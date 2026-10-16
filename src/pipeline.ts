// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import "./globals.js";
import * as path from "node:path";
import { buildPortrait } from "./builder.js";
import { countPendingTrios, discoverFiles, reviewPendingCandidates, scanSessions } from "./collector.js";
import { getPortraitDir, getSessionDirs } from "./config.js";
import { reportError } from "./error.js";
import { setCachedPipelineState } from "./footer.js";
import { resetGateRun } from "./gate.js";
import { emitCooldown } from "./instrument.js";
import { type LlmProgressInfo, NO_LLM_PROGRESS_SINK, setLlmProgressSink } from "./llm-call.js";
import { NO_CANCEL_CHECK, runMaintenance } from "./maintenance-core.js";
import type { PortraitSettings } from "./schema.js";
import { loadPortraitState, savePortraitState } from "./storage.js";
import type { PipelineStopReason, PortraitPipelineState } from "./types.js";
import { getErrorMessage } from "./utils.js";
import { loadWorkState, saveWorkState, selectPendingForBuild } from "./work-state.js";

/** Sentinel: no build options (use defaults) */
const NO_BUILD_OPTIONS: undefined = undefined;

/** Process a single scan result per cycle (maxResults=1) — one session at a time in the eviction loop. */
const SINGLE_RESULT = 1;

type Settings = PortraitSettings;

/** Module-level reference to the in-flight bg trio counter — prevents concurrent spawns.
 * Note: if runPipelineLoop is called twice rapidly, the second call skips bg scan
 * spawn (pendingBgScan is non-null) and gets a stale totalKnownTrios from the first.
 * This is non-critical: the trio counter is an estimation for UI progress only.
 */
let pendingBgScan: Promise<void> | null = null;

/** Reset pendingBgScan — for test isolation. */
export function resetPipelineState(): void {
  pendingBgScan = null;
}

/** Stats returned from the shared pipeline loop. */
export interface PipelineStats {
  totalSequences: number;
  totalInserted: number;
  totalEvicted: number;
  /** Set when the run stopped on a failure before its scan was exhausted. */
  stopReason: PipelineStopReason | null;
}

/** What one build round over the pending candidates did. */
interface BuildRoundResult {
  /** Batches sent to the builder. */
  batches: number;
  inserted: number;
  evicted: number;
  stopReason: PipelineStopReason | null;
}

/**
 * Build the pending `needsBuild` candidates in batches of `batchSize`, passing their texts to the
 * builder and removing exactly each successful batch's candidate ids from the work state. The
 * first failed build stops the round: its batch and the batches after it stay pending.
 */
async function buildPendingCandidates(
  portraitDir: string,
  sourceFilter: string | null,
  pipelineState: PortraitPipelineState,
  batchSize: number,
): Promise<BuildRoundResult> {
  const work = loadWorkState(portraitDir);
  const pending = selectPendingForBuild(work, sourceFilter);
  let batches = 0;
  let inserted = 0;
  let evicted = 0;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    batches++;
    const result = await buildPortrait(
      portraitDir,
      batch.map((candidate) => candidate.text),
      NO_BUILD_OPTIONS,
    );
    // Clear streamed counters once the call completes
    pipelineState.llmTokens = 0;
    pipelineState.llmWords = 0;
    if (result === undefined) {
      const keptCount = selectPendingForBuild(work, sourceFilter).length;
      reportError(
        `Building failed; ${keptCount} candidate ${keptCount === 1 ? "rule was" : "rules were"} kept and will be built on the next run.`,
        "building error",
      );
      return { batches, inserted, evicted, stopReason: "build_failed" };
    }
    inserted += result.inserted;
    evicted += result.evicted;
    // Increment maintenance counter
    pipelineState.rulesInsertedSinceMaintenance = (pipelineState.rulesInsertedSinceMaintenance ?? 0) + result.inserted;
    savePortraitState(portraitDir, pipelineState);
    setCachedPipelineState(pipelineState);
    // Acknowledge the built batch: exactly its candidate ids leave the work state.
    const builtIds = new Set(batch.map((candidate) => candidate.candidateId));
    work.pendingCandidates = work.pendingCandidates.filter((candidate) => !builtIds.has(candidate.candidateId));
    saveWorkState(portraitDir, work);
  }
  return { batches, inserted, evicted, stopReason: null };
}

