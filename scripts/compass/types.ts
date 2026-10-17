// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/** Shared types for the compass harness. */

import type { GateMode } from "../../src/gate.js";

/** Where a run's gate mode came from: the --gate-mode flag or the settings snapshot. */
export type GateModeSource = "flag" | "settings";

/** The run's resolved gate selection, carried to the confirmation, the manifest, and the pipeline. */
export interface GateRunConfig {
  mode: GateMode;
  source: GateModeSource;
  /** First 12 hex digits of the policy hash; recorded with every gate result. */
  policyHash: string;
  /** The classifier release every gate request is pinned to. */
  model: string;
}

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
  /** Isolated session root the pipeline scans; holds exactly the selected file under selected/ (scope=file only). */
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
  /** The response's stopReason as reported by the provider layer. */
  stopReason?: string;
  usage?: { input?: number; output?: number };
  /** Portrait attempt tag, when the request originated from an instrumented attempt. */
  stage?: string;
  attempt?: number;
}

export interface CounterSnapshot {
  requestCount: number;
  /** Boundary calls refused at a ceiling (no request issued). */
  refusedCount: number;
  elapsedMs: number;
  stopReason: "requests" | "deadline" | "aborted" | null;
  traces: TraceEntry[];
  usageTotals: { input: number; output: number; unknown: number };
}

/** One corpus partition: the development set or the held-out set. */
export type CorpusSet = "dev" | "heldout";

/** One trio line of a labels file. */
export interface LabelRow {
  key: string;
  label: "lesson" | "no_lesson";
  correction: boolean;
  source: "cc-draft" | "cc-draft-user-checked" | "user";
  note: string;
}

/** One line of a score run's scores.jsonl, as the label sheet and the evaluator read it. */
export interface ScoreResultRow {
  key: string;
  verdict: "no_lesson" | "maybe_lesson" | "fallback" | "not_run";
  answers: Record<string, number> | null;
  reason: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  attempts: number;
}

/** One line of an extract run's extract.jsonl, as the label sheet and the evaluator read it. */
export interface ExtractResultRow {
  key: string;
  outcome: "success" | "failed" | "not_run";
  notes: string[];
  attempts: number;
  usage: { input: number; output: number } | null;
}

/** A candidate gate policy file. */
export interface PolicyFile {
  name: string;
  questions: string[];
  thresholds: Record<string, number>;
}

/** One trio line of a frozen corpus's trios.jsonl. */
export interface CorpusTrio {
  key: string;
  set: CorpusSet;
  sessionId: string;
  /** Path of the frozen copy, relative to the corpus root. */
  file: string;
  /** 1-based position of the trio within its session file. */
  index: number;
  lines: { agentBefore: number; userFeedback: number; agentAfter: number };
  chars: { agentBefore: number; userFeedback: number; agentAfter: number };
}
