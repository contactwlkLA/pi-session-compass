// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Label sheets and label validation: the review selection is deterministic and
 * complete, the check reports every problem in one run, the sheet renders the
 * approved lines, every refusal prints its approved message, and the commands
 * write only their output. fetch is mocked and rejects by default, and every
 * corpus is frozen by the corpus command in a temp folder — nothing reads ~/.pi.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main as freezeCorpus } from "../../scripts/compass/corpus.js";
import { main as labelsMain } from "../../scripts/compass/labels.js";
import { strings } from "../../scripts/compass/strings.js";
import type { CorpusTrio } from "../../scripts/compass/types.js";
import { sha256File, sha256Text } from "../../scripts/compass/util.js";

const ROOT = process.cwd();
// Unique per test-file run so overlapping suite runs never share a directory.
const TEST_TMP_ROOT = path.join(ROOT, "outputs", "test-tmp");
fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
const TEST_TMP = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "labels-"));

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

/** A frozen one-session corpus in the dev set, with the trio keys beside it. */
async function devCorpus(
  name: string,
  records: Record<string, unknown>[],
): Promise<{ corpus: string; keys: string[] }> {
  const sessionId = `sess-${name}`;
  const seed = seedLanding([sessionId], "dev", name);
  const source = path.join(TEST_TMP, `source-${name}`);
  writeSession(source, "alpha.jsonl", records);
  const corpus = path.join(TEST_TMP, `corpus-${name}`);
  const result = await capture(() => freezeCorpus(["--source", source, "--output", corpus, "--seed", seed]));
  expect(result.code).toBe(0);
  return { corpus, keys: readCorpusRows(corpus).map((row) => row.key) };
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

function exportArgs(corpus: string, output: string, extra: string[]): string[] {
  return ["export", "--corpus", corpus, "--set", "dev", "--output", output, ...extra];
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

describe("review selection", () => {
  it("is deterministic for a seed and includes every no_lesson label and every disagreement", async () => {
    const { corpus, keys } = await devCorpus("review", trioRecords(sessionHeader("sess-review"), 12));
    const scores = path.join(TEST_TMP, "scores.jsonl");
    const extract = path.join(TEST_TMP, "extract.jsonl");
    const labels = path.join(TEST_TMP, "labels.jsonl");
    writeJsonl(
      scores,
      keys.map((key) => scoredRow(key, { correction: 0.2, preference: 0.2, steering: 0.2, confusion: 0.2 })),
    );
    writeJsonl(
      extract,
      keys.map((key, i) => extractRow(key, "success", i === 2 ? [] : ["one rule"], 1, null)),
    );
    // Partial labels are allowed: the unlabeled trios can only come in through the sample.
    writeJsonl(labels, [
      labelRow(keys[0], "no_lesson", false, "cc-draft", ""),
      labelRow(keys[1], "no_lesson", false, "cc-draft", ""),
      labelRow(keys[2], "lesson", false, "cc-draft", ""),
      labelRow(keys[3], "lesson", false, "cc-draft", ""),
      labelRow(keys[4], "lesson", false, "cc-draft", ""),
    ]);

    const output = path.join(TEST_TMP, "sheet.md");
    const argv = exportArgs(corpus, output, [
      "--scores",
      scores,
      "--extract",
      extract,
      "--labels",
      labels,
      "--select",
      "review",
      "--seed",
      "sample-seed",
    ]);
    const first = await capture(() => labelsMain(argv));
    expect(first.code).toBe(0);
    const firstSheet = fs.readFileSync(output, "utf-8");
    const second = await capture(() => labelsMain(argv));
    expect(second.code).toBe(0);
    expect(fs.readFileSync(output, "utf-8")).toBe(firstSheet);

    // Every no_lesson label and every disagreement is in the sheet.
    expect(firstSheet).toContain(keys[0]);
    expect(firstSheet).toContain(keys[1]);
    // Trio 3 is a lesson with no extractor rules — the one disagreement here.
    expect(firstSheet).toContain(keys[2]);
    // The disagreements and no_lesson labels cover 3 trios; the rest is 9, so the
    // seeded sample takes ceil(9 / 10) = 1 more.
    expect(firstSheet.match(/^## /gm)).toHaveLength(4);
  });

  it("takes the sample in the seeded hash order", async () => {
    const { corpus, keys } = await devCorpus("sample", trioRecords(sessionHeader("sess-sample"), 20));
    const scores = path.join(TEST_TMP, "scores.jsonl");
    const extract = path.join(TEST_TMP, "extract.jsonl");
    const labels = path.join(TEST_TMP, "labels.jsonl");
    writeJsonl(
      scores,
      keys.map((key) => scoredRow(key, { correction: 0.2, preference: 0.2, steering: 0.2, confusion: 0.2 })),
    );
    writeJsonl(
      extract,
      keys.map((key) => extractRow(key, "success", ["one rule"], 1, null)),
    );
    writeJsonl(
      labels,
      keys.map((key) => labelRow(key, "lesson", false, "cc-draft", "")),
    );

    const rank = [...keys].sort((a, b) => {
      const hashA = sha256Text(`sample-seed\n${a}`);
      const hashB = sha256Text(`sample-seed\n${b}`);
      return hashA === hashB ? 0 : hashA < hashB ? -1 : 1;
    });
    const expected = rank.slice(0, Math.ceil(keys.length / 10));

    const output = path.join(TEST_TMP, "sheet.md");
    const result = await capture(() =>
      labelsMain(
        exportArgs(corpus, output, [
          "--scores",
          scores,
          "--extract",
          extract,
          "--labels",
          labels,
          "--select",
          "review",
          "--seed",
          "sample-seed",
        ]),
      ),
    );
    expect(result.code).toBe(0);
    const sheet = fs.readFileSync(output, "utf-8");
    expect(sheet.match(/^## /gm)).toHaveLength(expected.length);
    for (const key of expected) expect(sheet).toContain(key);
  });
});

describe("check problems", () => {
  it("reports every problem in one run", async () => {
    const { corpus, keys } = await devCorpus("all-problems", trioRecords(sessionHeader("sess-all-problems"), 3));
    const labels = path.join(TEST_TMP, "labels.jsonl");
    writeJsonl(labels, [
      labelRow(keys[0], "lesson", false, "cc-draft", ""),
      labelRow(keys[0], "lesson", false, "cc-draft", ""),
      labelRow("deadbeefdeadbeef", "lesson", false, "cc-draft", ""),
      { ...labelRow(keys[1], "lesson", false, "cc-draft", ""), correction: "yes" },
    ]);

    const result = await capture(() => labelsMain(["check", "--corpus", corpus, "--set", "dev", "--labels", labels]));
    expect(result.code).toBe(2);
    expect(result.err).toContain(`compass labels: ${keys[0]} appears more than once`);
    expect(result.err).toContain("compass labels: deadbeefdeadbeef is not in set dev");
    expect(result.err).toContain(`compass labels: ${keys[1]} has an invalid field: correction`);
    expect(result.err).toContain(`compass labels: ${keys[2]} is missing`);
    expect(result.out).toBe("");
  });

  it("reports a missing key", async () => {
    const { corpus, keys } = await devCorpus("missing", trioRecords(sessionHeader("sess-missing"), 2));
    const labels = path.join(TEST_TMP, "labels.jsonl");
    writeJsonl(labels, [labelRow(keys[0], "lesson", false, "user", "")]);

    const result = await capture(() => labelsMain(["check", "--corpus", corpus, "--set", "dev", "--labels", labels]));
    expect(result.code).toBe(2);
    expect(result.err).toBe(`${strings.labelsProblem(keys[1], strings.labelsProblemMissing)}\n`);
  });

  it("reports a duplicated key", async () => {
    const { corpus, keys } = await devCorpus("duplicate", trioRecords(sessionHeader("sess-duplicate"), 1));
    const labels = path.join(TEST_TMP, "labels.jsonl");
    writeJsonl(labels, [
      labelRow(keys[0], "lesson", false, "user", ""),
      labelRow(keys[0], "no_lesson", true, "user", ""),
    ]);

    const result = await capture(() => labelsMain(["check", "--corpus", corpus, "--set", "dev", "--labels", labels]));
    expect(result.code).toBe(2);
    expect(result.err).toBe(`${strings.labelsProblem(keys[0], strings.labelsProblemDuplicate)}\n`);
  });

  it("reports a key outside the set", async () => {
    const { corpus } = await devCorpus("outside", trioRecords(sessionHeader("sess-outside"), 1));
    const labels = path.join(TEST_TMP, "labels.jsonl");
    writeJsonl(labels, [labelRow("cafebabecafebabe", "lesson", false, "user", "")]);

    const result = await capture(() => labelsMain(["check", "--corpus", corpus, "--set", "dev", "--labels", labels]));
    expect(result.code).toBe(2);
    expect(result.err).toContain("compass labels: cafebabecafebabe is not in set dev");
    expect(result.err).toContain("is missing");
  });

  it("reports each invalid field kind", async () => {
    const { corpus, keys } = await devCorpus("fields", trioRecords(sessionHeader("sess-fields"), 1));
    const labels = path.join(TEST_TMP, "labels.jsonl");
    const base = labelRow(keys[0], "lesson", false, "user", "");
    for (const field of ["key", "label", "correction", "source", "note"]) {
      const broken = { ...base };
      if (field === "key") broken.key = 7;
      if (field === "label") broken.label = "maybe";
      if (field === "correction") broken.correction = "yes";
      if (field === "source") broken.source = "someone";
      if (field === "note") delete broken.note;
      writeJsonl(labels, [broken]);
      const result = await capture(() => labelsMain(["check", "--corpus", corpus, "--set", "dev", "--labels", labels]));
      expect(result.code).toBe(2);
      expect(result.err).toContain(`compass labels: ${field === "key" ? "" : keys[0]} has an invalid field: ${field}`);
    }
  });

  it("prints the summary line with the file hash on success", async () => {
    const { corpus, keys } = await devCorpus("summary", trioRecords(sessionHeader("sess-summary"), 3));
    const labels = path.join(TEST_TMP, "labels.jsonl");
    writeJsonl(labels, [
      labelRow(keys[0], "lesson", true, "user", "kept"),
      labelRow(keys[1], "lesson", false, "cc-draft", ""),
      labelRow(keys[2], "no_lesson", false, "cc-draft-user-checked", ""),
    ]);

    const result = await capture(() => labelsMain(["check", "--corpus", corpus, "--set", "dev", "--labels", labels]));
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toBe(`${strings.labelsSummary("dev", 3, 2, 1, 1, sha256File(labels))}\n`);
  });
});

describe("sheet text", () => {
  it("renders the title, entry header, Jev line, extractor rules, label line, and text blocks", async () => {
    const agentBefore = `${"a".repeat(400)}${"b".repeat(600)}`;
    const agentAfter = `${"c".repeat(600)}${"d".repeat(400)}`;
    const userFeedback = "the feedback the user gave";
    const records = [sessionHeader("sess-sheet"), assistant(agentBefore), user(userFeedback), assistant(agentAfter)];
    const { corpus, keys } = await devCorpus("sheet", records);
    const scores = path.join(TEST_TMP, "scores.jsonl");
    const extract = path.join(TEST_TMP, "extract.jsonl");
    const labels = path.join(TEST_TMP, "labels.jsonl");
    writeJsonl(scores, [scoredRow(keys[0], { correction: 0.1, preference: 0.2, steering: 0.3, confusion: 0.456 })]);
    writeJsonl(extract, [extractRow(keys[0], "success", ["rule one", "rule two"], 1, null)]);
    writeJsonl(labels, [labelRow(keys[0], "lesson", true, "user", "take notes")]);

    const output = path.join(TEST_TMP, "sheet.md");
    const result = await capture(() =>
      labelsMain(
        exportArgs(corpus, output, [
          "--scores",
          scores,
          "--extract",
          extract,
          "--labels",
          labels,
          "--select",
          "all",
          "--seed",
          "s",
        ]),
      ),
    );
    expect(result.code).toBe(0);
    const sheet = fs.readFileSync(output, "utf-8");
    const file = readCorpusRows(corpus)[0].file;

    expect(sheet).toContain("# Label sheet — dev, 1 trios (all)");
    expect(sheet).toContain(`## ${file} · trio 1 · ${keys[0]}`);
    expect(sheet).toContain("Jev: correction 0.10, preference 0.20, steering 0.30, confusion 0.46");
    expect(sheet).toContain("Extractor: 2 rules");
    expect(sheet).toContain("  - rule one");
    expect(sheet).toContain("  - rule two");
    expect(sheet).toContain("Label: lesson · correction yes · user · take notes");
    expect(sheet).toContain("Agent before (last 800 characters):");
    expect(sheet).toContain("User reply:");
    expect(sheet).toContain("Agent after (first 800 characters):");
    // The blocks hold the last 800 and first 800 characters, not the whole texts.
    expect(sheet).toContain(`${"a".repeat(200)}${"b".repeat(600)}`);
    expect(sheet).not.toContain("a".repeat(400));
    expect(sheet).toContain(`${"c".repeat(600)}${"d".repeat(200)}`);
    expect(sheet).not.toContain("d".repeat(400));
    expect(sheet).toContain(userFeedback);
    expect(sheet.match(/````/g)).toHaveLength(6);
  });

  it("renders fallback, not-scored, failed, not-run, and no-label variants", async () => {
    const { corpus, keys } = await devCorpus("variants", trioRecords(sessionHeader("sess-variants"), 4));
    const scores = path.join(TEST_TMP, "scores.jsonl");
    const extract = path.join(TEST_TMP, "extract.jsonl");
    writeJsonl(scores, [
      fallbackRow(keys[0], "http_401"),
      notRunRow(keys[1]),
      scoredRow(keys[2], { correction: 0.5, preference: 0.5, steering: 0.5, confusion: 0.5 }),
      scoredRow(keys[3], { correction: 0.5, preference: 0.5, steering: 0.5, confusion: 0.5 }),
    ]);
    writeJsonl(extract, [
      extractRow(keys[0], "failed", [], 2, null),
      extractRow(keys[1], "not_run", [], 0, null),
      extractRow(keys[2], "success", [], 1, null),
      extractRow(keys[3], "success", ["rule"], 1, null),
    ]);

    const output = path.join(TEST_TMP, "sheet.md");
    const result = await capture(() =>
      labelsMain(
        exportArgs(corpus, output, ["--scores", scores, "--extract", extract, "--select", "all", "--seed", "s"]),
      ),
    );
    expect(result.code).toBe(0);
    const sheet = fs.readFileSync(output, "utf-8");
    expect(sheet).toContain("Jev: fallback (http_401)");
    expect(sheet).toContain("Jev: not scored");
    expect(sheet).toContain("Extractor: failed");
    expect(sheet).toContain("Extractor: not run");
    expect(sheet).toContain("Extractor: 0 rules");
    expect(sheet.match(/Label: \(none\)/g)).toHaveLength(4);
  });
});

describe("refusals", () => {
  async function corpusWithScores(
    name: string,
    trioCount: number,
  ): Promise<{
    corpus: string;
    keys: string[];
    scores: string;
    extract: string;
    labels: string;
  }> {
    const { corpus, keys } = await devCorpus(name, trioRecords(sessionHeader(`sess-${name}`), trioCount));
    const scores = path.join(TEST_TMP, "scores.jsonl");
    const extract = path.join(TEST_TMP, "extract.jsonl");
    const labels = path.join(TEST_TMP, "labels.jsonl");
    writeJsonl(
      scores,
      keys.map((key) => scoredRow(key, { correction: 0.2, preference: 0.2, steering: 0.2, confusion: 0.2 })),
    );
    writeJsonl(
      extract,
      keys.map((key) => extractRow(key, "success", ["rule"], 1, null)),
    );
    writeJsonl(
      labels,
      keys.map((key) => labelRow(key, "lesson", false, "user", "")),
    );
    return { corpus, keys, scores, extract, labels };
  }

  it("refuses a missing flag with its message", async () => {
    const { corpus } = await corpusWithScores("missing-flag", 1);
    const result = await capture(() =>
      labelsMain(["export", "--corpus", corpus, "--set", "dev", "--select", "all", "--seed", "s"]),
    );
    expect(result.code).toBe(2);
    expect(result.err).toBe("compass labels: --scores is required\n");
  });

  it("refuses a missing subcommand with its message", async () => {
    const result = await capture(() => labelsMain([]));
    expect(result.code).toBe(2);
    expect(result.err).toBe("compass labels: export or check is required\n");
  });

  it("refuses --select review without --labels", async () => {
    const { corpus, scores, extract } = await corpusWithScores("review-needs-labels", 1);
    const result = await capture(() =>
      labelsMain(
        exportArgs(corpus, path.join(TEST_TMP, "sheet.md"), [
          "--scores",
          scores,
          "--extract",
          extract,
          "--select",
          "review",
          "--seed",
          "s",
        ]),
      ),
    );
    expect(result.code).toBe(2);
    expect(result.err).toBe("compass labels: --select review needs --labels\n");
  });

  it("refuses a bad selection", async () => {
    const { corpus, scores, extract } = await corpusWithScores("bad-selection", 1);
    const result = await capture(() =>
      labelsMain(
        exportArgs(corpus, path.join(TEST_TMP, "sheet.md"), [
          "--scores",
          scores,
          "--extract",
          extract,
          "--select",
          "some",
          "--seed",
          "s",
        ]),
      ),
    );
    expect(result.code).toBe(2);
    expect(result.err).toBe("compass labels: --select must be all or review\n");
  });

  it("refuses a set other than dev or heldout", async () => {
    const { corpus, scores, extract } = await corpusWithScores("bad-set", 1);
    for (const value of ["all", "nope"]) {
      const result = await capture(() =>
        labelsMain([
          "export",
          "--corpus",
          corpus,
          "--set",
          value,
          "--output",
          path.join(TEST_TMP, "sheet.md"),
          "--scores",
          scores,
          "--extract",
          extract,
          "--select",
          "all",
          "--seed",
          "s",
        ]),
      );
      expect(result.code).toBe(2);
      expect(result.err).toBe("compass labels: --set must be dev or heldout\n");
    }
  });

  it("refuses a scores file that does not cover the set", async () => {
    const { corpus, keys, scores, extract } = await corpusWithScores("short-scores", 2);
    writeJsonl(scores, [scoredRow(keys[0], { correction: 0.2, preference: 0.2, steering: 0.2, confusion: 0.2 })]);
    const result = await capture(() =>
      labelsMain(
        exportArgs(corpus, path.join(TEST_TMP, "sheet.md"), [
          "--scores",
          scores,
          "--extract",
          extract,
          "--select",
          "all",
          "--seed",
          "s",
        ]),
      ),
    );
    expect(result.code).toBe(2);
    expect(result.err).toBe(`compass labels: ${scores} does not cover set dev of ${corpus}\n`);
  });

  it("refuses a scores file with a key outside the set", async () => {
    const { corpus, keys, scores, extract } = await corpusWithScores("foreign-scores", 1);
    writeJsonl(scores, [
      scoredRow(keys[0], { correction: 0.2, preference: 0.2, steering: 0.2, confusion: 0.2 }),
      scoredRow("cafebabecafebabe", { correction: 0.2, preference: 0.2, steering: 0.2, confusion: 0.2 }),
    ]);
    const result = await capture(() =>
      labelsMain(
        exportArgs(corpus, path.join(TEST_TMP, "sheet.md"), [
          "--scores",
          scores,
          "--extract",
          extract,
          "--select",
          "all",
          "--seed",
          "s",
        ]),
      ),
    );
    expect(result.code).toBe(2);
    expect(result.err).toBe(`compass labels: ${scores} does not cover set dev of ${corpus}\n`);
  });

  it("refuses an unparseable extract file", async () => {
    const { corpus, scores, extract } = await corpusWithScores("bad-extract", 1);
    fs.writeFileSync(extract, "not json\n", "utf-8");
    const result = await capture(() =>
      labelsMain(
        exportArgs(corpus, path.join(TEST_TMP, "sheet.md"), [
          "--scores",
          scores,
          "--extract",
          extract,
          "--select",
          "all",
          "--seed",
          "s",
        ]),
      ),
    );
    expect(result.code).toBe(2);
    expect(result.err).toBe(`compass labels: ${extract} does not cover set dev of ${corpus}\n`);
  });

  it("refuses a labels file with a key outside the set", async () => {
    const { corpus, keys, scores, extract, labels } = await corpusWithScores("foreign-labels", 1);
    writeJsonl(labels, [
      labelRow(keys[0], "lesson", false, "user", ""),
      labelRow("cafebabecafebabe", "lesson", false, "user", ""),
    ]);
    const result = await capture(() =>
      labelsMain(
        exportArgs(corpus, path.join(TEST_TMP, "sheet.md"), [
          "--scores",
          scores,
          "--extract",
          extract,
          "--labels",
          labels,
          "--select",
          "all",
          "--seed",
          "s",
        ]),
      ),
    );
    expect(result.code).toBe(2);
    expect(result.err).toBe(`compass labels: ${labels} does not cover set dev of ${corpus}\n`);
  });

  it("refuses a corpus that no longer matches its freeze", async () => {
    const { corpus, scores, extract } = await corpusWithScores("tampered", 1);
    fs.appendFileSync(path.join(corpus, "trios.jsonl"), "\n", "utf-8");
    const result = await capture(() =>
      labelsMain(
        exportArgs(corpus, path.join(TEST_TMP, "sheet.md"), [
          "--scores",
          scores,
          "--extract",
          extract,
          "--select",
          "all",
          "--seed",
          "s",
        ]),
      ),
    );
    expect(result.code).toBe(2);
    expect(result.err).toBe(`${strings.scoreCorpusChanged(corpus)}\n`);
  });
});

describe("offline boundaries", () => {
  it("writes only the output file and makes no request", async () => {
    const { corpus, keys } = await devCorpus("boundaries", trioRecords(sessionHeader("sess-boundaries"), 2));
    const scores = path.join(TEST_TMP, "scores.jsonl");
    const extract = path.join(TEST_TMP, "extract.jsonl");
    const labels = path.join(TEST_TMP, "labels.jsonl");
    writeJsonl(
      scores,
      keys.map((key) => scoredRow(key, { correction: 0.2, preference: 0.2, steering: 0.2, confusion: 0.2 })),
    );
    writeJsonl(
      extract,
      keys.map((key) => extractRow(key, "success", ["rule"], 1, null)),
    );
    writeJsonl(
      labels,
      keys.map((key) => labelRow(key, "lesson", false, "user", "")),
    );

    const output = path.join(TEST_TMP, "out", "sheet.md");
    const before = treeFiles(TEST_TMP);
    const result = await capture(() =>
      labelsMain(
        exportArgs(corpus, output, [
          "--scores",
          scores,
          "--extract",
          extract,
          "--labels",
          labels,
          "--select",
          "all",
          "--seed",
          "s",
        ]),
      ),
    );
    expect(result.code).toBe(0);
    const after = treeFiles(TEST_TMP);
    expect(after.filter((file) => !before.includes(file))).toEqual([path.join("out", "sheet.md")]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
