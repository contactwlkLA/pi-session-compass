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
  invalidGateMode: "--gate-mode must be off, shadow, or enforce",

  // ── Start-of-run confirmation (compass.md rule 4) ──
  confirmHeader: "compass harness — start-of-run confirmation",
  confirmRunType: (runType: string) => `Run type: ${runType}`,
  confirmLimits: (requests: number, runMs: number) =>
    `Limits: ${requests} model requests · ${runMs} ms (${Math.round(runMs / 6000) / 10} min) wall clock`,
  confirmLimitSource: (source: string) => `Limit source: ${LIMIT_SOURCE_LABELS[source] ?? source}`,
  confirmModel: (model: string, thinking: string) => `Model: ${model} · thinking: ${thinking}`,
  confirmGate: (mode: string, hash: string) =>
    `Jev gate: ${mode} (policy ${hash}) — each eligible trio also makes one Jev request (two with a retry).`,
  confirmGateOff: "Jev gate: off",
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
  stopPipelineFailed: (stage: string) => `stopped: ${stage} failed; pending work was kept (see diagnostics.log)`,
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
    "  execute  --session <jsonl> --run-type <t> --max-model-requests N --max-run-ms N --limits-source <s> " +
    "[--confirmed] [--start-snapshot <dir>] [--gate-mode off|shadow|enforce]",

  // ── Corpus freeze ──
  corpusMissingFlags: "compass corpus: --source <dir> (one or more), --output <dir> and --seed <text> are required",
  corpusNotDirectory: (dir: string) => `compass corpus: ${dir} is not a directory`,
  corpusOutputExists: (dir: string) => `compass corpus: ${dir} already exists; a frozen corpus is never overwritten`,
  corpusCountMismatch: (file: string, detector: number, census: number) =>
    `compass corpus: ${file} has ${detector} trios by the detector and ${census} by the census; nothing was frozen`,
  corpusFrozen: (
    sessions: number,
    trios: number,
    devSessions: number,
    devTrios: number,
    heldSessions: number,
    heldTrios: number,
    dir: string,
  ) =>
    `Corpus frozen: ${sessions} sessions, ${trios} trios · dev ${devSessions} sessions / ${devTrios} trios ` +
    `· held-out ${heldSessions} sessions / ${heldTrios} trios → ${dir}`,

  // ── Corpus scoring ──
  scoreCorpusChanged: (dir: string) =>
    `compass score: the corpus at ${dir} changed after it was frozen; no request was made`,
  scoreBadSet: "compass score: --set must be dev, heldout, or all",
  scoreHeader: "compass score — Jev classifier only (no extraction, no building, no portrait)",
  scoreCorpus: (dir: string, set: string, trios: number, cached: number, toScore: number) =>
    `Corpus: ${dir} · set ${set}: ${trios} trios (${cached} cached, ${toScore} to score)`,
  scoreModel: (model: string, hash: string, concurrency: number) =>
    `Jev model: ${model} · policy ${hash} · ${concurrency} at once`,
  scoreOutput: (dir: string) => `Output: ${dir}`,
  scoreNotConfirmed: "Not confirmed: pass --confirmed after the user approves these values. No request was made.",
  scoreNoKey: "compass score: TYPESAFE_API_KEY is not set. No request was made.",
  scoreDone: (scored: number, cached: number, fallbacks: number, notRun: number, requests: number, stop: string) =>
    `Scored ${scored} · cached ${cached} · fallbacks ${fallbacks} · not run ${notRun} · requests ${requests} · stop: ${stop}`,
  scoreBadConcurrency: "compass score: --concurrency must be an integer from 1 to 8",
  scoreProgress: (done: number, total: number, verdict: string) => `trio ${done}/${total}: ${verdict}`,
  scoreBadQuestions: (file: string) => `compass score: ${file} is not a valid question set`,
  scoreModelQuestions: (model: string, name: string, hash: string, concurrency: number) =>
    `Jev model: ${model} · questions ${name} (${hash}) · ${concurrency} at once`,
  codesTitle: (name: string, set: string, scored: number) =>
    `# Reply codes — ${name}, set ${set}, ${scored} scored trios (an answer ≥ 0.50 counts as yes)`,
  codesTableHeader: (ids: string[]) => `| folder | session | trios | ${ids.join(" | ")} |`,
  codesTotalCell: "all",
  codesExamplesHeading: (id: string) => `## ${id}: top replies`,
  codesExampleLine: (answer: string, session: string, index: number, reply: string) =>
    `- ${answer} · ${session} trio ${index} · ${reply}`,

  // ── Corpus extraction ──
  extractHeader: "compass extract — extraction only (no review, no building, no portrait)",
  extractCorpus: (dir: string, set: string, trios: number, cached: number, toRun: number) =>
    `Corpus: ${dir} · set ${set}: ${trios} trios (${cached} cached, ${toRun} to extract)`,
  extractModel: (provider: string, id: string, thinking: string, revision: string, concurrency: number) =>
    `Extractor: ${provider}/${id} · thinking ${thinking} · revision ${revision} · ${concurrency} at once`,
  extractProgress: (done: number, total: number, rules: number) => `trio ${done}/${total}: ${rules} rules`,
  extractFailed: (done: number, total: number) => `trio ${done}/${total}: failed`,
  extractDone: (ok: number, cached: number, failed: number, notRun: number, requests: number, stop: string) =>
    `Extracted ${ok} · cached ${cached} · failed ${failed} · not run ${notRun} · requests ${requests} · stop: ${stop}`,

  // ── Labels and evaluation ──
  labelsMissingFlag: (tool: string, flag: string) => `compass ${tool}: ${flag} is required`,
  labelsBadSet: (tool: string) => `compass ${tool}: --set must be dev or heldout`,
  labelsBadSelection: "compass labels: --select must be all or review",
  labelsReviewNeedsLabels: "compass labels: --select review needs --labels",
  labelsInputMismatch: (tool: string, file: string, set: string, corpus: string) =>
    `compass ${tool}: ${file} does not cover set ${set} of ${corpus}`,
  labelsProblem: (key: string, problem: string) => `compass labels: ${key} ${problem}`,
  labelsProblemMissing: "is missing",
  labelsProblemDuplicate: "appears more than once",
  labelsProblemNotInSet: (set: string) => `is not in set ${set}`,
  labelsProblemInvalidField: (field: string) => `has an invalid field: ${field}`,
  labelsSummary: (set: string, trios: number, lesson: number, noLesson: number, corrections: number, sha: string) =>
    `Labels ${set}: ${trios} trios · lesson ${lesson} · no_lesson ${noLesson} · corrections ${corrections} · sha256 ${sha}`,
  sheetTitle: (set: string, trios: number, selection: string) =>
    `# Label sheet — ${set}, ${trios} trios (${selection})`,
  sheetEntryHeader: (file: string, index: number, key: string) => `## ${file} · trio ${index} · ${key}`,
  sheetJev: (correction: number, preference: number, steering: number, confusion: number) =>
    `Jev: correction ${correction.toFixed(2)}, preference ${preference.toFixed(2)}, ` +
    `steering ${steering.toFixed(2)}, confusion ${confusion.toFixed(2)}`,
  sheetJevFallback: (reason: string) => `Jev: fallback (${reason})`,
  sheetJevNotScored: "Jev: not scored",
  sheetExtractor: (rules: number) => `Extractor: ${rules} rules`,
  sheetRuleLine: (rule: string) => `  - ${rule}`,
  sheetExtractorFailed: "Extractor: failed",
  sheetExtractorNotRun: "Extractor: not run",
  sheetLabel: (label: string, correction: boolean, source: string, note: string) =>
    `Label: ${label} · correction ${correction ? "yes" : "no"} · ${source}${note === "" ? "" : ` · ${note}`}`,
  sheetLabelNone: "Label: (none)",
  sheetAgentBefore: "Agent before (last 800 characters):",
  sheetUserReply: "User reply:",
  sheetAgentAfter: "Agent after (first 800 characters):",
  evaluateSweepDevOnly: "compass evaluate: the threshold sweep runs on dev only",
  evaluateBadPolicy: (file: string) => `compass evaluate: ${file} is not a valid policy`,
  evaluatePolicyReport: (
    name: string,
    set: string,
    rejected: number,
    trios: number,
    lessonKept: number,
    lessonTrios: number,
    percent: number,
    misses: number,
    bound: string,
    savedRequests: number,
    savedInput: number,
    savedOutput: number,
    gateInput: number,
    gateOutput: number,
  ) =>
    `Policy ${name} on ${set}: rejected ${rejected} of ${trios} · lesson kept ${lessonKept} of ${lessonTrios} ` +
    `(${percent}%) · correction misses ${misses} · miss bound ${bound} · ` +
    `extraction saved ${savedRequests} requests, ${savedInput} in / ${savedOutput} out tokens · ` +
    `gate cost ${gateInput} in / ${gateOutput} out tokens`,
  sweepTableHeader: "| rule | threshold | rejected | lesson kept | correction misses |",
  ruleAllFour: "all four",
  ruleWithoutSteering: "without steering",

  // ── Sheets ──
  resultsSheetTitle: (runType: string) => `compass ${runType} results — samples, not a measurement`,
  runningTableTitle: (runType: string) => `compass ${runType} — running table`,
  runningTableCovered: (examined: number, eligible: number) => `Covered: ${examined} of ${eligible} eligible trios`,
  runningTableNote:
    "Insert / merge / skip and portrait size reflect the builds completed when the trio was examined; " +
    "builds run in batches, so they trail the extraction counts.",
  runningTableTrioRef: (index: number, file: string) => `${index} (${file})`,
  runningTableRate: (productive: number, examined: number) =>
    `${productive}/${examined} (${examined === 0 ? 0 : Math.round((productive / examined) * 100)}%)`,
  runningTableImS: (inserted: number, merged: number, skipped: number) => `${inserted} / ${merged} / ${skipped}`,
  runningTablePortraitSize: (rules: number) => `${rules} rules`,
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
  sheetGate: (decision: string) => `Gate: ${decision}`,
  sheetGateScores: (correction: number, preference: number, steering: number, confusion: number) =>
    ` — correction ${correction.toFixed(2)}, preference ${preference.toFixed(2)}, ` +
    `steering ${steering.toFixed(2)}, confusion ${confusion.toFixed(2)}`,
  sheetGateFallback: (reason: string) => ` — fallback: ${reason}`,
  sheetGateSkipped: "Extractor: not run (gate: no_lesson, enforce mode)",
  sheetNoneProductive: "(none — non-productive trio)",
  sheetBuildHeader: (index: number) => `## Build ${index}`,
  sheetNoText: "(no text)",
  sheetPortraitDiff: (inserted: number, evicted: number) => `+${inserted} inserted · ${evicted} evicted`,
  sheetFinalDiffHeader: "## Final portrait diff",
  sheetAdded: (n: number) => `Added (${n}):`,
  sheetRemoved: (n: number) => `Removed (${n}):`,
} as const;
