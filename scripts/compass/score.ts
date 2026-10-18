// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Corpus scoring: run the Jev classifier over one set of a frozen corpus,
 * several trios at a time, counted against the run limits, and append every
 * durable result to a cache so a rerun never pays for the same trio twice.
 * No extraction, no building, no portrait — only Jev requests, and none before
 * the corpus, the confirmation, and the credential have been checked.
 * With --questions, a question set read from a file replaces the gate's
 * questions on the wire: the rows carry no gate verdict, and codes.md tallies
 * the answers per folder and session instead of the gate's results table.
 *
 * Usage:
 *   node score.js --corpus <dir> --set dev|heldout|all --run-type <t> \
 *     --max-model-requests N --max-run-ms N --limits-source <s> \
 *     [--concurrency N] [--output <dir>] [--questions <file>] [--confirmed]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildGateState,
  callJev,
  JEV_POLICY,
  JEV_POLICY_HASH,
  type JevPolicy,
  type JevQuestion,
  type JevResult,
  routeGate,
} from "../../src/jev.js";
import type { InteractionSequence } from "../../src/types.js";
import {
  appendCacheLine,
  freezeMatches,
  loadCache,
  loadSelected,
  parseConcurrency,
  parseSet,
  runPool,
} from "./corpus-run.js";
import { RequestCounter } from "./counter.js";
import { parseLimits } from "./limits.js";
import { renderTable } from "./probe.js";
import { strings } from "./strings.js";
import type { CorpusSet, CorpusTrio, Limits } from "./types.js";
import { findWorkspaceRoot, parseArgv, sha256File, sha256Text } from "./util.js";

type Verdict = "no_lesson" | "maybe_lesson" | "scored" | "fallback" | "not_run";

/** The gate's four verdicts — the only ones the results table's columns understand. */
type TableVerdict = "no_lesson" | "maybe_lesson" | "fallback" | "not_run";

/** How the run ended, in the words the final line reports. */
type StopLabel = "completed" | "request limit" | "time limit" | "auth error" | "three failed requests in a row";

/** One result row: a corpus trio as it was scored, cached, or left unstarted. */
interface ScoreRow {
  key: string;
  set: CorpusSet;
  sessionId: string;
  file: string;
  index: number;
  verdict: Verdict;
  answers: Record<string, number> | null;
  reason: string | null;
  model: string | null;
  attempts: number;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  cached: boolean;
}

/** One line of the cache: only durable results (scored, and the oversized-state refusal). */
interface CacheLine {
  key: string;
  verdict: Verdict;
  answers: Record<string, number> | null;
  reason: string | null;
  model: string | null;
  attempts: number;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
}

/** Failed requests in a row after which scoring stops (the same limit the gate uses). */
const FAILURE_LIMIT = 3;
const SNIPPET_CHARS = 90;
/** An answer at or above this counts as a yes in the codes tally. */
const YES_THRESHOLD = 0.5;
/** The most example replies listed under one code. */
const TOP_EXAMPLES = 10;
const QUESTION_ID_RE = /^[a-z_]{1,32}$/;
const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 8;
/** A gate cache line carries the gate's verdicts; a question-set cache line carries its own. */
const GATE_CACHE_VERDICTS: Verdict[] = ["no_lesson", "maybe_lesson", "fallback", "not_run"];
const QUESTION_CACHE_VERDICTS: Verdict[] = ["scored", "fallback"];

function isVerdictIn(value: unknown, allowed: Verdict[]): value is Verdict {
  return typeof value === "string" && (allowed as string[]).includes(value);
}

/** The table's reply cell: whitespace flattened, at most 90 characters. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1)}…` : flat;
}

/** A question set read from a file: its name, its questions in file order, and the file it came from. */
interface QuestionSet {
  name: string;
  questions: Record<string, JevQuestion>;
  file: string;
  hash: string;
}

/** The first 12 hex digits of sha256 over the model, the set's name, and its questions as parsed. */
function questionSetHash(name: string, questions: Record<string, unknown>): string {
  return sha256Text(JSON.stringify({ model: JEV_POLICY.model, name, questions })).slice(0, 12);
}

