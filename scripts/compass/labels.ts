// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Label sheets and label files over a frozen corpus: write a readable sheet of
 * the trios to label or check, and validate a labels file against the set it
 * belongs to. Offline — no network, no model, and no write outside the
 * requested output.
 *
 * Usage:
 *   node labels.js export --corpus <dir> --set dev|heldout --scores <scores.jsonl> \
 *     --extract <extract.jsonl> [--labels <labels.jsonl>] --select all|review \
 *     --seed <text> --output <file.md>
 *   node labels.js check --corpus <dir> --set dev|heldout --labels <labels.jsonl>
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { InteractionSequence } from "../../src/types.js";
import { freezeMatches, loadSelected } from "./corpus-run.js";
import { strings } from "./strings.js";
import type { CorpusSet, CorpusTrio, ExtractResultRow, LabelRow, ScoreResultRow } from "./types.js";
import { parseArgv, sha256File, sha256Text } from "./util.js";

const TOOL = "labels";
const COMMAND_EXPORT = "export";
const COMMAND_CHECK = "check";
const SELECTION_ALL = "all";
const SELECTION_REVIEW = "review";
const BLOCK_CHARS = 800;
const FENCE = "````";
const REVIEW_SAMPLE_DIVISOR = 10;
const GATE_QUESTION_IDS = ["correction", "preference", "steering", "confusion"] as const;
const LABEL_SOURCES = ["cc-draft", "cc-draft-user-checked", "user"] as const;

/** The requested set, or null when the value names neither dev nor heldout. */
export function parseCorpusSet(value: unknown): CorpusSet | null {
  if (value === "dev" || value === "heldout") return value;
  return null;
}

/** The flag's value as one string, or null when the flag is absent or repeated. */
export function flagValue(args: Record<string, string | string[]>, flag: string): string | null {
  const value = args[flag];
  return typeof value === "string" ? value : null;
}

/** The file's JSON objects, one per non-empty line, or null when it is missing or unparseable. */
export function readJsonlObjects(file: string): Record<string, unknown>[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const entries: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    entries.push(parsed as Record<string, unknown>);
  }
  return entries;
}

/** The first label field that is missing or wrongly typed, or null when every field is valid. */
export function invalidLabelField(entry: Record<string, unknown>): string | null {
  if (typeof entry.key !== "string" || entry.key === "") return "key";
  if (entry.label !== "lesson" && entry.label !== "no_lesson") return "label";
  if (typeof entry.correction !== "boolean") return "correction";
  if (!LABEL_SOURCES.includes(entry.source as (typeof LABEL_SOURCES)[number])) return "source";
  if (typeof entry.note !== "string") return "note";
  return null;
}

/** The labels by key (the first line of a key wins), or null when a line has an invalid field. */
export function toLabelMap(entries: Record<string, unknown>[]): Map<string, LabelRow> | null {
  const rows = new Map<string, LabelRow>();
  for (const entry of entries) {
    if (invalidLabelField(entry) !== null) return null;
    const key = entry.key as string;
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        label: entry.label as LabelRow["label"],
        correction: entry.correction as boolean,
        source: entry.source as LabelRow["source"],
        note: entry.note as string,
      });
    }
  }
  return rows;
}

function isTokenPair(value: object, first: string, second: string): boolean {
  const record = value as Record<string, unknown>;
  return typeof record[first] === "number" && typeof record[second] === "number";
}

/** The score rows by key (the first line of a key wins), or null when a line is not a row. */
export function toScoreMap(entries: Record<string, unknown>[]): Map<string, ScoreResultRow> | null {
  const rows = new Map<string, ScoreResultRow>();
  for (const entry of entries) {
    const key: unknown = entry.key;
    const verdict: unknown = entry.verdict;
    if (typeof key !== "string") return null;
    if (verdict !== "no_lesson" && verdict !== "maybe_lesson" && verdict !== "fallback" && verdict !== "not_run") {
      return null;
    }
    const answers: unknown = entry.answers ?? null;
    if (answers !== null) {
      if (typeof answers !== "object") return null;
      for (const value of Object.values(answers as Record<string, unknown>)) {
        if (typeof value !== "number" || !Number.isFinite(value)) return null;
      }
    }
    const reason: unknown = entry.reason ?? null;
    if (reason !== null && typeof reason !== "string") return null;
    const usage: unknown = entry.usage ?? null;
    if (usage !== null && (typeof usage !== "object" || !isTokenPair(usage, "inputTokens", "outputTokens")))
      return null;
    const attempts: unknown = entry.attempts ?? 0;
    if (typeof attempts !== "number") return null;
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        verdict: verdict as ScoreResultRow["verdict"],
        answers: answers as Record<string, number> | null,
        reason: reason as string | null,
        usage: usage as { inputTokens: number; outputTokens: number } | null,
        attempts,
      });
    }
  }
  return rows;
}

