// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Pending candidates and the runs that build them: a candidate a run left pending (that run died
 * before its build) is built by the next run with no re-extraction, a failed build keeps every
 * candidate and stops the run, successful batches are acknowledged and a second run builds
 * nothing, a source filter builds only its own source, and a pending post-review group is
 * reviewed at the start of the next run.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, type vi } from "vitest";
import { buildPortrait } from "../src/builder.js";
import { scanSessions } from "../src/collector.js";
import { reportError } from "../src/error.js";
import { callPortraitLlm } from "../src/llm-call.js";
import { resetPipelineState, runPipelineLoop } from "../src/pipeline.js";
import { POST_EXTRACTION_PROMPT } from "../src/prompts.js";
import type { PortraitSettings } from "../src/schema.js";
import type { PendingCandidate, PortraitPipelineState } from "../src/types.js";
import { DEFAULT_PIPELINE_STATE } from "../src/types.js";
import { EXTRACTION_POLICY_REVISION, loadWorkState, saveWorkState } from "../src/work-state.js";
import { setupTestSettings, teardownTestSettings } from "./settings-helpers.js";
import { setTestConfig, useStubs } from "./setup.js";

const mockCallPortraitLlm = callPortraitLlm as unknown as ReturnType<typeof vi.fn>;
const mockBuildPortrait = buildPortrait as unknown as ReturnType<typeof vi.fn>;
const mockReportError = reportError as unknown as ReturnType<typeof vi.fn>;

const SESSION_ID = "pending-session";
const CWD = "/work/project";
const HEADER = JSON.stringify({ type: "session", id: SESSION_ID, cwd: CWD });
const NO_SOURCE_FILTER: null = null;
const NO_ENTRY_IDS: (string | null)[] = [null, null, null];

let portraitDir: string;
let sessionDir: string;
let settings: PortraitSettings;