/** Whether any pending candidate awaits post-review for the given source filter. */
function hasPendingReviewWork(portraitDir: string, sourceFilter: string | null): boolean {
  const sourcePath = sourceFilter === null ? null : path.resolve(sourceFilter);
  return loadWorkState(portraitDir).pendingCandidates.some(
    (candidate) =>
      candidate.stage === "needsPostReview" && (sourcePath === null || candidate.sourcePath === sourcePath),
  );
}

/**
 * Shared processing loop: scan → rateLimit → build → rateLimit.
 * Used by both runProfilingCycle (timer) and collect (manual command).
 *
 * A run first reviews and builds the work an earlier run left pending; a stop during that drain
 * ends the run before the first scan.
 *
 * Handles: MB progress reset, trio counter reset + bg spawn, rate limiting, finalization.
 *
 * @param settings - portrait settings
 * @param maxSequences - max sequences to process (Infinity for no limit)
 * @param shouldCancel - called before each iteration; return true to stop (cancellation, etc.)
 * @param sourceFilter - when a path, only that session file's pending work is reviewed and built
 */
export async function runPipelineLoop(
  settings: Settings,
  maxSequences: number,
  shouldCancel: () => boolean,
  sourceFilter: string | null,
): Promise<PipelineStats> {
  resetGateRun();
  const portraitDir = getPortraitDir();
  const pipelineState = loadPortraitState(portraitDir);
  const rateLimitMs = settings.rateLimitMs;
  const batchSize = settings.buildingBatchSize;

  // Install progress sink: extraction + building LLM calls update the footer live.
  // Counters reset per attempt inside attemptWithRetries; we just mirror them to the cache.
  const progressSink = (info: LlmProgressInfo) => {
    pipelineState.llmTokens = info.tokens;
    pipelineState.llmWords = info.words;
    setCachedPipelineState(pipelineState);
  };
  setLlmProgressSink(progressSink);

  try {
    // Reset progress counters
    pipelineState.totalKnownTrios = 0;
    pipelineState.triosProcessed = 0;
    pipelineState.scanSessionKB = 0; // Session progress resets to 0

    // Pre-compute remaining KB (after checkpoints) before setting phase,
    // so footer shows "0.0/Remaining MB" immediately on collect start
    const maxAgeMs = settings.maxAgeDays * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - maxAgeMs;
    const sessionDirs = getSessionDirs();
    const allFiles = discoverFiles(sessionDirs, cutoff);
    const filesTotalKB = Math.round(allFiles.reduce((sum, f) => sum + f.size, 0) / 1024);
    const checkpointKB = Math.round(allFiles.reduce((sum, f) => sum + (f.checkpoint?.lastByte ?? 0), 0) / 1024);
    pipelineState.scanRemainingKB = filesTotalKB - checkpointKB;

    // Set pipeline phase to scanning
    pipelineState.pipelinePhase = "scanning";
    savePortraitState(portraitDir, pipelineState);
    setCachedPipelineState(pipelineState);

    // Spawn background trio counter (non-blocking)
    // Skip if one is already running — previous result is still valid
    if (!pendingBgScan) {
      pendingBgScan = countPendingTrios(portraitDir, settings.maxAgeDays)
        .then((total) => {
          const updated = loadPortraitState(portraitDir);
          updated.totalKnownTrios = total;
          savePortraitState(portraitDir, updated);
          const cached = globalThis.__piPortraitPipelineState;
          if (cached) {
            cached.totalKnownTrios = total;
          }
        })
        .catch(() => {
          /* bg scan failure is non-critical */
        })
        .finally(() => {
          pendingBgScan = null;
        });
    }

    let totalSequences = 0;
    let totalInserted = 0;
    let totalEvicted = 0;
    let remaining = 1;
    let stopReason: PipelineStopReason | null = null;

    // Finish the work an earlier run left pending before the first scan: review what awaits
    // post-review, then build what awaits building. A stop here ends the run.
    const hadPendingReview = hasPendingReviewWork(portraitDir, sourceFilter);
    stopReason = await reviewPendingCandidates(portraitDir, sourceFilter);
    if (hadPendingReview && stopReason === null && rateLimitMs > 0) {
      emitCooldown({ kind: "extraction", ms: rateLimitMs });
      await new Promise((resolve) => setTimeout(resolve, rateLimitMs));
    }
    if (stopReason === null) {
      const drained = await buildPendingCandidates(portraitDir, sourceFilter, pipelineState, batchSize);
      totalInserted += drained.inserted;
      totalEvicted += drained.evicted;
      stopReason = drained.stopReason;
      if (drained.batches > 0 && stopReason === null && rateLimitMs > 0) {
        emitCooldown({ kind: "building", ms: rateLimitMs });
        await new Promise((resolve) => setTimeout(resolve, rateLimitMs));
      }
    }

    while (stopReason === null && remaining > 0 && totalSequences < maxSequences && !shouldCancel()) {
      const scanResults = await scanSessions(portraitDir, pipelineState, 100, SINGLE_RESULT);
      remaining = scanResults.remainingFiles;
      if (scanResults.stopReason) stopReason = scanResults.stopReason;

      if (scanResults.results.length === 0) break;
      totalSequences += scanResults.results.length;

      // Cooldown after extraction LLM calls
      if (rateLimitMs > 0) {
        emitCooldown({ kind: "extraction", ms: rateLimitMs });
        await new Promise((resolve) => setTimeout(resolve, rateLimitMs));
      }

      pipelineState.pipelinePhase = "processing";
      savePortraitState(portraitDir, pipelineState);
      setCachedPipelineState(pipelineState);

      // Build the candidates this pass saved (and any left pending), acknowledging each batch.
      const built = await buildPendingCandidates(portraitDir, sourceFilter, pipelineState, batchSize);
      totalInserted += built.inserted;
      totalEvicted += built.evicted;
      if (built.stopReason !== null) stopReason = built.stopReason;
      // Cooldown after builder LLM calls
      if (built.batches > 0 && stopReason === null && rateLimitMs > 0) {
        emitCooldown({ kind: "building", ms: rateLimitMs });
        await new Promise((resolve) => setTimeout(resolve, rateLimitMs));
      }

      // Back to scanning for next file
      if (stopReason === null && remaining > 0 && totalSequences < maxSequences && !shouldCancel()) {
        pipelineState.pipelinePhase = "scanning";
        savePortraitState(portraitDir, pipelineState);
        setCachedPipelineState(pipelineState);
      }
    }

    // Finalize state — load fresh to merge any bg scan updates
    const finalState = loadPortraitState(portraitDir);
    // Merge bg scan totalKnownTrios if it completed
    if (finalState.totalKnownTrios > pipelineState.totalKnownTrios) {
      pipelineState.totalKnownTrios = finalState.totalKnownTrios;
    }
    // Set finalization fields directly on pipelineState (which is what gets saved)
    pipelineState.lastPipelineRun = new Date().toISOString();
    pipelineState.lastScanTimestamp = new Date().toISOString();
    pipelineState.pipelinePhase = "idle";
    pipelineState.remainingFiles = 0;
    pipelineState.llmTokens = 0;
    pipelineState.llmWords = 0;
    savePortraitState(portraitDir, pipelineState);
    setCachedPipelineState(pipelineState);

    // Auto-maintenance check
    if (
      stopReason === null &&
      settings.maintenanceEveryNRulesInserted > 0 &&
      (pipelineState.rulesInsertedSinceMaintenance ?? 0) >= settings.maintenanceEveryNRulesInserted &&
      !shouldCancel()
    ) {
      try {
        await runMaintenance(NO_CANCEL_CHECK);
      } catch (error) {
        reportError(`Auto-maintenance failed: ${getErrorMessage(error)}`, "maintenance error");
      }
    }

    return { totalSequences, totalInserted, totalEvicted, stopReason };
  } finally {
    // Release the sink so it doesn't outlive the collect cycle.
    // (Auto-maintenance, if it ran, already cleared+restored its own sink.)
    setLlmProgressSink(NO_LLM_PROGRESS_SINK);
  }
}
