// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Corpus extraction: run the production extractor over one set of a frozen
 * corpus, several trios at a time, counted against the run limits, and append
 * every successful result to a cache keyed by the extractor revision, so a
 * rerun never pays for the same trio twice. No review, no building, no
 * portrait — and no request before the corpus, the snapshot, the model, and
 * the confirmation are in place.
 *
 * Usage:
 *   node extract.js --corpus <dir> --set dev|heldout|all --run-type <t> \
 *     --max-model-requests N --max-run-ms N --limits-source <s> \
 *     [--concurrency N] [--output <dir>] [--confirmed]
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { InteractionSequence } from "../../src/types.js";
import { RequestCounter } from "./counter.js";
import { parseLimits } from "./limits.js";
import { bootModel, type ModelSnapshot } from "./model-boot.js";
import { captureSettingsSnapshot } from "./settings.js";
import { strings } from "./strings.js";
import type { CorpusSet, CorpusTrio, Limits } from "./types.js";
import { findWorkspaceRoot, parseArgv, sha256File, sha256Text } from "./util.js";

type Outcome = "success" | "failed" | "not_run";

/** How the run ended, in the words the final line reports. */
type StopLabel = "completed" | "request limit" | "time limit" | "three failed extractions in a row";

/** One result row: a corpus trio as it was extracted, cached, failed, or left unstarted. */
interface ExtractRow {
  key: string;
  set: CorpusSet;
  sessionId: string;
  file: string;
  index: number;
  outcome: Outcome;
  notes: string[];
  attempts: number;
  usage: { input: number; output: number } | null;
  latencyMs: number;
  cached: boolean;
}

/** One cache line: a successful extraction, replayed instead of re-requested. */
interface ExtractCacheLine {
  key: string;
  notes: string[];
  attempts: number;
  usage: { input: number; output: number };
  latencyMs: number;
}

/** What one trio's own attempt events consumed, accumulated under its store. */
interface AttemptBucket {
  attempts: number;
  input: number;
  output: number;
}

/** Failed extractions in a row after which the run stops. */
const FAILURE_LIMIT = 3;

function isCacheLine(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const line = value as { key?: unknown; notes?: unknown; attempts?: unknown; latencyMs?: unknown; usage?: unknown };
  if (typeof line.key !== "string" || !Array.isArray(line.notes)) return false;
  if (typeof line.attempts !== "number" || typeof line.latencyMs !== "number") return false;
  if (typeof line.usage !== "object" || line.usage === null) return false;
  const usage = line.usage as { input?: unknown; output?: unknown };
  return typeof usage.input === "number" && typeof usage.output === "number";
}

function notRunRow(trio: CorpusTrio): ExtractRow {
  return {
    key: trio.key,
    set: trio.set,
    sessionId: trio.sessionId,
    file: trio.file,
    index: trio.index,
    outcome: "not_run",
    notes: [],
    attempts: 0,
    usage: null,
    latencyMs: 0,
    cached: false,
  };
}

function refuseCorpus(dir: string): void {
  process.stderr.write(`${strings.scoreCorpusChanged(dir)}\n`);
}

