// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// config.js + llm-call.js are mocked centrally in tests/setup.ts. The remaining dependencies
// (collector, builder, storage, footer, maintenance-core, error) are also centralized there with
// flag-gated stubs: the real implementations are always available, and a stub activates only when
// its flag is on (declared per-test via useStubs). This avoids the isolate:false mock collision
// where one file's vi.mock would decide a module's identity for the whole process.

import { buildPortrait } from "../src/builder.js";
import { countPendingTrios, scanSessions } from "../src/collector.js";
import { runMaintenance } from "../src/maintenance-core.js";
import { resetPipelineState, runPipelineLoop } from "../src/pipeline.js";
import type { PortraitSettings } from "../src/schema.js";
import { loadPortraitState, parsePortraitRules, readPortrait } from "../src/storage.js";
import type { PendingCandidate } from "../src/types.js";
import { EXTRACTION_POLICY_REVISION, loadWorkState, saveWorkState } from "../src/work-state.js";
import { setupTestSettings, teardownTestSettings } from "./settings-helpers.js";
import { getStubPortraitState, setTestConfig, useStubs } from "./setup.js";

const mockScanSessions = scanSessions as unknown as ReturnType<typeof vi.fn>;
const mockBuildPortrait = buildPortrait as unknown as ReturnType<typeof vi.fn>;
const mockLoadPortraitState = loadPortraitState as unknown as ReturnType<typeof vi.fn>;
const mockReadPortrait = readPortrait as unknown as ReturnType<typeof vi.fn>;
const mockCountPendingTrios = countPendingTrios as unknown as ReturnType<typeof vi.fn>;
const mockParsePortraitRules = parsePortraitRules as unknown as ReturnType<typeof vi.fn>;

let portraitDir: string;

/**
 * Make every scan pass save one pending `needsBuild` candidate per text — what the scan does at
 * its examined-trio boundary — and return the texts as that pass's results.
 */