/** True for one question exactly as the file format describes it: no missing and no unknown fields. */
function isQuestionShape(value: unknown): value is JevQuestion {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || record.type !== "noul") return false;
  if (typeof record.instructions !== "string") return false;
  const criteria = record.criteria;
  if (typeof criteria !== "object" || criteria === null) return false;
  const criteriaRecord = criteria as Record<string, unknown>;
  if (Object.keys(criteriaRecord).length !== 2) return false;
  return typeof criteriaRecord.true === "string" && typeof criteriaRecord.false === "string";
}

/** The question set in `file`, or null when the file is missing, unreadable, or not the format. */
function parseQuestionSet(file: string): QuestionSet | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || typeof record.name !== "string" || record.name === "") return null;
  const questions = record.questions;
  if (typeof questions !== "object" || questions === null) return null;
  const questionRecords = questions as Record<string, unknown>;
  const ids = Object.keys(questionRecords);
  if (ids.length < MIN_QUESTIONS || ids.length > MAX_QUESTIONS) return null;
  for (const id of ids) {
    if (!QUESTION_ID_RE.test(id) || !isQuestionShape(questionRecords[id])) return null;
  }
  return {
    name: record.name,
    questions: questionRecords as Record<string, JevQuestion>,
    file,
    hash: questionSetHash(record.name, questionRecords),
  };
}

/** True for a line this cache may serve: a durable result in this mode's verdicts only. */
function isCacheLine(value: CacheLine, allowedVerdicts: Verdict[]): boolean {
  if (typeof value.key !== "string" || !isVerdictIn(value.verdict, allowedVerdicts)) return false;
  if (typeof value.attempts !== "number" || typeof value.latencyMs !== "number") return false;
  if (value.reason !== null && typeof value.reason !== "string") return false;
  if (value.model !== null && typeof value.model !== "string") return false;
  if (value.answers !== null && typeof value.answers !== "object") return false;
  if (value.usage !== null && typeof value.usage !== "object") return false;
  return true;
}

function isGateCacheLine(value: CacheLine): boolean {
  return isCacheLine(value, GATE_CACHE_VERDICTS);
}

function isQuestionCacheLine(value: CacheLine): boolean {
  return isCacheLine(value, QUESTION_CACHE_VERDICTS);
}

function notRunRow(trio: CorpusTrio): ScoreRow {
  return {
    key: trio.key,
    set: trio.set,
    sessionId: trio.sessionId,
    file: trio.file,
    index: trio.index,
    verdict: "not_run",
    answers: null,
    reason: null,
    model: null,
    attempts: 0,
    latencyMs: 0,
    usage: null,
    cached: false,
  };
}

/**
 * The results sheet: probe's table with one more first column (the session
 * file name) in front of every row.
 */
function renderScoreTable(rows: ScoreRow[], texts: InteractionSequence[]): string {
  const lines = renderTable(
    rows.map((row, position) => {
      const trio = texts[position];
      return {
        trio: row.index,
        userFeedback: trio === undefined ? "" : snippet(trio.userFeedback),
        // Only a gate run writes this table, so its rows carry one of the gate's four verdicts.
        verdict: row.verdict as TableVerdict,
        answers: row.answers,
        reason: row.reason,
        model: row.model,
        attempts: row.attempts,
        latencyMs: row.latencyMs,
        usage: row.usage,
      };
    }),
  ).split("\n");
  const withSession = lines.map((line, position) => {
    if (position === 0) return line.replace(/^\| /, "| session | ");
    if (position === 1) return line.replace("|", "|---|");
    if (line === "") return line;
    const name = path.basename(rows[position - 2].file).replace(/\|/g, "\\|");
    return line.replace(/^\| /, `| ${name} | `);
  });
  return `${withSession.join("\n")}\n`;
}

/** A corpus file's source folder, with the freeze's numeric prefix dropped. */
function folderOf(file: string): string {
  const parts = file.split("/");
  const folder = parts.length >= 2 ? parts[1] : path.basename(file);
  return folder.replace(/^\d+-/, "");
}

/**
 * The reply-codes report: the set's title, one row per session with each code's
 * yes count, a total row per folder and one for all rows, then each code's top
 * replies — highest answers first, ties in corpus order, capped at ten.
 */
