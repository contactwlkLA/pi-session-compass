// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The extraction-only run: every check refuses before a request, every request
 * goes through the counter, per-trio attempts and usage stay separate under
 * concurrency, the cache serves a hit without a request, and the run stops on
 * a ceiling or on three failures in a row. The model layer is mocked with a
 * scripted stream (controllable delays, usage, and failures) while llm-call,
 * the agent loop, and the extractor run for real — no test makes a live
 * request, and the settings snapshot is mocked so no test reads ~/.pi.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main as freezeCorpus } from "../../scripts/compass/corpus.js";
import { main as extractRun } from "../../scripts/compass/extract.js";
import { strings } from "../../scripts/compass/strings.js";
import type { CorpusTrio } from "../../scripts/compass/types.js";
import { sha256Text } from "../../scripts/compass/util.js";
import type { PortraitState } from "../../src/types.js";
import { EXTRACTION_POLICY_REVISION } from "../../src/work-state.js";

const ROOT = process.cwd();
// Unique per test-file run so overlapping suite runs never share a directory.
const TEST_TMP_ROOT = path.join(ROOT, "outputs", "test-tmp");
fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
const TEST_TMP = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "extract-"));

const MODEL = "meta/test-model";
const REVISION = sha256Text(`${EXTRACTION_POLICY_REVISION}\n${MODEL}\nhigh`).slice(0, 12);

interface ScriptedTurn {
  kind: "tool" | "error";
  delayMs: number;
  input: number;
  output: number;
  notes: string[];
}

const modelState = vi.hoisted(() => ({
  booted: false,
  calls: 0,
  pending: 0,
  maxPending: 0,
  script: [] as ScriptedTurn[],
}));

const settingsState = vi.hoisted(() => ({
  portraitSettings: {} as Record<string, unknown>,
  hostPiSettings: { defaultProvider: "meta", defaultModel: "test-model" } as {
    defaultProvider?: string;
    defaultModel?: string;
  },
}));

const DEFAULT_TURN: ScriptedTurn = {
  kind: "tool",
  delayMs: 0,
  input: 11,
  output: 4,
  notes: ["extracted rule"],
};

vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: {
    create: async () => {
      modelState.booted = true;
      return {};
    },
  },
  ModelRegistry: class {
    find(provider: string, id: string) {
      if (provider !== "meta" || id !== "test-model") return undefined;
      return { provider, id, api: "test" };
    }

    async getApiKeyAndHeaders() {
      return { ok: true, apiKey: "placeholder-key", headers: {} };
    }

    streamSimple() {
      modelState.calls++;
      const turn = modelState.script.shift() ?? DEFAULT_TURN;
      modelState.pending++;
      modelState.maxPending = Math.max(modelState.maxPending, modelState.pending);
      return {
        async *[Symbol.asyncIterator]() {
          // No streamed events: the message below arrives as one completed turn.
        },
        async result() {
          try {
            if (turn.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, turn.delayMs));
            if (turn.kind === "error") {
              // A provider failure resolves as an error message, as the real stream does.
              return {
                role: "assistant",
                content: [{ type: "text", text: "the provider failed" }],
                stopReason: "error",
                errorMessage: "upstream refused the request",
              };
            }
            return {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: `call-${modelState.calls}`,
                  name: "return_extraction",
                  arguments: {
                    summary: { agentBefore: "before", userFeedback: "feedback", agentAfter: "after" },
                    behaviorNotes: turn.notes,
                  },
                },
              ],
              stopReason: "toolUse",
              usage: { input: turn.input, output: turn.output },
            };
          } finally {
            modelState.pending--;
          }
        },
      };
    }
  },
}));

