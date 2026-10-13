// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * User-facing strings for the compass harness.
 *
 * DRAFT — pending Text Review approval (AGENTS.md protected-text rule).
 * Nothing in this file may be treated as approved product copy until the
 * operator approves the exact text in a session review.
 */

export const strings = {
  // ── Limits and switches ──
  missingSwitch: (name: string) =>
    `compass harness: missing required switch --${name}. ` +
    "The harness has no built-in limits; pass --run-type, --max-model-requests, and --max-run-ms.",
  invalidLimit: (flag: string, value: string) =>
    `compass harness: invalid value for ${flag} ('${value}') — expected a finite positive integer.`,
  invalidRunType: (value: string) =>
    `compass harness: unknown run type '${value}'. Valid run types: smoke, baseline, compare, evaluate, collect.`,

  // ── Start-of-run confirmation (compass.md rule 4) ──
  confirmHeader: "compass harness — start-of-run confirmation",
  confirmRunType: (runType: string) => `Run type: ${runType}`,
  confirmLimits: (requests: number, runMs: number) => `Limits: ${requests} model requests · ${runMs} ms wall clock`,
  confirmSuggested: (requests: number, runMs: number, source: string) =>
    `Suggested limits: ${requests} requests · ${runMs} ms (source: ${source})`,
  confirmSelection: (file: string, trios: number) => `Selected file: ${file} — ${trios} eligible trios`,
  confirmSelectionAll: (trios: number) =>
    `Selection: all session files in scope — ${trios} eligible trios in last census`,
  confirmOutputDir: (dir: string) => `Output directory: ${dir}`,
  costNoteLowerBound:
    "Each eligible trio needs at least one extraction request (a source-review lower bound, unmeasured).",
  costNoteSpend: "The limits cap requests and wall-clock time — not spend.",
  costNoteThinking: "Extraction runs at high thinking, so token cost is unknown until the provider reports usage.",
  costNoteCapped: "A capped run stops partway and is incomplete.",
  askProceed: "Proceed with this run? [y/N] ",
  refuseNoConfirm:
    "compass harness: refusing to run — no model request was made. " +
    "When an agent launches the harness, it must pass --confirmed only after the user approves these values in the session.",
  cancelled: "compass harness: cancelled — no model request was made.",

  // ── Selection ──
  selectionNotFound: (p: string) => `selection target not found: ${p}`,
  selectionNotAFile: (p: string) => `selection target is not a file: ${p}`,
  selectionNotJsonl: (p: string) => `selection target must be a .jsonl session file: ${p}`,
  selectionEmpty: (p: string) => `selection target is empty: ${p}`,

  // ── Run outcomes ──
  stopCompleted: (files: number) => `completed — the selected scope was covered (${files} sequences processed)`,
  stopRequestLimit: (n: number) => `stopped: request limit reached (${n} model requests)`,
  stopDeadline: (ms: number) => `stopped: run deadline reached (${ms} ms)`,
  stopCancelled: "stopped: cancelled",

  // ── Sheets ──
  smokeSheetTitle: "compass smoke results — samples, not a measurement",
  baselineSheetTitle: "compass baseline — running table",
  sheetColTrio: "Trio ref",
  sheetColExtractor: "Extractor output",
  sheetColBuilder: "Builder decision",
  sheetColPortrait: "Portrait diff",
  sheetColExamined: "Trios examined",
  sheetColProductiveRate: "Cumulative productive rate",
  sheetColCandidates: "Cumulative candidates",
  sheetColInsertMergeSkip: "Insert / merge / skip",
  sheetColPortraitSize: "Portrait size",
} as const;
