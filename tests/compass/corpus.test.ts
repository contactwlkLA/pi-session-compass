// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Frozen corpus: flag, directory, and copy refusals; the numbered session
 * layout; the detector/census agreement check; the seeded split; the trio
 * keys; and the recorded hashes. Offline only — the sources are small session
 * files written into a temporary folder, and nothing is read from ~/.pi.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main as freezeCorpus } from "../../scripts/compass/corpus.js";
import { strings } from "../../scripts/compass/strings.js";
import type { CorpusSet, CorpusTrio } from "../../scripts/compass/types.js";
import { sha256File, sha256Text } from "../../scripts/compass/util.js";

const ROOT = process.cwd();
// Unique per test-file run so overlapping suite runs never share a directory.
const TEST_TMP_ROOT = path.join(ROOT, "outputs", "test-tmp");
fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
const TEST_TMP = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "corpus-"));

/** When set, the census reports one trio more for that file name. */
const censusState = vi.hoisted(() => ({ mismatchFor: null as string | null }));

vi.mock("../../scripts/compass/census.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../scripts/compass/census.js")>();
  return {
    ...actual,
    censusFile: async (filePath: string) => {
      const census = await actual.censusFile(filePath);
      if (censusState.mismatchFor !== null && path.basename(filePath) === censusState.mismatchFor) {
        return { ...census, totalTrios: census.totalTrios + 1 };
      }
      return census;
    },
  };
});

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

function writeSession(dir: string, name: string, records: Record<string, unknown>[]): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf-8");
  return file;
}

/** The split as the task defines it, restated here to check the freeze against the spec. */
function setFor(seed: string, sessionId: string): CorpusSet {
  return parseInt(sha256Text(`${seed}\n${sessionId}`).slice(0, 8), 16) % 2 === 0 ? "dev" : "heldout";
}

/** A seed that lands the first session in dev and the second in heldout. */
function seedSplitting(first: string, second: string): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const seed = `split-${attempt}`;
    if (setFor(seed, first) === "dev" && setFor(seed, second) === "heldout") return seed;
  }
  throw new Error(`no seed lands ${first} in dev and ${second} in heldout`);
}

