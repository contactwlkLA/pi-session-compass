// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Gate-policy evaluation over a frozen corpus: score a candidate policy against
 * the labels, and sweep rule and threshold combinations on the development set.
 * Offline — no network, no model, and no write outside the output directory.
 *
 * Usage:
 *   node evaluate.js policy --corpus <dir> --set dev|heldout --labels <labels.jsonl> \
 *     --scores <scores.jsonl> --extract <extract.jsonl> --policy <policy.json> [--output <dir>]
 *   node evaluate.js sweep --corpus <dir> --set dev --labels <labels.jsonl> \
 *     --scores <scores.jsonl> --extract <extract.jsonl> [--output <dir>]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { JEV_POLICY } from "../../src/jev.js";
import {
  agreesWithSet,
  flagValue,
  loadCorpusSet,
  parseCorpusSet,
  readJsonlObjects,
  toExtractMap,
  toLabelMap,
  toScoreMap,
} from "./labels.js";
import { strings } from "./strings.js";
import type { CorpusTrio, ExtractResultRow, LabelRow, PolicyFile, ScoreResultRow } from "./types.js";
import { findWorkspaceRoot, parseArgv } from "./util.js";

const TOOL = "evaluate";
const COMMAND_POLICY = "policy";
const COMMAND_SWEEP = "sweep";
const DEV_SET = "dev";
const SWEEP_STEPS = 10;
const SWEEP_STEP_HUNDREDTHS = 5;
const HUNDREDTHS = 100;
const PERCENT = 100;
const MISS_BOUND_NUMERATOR = 3;
const STEERING_ID = "steering";
const GATE_QUESTION_IDS = Object.keys(JEV_POLICY.questions);
const SWEEP_THRESHOLD_ROW_SEPARATOR = "|---|---:|---:|---:|---:|";

/** The policy file's shape, or null when any part of it is invalid. */
function parsePolicy(value: unknown): PolicyFile | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const name: unknown = record.name;
  const questions: unknown = record.questions;
  const thresholds: unknown = record.thresholds;
  if (typeof name !== "string" || name === "") return null;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const ids: string[] = [];
  for (const id of questions) {
    if (typeof id !== "string" || !GATE_QUESTION_IDS.includes(id) || ids.includes(id)) return null;
    ids.push(id);
  }
  if (typeof thresholds !== "object" || thresholds === null) return null;
  const table = thresholds as Record<string, unknown>;
  if (Object.keys(table).length !== ids.length) return null;
  const clean: Record<string, number> = {};
  for (const id of ids) {
    const threshold: unknown = table[id];
    if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) return null;
    clean[id] = threshold;
  }
  return { name, questions: ids, thresholds: clean };
}

function isScored(row: ScoreResultRow): boolean {
  return row.verdict === "no_lesson" || row.verdict === "maybe_lesson";
}

/**
 * A scored trio is rejected when every listed question's answer is at or below
 * its threshold; a fallback or unscored trio is never rejected.
 */
function isRejected(score: ScoreResultRow | undefined, ids: string[], thresholds: Record<string, number>): boolean {
  if (score === undefined || !isScored(score)) return false;
  const answers = score.answers;
  if (answers === null) return false;
  for (const id of ids) {
    const answer = answers[id];
    const threshold = thresholds[id];
    if (answer === undefined || threshold === undefined) return false;
    if (answer > threshold) return false;
  }
  return true;
}

/** The counts one policy or one sweep cell reports over the set. */
interface Counts {
  trios: number;
  scored: number;
  rejected: number;
  rejectedKeys: string[];
  lessonTrios: number;
  lessonKept: number;
  missedLessonKeys: string[];
  correctionTrios: number;
  correctionMisses: number;
  missedCorrectionKeys: string[];
  savedRequests: number;
  savedInput: number;
  savedOutput: number;
  gateInput: number;
  gateOutput: number;
}

function countOver(
  keys: string[],
  labels: Map<string, LabelRow>,
  scores: Map<string, ScoreResultRow>,
  extracts: Map<string, ExtractResultRow>,
  ids: string[],
  thresholds: Record<string, number>,
): Counts {
  const counts: Counts = {
    trios: keys.length,
    scored: 0,
    rejected: 0,
    rejectedKeys: [],
    lessonTrios: 0,
    lessonKept: 0,
    missedLessonKeys: [],
    correctionTrios: 0,
    correctionMisses: 0,
    missedCorrectionKeys: [],
    savedRequests: 0,
    savedInput: 0,
    savedOutput: 0,
    gateInput: 0,
    gateOutput: 0,
  };
  for (const key of keys) {
    const score = scores.get(key);
    const label = labels.get(key);
    const extract = extracts.get(key);
    const isLesson = label?.label === "lesson";
    const isCorrection = label?.correction === true;
    if (isLesson) counts.lessonTrios++;
    if (isCorrection) counts.correctionTrios++;
    if (score !== undefined && isScored(score)) {
      counts.scored++;
      if (score.usage !== null) {
        counts.gateInput += score.usage.inputTokens;
        counts.gateOutput += score.usage.outputTokens;
      }
    }
    if (!isRejected(score, ids, thresholds)) {
      if (isLesson) counts.lessonKept++;
      continue;
    }
    counts.rejected++;
    counts.rejectedKeys.push(key);
    if (isLesson) counts.missedLessonKeys.push(key);
    if (isCorrection) {
      counts.correctionMisses++;
      counts.missedCorrectionKeys.push(key);
    }
    counts.savedRequests += extract?.attempts ?? 0;
    counts.savedInput += extract?.usage?.input ?? 0;
    counts.savedOutput += extract?.usage?.output ?? 0;
  }
  return counts;
}

