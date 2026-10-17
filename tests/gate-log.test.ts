// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The gate log: one JSON line per gate check in shadow or enforce, nothing in
 * off, a failed write that never changes the scan, no credential and no trio
 * text in the file, and the gate log file ignored by a freshly created portrait
 * repo. Like tests/gate.test.ts, every test replaces `globalThis.fetch` with a
 * mock that rejects by default, so a request no test asked for fails at once
 * instead of reaching the network.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanSessions } from "../src/collector.js";
import { reportError } from "../src/error.js";
import { resetGateRun } from "../src/gate.js";
import { GATE_LOG_FILE, type GateLogEntry } from "../src/gate-log.js";
import { initGit, resetGitExec, setGitExec } from "../src/git.js";
import { JEV_POLICY_HASH } from "../src/jev.js";
import { callPortraitLlm } from "../src/llm-call.js";
import { DEFAULT_PIPELINE_STATE } from "../src/types.js";
import { setupTestSettings, teardownTestSettings } from "./settings-helpers.js";
import { setTestConfig, useStubs } from "./setup.js";

const mockReportError = reportError as unknown as ReturnType<typeof vi.fn>;
const mockCallPortraitLlm = callPortraitLlm as unknown as ReturnType<typeof vi.fn>;

const KEY = "gate-log-credential-placeholder-0000";

/**
 * Fixture (the two-trio session below), with the expected log lines derived
 * from it before any assertion was written:
 *
 * | record | text          | in trio |
 * |--------|---------------|---------|
 * | A1     | "A1 plan"     | 1 (before) |
 * | U1     | "U1 feedback" | 1 (user) |
 * | A2     | "A2 reply"    | 1 (after), 2 (before) |
 * | U2     | "U2 feedback" | 2 (user) |
 * | A3     | "A3 reply"    | 2 (after) |
 *
 * → 2 trios per scan; 2 log lines in shadow/enforce, 0 in off; the records
 * carry no id, so `entryIds` is [null, null, null] and each `trioId` hashes
 * the three record texts — the two differ.
 */
const TRIO_TEXTS = ["A1 plan", "U1 feedback", "A2 reply", "U2 feedback", "A3 reply"];
const HEADER_ID = "gate-session";
const ENTRY_KEYS = [
  "ts",
  "session",
  "sessionId",
  "trioId",
  "entryIds",
  "mode",
  "policyHash",
  "decision",
  "result",
  "answers",
  "model",
  "attempts",
  "latencyMs",
  "usage",
];

