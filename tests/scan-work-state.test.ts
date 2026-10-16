// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Scans save their positions and pending candidates through the work state: one snapshot per
 * examined trio, the raw rules saved before the review, and a corrupt snapshot stopping the scan.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, type vi } from "vitest";
import { scanSessions } from "../src/collector.js";
import { reportError } from "../src/error.js";
import { callPortraitLlm } from "../src/llm-call.js";
import { POST_EXTRACTION_PROMPT } from "../src/prompts.js";
import { loadLatestSnapshot, SnapshotCorruptError } from "../src/snapshot-store.js";
import type { PendingCandidate, PortraitPipelineState } from "../src/types.js";
import { DEFAULT_PIPELINE_STATE } from "../src/types.js";
import { EXTRACTION_POLICY_REVISION } from "../src/work-state.js";
import { setupTestSettings, teardownTestSettings } from "./settings-helpers.js";
import { setTestConfig, useStubs } from "./setup.js";

const mockCallPortraitLlm = callPortraitLlm as unknown as ReturnType<typeof vi.fn>;
const mockReportError = reportError as unknown as ReturnType<typeof vi.fn>;

const SESSION_ID = "work-session";
const CWD = "/work/project";
const HEADER = JSON.stringify({ type: "session", id: SESSION_ID, cwd: CWD });

let portraitDir: string;
let sessionDir: string;
let extractNotes: (userFeedback: string) => string[] | undefined;
let reviewNotes: (rules: string[]) => string[] | undefined;

function message(role: "user" | "assistant", text: string, id: string): string {
  return JSON.stringify({ type: "message", id, message: { role, content: [{ type: "text", text }] } });
}

/** Write complete records, one per LF-terminated line; returns each record's byte offset. */
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

/** Pull the user-feedback block out of the extraction prompt the SUT sends to the LLM. */
function userFeedbackFromPrompt(messages: unknown): string {
  const list = messages as Array<{ content: Array<{ text: string }> }>;
  const prompt = list[0]?.content?.[0]?.text ?? "";
  const match = /<user-feedback>\n([\s\S]*?)\n<\/user-feedback>/.exec(prompt);
  return match ? match[1] : "";
}

/** Pull the raw rules out of the review prompt the SUT sends to the LLM. */
function rulesFromPrompt(messages: unknown): string[] {
  const list = messages as Array<{ content: Array<{ text: string }> }>;
  const prompt = list[0]?.content?.[0]?.text ?? "";
  const match = /<rules>\n([\s\S]*?)\n<\/rules>/.exec(prompt);
  return match ? match[1].split("\n") : [];
}

function freshState(): PortraitPipelineState {
  return { ...DEFAULT_PIPELINE_STATE };
}

function configure(postExtractionEnabled: boolean): void {
  teardownTestSettings();
  setupTestSettings({ debugDumpLimit: 0, postExtractionEnabled });
}

/** The candidate a trio's first rule saves when post-review is off. */
function savedCandidate(trioId: string, file: string, entryIds: string[], text: string): PendingCandidate {
  return {
    candidateId: `${trioId}:0`,
    trioId,
    sourcePath: path.resolve(file),
    cwd: CWD,
    sessionId: SESSION_ID,
    entryIds,
    policyRevision: EXTRACTION_POLICY_REVISION,
    text,
    stage: "needsBuild",
    reviewContext: null,
  };
}