/** The extract rows by key (the first line of a key wins), or null when a line is not a row. */
export function toExtractMap(entries: Record<string, unknown>[]): Map<string, ExtractResultRow> | null {
  const rows = new Map<string, ExtractResultRow>();
  for (const entry of entries) {
    const key: unknown = entry.key;
    const outcome: unknown = entry.outcome;
    if (typeof key !== "string") return null;
    if (outcome !== "success" && outcome !== "failed" && outcome !== "not_run") return null;
    const notes: unknown = entry.notes;
    if (!Array.isArray(notes) || notes.some((note) => typeof note !== "string")) return null;
    const usage: unknown = entry.usage ?? null;
    if (usage !== null && (typeof usage !== "object" || !isTokenPair(usage, "input", "output"))) return null;
    const attempts: unknown = entry.attempts ?? 0;
    if (typeof attempts !== "number") return null;
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        outcome: outcome as ExtractResultRow["outcome"],
        notes: notes as string[],
        attempts,
        usage: usage as { input: number; output: number } | null,
      });
    }
  }
  return rows;
}

/**
 * True when every key belongs to the set and, for a file that must cover the
 * set, every set key appears at least once.
 */
export function agreesWithSet(setKeys: Set<string>, keys: Iterable<string>, requireCoverage: boolean): boolean {
  const seen = new Set<string>();
  for (const key of keys) {
    if (!setKeys.has(key)) return false;
    seen.add(key);
  }
  return !requireCoverage || seen.size === setKeys.size;
}

/** The set's trios with the frozen texts beside them, or null when the freeze or a key check fails. */
export function loadCorpusSet(
  corpusDir: string,
  set: CorpusSet,
): { selected: CorpusTrio[]; texts: InteractionSequence[] } | null {
  if (!freezeMatches(corpusDir)) return null;
  return loadSelected(corpusDir, set);
}

/** One sheet entry: the corpus trio, its text, and whatever the input files say about it. */
interface SheetEntry {
  trio: CorpusTrio;
  text: InteractionSequence;
  score: ScoreResultRow | undefined;
  extract: ExtractResultRow | undefined;
  label: LabelRow | undefined;
}

function jevLine(score: ScoreResultRow | undefined): string {
  const answers = score?.answers ?? null;
  const [correctionId, preferenceId, steeringId, confusionId] = GATE_QUESTION_IDS;
  const correction = answers?.[correctionId];
  const preference = answers?.[preferenceId];
  const steering = answers?.[steeringId];
  const confusion = answers?.[confusionId];
  if (correction !== undefined && preference !== undefined && steering !== undefined && confusion !== undefined) {
    return strings.sheetJev(correction, preference, steering, confusion);
  }
  if (score !== undefined && score.verdict === "fallback") return strings.sheetJevFallback(score.reason ?? "");
  return strings.sheetJevNotScored;
}

function extractorLines(extract: ExtractResultRow | undefined): string[] {
  if (extract === undefined || extract.outcome === "not_run") return [strings.sheetExtractorNotRun];
  if (extract.outcome === "failed") return [strings.sheetExtractorFailed];
  return [strings.sheetExtractor(extract.notes.length), ...extract.notes.map((note) => strings.sheetRuleLine(note))];
}

function labelLine(label: LabelRow | undefined): string {
  if (label === undefined) return strings.sheetLabelNone;
  return strings.sheetLabel(label.label, label.correction, label.source, label.note);
}

function tail(text: string, chars: number): string {
  return text.length <= chars ? text : text.slice(text.length - chars);
}