function exitCodeFor(stop: StopLabel): number {
  if (stop === "completed") return 0;
  if (stop === "request limit" || stop === "time limit") return 3;
  return 4;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgv(argv);

  // Env isolation first: the extractor reads the portrait dir from the environment,
  // and this run's portrait dir lives inside its own output.
  const setForPath = typeof args.set === "string" ? args.set : "set";
  const outputDir =
    typeof args.output === "string"
      ? path.resolve(args.output)
      : path.join(
          findWorkspaceRoot(),
          "outputs",
          "s5",
          `extract-${setForPath}-${new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "")}`,
        );
  const portraitDir = path.join(outputDir, "portrait");
  fs.mkdirSync(portraitDir, { recursive: true });
  process.env.PI_PORTRAIT_STATE_DIR = portraitDir;

  // Everything that can reach src loads only after the isolation is in place.
  const { appendCacheLine, fillNotRun, freezeMatches, loadCache, loadSelected, parseConcurrency, parseSet, runPool } =
    await import("./corpus-run.js");
  const { EXTRACTION_POLICY_REVISION } = await import("../../src/work-state.js");
  const { callExtractionLlm } = await import("../../src/collector.js");
  const { setLlmAttemptSink } = await import("../../src/llm-call.js");

  // Checks before any request, in the score order: limits, set, concurrency, freeze, keys.
  let limits: Limits;
  try {
    limits = parseLimits(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
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
  const corpusDir = path.resolve(typeof args.corpus === "string" ? args.corpus : "");
  if (!freezeMatches(corpusDir)) {
    refuseCorpus(corpusDir);
    return 2;
  }
  const loaded = loadSelected(corpusDir, setArg);
  if (loaded === null) {
    refuseCorpus(corpusDir);
    return 2;
  }
  const { selected, texts: selectedTexts } = loaded;

  // The frozen run snapshot, the model, and the extractor revision that keys the cache.
  const { snapshotPath } = await captureSettingsSnapshot(path.join(outputDir, "settings-snapshot.json"));
  const settings = JSON.parse(fs.readFileSync(snapshotPath, "utf-8")) as ModelSnapshot;
  const counter = new RequestCounter(limits);
  const booted = await bootModel(settings, counter);
  if ("error" in booted) {
    process.stderr.write(`compass harness: ${booted.error}\n`);
    return 1;
  }
  const provider = booted.model.provider;
  const id = booted.model.id;
  const thinkingLevel = settings.portraitSettings.thinkingLevel;
  const revision = sha256Text(`${EXTRACTION_POLICY_REVISION}\n${provider}/${id}\n${thinkingLevel}`).slice(0, 12);

  const cachePath = path.join(corpusDir, "cache", `extract-${revision}.jsonl`);
  const cache = loadCache<ExtractCacheLine>(cachePath, isCacheLine);
  const cached = selected.filter((row) => cache.has(row.key)).length;

  const block = [
    strings.extractHeader,
    strings.extractCorpus(corpusDir, setArg, selected.length, cached, selected.length - cached),
    strings.confirmLimits(limits.maxModelRequests, limits.maxRunMs),
    strings.confirmLimitSource(limits.source),
    strings.extractModel(provider, id, thinkingLevel, revision, concurrency),
    strings.scoreOutput(outputDir),
  ].join("\n");
  process.stdout.write(`${block}\n`);
  if (args.confirmed !== "true") {
    process.stdout.write(`${strings.scoreNotConfirmed}\n`);
    return 2;
  }
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  // Failures report through the same diagnostics file the pipeline run writes.
  globalThis.__piPortraitReportError = (message: string, source: string) => {
    fs.appendFileSync(
      path.join(outputDir, "diagnostics.log"),
      `${new Date().toISOString()} [${source}] ${message}\n`,
      "utf-8",
    );
  };

  // One store per trio: its attempt events accumulate under its own async context,
  // so concurrent trios never mix attempts or usage.
  const attemptStore = new AsyncLocalStorage<AttemptBucket>();
  setLlmAttemptSink((event) => {
    const bucket = attemptStore.getStore();
    if (bucket === undefined) return;
    bucket.attempts++;
    if (event.usage) {
      if (typeof event.usage.input === "number") bucket.input += event.usage.input;
      if (typeof event.usage.output === "number") bucket.output += event.usage.output;
    }
  });

  const rows: Array<ExtractRow | null> = selected.map(() => null);
  let stop: StopLabel | null = null;
  let consecutiveFailures = 0;
  let done = 0;

  /** Surface a ceiling the counter reached on its own; the first stop set wins. */
  const syncStop = (): void => {
    if (stop !== null) return;
    if (counter.exhausted()) stop = counter.stopReason === "deadline" ? "time limit" : "request limit";
  };

  const finish = (row: ExtractRow): void => {
    process.stdout.write(
      row.outcome === "failed"
        ? `${strings.extractFailed(done + 1, selected.length)}\n`
        : `${strings.extractProgress(done + 1, selected.length, row.notes.length)}\n`,
    );
    done++;
    // The ceiling first: it is what declined this trio's requests.
    syncStop();
    if (row.outcome === "success") {
      consecutiveFailures = 0;
    } else if (stop === null) {
      consecutiveFailures++;
      if (consecutiveFailures >= FAILURE_LIMIT) stop = "three failed extractions in a row";
    }
  };

  const runTrio = async (trio: CorpusTrio, texts: InteractionSequence): Promise<ExtractRow> => {
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
        outcome: "success",
        notes: hit.notes,
        attempts: hit.attempts,
        usage: hit.usage,
        latencyMs: hit.latencyMs,
        cached: true,
      };
    }
    const bucket: AttemptBucket = { attempts: 0, input: 0, output: 0 };
    const startedAtMs = Date.now();
    let outcome: "success" | "failed" = "failed";
    let notes: string[] = [];
    try {
      const extraction = await attemptStore.run(bucket, () => callExtractionLlm(texts, 0));
      if (extraction.kind === "success") {
        outcome = "success";
        notes = extraction.notes;
      }
    } catch (error) {
      // The extractor's paused sentinel is one failed extraction; anything else is unexpected.
      if (!(error instanceof Error && error.message === "PAUSED")) throw error;
    }
    const row: ExtractRow = {
      ...identity,
      outcome,
      notes,
      attempts: bucket.attempts,
      usage: bucket.attempts > 0 ? { input: bucket.input, output: bucket.output } : null,
      latencyMs: Date.now() - startedAtMs,
      cached: false,
    };
    if (outcome === "success") {
      appendCacheLine(cachePath, {
        key: row.key,
        notes: row.notes,
        attempts: row.attempts,
        usage: { input: bucket.input, output: bucket.output },
        latencyMs: row.latencyMs,
      });
    }
    return row;
  };

  try {
    // The pool takes the next unstarted trio while no stop is set; rows keep corpus order.
    await runPool<ExtractRow>({
      concurrency,
      size: selected.length,
      shouldStart: () => stop === null,
      runOne: (position) => runTrio(selected[position], selectedTexts[position]),
      onRow: (position, row) => {
        rows[position] = row;
        finish(row);
      },
    });
  } finally {
    setLlmAttemptSink(null);
  }

  const finalRows: ExtractRow[] = fillNotRun(selected, rows, notRunRow);
  const outcomes = finalRows.reduce<Record<string, number>>((acc, row) => {
    acc[row.outcome] = (acc[row.outcome] ?? 0) + 1;
    return acc;
  }, {});
  const runSnapshot = counter.snapshot();
  const endStop: StopLabel = stop ?? "completed";

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "extract.jsonl"),
    `${finalRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(outputDir, "summary.json"),
    `${JSON.stringify(
      {
        runType: limits.runType,
        corpus: corpusDir,
        set: setArg,
        corpusFreeze: sha256File(path.join(corpusDir, "freeze.json")),
        limits: { maxRequests: limits.maxModelRequests, maxRunMs: limits.maxRunMs, source: limits.source },
        confirmed: true,
        concurrency,
        model: `${provider}/${id}`,
        thinkingLevel,
        revision,
        postExtractionEnabled: settings.portraitSettings.postExtractionEnabled,
        trios: selected.length,
        cached,
        outcomes,
        requests: runSnapshot.requestCount,
        elapsedMs: runSnapshot.elapsedMs,
        usage: runSnapshot.usageTotals,
        stop: endStop,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  process.stdout.write(
    `${strings.extractDone(
      outcomes.success ?? 0,
      cached,
      outcomes.failed ?? 0,
      outcomes.not_run ?? 0,
      runSnapshot.requestCount,
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
