// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The gate in front of extraction: modes, run-scoped state, the emitted
 * result events, and the scan step that skips an enforce-mode rejection while
 * saving its scan position. Every test replaces `globalThis.fetch` with a mock
 * that rejects by default, so a request no test asked for fails at once
 * instead of reaching the network; the credential is a placeholder and no
 * result or reported message may contain it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanSessions } from "../src/collector.js";
import { reportError } from "../src/error.js";
import { checkTrio, resetGateRun } from "../src/gate.js";
import { setInstrumentHooks } from "../src/instrument.js";
import { JEV_POLICY_HASH } from "../src/jev.js";
import { callPortraitLlm } from "../src/llm-call.js";
import { runPipelineLoop } from "../src/pipeline.js";
import { PORTRAIT_SCHEMA } from "../src/schema.js";
import { loadLatestSnapshot } from "../src/snapshot-store.js";
import { DEFAULT_PIPELINE_STATE, type InteractionSequence } from "../src/types.js";
import { defaultPortraitSettings, setupTestSettings, teardownTestSettings } from "./settings-helpers.js";
import { setTestConfig, useStubs } from "./setup.js";

const mockReportError = reportError as unknown as ReturnType<typeof vi.fn>;
const mockCallPortraitLlm = callPortraitLlm as unknown as ReturnType<typeof vi.fn>;

const KEY = "gate-credential-placeholder-0000";
const SOURCE = "/sessions/project/gate-source.jsonl";
const U1_MESSAGE = "Jev gate skipped for this run: TYPESAFE_API_KEY is not set. Every trio goes to extraction.";
const U2_MESSAGE =
  "Jev gate failed 3 times in a row and is off for the rest of this run. Every trio goes to extraction.";
const GATE_ERROR_SOURCE = "gate error";

const TRIO: InteractionSequence = {
  agentBefore: "agent proposed a fix",
  userFeedback: "do it the other way round",
  agentAfter: "agent redid the fix",
};
const BULKY_TRIO: InteractionSequence = {
  agentBefore: "y".repeat(40 * 1024),
  userFeedback: "do it the other way round",
  agentAfter: "agent redid the fix",
};

const LOW_ANSWERS = {
  correction: { type: "noul", noul: 0.01 },
  preference: { type: "noul", noul: 0.02 },
  steering: { type: "noul", noul: 0 },
  confusion: { type: "noul", noul: 0.05 },
};
const HIGH_ANSWERS = {
  correction: { type: "noul", noul: 0.9 },
  preference: { type: "noul", noul: 0.02 },
  steering: { type: "noul", noul: 0 },
  confusion: { type: "noul", noul: 0.05 },
};

const fetchMock = vi.fn((): Promise<Response> => Promise.reject(new Error("network is unavailable in tests")));
const REAL_FETCH = globalThis.fetch;
let savedKey: string | undefined;
let portraitDir: string;
let sessionDir: string;

/** A fresh 200 body; a Response's body can be read once, so never reuse one. */
function scoredResponse(answers: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 12, output_tokens: 3 } }), {
    status: 200,
  });
}

function rejectResponse(status: number): Response {
  return new Response("", { status });
}