function textBlocks(text: InteractionSequence): string[] {
  return [
    strings.sheetAgentBefore,
    FENCE,
    tail(text.agentBefore, BLOCK_CHARS),
    FENCE,
    "",
    strings.sheetUserReply,
    FENCE,
    text.userFeedback,
    FENCE,
    "",
    strings.sheetAgentAfter,
    FENCE,
    text.agentAfter.slice(0, BLOCK_CHARS),
    FENCE,
  ];
}

function renderSheet(set: CorpusSet, selection: string, entries: SheetEntry[]): string {
  const lines: string[] = [strings.sheetTitle(set, entries.length, selection), ""];
  for (const entry of entries) {
    lines.push(strings.sheetEntryHeader(entry.trio.file, entry.trio.index, entry.trio.key));
    lines.push(jevLine(entry.score));
    lines.push(...extractorLines(entry.extract));
    lines.push(labelLine(entry.label));
    lines.push("");
    lines.push(...textBlocks(entry.text));
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The review selection: every no_lesson label, every disagreement (a lesson
 * labeled with no extractor rules, or a no_lesson with rules), and a seeded
 * 10% sample of the rest, taken in hash order.
 */
function selectReview(
  selected: CorpusTrio[],
  labels: Map<string, LabelRow>,
  extracts: Map<string, ExtractResultRow>,
  seed: string,
): Set<string> {
  const chosen = new Set<string>();
  for (const row of selected) {
    const label = labels.get(row.key);
    const extract = extracts.get(row.key);
    const rules = extract !== undefined && extract.outcome === "success" ? extract.notes.length : null;
    if (label === undefined) continue;
    if (label.label === "no_lesson" || rules === 0) chosen.add(row.key);
  }
  const rest = selected.filter((row) => !chosen.has(row.key));
  const sorted = [...rest].sort((a, b) => {
    const hashA = sha256Text(`${seed}\n${a.key}`);
    const hashB = sha256Text(`${seed}\n${b.key}`);
    if (hashA !== hashB) return hashA < hashB ? -1 : 1;
    return a.key < b.key ? -1 : 1;
  });
  const sampleSize = Math.ceil(sorted.length / REVIEW_SAMPLE_DIVISOR);
  for (const row of sorted.slice(0, sampleSize)) chosen.add(row.key);
  return chosen;
}

function mismatch(tool: string, file: string, set: string, corpus: string): void {
  process.stderr.write(`${strings.labelsInputMismatch(tool, file, set, corpus)}\n`);
}

async function runExport(args: Record<string, string | string[]>): Promise<number> {
  const flags = ["corpus", "set", "scores", "extract", "select", "seed", "output"];
  for (const flag of flags) {
    if (flagValue(args, flag) === null) {
      process.stderr.write(`${strings.labelsMissingFlag(TOOL, `--${flag}`)}\n`);
      return 2;
    }
  }
  const corpusArg = flagValue(args, "corpus") as string;
  const scoresArg = flagValue(args, "scores") as string;
  const extractArg = flagValue(args, "extract") as string;
  const labelsArg = flagValue(args, "labels");
  const seed = flagValue(args, "seed") as string;
  const outputArg = flagValue(args, "output") as string;
  const set = parseCorpusSet(flagValue(args, "set"));
  if (set === null) {
    process.stderr.write(`${strings.labelsBadSet(TOOL)}\n`);
    return 2;
  }
  const selection = flagValue(args, "select");
  if (selection !== SELECTION_ALL && selection !== SELECTION_REVIEW) {
    process.stderr.write(`${strings.labelsBadSelection}\n`);
    return 2;
  }
  if (selection === SELECTION_REVIEW && labelsArg === null) {
    process.stderr.write(`${strings.labelsReviewNeedsLabels}\n`);
    return 2;
  }

  const corpusDir = path.resolve(corpusArg);
  const loaded = loadCorpusSet(corpusDir, set);
  if (loaded === null) {
    process.stderr.write(`${strings.scoreCorpusChanged(corpusArg)}\n`);
    return 2;
  }
  const { selected, texts } = loaded;
  const setKeys = new Set(selected.map((row) => row.key));

  const scoreEntries = readJsonlObjects(scoresArg);
  const extractEntries = readJsonlObjects(extractArg);
  const labelEntries = labelsArg === null ? [] : readJsonlObjects(labelsArg);
  const scores = scoreEntries === null ? null : toScoreMap(scoreEntries);
  const extracts = extractEntries === null ? null : toExtractMap(extractEntries);
  const labels = labelEntries === null ? null : toLabelMap(labelEntries);
  const problems: string[] = [];
  if (scores === null || !agreesWithSet(setKeys, scores.keys(), true)) problems.push(scoresArg);
  if (extracts === null || !agreesWithSet(setKeys, extracts.keys(), true)) problems.push(extractArg);
  if (labelsArg !== null && (labels === null || !agreesWithSet(setKeys, labels.keys(), false))) {
    problems.push(labelsArg);
  }
  if (problems.length > 0) {
    for (const file of problems) mismatch(TOOL, file, set, corpusArg);
    return 2;
  }
  const scoresBy = scores ?? new Map<string, ScoreResultRow>();
  const extractsBy = extracts ?? new Map<string, ExtractResultRow>();
  const labelsBy = labels ?? new Map<string, LabelRow>();

  const chosen = selection === SELECTION_ALL ? new Set(setKeys) : selectReview(selected, labelsBy, extractsBy, seed);
  const entries: SheetEntry[] = [];
  for (const [position, row] of selected.entries()) {
    if (!chosen.has(row.key)) continue;
    entries.push({
      trio: row,
      text: texts[position],
      score: scoresBy.get(row.key),
      extract: extractsBy.get(row.key),
      label: labelsBy.get(row.key),
    });
  }

  const output = path.resolve(outputArg);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, renderSheet(set, selection, entries), "utf-8");
  return 0;
}

async function runCheck(args: Record<string, string | string[]>): Promise<number> {
  const flags = ["corpus", "set", "labels"];
  for (const flag of flags) {
    if (flagValue(args, flag) === null) {
      process.stderr.write(`${strings.labelsMissingFlag(TOOL, `--${flag}`)}\n`);
      return 2;
    }
  }
  const corpusArg = flagValue(args, "corpus") as string;
  const labelsArg = flagValue(args, "labels") as string;
  const set = parseCorpusSet(flagValue(args, "set"));
  if (set === null) {
    process.stderr.write(`${strings.labelsBadSet(TOOL)}\n`);
    return 2;
  }
  const corpusDir = path.resolve(corpusArg);
  const loaded = loadCorpusSet(corpusDir, set);
  if (loaded === null) {
    process.stderr.write(`${strings.scoreCorpusChanged(corpusArg)}\n`);
    return 2;
  }
  const { selected } = loaded;
  const setKeys = new Set(selected.map((row) => row.key));

  const entries = readJsonlObjects(labelsArg);
  if (entries === null) {
    mismatch(TOOL, labelsArg, set, corpusArg);
    return 2;
  }

  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const field = invalidLabelField(entry);
    const rawKey: unknown = entry.key;
    const key = typeof rawKey === "string" && rawKey !== "" ? rawKey : null;
    if (field !== null) {
      problems.push(strings.labelsProblem(key ?? "", strings.labelsProblemInvalidField(field)));
    }
    if (key === null) continue;
    if (!setKeys.has(key)) {
      problems.push(strings.labelsProblem(key, strings.labelsProblemNotInSet(set)));
    }
    if (seen.has(key)) {
      problems.push(strings.labelsProblem(key, strings.labelsProblemDuplicate));
    } else {
      seen.add(key);
    }
  }
  for (const row of selected) {
    if (!seen.has(row.key)) problems.push(strings.labelsProblem(row.key, strings.labelsProblemMissing));
  }
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    return 2;
  }

  const lesson = entries.filter((entry) => entry.label === "lesson").length;
  const noLesson = entries.filter((entry) => entry.label === "no_lesson").length;
  const corrections = entries.filter((entry) => entry.correction === true).length;
  process.stdout.write(
    `${strings.labelsSummary(set, entries.length, lesson, noLesson, corrections, sha256File(labelsArg))}\n`,
  );
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgv(argv);
  const positional = args._;
  const command = Array.isArray(positional) ? positional[0] : undefined;
  if (command !== COMMAND_EXPORT && command !== COMMAND_CHECK) {
    process.stderr.write(`${strings.labelsMissingFlag(TOOL, `${COMMAND_EXPORT} or ${COMMAND_CHECK}`)}\n`);
    return 2;
  }
  return command === COMMAND_EXPORT ? runExport(args) : runCheck(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exit(1);
    },
  );
}
