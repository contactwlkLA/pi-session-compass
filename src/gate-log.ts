// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The gate log: one line per gate check in shadow or enforce, so the gate's
 * decisions on real sessions stay inspectable after the run. The entry copies
 * the result event and the trio identity only — never trio text and never the
 * credential. A failed write is ignored so the scan is never affected.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { GateCheck, GateMode } from "./gate.js";

/** The log's file name inside the portrait dir. */
export const GATE_LOG_FILE = "gate-log.jsonl";

/** One gate check as the log records it. */
export interface GateLogEntry {
  /** ISO time of the check. */
  ts: string;
  /** Resolved session file path (the check's `sourcePath`). */
  session: string;
  /** Session header id, or null. */
  sessionId: string | null;
  /** Stable trio identity (sha256 hex). */
  trioId: string;
  /** The trio's three record ids, null when a record has none. */
  entryIds: (string | null)[];
  mode: GateMode;
  policyHash: string;
  /** What the scan did with the trio: the event's `routed`. */
  decision: GateCheck["decision"];
  /** The event's `decision` when scored (`no_lesson` / `maybe_lesson`), its `fallbackReason` otherwise. */
  result: string;
  answers: Record<string, number> | null;
  model: string | null;
  attempts: number;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
}

/**
 * Append one entry as a JSON line. Swallows every error: the gate log is
 * best-effort evidence, and a write that fails (missing dir, permission,
 * the path taken by a directory) must not change the scan.
 */
export function appendGateLog(portraitDir: string, entry: GateLogEntry): void {
  try {
    fs.appendFileSync(path.join(portraitDir, GATE_LOG_FILE), `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    // ignored on purpose
  }
}