function scanSavingCandidates(texts: string[]): void {
  mockScanSessions.mockImplementation(async () => {
    const work = loadWorkState(portraitDir);
    const candidates: PendingCandidate[] = texts.map((text, index) => ({
      candidateId: `saved:${index}`,
      trioId: `saved-${index}`,
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
      results: [{ behaviorNotes: texts, sessionPath: "/tmp/s1.jsonl", source: "main" }],
      remainingFiles: 0,
      triosProcessed: 1,
      totalKnownTrios: 1,
    };
  });
}

// ============================================================================
// runPipelineLoop tests
// ============================================================================
describe("runPipelineLoop", () => {
  const defaultSettings: PortraitSettings = {
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
    maintenanceEveryNRulesInserted: 200,
    maintenanceBackfillBatchSize: 1,
    maintenanceMaxTokens: 0,
    maintenanceTimeoutMs: 3_600_000,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Stub every dependency pipeline drives (real impls stay available for files that need them).
    useStubs({
      collector: true,
      builder: true,
      storage: true,
      footer: true,
      maintenanceCore: true,
      error: true,
    });
    // Redirect the central config mock to the work dir this suite uses.
    portraitDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-loop-"));
    setTestConfig({ portraitDir, sessionDirs: [path.join(portraitDir, "sessions")] });
    setupTestSettings(null);
    resetPipelineState(); // Reset pendingBgScan for test isolation

    // Reset mock state counter (centralized storage stub state)
    getStubPortraitState().rulesInsertedSinceMaintenance = 0;

    // Default: no more files after first scan
    mockScanSessions.mockResolvedValue({
      results: [{ behaviorNotes: ["rule-1"], sessionPath: "/tmp/s1.jsonl", source: "main" }],
      remainingFiles: 0,
      triosProcessed: 1,
      totalKnownTrios: 1,
    });
    mockBuildPortrait.mockResolvedValue(undefined);
    mockReadPortrait.mockReturnValue(null);
    mockParsePortraitRules.mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    teardownTestSettings();
    fs.rmSync(portraitDir, { recursive: true, force: true });
  });

  it("processes one batch and returns stats", async () => {
    const stats = await runPipelineLoop(defaultSettings, Infinity, () => false, null);
    expect(stats.totalSequences).toBe(1);
    expect(mockScanSessions).toHaveBeenCalledTimes(1);
  });

  it("respects maxSequences limit", async () => {
    mockScanSessions.mockResolvedValue({
      results: [{ behaviorNotes: ["rule-1"], sessionPath: "/tmp/s1.jsonl", source: "main" }],
      remainingFiles: 5,
      triosProcessed: 1,
      totalKnownTrios: 10,
    });

    const stats = await runPipelineLoop(defaultSettings, 1, () => false, null);
    expect(stats.totalSequences).toBe(1);
    expect(mockScanSessions).toHaveBeenCalledTimes(1);
  });

  it("stops when shouldCancel returns true", async () => {
    mockScanSessions.mockResolvedValue({
      results: [{ behaviorNotes: ["rule-1"], sessionPath: "/tmp/s1.jsonl", source: "main" }],
      remainingFiles: 5,
      triosProcessed: 1,
      totalKnownTrios: 10,
    });

    const stats = await runPipelineLoop(defaultSettings, Infinity, () => true, null);
    expect(stats.totalSequences).toBe(0);
    expect(mockScanSessions).not.toHaveBeenCalled();
  });

  it("applies rate limit delay after extraction", async () => {
    const settingsWithRateLimit = { ...defaultSettings, rateLimitMs: 1000 };
    mockScanSessions.mockResolvedValue({
      results: [{ behaviorNotes: ["rule-1"], sessionPath: "/tmp/s1.jsonl", source: "main" }],
      remainingFiles: 0,
      triosProcessed: 1,
      totalKnownTrios: 1,
    });

    const start = Date.now();
    const promise = runPipelineLoop(settingsWithRateLimit, Infinity, () => false, null);
    await vi.advanceTimersByTimeAsync(2000); // Fast-forward through delays
    const stats = await promise;
    const elapsed = Date.now() - start;
    expect(stats.totalSequences).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(1000); // At least 1s delay was applied
  }, 10000);

  it("resets progress counters before loop", async () => {
    await runPipelineLoop(defaultSettings, Infinity, () => false, null);
    const state = mockLoadPortraitState.mock.results[0]?.value;
    expect(state.totalKnownTrios).toBe(0);
    expect(state.triosProcessed).toBe(0);
    expect(state.scanSessionKB).toBe(0);
  });

  it("finalizes state to idle after loop", async () => {
    await runPipelineLoop(defaultSettings, Infinity, () => false, null);
    const state = mockLoadPortraitState.mock.results[0]?.value;
    expect(state.pipelinePhase).toBe("idle");
    expect(state.remainingFiles).toBe(0);
    expect(state.lastPipelineRun).toBeDefined();
    expect(state.lastScanTimestamp).toBeDefined();
  });

  it("does not rate limit when rateLimit is 0s", async () => {
    // With fake timers, if there's no delay, the promise resolves immediately
    const promise = runPipelineLoop(defaultSettings, Infinity, () => false, null);
    const stats = await promise;
    expect(stats.totalSequences).toBe(1);
  });

  it("spawns bg trio counter only once across multiple calls", async () => {
    mockScanSessions.mockResolvedValue({
      results: [{ behaviorNotes: ["rule-1"], sessionPath: "/tmp/s1.jsonl", source: "main" }],
      remainingFiles: 0,
      triosProcessed: 1,
      totalKnownTrios: 1,
    });

    // Make the bg scan slow so pendingBgScan stays non-null during both calls
    let resolveBgScan: (() => void) | undefined;
    mockCountPendingTrios.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveBgScan = () => resolve();
      }),
    );

    const p1 = runPipelineLoop(defaultSettings, Infinity, () => false, null);
    const p2 = runPipelineLoop(defaultSettings, Infinity, () => false, null);
    // Both calls started before bg scan finished — only one spawn
    resolveBgScan?.();
    await p1;
    await p2;
    expect(mockCountPendingTrios).toHaveBeenCalledTimes(1);
  });

  it("counts totalInserted from buildPortrait result", async () => {
    scanSavingCandidates(["rule-1"]);
    mockBuildPortrait.mockResolvedValue({ inserted: 2, evicted: 1, rules: [], evictedRules: [], droppedRules: [] });

    const stats = await runPipelineLoop(defaultSettings, Infinity, () => false, null);
    expect(stats.totalInserted).toBe(2);
    expect(stats.totalEvicted).toBe(1);
  });

  it("propagates errors from scanSessions", async () => {
    mockScanSessions.mockRejectedValue(new Error("scan failed"));

    await expect(runPipelineLoop(defaultSettings, Infinity, () => false, null)).rejects.toThrow("scan failed");
  });

  it("propagates errors from buildPortrait", async () => {
    scanSavingCandidates(["rule-1"]);
    mockBuildPortrait.mockRejectedValue(new Error("build failed"));

    await expect(runPipelineLoop(defaultSettings, Infinity, () => false, null)).rejects.toThrow("build failed");
  });

  it("respects mid-loop cancellation", async () => {
    let callCount = 0;
    mockScanSessions.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          results: [{ behaviorNotes: ["rule-1"], sessionPath: "/tmp/s1.jsonl", source: "main" }],
          remainingFiles: 2,
          triosProcessed: 1,
          totalKnownTrios: 3,
        });
      }
      return Promise.resolve({ results: [], remainingFiles: 0, triosProcessed: 0, totalKnownTrios: 0 });
    });
    mockParsePortraitRules.mockImplementation(() => []);
    mockBuildPortrait.mockResolvedValue(undefined);

    const cancelCb = () => {
      if (callCount >= 1) return true;
      return false;
    };

    const stats = await runPipelineLoop(defaultSettings, Infinity, cancelCb, null);
    expect(stats.totalSequences).toBe(1); // stopped after first iteration
  });

  it("preserves bg scan totalKnownTrios during finalization", async () => {
    mockCountPendingTrios.mockResolvedValue(42);
    mockScanSessions.mockResolvedValue({
      results: [],
      remainingFiles: 0,
      triosProcessed: 0,
      totalKnownTrios: 0,
    });

    await runPipelineLoop(defaultSettings, Infinity, () => false, null);

    // Advance timers to let bg scan microtask complete
    await vi.advanceTimersByTimeAsync(10);

    // totalKnownTrios should be 42 (set by bg scan, preserved by finalization)
    expect(getStubPortraitState().totalKnownTrios).toBe(42);
  });

  it("increments rulesInsertedSinceMaintenance counter on buildPortrait", async () => {
    scanSavingCandidates(["rule-1"]);
    mockBuildPortrait.mockResolvedValue({ inserted: 3, evicted: 0, rules: [], evictedRules: [], droppedRules: [] });

    await runPipelineLoop(defaultSettings, Infinity, () => false, null);

    expect(getStubPortraitState().rulesInsertedSinceMaintenance).toBe(3);
  });

  it("triggers auto-maintenance when counter reaches threshold", async () => {
    const mockRunMaintenance = runMaintenance as unknown as ReturnType<typeof vi.fn>;

    const settingsWithMaintenance = {
      ...defaultSettings,
      maintenanceEveryNRulesInserted: 5,
    };

    scanSavingCandidates(["rule-1"]);
    mockBuildPortrait.mockResolvedValue({ inserted: 6, evicted: 0, rules: [], evictedRules: [], droppedRules: [] });

    await runPipelineLoop(settingsWithMaintenance, Infinity, () => false, null);

    expect(mockRunMaintenance).toHaveBeenCalledTimes(1);
  });

  it("does not trigger auto-maintenance when counter is below threshold", async () => {
    const mockRunMaintenance = runMaintenance as unknown as ReturnType<typeof vi.fn>;

    const settingsWithMaintenance = {
      ...defaultSettings,
      maintenanceEveryNRulesInserted: 10,
    };

    scanSavingCandidates(["rule-1"]);
    mockBuildPortrait.mockResolvedValue({ inserted: 3, evicted: 0, rules: [], evictedRules: [], droppedRules: [] });

    await runPipelineLoop(settingsWithMaintenance, Infinity, () => false, null);

    expect(mockRunMaintenance).not.toHaveBeenCalled();
  });

  it("does not trigger auto-maintenance when maintenanceEveryNRulesInserted is 0", async () => {
    const mockRunMaintenance = runMaintenance as unknown as ReturnType<typeof vi.fn>;

    const settingsNoMaintenance = {
      ...defaultSettings,
      maintenanceEveryNRulesInserted: 0,
    };

    scanSavingCandidates(["rule-1"]);
    mockBuildPortrait.mockResolvedValue({ inserted: 100, evicted: 0, rules: [], evictedRules: [], droppedRules: [] });

    await runPipelineLoop(settingsNoMaintenance, Infinity, () => false, null);

    expect(mockRunMaintenance).not.toHaveBeenCalled();
  });
});
