// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Corpus scoring: run the Jev classifier over one set of a frozen corpus,
 * several trios at a time, counted against the run limits, and append every
 * durable result to a cache so a rerun never pays for the same trio twice.
 * No extraction, no building, no portrait — only Jev requests, and none before
 * the corpus, the confirmation, and the credential have been checked.
 *
 * Usage:
 *   node score.js --corpus <dir> --set dev|heldout|all --run-type <t> \
 *     --max-model-requests N --max-run-ms N --limits-source <s> \
 *     [--concurrency N] [--output <dir>] [--confirmed]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { buildGateState, callJev, JEV_POLICY, JEV_POLICY_HASH, type JevResult, routeGate } from "../../src/jev.js";
import type { InteractionSequence } from "../../src/types.js";
import { trioKey } from "./corpus.js";
import { RequestCounter } from "./counter.js";
import { parseLimits } from "./limits.js";
import { readTrios, renderTable } from "./probe.js";
import { strings } from "./strings.js";
import type { CorpusSet, CorpusTrio, Limits } from "./types.js";
import { findWorkspaceRoot, parseArgv, sha256File } from "./util.js";

type Verdict = "no_lesson" | "maybe_lesson" | "fallback" | "not_run";

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

const DEFAULT_CONCURRENCY = 4;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;
/** Failed requests in a row after which scoring stops (the same limit the gate uses). */
const FAILURE_LIMIT = 3;
const SNIPPET_CHARS = 90;
const VERDICTS: Verdict[] = ["no_lesson", "maybe_lesson", "fallback", "not_run"];

function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as string[]).includes(value);
}