// The snapshot is written by the test, so no run reads the live ~/.pi settings.
vi.mock("../../scripts/compass/settings.js", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    captureSettingsSnapshot: async (outPath: string) => {
      const portraitSettings: Record<string, unknown> = {
        model: "meta/test-model",
        thinkingLevel: "high",
        retries: 0,
        timeoutMs: null,
        maxTokens: 2000,
        rateLimitMs: 0,
        debugDumpLimit: 0,
        postExtractionEnabled: false,
        ...settingsState.portraitSettings,
      };
      const snapshot = {
        capturedAt: new Date().toISOString(),
        portraitSettings,
        overriddenKeys: [],
        hostPiSettings: settingsState.hostPiSettings,
        note: "sanitized: key/secret/token-like values redacted",
      };
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2), "utf-8");
      return { snapshotPath: outPath, portraitSettings, overriddenKeys: [] };
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

function writeSession(dir: string, name: string, records: Record<string, unknown>[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf-8");
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

/** Freeze one source folder of session files and return the corpus directory. */
async function frozenCorpus(name: string, files: Record<string, Record<string, unknown>[]>): Promise<string> {
  const source = path.join(TEST_TMP, `source-${name}`);
  for (const [fileName, records] of Object.entries(files)) writeSession(source, fileName, records);
  const corpusDir = path.join(TEST_TMP, `corpus-${name}`);
  const frozen = await capture(() =>
    freezeCorpus(["--source", source, "--output", corpusDir, "--seed", "extract-seed"]),
  );
  expect(frozen.code).toBe(0);
  return corpusDir;
}

/** The split as the freeze defines it, restated here to pick the requested set. */
function setFor(sessionId: string): "dev" | "heldout" {
  return parseInt(sha256Text(`extract-seed\n${sessionId}`).slice(0, 8), 16) % 2 === 0 ? "dev" : "heldout";
}

function threeTrioFiles(): Record<string, Record<string, unknown>[]> {
  return { "alpha.jsonl": trioRecords(sessionHeader("sess-alpha"), 3) };
}

interface ExtractRun {
  corpus: string;
  set: string;
  output: string;
  requests: string;
  runMs: string;
  concurrency: string | null;
  confirmed: boolean;
}

function extractArgv(run: ExtractRun): string[] {
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

function defaultRun(corpus: string, output: string): ExtractRun {
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

interface ExtractRowJson {
  key: string;
  set: string;
  sessionId: string;
  file: string;
  index: number;
  outcome: "success" | "failed" | "not_run";
  notes: string[];
  attempts: number;
  usage: { input: number; output: number } | null;
  latencyMs: number;
  cached: boolean;
}

function readRows(outputDir: string): ExtractRowJson[] {
  return fs
    .readFileSync(path.join(outputDir, "extract.jsonl"), "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ExtractRowJson);
}

function readSummary(outputDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(outputDir, "summary.json"), "utf-8")) as Record<string, unknown>;
}

function readCorpusRows(corpusDir: string): CorpusTrio[] {
  return fs
    .readFileSync(path.join(corpusDir, "trios.jsonl"), "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CorpusTrio);
}

function readCacheLines(corpusDir: string): Record<string, unknown>[] {
  const cachePath = path.join(corpusDir, "cache", `extract-${REVISION}.jsonl`);
  if (!fs.existsSync(cachePath)) return [];
  return fs
    .readFileSync(cachePath, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

let savedStateDir: string | undefined;

beforeEach(() => {
  savedStateDir = process.env.PI_PORTRAIT_STATE_DIR;
  delete process.env.PI_PORTRAIT_STATE_DIR;
  modelState.booted = false;
  modelState.calls = 0;
  modelState.pending = 0;
  modelState.maxPending = 0;
  modelState.script = [];
  settingsState.portraitSettings = {};
  settingsState.hostPiSettings = { defaultProvider: "meta", defaultModel: "test-model" };
  delete globalThis.__piPortraitReportError;
  delete globalThis.__piPortrait;
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
  fs.mkdirSync(TEST_TMP, { recursive: true });
});

afterEach(() => {
  if (savedStateDir === undefined) delete process.env.PI_PORTRAIT_STATE_DIR;
  else process.env.PI_PORTRAIT_STATE_DIR = savedStateDir;
  delete globalThis.__piPortraitReportError;
  delete globalThis.__piPortrait;
  vi.restoreAllMocks();
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
});

describe("refusals before any request", () => {
  it("refuses a limits error with the harness message before the snapshot", async () => {
    const corpus = await frozenCorpus("limits", threeTrioFiles());
    const outputDir = path.join(TEST_TMP, "extract-out");

    const { code, err } = await capture(() =>
      extractRun([
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
        outputDir,
        "--confirmed",
      ]),
    );

    expect(code).toBe(2);
    expect(err).toBe(`${strings.missingSwitch("max-run-ms")}\n`);
    expect(modelState.calls).toBe(0);
    expect(fs.existsSync(path.join(outputDir, "settings-snapshot.json"))).toBe(false);
  });

  it("refuses an unknown set with score's message before the snapshot", async () => {
    const corpus = await frozenCorpus("set-guard", threeTrioFiles());
    const outputDir = path.join(TEST_TMP, "extract-out");

    const { code, err } = await capture(() =>
      extractRun(extractArgv({ ...defaultRun(corpus, outputDir), set: "development" })),
    );

    expect(code).toBe(2);
    expect(err).toBe("compass score: --set must be dev, heldout, or all\n");
    expect(modelState.calls).toBe(0);
    expect(fs.existsSync(path.join(outputDir, "settings-snapshot.json"))).toBe(false);
  });

  it.each(["0", "9"])("refuses an out-of-range concurrency of %s", async (value) => {
    const corpus = await frozenCorpus("concurrency-guard", threeTrioFiles());
    const outputDir = path.join(TEST_TMP, `extract-out-${value}`);

    const { code, err } = await capture(() =>
      extractRun(extractArgv({ ...defaultRun(corpus, outputDir), concurrency: value })),
    );

    expect(code).toBe(2);
    expect(err).toBe("compass score: --concurrency must be an integer from 1 to 8\n");
    expect(modelState.calls).toBe(0);
  });

  it("refuses a corpus whose freeze file is missing", async () => {
    const corpus = await frozenCorpus("no-freeze", threeTrioFiles());
    fs.rmSync(path.join(corpus, "freeze.json"));
    const outputDir = path.join(TEST_TMP, "extract-out");

    const { code, err } = await capture(() => extractRun(extractArgv(defaultRun(corpus, outputDir))));

    expect(code).toBe(2);
    expect(err).toBe(`compass score: the corpus at ${corpus} changed after it was frozen; no request was made\n`);
    expect(modelState.calls).toBe(0);
  });

  it("refuses a frozen session copy edited after the freeze", async () => {
    const corpus = await frozenCorpus("edited-copy", threeTrioFiles());
    const copy = path.join(corpus, "sessions", "1-source-edited-copy", "alpha.jsonl");
    fs.writeFileSync(
      copy,
      fs.readFileSync(copy, "utf-8").replace("the agent's reply number 1", "a reply that changed"),
      "utf-8",
    );
    const outputDir = path.join(TEST_TMP, "extract-out");

    const { code, err } = await capture(() => extractRun(extractArgv(defaultRun(corpus, outputDir))));

    expect(code).toBe(2);
    expect(err).toBe(`compass score: the corpus at ${corpus} changed after it was frozen; no request was made\n`);
    expect(modelState.calls).toBe(0);
  });

  it("boots the model, prints the approved block, and refuses without --confirmed", async () => {
    const corpus = await frozenCorpus("unconfirmed", threeTrioFiles());
    const outputDir = path.join(TEST_TMP, "extract-out");

    const { code, out, err } = await capture(() =>
      extractRun(extractArgv({ ...defaultRun(corpus, outputDir), confirmed: false })),
    );

    expect(code).toBe(2);
    expect(err).toBe("");
    expect(modelState.booted).toBe(true);
    expect(modelState.calls).toBe(0);
    const lines = out.split("\n");
    expect(lines[0]).toBe("compass extract — extraction only (no review, no building, no portrait)");
    expect(lines[1]).toBe(`Corpus: ${corpus} · set all: 3 trios (0 cached, 3 to extract)`);
    expect(lines[2]).toBe(strings.confirmLimits(50, 600000));
    expect(lines[3]).toBe(strings.confirmLimitSource("user-override"));
    expect(lines[4]).toBe(`Extractor: ${MODEL} · thinking high · revision ${REVISION} · 4 at once`);
    expect(lines[5]).toBe(`Output: ${outputDir}`);
    expect(lines[6]).toBe("Not confirmed: pass --confirmed after the user approves these values. No request was made.");
    expect(lines[7]).toBe("");
    expect(fs.existsSync(path.join(outputDir, "extract.jsonl"))).toBe(false);
  });

  it("prints the access blocker with the harness prefix and exits 1", async () => {
    const corpus = await frozenCorpus("missing-model", threeTrioFiles());
    settingsState.portraitSettings = { model: "meta/missing-model" };
    const outputDir = path.join(TEST_TMP, "extract-out");

    const { code, out, err } = await capture(() => extractRun(extractArgv(defaultRun(corpus, outputDir))));

    expect(code).toBe(1);
    expect(err).toBe("compass harness: model 'meta/missing-model' unavailable: not found in the model registry\n");
    expect(out).toBe("");
    expect(modelState.calls).toBe(0);
  });

  it("prints the missing-override blocker with the harness prefix and exits 1", async () => {
    const corpus = await frozenCorpus("no-override", threeTrioFiles());
    settingsState.portraitSettings = { model: null };
    settingsState.hostPiSettings = {};
    const outputDir = path.join(TEST_TMP, "extract-out");

    const { code, out, err } = await capture(() => extractRun(extractArgv(defaultRun(corpus, outputDir))));

    expect(code).toBe(1);
    expect(err).toBe("compass harness: no portrait model override and no resolvable host default model\n");
    expect(out).toBe("");
  });
});

describe("a completed run", () => {
  it("extracts every trio, prints the progress and final lines, and writes rows, cache, and summary", async () => {
    const corpus = await frozenCorpus("complete", threeTrioFiles());
    const outputDir = path.join(TEST_TMP, "extract-out");

    const { code, out, err } = await capture(() => extractRun(extractArgv(defaultRun(corpus, outputDir))));

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(modelState.calls).toBe(3);
    const lines = out.split("\n");
    expect(lines[0]).toBe("compass extract — extraction only (no review, no building, no portrait)");
    expect(lines[1]).toBe(`Corpus: ${corpus} · set all: 3 trios (0 cached, 3 to extract)`);
    expect(lines[4]).toBe(`Extractor: ${MODEL} · thinking high · revision ${REVISION} · 4 at once`);
    expect(lines.slice(2, 4)).toEqual([strings.confirmLimits(50, 600000), strings.confirmLimitSource("user-override")]);
    expect(lines[5]).toBe(`Output: ${outputDir}`);
    expect(lines[6]).toBe("trio 1/3: 1 rules");
    expect(lines[7]).toBe("trio 2/3: 1 rules");
    expect(lines[8]).toBe("trio 3/3: 1 rules");
    expect(lines[9]).toBe("Extracted 3 · cached 0 · failed 0 · not run 0 · requests 3 · stop: completed");
    expect(lines[10]).toBe("");

    const rows = readRows(outputDir);
    expect(rows.map((row) => row.key)).toEqual(readCorpusRows(corpus).map((row) => row.key));
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        "key",
        "set",
        "sessionId",
        "file",
        "index",
        "outcome",
        "notes",
        "attempts",
        "usage",
        "latencyMs",
        "cached",
      ].sort(),
    );
    for (const row of rows) {
      expect(row).toMatchObject({
        outcome: "success",
        notes: ["extracted rule"],
        attempts: 1,
        usage: { input: 11, output: 4 },
        cached: false,
        sessionId: "sess-alpha",
        index: expect.any(Number),
      });
      expect(row.latencyMs).toBeGreaterThanOrEqual(0);
    }

    const summary = readSummary(outputDir);
    expect(summary).toMatchObject({
      runType: "smoke",
      corpus,
      set: "all",
      corpusFreeze: expect.any(String),
      limits: { maxRequests: 50, maxRunMs: 600000, source: "user-override" },
      confirmed: true,
      concurrency: 4,
      model: MODEL,
      thinkingLevel: "high",
      revision: REVISION,
      postExtractionEnabled: false,
      trios: 3,
      cached: 0,
      outcomes: { success: 3 },
      requests: 3,
      usage: { input: 33, output: 12, unknown: 0 },
      stop: "completed",
    });
    expect(summary.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(fs.existsSync(path.join(outputDir, "diagnostics.log"))).toBe(false);

    expect(readCacheLines(corpus)).toHaveLength(3);
    expect(readCacheLines(corpus)[0]).toMatchObject({ key: rows[0].key, notes: ["extracted rule"], attempts: 1 });
    expect(fs.existsSync(path.join(outputDir, "portrait"))).toBe(true);
    expect(process.env.PI_PORTRAIT_STATE_DIR).toBe(path.join(outputDir, "portrait"));
  });

  it("records postExtractionEnabled from the snapshot without running any review", async () => {
    const corpus = await frozenCorpus("post-review", { "alpha.jsonl": trioRecords(sessionHeader("sess-alpha"), 1) });
    settingsState.portraitSettings = { postExtractionEnabled: true };
    const outputDir = path.join(TEST_TMP, "extract-out");

    const { code } = await capture(() => extractRun(extractArgv(defaultRun(corpus, outputDir))));

    expect(code).toBe(0);
    expect(readSummary(outputDir)).toMatchObject({ postExtractionEnabled: true, requests: 1, trios: 1 });
    expect(modelState.calls).toBe(1);
  });

  it("extracts only the requested set and completes an empty selection", async () => {
    const corpus = await frozenCorpus("set-select", { "alpha.jsonl": trioRecords(sessionHeader("sess-alpha"), 3) });
    const wanted = setFor("sess-alpha");
    const other = wanted === "dev" ? "heldout" : "dev";
    const selectedOut = path.join(TEST_TMP, "extract-selected");
    const emptyOut = path.join(TEST_TMP, "extract-empty");

    const selected = await capture(() => extractRun(extractArgv({ ...defaultRun(corpus, selectedOut), set: wanted })));
    const empty = await capture(() => extractRun(extractArgv({ ...defaultRun(corpus, emptyOut), set: other })));

    expect(selected.code).toBe(0);
    expect(empty.code).toBe(0);
    expect(selected.out).toContain(`Corpus: ${corpus} · set ${wanted}: 3 trios (0 cached, 3 to extract)`);
    const rows = readRows(selectedOut);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.set))).toEqual(new Set([wanted]));
    expect(new Set(rows.map((row) => row.sessionId))).toEqual(new Set(["sess-alpha"]));
    expect(empty.out).toContain(`Corpus: ${corpus} · set ${other}: 0 trios (0 cached, 0 to extract)`);
    expect(readRows(emptyOut)).toHaveLength(0);
    expect(readSummary(emptyOut)).toMatchObject({ trios: 0, requests: 0, stop: "completed", outcomes: {} });
    expect(modelState.calls).toBe(3);
  });

  it("treats a paused extractor as a failed row without stopping the run", async () => {
    const corpus = await frozenCorpus("paused", { "alpha.jsonl": trioRecords(sessionHeader("sess-alpha"), 1) });
    modelState.script = [{ kind: "error", delayMs: 0, input: 0, output: 0, notes: [] }];
    globalThis.__piPortrait = { uiSelect: async () => "Pause profiling to investigate" } as unknown as PortraitState;
    const outputDir = path.join(TEST_TMP, "extract-out");

    const { code } = await capture(() => extractRun(extractArgv(defaultRun(corpus, outputDir))));

    expect(code).toBe(0);
    expect(readRows(outputDir)[0]).toMatchObject({ outcome: "failed", cached: false });
    expect(readSummary(outputDir)).toMatchObject({ outcomes: { failed: 1 }, requests: 1, stop: "completed" });
    expect(readCacheLines(corpus)).toHaveLength(0);
  });
});

describe("stops", () => {
  it("passes one request through the counter, records the running trios, and exits 3 at the ceiling", async () => {
    const corpus = await frozenCorpus("ceiling", {
      "alpha.jsonl": trioRecords(sessionHeader("sess-alpha"), 6),
    });
    const outputDir = path.join(TEST_TMP, "extract-out");

    const { code, out } = await capture(() =>
      extractRun(extractArgv({ ...defaultRun(corpus, outputDir), requests: "1" })),
    );

    expect(code).toBe(3);
    expect(modelState.calls).toBe(1);
    const rows = readRows(outputDir);
    expect(rows).toHaveLength(6);
    expect(rows.slice(0, 4).every((row) => row.outcome === "success" || row.outcome === "failed")).toBe(true);
    expect(rows.filter((row) => row.outcome === "success")).toHaveLength(1);
    expect(rows.filter((row) => row.outcome === "failed")).toHaveLength(3);
    expect(rows.slice(4).map((row) => row.outcome)).toEqual(["not_run", "not_run"]);
    expect(readSummary(outputDir)).toMatchObject({ stop: "request limit", requests: 1 });
    expect(out).toContain("Extracted 1 · cached 0 · failed 3 · not run 2 · requests 1 · stop: request limit");
  });

  it("stops on the run deadline and exits 3", async () => {
    const corpus = await frozenCorpus("deadline", threeTrioFiles());
    modelState.script = [{ kind: "tool", delayMs: 600, input: 5, output: 2, notes: ["extracted rule"] }];
    const outputDir = path.join(TEST_TMP, "extract-out");

    const { code } = await capture(() =>
      extractRun(extractArgv({ ...defaultRun(corpus, outputDir), runMs: "300", concurrency: "1" })),
    );

    expect(code).toBe(3);
    expect(modelState.calls).toBe(1);
    expect(readRows(outputDir).map((row) => row.outcome)).toEqual(["success", "not_run", "not_run"]);
    expect(readSummary(outputDir)).toMatchObject({ stop: "time limit", requests: 1 });
  });

  it("stops after three failed extractions in a row, exits 4, and keeps the diagnostics line", async () => {
    const corpus = await frozenCorpus("streak", {
      "alpha.jsonl": trioRecords(sessionHeader("sess-alpha"), 6),
    });
    modelState.script = [
      { kind: "error", delayMs: 0, input: 0, output: 0, notes: [] },
      { kind: "error", delayMs: 0, input: 0, output: 0, notes: [] },
      { kind: "error", delayMs: 0, input: 0, output: 0, notes: [] },
    ];
    const outputDir = path.join(TEST_TMP, "extract-out");

    const { code, out } = await capture(() =>
      extractRun(extractArgv({ ...defaultRun(corpus, outputDir), concurrency: "1" })),
    );

    expect(code).toBe(4);
    expect(modelState.calls).toBe(3);
    const rows = readRows(outputDir);
    expect(rows.map((row) => row.outcome)).toEqual(["failed", "failed", "failed", "not_run", "not_run", "not_run"]);
    expect(readSummary(outputDir)).toMatchObject({
      stop: "three failed extractions in a row",
      requests: 3,
      outcomes: { failed: 3, not_run: 3 },
    });
    expect(out).toContain(
      "Extracted 0 · cached 0 · failed 3 · not run 3 · requests 3 · stop: three failed extractions in a row",
    );
    const diagnostics = fs.readFileSync(path.join(outputDir, "diagnostics.log"), "utf-8");
    expect(diagnostics).toContain("LLM call failed after retries");
    expect(readCacheLines(corpus)).toHaveLength(0);
  });
});

describe("concurrency and attribution", () => {
  it("keeps at most N trios in flight, rows in corpus order, and each row's own usage", async () => {
    const corpus = await frozenCorpus("pool", {
      "alpha.jsonl": trioRecords(sessionHeader("sess-alpha"), 6),
    });
    const delays = [80, 10, 10, 10, 10, 10];
    modelState.script = delays.map((delayMs, index) => ({
      kind: "tool",
      delayMs,
      input: 100 + index,
      output: 10 + index,
      notes: [`rule ${index}`],
    }));
    const outputDir = path.join(TEST_TMP, "extract-out");

    const { code } = await capture(() =>
      extractRun(extractArgv({ ...defaultRun(corpus, outputDir), concurrency: "3" })),
    );

    expect(code).toBe(0);
    expect(modelState.maxPending).toBe(3);
    const rows = readRows(outputDir);
    expect(rows.map((row) => row.key)).toEqual(readCorpusRows(corpus).map((row) => row.key));
    rows.forEach((row, index) => {
      expect(row.outcome).toBe("success");
      expect(row.notes).toEqual([`rule ${index}`]);
      expect(row.attempts).toBe(1);
      expect(row.usage).toEqual({ input: 100 + index, output: 10 + index });
    });
    expect(rows[0].latencyMs).toBeGreaterThan(rows[1].latencyMs);
    expect(readSummary(outputDir)).toMatchObject({
      requests: 6,
      stop: "completed",
      usage: { input: 615, output: 75, unknown: 0 },
    });
  });
});

describe("cache", () => {
  it("serves every cached trio without a request while the model is still booted", async () => {
    const corpus = await frozenCorpus("cache-hit", threeTrioFiles());
    const cachePath = path.join(corpus, "cache", `extract-${REVISION}.jsonl`);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(
      cachePath,
      `${readCorpusRows(corpus)
        .map((row) =>
          JSON.stringify({
            key: row.key,
            notes: ["cached rule"],
            attempts: 1,
            usage: { input: 9, output: 3 },
            latencyMs: 7,
          }),
        )
        .join("\n")}\n`,
      "utf-8",
    );
    const outputDir = path.join(TEST_TMP, "extract-out");

    const { code, out } = await capture(() => extractRun(extractArgv(defaultRun(corpus, outputDir))));

    expect(code).toBe(0);
    expect(modelState.booted).toBe(true);
    expect(modelState.calls).toBe(0);
    expect(out).toContain(`Corpus: ${corpus} · set all: 3 trios (3 cached, 0 to extract)`);
    expect(out).toContain("Extracted 3 · cached 3 · failed 0 · not run 0 · requests 0 · stop: completed");
    const rows = readRows(outputDir);
    expect(rows.every((row) => row.cached && row.outcome === "success")).toBe(true);
    expect(new Set(rows.map((row) => row.notes[0]))).toEqual(new Set(["cached rule"]));
    expect(readSummary(outputDir)).toMatchObject({ cached: 3, requests: 0, outcomes: { success: 3 } });
  });

  it("keeps a failed extraction out of the cache so a rerun tries it again", async () => {
    const corpus = await frozenCorpus("cache-failure", {
      "alpha.jsonl": trioRecords(sessionHeader("sess-alpha"), 1),
    });
    const outputDir = path.join(TEST_TMP, "extract-first");
    modelState.script = [{ kind: "error", delayMs: 0, input: 0, output: 0, notes: [] }];

    const first = await capture(() => extractRun(extractArgv(defaultRun(corpus, outputDir))));

    expect(first.code).toBe(0);
    expect(readRows(outputDir)[0].outcome).toBe("failed");
    expect(readCacheLines(corpus)).toHaveLength(0);

    const secondOut = path.join(TEST_TMP, "extract-second");
    const second = await capture(() => extractRun(extractArgv(defaultRun(corpus, secondOut))));

    expect(second.code).toBe(0);
    expect(modelState.calls).toBe(2);
    expect(readRows(secondOut)[0]).toMatchObject({ outcome: "success", cached: false });
    expect(readCacheLines(corpus)).toHaveLength(1);
  });
});