const LOW_ANSWERS = {
  correction: { type: "noul", noul: 0.01 },
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

function writeTwoTrioSession(): { file: string; offsets: number[] } {
  const file = path.join(sessionDir, "two-trios.jsonl");
  const offsets = writeSession(file, [
    JSON.stringify({ type: "session", id: HEADER_ID, cwd: "/work/project" }),
    assistantRecord(TRIO_TEXTS[0]),
    userRecord(TRIO_TEXTS[1]),
    assistantRecord(TRIO_TEXTS[2]),
    userRecord(TRIO_TEXTS[3]),
    assistantRecord(TRIO_TEXTS[4]),
  ]);
  return { file, offsets };
}

function logPath(): string {
  return path.join(portraitDir, GATE_LOG_FILE);
}

function readLogLines(): string[] {
  return fs
    .readFileSync(logPath(), "utf-8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function readLogEntries(): GateLogEntry[] {
  return readLogLines().map((line) => JSON.parse(line) as GateLogEntry);
}

function checkpointFile(): string {
  return path.join(portraitDir, "processed-sessions.json");
}

function readCheckpoint(filePath: string): number | undefined {
  if (!fs.existsSync(checkpointFile())) return undefined;
  const all = JSON.parse(fs.readFileSync(checkpointFile(), "utf-8")) as Record<string, { lastByte?: number }>;
  return all[filePath]?.lastByte;
}

async function scan() {
  return scanSessions(portraitDir, { ...DEFAULT_PIPELINE_STATE }, 10, 100);
}

beforeEach(() => {
  portraitDir = path.join(os.tmpdir(), `gate-log-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
  resetGateRun();
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = savedKey;
  globalThis.fetch = REAL_FETCH;
  teardownTestSettings();
  resetGitExec();
  fs.rmSync(portraitDir, { recursive: true, force: true });
});

describe("gate log entries", () => {
  it("shadow logs every check with the full entry; both trios extracted", async () => {
    setupTestSettings({ gateMode: "shadow" });
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(() => Promise.resolve(scoredResponse(LOW_ANSWERS)));
    const { file } = writeTwoTrioSession();

    const result = await scan();

    expect(result.stopReason).toBeNull();
    expect(result.results).toHaveLength(2);
    const entries = readLogEntries();
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(Object.keys(entry)).toEqual(ENTRY_KEYS);
      expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(entry.session).toBe(path.resolve(file));
      expect(entry.sessionId).toBe(HEADER_ID);
      expect(entry.entryIds).toEqual([null, null, null]);
      expect(entry.mode).toBe("shadow");
      expect(entry.policyHash).toBe(JEV_POLICY_HASH);
      expect(entry.decision).toBe("extract");
      expect(entry.result).toBe("no_lesson");
      expect(entry.answers).toEqual({ correction: 0.01, preference: 0.02, steering: 0, confusion: 0.05 });
      expect(entry.model).toBe("jev-1.13.0");
      expect(entry.attempts).toBe(1);
      expect(entry.latencyMs).toBeGreaterThanOrEqual(0);
      expect(entry.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    }
    // The two trios differ, and the log locates exactly the trios the scan examined.
    expect(entries[0].trioId).not.toBe(entries[1].trioId);
    expect(entries.map((entry) => entry.trioId).sort()).toEqual(result.results.map((r) => r.trioId).sort());
  });

  it("enforce logs every check with its skip decision", async () => {
    setupTestSettings({ gateMode: "enforce" });
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(() => Promise.resolve(scoredResponse(LOW_ANSWERS)));
    const { file, offsets } = writeTwoTrioSession();

    const result = await scan();

    expect(result.stopReason).toBeNull();
    expect(result.results).toHaveLength(0);
    expect(mockCallPortraitLlm).not.toHaveBeenCalled();
    const entries = readLogEntries();
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.mode).toBe("enforce");
      expect(entry.decision).toBe("skip");
      expect(entry.result).toBe("no_lesson");
      expect(entry.session).toBe(path.resolve(file));
    }
    // A skipped trio saves its position like an empty extraction.
    expect(readCheckpoint(file)).toBe(offsets[5]);
  });

  it("off writes no log file", async () => {
    setupTestSettings({ gateMode: "off" });
    writeTwoTrioSession();

    const result = await scan();

    expect(result.stopReason).toBeNull();
    expect(result.results).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(logPath())).toBe(false);
  });

  it("logs a missing key as a zero-attempt fallback and still extracts every trio", async () => {
    setupTestSettings({ gateMode: "shadow" });
    writeTwoTrioSession();

    const result = await scan();

    expect(result.stopReason).toBeNull();
    expect(result.results).toHaveLength(2);
    const entries = readLogEntries();
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.result).toBe("key_missing");
      expect(entry.decision).toBe("extract");
      expect(entry.mode).toBe("shadow");
      expect(entry.answers).toBeNull();
      expect(entry.model).toBeNull();
      expect(entry.attempts).toBe(0);
      expect(entry.usage).toBeNull();
    }
  });

  it("a failing write leaves the scan, its checkpoints, and its errors untouched", async () => {
    setupTestSettings({ gateMode: "shadow" });
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(() => Promise.resolve(scoredResponse(LOW_ANSWERS)));
    const { file, offsets } = writeTwoTrioSession();
    // A directory where the log file goes: every append fails.
    fs.mkdirSync(logPath(), { recursive: true });

    const result = await scan();

    expect(result.stopReason).toBeNull();
    expect(result.results).toHaveLength(2);
    expect(result.results.map((entry) => entry.behaviorNotes)).toEqual([["extracted rule"], ["extracted rule"]]);
    expect(readCheckpoint(file)).toBe(offsets[5]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("the log file holds no credential and no trio text", async () => {
    setupTestSettings({ gateMode: "shadow" });
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(() => Promise.resolve(scoredResponse(LOW_ANSWERS)));
    writeTwoTrioSession();

    await scan();

    const raw = fs.readFileSync(logPath(), "utf-8");
    expect(raw).not.toContain(KEY);
    for (const text of TRIO_TEXTS) {
      expect(raw).not.toContain(text);
    }
  });
});

describe("gate log in the portrait repo", () => {
  it("initGit writes a .gitignore that ignores the gate log", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-log-git-"));
    try {
      setGitExec(() => "");
      initGit(dir);
      const gitignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf-8");
      expect(gitignore.split("\n")).toContain(GATE_LOG_FILE);
    } finally {
      resetGitExec();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