/** The table's reply cell: whitespace flattened, at most 90 characters. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1)}…` : flat;
}

/** The frozen copy's hash matches the recorded freeze, both files present. */
function freezeMatches(corpusDir: string): boolean {
  let freeze: Record<string, unknown>;
  try {
    freeze = JSON.parse(fs.readFileSync(path.join(corpusDir, "freeze.json"), "utf-8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  const corpusHash = freeze["corpus.json"];
  const triosHash = freeze["trios.jsonl"];
  if (typeof corpusHash !== "string" || typeof triosHash !== "string") return false;
  const corpusJson = path.join(corpusDir, "corpus.json");
  const triosJsonl = path.join(corpusDir, "trios.jsonl");
  if (!fs.existsSync(corpusJson) || !fs.existsSync(triosJsonl)) return false;
  return sha256File(corpusJson) === corpusHash && sha256File(triosJsonl) === triosHash;
}

function isCacheLine(value: CacheLine): boolean {
  if (typeof value.key !== "string" || !isVerdict(value.verdict)) return false;
  if (typeof value.attempts !== "number" || typeof value.latencyMs !== "number") return false;
  if (value.reason !== null && typeof value.reason !== "string") return false;
  if (value.model !== null && typeof value.model !== "string") return false;
  if (value.answers !== null && typeof value.answers !== "object") return false;
  if (value.usage !== null && typeof value.usage !== "object") return false;
  return true;
}

/** The cache as a key → result map; a truncated or foreign line is ignored, first line wins. */
function loadCache(cachePath: string): Map<string, CacheLine> {
  const cache = new Map<string, CacheLine>();
  let raw: string;
  try {
    raw = fs.readFileSync(cachePath, "utf-8");
  } catch {
    return cache;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: CacheLine;
    try {
      parsed = JSON.parse(line) as CacheLine;
    } catch {
      continue;
    }
    if (!isCacheLine(parsed) || cache.has(parsed.key)) continue;
    cache.set(parsed.key, parsed);
  }
  return cache;
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
        verdict: row.verdict,
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

function exitCodeFor(stop: StopLabel): number {
  if (stop === "completed") return 0;
  if (stop === "request limit" || stop === "time limit") return 3;
  return 4;
}

function refuseCorpus(dir: string): void {
  process.stderr.write(`${strings.scoreCorpusChanged(dir)}\n`);
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgv(argv);

  // Checks before any request, in this order: limits, set, concurrency, freeze, keys.
  let limits: Limits;
  try {
    limits = parseLimits(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const setArg = typeof args.set === "string" ? args.set : null;
  if (setArg !== "dev" && setArg !== "heldout" && setArg !== "all") {
    process.stderr.write(`${strings.scoreBadSet}\n`);
    return 2;
  }
  const rawConcurrency = typeof args.concurrency === "string" ? args.concurrency : `${DEFAULT_CONCURRENCY}`;
  const concurrency = Number(rawConcurrency);
  if (!Number.isInteger(concurrency) || concurrency < MIN_CONCURRENCY || concurrency > MAX_CONCURRENCY) {
    process.stderr.write(`${strings.scoreBadConcurrency}\n`);
    return 2;
  }
  const corpusDir = path.resolve(typeof args.corpus === "string" ? args.corpus : "");
  if (!freezeMatches(corpusDir)) {
    refuseCorpus(corpusDir);
    return 2;
  }

  const selected: CorpusTrio[] = [];
  for (const line of fs.readFileSync(path.join(corpusDir, "trios.jsonl"), "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as CorpusTrio;
    if (setArg === "all" || row.set === setArg) selected.push(row);
  }

  // Every selected trio must reproduce its key from the frozen copy's text.
  const textsByFile = new Map<string, InteractionSequence[]>();
  const selectedTexts: InteractionSequence[] = [];
  for (const row of selected) {
    let texts = textsByFile.get(row.file);
    if (texts === undefined) {
      try {
        texts = readTrios(path.join(corpusDir, row.file));
      } catch {
        refuseCorpus(corpusDir);
        return 2;
      }
      textsByFile.set(row.file, texts);
    }
    const trio: InteractionSequence | undefined = texts[row.index - 1];
    if (trio === undefined || trioKey(row.sessionId, row.index, trio) !== row.key) {
      refuseCorpus(corpusDir);
      return 2;
    }
    selectedTexts.push(trio);
  }

  const cachePath = path.join(corpusDir, "cache", `gate-${JEV_POLICY_HASH}.jsonl`);
  const cache = loadCache(cachePath);
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
    strings.scoreModel(JEV_POLICY.model, JEV_POLICY_HASH, concurrency),
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

  const counter = new RequestCounter(limits);
  const transport = {
    fetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init),
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  const beforeAttempt = (): boolean => counter.gateAttempt(JEV_POLICY.model);

  const rows: Array<ScoreRow | null> = selected.map(() => null);
  let nextIndex = 0;
  let stop: StopLabel | null = null;
  let consecutiveFailures = 0;
  let done = 0;

  /** Surface a ceiling the counter reached on its own; the first stop set wins. */
  const syncStop = (): void => {
    if (stop !== null) return;
    if (counter.exhausted()) stop = counter.stopReason === "deadline" ? "time limit" : "request limit";
  };

  const appendCache = (line: CacheLine): void => {
    fs.appendFileSync(cachePath, `${JSON.stringify(line)}\n`, "utf-8");
  };

  const finish = (row: ScoreRow): void => {
    process.stdout.write(`${strings.scoreProgress(done + 1, selected.length, row.verdict)}\n`);
    done++;
    if (!row.cached) {
      // Only this run's own requests move the failure streak: a cached line is history.
      if (row.verdict === "fallback" && (row.reason === "http_401" || row.reason === "http_403")) {
        stop ??= "auth error";
      } else if (row.verdict === "fallback" && row.attempts > 0) {
        consecutiveFailures++;
        if (consecutiveFailures >= FAILURE_LIMIT) stop ??= "three failed requests in a row";
      } else if (row.verdict === "no_lesson" || row.verdict === "maybe_lesson") {
        consecutiveFailures = 0;
      }
    }
    syncStop();
  };

  const scoreTrio = async (trio: CorpusTrio, texts: InteractionSequence): Promise<ScoreRow> => {
    const identity = {
      key: trio.key,
      set: trio.set,
      sessionId: trio.sessionId,
      file: trio.file,
      index: trio.index,
    };
    const hit = cache.get(trio.key);
    if (hit !== undefined) {
      return {
        ...identity,
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
    const state = buildGateState(texts, JEV_POLICY);
    if (state.kind === "oversized") {
      const row: ScoreRow = {
        ...identity,
        verdict: "fallback",
        answers: null,
        reason: "oversized_state",
        model: null,
        attempts: 0,
        latencyMs: 0,
        usage: null,
        cached: false,
      };
      appendCache({
        key: row.key,
        verdict: row.verdict,
        answers: null,
        reason: row.reason,
        model: null,
        attempts: 0,
        latencyMs: 0,
        usage: null,
      });
      return row;
    }
    const result: JevResult = await callJev(state.state, apiKey, JEV_POLICY, transport, beforeAttempt);
    const scored = result.kind === "scored";
    const row: ScoreRow = {
      ...identity,
      verdict: scored ? routeGate(result, JEV_POLICY) : "fallback",
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
        key: row.key,
        verdict: row.verdict,
        answers: row.answers,
        reason: row.reason,
        model: row.model,
        attempts: row.attempts,
        latencyMs: row.latencyMs,
        usage: row.usage,
      });
    }
    return row;
  };

  // A worker takes the next unstarted trio while no stop is set; rows keep corpus order.
  const worker = async (): Promise<void> => {
    for (;;) {
      if (stop !== null) return;
      const position = nextIndex;
      if (position >= selected.length) return;
      nextIndex++;
      const row = await scoreTrio(selected[position], selectedTexts[position]);
      rows[position] = row;
      finish(row);
    }
  };
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);

  const finalRows: ScoreRow[] = rows.map((row, position) => row ?? notRunRow(selected[position]));
  const verdicts = finalRows.reduce<Record<string, number>>((acc, row) => {
    acc[row.verdict] = (acc[row.verdict] ?? 0) + 1;
    return acc;
  }, {});
  const snapshot = counter.snapshot();
  const endStop: StopLabel = stop ?? "completed";

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "scores.jsonl"),
    `${finalRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf-8",
  );
  fs.writeFileSync(path.join(outputDir, "scores-table.md"), renderScoreTable(finalRows, selectedTexts), "utf-8");
  const withAnswers = finalRows.filter((row) => row.answers !== null);
  fs.writeFileSync(
    path.join(outputDir, "summary.json"),
    `${JSON.stringify(
      {
        runType: limits.runType,
        corpus: corpusDir,
        trios: selected.length,
        set: setArg,
        limits: { maxRequests: limits.maxModelRequests, maxRunMs: limits.maxRunMs, source: limits.source },
        stop: endStop,
        requests: snapshot.requestCount,
        elapsedMs: snapshot.elapsedMs,
        policyHash: JEV_POLICY_HASH,
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
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  process.stdout.write(
    `${strings.scoreDone(
      (verdicts.no_lesson ?? 0) + (verdicts.maybe_lesson ?? 0),
      cached,
      verdicts.fallback ?? 0,
      verdicts.not_run ?? 0,
      snapshot.requestCount,
      endStop,
    )}\n`,
  );
  return exitCodeFor(endStop);
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