function lessonPercent(counts: Counts): number {
  return counts.lessonTrios === 0 ? 0 : Math.round((counts.lessonKept / counts.lessonTrios) * PERCENT);
}

function missBound(counts: Counts): string {
  return counts.correctionMisses === 0
    ? `${MISS_BOUND_NUMERATOR} / ${counts.correctionTrios}`
    : `${counts.correctionMisses} / ${counts.correctionTrios}`;
}

/** The set's trios, labels, scores, and extract rows, or the files that disagree with the set. */
interface Inputs {
  keys: string[];
  labels: Map<string, LabelRow>;
  scores: Map<string, ScoreResultRow>;
  extracts: Map<string, ExtractResultRow>;
}

function loadInputs(
  selected: CorpusTrio[],
  labelsArg: string,
  scoresArg: string,
  extractArg: string,
): Inputs | string[] {
  const setKeys = new Set(selected.map((row) => row.key));
  const scoreEntries = readJsonlObjects(scoresArg);
  const extractEntries = readJsonlObjects(extractArg);
  const labelEntries = readJsonlObjects(labelsArg);
  const scores = scoreEntries === null ? null : toScoreMap(scoreEntries);
  const extracts = extractEntries === null ? null : toExtractMap(extractEntries);
  const labels = labelEntries === null ? null : toLabelMap(labelEntries);
  const problems: string[] = [];
  if (scores === null || !agreesWithSet(setKeys, scores.keys(), true)) problems.push(scoresArg);
  if (extracts === null || !agreesWithSet(setKeys, extracts.keys(), true)) problems.push(extractArg);
  if (labels === null || !agreesWithSet(setKeys, labels.keys(), false)) problems.push(labelsArg);
  if (problems.length > 0) return problems;
  return {
    keys: selected.map((row) => row.key),
    labels: labels ?? new Map<string, LabelRow>(),
    scores: scores ?? new Map<string, ScoreResultRow>(),
    extracts: extracts ?? new Map<string, ExtractResultRow>(),
  };
}

function defaultOutputDir(command: string, set: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
  return path.join(findWorkspaceRoot(), "outputs", "s5", `${command}-${set}-${stamp}`);
}

function requireFlag(args: Record<string, string | string[]>, flags: string[]): string | null {
  for (const flag of flags) {
    if (flagValue(args, flag) === null) {
      process.stderr.write(`${strings.labelsMissingFlag(TOOL, `--${flag}`)}\n`);
      return flag;
    }
  }
  return null;
}

function reportMismatch(problems: string[], set: string, corpusArg: string): void {
  for (const file of problems) {
    process.stderr.write(`${strings.labelsInputMismatch(TOOL, file, set, corpusArg)}\n`);
  }
}

