// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Corpus scoring: every refusal path runs before any request; the counter is
 * the only path to fetch; the cache rules; concurrency with corpus-order rows;
 * the stop rules; and the credential staying out of every artifact. fetch is
 * mocked and rejects by default, TYPESAFE_API_KEY is set and restored per
 * test, and every corpus is frozen by the corpus command in a temp folder —
 * nothing reads ~/.pi.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main as freezeCorpus } from "../../scripts/compass/corpus.js";
import { main as scoreCorpus } from "../../scripts/compass/score.js";
import { strings } from "../../scripts/compass/strings.js";
import type { CorpusSet, CorpusTrio } from "../../scripts/compass/types.js";
import { sha256File, sha256Text } from "../../scripts/compass/util.js";

const ROOT = process.cwd();
// Unique per test-file run so overlapping suite runs never share a directory.
const TEST_TMP_ROOT = path.join(ROOT, "outputs", "test-tmp");
fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
const TEST_TMP = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "score-"));

const KEY = "score-credential-placeholder-0000";
const HASH = "ad7880acdc3b";
const MODEL = "jev-1.13.0";

const sessionHeader = (id: string): Record<string, unknown> => ({ type: "session", id, cwd: "/tmp/project" });
const assistant = (text: string): Record<string, unknown> => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const user = (text: string): Record<string, unknown> => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text }] },
});

/** A header plus `count` trios: header, first assistant, then one user/assistant pair per trio. */
function trioRecords(header: Record<string, unknown> | null, count: number): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  if (header !== null) records.push(header);
  records.push(assistant("the plan the agent laid out"));
  for (let i = 0; i < count; i++) {
    records.push(user(`the user's feedback number ${i + 1}`));
    records.push(assistant(`the agent's reply number ${i + 1}`));
  }
  return records;
}

function writeSession(dir: string, name: string, records: Record<string, unknown>[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf-8");
}

/** The split as the task defines it, restated here to check runs against the spec. */
function setFor(seed: string, sessionId: string): CorpusSet {
  return parseInt(sha256Text(`${seed}\n${sessionId}`).slice(0, 8), 16) % 2 === 0 ? "dev" : "heldout";
}

/** A seed that lands every given session id in the wanted set. */
function seedLanding(sessionIds: string[], wanted: CorpusSet, prefix: string): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const seed = `${prefix}-${attempt}`;
    if (sessionIds.every((id) => setFor(seed, id) === wanted)) return seed;
  }
  throw new Error(`no seed lands ${sessionIds.join(", ")} in ${wanted}`);
}

/** A seed that lands the first session in dev and the second in heldout. */
function seedSplitting(first: string, second: string): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const seed = `split-${attempt}`;
    if (setFor(seed, first) === "dev" && setFor(seed, second) === "heldout") return seed;
  }
  throw new Error(`no seed lands ${first} in dev and ${second} in heldout`);
}

const LOW_ANSWERS = {
  correction: { type: "noul", noul: 0.01 },
  preference: { type: "noul", noul: 0.02 },
  steering: { type: "noul", noul: 0 },
  confusion: { type: "noul", noul: 0.05 },
};

function scoredResponse(): Response {
  return new Response(
    JSON.stringify({ model: MODEL, answers: LOW_ANSWERS, usage: { input_tokens: 12, output_tokens: 3 } }),
    {
      status: 200,
    },
  );
}

function statusResponse(status: number): Response {
  return new Response("", { status });
}

const fetchMock = vi.fn((): Promise<Response> => Promise.reject(new Error("network is unavailable in tests")));
const REAL_FETCH = globalThis.fetch;
let savedKey: string | undefined;