function assistantRecord(text: string): string {
  return JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function userRecord(text: string): string {
  return JSON.stringify({
    type: "message",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

/** Write complete LF-terminated records; returns the byte offset of each record. */
function writeSession(filePath: string, lines: string[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += Buffer.byteLength(line, "utf-8") + 1;
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
  return offsets;
}

function checkpointFile(): string {
  return path.join(portraitDir, "processed-sessions.json");
}

function readCheckpoint(filePath: string): number | undefined {
  if (!fs.existsSync(checkpointFile())) return undefined;
  const all = JSON.parse(fs.readFileSync(checkpointFile(), "utf-8")) as Record<string, { lastByte?: number }>;
  return all[filePath]?.lastByte;
}

beforeEach(() => {
  portraitDir = path.join(os.tmpdir(), `gate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  sessionDir = path.join(portraitDir, "sessions", "test-project");
  fs.mkdirSync(sessionDir, { recursive: true });
  setTestConfig({ portraitDir, sessionDirs: [path.join(portraitDir, "sessions")] });
  useStubs({ error: true });
  mockReportError.mockClear();
  mockCallPortraitLlm.mockReset();
  mockCallPortraitLlm.mockImplementation(async () => ({
    notes: ["extracted rule"],
    summary: { agentBefore: "a", userFeedback: "b", agentAfter: "c" },
  }));
  savedKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.reject(new Error("network is unavailable in tests")));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  setInstrumentHooks({});
  resetGateRun();
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = savedKey;
  globalThis.fetch = REAL_FETCH;
  setInstrumentHooks({});
  teardownTestSettings();
  fs.rmSync(portraitDir, { recursive: true, force: true });
});

describe("gate setting", () => {
  it("ships off by default and lists the modes in the General tab", () => {
    const setting = PORTRAIT_SCHEMA.settings.find((entry) => entry.id === "gateMode");
    expect(setting).toMatchObject({ defaultValue: "off", presets: ["off", "shadow", "enforce"] });
    const general = PORTRAIT_SCHEMA.tabs.find((tab) => tab.label === "General");
    expect(general?.settingIds.indexOf("gateMode")).toBe(1);
    expect(defaultPortraitSettings(null).gateMode).toBe("off");
  });
});

describe("checkTrio modes", () => {
  it("off makes no request and reports nothing", async () => {
    const check = await checkTrio(TRIO, "off", SOURCE);

    expect(check).toEqual({ decision: "extract", event: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("shadow records a no_lesson result and still extracts", async () => {
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(() => Promise.resolve(scoredResponse(LOW_ANSWERS)));
    const seen: unknown[] = [];
    setInstrumentHooks({ onGateResult: (event) => seen.push(event) });

    const check = await checkTrio(TRIO, "shadow", SOURCE);

    expect(check.decision).toBe("extract");
    expect(check.event).toMatchObject({
      sourcePath: SOURCE,
      mode: "shadow",
      policyHash: JEV_POLICY_HASH,
      decision: "no_lesson",
      routed: "extract",
      fallbackReason: null,
      model: "jev-1.13.0",
      attempts: 1,
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    expect(check.event?.answers).toEqual({
      correction: 0.01,
      preference: 0.02,
      steering: 0,
      confusion: 0.05,
    });
    expect(check.event?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(seen).toEqual([check.event]);
  });

  it("shadow records a maybe_lesson result and extracts", async () => {
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(() => Promise.resolve(scoredResponse(HIGH_ANSWERS)));

    const check = await checkTrio(TRIO, "shadow", SOURCE);

    expect(check.decision).toBe("extract");
    expect(check.event?.decision).toBe("maybe_lesson");
    expect(check.event?.routed).toBe("extract");
  });

  it("enforce skips only a no_lesson trio", async () => {
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(() => Promise.resolve(scoredResponse(LOW_ANSWERS)));
    const rejected = await checkTrio(TRIO, "enforce", SOURCE);
    expect(rejected.decision).toBe("skip");
    expect(rejected.event?.routed).toBe("skip");

    fetchMock.mockImplementation(() => Promise.resolve(scoredResponse(HIGH_ANSWERS)));
    const accepted = await checkTrio(TRIO, "enforce", SOURCE);
    expect(accepted.decision).toBe("extract");
    expect(accepted.event?.decision).toBe("maybe_lesson");
  });

  it("enforce extracts a trio the gate fell back on", async () => {
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(() => Promise.resolve(rejectResponse(500)));

    const check = await checkTrio(TRIO, "enforce", SOURCE);

    expect(check.decision).toBe("extract");
    expect(check.event).toMatchObject({ decision: "fallback", routed: "extract", fallbackReason: "http_500" });
    expect(check.event?.answers).toBeNull();
  });
});

describe("run-scoped gate state", () => {
  it("reports a missing key once for the run and makes no request", async () => {
    for (let i = 0; i < 5; i++) {
      const check = await checkTrio(TRIO, "shadow", SOURCE);
      expect(check.decision).toBe("extract");
      expect(check.event).toMatchObject({ decision: "fallback", fallbackReason: "key_missing", attempts: 0 });
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError).toHaveBeenCalledWith(U1_MESSAGE, GATE_ERROR_SOURCE);
  });

  it("treats an empty key as missing", async () => {
    process.env.TYPESAFE_API_KEY = "";

    const check = await checkTrio(TRIO, "shadow", SOURCE);

    expect(check.event?.fallbackReason).toBe("key_missing");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError).toHaveBeenCalledWith(U1_MESSAGE, GATE_ERROR_SOURCE);
  });

  it("stops the gate after three request failures and keeps extracting", async () => {
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(() => Promise.resolve(rejectResponse(500)));

    for (let i = 0; i < 3; i++) {
      const check = await checkTrio(TRIO, "shadow", SOURCE);
      expect(check.decision).toBe("extract");
      expect(check.event?.fallbackReason).toBe("http_500");
    }
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError).toHaveBeenCalledWith(U2_MESSAGE, GATE_ERROR_SOURCE);

    const fourth = await checkTrio(TRIO, "shadow", SOURCE);
    expect(fourth.decision).toBe("extract");
    expect(fourth.event).toMatchObject({ decision: "fallback", fallbackReason: "check_stopped", attempts: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("resets the failure count on a scored result in between", async () => {
    process.env.TYPESAFE_API_KEY = KEY;
    const responses = [
      () => rejectResponse(500),
      () => rejectResponse(500),
      () => scoredResponse(LOW_ANSWERS),
      () => rejectResponse(500),
      () => rejectResponse(500),
    ];
    fetchMock.mockImplementation(async () => {
      const next = responses.shift();
      if (next === undefined) throw new Error("no scripted response left");
      return next();
    });

    for (let i = 0; i < 5; i++) {
      const check = await checkTrio(TRIO, "shadow", SOURCE);
      expect(check.decision).toBe("extract");
    }

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("never counts an oversized state toward the three", async () => {
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(() => Promise.resolve(rejectResponse(500)));

    const oversized = await checkTrio(BULKY_TRIO, "shadow", SOURCE);
    expect(oversized.event).toMatchObject({ decision: "fallback", fallbackReason: "oversized_state", attempts: 0 });
    for (let i = 0; i < 3; i++) {
      await checkTrio(TRIO, "shadow", SOURCE);
    }

    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError).toHaveBeenCalledWith(U2_MESSAGE, GATE_ERROR_SOURCE);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never counts a declined attempt toward the three", async () => {
    process.env.TYPESAFE_API_KEY = KEY;
    setInstrumentHooks({ onGateAttempt: () => false });

    for (let i = 0; i < 3; i++) {
      const check = await checkTrio(TRIO, "shadow", SOURCE);
      expect(check.event).toMatchObject({ decision: "fallback", fallbackReason: "over_budget", attempts: 0 });
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("reports the missing key again after a reset", async () => {
    await checkTrio(TRIO, "shadow", SOURCE);
    expect(mockReportError).toHaveBeenCalledTimes(1);

    resetGateRun();

    await checkTrio(TRIO, "shadow", SOURCE);
    expect(mockReportError).toHaveBeenCalledTimes(2);
    expect(mockReportError).toHaveBeenLastCalledWith(U1_MESSAGE, GATE_ERROR_SOURCE);
  });

  it("accepts requests again after a reset", async () => {
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(() => Promise.resolve(rejectResponse(500)));
    for (let i = 0; i < 3; i++) await checkTrio(TRIO, "shadow", SOURCE);
    const stopped = await checkTrio(TRIO, "shadow", SOURCE);
    expect(stopped.event?.fallbackReason).toBe("check_stopped");

    resetGateRun();
    fetchMock.mockImplementation(() => Promise.resolve(scoredResponse(LOW_ANSWERS)));

    const afterReset = await checkTrio(TRIO, "shadow", SOURCE);
    expect(afterReset.event?.decision).toBe("no_lesson");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps the credential out of results, events, and reported messages", async () => {
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(() => Promise.resolve(rejectResponse(500)));
    const failed = await checkTrio(TRIO, "shadow", SOURCE);

    fetchMock.mockImplementation(() => Promise.resolve(scoredResponse(LOW_ANSWERS)));
    const scored = await checkTrio(TRIO, "shadow", SOURCE);

    delete process.env.TYPESAFE_API_KEY;
    resetGateRun();
    const withoutKey = await checkTrio(TRIO, "shadow", SOURCE);

    expect(JSON.stringify([failed, scored, withoutKey])).not.toContain(KEY);
    expect(JSON.stringify(mockReportError.mock.calls)).not.toContain(KEY);
    expect(withoutKey.event?.fallbackReason).toBe("key_missing");
  });
});

describe("scan with the gate", () => {
  const HEADER = JSON.stringify({ type: "session", id: "gate-session", cwd: "/work/project" });

  function writeTwoTrioSession(): { file: string; offsets: number[] } {
    const file = path.join(sessionDir, "two-trios.jsonl");
    const offsets = writeSession(file, [
      HEADER,
      assistantRecord("A1 plan"),
      userRecord("U1 feedback"),
      assistantRecord("A2 reply"),
      userRecord("U2 feedback"),
      assistantRecord("A3 reply"),
    ]);
    return { file, offsets };
  }

  async function scan() {
    return scanSessions(portraitDir, { ...DEFAULT_PIPELINE_STATE }, 10, 100);
  }

  it("off makes no request and extracts every trio", async () => {
    setupTestSettings({ gateMode: "off" });
    const { file, offsets } = writeTwoTrioSession();

    const result = await scan();

    expect(result.stopReason).toBeNull();
    expect(result.results).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockReportError).not.toHaveBeenCalled();
    expect(readCheckpoint(file)).toBe(offsets[5]);
  });

  it("shadow requests every trio and extracts every trio", async () => {
    setupTestSettings({ gateMode: "shadow" });
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(() => Promise.resolve(scoredResponse(LOW_ANSWERS)));
    const { file, offsets } = writeTwoTrioSession();

    const result = await scan();

    expect(result.stopReason).toBeNull();
    expect(result.results).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockCallPortraitLlm).toHaveBeenCalledTimes(2);
    expect(readCheckpoint(file)).toBe(offsets[5]);
  });

  it("enforce skips a rejected trio, saves its position, and extracts the next one", async () => {
    setupTestSettings({ gateMode: "enforce" });
    process.env.TYPESAFE_API_KEY = KEY;
    const responses = [() => scoredResponse(LOW_ANSWERS), () => scoredResponse(HIGH_ANSWERS)];
    fetchMock.mockImplementation(async () => {
      const next = responses.shift();
      if (next === undefined) throw new Error("no scripted response left");
      return next();
    });
    const examined = vi.fn();
    const gated = vi.fn();
    setInstrumentHooks({ onTrioExamined: examined, onGateResult: gated });
    const { file, offsets } = writeTwoTrioSession();

    const result = await scan();

    expect(result.stopReason).toBeNull();
    // Only the second trio reached the extractor; the rejected one saved its
    // position like an empty extraction and left no candidate behind.
    expect(mockCallPortraitLlm).toHaveBeenCalledTimes(1);
    expect(result.results.map((entry) => entry.behaviorNotes)).toEqual([["extracted rule"]]);
    expect(readCheckpoint(file)).toBe(offsets[5]);
    const pending = loadLatestSnapshot(portraitDir)?.state.pendingCandidates ?? [];
    expect(pending.map((candidate) => candidate.text)).toEqual(["extracted rule"]);
    expect(examined).toHaveBeenCalledTimes(1);
    expect(gated).toHaveBeenCalledTimes(2);
    expect(gated.mock.calls[0][0]).toMatchObject({ decision: "no_lesson", routed: "skip" });
    expect(gated.mock.calls[1][0]).toMatchObject({ decision: "maybe_lesson", routed: "extract" });
  });

  it("enforce extracts every trio the gate falls back on", async () => {
    setupTestSettings({ gateMode: "enforce" });
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(() => Promise.resolve(rejectResponse(500)));
    const { file, offsets } = writeTwoTrioSession();

    const result = await scan();

    expect(result.stopReason).toBeNull();
    expect(result.results).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readCheckpoint(file)).toBe(offsets[5]);
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("starts each pipeline run with a fresh gate", async () => {
    setupTestSettings({ gateMode: "shadow" });
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(() => Promise.resolve(rejectResponse(500)));
    for (let i = 0; i < 3; i++) await checkTrio(TRIO, "shadow", SOURCE);
    const stopped = await checkTrio(TRIO, "shadow", SOURCE);
    expect(stopped.event?.fallbackReason).toBe("check_stopped");

    useStubs({ collector: true, footer: true, storage: true, builder: true, maintenanceCore: true, error: true });
    const settings = defaultPortraitSettings({ gateMode: "shadow" });
    await runPipelineLoop(settings, Infinity, () => false, null);

    fetchMock.mockImplementation(() => Promise.resolve(scoredResponse(LOW_ANSWERS)));
    const afterRun = await checkTrio(TRIO, "shadow", SOURCE);
    expect(afterRun.event?.decision).toBe("no_lesson");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
