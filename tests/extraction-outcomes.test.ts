// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Extraction outcomes: a failed extraction or review stops the scan at the trio it failed on
 * (the saved position stays at the last examined trio), the pipeline stops cleanly, and every
 * examined trio carries a stable identity and candidate ids.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPortrait } from "../src/builder.js";
import { scanSessions } from "../src/collector.js";
import { reportError } from "../src/error.js";
import { callPortraitLlm } from "../src/llm-call.js";
import { runMaintenance } from "../src/maintenance-core.js";
import { resetPipelineState, runPipelineLoop } from "../src/pipeline.js";
import type { PortraitSettings } from "../src/schema.js";
import { loadLatestSnapshot } from "../src/snapshot-store.js";
import { loadPortraitState } from "../src/storage.js";
import type { PendingCandidate, PortraitPipelineState } from "../src/types.js";
import { DEFAULT_PIPELINE_STATE } from "../src/types.js";
import { EXTRACTION_POLICY_REVISION, loadWorkState, saveWorkState } from "../src/work-state.js";
import { setupTestSettings, teardownTestSettings } from "./settings-helpers.js";
import { getStubPortraitState, setTestConfig, useStubs } from "./setup.js";

const mockCallPortraitLlm = callPortraitLlm as unknown as ReturnType<typeof vi.fn>;
const mockReportError = reportError as unknown as ReturnType<typeof vi.fn>;
const mockScanSessions = scanSessions as unknown as ReturnType<typeof vi.fn>;
const mockBuildPortrait = buildPortrait as unknown as ReturnType<typeof vi.fn>;
const mockRunMaintenance = runMaintenance as unknown as ReturnType<typeof vi.fn>;
const mockLoadPortraitState = loadPortraitState as unknown as ReturnType<typeof vi.fn>;

const SESSION_ID = "outcomes-session";
const CWD = "/work/project";
const HEADER = JSON.stringify({ type: "session", id: SESSION_ID, cwd: CWD });

let portraitDir: string;
let sessionDir: string;

