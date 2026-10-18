// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Gate-policy evaluation: the policy counts match a hand-computed fixture
 * (fallbacks and unstarted trios are never rejected, the miss bound is the
 * rule of three over the lesson trios), the sweep refuses the held-out set and
 * writes its table, every refusal prints its approved message, and the commands
 * write only their output. fetch is mocked and rejects by default, and every
 * corpus is frozen by the corpus command in a temp folder — nothing reads ~/.pi.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main as freezeCorpus } from "../../scripts/compass/corpus.js";
import { main as evaluateMain } from "../../scripts/compass/evaluate.js";
import { strings } from "../../scripts/compass/strings.js";
import type { CorpusTrio } from "../../scripts/compass/types.js";
import { sha256Text } from "../../scripts/compass/util.js";

const ROOT = process.cwd();
// Unique per test-file run so overlapping suite runs never share a directory.
const TEST_TMP_ROOT = path.join(ROOT, "outputs", "test-tmp");
fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
const TEST_TMP = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "evaluate-"));

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

function writeJsonl(file: string, rows: Record<string, unknown>[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf-8");
}

/** The split as the task defines it, restated here to check runs against the spec. */
function setFor(seed: string, sessionId: string): "dev" | "heldout" {
  return parseInt(sha256Text(`${seed}\n${sessionId}`).slice(0, 8), 16) % 2 === 0 ? "dev" : "heldout";
}

/** A seed that lands every given session id in the wanted set. */
function seedLanding(sessionIds: string[], wanted: "dev" | "heldout", prefix: string): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const seed = `${prefix}-${attempt}`;
    if (sessionIds.every((id) => setFor(seed, id) === wanted)) return seed;
  }
  throw new Error(`no seed lands ${sessionIds.join(", ")} in ${wanted}`);
}

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

function readCorpusRows(corpusDir: string): CorpusTrio[] {
  return fs
    .readFileSync(path.join(corpusDir, "trios.jsonl"), "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CorpusTrio);
}

function treeFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else files.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return files;
}

function scoredRow(key: string, answers: Record<string, number>): Record<string, unknown> {
  return {
    key,
    verdict: "maybe_lesson",
    answers,
    reason: null,
    model: "jev-1.13.0",
    attempts: 1,
    latencyMs: 5,
    usage: { inputTokens: 12, outputTokens: 3 },
    cached: false,
  };
}

function fallbackRow(key: string, reason: string): Record<string, unknown> {
  return {
    key,
    verdict: "fallback",
    answers: null,
    reason,
    model: null,
    attempts: 1,
    latencyMs: 5,
    usage: null,
    cached: false,
  };
}