function assistantRecord(text: string, id: string): string {
  return JSON.stringify({
    type: "message",
    id,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function userRecord(text: string, id: string): string {
  return JSON.stringify({
    type: "message",
    id,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

/** Write complete LF-terminated records. */
function writeSession(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
}

function freshState(): PortraitPipelineState {
  return { ...DEFAULT_PIPELINE_STATE };
}

function needsBuild(trioId: string, sourcePath: string, index: number, text: string): PendingCandidate {
  return {
    candidateId: `${trioId}:${index}`,
    trioId,
    sourcePath: path.resolve(sourcePath),
    cwd: CWD,
    sessionId: SESSION_ID,
    entryIds: NO_ENTRY_IDS,
    policyRevision: EXTRACTION_POLICY_REVISION,
    text,
    stage: "needsBuild",
    reviewContext: null,
  };
}

function needsPostReview(trioId: string, sourcePath: string, index: number, text: string): PendingCandidate {
  return {
    ...needsBuild(trioId, sourcePath, index, text),
    stage: "needsPostReview",
    reviewContext: { agentBefore: "before", userFeedback: "feedback", agentAfter: "after" },
  };
}

/** Save candidates into the work state, as a scan does at its examined-trio boundary. */
function seedPending(candidates: PendingCandidate[]): void {
  const work = loadWorkState(portraitDir);
  work.pendingCandidates.push(...candidates);
  saveWorkState(portraitDir, work);
}

/** The pending candidates as `[stage, text]` pairs, in stored order. */
function pendingStages(): [string, string][] {
  return loadWorkState(portraitDir).pendingCandidates.map((candidate) => [candidate.stage, candidate.text]);
}

function buildResult(inserted: number): Record<string, unknown> {
  return { inserted, evicted: 0, rules: [], evictedRules: [], droppedRules: [] };
}

describe("pending candidates built by later runs", () => {
  beforeEach(() => {
    portraitDir = path.join(os.tmpdir(), `pending-build-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    sessionDir = path.join(portraitDir, "sessions", "test-project");
    fs.mkdirSync(sessionDir, { recursive: true });
    setTestConfig({ portraitDir, sessionDirs: [path.join(portraitDir, "sessions")] });
    useStubs({ builder: true, error: true, footer: true, maintenanceCore: true });
    resetPipelineState();
    mockReportError.mockClear();
    mockCallPortraitLlm.mockReset();
    mockBuildPortrait.mockReset();
    mockBuildPortrait.mockResolvedValue(buildResult(1));
    settings = setupTestSettings({
      debugDumpLimit: 0,
      postExtractionEnabled: false,
      buildingBatchSize: 1,
      maintenanceEveryNRulesInserted: 0,
      rateLimitMs: 0,
    });
  });

  afterEach(() => {
    teardownTestSettings();
    fs.rmSync(portraitDir, { recursive: true, force: true });
  });

  it("builds a candidate a crashed run left pending, with no re-extraction", async () => {
    const file = path.join(sessionDir, "crash.jsonl");
    writeSession(file, [
      HEADER,
      assistantRecord("A1 plan", "1"),
      userRecord("U1 feedback", "2"),
      assistantRecord("A2 reply", "3"),
    ]);
    mockCallPortraitLlm.mockResolvedValue({
      notes: ["U1 rule"],
      summary: { agentBefore: "before", userFeedback: "feedback", agentAfter: "after" },
    });

    // First run: the scan saves the candidate at its examined-trio boundary, then dies before the build.
    const first = await scanSessions(portraitDir, freshState(), 10, 100);
    expect(first.stopReason).toBeNull();
    expect(pendingStages()).toEqual([["needsBuild", "U1 rule"]]);
    const extractionCalls = mockCallPortraitLlm.mock.calls.length;
    expect(extractionCalls).toBe(1);

    // Next run: the pending candidate is built and the trio is not extracted again.
    const stats = await runPipelineLoop(settings, Infinity, () => false, NO_SOURCE_FILTER);
    expect(stats.stopReason).toBeNull();
    expect(mockCallPortraitLlm.mock.calls.length).toBe(extractionCalls);
    expect(mockBuildPortrait).toHaveBeenCalledTimes(1);
    expect(mockBuildPortrait.mock.calls[0][1]).toEqual(["U1 rule"]);
    expect(pendingStages()).toEqual([]);
  });

  it("keeps the candidates and stops with the building message when a build fails", async () => {
    const file = path.join(sessionDir, "failure.jsonl");
    seedPending([needsBuild("t1", file, 0, "rule one"), needsBuild("t1", file, 1, "rule two")]);
    mockBuildPortrait.mockResolvedValue(undefined);

    const stats = await runPipelineLoop(settings, Infinity, () => false, NO_SOURCE_FILTER);
    expect(stats.stopReason).toBe("build_failed");
    expect(stats.totalSequences).toBe(0);
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError).toHaveBeenCalledWith(
      "Building failed; 2 candidate rules were kept and will be built on the next run.",
      "building error",
    );
    expect(pendingStages()).toEqual([
      ["needsBuild", "rule one"],
      ["needsBuild", "rule two"],
    ]);
  });

  it("keeps the failed batch and the batches after it while earlier batches stay acknowledged", async () => {
    const file = path.join(sessionDir, "partial.jsonl");
    seedPending([
      needsBuild("t1", file, 0, "rule one"),
      needsBuild("t2", file, 0, "rule two"),
      needsBuild("t3", file, 0, "rule three"),
    ]);
    mockBuildPortrait.mockResolvedValueOnce(buildResult(1)).mockResolvedValueOnce(undefined);

    const stats = await runPipelineLoop(settings, Infinity, () => false, NO_SOURCE_FILTER);
    expect(stats.stopReason).toBe("build_failed");
    expect(mockBuildPortrait).toHaveBeenCalledTimes(2);
    expect(mockReportError).toHaveBeenCalledWith(
      "Building failed; 2 candidate rules were kept and will be built on the next run.",
      "building error",
    );
    // The built batch left the work state; the failed batch and the one after it stayed.
    expect(pendingStages()).toEqual([
      ["needsBuild", "rule two"],
      ["needsBuild", "rule three"],
    ]);
  });

  it("acknowledges successful batches and a second run builds nothing", async () => {
    const file = path.join(sessionDir, "acknowledged.jsonl");
    seedPending([needsBuild("t1", file, 0, "rule one"), needsBuild("t1", file, 1, "rule two")]);
    mockBuildPortrait.mockResolvedValue(buildResult(2));

    const batched: PortraitSettings = { ...settings, buildingBatchSize: 2 };
    const first = await runPipelineLoop(batched, Infinity, () => false, NO_SOURCE_FILTER);
    expect(first.stopReason).toBeNull();
    expect(first.totalInserted).toBe(2);
    expect(mockBuildPortrait).toHaveBeenCalledTimes(1);
    expect(mockBuildPortrait.mock.calls[0][1]).toEqual(["rule one", "rule two"]);
    expect(pendingStages()).toEqual([]);

    const second = await runPipelineLoop(batched, Infinity, () => false, NO_SOURCE_FILTER);
    expect(second.stopReason).toBeNull();
    expect(mockBuildPortrait).toHaveBeenCalledTimes(1);
  });

  it("builds only the selected source's candidates and leaves the others pending", async () => {
    const fileA = path.join(sessionDir, "a.jsonl");
    const fileB = path.join(sessionDir, "b.jsonl");
    seedPending([needsBuild("ta", fileA, 0, "rule A"), needsBuild("tb", fileB, 0, "rule B")]);

    const stats = await runPipelineLoop(settings, Infinity, () => false, fileA);
    expect(stats.stopReason).toBeNull();
    expect(mockBuildPortrait).toHaveBeenCalledTimes(1);
    expect(mockBuildPortrait.mock.calls[0][1]).toEqual(["rule A"]);
    expect(pendingStages()).toEqual([["needsBuild", "rule B"]]);
  });

  it("reviews a pending needsPostReview group at the start of the next run", async () => {
    const file = path.join(sessionDir, "review.jsonl");
    seedPending([needsPostReview("tr", file, 0, "raw one"), needsPostReview("tr", file, 1, "raw two")]);
    mockCallPortraitLlm.mockResolvedValue(["kept rule"]);

    const stats = await runPipelineLoop(settings, Infinity, () => false, NO_SOURCE_FILTER);
    expect(stats.stopReason).toBeNull();
    // The review call happens before anything is built.
    expect(mockCallPortraitLlm).toHaveBeenCalledTimes(1);
    expect(mockCallPortraitLlm.mock.calls[0][1]).toBe(POST_EXTRACTION_PROMPT);
    expect(mockBuildPortrait).toHaveBeenCalledTimes(1);
    expect(mockBuildPortrait.mock.calls[0][1]).toEqual(["kept rule"]);
    expect(pendingStages()).toEqual([]);
  });

  it("stops at a failed pending review without building and keeps every candidate", async () => {
    const file = path.join(sessionDir, "review-failure.jsonl");
    seedPending([
      needsBuild("tb", file, 0, "kept rule"),
      needsPostReview("tr", file, 0, "raw one"),
      needsPostReview("tr", file, 1, "raw two"),
    ]);
    mockCallPortraitLlm.mockResolvedValue(undefined);

    const stats = await runPipelineLoop(settings, Infinity, () => false, NO_SOURCE_FILTER);
    expect(stats.stopReason).toBe("review_failed");
    expect(stats.totalSequences).toBe(0);
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError).toHaveBeenCalledWith(
      "Rule review failed; 2 extracted rules were kept and will be reviewed on the next run.",
      "review error",
    );
    expect(mockBuildPortrait).not.toHaveBeenCalled();
    expect(pendingStages()).toEqual([
      ["needsBuild", "kept rule"],
      ["needsPostReview", "raw one"],
      ["needsPostReview", "raw two"],
    ]);
  });
});