describe("work state written by a scan", () => {
  beforeEach(() => {
    portraitDir = path.join(os.tmpdir(), `scan-work-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    sessionDir = path.join(portraitDir, "sessions", "test-project");
    fs.mkdirSync(sessionDir, { recursive: true });
    setTestConfig({ portraitDir, sessionDirs: [path.join(portraitDir, "sessions")] });
    useStubs({ error: true });
    mockReportError.mockClear();
    configure(false);
    extractNotes = (userFeedback) => [userFeedback];
    reviewNotes = (rules) => rules;
    mockCallPortraitLlm.mockReset();
    mockCallPortraitLlm.mockImplementation(async (messages: unknown, systemPrompt: string) => {
      if (systemPrompt === POST_EXTRACTION_PROMPT) return reviewNotes(rulesFromPrompt(messages));
      const userFeedback = userFeedbackFromPrompt(messages);
      const notes = extractNotes(userFeedback);
      if (notes === undefined) return undefined;
      return {
        notes,
        summary: { agentBefore: "agent before", userFeedback, agentAfter: "agent after" },
      };
    });
  });

  afterEach(() => {
    teardownTestSettings();
    fs.rmSync(portraitDir, { recursive: true, force: true });
  });

  it("saves one snapshot per examined trio, each with its position and candidates", async () => {
    const file = path.join(sessionDir, "two-trios.jsonl");
    const offsets = writeSession(file, [
      HEADER,
      message("assistant", "A1 plan", "a1"),
      message("user", "U1 feedback", "u1"),
      message("assistant", "A2 reply", "a2"),
      message("user", "U2 feedback", "u2"),
      message("assistant", "A3 reply", "a3"),
    ]);

    const scan = await scanSessions(portraitDir, freshState(), 10, 100);
    expect(scan.results.map((result) => result.behaviorNotes)).toEqual([["U1 feedback"], ["U2 feedback"]]);

    const latest = loadLatestSnapshot(portraitDir);
    expect(latest?.manifest.seq).toBe(2);
    expect(latest?.state.scanPositions[file]?.lastByte).toBe(offsets[5]);
    const [first, second] = scan.results.map((result) => result.trioId);
    expect(latest?.state.pendingCandidates).toEqual([
      savedCandidate(first, file, ["a1", "u1", "a2"], "U1 feedback"),
      savedCandidate(second, file, ["a2", "u2", "a3"], "U2 feedback"),
    ]);
  });

  it("saves the position alone when a trio yields no rules", async () => {
    const file = path.join(sessionDir, "zero-rules.jsonl");
    const offsets = writeSession(file, [
      HEADER,
      message("assistant", "A1 plan", "a1"),
      message("user", "U1 feedback", "u1"),
      message("assistant", "A2 reply", "a2"),
    ]);
    extractNotes = () => [];

    const scan = await scanSessions(portraitDir, freshState(), 10, 100);
    expect(scan.stopReason).toBeNull();

    const latest = loadLatestSnapshot(portraitDir);
    expect(latest?.manifest.seq).toBe(1);
    expect(latest?.state.scanPositions[file]?.lastByte).toBe(offsets[3]);
    expect(latest?.state.pendingCandidates).toEqual([]);
  });

  it("writes no snapshot when an extraction fails", async () => {
    const file = path.join(sessionDir, "extraction-failure.jsonl");
    writeSession(file, [
      HEADER,
      message("assistant", "A1 plan", "a1"),
      message("user", "U1 feedback", "u1"),
      message("assistant", "A2 reply", "a2"),
    ]);
    extractNotes = () => undefined;

    const scan = await scanSessions(portraitDir, freshState(), 10, 100);
    expect(scan.stopReason).toBe("extraction_failed");
    expect(loadLatestSnapshot(portraitDir)).toBeNull();
    expect(fs.existsSync(path.join(portraitDir, "snapshots"))).toBe(false);
  });

  it("saves the raw rules before the review, then replaces them with the kept rules", async () => {
    configure(true);
    const file = path.join(sessionDir, "review-keeps-one.jsonl");
    const offsets = writeSession(file, [
      HEADER,
      message("assistant", "A1 plan", "a1"),
      message("user", "U1 feedback", "u1"),
      message("assistant", "A2 reply", "a2"),
    ]);
    extractNotes = () => ["rule one", "rule two"];
    let duringReview: Pick<PendingCandidate, "stage" | "text" | "reviewContext">[] | undefined;
    reviewNotes = (rules) => {
      expect(rules).toEqual(["rule one", "rule two"]);
      duringReview = loadLatestSnapshot(portraitDir)?.state.pendingCandidates.map((candidate) => ({
        stage: candidate.stage,
        text: candidate.text,
        reviewContext: candidate.reviewContext,
      }));
      return ["rule two"];
    };

    const scan = await scanSessions(portraitDir, freshState(), 10, 100);
    expect(scan.results.map((result) => result.behaviorNotes)).toEqual([["rule two"]]);

    const reviewContext = { agentBefore: "agent before", userFeedback: "U1 feedback", agentAfter: "agent after" };
    expect(duringReview).toEqual([
      { stage: "needsPostReview", text: "rule one", reviewContext },
      { stage: "needsPostReview", text: "rule two", reviewContext },
    ]);

    const latest = loadLatestSnapshot(portraitDir);
    expect(latest?.manifest.seq).toBe(2);
    expect(latest?.state.scanPositions[file]?.lastByte).toBe(offsets[3]);
    const trioId = scan.results[0].trioId;
    expect(latest?.state.pendingCandidates).toEqual([savedCandidate(trioId, file, ["a1", "u1", "a2"], "rule two")]);
  });

  it("removes the trio's candidates when the review keeps none", async () => {
    configure(true);
    const file = path.join(sessionDir, "review-keeps-none.jsonl");
    const offsets = writeSession(file, [
      HEADER,
      message("assistant", "A1 plan", "a1"),
      message("user", "U1 feedback", "u1"),
      message("assistant", "A2 reply", "a2"),
    ]);
    extractNotes = () => ["rule one", "rule two"];
    reviewNotes = () => [];

    const scan = await scanSessions(portraitDir, freshState(), 10, 100);
    expect(scan.results).toEqual([]);
    expect(scan.stopReason).toBeNull();

    const latest = loadLatestSnapshot(portraitDir);
    expect(latest?.manifest.seq).toBe(2);
    expect(latest?.state.scanPositions[file]?.lastByte).toBe(offsets[3]);
    expect(latest?.state.pendingCandidates).toEqual([]);
  });

  it("keeps the raw candidates and stops when the review fails", async () => {
    configure(true);
    const file = path.join(sessionDir, "review-fails.jsonl");
    const offsets = writeSession(file, [
      HEADER,
      message("assistant", "A1 plan", "a1"),
      message("user", "U1 feedback", "u1"),
      message("assistant", "A2 reply", "a2"),
    ]);
    extractNotes = () => ["rule one", "rule two"];
    reviewNotes = () => undefined;

    const scan = await scanSessions(portraitDir, freshState(), 10, 100);
    expect(scan.stopReason).toBe("review_failed");
    expect(mockReportError).toHaveBeenCalledWith(
      "Rule review failed; 2 extracted rules were kept and will be reviewed on the next run.",
      "review error",
    );

    const latest = loadLatestSnapshot(portraitDir);
    expect(latest?.manifest.seq).toBe(1);
    expect(latest?.state.scanPositions[file]?.lastByte).toBe(offsets[3]);
    expect(latest?.state.pendingCandidates.map((candidate) => [candidate.stage, candidate.text])).toEqual([
      ["needsPostReview", "rule one"],
      ["needsPostReview", "rule two"],
    ]);
  });

  it("resumes from the snapshot position, not from processed-sessions.json", async () => {
    const file = path.join(sessionDir, "resume.jsonl");
    writeSession(file, [
      HEADER,
      message("assistant", "A1 plan", "a1"),
      message("user", "U1 feedback", "u1"),
      message("assistant", "A2 reply", "a2"),
      message("user", "U2 feedback", "u2"),
      message("assistant", "A3 reply", "a3"),
    ]);

    const first = await scanSessions(portraitDir, freshState(), 10, 1);
    expect(first.results.map((result) => result.behaviorNotes)).toEqual([["U1 feedback"]]);

    fs.writeFileSync(path.join(portraitDir, "processed-sessions.json"), "{}", "utf-8");
    const second = await scanSessions(portraitDir, freshState(), 10, 100);
    expect(second.results.map((result) => result.behaviorNotes)).toEqual([["U2 feedback"]]);
  });

  it("rejects a corrupt snapshot without seeding from processed-sessions.json", async () => {
    const file = path.join(sessionDir, "corrupt.jsonl");
    writeSession(file, [
      HEADER,
      message("assistant", "A1 plan", "a1"),
      message("user", "U1 feedback", "u1"),
      message("assistant", "A2 reply", "a2"),
    ]);
    await scanSessions(portraitDir, freshState(), 10, 100);

    const snapshot = loadLatestSnapshot(portraitDir);
    if (!snapshot) throw new Error("the first scan saved no snapshot");
    fs.appendFileSync(path.join(snapshot.dir, "state.json"), " ", "utf-8");
    // An empty mirror would make a seeded scan start the file over and extract its trio again.
    fs.writeFileSync(path.join(portraitDir, "processed-sessions.json"), "{}", "utf-8");
    const callsBefore = mockCallPortraitLlm.mock.calls.length;

    await expect(scanSessions(portraitDir, freshState(), 10, 100)).rejects.toBeInstanceOf(SnapshotCorruptError);
    expect(mockCallPortraitLlm.mock.calls.length).toBe(callsBefore);
    expect(fs.readFileSync(path.join(portraitDir, "processed-sessions.json"), "utf-8")).toBe("{}");
  });
});