function notRunRow(key: string): Record<string, unknown> {
  return {
    key,
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

function extractRow(
  key: string,
  outcome: string,
  notes: string[],
  attempts: number,
  usage: { input: number; output: number } | null,
): Record<string, unknown> {
  return { key, outcome, notes, attempts, usage, latencyMs: 10, cached: false };
}

function labelRow(
  key: string,
  label: string,
  correction: boolean,
  source: string,
  note: string,
): Record<string, unknown> {
  return { key, label, correction, source, note };
}

interface Fixture {
  corpus: string;
  keys: string[];
  scores: string;
  extract: string;
  labels: string;
  policy: string;
}

/**
 * The hand-computed fixture: six dev trios where four are scored (two under
 * every threshold at 0.5), one is a fallback, and one was never scored.
 */
async function devFixture(name: string): Promise<Fixture> {
  const sessionId = `sess-${name}`;
  const seed = seedLanding([sessionId], "dev", name);
  const source = path.join(TEST_TMP, `source-${name}`);
  writeSession(source, "alpha.jsonl", trioRecords(sessionHeader(sessionId), 6));
  const corpus = path.join(TEST_TMP, `corpus-${name}`);
  const frozen = await capture(() => freezeCorpus(["--source", source, "--output", corpus, "--seed", seed]));
  expect(frozen.code).toBe(0);
  const keys = readCorpusRows(corpus).map((row) => row.key);

  const scores = path.join(TEST_TMP, "scores.jsonl");
  const extract = path.join(TEST_TMP, "extract.jsonl");
  const labels = path.join(TEST_TMP, "labels.jsonl");
  writeJsonl(scores, [
    scoredRow(keys[0], { correction: 0.1, preference: 0.1, steering: 0.9, confusion: 0.1 }),
    scoredRow(keys[1], { correction: 0.2, preference: 0.2, steering: 0.2, confusion: 0.2 }),
    scoredRow(keys[2], { correction: 0.9, preference: 0.9, steering: 0.1, confusion: 0.9 }),
    scoredRow(keys[3], { correction: 0.1, preference: 0.1, steering: 0.1, confusion: 0.1 }),
    fallbackRow(keys[4], "http_401"),
    notRunRow(keys[5]),
  ]);
  writeJsonl(extract, [
    extractRow(keys[0], "success", ["rule"], 1, { input: 10, output: 5 }),
    extractRow(keys[1], "success", ["rule", "rule"], 3, { input: 100, output: 50 }),
    extractRow(keys[2], "success", ["rule"], 1, { input: 10, output: 5 }),
    extractRow(keys[3], "failed", [], 2, { input: 30, output: 10 }),
    extractRow(keys[4], "success", ["rule"], 1, { input: 10, output: 5 }),
    extractRow(keys[5], "not_run", [], 0, null),
  ]);
  writeJsonl(labels, [
    labelRow(keys[0], "lesson", false, "cc-draft", ""),
    labelRow(keys[1], "lesson", true, "cc-draft", ""),
    labelRow(keys[2], "lesson", false, "cc-draft", ""),
    labelRow(keys[3], "no_lesson", false, "cc-draft", ""),
    labelRow(keys[4], "no_lesson", true, "cc-draft", ""),
    labelRow(keys[5], "lesson", false, "cc-draft", ""),
  ]);

  const policy = path.join(TEST_TMP, "policy.json");
  fs.writeFileSync(
    policy,
    `${JSON.stringify({
      name: "strict",
      questions: ["correction", "preference", "steering", "confusion"],
      thresholds: { correction: 0.5, preference: 0.5, steering: 0.5, confusion: 0.5 },
    })}\n`,
    "utf-8",
  );
  return { corpus, keys, scores, extract, labels, policy };
}

function policyArgs(fixture: Fixture, output: string, extra: string[]): string[] {
  return [
    "policy",
    "--corpus",
    fixture.corpus,
    "--labels",
    fixture.labels,
    "--scores",
    fixture.scores,
    "--extract",
    fixture.extract,
    "--policy",
    fixture.policy,
    "--output",
    output,
    ...extra,
  ];
}

function sweepArgs(fixture: Fixture, output: string, extra: string[]): string[] {
  return [
    "sweep",
    "--corpus",
    fixture.corpus,
    "--labels",
    fixture.labels,
    "--scores",
    fixture.scores,
    "--extract",
    fixture.extract,
    "--output",
    output,
    ...extra,
  ];
}

const fetchMock = vi.fn((): Promise<Response> => Promise.reject(new Error("network is unavailable in tests")));
const REAL_FETCH = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.reject(new Error("network is unavailable in tests")));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
  fs.mkdirSync(TEST_TMP, { recursive: true });
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  vi.restoreAllMocks();
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
});