async function runPolicy(args: Record<string, string | string[]>): Promise<number> {
  if (requireFlag(args, ["corpus", "set", "labels", "scores", "extract", "policy"]) !== null) return 2;
  const corpusArg = flagValue(args, "corpus") as string;
  const labelsArg = flagValue(args, "labels") as string;
  const scoresArg = flagValue(args, "scores") as string;
  const extractArg = flagValue(args, "extract") as string;
  const policyArg = flagValue(args, "policy") as string;
  const outputArg = flagValue(args, "output");
  const set = parseCorpusSet(flagValue(args, "set"));
  if (set === null) {
    process.stderr.write(`${strings.labelsBadSet(TOOL)}\n`);
    return 2;
  }

  let policyRaw: unknown;
  try {
    policyRaw = JSON.parse(fs.readFileSync(policyArg, "utf-8"));
  } catch {
    policyRaw = null;
  }
  const policy = parsePolicy(policyRaw);
  if (policy === null) {
    process.stderr.write(`${strings.evaluateBadPolicy(policyArg)}\n`);
    return 2;
  }

  const loaded = loadCorpusSet(path.resolve(corpusArg), set);
  if (loaded === null) {
    process.stderr.write(`${strings.scoreCorpusChanged(corpusArg)}\n`);
    return 2;
  }
  const inputs = loadInputs(loaded.selected, labelsArg, scoresArg, extractArg);
  if (Array.isArray(inputs)) {
    reportMismatch(inputs, set, corpusArg);
    return 2;
  }

  const counts = countOver(
    inputs.keys,
    inputs.labels,
    inputs.scores,
    inputs.extracts,
    policy.questions,
    policy.thresholds,
  );
  const bound = missBound(counts);
  process.stdout.write(
    `${strings.evaluatePolicyReport(
      policy.name,
      set,
      counts.rejected,
      counts.trios,
      counts.lessonKept,
      counts.lessonTrios,
      lessonPercent(counts),
      counts.correctionMisses,
      bound,
      counts.savedRequests,
      counts.savedInput,
      counts.savedOutput,
      counts.gateInput,
      counts.gateOutput,
    )}\n`,
  );

  const outputDir = outputArg === null ? defaultOutputDir(COMMAND_POLICY, set) : path.resolve(outputArg);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "evaluate.json"),
    `${JSON.stringify(
      {
        policy: policy.name,
        questions: policy.questions,
        thresholds: policy.thresholds,
        corpus: corpusArg,
        set,
        trios: counts.trios,
        scored: counts.scored,
        rejected: counts.rejected,
        rejectedKeys: counts.rejectedKeys,
        lessonTrios: counts.lessonTrios,
        lessonKept: counts.lessonKept,
        missedLessonKeys: counts.missedLessonKeys,
        correctionTrios: counts.correctionTrios,
        correctionMisses: counts.correctionMisses,
        missedCorrectionKeys: counts.missedCorrectionKeys,
        missBound: bound,
        extractionSaved: {
          requests: counts.savedRequests,
          inputTokens: counts.savedInput,
          outputTokens: counts.savedOutput,
        },
        gateCost: { inputTokens: counts.gateInput, outputTokens: counts.gateOutput },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return 0;
}

async function runSweep(args: Record<string, string | string[]>): Promise<number> {
  if (requireFlag(args, ["corpus", "set", "labels", "scores", "extract"]) !== null) return 2;
  const corpusArg = flagValue(args, "corpus") as string;
  const labelsArg = flagValue(args, "labels") as string;
  const scoresArg = flagValue(args, "scores") as string;
  const extractArg = flagValue(args, "extract") as string;
  const outputArg = flagValue(args, "output");
  const set = flagValue(args, "set");
  if (set !== DEV_SET) {
    process.stderr.write(`${strings.evaluateSweepDevOnly}\n`);
    return 2;
  }

  const loaded = loadCorpusSet(path.resolve(corpusArg), DEV_SET);
  if (loaded === null) {
    process.stderr.write(`${strings.scoreCorpusChanged(corpusArg)}\n`);
    return 2;
  }

  const inputs = loadInputs(loaded.selected, labelsArg, scoresArg, extractArg);
  if (Array.isArray(inputs)) {
    reportMismatch(inputs, DEV_SET, corpusArg);
    return 2;
  }

  const rules = [
    { name: strings.ruleAllFour, ids: GATE_QUESTION_IDS },
    { name: strings.ruleWithoutSteering, ids: GATE_QUESTION_IDS.filter((id) => id !== STEERING_ID) },
  ];
  const thresholds: number[] = [];
  for (let step = 1; step <= SWEEP_STEPS; step++) thresholds.push((step * SWEEP_STEP_HUNDREDTHS) / HUNDREDTHS);

  const rows: {
    rule: string;
    threshold: number;
    rejected: number;
    lessonKept: number;
    lessonTotal: number;
    correctionMisses: number;
  }[] = [];
  const lines = [strings.sweepTableHeader, SWEEP_THRESHOLD_ROW_SEPARATOR];
  for (const rule of rules) {
    for (const threshold of thresholds) {
      const table: Record<string, number> = {};
      for (const id of rule.ids) table[id] = threshold;
      const counts = countOver(inputs.keys, inputs.labels, inputs.scores, inputs.extracts, rule.ids, table);
      rows.push({
        rule: rule.name,
        threshold,
        rejected: counts.rejected,
        lessonKept: counts.lessonKept,
        lessonTotal: counts.lessonTrios,
        correctionMisses: counts.correctionMisses,
      });
      lines.push(
        `| ${rule.name} | ${threshold.toFixed(2)} | ${counts.rejected} | ` +
          `${counts.lessonKept} of ${counts.lessonTrios} (${lessonPercent(counts)}%) | ${counts.correctionMisses} |`,
      );
    }
  }

  const outputDir = outputArg === null ? defaultOutputDir(COMMAND_SWEEP, DEV_SET) : path.resolve(outputArg);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "sweep.md"), `${lines.join("\n")}\n`, "utf-8");
  fs.writeFileSync(
    path.join(outputDir, "sweep.json"),
    `${JSON.stringify(
      {
        corpus: corpusArg,
        set: DEV_SET,
        labels: labelsArg,
        scores: scoresArg,
        extract: extractArg,
        thresholds,
        rows,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgv(argv);
  const positional = args._;
  const command = Array.isArray(positional) ? positional[0] : undefined;
  if (command !== COMMAND_POLICY && command !== COMMAND_SWEEP) {
    process.stderr.write(`${strings.labelsMissingFlag(TOOL, `${COMMAND_POLICY} or ${COMMAND_SWEEP}`)}\n`);
    return 2;
  }
  return command === COMMAND_POLICY ? runPolicy(args) : runSweep(args);
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
