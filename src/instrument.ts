// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Zero-overhead instrumentation hooks for the compass harness (Stage 1 counters).
 *
 * Hooks are unset by default and every emit is a no-op, so pipeline behavior is
 * unchanged when the harness does not install them. The harness installs them
 * in the same process before running the pipeline loop.
 */

/** One extraction attempt over an agent→user→assistant trio, whether or not it produced notes. */
export interface TrioExaminedEvent {
  sessionPath: string;
  /** Number of candidate rules the extractor kept (0 = non-productive trio). */
  notes: number;
  /** Kept candidate rule texts (empty when non-productive; smoke-sheet evidence). */
  notesText: string[];
}

/** One building LLM call's decisions plus their applied effect. */
export interface BuildEvent {
  decisions: { action: "insert" | "merge" | "skip"; candidate?: string; text?: string }[];
  inserted: number;
  evicted: number;
}

/** One enforced rate-limit cooldown the pipeline actually slept through. */
export interface CooldownEvent {
  kind: "extraction" | "building";
  ms: number;
}

export interface InstrumentHooks {
  onTrioExamined?: (event: TrioExaminedEvent) => void;
  onBuild?: (event: BuildEvent) => void;
  onCooldown?: (event: CooldownEvent) => void;
}

let hooks: InstrumentHooks = {};

/** Install instrumentation hooks (pass an empty object to clear). */
export function setInstrumentHooks(next: InstrumentHooks): void {
  hooks = next;
}

export function emitTrioExamined(event: TrioExaminedEvent): void {
  hooks.onTrioExamined?.(event);
}

export function emitBuild(event: BuildEvent): void {
  hooks.onBuild?.(event);
}

export function emitCooldown(event: CooldownEvent): void {
  hooks.onCooldown?.(event);
}
