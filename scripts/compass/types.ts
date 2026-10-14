// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/** Shared types for the compass harness. */

export type RunType = "smoke" | "baseline" | "compare" | "evaluate" | "collect";

export const RUN_TYPES: RunType[] = ["smoke", "baseline", "compare", "evaluate", "collect"];

export type Scope = "all" | "file";

/** Frozen copy of the user-selected session file. */
export interface FrozenFile {
  sourcePath: string;
  /** Canonical frozen copy under fixtures/sessions/. */
  storedPath: string;
  sha256: string;
  sizeBytes: number;
}

/** Where a run's starting portrait came from, recorded in the manifest. */
export interface StartPortrait {
  source: "snapshot" | "live";
  dir: string;
  digest: string;
}

/** The selection object shared with the pipeline and counter before any model call. */
export interface RunSelection {
  scope: Scope;
  runId: string;
  outputDir: string;
  /** Present only for scope=file. */
  frozen?: FrozenFile;
  /** Isolated dir containing exactly the selected file (scope=file only). */
  isolatedSessionDir?: string;
  createdAt: string;
}

export interface Limits {
  runType: RunType;
  maxModelRequests: number;
  maxRunMs: number;
  /** Provenance: compass.md table row, agent suggestion, or user override. */
  source: "compass-table" | "agent-suggestion" | "user-override";
}

/** One trio located by the offline census, with 1-based line references into the JSONL. */
export interface CensusTrio {
  trioIndex: number;
  agentBeforeLine: number;
  userFeedbackLine: number;
  agentAfterLine: number;
}

export interface CensusResult {
  file: string;
  sha256: string;
  totalTrios: number;
  nonEmptyLines: number;
  trios: CensusTrio[];
}

/** One recorded model request at the streamFn boundary. */
export interface TraceEntry {
  seq: number;
  model: string;
  provider: string;
  startedAtMs: number;
  endedAtMs: number;
  outcome: "ok" | "error" | "refused";
  error?: string;
  usage?: { input?: number; output?: number };
  /** Portrait attempt tag, when the request originated from an instrumented attempt. */
  stage?: string;
  attempt?: number;
}

export interface CounterSnapshot {
  requestCount: number;
  elapsedMs: number;
  stopReason: "requests" | "deadline" | "aborted" | null;
  traces: TraceEntry[];
  usageTotals: { input: number; output: number; unknown: number };
}