describe("policy counts", () => {
  it("match the hand-computed fixture, keep every fallback and unstarted trio, and report the bound", async () => {
    const fixture = await devFixture("counts");
    const output = path.join(TEST_TMP, "out");
    const result = await capture(() => evaluateMain(policyArgs(fixture, output, ["--set", "dev"])));

    // Scored at 0.5 on all four: trio 1 (steering 0.9) and trio 3 are kept;
    // trios 2 and 4 are rejected. The fallback and the unstarted trio are not.
    // Lesson trios: 1, 2, 3, 6 → rejected among them: trio 2 → kept 3 of 4 (75%).
    // Correction labels: trios 2 and 5 → correctionTrios 2; one miss (trio 2) → bound 1 / 2.
    // Extraction saved: trio 2 (3 attempts, 100/50) + trio 4 (2 attempts, 30/10).
    // Gate cost: four scored trios at 12 in / 3 out.
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      "Policy strict on dev: rejected 2 of 6 · lesson kept 3 of 4 (75%) · correction misses 1 · " +
        "miss bound 1 / 2 · extraction saved 5 requests, 130 in / 60 out tokens · gate cost 48 in / 12 out tokens\n",
    );
    expect(result.err).toBe("");

    const report = JSON.parse(fs.readFileSync(path.join(output, "evaluate.json"), "utf-8")) as Record<string, unknown>;
    expect(report.trios).toBe(6);
    expect(report.scored).toBe(4);
    expect(report.rejected).toBe(2);
    expect(report.rejectedKeys).toEqual([fixture.keys[1], fixture.keys[3]]);
    expect(report.lessonTrios).toBe(4);
    expect(report.lessonKept).toBe(3);
    expect(report.missedLessonKeys).toEqual([fixture.keys[1]]);
    expect(report.correctionTrios).toBe(2);
    expect(report.correctionMisses).toBe(1);
    expect(report.missedCorrectionKeys).toEqual([fixture.keys[1]]);
    expect(report.missBound).toBe("1 / 2");
    expect(report.extractionSaved).toEqual({ requests: 5, inputTokens: 130, outputTokens: 60 });
    expect(report.gateCost).toEqual({ inputTokens: 48, outputTokens: 12 });
  });

  it("report the rule-of-three bound when nothing is missed", async () => {
    const fixture = await devFixture("bound");
    fs.writeFileSync(
      fixture.policy,
      `${JSON.stringify({
        name: "open",
        questions: ["correction", "preference", "steering", "confusion"],
        thresholds: { correction: 0, preference: 0, steering: 0, confusion: 0 },
      })}\n`,
      "utf-8",
    );
    const result = await capture(() => evaluateMain(policyArgs(fixture, path.join(TEST_TMP, "out"), ["--set", "dev"])));
    // Every answer is above zero, so nothing is rejected and nothing is missed.
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      "Policy open on dev: rejected 0 of 6 · lesson kept 4 of 4 (100%) · correction misses 0 · " +
        "miss bound 3 / 2 · extraction saved 0 requests, 0 in / 0 out tokens · gate cost 48 in / 12 out tokens\n",
    );
  });

  it("reject on the listed questions only", async () => {
    const fixture = await devFixture("subset");
    fs.writeFileSync(
      fixture.policy,
      `${JSON.stringify({
        name: "steering-only",
        questions: ["steering"],
        thresholds: { steering: 0.5 },
      })}\n`,
      "utf-8",
    );
    const result = await capture(() => evaluateMain(policyArgs(fixture, path.join(TEST_TMP, "out"), ["--set", "dev"])));
    // Trio 3 (steering 0.1) is rejected here although the all-four rule keeps it,
    // and trios 2 and 4 stay rejected: three rejected, one correction miss.
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      "Policy steering-only on dev: rejected 3 of 6 · lesson kept 2 of 4 (50%) · correction misses 1 · " +
        "miss bound 1 / 2 · extraction saved 6 requests, 140 in / 65 out tokens · gate cost 48 in / 12 out tokens\n",
    );
  });
});

describe("sweep", () => {
  it("refuses the held-out set", async () => {
    const fixture = await devFixture("refuse");
    const result = await capture(() =>
      evaluateMain(sweepArgs(fixture, path.join(TEST_TMP, "out"), ["--set", "heldout"])),
    );
    expect(result.code).toBe(2);
    expect(result.err).toBe("compass evaluate: the threshold sweep runs on dev only\n");
  });

  it("writes one row per rule and threshold with hand-checked counts", async () => {
    const fixture = await devFixture("table");
    const output = path.join(TEST_TMP, "out");
    const result = await capture(() => evaluateMain(sweepArgs(fixture, output, ["--set", "dev"])));
    expect(result.code).toBe(0);

    const table = fs.readFileSync(path.join(output, "sweep.md"), "utf-8").split("\n");
    expect(table[0]).toBe("| rule | threshold | rejected | lesson kept | correction misses |");
    expect(table[1]).toBe("|---|---:|---:|---:|---:|");
    expect(table).toHaveLength(23);
    expect(table[2]).toBe("| all four | 0.05 | 0 | 4 of 4 (100%) | 0 |");
    expect(table[11]).toBe("| all four | 0.50 | 2 | 3 of 4 (75%) | 1 |");
    // Without steering, trio 1 (0.1 on the other three) is rejected as well.
    expect(table[12]).toBe("| without steering | 0.05 | 0 | 4 of 4 (100%) | 0 |");
    expect(table[21]).toBe("| without steering | 0.50 | 3 | 2 of 4 (50%) | 1 |");

    const sweep = JSON.parse(fs.readFileSync(path.join(output, "sweep.json"), "utf-8")) as Record<string, unknown>;
    expect(sweep.thresholds).toEqual([0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5]);
    expect((sweep.rows as Record<string, unknown>[]).length).toBe(20);
    expect((sweep.rows as Record<string, unknown>[])[0]).toEqual({
      rule: "all four",
      threshold: 0.05,
      rejected: 0,
      lessonKept: 4,
      lessonTotal: 4,
      correctionMisses: 0,
    });
  });
});