function assistantRecord(text: string, id: string | null): string {
  return JSON.stringify({
    type: "message",
    ...(id === null ? {} : { id }),
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function userRecord(text: string, id: string | null): string {
  return JSON.stringify({
    type: "message",
    ...(id === null ? {} : { id }),
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

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function checkpointFile(): string {
  return path.join(portraitDir, "processed-sessions.json");
}

function readCheckpoint(filePath: string): number | undefined {
  if (!fs.existsSync(checkpointFile())) return undefined;
  const all = JSON.parse(fs.readFileSync(checkpointFile(), "utf-8")) as Record<string, { lastByte?: number }>;
  return all[filePath]?.lastByte;
}

/** Forget every saved scan position, so the next pass scans the file from its start. */
function forgetPositions(): void {
  fs.rmSync(checkpointFile(), { force: true });
  fs.rmSync(path.join(portraitDir, "snapshots"), { recursive: true, force: true });
}

function freshState(): PortraitPipelineState {
  return { ...DEFAULT_PIPELINE_STATE };
}

/** Pull the user-feedback block out of the extraction prompt the SUT sends to the LLM. */
function userFeedbackFromPrompt(messages: unknown): string {
  const list = messages as Array<{ content: Array<{ text: string }> }>;
  const prompt = list[0]?.content?.[0]?.text ?? "";
  const match = /<user-feedback>\n([\s\S]*?)\n<\/user-feedback>/.exec(prompt);
  return match ? match[1] : "";
}

/** Extraction returns one note per trio: the trio's user feedback. */
function oneNotePerTrio(messages: unknown): { notes: string[]; summary: Record<string, string> } {
  const userFeedback = userFeedbackFromPrompt(messages);
  return {
    notes: [userFeedback],
    summary: { agentBefore: "agent before", userFeedback, agentAfter: "agent after" },
  };
}

function extractionResult(notes: string[]): { notes: string[]; summary: Record<string, string> } {
  return {
    notes,
    summary: { agentBefore: "agent before", userFeedback: "user feedback", agentAfter: "agent after" },
  };
}

function setup(overrides: Partial<PortraitSettings>): void {
  setupTestSettings({ debugDumpLimit: 0, postExtractionEnabled: false, ...overrides });
}

beforeEach(() => {
  portraitDir = path.join(os.tmpdir(), `extraction-outcomes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  sessionDir = path.join(portraitDir, "sessions", "test-project");
  fs.mkdirSync(sessionDir, { recursive: true });
  setTestConfig({ portraitDir, sessionDirs: [path.join(portraitDir, "sessions")] });
  useStubs({ error: true });
  mockReportError.mockClear();
  mockCallPortraitLlm.mockReset();
  mockCallPortraitLlm.mockImplementation(async (messages: unknown) => oneNotePerTrio(messages));
  setup({});
});

afterEach(() => {
  teardownTestSettings();
  fs.rmSync(portraitDir, { recursive: true, force: true });
});

describe("failed extraction", () => {
  it("stops at the failed trio, keeps its position, and the next pass emits it", async () => {
    const file = path.join(sessionDir, "extraction-failure.jsonl");
    const offsets = writeSession(file, [
      HEADER,
      assistantRecord("A1 first plan", null),
      userRecord("U1 first feedback", null),
      assistantRecord("A2 first reply", null),
      userRecord("U2 second feedback", null),
      assistantRecord("A3 second reply", null),
    ]);

    // Trio 1 succeeds; trio 2's extraction returns nothing (all retries failed).
    mockCallPortraitLlm.mockResolvedValueOnce(extractionResult(["U1 first feedback"])).mockResolvedValueOnce(undefined);

    const first = await scanSessions(portraitDir, freshState(), 10, 100);
    expect(first.results.map((r) => r.behaviorNotes)).toEqual([["U1 first feedback"]]);
    expect(first.stopReason).toBe("extraction_failed");
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError).toHaveBeenCalledWith(
      `Rule extraction failed for a trio in ${file}. Its scan position was kept; the trio will be extracted again on the next run.`,
      "extraction error",
    );
    // Trio 2 starts at A2: that record's offset is the saved position.
    expect(readCheckpoint(file)).toBe(offsets[3]);

    const retry = await scanSessions(portraitDir, freshState(), 10, 100);
    expect(retry.stopReason).toBeNull();
    expect(retry.results.map((r) => r.behaviorNotes)).toEqual([["U2 second feedback"]]);
    expect(readCheckpoint(file)).toBe(offsets[5]);
  });
});

describe("failed review", () => {
  it("stops with the review message; the trio's raw rules stay pending and its position is kept", async () => {
    setup({ postExtractionEnabled: true });
    const file = path.join(sessionDir, "review-failure.jsonl");
    const offsets = writeSession(file, [
      HEADER,
      assistantRecord("A1 plan", null),
      userRecord("U1 feedback", null),
      assistantRecord("A2 reply", null),
    ]);

    // Extraction keeps two raw rules; the review call returns nothing.
    mockCallPortraitLlm
      .mockResolvedValueOnce(extractionResult(["rule one", "rule two"]))
      .mockResolvedValueOnce(undefined);

    const result = await scanSessions(portraitDir, freshState(), 10, 100);
    expect(result.results).toEqual([]);
    expect(result.stopReason).toBe("review_failed");
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError).toHaveBeenCalledWith(
      "Rule review failed; 2 extracted rules were kept and will be reviewed on the next run.",
      "review error",
    );
    // The trio was examined: its position and its raw rules are saved, and the rules await review.
    expect(readCheckpoint(file)).toBe(offsets[3]);
    const pending = loadLatestSnapshot(portraitDir)?.state.pendingCandidates ?? [];
    expect(pending.map((candidate) => [candidate.stage, candidate.text])).toEqual([
      ["needsPostReview", "rule one"],
      ["needsPostReview", "rule two"],
    ]);
  });
});

describe("successful extraction with no rules", () => {
  it("advances the position and does not stop", async () => {
    const file = path.join(sessionDir, "zero-rules.jsonl");
    const offsets = writeSession(file, [
      HEADER,
      assistantRecord("A1 plan", null),
      userRecord("U1 feedback", null),
      assistantRecord("A2 reply", null),
      userRecord("U2 feedback", null),
      assistantRecord("A3 reply", null),
    ]);

    mockCallPortraitLlm
      .mockResolvedValueOnce(extractionResult([]))
      .mockResolvedValueOnce(extractionResult(["U2 rule"]));

    const result = await scanSessions(portraitDir, freshState(), 10, 100);
    expect(result.stopReason).toBeNull();
    expect(mockReportError).not.toHaveBeenCalled();
    expect(result.results.map((r) => r.behaviorNotes)).toEqual([["U2 rule"]]);
    expect(readCheckpoint(file)).toBe(offsets[5]);
  });
});

describe("pipeline stop", () => {
  const settings: PortraitSettings = {
    enabled: true,
    gateMode: "off",
    intervalMs: 300_000,
    startupDelayMs: 2000,
    ruleLimit: 200,
    model: null,
    thinkingLevel: "high" as const,
    maxTokens: 8192,
    timeoutMs: 180_000,
    retries: 3,
    buildingBatchSize: 1,
    maxAgeDays: 30,
    debugDumpLimit: 0,
    postExtractionEnabled: false,
    postExtractionModel: null,
    rateLimitMs: 0,
    maintenanceModel: null,
    maintenanceEveryNRulesInserted: 1,
    maintenanceBackfillBatchSize: 1,
    maintenanceMaxTokens: 0,
    maintenanceTimeoutMs: 3_600_000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useStubs({
      collector: true,
      builder: true,
      storage: true,
      footer: true,
      maintenanceCore: true,
      error: true,
    });
    resetPipelineState();
    getStubPortraitState().rulesInsertedSinceMaintenance = 0;
    mockBuildPortrait.mockResolvedValue({ inserted: 1, evicted: 0, rules: [], evictedRules: [], droppedRules: [] });
  });

  it("builds the results already returned, makes no further scan, skips maintenance, and reports the stop", async () => {
    mockScanSessions.mockImplementationOnce(async () => {
      // The failing pass saved its results' candidates at the examined-trio boundary.
      const work = loadWorkState(portraitDir);
      const candidates: PendingCandidate[] = ["rule-1", "rule-2"].map((text, index) => ({
        candidateId: `t:${index}`,
        trioId: "t",
        sourcePath: "/tmp/s1.jsonl",
        cwd: null,
        sessionId: null,
        entryIds: [null, null, null],
        policyRevision: EXTRACTION_POLICY_REVISION,
        text,
        stage: "needsBuild",
        reviewContext: null,
      }));
      work.pendingCandidates.push(...candidates);
      saveWorkState(portraitDir, work);
      return {
        results: [
          {
            behaviorNotes: ["rule-1", "rule-2"],
            sessionPath: "/tmp/s1.jsonl",
            source: "main",
            trioId: "t",
            candidateIds: ["t:0", "t:1"],
            sessionId: null,
            cwd: null,
            entryIds: [null, null, null],
          },
        ],
        remainingFiles: 3,
        triosProcessed: 1,
        totalKnownTrios: 1,
        stopReason: "extraction_failed",
      };
    });

    const stats = await runPipelineLoop(settings, Infinity, () => false, null);

    expect(stats.stopReason).toBe("extraction_failed");
    expect(mockScanSessions).toHaveBeenCalledTimes(1);
    expect(mockBuildPortrait).toHaveBeenCalledTimes(2);
    expect(mockBuildPortrait.mock.calls[0][1]).toEqual(["rule-1"]);
    expect(mockBuildPortrait.mock.calls[1][1]).toEqual(["rule-2"]);
    expect(mockRunMaintenance).not.toHaveBeenCalled();
    const state = mockLoadPortraitState.mock.results[0]?.value;
    expect(state.pipelinePhase).toBe("idle");
  });

  it("returns a null stop reason on a normal run", async () => {
    mockScanSessions.mockResolvedValueOnce({
      results: [],
      remainingFiles: 0,
      triosProcessed: 0,
      totalKnownTrios: 0,
      stopReason: null,
    });

    const stats = await runPipelineLoop(settings, Infinity, () => false, null);
    expect(stats.stopReason).toBeNull();
  });
});

describe("trio identity and candidate ids", () => {
  it("keeps the same trio id in an uninterrupted scan and in a scan restarted at every trio", async () => {
    const file = path.join(sessionDir, "restarts.jsonl");
    writeSession(file, [
      HEADER,
      assistantRecord("A1 plan", "a1"),
      userRecord("U1 feedback", "u1"),
      assistantRecord("A2 reply", "a2"),
      userRecord("U2 feedback", "u2"),
      assistantRecord("A3 reply", "a3"),
      userRecord("U3 feedback", "u3"),
      assistantRecord("A4 reply", "a4"),
    ]);

    const uninterruptedResult = await scanSessions(portraitDir, freshState(), 10, 100);
    const uninterruptedIds = uninterruptedResult.results.map((r) => r.trioId);
    forgetPositions();

    // One trio per pass: each pass restarts from the saved position.
    const restartedIds: string[] = [];
    for (let pass = 0; pass < 10; pass++) {
      const result = await scanSessions(portraitDir, freshState(), 10, 1);
      if (result.results.length === 0) break;
      restartedIds.push(result.results[0].trioId);
    }

    expect(uninterruptedIds).toHaveLength(3);
    expect(restartedIds).toEqual(uninterruptedIds);
    // Distinct trios have distinct ids.
    expect(new Set(uninterruptedIds).size).toBe(uninterruptedIds.length);
  });

  it("keeps earlier trio ids when records are appended", async () => {
    const file = path.join(sessionDir, "append.jsonl");
    const lines = [
      HEADER,
      assistantRecord("A1 plan", "a1"),
      userRecord("U1 feedback", "u1"),
      assistantRecord("A2 reply", "a2"),
      userRecord("U2 feedback", "u2"),
      assistantRecord("A3 reply", "a3"),
    ];
    writeSession(file, lines);
    const before = (await scanSessions(portraitDir, freshState(), 10, 100)).results.map((r) => r.trioId);
    forgetPositions();

    writeSession(file, [...lines, userRecord("U3 feedback", "u3"), assistantRecord("A4 reply", "a4")]);
    const after = (await scanSessions(portraitDir, freshState(), 10, 100)).results.map((r) => r.trioId);

    expect(before).toHaveLength(2);
    expect(after).toHaveLength(3);
    expect(after.slice(0, 2)).toEqual(before);
  });

  it("derives the trio id from the session id and record ids when all are present", async () => {
    const file = path.join(sessionDir, "with-ids.jsonl");
    writeSession(file, [
      HEADER,
      assistantRecord("A1 plan", "a1"),
      userRecord("U1 feedback", "u1"),
      assistantRecord("A2 reply", "a2"),
    ]);
    mockCallPortraitLlm.mockResolvedValueOnce(extractionResult(["rule"]));

    const [result] = (await scanSessions(portraitDir, freshState(), 10, 100)).results;
    expect(result.trioId).toBe(sha256(`${SESSION_ID}\na1\nu1\na2`));
    expect(result.entryIds).toEqual(["a1", "u1", "a2"]);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.cwd).toBe(CWD);
  });

  it("derives the trio id from the record texts when any record id is absent", async () => {
    const file = path.join(sessionDir, "without-ids.jsonl");
    const lines = [
      HEADER,
      assistantRecord("A1 plan", "a1"),
      userRecord("U1 feedback", null),
      assistantRecord("A2 reply", "a2"),
    ];
    writeSession(file, lines);
    mockCallPortraitLlm.mockResolvedValueOnce(extractionResult(["rule"]));

    const [result] = (await scanSessions(portraitDir, freshState(), 10, 100)).results;
    expect(result.trioId).toBe(sha256([lines[1], lines[2], lines[3]].join("\n")));
    expect(result.entryIds).toEqual(["a1", null, "a2"]);
  });

  it("gives each candidate the trio id with its index", async () => {
    const file = path.join(sessionDir, "candidates.jsonl");
    writeSession(file, [
      HEADER,
      assistantRecord("A1 plan", "a1"),
      userRecord("U1 feedback", "u1"),
      assistantRecord("A2", "a2"),
    ]);
    mockCallPortraitLlm.mockResolvedValueOnce(extractionResult(["rule one", "rule two"]));

    const [result] = (await scanSessions(portraitDir, freshState(), 10, 100)).results;
    expect(result.behaviorNotes).toEqual(["rule one", "rule two"]);
    expect(result.candidateIds).toEqual([`${result.trioId}:0`, `${result.trioId}:1`]);
  });
});