async function capture(run: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const code = await run();
    return {
      code,
      out: outSpy.mock.calls.map((call) => String(call[0])).join(""),
      err: errSpy.mock.calls.map((call) => String(call[0])).join(""),
    };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

/** Freeze one source folder of session files and return the corpus directory. */
async function freezeSource(
  name: string,
  seed: string,
  files: Record<string, Record<string, unknown>[]>,
): Promise<string> {
  const source = path.join(TEST_TMP, `source-${name}`);
  for (const [fileName, records] of Object.entries(files)) writeSession(source, fileName, records);
  const corpusDir = path.join(TEST_TMP, `corpus-${name}`);
  const result = await capture(() => freezeCorpus(["--source", source, "--output", corpusDir, "--seed", seed]));
  expect(result.code).toBe(0);
  return corpusDir;
}

interface ScoreRun {
  corpus: string;
  set: string;
  output: string;
  requests: string;
  runMs: string;
  /** null omits the switch entirely, so the default applies. */
  concurrency: string | null;
  confirmed: boolean;
}

function scoreArgv(run: ScoreRun): string[] {
  const argv = [
    "--corpus",
    run.corpus,
    "--set",
    run.set,
    "--run-type",
    "smoke",
    "--max-model-requests",
    run.requests,
    "--max-run-ms",
    run.runMs,
    "--limits-source",
    "user-override",
    "--output",
    run.output,
  ];
  if (run.concurrency !== null) argv.push("--concurrency", run.concurrency);
  if (run.confirmed) argv.push("--confirmed");
  return argv;
}

function defaultRun(corpus: string, output: string): ScoreRun {
  return {
    corpus,
    set: "all",
    output,
    requests: "50",
    runMs: "600000",
    concurrency: "4",
    confirmed: true,
  };
}

interface ScoreRowJson {
  key: string;
  set: CorpusSet;
  sessionId: string;
  file: string;
  index: number;
  verdict: string;
  answers: Record<string, number> | null;
  reason: string | null;
  model: string | null;
  attempts: number;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  cached: boolean;
}

function readRows(outputDir: string): ScoreRowJson[] {
  return fs
    .readFileSync(path.join(outputDir, "scores.jsonl"), "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ScoreRowJson);
}

function readCorpusRows(corpusDir: string): CorpusTrio[] {
  return fs
    .readFileSync(path.join(corpusDir, "trios.jsonl"), "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CorpusTrio);
}

function readSummary(outputDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(outputDir, "summary.json"), "utf-8")) as Record<string, unknown>;
}

function readCacheLines(corpusDir: string): Record<string, unknown>[] {
  const cachePath = path.join(corpusDir, "cache", `gate-${HASH}.jsonl`);
  if (!fs.existsSync(cachePath)) return [];
  return fs
    .readFileSync(cachePath, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The one-session corpus most tests run against: three trios, dev and heldout irrelevant. */
function threeTrioFiles(): Record<string, Record<string, unknown>[]> {
  return { "alpha.jsonl": trioRecords(sessionHeader("sess-alpha"), 3) };
}

beforeEach(() => {
  savedKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.reject(new Error("network is unavailable in tests")));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
  fs.mkdirSync(TEST_TMP, { recursive: true });
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = savedKey;
  globalThis.fetch = REAL_FETCH;
  vi.restoreAllMocks();
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
});

describe("refusals before any request", () => {
  it("refuses a limits error with the harness message and makes no request", async () => {
    const corpus = await freezeSource("limits", "seed", threeTrioFiles());
    const outDir = path.join(TEST_TMP, "score-out");

    const { code, err } = await capture(() =>
      scoreCorpus([
        "--corpus",
        corpus,
        "--set",
        "all",
        "--run-type",
        "smoke",
        "--max-model-requests",
        "5",
        "--limits-source",
        "user-override",
        "--output",
        outDir,
        "--confirmed",
      ]),
    );

    expect(code).toBe(2);
    expect(err).toBe(`${strings.missingSwitch("max-run-ms")}\n`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it("refuses an unknown set with the approved message", async () => {
    const corpus = await freezeSource("set-guard", "seed", threeTrioFiles());
    const outDir = path.join(TEST_TMP, "score-out");

    const { code, err } = await capture(() =>
      scoreCorpus(scoreArgv({ ...defaultRun(corpus, outDir), set: "development" })),
    );

    expect(code).toBe(2);
    expect(err).toBe(`${strings.scoreBadSet}\n`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it.each(["0", "9", "4.5", "abc"])("refuses an out-of-range concurrency of %s", async (value) => {
    const corpus = await freezeSource("concurrency-guard", "seed", threeTrioFiles());
    const outDir = path.join(TEST_TMP, `score-out-${value}`);

    const { code, err } = await capture(() =>
      scoreCorpus(scoreArgv({ ...defaultRun(corpus, outDir), concurrency: value })),
    );

    expect(code).toBe(2);
    expect(err).toBe(`${strings.scoreBadConcurrency}\n`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a corpus whose freeze file is missing", async () => {
    const corpus = await freezeSource("no-freeze", "seed", threeTrioFiles());
    fs.rmSync(path.join(corpus, "freeze.json"));
    const outDir = path.join(TEST_TMP, "score-out");

    const { code, err } = await capture(() => scoreCorpus(scoreArgv(defaultRun(corpus, outDir))));

    expect(code).toBe(2);
    expect(err).toBe(`${strings.scoreCorpusChanged(corpus)}\n`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an edited corpus file", async () => {
    const corpus = await freezeSource("edited-meta", "seed", threeTrioFiles());
    const corpusJson = path.join(corpus, "corpus.json");
    fs.writeFileSync(corpusJson, `${fs.readFileSync(corpusJson, "utf-8")}\n`, "utf-8");
    const outDir = path.join(TEST_TMP, "score-out");

    const { code, err } = await capture(() => scoreCorpus(scoreArgv(defaultRun(corpus, outDir))));

    expect(code).toBe(2);
    expect(err).toBe(`${strings.scoreCorpusChanged(corpus)}\n`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a frozen session copy edited after the freeze", async () => {
    const corpus = await freezeSource("edited-copy", "seed", threeTrioFiles());
    const copy = path.join(corpus, "sessions", "1-source-edited-copy", "alpha.jsonl");
    const edited = fs
      .readFileSync(copy, "utf-8")
      .replace("the agent's reply number 1", "a reply that changed after the freeze");
    fs.writeFileSync(copy, edited, "utf-8");
    const outDir = path.join(TEST_TMP, "score-out");

    const { code, err } = await capture(() => scoreCorpus(scoreArgv(defaultRun(corpus, outDir))));

    expect(code).toBe(2);
    expect(err).toBe(`${strings.scoreCorpusChanged(corpus)}\n`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it("refuses without --confirmed, before the credential check and any request", async () => {
    const corpus = await freezeSource("unconfirmed", "seed", threeTrioFiles());
    const outDir = path.join(TEST_TMP, "score-out");

    const { code, out, err } = await capture(() =>
      scoreCorpus(scoreArgv({ ...defaultRun(corpus, outDir), confirmed: false })),
    );

    expect(code).toBe(2);
    expect(out).toContain(`${strings.scoreNotConfirmed}\n`);
    expect(err).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it("refuses without TYPESAFE_API_KEY even when every trio is cached", async () => {
    const corpus = await freezeSource("no-key-cached", "seed", threeTrioFiles());
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(async () => scoredResponse());
    const firstRun = await capture(() =>
      scoreCorpus(scoreArgv(defaultRun(corpus, path.join(TEST_TMP, "score-first")))),
    );
    expect(firstRun.code).toBe(0);
    expect(readCacheLines(corpus)).toHaveLength(3);
    fetchMock.mockClear();

    delete process.env.TYPESAFE_API_KEY;
    const outDir = path.join(TEST_TMP, "score-out");
    const { code, out, err } = await capture(() => scoreCorpus(scoreArgv(defaultRun(corpus, outDir))));

    expect(code).toBe(2);
    expect(err).toBe(`${strings.scoreNoKey}\n`);
    expect(out).toContain("(3 cached, 0 to score)");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(outDir)).toBe(false);
  });
});

describe("a completed run", () => {
  it("prints the approved run block, one progress line per trio, and the final line", async () => {
    const corpus = await freezeSource("block", seedSplitting("sess-alpha", "sess-beta"), {
      "alpha.jsonl": trioRecords(sessionHeader("sess-alpha"), 3),
      "beta.jsonl": trioRecords(sessionHeader("sess-beta"), 3),
    });
    const outDir = path.join(TEST_TMP, "score-out");
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(async () => scoredResponse());

    const { code, out, err } = await capture(() => scoreCorpus(scoreArgv(defaultRun(corpus, outDir))));

    expect(code).toBe(0);
    expect(err).toBe("");
    const lines = out.split("\n");
    expect(lines[0]).toBe("compass score — Jev classifier only (no extraction, no building, no portrait)");
    expect(lines[1]).toBe(`Corpus: ${corpus} · set all: 6 trios (0 cached, 6 to score)`);
    expect(lines[2]).toBe(strings.confirmLimits(50, 600000));
    expect(lines[3]).toBe(strings.confirmLimitSource("user-override"));
    expect(lines[4]).toBe(`Jev model: ${MODEL} · policy ${HASH} · 4 at once`);
    expect(lines[5]).toBe(`Output: ${outDir}`);
    expect(lines[6]).toMatch(/^trio 1\/6: no_lesson$/);
    const progress = lines.filter((line) => /^trio \d+\/6: /.test(line));
    expect(progress.map((line) => Number(line.slice("trio ".length).split("/")[0]))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(lines[lines.length - 2]).toBe(
      "Scored 6 · cached 0 · fallbacks 0 · not run 0 · requests 6 · stop: completed",
    );
  });

  it("writes rows in corpus order, the session column on the table, and the summary", async () => {
    const corpus = await freezeSource("artifacts", seedSplitting("sess-alpha", "sess-beta"), {
      "alpha.jsonl": trioRecords(sessionHeader("sess-alpha"), 3),
      "beta.jsonl": trioRecords(sessionHeader("sess-beta"), 3),
    });
    const outDir = path.join(TEST_TMP, "score-out");
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(async () => scoredResponse());

    const { code } = await capture(() => scoreCorpus(scoreArgv(defaultRun(corpus, outDir))));
    expect(code).toBe(0);

    const rows = readRows(outDir);
    expect(rows.map((row) => row.key)).toEqual(readCorpusRows(corpus).map((row) => row.key));
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        "key",
        "set",
        "sessionId",
        "file",
        "index",
        "verdict",
        "answers",
        "reason",
        "model",
        "attempts",
        "latencyMs",
        "usage",
        "cached",
      ].sort(),
    );
    expect(rows[0]).toMatchObject({
      set: "dev",
      sessionId: "sess-alpha",
      file: "sessions/1-source-artifacts/alpha.jsonl",
      index: 1,
      verdict: "no_lesson",
      cached: false,
      model: MODEL,
    });
    expect(rows[3]).toMatchObject({ set: "heldout", sessionId: "sess-beta", index: 1 });

    const table = fs.readFileSync(path.join(outDir, "scores-table.md"), "utf-8").split("\n");
    expect(table[0]).toBe("| session | # | verdict | correction | preference | steering | confusion | user reply |");
    expect(table[1]).toBe("|---|---|---|---|---|---|---|---|");
    expect(table[2]).toMatch(/^\| alpha\.jsonl \| 1 \| no_lesson \| 0\.01 \| 0\.02 \| 0\.00 \| 0\.05 \|/);
    expect(table.some((line) => line.startsWith("| beta.jsonl | 1 |"))).toBe(true);

    const summary = readSummary(outDir);
    expect(summary).toMatchObject({
      runType: "smoke",
      corpus,
      trios: 6,
      set: "all",
      limits: { maxRequests: 50, maxRunMs: 600000, source: "user-override" },
      stop: "completed",
      requests: 6,
      policyHash: HASH,
      concurrency: 4,
      cached: 0,
      confirmed: true,
      corpusFreeze: sha256File(path.join(corpus, "freeze.json")),
      verdicts: { no_lesson: 6 },
      modelsReturned: [MODEL],
      usage: { inputTokens: 72, outputTokens: 18 },
    });
    expect(summary).not.toHaveProperty("session");
    expect(summary.latencyMs).toMatchObject({ mean: expect.any(Number), max: expect.any(Number) });
  });

  it("scores only the requested set", async () => {
    const corpus = await freezeSource("set-select", seedSplitting("sess-alpha", "sess-beta"), {
      "alpha.jsonl": trioRecords(sessionHeader("sess-alpha"), 3),
      "beta.jsonl": trioRecords(sessionHeader("sess-beta"), 3),
    });
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(async () => scoredResponse());

    const devOut = path.join(TEST_TMP, "score-dev");
    const dev = await capture(() => scoreCorpus(scoreArgv({ ...defaultRun(corpus, devOut), set: "dev" })));

    expect(dev.code).toBe(0);
    expect(dev.out).toContain(`Corpus: ${corpus} · set dev: 3 trios (0 cached, 3 to score)`);
    const devRows = readRows(devOut);
    expect(devRows).toHaveLength(3);
    expect(new Set(devRows.map((row) => row.set))).toEqual(new Set(["dev"]));
    expect(new Set(devRows.map((row) => row.sessionId))).toEqual(new Set(["sess-alpha"]));
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // The second run scores only the held-out sessions: the dev trios come from the cache.
    const heldOut = path.join(TEST_TMP, "score-heldout");
    const held = await capture(() => scoreCorpus(scoreArgv({ ...defaultRun(corpus, heldOut), set: "heldout" })));

    expect(held.code).toBe(0);
    expect(held.out).toContain(`Corpus: ${corpus} · set heldout: 3 trios (0 cached, 3 to score)`);
    const heldRows = readRows(heldOut);
    expect(heldRows).toHaveLength(3);
    expect(new Set(heldRows.map((row) => row.set))).toEqual(new Set(["heldout"]));
    expect(new Set(heldRows.map((row) => row.sessionId))).toEqual(new Set(["sess-beta"]));
    expect(fetchMock).toHaveBeenCalledTimes(6);

    // The whole corpus now: nothing left to score, so no further request.
    const allOut = path.join(TEST_TMP, "score-all");
    const all = await capture(() => scoreCorpus(scoreArgv({ ...defaultRun(corpus, allOut), set: "all" })));

    expect(all.code).toBe(0);
    expect(all.out).toContain(`Corpus: ${corpus} · set all: 6 trios (6 cached, 0 to score)`);
    const allRows = readRows(allOut);
    expect(allRows).toHaveLength(6);
    expect(allRows.filter((row) => row.cached)).toHaveLength(6);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("completes a set that selects no trio at all", async () => {
    const corpus = await freezeSource("empty-set", seedLanding(["sess-alpha", "sess-beta"], "heldout", "held"), {
      "alpha.jsonl": trioRecords(sessionHeader("sess-alpha"), 3),
      "beta.jsonl": trioRecords(sessionHeader("sess-beta"), 3),
    });
    const outDir = path.join(TEST_TMP, "score-out");
    process.env.TYPESAFE_API_KEY = KEY;

    const { code, out } = await capture(() =>
      scoreCorpus(scoreArgv({ ...defaultRun(corpus, outDir), set: "dev", concurrency: null })),
    );

    expect(code).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    // Without --concurrency the block still reports the default of four at once.
    expect(out).toContain(`Jev model: ${MODEL} · policy ${HASH} · 4 at once`);
    expect(out).toContain(`Corpus: ${corpus} · set dev: 0 trios (0 cached, 0 to score)`);
    expect(out).toContain("Scored 0 · cached 0 · fallbacks 0 · not run 0 · requests 0 · stop: completed");
    expect(readRows(outDir)).toHaveLength(0);
    const summary = readSummary(outDir);
    expect(summary).toMatchObject({ trios: 0, requests: 0, stop: "completed" });
    expect(summary.verdicts).toEqual({});
  });
});

describe("stops", () => {
  it("declines at the request ceiling, records the running trios, and exits 3", async () => {
    const corpus = await freezeSource("limit", "seed", {
      "alpha.jsonl": trioRecords(sessionHeader("sess-alpha"), 6),
    });
    const outDir = path.join(TEST_TMP, "score-out");
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(async () => scoredResponse());

    const { code } = await capture(() => scoreCorpus(scoreArgv({ ...defaultRun(corpus, outDir), requests: "1" })));

    expect(code).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = readRows(outDir);
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row.verdict === "no_lesson")).toHaveLength(1);
    expect(rows.filter((row) => row.reason === "over_budget")).toHaveLength(3);
    expect(rows.filter((row) => row.verdict === "not_run").map((row) => row.index)).toEqual([5, 6]);
    expect(readSummary(outDir)).toMatchObject({ stop: "request limit", requests: 1 });
  });

  it("stops on the run deadline and exits 3", async () => {
    const corpus = await freezeSource("deadline", "seed", threeTrioFiles());
    const outDir = path.join(TEST_TMP, "score-out");
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return scoredResponse();
    });

    const { code } = await capture(() =>
      scoreCorpus(scoreArgv({ ...defaultRun(corpus, outDir), runMs: "50", concurrency: "1" })),
    );

    expect(code).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = readRows(outDir);
    expect(rows.map((row) => row.verdict)).toEqual(["no_lesson", "not_run", "not_run"]);
    expect(readSummary(outDir)).toMatchObject({ stop: "time limit", requests: 1 });
  });

  it("stops on an authentication error and exits 4", async () => {
    const corpus = await freezeSource("auth", "seed", threeTrioFiles());
    const outDir = path.join(TEST_TMP, "score-out");
    process.env.TYPESAFE_API_KEY = KEY;
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls++;
      return calls === 1 ? scoredResponse() : statusResponse(401);
    });

    const { code, out } = await capture(() =>
      scoreCorpus(scoreArgv({ ...defaultRun(corpus, outDir), concurrency: "1" })),
    );

    expect(code).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readRows(outDir).map((row) => row.verdict)).toEqual(["no_lesson", "fallback", "not_run"]);
    expect(readRows(outDir)[1].reason).toBe("http_401");
    expect(out).toContain("Scored 1 · cached 0 · fallbacks 1 · not run 1 · requests 2 · stop: auth error");
    expect(readSummary(outDir)).toMatchObject({ stop: "auth error", requests: 2 });
  });

  it("stops after three failed requests in a row and exits 4", async () => {
    const corpus = await freezeSource("streak", "seed", {
      "alpha.jsonl": trioRecords(sessionHeader("sess-alpha"), 6),
    });
    const outDir = path.join(TEST_TMP, "score-out");
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(async () => statusResponse(500));

    const { code, out } = await capture(() =>
      scoreCorpus(scoreArgv({ ...defaultRun(corpus, outDir), concurrency: "1" })),
    );

    expect(code).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const rows = readRows(outDir);
    expect(rows.map((row) => row.verdict)).toEqual([
      "fallback",
      "fallback",
      "fallback",
      "not_run",
      "not_run",
      "not_run",
    ]);
    expect(rows.slice(0, 3).every((row) => row.reason === "http_500")).toBe(true);
    expect(out).toContain(
      "Scored 0 · cached 0 · fallbacks 3 · not run 3 · requests 3 · stop: three failed requests in a row",
    );
    expect(readSummary(outDir)).toMatchObject({ stop: "three failed requests in a row", requests: 3 });
  });
});

describe("concurrency", () => {
  it("keeps at most N requests in flight and rows in corpus order when responses finish out of order", async () => {
    const corpus = await freezeSource("pool", "seed", {
      "alpha.jsonl": trioRecords(sessionHeader("sess-alpha"), 6),
    });
    const outDir = path.join(TEST_TMP, "score-out");
    process.env.TYPESAFE_API_KEY = KEY;
    let pending = 0;
    let maxPending = 0;
    let call = 0;
    const delays = [80, 10, 10, 10, 10, 10];
    fetchMock.mockImplementation(async () => {
      const index = call++;
      pending++;
      maxPending = Math.max(maxPending, pending);
      await new Promise((resolve) => setTimeout(resolve, delays[index]));
      pending--;
      return scoredResponse();
    });

    const { code } = await capture(() => scoreCorpus(scoreArgv({ ...defaultRun(corpus, outDir), concurrency: "3" })));

    expect(code).toBe(0);
    expect(maxPending).toBe(3);
    const rows = readRows(outDir);
    expect(rows.map((row) => row.key)).toEqual(readCorpusRows(corpus).map((row) => row.key));
    expect(rows[0].latencyMs).toBeGreaterThan(rows[1].latencyMs);
    expect(readSummary(outDir)).toMatchObject({ requests: 6, stop: "completed" });
  });
});

describe("cache", () => {
  it("serves every cached trio without a request on a rerun", async () => {
    const corpus = await freezeSource("cache-hit", "seed", threeTrioFiles());
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(async () => scoredResponse());
    const firstOut = path.join(TEST_TMP, "score-first");
    const first = await capture(() => scoreCorpus(scoreArgv(defaultRun(corpus, firstOut))));
    expect(first.code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(readCacheLines(corpus)).toHaveLength(3);
    fetchMock.mockClear();

    const outDir = path.join(TEST_TMP, "score-out");
    const { code, out } = await capture(() => scoreCorpus(scoreArgv(defaultRun(corpus, outDir))));

    expect(code).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toContain(`Corpus: ${corpus} · set all: 3 trios (3 cached, 0 to score)`);
    expect(out).toContain("Scored 3 · cached 3 · fallbacks 0 · not run 0 · requests 0 · stop: completed");
    expect(readRows(outDir).every((row) => row.cached)).toBe(true);
    expect(readSummary(outDir)).toMatchObject({ cached: 3, requests: 0, stop: "completed" });
  });

  it("keeps failed requests out of the cache so a rerun tries them again", async () => {
    const corpus = await freezeSource("cache-failure", "seed", {
      "alpha.jsonl": trioRecords(sessionHeader("sess-alpha"), 1),
    });
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(async () => statusResponse(500));
    const outDir = path.join(TEST_TMP, "score-first");

    const { code } = await capture(() => scoreCorpus(scoreArgv({ ...defaultRun(corpus, outDir), concurrency: "1" })));

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readRows(outDir)).toHaveLength(1);
    expect(readRows(outDir)[0]).toMatchObject({ verdict: "fallback", reason: "http_500" });
    expect(readCacheLines(corpus)).toHaveLength(0);
  });

  it("caches an oversized state and serves it from the cache afterwards", async () => {
    const corpus = await freezeSource("cache-oversized", "seed", {
      "bulky.jsonl": [
        sessionHeader("sess-bulky"),
        assistant("the plan the agent laid out"),
        user("x".repeat(40 * 1024)),
        assistant("the agent's reply"),
      ],
    });
    const outDir = path.join(TEST_TMP, "score-first");
    process.env.TYPESAFE_API_KEY = KEY;

    const first = await capture(() => scoreCorpus(scoreArgv(defaultRun(corpus, outDir))));

    expect(first.code).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readRows(outDir)).toEqual([
      expect.objectContaining({ verdict: "fallback", reason: "oversized_state", attempts: 0, cached: false }),
    ]);
    expect(readCacheLines(corpus)).toEqual([
      expect.objectContaining({ key: readCorpusRows(corpus)[0].key, verdict: "fallback", reason: "oversized_state" }),
    ]);

    const secondOut = path.join(TEST_TMP, "score-second");
    const second = await capture(() => scoreCorpus(scoreArgv(defaultRun(corpus, secondOut))));

    expect(second.code).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readRows(secondOut)[0]).toMatchObject({ reason: "oversized_state", cached: true });
    expect(second.out).toContain("(1 cached, 0 to score)");
  });
});

describe("credential hygiene", () => {
  it("keeps the key out of every artifact", async () => {
    const corpus = await freezeSource("hygiene", "seed", threeTrioFiles());
    const outDir = path.join(TEST_TMP, "score-out");
    process.env.TYPESAFE_API_KEY = KEY;
    fetchMock.mockImplementation(async () => scoredResponse());

    const { code } = await capture(() => scoreCorpus(scoreArgv(defaultRun(corpus, outDir))));
    expect(code).toBe(0);

    const artifacts = [
      fs.readFileSync(path.join(outDir, "scores.jsonl"), "utf-8"),
      fs.readFileSync(path.join(outDir, "summary.json"), "utf-8"),
      fs.readFileSync(path.join(outDir, "scores-table.md"), "utf-8"),
      fs.readFileSync(path.join(corpus, "cache", `gate-${HASH}.jsonl`), "utf-8"),
    ];
    for (const artifact of artifacts) expect(artifact).not.toContain(KEY);
  });
});

describe("reply codes question set", () => {
  const SET_NAME = "reply-codes-test";
  const CODE_IDS = ["approval", "correction", "task_step"];

  /**
   * The counting fixture: two source folders, three sessions, eight trios.
   * The answers the mock returns per reply, and the counts derived from them:
   *
   * | folder | session | trios | approval | correction | task_step |
   * |---|---|---|---|---|---|
   * | source-qa | alpha.jsonl | 3 | 1 | 1 | 1 |
   * | source-qa | beta.jsonl | 2 | 1 | 1 | 1 |
   * | source-qb | gamma.jsonl | 3 | 2 | 1 | 1 |
   * | source-qa | all | 5 | 2 | 2 | 2 |
   * | source-qb | all | 3 | 2 | 1 | 1 |
   * | all | all | 8 | 4 | 3 | 3 |
   *
   * gamma one (approval 0.50) and gamma two (correction 0.40) pin the
   * threshold: an answer ≥ 0.50 counts as a yes, one below it does not.
   */
  const FIXTURE_ANSWERS: Record<string, Record<string, number>> = {
    "alpha one": { approval: 0.9, correction: 0.1, task_step: 0.1 },
    "alpha two": { approval: 0.1, correction: 0.9, task_step: 0.9 },
    "alpha three": { approval: 0.1, correction: 0.1, task_step: 0.1 },
    "beta one": { approval: 0.9, correction: 0.9, task_step: 0.1 },
    "beta two": { approval: 0.1, correction: 0.1, task_step: 0.9 },
    "gamma one": { approval: 0.5, correction: 0.1, task_step: 0.9 },
    "gamma two": { approval: 0.1, correction: 0.4, task_step: 0.1 },
    "gamma three": { approval: 0.9, correction: 0.5, task_step: 0.1 },
  };

  interface SentRequest {
    model: string;
    questions: Record<string, unknown>;
  }

  function questionEntry(text: string): Record<string, unknown> {
    return {
      type: "noul",
      instructions: `In this exchange between a user and an AI coding agent, ${text}`,
      criteria: { true: "it applies", false: "it does not apply" },
    };
  }

  function validQuestions(): Record<string, unknown> {
    return {
      approval: questionEntry("is the reply an approval?"),
      correction: questionEntry("is the reply a correction?"),
      task_step: questionEntry("is the reply a task step?"),
    };
  }

  function writeSet(fileName: string, content: string): string {
    const target = path.join(TEST_TMP, fileName);
    fs.writeFileSync(target, content, "utf-8");
    return target;
  }

  function writeValidSet(): string {
    return writeSet("set-valid.json", JSON.stringify({ name: SET_NAME, questions: validQuestions() }));
  }

  /** The set's cache hash, computed the way the spec defines it. */
  function expectedSetHash(setFile: string): string {
    const parsed = JSON.parse(fs.readFileSync(setFile, "utf-8")) as {
      name: string;
      questions: Record<string, unknown>;
    };
    return sha256Text(JSON.stringify({ model: MODEL, name: parsed.name, questions: parsed.questions })).slice(0, 12);
  }

  function replyRecords(sessionId: string, replies: string[]): Record<string, unknown>[] {
    const records: Record<string, unknown>[] = [sessionHeader(sessionId), assistant("the plan the agent laid out")];
    for (const reply of replies) {
      records.push(user(reply));
      records.push(assistant("the agent's reply"));
    }
    return records;
  }

  /** Two source folders frozen into one corpus: source-qa (alpha, beta) and source-qb (gamma). */
  async function freezeCountingCorpus(seed: string): Promise<string> {
    const sourceA = path.join(TEST_TMP, "source-qa");
    writeSession(sourceA, "alpha.jsonl", replyRecords("sess-a", ["alpha one", "alpha two", "alpha three"]));
    writeSession(sourceA, "beta.jsonl", replyRecords("sess-b", ["beta one", "beta two"]));
    const sourceB = path.join(TEST_TMP, "source-qb");
    writeSession(sourceB, "gamma.jsonl", replyRecords("sess-c", ["gamma one", "gamma two", "gamma three"]));
    const corpusDir = path.join(TEST_TMP, "corpus-counting");
    const result = await capture(() =>
      freezeCorpus(["--source", sourceA, "--source", sourceB, "--output", corpusDir, "--seed", seed]),
    );
    expect(result.code).toBe(0);
    return corpusDir;
  }

  /** score's argv with --questions; the = form keeps parseArgv from swallowing the next switch. */
  function questionArgv(run: ScoreRun, setFile: string): string[] {
    return [...scoreArgv(run), `--questions=${setFile}`];
  }

  /** A mocked Jev endpoint whose answers come from FIXTURE_ANSWERS, keyed by the reply in the request. */
  function mockByReply(): { sent: SentRequest[] } {
    const sent: SentRequest[] = [];
    globalThis.fetch = vi.fn(async (_input: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        model: string;
        questions: Record<string, unknown>;
        state: { userFeedback: string };
      };
      const fixture = FIXTURE_ANSWERS[body.state.userFeedback];
      if (fixture === undefined) throw new Error(`unexpected reply in test request: ${body.state.userFeedback}`);
      const answers: Record<string, { type: string; noul: number }> = {};
      for (const [id, noul] of Object.entries(fixture)) answers[id] = { type: "noul", noul };
      sent.push({ model: body.model, questions: body.questions });
      return new Response(JSON.stringify({ model: MODEL, answers, usage: { input_tokens: 12, output_tokens: 3 } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    return { sent };
  }

  /** A mocked Jev endpoint answering every question id with a fixed noul. */
  function mockById(values: Record<string, number>): { sent: SentRequest[] } {
    const sent: SentRequest[] = [];
    globalThis.fetch = vi.fn(async (_input: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        model: string;
        questions: Record<string, unknown>;
        state: { userFeedback: string };
      };
      sent.push({ model: body.model, questions: body.questions });
      const answers: Record<string, { type: string; noul: number }> = {};
      for (const id of Object.keys(body.questions)) {
        answers[id] = { type: "noul", noul: values[id] ?? 0.1 };
      }
      return new Response(JSON.stringify({ model: MODEL, answers, usage: { input_tokens: 12, output_tokens: 3 } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    return { sent };
  }

  it("sends exactly the file's questions, caches under the set's hash, and writes codes.md", async () => {
    const corpus = await freezeCountingCorpus("seed-counting");
    const setFile = writeValidSet();
    const hash = expectedSetHash(setFile);
    process.env.TYPESAFE_API_KEY = KEY;
    const { sent } = mockByReply();
    const outDir = path.join(TEST_TMP, "score-out");

    const { code, out, err } = await capture(() => scoreCorpus(questionArgv(defaultRun(corpus, outDir), setFile)));

    expect(code).toBe(0);
    expect(err).toBe("");
    // The question-set model line replaces the gate's policy line in the run block.
    expect(out.split("\n")[4]).toBe(`Jev model: ${MODEL} · questions ${SET_NAME} (${hash}) · 4 at once`);
    expect(out).not.toContain(`policy ${HASH}`);

    // Criterion 2: the wire carries exactly the file's questions.
    expect(sent).toHaveLength(8);
    for (const request of sent) {
      expect(request.model).toBe(MODEL);
      expect(request.questions).toEqual(validQuestions());
    }

    // Criterion 2: the cache name uses the set's hash, never the gate's.
    const questionCache = path.join(corpus, "cache", `questions-${hash}.jsonl`);
    const cacheLines = fs
      .readFileSync(questionCache, "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(cacheLines).toHaveLength(8);
    expect(fs.existsSync(path.join(corpus, "cache", `gate-${HASH}.jsonl`))).toBe(false);

    // The gate's results table is not written; codes.md is, and the summary records the set.
    expect(fs.existsSync(path.join(outDir, "scores-table.md"))).toBe(false);
    expect(fs.existsSync(path.join(outDir, "codes.md"))).toBe(true);
    const rows = readRows(outDir);
    expect(rows.map((row) => row.verdict)).toEqual(Array.from({ length: 8 }, () => "scored"));
    expect(Object.keys(rows[0].answers ?? {})).toEqual(CODE_IDS);
    const summary = readSummary(outDir);
    expect(summary.policyHash).toBe(HASH);
    expect(summary.questionSet).toEqual({ name: SET_NAME, hash, file: setFile });
  });

  it("codes.md counts match the hand-computed fixture", async () => {
    const corpus = await freezeCountingCorpus("seed-counting");
    const setFile = writeValidSet();
    process.env.TYPESAFE_API_KEY = KEY;
    mockByReply();
    const outDir = path.join(TEST_TMP, "score-out");

    const { code } = await capture(() => scoreCorpus(questionArgv(defaultRun(corpus, outDir), setFile)));

    expect(code).toBe(0);
    const codes = fs.readFileSync(path.join(outDir, "codes.md"), "utf-8").split("\n");
    expect(codes[0]).toBe(`# Reply codes — ${SET_NAME}, set all, 8 scored trios (an answer ≥ 0.50 counts as yes)`);
    expect(codes[1]).toBe("");
    expect(codes[2]).toBe("| folder | session | trios | approval | correction | task_step |");
    expect(codes[3]).toBe("|---|---|---|---|---|---|");
    expect(codes.slice(4, 10)).toEqual([
      "| source-qa | alpha.jsonl | 3 | 1 | 1 | 1 |",
      "| source-qa | beta.jsonl | 2 | 1 | 1 | 1 |",
      "| source-qb | gamma.jsonl | 3 | 2 | 1 | 1 |",
      "| source-qa | all | 5 | 2 | 2 | 2 |",
      "| source-qb | all | 3 | 2 | 1 | 1 |",
      "| all | all | 8 | 4 | 3 | 3 |",
    ]);
    expect(codes.slice(11)).toEqual([
      "## approval: top replies",
      "- 0.90 · alpha.jsonl trio 1 · alpha one",
      "- 0.90 · beta.jsonl trio 1 · beta one",
      "- 0.90 · gamma.jsonl trio 3 · gamma three",
      "- 0.50 · gamma.jsonl trio 1 · gamma one",
      "",
      "## correction: top replies",
      "- 0.90 · alpha.jsonl trio 2 · alpha two",
      "- 0.90 · beta.jsonl trio 1 · beta one",
      "- 0.50 · gamma.jsonl trio 3 · gamma three",
      "",
      "## task_step: top replies",
      "- 0.90 · alpha.jsonl trio 2 · alpha two",
      "- 0.90 · beta.jsonl trio 2 · beta two",
      "- 0.90 · gamma.jsonl trio 1 · gamma one",
      "",
    ]);
  });

  it("refuses an invalid question set before any request", async () => {
    // The corpus path does not exist: the question-set refusal has to come first.
    const corpus = path.join(TEST_TMP, "corpus-not-touched");
    const valid = { name: SET_NAME, questions: validQuestions() };
    const nineQuestions: Record<string, unknown> = {};
    for (let i = 1; i <= 9; i++) nineQuestions[`q${i}`] = questionEntry("a question");
    const noInstructions = validQuestions() as Record<string, Record<string, unknown>>;
    noInstructions.approval = { type: "noul", criteria: { true: "yes", false: "no" } };
    const invalid: Array<{ label: string; content: string }> = [
      { label: "non-JSON content", content: "{not json" },
      { label: "a top-level array", content: "[]" },
      { label: "an unknown top-level key", content: JSON.stringify({ ...valid, extra: true }) },
      { label: "a missing name", content: JSON.stringify({ questions: validQuestions() }) },
      { label: "an empty name", content: JSON.stringify({ name: "", questions: validQuestions() }) },
      { label: "no questions", content: JSON.stringify({ name: SET_NAME, questions: {} }) },
      { label: "nine questions", content: JSON.stringify({ name: SET_NAME, questions: nineQuestions }) },
      {
        label: "a question id outside the id pattern",
        content: JSON.stringify({ name: SET_NAME, questions: { ...validQuestions(), Approval: questionEntry("x") } }),
      },
      {
        label: "a question with an unknown key",
        content: JSON.stringify({
          name: SET_NAME,
          questions: { ...validQuestions(), approval: { ...questionEntry("x"), extra: true } },
        }),
      },
      {
        label: "a question without instructions",
        content: JSON.stringify({ name: SET_NAME, questions: noInstructions }),
      },
      {
        label: "a criteria object with an unknown key",
        content: JSON.stringify({
          name: SET_NAME,
          questions: {
            ...validQuestions(),
            approval: { type: "noul", instructions: "x", criteria: { true: "y", false: "n", maybe: "m" } },
          },
        }),
      },
      {
        label: "a question whose type is not noul",
        content: JSON.stringify({
          name: SET_NAME,
          questions: { ...validQuestions(), approval: { ...questionEntry("x"), type: "prob" } },
        }),
      },
    ];

    const cases: Array<{ label: string; file: string }> = [
      { label: "a missing file", file: path.join(TEST_TMP, "no-such-set.json") },
    ];
    for (const [index, item] of invalid.entries()) {
      cases.push({ label: item.label, file: writeSet(`invalid-${index}.json`, item.content) });
    }

    for (const [index, item] of cases.entries()) {
      const outDir = path.join(TEST_TMP, `refusal-${index}`);
      const { code, out, err } = await capture(() =>
        scoreCorpus(questionArgv({ ...defaultRun(corpus, outDir) }, item.file)),
      );
      expect(code, item.label).toBe(2);
      expect(err, item.label).toBe(`${strings.scoreBadQuestions(item.file)}\n`);
      expect(out, item.label).not.toContain("Corpus:");
      expect(fs.existsSync(outDir), item.label).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves the question cache on a rerun and rebuilds codes.md without a request", async () => {
    const corpus = await freezeCountingCorpus("seed-counting");
    const setFile = writeValidSet();
    const hash = expectedSetHash(setFile);
    process.env.TYPESAFE_API_KEY = KEY;
    const { sent } = mockByReply();

    const firstOut = path.join(TEST_TMP, "score-first");
    const first = await capture(() => scoreCorpus(questionArgv(defaultRun(corpus, firstOut), setFile)));
    expect(first.code).toBe(0);
    expect(sent).toHaveLength(8);
    expect(fs.existsSync(path.join(corpus, "cache", `questions-${hash}.jsonl`))).toBe(true);
    const firstCodes = fs.readFileSync(path.join(firstOut, "codes.md"), "utf-8");

    const outDir = path.join(TEST_TMP, "score-out");
    const second = await capture(() => scoreCorpus(questionArgv(defaultRun(corpus, outDir), setFile)));

    expect(second.code).toBe(0);
    expect(sent).toHaveLength(8);
    expect(second.out).toContain("(8 cached, 0 to score)");
    expect(second.out).toContain("Scored 8 · cached 8 · fallbacks 0 · not run 0 · requests 0 · stop: completed");
    const rows = readRows(outDir);
    expect(rows.every((row) => row.cached && row.verdict === "scored")).toBe(true);
    expect(fs.readFileSync(path.join(outDir, "codes.md"), "utf-8")).toBe(firstCodes);
  });

  it("resets the failure streak when the run scores again", async () => {
    const corpus = await freezeSource("streak-questions", "seed", {
      "alpha.jsonl": trioRecords(sessionHeader("sess-alpha"), 8),
    });
    const setFile = writeValidSet();
    process.env.TYPESAFE_API_KEY = KEY;
    const answers = {
      approval: { type: "noul", noul: 0.1 },
      correction: { type: "noul", noul: 0.1 },
      task_step: { type: "noul", noul: 0.1 },
    };
    let call = 0;
    const mock = vi.fn(async () => {
      call++;
      if (call % 2 === 0) return statusResponse(500);
      return new Response(JSON.stringify({ model: MODEL, answers, usage: { input_tokens: 12, output_tokens: 3 } }), {
        status: 200,
      });
    });
    globalThis.fetch = mock as unknown as typeof fetch;
    const outDir = path.join(TEST_TMP, "score-out");

    const { code } = await capture(() =>
      scoreCorpus(questionArgv({ ...defaultRun(corpus, outDir), concurrency: "1" }, setFile)),
    );

    // Failures on even calls are never three in a row, so nothing stops the run.
    expect(code).toBe(0);
    expect(mock).toHaveBeenCalledTimes(8);
    expect(readRows(outDir).map((row) => row.verdict)).toEqual([
      "scored",
      "fallback",
      "scored",
      "fallback",
      "scored",
      "fallback",
      "scored",
      "fallback",
    ]);
    expect(readSummary(outDir)).toMatchObject({ stop: "completed", requests: 8 });
  });

  it("scores with the checked-in reply-codes set", async () => {
    const corpus = await freezeSource("reply-codes-file", "seed", threeTrioFiles());
    const setFile = path.join(ROOT, "scripts", "compass", "questions", "reply-codes-v1.json");
    process.env.TYPESAFE_API_KEY = KEY;
    const { sent } = mockById({});
    const outDir = path.join(TEST_TMP, "score-out");

    const { code } = await capture(() => scoreCorpus(questionArgv(defaultRun(corpus, outDir), setFile)));

    expect(code).toBe(0);
    expect(sent).toHaveLength(3);
    expect(Object.keys(sent[0].questions)).toEqual(["approval", "correction", "hold_back", "task_step", "chatter"]);
    const checkedIn = JSON.parse(fs.readFileSync(setFile, "utf-8")) as { questions: Record<string, unknown> };
    expect(sent[0].questions).toEqual(checkedIn.questions);
    expect(fs.readFileSync(path.join(outDir, "codes.md"), "utf-8")).toContain("# Reply codes — reply-codes-v1");
  });

  it("lists at most ten top replies under one code", async () => {
    const replies: string[] = [];
    for (let i = 1; i <= 12; i++) replies.push(`cap reply ${i}`);
    const corpus = await freezeSource("cap", "seed", { "alpha.jsonl": replyRecords("sess-cap", replies) });
    const setFile = writeValidSet();
    process.env.TYPESAFE_API_KEY = KEY;
    mockById({ approval: 0.9 });
    const outDir = path.join(TEST_TMP, "score-out");

    const { code } = await capture(() => scoreCorpus(questionArgv(defaultRun(corpus, outDir), setFile)));

    expect(code).toBe(0);
    const codes = fs.readFileSync(path.join(outDir, "codes.md"), "utf-8").split("\n");
    const heading = codes.indexOf("## approval: top replies");
    expect(heading).toBeGreaterThan(-1);
    const approvalLines = codes.slice(heading + 1).filter((line) => line.startsWith("- "));
    expect(approvalLines).toHaveLength(10);
    expect(approvalLines[0]).toBe("- 0.90 · alpha.jsonl trio 1 · cap reply 1");
    expect(approvalLines[9]).toBe("- 0.90 · alpha.jsonl trio 10 · cap reply 10");
    // The other two codes answer 0.10 everywhere, so they list no replies.
    expect(codes.join("\n")).not.toContain("## correction: top replies\n- ");
  });

  it("caches an oversized state under the set's hash and keeps it out of the counts", async () => {
    const corpus = await freezeSource("oversized-questions", "seed", {
      "big.jsonl": [
        sessionHeader("sess-big"),
        assistant("the plan the agent laid out"),
        user("x".repeat(40 * 1024)),
        assistant("the agent's reply"),
      ],
    });
    const setFile = writeValidSet();
    const hash = expectedSetHash(setFile);
    process.env.TYPESAFE_API_KEY = KEY;
    const { sent } = mockByReply();
    const outDir = path.join(TEST_TMP, "score-out");

    const first = await capture(() => scoreCorpus(questionArgv(defaultRun(corpus, outDir), setFile)));

    expect(first.code).toBe(0);
    expect(sent).toHaveLength(0);
    expect(readRows(outDir)[0]).toMatchObject({ verdict: "fallback", reason: "oversized_state", cached: false });
    const cacheLines = fs
      .readFileSync(path.join(corpus, "cache", `questions-${hash}.jsonl`), "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(cacheLines).toHaveLength(1);

    const secondOut = path.join(TEST_TMP, "score-second");
    const second = await capture(() => scoreCorpus(questionArgv(defaultRun(corpus, secondOut), setFile)));

    expect(second.code).toBe(0);
    expect(sent).toHaveLength(0);
    expect(readRows(secondOut)[0]).toMatchObject({ reason: "oversized_state", cached: true });
    const codes = fs.readFileSync(path.join(secondOut, "codes.md"), "utf-8").split("\n");
    expect(codes[0]).toContain("0 scored trios");
    expect(codes).toContain("| source-oversized-questions | big.jsonl | 0 | 0 | 0 | 0 |");
  });
});