describe("refusals", () => {
  it("refuse an invalid policy file", async () => {
    const fixture = await devFixture("bad-policy");
    const broken: Record<string, unknown>[] = [
      { name: "", questions: ["steering"], thresholds: { steering: 0.5 } },
      { name: "x", questions: [], thresholds: {} },
      { name: "x", questions: ["answer"], thresholds: { answer: 0.5 } },
      { name: "x", questions: ["steering", "steering"], thresholds: { steering: 0.5 } },
      { name: "x", questions: ["steering"], thresholds: { steering: 0.5, correction: 0.5 } },
      { name: "x", questions: ["steering", "confusion"], thresholds: { steering: 0.5 } },
      { name: "x", questions: ["steering"], thresholds: { steering: 1.5 } },
      { name: "x", questions: ["steering"], thresholds: { steering: "0.5" } },
      { questions: ["steering"], thresholds: { steering: 0.5 } },
    ];
    for (const policy of broken) {
      fs.writeFileSync(fixture.policy, `${JSON.stringify(policy)}\n`, "utf-8");
      const result = await capture(() =>
        evaluateMain(policyArgs(fixture, path.join(TEST_TMP, "out"), ["--set", "dev"])),
      );
      expect(result.code).toBe(2);
      expect(result.err).toBe(`compass evaluate: ${fixture.policy} is not a valid policy\n`);
    }
    fs.writeFileSync(fixture.policy, "not json\n", "utf-8");
    const result = await capture(() => evaluateMain(policyArgs(fixture, path.join(TEST_TMP, "out"), ["--set", "dev"])));
    expect(result.code).toBe(2);
    expect(result.err).toBe(`compass evaluate: ${fixture.policy} is not a valid policy\n`);
  });

  it("refuse a set other than dev or heldout", async () => {
    const fixture = await devFixture("bad-set");
    for (const value of ["all", "nope"]) {
      const result = await capture(() =>
        evaluateMain(policyArgs(fixture, path.join(TEST_TMP, "out"), ["--set", value])),
      );
      expect(result.code).toBe(2);
      expect(result.err).toBe("compass evaluate: --set must be dev or heldout\n");
    }
  });

  it("refuse a missing flag and a missing subcommand", async () => {
    const fixture = await devFixture("missing-flag");
    const result = await capture(() =>
      evaluateMain(["policy", "--corpus", fixture.corpus, "--set", "dev", "--labels", fixture.labels]),
    );
    expect(result.code).toBe(2);
    expect(result.err).toBe("compass evaluate: --scores is required\n");

    const noCommand = await capture(() => evaluateMain([]));
    expect(noCommand.code).toBe(2);
    expect(noCommand.err).toBe("compass evaluate: policy or sweep is required\n");
  });

  it("refuse labels, scores, and extract files that disagree with the set", async () => {
    const fixture = await devFixture("mismatch");
    const foreign = path.join(TEST_TMP, "foreign.jsonl");
    writeJsonl(foreign, [labelRow("cafebabecafebabe", "lesson", false, "user", "")]);
    const result = await capture(() =>
      evaluateMain(
        policyArgs(fixture, path.join(TEST_TMP, "out"), ["--set", "dev"]).map((arg) =>
          arg === fixture.labels ? foreign : arg,
        ),
      ),
    );
    expect(result.code).toBe(2);
    expect(result.err).toBe(`compass evaluate: ${foreign} does not cover set dev of ${fixture.corpus}\n`);

    const missing = path.join(TEST_TMP, "missing.jsonl");
    const short = await capture(() =>
      evaluateMain(
        policyArgs(fixture, path.join(TEST_TMP, "out"), ["--set", "dev"]).map((arg) =>
          arg === fixture.scores ? missing : arg,
        ),
      ),
    );
    expect(short.code).toBe(2);
    expect(short.err).toBe(`compass evaluate: ${missing} does not cover set dev of ${fixture.corpus}\n`);
  });

  it("refuse a corpus that no longer matches its freeze", async () => {
    const fixture = await devFixture("tampered");
    fs.appendFileSync(path.join(fixture.corpus, "trios.jsonl"), "\n", "utf-8");
    const result = await capture(() => evaluateMain(policyArgs(fixture, path.join(TEST_TMP, "out"), ["--set", "dev"])));
    expect(result.code).toBe(2);
    expect(result.err).toBe(`${strings.scoreCorpusChanged(fixture.corpus)}\n`);
  });
});

describe("offline boundaries", () => {
  it("write only the output directory and make no request", async () => {
    const fixture = await devFixture("boundaries");
    const output = path.join(TEST_TMP, "out");
    const before = treeFiles(TEST_TMP);
    const result = await capture(() => evaluateMain(policyArgs(fixture, output, ["--set", "dev"])));
    expect(result.code).toBe(0);
    const after = treeFiles(TEST_TMP);
    expect(after.filter((file) => !before.includes(file))).toEqual([path.join("out", "evaluate.json")]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