function renderCodes(rows: ScoreRow[], texts: InteractionSequence[], set: QuestionSet, runSet: string): string {
  const ids = Object.keys(set.questions);
  const sessions: string[] = [];
  const folders: string[] = [];
  for (const row of rows) {
    if (!sessions.includes(row.file)) sessions.push(row.file);
    const folder = folderOf(row.file);
    if (!folders.includes(folder)) folders.push(folder);
  }
  const scoredTrios = (subset: ScoreRow[]): number => subset.filter((row) => row.verdict === "scored").length;
  const yesCounts = (subset: ScoreRow[]): number[] =>
    ids.map(
      (id) => subset.filter((row) => row.verdict === "scored" && (row.answers?.[id] ?? 0) >= YES_THRESHOLD).length,
    );
  const tableRow = (first: string, second: string, subset: ScoreRow[]): string =>
    `| ${first.replace(/\|/g, "\\|")} | ${second.replace(/\|/g, "\\|")} | ${scoredTrios(subset)} | ${yesCounts(subset).join(" | ")} |`;

  const lines: string[] = [strings.codesTitle(set.name, runSet, scoredTrios(rows)), ""];
  lines.push(strings.codesTableHeader(ids));
  lines.push(`|${"---|".repeat(3 + ids.length)}`);
  for (const file of sessions) {
    lines.push(
      tableRow(
        folderOf(file),
        path.basename(file),
        rows.filter((row) => row.file === file),
      ),
    );
  }
  for (const folder of folders) {
    lines.push(
      tableRow(
        folder,
        strings.codesTotalCell,
        rows.filter((row) => folderOf(row.file) === folder),
      ),
    );
  }
  lines.push(tableRow(strings.codesTotalCell, strings.codesTotalCell, rows));

  for (const id of ids) {
    lines.push("", strings.codesExamplesHeading(id));
    const examples: Array<{ answer: number; row: ScoreRow; reply: string }> = [];
    for (const [position, row] of rows.entries()) {
      if (row.verdict !== "scored" || row.answers === null) continue;
      const answer = row.answers[id];
      const text = texts[position];
      if (answer === undefined || text === undefined || answer < YES_THRESHOLD) continue;
      examples.push({ answer, row, reply: snippet(text.userFeedback) });
    }
    examples.sort((a, b) => b.answer - a.answer);
    for (const example of examples.slice(0, TOP_EXAMPLES)) {
      lines.push(
        strings.codesExampleLine(
          example.answer.toFixed(2),
          path.basename(example.row.file),
          example.row.index,
          example.reply,
        ),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function exitCodeFor(stop: StopLabel): number {
  if (stop === "completed") return 0;
  if (stop === "request limit" || stop === "time limit") return 3;
  return 4;
}

function refuseCorpus(dir: string): void {
  process.stderr.write(`${strings.scoreCorpusChanged(dir)}\n`);
}

/** One item to score: a corpus trio or a report exchange, with the key its cache line carries. */
interface ScoreTarget {
  key: string;
  texts: InteractionSequence;
}

/** One item's outcome, before it is shaped into a row. */
interface ScoredOutcome {
  verdict: Verdict;
  answers: Record<string, number> | null;
  reason: string | null;
  model: string | null;
  attempts: number;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  cached: boolean;
}

interface ScoringRun {
  targets: ScoreTarget[];
  cache: Map<string, CacheLine>;
  cachePath: string;
  policy: JevPolicy;
  /** Gate mode routes the gate's own verdicts; a question set always scores. */
  gate: boolean;
  apiKey: string;
  limits: Limits;
  concurrency: number;
  progress: (done: number, total: number, verdict: string) => string;
}

interface ScoringResult {
  outcomes: Array<ScoredOutcome | null>;
  stop: StopLabel;
  requests: number;
  elapsedMs: number;
}

/** Score every target once: cache hits first, then requests under the counter, pool, and stop rules. */
async function scoreTargets(run: ScoringRun): Promise<ScoringResult> {
  const counter = new RequestCounter(run.limits);
  const transport = {
    fetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init),
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  const beforeAttempt = (): boolean => counter.gateAttempt(JEV_POLICY.model);

  const outcomes: Array<ScoredOutcome | null> = run.targets.map(() => null);
  let stop: StopLabel | null = null;
  let consecutiveFailures = 0;
  let done = 0;

  /** Surface a ceiling the counter reached on its own; the first stop set wins. */
  const syncStop = (): void => {
    if (stop !== null) return;
    if (counter.exhausted()) stop = counter.stopReason === "deadline" ? "time limit" : "request limit";
  };

  const appendCache = (line: CacheLine): void => appendCacheLine(run.cachePath, line);

  const finish = (outcome: ScoredOutcome): void => {
    process.stdout.write(`${run.progress(done + 1, run.targets.length, outcome.verdict)}\n`);
    done++;
    if (!outcome.cached) {
      // Only this run's own requests move the failure streak: a cached line is history.
      if (outcome.verdict === "fallback" && (outcome.reason === "http_401" || outcome.reason === "http_403")) {
        stop ??= "auth error";
      } else if (outcome.verdict === "fallback" && outcome.attempts > 0) {
        consecutiveFailures++;
        if (consecutiveFailures >= FAILURE_LIMIT) stop ??= "three failed requests in a row";
      } else if (
        outcome.verdict === "no_lesson" ||
        outcome.verdict === "maybe_lesson" ||
        outcome.verdict === "scored"
      ) {
        consecutiveFailures = 0;
      }
    }
    syncStop();
  };

  const scoreTarget = async (target: ScoreTarget): Promise<ScoredOutcome> => {
    const hit = run.cache.get(target.key);
    if (hit !== undefined) {
      return {
        verdict: hit.verdict,
        answers: hit.answers,
        reason: hit.reason,
        model: hit.model,
        attempts: hit.attempts,
        latencyMs: hit.latencyMs,
        usage: hit.usage,
        cached: true,
      };
    }
    const state = buildGateState(target.texts, run.policy);
    if (state.kind === "oversized") {
      appendCache({
        key: target.key,
        verdict: "fallback",
        answers: null,
        reason: "oversized_state",
        model: null,
        attempts: 0,
        latencyMs: 0,
        usage: null,
      });
      return {
        verdict: "fallback",
        answers: null,
        reason: "oversized_state",
        model: null,
        attempts: 0,
        latencyMs: 0,
        usage: null,
        cached: false,
      };
    }
    const result: JevResult = await callJev(state.state, run.apiKey, run.policy, transport, beforeAttempt);
    const scored = result.kind === "scored";
    let verdict: Verdict = "fallback";
    if (scored) verdict = run.gate ? routeGate(result, run.policy) : "scored";
    const outcome: ScoredOutcome = {
      verdict,
      answers: scored ? result.answers : null,
      reason: scored ? null : result.reason,
      model: scored ? result.model : null,
      attempts: result.attempts,
      latencyMs: result.latencyMs,
      usage: scored ? result.usage : null,
      cached: false,
    };
    if (scored || result.reason === "oversized_state") {
      appendCache({
        key: target.key,
        verdict: outcome.verdict,
        answers: outcome.answers,
        reason: outcome.reason,
        model: outcome.model,
        attempts: outcome.attempts,
        latencyMs: outcome.latencyMs,
        usage: outcome.usage,
      });
    }
    return outcome;
  };

  // The pool takes the next unstarted target while no stop is set; outcomes keep target order.
  await runPool<ScoredOutcome>({
    concurrency: run.concurrency,
    size: run.targets.length,
    shouldStart: () => stop === null,
    runOne: (position) => scoreTarget(run.targets[position]),
    onRow: (position, outcome) => {
      outcomes[position] = outcome;
      finish(outcome);
    },
  });

  const snapshot = counter.snapshot();
  return {
    outcomes,
    stop: stop ?? "completed",
    requests: snapshot.requestCount,
    elapsedMs: snapshot.elapsedMs,
  };
}

/** One line of scores.jsonl in exchanges mode: an exchange as it was scored. */
interface ExchangeScoreRow {
  key: string;
  session: string;
  index: number;
  verdict: Verdict;
  answers: Record<string, number> | null;
  reason: string | null;
  model: string | null;
  attempts: number;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  cached: boolean;
}

/** One line of an exchanges file, as the report writes it. */
interface ExchangeLine {
  key: string;
  session: string;
  sessionId: string;
  file: string;
  index: number;
  agentBefore: string;
  userFeedback: string;
  agentAfter: string;
  trimmed: boolean;
}

const EXCHANGE_STRING_FIELDS = [
  "key",
  "session",
  "sessionId",
  "file",
  "agentBefore",
  "userFeedback",
  "agentAfter",
] as const;

/** The exchanges file's lines, or null when a line is malformed or a key repeats. */
function parseExchanges(file: string): ExchangeLine[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const lines: ExchangeLine[] = [];
  const keys = new Set<string>();
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    for (const field of EXCHANGE_STRING_FIELDS) {
      if (typeof record[field] !== "string") return null;
    }
    const index = record.index;
    if (typeof index !== "number" || !Number.isInteger(index)) return null;
    const key = record.key as string;
    if (keys.has(key)) return null;
    keys.add(key);
    lines.push({
      key,
      session: record.session as string,
      sessionId: record.sessionId as string,
      file: record.file as string,
      index,
      agentBefore: record.agentBefore as string,
      userFeedback: record.userFeedback as string,
      agentAfter: record.agentAfter as string,
      trimmed: record.trimmed === true,
    });
  }
  return lines;
}

function notRunExchangeRow(exchange: ExchangeLine): ExchangeScoreRow {
  return {
    key: exchange.key,
    session: exchange.session,
    index: exchange.index,
    verdict: "not_run",
    answers: null,
    reason: null,
    model: null,
    attempts: 0,
    latencyMs: 0,
    usage: null,
    cached: false,
  };
}

function tally(rows: ExchangeScoreRow[]): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.verdict] = (acc[row.verdict] ?? 0) + 1;
    return acc;
  }, {});
}

