// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * User-facing strings for the compass harness.
 */

/** Human labels for --limits-source values (start-of-run confirmation). */
const LIMIT_SOURCE_LABELS: Record<string, string> = {
  "compass-table": "compass.md table",
  "agent-suggestion": "agent suggestion",
  "user-override": "user override",
};

export const strings = {
  // ── Limits and switches ──
  missingSwitch: (name: string) =>
    `compass harness: missing required switch --${name}. ` +
    "The harness has no built-in limits; pass --run-type, --max-model-requests, --max-run-ms, and --limits-source.",
  invalidLimit: (flag: string, value: string) =>
    `compass harness: invalid value for ${flag} ('${value}') — expected a finite positive integer.`,
  invalidLimitSource: (value: string) =>
    `compass harness: invalid value for --limits-source ('${value}') — expected compass-table, agent-suggestion, or user-override.`,
  invalidRunType: (value: string) =>
    `compass harness: unknown run type '${value}'. Valid run types: smoke, baseline, compare, evaluate, collect.`,

  // ── Start-of-run confirmation (compass.md rule 4) ──
  confirmHeader: "compass harness — start-of-run confirmation",
  confirmRunType: (runType: string) => `Run type: ${runType}`,
  confirmLimits: (requests: number, runMs: number) =>
    `Limits: ${requests} model requests · ${runMs} ms (${runMs / 60_000} min) wall clock`,
  confirmLimitSource: (source: string) => `Limit source: ${LIMIT_SOURCE_LABELS[source] ?? source}`,
  confirmModel: (model: string, thinking: string) => `Model: ${model} · thinking: ${thinking}`,
  confirmSelection: (file: string, trios: number) => `Selected file: ${file} — ${trios} eligible trios`,
  confirmSelectionAll: (trios: number) =>
    `Selection: all session files in scope — ${trios} eligible trios in last census`,
  confirmOutputDir: (dir: string) => `Output directory: ${dir}`,
  confirmStartSnapshot: (dir: string) => `Starting portrait: ${dir} (frozen snapshot)`,
  confirmStartLive: (dir: string) => `Starting portrait: ${dir} (live — snapshot taken at this run)`,
  confirmCapped: (requests: number, trios: number) =>
    `Capped: the request limit (${requests}) is below the eligible trio count (${trios}); the run will stop before covering every trio.`,
  costNoteLowerBound:
    "Each eligible trio needs at least one extraction request (a source-review lower bound, unmeasured).",
  costNoteSpend: "The limits cap requests and wall-clock time — not spend.",
  costNoteThinking: (thinking: string) =>
    `Extraction runs at ${thinking} thinking, so token cost is unknown until the provider reports usage.`,
  costNoteCapped: "A capped run stops partway and is incomplete.",
  askOwnLimits: "To use other limits, answer N and rerun with your own --max-model-requests and --max-run-ms.",
  askProceed: "Proceed with this run? [y/N] ",
  refuseNoConfirm:
    "compass harness: refusing to run — no model request was made. " +
    "When an agent launches the harness, it must pass --confirmed only after the user approves these values in the session.",
  cancelled: "compass harness: cancelled — no model request was made.",

  // ── Starting snapshot ──
  startSnapshotNotFound: (dir: string) =>
    `compass harness: start snapshot not found: ${dir} — no model request was made.`,
  startSnapshotNoHashes: (dir: string) =>
    `compass harness: start snapshot has no hashes.json: ${dir} — no model request was made.`,
  startSnapshotMismatch: (file: string, dir: string) =>
    `compass harness: start snapshot does not match its recorded hashes (${file}): ${dir} — no model request was made.`,

  // ── Selection ──
  selectionNotFound: (p: string) => `compass harness: selection target not found: ${p}`,
  selectionNotAFile: (p: string) => `compass harness: selection target is not a file: ${p}`,
  selectionNotJsonl: (p: string) => `compass harness: selection target must be a .jsonl session file: ${p}`,
  selectionEmpty: (p: string) => `compass harness: selection target is empty: ${p}`,
  unknownScope: (raw: string) => `compass harness: unknown scope '${raw}' — valid scopes: all, file`,
  scopeFileNeedsSession: "compass harness: scope=file requires --session <path>",
  frozenCopyMismatch: (file: string) => `compass harness: frozen copy hash mismatch for ${file}`,

  // ── Prepare summary ──
  prepareOutput: (dir: string) => `output: ${dir}`,
  prepareSelected: (file: string, sha256: string, trios: number) =>
    `selected: ${file} (sha256 ${sha256}…, ${trios} trios)`,
  prepareManifest: (path: string) => `manifest: ${path}`,
  prepareSelectionAll: "selection: all session files",

  // ── Run outcomes ──
  stopCompleted: (n: number) =>
    `completed — the selected scope was covered (${n} ${n === 1 ? "sequence" : "sequences"} processed)`,
  stopRequestLimit: (n: number) => `stopped: request limit reached (${n} model requests)`,
  stopDeadline: (ms: number) => `stopped: run deadline reached (${ms} ms)`,
  stopCancelled: "stopped: cancelled",
  limitReached: (kind: string) => `compass harness: limit reached (${kind}) — run incomplete, evidence preserved.`,
  errorSeeReceipt: "error — see receipt for details",
  runFailed: (message: string) => `compass harness: run failed: ${message}`,
  modelUnavailable: (modelString: string) => `model '${modelString}' unavailable: not found in the model registry`,
  noModelOverride: "no portrait model override and no resolvable host default model",
  workspaceRootNotFound: "compass harness: workspace root not found (md/compass.md + biome.json)",

  // ── Usage ──
  usageHeader: "compass harness: expected 'prepare' or 'execute'.",
  usagePrepare: "  prepare  --session <jsonl> [--scope file|all] [--output <dir>]",
  usageExecute:
    "  execute  --session <jsonl> --run-type <t> --max-model-requests N --max-run-ms N --limits-source <s> [--confirmed] [--start-snapshot <dir>]",

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
  sheetSelectedScope: (scope: string, sourcePath: string | null) =>
    `Selected scope: ${scope}${sourcePath ? ` — ${sourcePath}` : ""}`,
  sheetTriosExamined: (trios: number, builds: number, before: number, after: number) =>
    `Trios examined: ${trios} · builds: ${builds} · portrait rules: ${before} → ${after}`,
  sheetTrioHeader: (index: number, ref: string) => `## Trio ${index} (${ref})`,
  sheetNoneProductive: "(none — non-productive trio)",
  sheetBuildHeader: (index: number) => `## Build ${index}`,
  sheetNoText: "(no text)",
  sheetPortraitDiff: (inserted: number, evicted: number) => `+${inserted} inserted · ${evicted} evicted`,
  sheetFinalDiffHeader: "## Final portrait diff",
  sheetAdded: (n: number) => `Added (${n}):`,
  sheetRemoved: (n: number) => `Removed (${n}):`,
} as const;