async function runFreeze(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const code = await freezeCorpus(argv);
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

function readRows(corpusDir: string): CorpusTrio[] {
  return fs
    .readFileSync(path.join(corpusDir, "trios.jsonl"), "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CorpusTrio);
}

interface CorpusJson {
  seed: string;
  createdAt: string;
  sources: {
    dir: string;
    files: { name: string; sha256: string; sessionId: string; set: CorpusSet; trios: number }[];
  }[];
  totals: {
    sessions: number;
    trios: number;
    dev: { sessions: number; trios: number };
    heldout: { sessions: number; trios: number };
  };
}

function readCorpusJson(corpusDir: string): CorpusJson {
  return JSON.parse(fs.readFileSync(path.join(corpusDir, "corpus.json"), "utf-8")) as CorpusJson;
}

beforeEach(() => {
  censusState.mismatchFor = null;
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
  fs.mkdirSync(TEST_TMP, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
});

describe("flag and directory refusals", () => {
  it("refuses without --source, --output, or --seed", async () => {
    const source = path.join(TEST_TMP, "source");
    writeSession(source, "alpha.jsonl", trioRecords(sessionHeader("sess-alpha"), 1));
    const output = path.join(TEST_TMP, "corpus-out");

    const noSource = await runFreeze(["--output", output, "--seed", "seed"]);
    const noOutput = await runFreeze(["--source", source, "--seed", "seed"]);
    const noSeed = await runFreeze(["--source", source, "--output", output]);

    for (const result of [noSource, noOutput, noSeed]) {
      expect(result.code).toBe(2);
      expect(result.err).toBe(`${strings.corpusMissingFlags}\n`);
      expect(result.out).toBe("");
    }
    expect(fs.existsSync(output)).toBe(false);
  });

  it("refuses a source that is not a directory with the approved message", async () => {
    const sourceFile = path.join(TEST_TMP, "not-a-dir.jsonl");
    fs.writeFileSync(sourceFile, "", "utf-8");
    const output = path.join(TEST_TMP, "corpus-out");

    const { code, err } = await runFreeze(["--source", sourceFile, "--output", output, "--seed", "seed"]);

    expect(code).toBe(2);
    expect(err).toBe(`${strings.corpusNotDirectory(path.resolve(sourceFile))}\n`);
    expect(fs.existsSync(output)).toBe(false);
  });

  it("never overwrites an existing output directory", async () => {
    const source = path.join(TEST_TMP, "source");
    writeSession(source, "alpha.jsonl", trioRecords(sessionHeader("sess-alpha"), 2));
    const output = path.join(TEST_TMP, "corpus-out");
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, "keep-me.txt"), "evidence\n", "utf-8");

    const { code, err } = await runFreeze(["--source", source, "--output", output, "--seed", "seed"]);

    expect(code).toBe(2);
    expect(err).toBe(`${strings.corpusOutputExists(output)}\n`);
    expect(fs.readdirSync(output)).toEqual(["keep-me.txt"]);
  });
});

describe("freezing", () => {
  it("copies, verifies, counts, splits, and hashes a two-source corpus", async () => {
    const sourceA = path.join(TEST_TMP, "alpha-sessions");
    writeSession(sourceA, "alpha.jsonl", trioRecords(sessionHeader("sess-alpha"), 3));
    const sourceB = path.join(TEST_TMP, "beta-sessions");
    writeSession(sourceB, "beta.jsonl", trioRecords(sessionHeader("sess-beta"), 3));
    const sourceHashes = [sha256File(path.join(sourceA, "alpha.jsonl")), sha256File(path.join(sourceB, "beta.jsonl"))];
    const seed = seedSplitting("sess-alpha", "sess-beta");
    const output = path.join(TEST_TMP, "corpus-out");

    const { code, out, err } = await runFreeze([
      "--source",
      sourceA,
      "--source",
      sourceB,
      "--output",
      output,
      "--seed",
      seed,
    ]);

    expect(code).toBe(0);
    expect(err).toBe("");
    // Numbered source folders keep identically named sources apart.
    const copyA = path.join(output, "sessions", "1-alpha-sessions", "alpha.jsonl");
    const copyB = path.join(output, "sessions", "2-beta-sessions", "beta.jsonl");
    expect(sha256File(copyA)).toBe(sourceHashes[0]);
    expect(sha256File(copyB)).toBe(sourceHashes[1]);
    // The sources themselves are untouched.
    expect(sha256File(path.join(sourceA, "alpha.jsonl"))).toBe(sourceHashes[0]);
    expect(sha256File(path.join(sourceB, "beta.jsonl"))).toBe(sourceHashes[1]);

    const rows = readRows(output);
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.file)).toEqual([
      "sessions/1-alpha-sessions/alpha.jsonl",
      "sessions/1-alpha-sessions/alpha.jsonl",
      "sessions/1-alpha-sessions/alpha.jsonl",
      "sessions/2-beta-sessions/beta.jsonl",
      "sessions/2-beta-sessions/beta.jsonl",
      "sessions/2-beta-sessions/beta.jsonl",
    ]);
    expect(rows.map((row) => row.index)).toEqual([1, 2, 3, 1, 2, 3]);
    for (const row of rows) {
      expect(row.key).toMatch(/^[0-9a-f]{16}$/);
      expect(row.sessionId).toBe(row.file.includes("alpha") ? "sess-alpha" : "sess-beta");
      expect(row.set).toBe(row.file.includes("alpha") ? "dev" : "heldout");
      expect(row.lines.agentBefore).toBeGreaterThan(0);
      expect(row.lines.userFeedback).toBeGreaterThan(0);
      expect(row.lines.agentAfter).toBeGreaterThan(0);
      expect(row.chars.agentBefore).toBeGreaterThan(0);
      expect(row.chars.userFeedback).toBeGreaterThan(0);
      expect(row.chars.agentAfter).toBeGreaterThan(0);
    }

    const corpus = readCorpusJson(output);
    expect(corpus.seed).toBe(seed);
    expect(corpus.sources.map((entry) => entry.dir)).toEqual([sourceA, sourceB]);
    expect(corpus.sources[0].files[0]).toEqual({
      name: "alpha.jsonl",
      sha256: sourceHashes[0],
      sessionId: "sess-alpha",
      set: "dev",
      trios: 3,
    });
    expect(corpus.sources[1].files[0]).toMatchObject({ sessionId: "sess-beta", set: "heldout", trios: 3 });
    expect(corpus.totals).toEqual({
      sessions: 2,
      trios: 6,
      dev: { sessions: 1, trios: 3 },
      heldout: { sessions: 1, trios: 3 },
    });

    const freeze = JSON.parse(fs.readFileSync(path.join(output, "freeze.json"), "utf-8")) as Record<string, string>;
    expect(freeze).toEqual({
      "corpus.json": sha256File(path.join(output, "corpus.json")),
      "trios.jsonl": sha256File(path.join(output, "trios.jsonl")),
    });
    expect(out).toBe(
      `Corpus frozen: 2 sessions, 6 trios · dev 1 sessions / 3 trios · held-out 1 sessions / 3 trios → ${output}\n`,
    );
  });

  it("gives the same sets and keys for the same seed and files", async () => {
    const source = path.join(TEST_TMP, "source");
    writeSession(source, "alpha.jsonl", trioRecords(sessionHeader("sess-alpha"), 3));
    writeSession(source, "beta.jsonl", trioRecords(sessionHeader("sess-beta"), 2));
    const first = path.join(TEST_TMP, "corpus-first");
    const second = path.join(TEST_TMP, "corpus-second");

    const one = await runFreeze(["--source", source, "--output", first, "--seed", "same-seed"]);
    const two = await runFreeze(["--source", source, "--output", second, "--seed", "same-seed"]);

    expect(one.code).toBe(0);
    expect(two.code).toBe(0);
    expect(fs.readFileSync(path.join(second, "trios.jsonl"), "utf-8")).toBe(
      fs.readFileSync(path.join(first, "trios.jsonl"), "utf-8"),
    );
    const corpusOne = readCorpusJson(first);
    const corpusTwo = readCorpusJson(second);
    expect(corpusTwo).toEqual({ ...corpusOne, createdAt: corpusTwo.createdAt });
  });

  it("keeps every session inside one set, matching the seeded split", async () => {
    const source = path.join(TEST_TMP, "source");
    writeSession(source, "alpha.jsonl", trioRecords(sessionHeader("sess-alpha"), 3));
    writeSession(source, "beta.jsonl", trioRecords(sessionHeader("sess-beta"), 3));
    const output = path.join(TEST_TMP, "corpus-out");
    const seed = "split-seed";

    const { code } = await runFreeze(["--source", source, "--output", output, "--seed", seed]);

    expect(code).toBe(0);
    const rows = readRows(output);
    const bySession = new Map<string, Set<CorpusSet>>();
    for (const row of rows) {
      const sets = bySession.get(row.sessionId) ?? new Set<CorpusSet>();
      sets.add(row.set);
      bySession.set(row.sessionId, sets);
    }
    expect([...bySession.values()].every((sets) => sets.size === 1)).toBe(true);
    for (const [sessionId, sets] of bySession) {
      expect([...sets][0]).toBe(setFor(seed, sessionId));
    }
    const corpus = readCorpusJson(output);
    expect(corpus.totals.dev.trios + corpus.totals.heldout.trios).toBe(corpus.totals.trios);
  });

  it("uses the file name for a session without a session entry and lists an empty file", async () => {
    const source = path.join(TEST_TMP, "source");
    writeSession(source, "plain.jsonl", trioRecords(null, 2));
    writeSession(source, "empty.jsonl", []);
    const output = path.join(TEST_TMP, "corpus-out");

    const { code, out } = await runFreeze(["--source", source, "--output", output, "--seed", "seed"]);

    expect(code).toBe(0);
    const corpus = readCorpusJson(output);
    const files = Object.fromEntries(corpus.sources[0].files.map((file) => [file.name, file]));
    expect(files["plain.jsonl"]).toMatchObject({ sessionId: "plain", trios: 2 });
    expect(files["empty.jsonl"]).toMatchObject({ sessionId: "empty", trios: 0 });
    expect(corpus.totals.sessions).toBe(2);
    expect(readRows(output).map((row) => row.sessionId)).not.toContain("empty");
    expect(out).toContain("2 sessions, 2 trios");
  });

  it("keeps identically named files from two sources apart", async () => {
    const sourceA = path.join(TEST_TMP, "first");
    const sourceB = path.join(TEST_TMP, "second");
    writeSession(sourceA, "shared.jsonl", trioRecords(sessionHeader("sess-one"), 1));
    writeSession(sourceB, "shared.jsonl", trioRecords(sessionHeader("sess-two"), 2));
    const output = path.join(TEST_TMP, "corpus-out");

    const { code } = await runFreeze(["--source", sourceA, "--source", sourceB, "--output", output, "--seed", "seed"]);

    expect(code).toBe(0);
    expect(sha256File(path.join(output, "sessions", "1-first", "shared.jsonl"))).toBe(
      sha256File(path.join(sourceA, "shared.jsonl")),
    );
    expect(sha256File(path.join(output, "sessions", "2-second", "shared.jsonl"))).toBe(
      sha256File(path.join(sourceB, "shared.jsonl")),
    );
    const rows = readRows(output);
    expect(rows.map((row) => row.file)).toEqual([
      "sessions/1-first/shared.jsonl",
      "sessions/2-second/shared.jsonl",
      "sessions/2-second/shared.jsonl",
    ]);
    expect(new Set(rows.map((row) => row.sessionId))).toEqual(new Set(["sess-one", "sess-two"]));
  });

  it("keys duplicate trio texts apart through the index", async () => {
    const source = path.join(TEST_TMP, "source");
    writeSession(source, "dupes.jsonl", [
      sessionHeader("sess-dupes"),
      assistant("identical agent text"),
      user("identical user text"),
      assistant("identical agent text"),
      user("identical user text"),
      assistant("identical agent text"),
    ]);
    const output = path.join(TEST_TMP, "corpus-out");

    const { code } = await runFreeze(["--source", source, "--output", output, "--seed", "seed"]);

    expect(code).toBe(0);
    const rows = readRows(output);
    expect(rows).toHaveLength(2);
    expect(rows[0].key).not.toBe(rows[1].key);
    expect(rows[0].chars).toEqual(rows[1].chars);
    expect(rows.map((row) => row.index)).toEqual([1, 2]);
  });

  it("stops with the count mismatch message when the two counts disagree", async () => {
    const source = path.join(TEST_TMP, "source");
    writeSession(source, "alpha.jsonl", trioRecords(sessionHeader("sess-alpha"), 3));
    const output = path.join(TEST_TMP, "corpus-out");
    censusState.mismatchFor = "alpha.jsonl";

    const { code, err } = await runFreeze(["--source", source, "--output", output, "--seed", "seed"]);

    expect(code).toBe(2);
    expect(err).toBe(`${strings.corpusCountMismatch(path.join(source, "alpha.jsonl"), 3, 4)}\n`);
    // The copies stay for inspection; nothing was frozen.
    expect(fs.existsSync(path.join(output, "sessions", "1-source", "alpha.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(output, "trios.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(output, "corpus.json"))).toBe(false);
    expect(fs.existsSync(path.join(output, "freeze.json"))).toBe(false);
  });
});