/** The run's summary for one output folder. */
function writeSummary(outputDir: string, summary: Record<string, unknown>): void {
  fs.writeFileSync(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
}

/** Score a report's exchanges with a question set, writing scores.jsonl and summary.json. */
async function runExchanges(
  args: Record<string, string | string[]>,
  limits: Limits,
  exchangesArg: string,
): Promise<number> {
  if (args.corpus !== undefined || args.set !== undefined || typeof args.questions !== "string") {
    process.stderr.write(`${strings.scoreInputConflict}\n`);
    return 2;
  }
  const concurrency = parseConcurrency(args.concurrency);
  if (concurrency === null) {
    process.stderr.write(`${strings.scoreBadConcurrency}\n`);
    return 2;
  }
  const questionSet = parseQuestionSet(args.questions);
  if (questionSet === null) {
    process.stderr.write(`${strings.scoreBadQuestions(args.questions)}\n`);
    return 2;
  }
  const file = path.resolve(exchangesArg);
  const exchanges = parseExchanges(file);
  if (exchanges === null) {
    process.stderr.write(`${strings.scoreBadExchanges(file)}\n`);
    return 2;
  }
  const policy: JevPolicy = { ...JEV_POLICY, questions: questionSet.questions };
  const cachePath = path.join(path.dirname(file), "cache", `questions-${questionSet.hash}.jsonl`);
  const cache = loadCache<CacheLine>(cachePath, isQuestionCacheLine);
  const cached = exchanges.filter((exchange) => cache.has(exchange.key)).length;
  const outputDir = typeof args.output === "string" ? path.resolve(args.output) : path.dirname(file);

  const block = [
    strings.scoreHeader,
    strings.scoreExchanges(file, exchanges.length, cached, exchanges.length - cached),
    strings.confirmLimits(limits.maxModelRequests, limits.maxRunMs),
    strings.confirmLimitSource(limits.source),
    strings.scoreModelQuestions(JEV_POLICY.model, questionSet.name, questionSet.hash, concurrency),
    strings.scoreOutput(outputDir),
  ].join("\n");
  process.stdout.write(`${block}\n`);
  if (args.confirmed !== "true") {
    process.stdout.write(`${strings.scoreNotConfirmed}\n`);
    return 2;
  }
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    process.stderr.write(`${strings.scoreNoKey}\n`);
    return 2;
  }
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });

  const result = await scoreTargets({
    targets: exchanges.map((exchange) => ({
      key: exchange.key,
      texts: {
        agentBefore: exchange.agentBefore,
        userFeedback: exchange.userFeedback,
        agentAfter: exchange.agentAfter,
      },
    })),
    cache,
    cachePath,
    policy,
    gate: false,
    apiKey,
    limits,
    concurrency,
    progress: (done, total, verdict) => strings.scoreProgressPrompt(done, total, verdict),
  });

  const rows: ExchangeScoreRow[] = exchanges.map((exchange, position) => {
    const outcome = result.outcomes[position];
    if (outcome === null) return notRunExchangeRow(exchange);
    return {
      key: exchange.key,
      session: exchange.session,
      index: exchange.index,
      verdict: outcome.verdict,
      answers: outcome.answers,
      reason: outcome.reason,
      model: outcome.model,
      attempts: outcome.attempts,
      latencyMs: outcome.latencyMs,
      usage: outcome.usage,
      cached: outcome.cached,
    };
  });
  const verdicts = tally(rows);
  const endStop = result.stop;
  const withAnswers = rows.filter((row) => row.answers !== null);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "scores.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf-8",
  );
  writeSummary(outputDir, {
    runType: limits.runType,
    exchanges: file,
    prompts: exchanges.length,
    limits: { maxRequests: limits.maxModelRequests, maxRunMs: limits.maxRunMs, source: limits.source },
    stop: endStop,
    requests: result.requests,
    elapsedMs: result.elapsedMs,
    policyHash: JEV_POLICY_HASH,
    questionSet: { name: questionSet.name, hash: questionSet.hash, file: questionSet.file },
    modelsReturned: [...new Set(withAnswers.map((row) => row.model))],
    verdicts,
    latencyMs: {
      mean: withAnswers.length
        ? Math.round(withAnswers.reduce((sum, row) => sum + row.latencyMs, 0) / withAnswers.length)
        : null,
      max: withAnswers.length ? Math.max(...withAnswers.map((row) => row.latencyMs)) : null,
    },
    usage: withAnswers.reduce(
      (acc, row) => ({
        inputTokens: acc.inputTokens + (row.usage?.inputTokens ?? 0),
        outputTokens: acc.outputTokens + (row.usage?.outputTokens ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0 },
    ),
    concurrency,
    cached,
    confirmed: true,
  });
  process.stdout.write(
    `${strings.scoreDone(
      verdicts.scored ?? 0,
      cached,
      verdicts.fallback ?? 0,
      verdicts.not_run ?? 0,
      result.requests,
      endStop,
    )}\n`,
  );
  return exitCodeFor(endStop);
}

/** Score one set of a frozen corpus: the corpus command's path, unchanged beside exchanges mode. */
async function runCorpus(args: Record<string, string | string[]>, limits: Limits): Promise<number> {
  // Checks before any request, in this order: set, concurrency, question set, freeze, keys.
  const setArg = parseSet(args.set);
  if (setArg === null) {
    process.stderr.write(`${strings.scoreBadSet}\n`);
    return 2;
  }
  const concurrency = parseConcurrency(args.concurrency);
  if (concurrency === null) {
    process.stderr.write(`${strings.scoreBadConcurrency}\n`);
    return 2;
  }
  const questionsArg = typeof args.questions === "string" ? args.questions : null;
  let questionSet: QuestionSet | null = null;
  if (questionsArg !== null) {
    questionSet = parseQuestionSet(questionsArg);
    if (questionSet === null) {
      process.stderr.write(`${strings.scoreBadQuestions(questionsArg)}\n`);
      return 2;
    }
  }
  const policy: JevPolicy = questionSet === null ? JEV_POLICY : { ...JEV_POLICY, questions: questionSet.questions };
  const corpusDir = path.resolve(typeof args.corpus === "string" ? args.corpus : "");
  if (!freezeMatches(corpusDir)) {
    refuseCorpus(corpusDir);
    return 2;
  }

  // Every selected trio must reproduce its key from the frozen copy's text.
  const loaded = loadSelected(corpusDir, setArg);
  if (loaded === null) {
    refuseCorpus(corpusDir);
    return 2;
  }
  const { selected, texts: selectedTexts } = loaded;

  const cachePath = path.join(
    corpusDir,
    "cache",
    questionSet === null ? `gate-${JEV_POLICY_HASH}.jsonl` : `questions-${questionSet.hash}.jsonl`,
  );
  const cache = loadCache<CacheLine>(cachePath, questionSet === null ? isGateCacheLine : isQuestionCacheLine);
  const cached = selected.filter((row) => cache.has(row.key)).length;

  const outputDir =
    typeof args.output === "string"
      ? path.resolve(args.output)
      : path.join(
          findWorkspaceRoot(),
          "outputs",
          "s5",
          `score-${setArg}-${new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "")}`,
        );
  const block = [
    strings.scoreHeader,
    strings.scoreCorpus(corpusDir, setArg, selected.length, cached, selected.length - cached),
    strings.confirmLimits(limits.maxModelRequests, limits.maxRunMs),
    strings.confirmLimitSource(limits.source),
    questionSet === null
      ? strings.scoreModel(JEV_POLICY.model, JEV_POLICY_HASH, concurrency)
      : strings.scoreModelQuestions(JEV_POLICY.model, questionSet.name, questionSet.hash, concurrency),
    strings.scoreOutput(outputDir),
  ].join("\n");
  process.stdout.write(`${block}\n`);
  if (args.confirmed !== "true") {
    process.stdout.write(`${strings.scoreNotConfirmed}\n`);
    return 2;
  }
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    process.stderr.write(`${strings.scoreNoKey}\n`);
    return 2;
  }
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });

  const result = await scoreTargets({
    targets: selected.map((trio, position) => ({ key: trio.key, texts: selectedTexts[position] })),
    cache,
    cachePath,
    policy,
    gate: questionSet === null,
    apiKey,
    limits,
    concurrency,
    progress: (done, total, verdict) => strings.scoreProgress(done, total, verdict),
  });

  const finalRows: ScoreRow[] = selected.map((trio, position) => {
    const outcome = result.outcomes[position];
    if (outcome === null) return notRunRow(trio);
    return {
      key: trio.key,
      set: trio.set,
      sessionId: trio.sessionId,
      file: trio.file,
      index: trio.index,
      verdict: outcome.verdict,
      answers: outcome.answers,
      reason: outcome.reason,
      model: outcome.model,
      attempts: outcome.attempts,
      latencyMs: outcome.latencyMs,
      usage: outcome.usage,
      cached: outcome.cached,
    };
  });
  const verdicts = finalRows.reduce<Record<string, number>>((acc, row) => {
    acc[row.verdict] = (acc[row.verdict] ?? 0) + 1;
    return acc;
  }, {});
  const endStop = result.stop;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "scores.jsonl"),
    `${finalRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf-8",
  );
  if (questionSet === null) {
    fs.writeFileSync(path.join(outputDir, "scores-table.md"), renderScoreTable(finalRows, selectedTexts), "utf-8");
  } else {
    fs.writeFileSync(
      path.join(outputDir, "codes.md"),
      renderCodes(finalRows, selectedTexts, questionSet, setArg),
      "utf-8",
    );
  }
  const withAnswers = finalRows.filter((row) => row.answers !== null);
  writeSummary(outputDir, {
    runType: limits.runType,
    corpus: corpusDir,
    trios: selected.length,
    set: setArg,
    limits: { maxRequests: limits.maxModelRequests, maxRunMs: limits.maxRunMs, source: limits.source },
    stop: endStop,
    requests: result.requests,
    elapsedMs: result.elapsedMs,
    policyHash: JEV_POLICY_HASH,
    ...(questionSet === null
      ? {}
      : { questionSet: { name: questionSet.name, hash: questionSet.hash, file: questionSet.file } }),
    modelsReturned: [...new Set(withAnswers.map((row) => row.model))],
    verdicts,
    latencyMs: {
      mean: withAnswers.length
        ? Math.round(withAnswers.reduce((sum, row) => sum + row.latencyMs, 0) / withAnswers.length)
        : null,
      max: withAnswers.length ? Math.max(...withAnswers.map((row) => row.latencyMs)) : null,
    },
    usage: withAnswers.reduce(
      (acc, row) => ({
        inputTokens: acc.inputTokens + (row.usage?.inputTokens ?? 0),
        outputTokens: acc.outputTokens + (row.usage?.outputTokens ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0 },
    ),
    corpusFreeze: sha256File(path.join(corpusDir, "freeze.json")),
    concurrency,
    cached,
    confirmed: true,
  });
  process.stdout.write(
    `${strings.scoreDone(
      (verdicts.no_lesson ?? 0) + (verdicts.maybe_lesson ?? 0) + (verdicts.scored ?? 0),
      cached,
      verdicts.fallback ?? 0,
      verdicts.not_run ?? 0,
      result.requests,
      endStop,
    )}\n`,
  );
  return exitCodeFor(endStop);
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgv(argv);
  const exchangesArg = typeof args.exchanges === "string" ? args.exchanges : null;

  // Limits first in both modes; then the input mode decides which run follows.
  let limits: Limits;
  try {
    limits = parseLimits(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (exchangesArg !== null) return runExchanges(args, limits, exchangesArg);
  return runCorpus(args, limits);
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
