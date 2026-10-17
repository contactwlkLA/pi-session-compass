// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The harness side of the Jev gate: the receipt's gate block and gate trace
 * lines, the gate line on the results sheet (and the not-run line for a
 * rejected trio), the coverage and pass-progress counts, the counter declining
 * a gate attempt at the ceiling, and the --gate-mode switch travelling from
 * flag or settings into the confirmation and the manifest. The pipeline loop
 * and the model runtime are mocked, so the gate hooks are driven directly and
 * no model call and no network request is made.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPipeline } from "../../scripts/compass/pipeline-boot.js";
import { executeRun, prepareRun } from "../../scripts/compass/run.js";
import { snapshotPortraitState } from "../../scripts/compass/snapshot.js";
import { strings } from "../../scripts/compass/strings.js";
import type { CensusResult, GateRunConfig, Limits, RunSelection } from "../../scripts/compass/types.js";

const ROOT = process.cwd();
// Unique per test-file run so overlapping suite runs never share a directory.
const TEST_TMP_ROOT = path.join(ROOT, "outputs", "test-tmp");
fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
const TEST_TMP = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "gate-harness-"));

const LIMITS: Limits = { runType: "smoke", maxModelRequests: 5, maxRunMs: 900_000, source: "compass-table" };
const HASH = "ad7880acdc3b";
const LIVE_HASH = "f302de0ce97b";
const MODEL = "jev-1.13.0";
const SESSION = "/tmp/sessions/seed.jsonl";
const CENSUS: CensusResult = { file: "seed.jsonl", sha256: "x", totalTrios: 26, nonEmptyLines: 100, trios: [] };

function gateConfig(mode: GateRunConfig["mode"], source: GateRunConfig["source"]): GateRunConfig {
  return { mode, source, policyHash: HASH, model: MODEL };
}

/** What one mocked pass drives on the installed hooks, in order. */
type ScriptEvent =
  | { kind: "attempt" }
  | { kind: "gate"; event: Record<string, unknown> }
  | { kind: "trio"; event: Record<string, unknown> };

interface MockHooks {
  onGateAttempt?: () => boolean;
  onGateResult?: (event: unknown) => void;
  onTrioExamined?: (event: unknown) => void;
}

const loopState = vi.hoisted(() => ({
  hooks: null as MockHooks | null,
  passes: 0,
  /** Hook calls per pass, in call order; a missing pass ends the run. */
  passEvents: [] as ScriptEvent[][],
  /** What each gate attempt call returned, in call order. */
  attemptDecisions: [] as boolean[],
  /** The settings object each pass received, as the gate mode is passed to the loop. */
  loopSettings: [] as Record<string, unknown>[],
}));

vi.mock("../../src/settings-ui.js", () => ({
  _setGetPortraitSettings: () => {},
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: { create: async () => ({}) },
  ModelRegistry: class {
    find() {
      return { provider: "meta", id: "test-model" };
    }
    streamSimple() {}
  },
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  setDefaultStreamFn: () => {},
}));

vi.mock("../../src/llm-call.js", () => ({
  setLlmAttemptSink: () => {},
  setCapturedModel: () => {},
}));

vi.mock("../../src/instrument.js", () => ({
  setInstrumentHooks: (hooks: MockHooks) => {
    loopState.hooks = hooks;
  },
}));

vi.mock("../../src/pipeline.js", () => ({
  runPipelineLoop: async (
    settings: Record<string, unknown>,
    _max: number,
    _shouldCancel: () => boolean,
    _sourceFilter: string | null,
  ) => {
    loopState.passes++;
    loopState.loopSettings.push(settings);
    const events = loopState.passEvents[loopState.passes - 1] ?? [];
    let trios = 0;
    for (const entry of events) {
      const hooks = loopState.hooks;
      if (entry.kind === "attempt") {
        loopState.attemptDecisions.push(hooks?.onGateAttempt?.() ?? true);
      } else if (entry.kind === "gate") {
        hooks?.onGateResult?.(entry.event);
      } else {
        trios++;
        hooks?.onTrioExamined?.(entry.event);
      }
    }
    return { totalSequences: trios > 0 ? 1 : 0, totalInserted: 0, totalEvicted: 0, stopReason: null };
  },
}));

/** A scored gate result as src/gate.ts emits it. */
function scoredGate(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    sourcePath: SESSION,
    mode: "enforce",
    policyHash: HASH,
    decision: "no_lesson",
    routed: "extract",
    answers: { correction: 0.01, preference: 0.02, steering: 0, confusion: 0.05 },
    fallbackReason: null,
    model: MODEL,
    attempts: 1,
    latencyMs: 12,
    usage: { inputTokens: 11, outputTokens: 5 },
    ...overrides,
  };
}

function trioExamined(notes: number): Record<string, unknown> {
  return { sessionPath: SESSION, notes, notesText: notes > 0 ? ["extracted rule"] : [] };
}

function writePortrait(dir: string, rules: string[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "portrait.md"),
    `# Portrait\n\n## Anticipation Rules\n${rules.join("\n")}\n`,
    "utf-8",
  );
}

function writeSettingsSnapshot(outputDir: string): void {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "settings-snapshot.json"),
    JSON.stringify({ portraitSettings: { model: "meta/test-model" }, hostPiSettings: {} }),
    "utf-8",
  );
}

function selectionFor(outputDir: string): RunSelection {
  return { scope: "all", runId: "t-gate", outputDir, createdAt: new Date(0).toISOString() };
}

async function bootRun(
  outputDir: string,
  gate: GateRunConfig,
  passEvents: ScriptEvent[][],
  limits: Limits,
): Promise<number> {
  writePortrait(path.join(outputDir, "portrait"), ["r1"]);
  writeSettingsSnapshot(outputDir);
  loopState.passEvents = passEvents;
  return runPipeline({
    limits,
    prepared: { selection: selectionFor(outputDir), census: CENSUS },
    outputDir,
    confirmMode: "flag",
    gate,
  });
}

interface GateReceipt {
  stop: { kind: string };
  requests: { count: number; refused: number; usageTotals: { input: number; output: number; unknown: number } };
  stages: Record<string, number>;
  gate: {
    mode: string;
    source: string;
    policyHash: string;
    model: string;
    checks: number;
    noLesson: number;
    maybeLesson: number;
    skipped: number;
    fallbacks: Record<string, number>;
    requests: number;
    latencyMsTotal: number;
    usage: { inputTokens: number; outputTokens: number };
  };
  counts: { triosExamined: number };
}

function readReceipt(outputDir: string): GateReceipt {
  return JSON.parse(fs.readFileSync(path.join(outputDir, "receipt.json"), "utf-8")) as GateReceipt;
}

function readSheet(outputDir: string): string {
  return fs.readFileSync(path.join(outputDir, "results-sheet.md"), "utf-8");
}

function readTraces(outputDir: string): Record<string, unknown>[] {
  const raw = fs.readFileSync(path.join(outputDir, "traces.jsonl"), "utf-8").trim();
  if (raw === "") return [];
  return raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** One line per recorded gate event. */
function gateEventLines(outputDir: string): Record<string, unknown>[] {
  return readTraces(outputDir).filter((line) => line.kind === "gate");
}

/** One line per gate request the counter actually sent. */
function gateRequestTraces(outputDir: string): Record<string, unknown>[] {
  return readTraces(outputDir).filter((line) => line.kind === "boundary" && line.stage === "gate");
}

/** The sheet section of one trio entry, from its header to the next header. */
function sheetEntry(sheet: string, header: string): string {
  const start = sheet.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = sheet.slice(start + header.length);
  const next = rest.indexOf("\n## ");
  return next < 0 ? rest : rest.slice(0, next);
}

beforeEach(() => {
  loopState.hooks = null;
  loopState.passes = 0;
  loopState.passEvents = [];
  loopState.attemptDecisions = [];
  loopState.loopSettings = [];
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
  fs.mkdirSync(TEST_TMP, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
});

describe("receipt gate block", () => {
  it("records a shadow run's scores, latency, usage, stage count, and gate traces", async () => {
    const outputDir = path.join(TEST_TMP, "shadow");

    const exitCode = await bootRun(
      outputDir,
      gateConfig("shadow", "flag"),
      [
        [
          { kind: "attempt" },
          {
            kind: "gate",
            event: scoredGate({ mode: "shadow", decision: "maybe_lesson" }),
          },
          { kind: "trio", event: trioExamined(1) },
        ],
      ],
      LIMITS,
    );

    expect(exitCode).toBe(0);
    expect(loopState.loopSettings[0].gateMode).toBe("shadow");
    expect(loopState.attemptDecisions).toEqual([true]);
    const receipt = readReceipt(outputDir);
    expect(receipt.gate).toEqual({
      mode: "shadow",
      source: "flag",
      policyHash: HASH,
      model: MODEL,
      checks: 1,
      noLesson: 0,
      maybeLesson: 1,
      skipped: 0,
      fallbacks: {},
      requests: 1,
      latencyMsTotal: 12,
      usage: { inputTokens: 11, outputTokens: 5 },
    });
    expect(receipt.stages).toEqual({ gate: 1 });
    // The gate's request is counted, but its usage never enters the request totals.
    expect(receipt.requests.count).toBe(1);
    expect(receipt.requests.usageTotals).toEqual({ input: 0, output: 0, unknown: 0 });
    expect(receipt.counts.triosExamined).toBe(1);
    const gateLines = gateEventLines(outputDir);
    expect(gateLines).toHaveLength(1);
    expect(gateLines[0]).toMatchObject({ kind: "gate", decision: "maybe_lesson", routed: "extract" });
    expect(gateRequestTraces(outputDir)).toHaveLength(1);
    expect(readSheet(outputDir)).toContain(
      "Gate: maybe_lesson — correction 0.01, preference 0.02, steering 0.00, confusion 0.05",
    );
    expect(fs.readFileSync(path.join(outputDir, "running-table.md"), "utf-8")).toContain(
      "Covered: 1 of 26 eligible trios",
    );
  });

  it("counts fallbacks by reason and keeps their own line on the sheet", async () => {
    const outputDir = path.join(TEST_TMP, "fallback");
    const fallback = scoredGate({
      decision: "fallback",
      answers: null,
      fallbackReason: "http_500",
      model: null,
      usage: null,
      latencyMs: 40,
    });

    const exitCode = await bootRun(
      outputDir,
      gateConfig("shadow", "settings"),
      [[{ kind: "attempt" }, { kind: "gate", event: fallback }, { kind: "trio", event: trioExamined(1) }]],
      LIMITS,
    );

    expect(exitCode).toBe(0);
    const receipt = readReceipt(outputDir);
    expect(receipt.gate).toMatchObject({
      checks: 1,
      noLesson: 0,
      maybeLesson: 0,
      skipped: 0,
      fallbacks: { http_500: 1 },
      requests: 1,
      latencyMsTotal: 40,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const gateLines = readSheet(outputDir)
      .split("\n")
      .filter((line) => line.startsWith("Gate: "));
    expect(gateLines).toEqual(["Gate: fallback — fallback: http_500"]);
  });

  it("leaves the gate block zeroed and the traces without gate lines in an off run", async () => {
    const outputDir = path.join(TEST_TMP, "off");

    const exitCode = await bootRun(
      outputDir,
      gateConfig("off", "settings"),
      [[{ kind: "trio", event: trioExamined(1) }]],
      LIMITS,
    );

    expect(exitCode).toBe(0);
    const receipt = readReceipt(outputDir);
    expect(receipt.gate).toEqual({
      mode: "off",
      source: "settings",
      policyHash: HASH,
      model: MODEL,
      checks: 0,
      noLesson: 0,
      maybeLesson: 0,
      skipped: 0,
      fallbacks: {},
      requests: 0,
      latencyMsTotal: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(receipt.stages).toEqual({});
    expect(receipt.counts.triosExamined).toBe(1);
    expect(gateEventLines(outputDir)).toEqual([]);
    expect(gateRequestTraces(outputDir)).toEqual([]);
    expect(readSheet(outputDir)).not.toContain("Gate: ");
    expect(fs.readFileSync(path.join(outputDir, "running-table.md"), "utf-8")).toContain(
      "Covered: 1 of 26 eligible trios",
    );
  });
});

describe("sheet entries", () => {
  it("gives a skipped trio the gate scores and the not-run line instead of extractor output", async () => {
    const outputDir = path.join(TEST_TMP, "enforce");
    const skip = scoredGate({ routed: "skip" });
    const accepted = scoredGate({ decision: "maybe_lesson", latencyMs: 8 });

    const exitCode = await bootRun(
      outputDir,
      gateConfig("enforce", "flag"),
      [
        [
          { kind: "attempt" },
          { kind: "gate", event: skip },
          { kind: "attempt" },
          { kind: "gate", event: accepted },
          { kind: "trio", event: trioExamined(1) },
        ],
      ],
      LIMITS,
    );

    expect(exitCode).toBe(0);
    const receipt = readReceipt(outputDir);
    expect(receipt.gate).toMatchObject({ checks: 2, noLesson: 1, maybeLesson: 1, skipped: 1, requests: 2 });
    expect(receipt.stages).toEqual({ gate: 2 });
    // Examined counts stay examined-only; coverage adds the skipped trios.
    expect(receipt.counts.triosExamined).toBe(1);
    const sheet = readSheet(outputDir);
    expect(sheet).toContain("Trios examined: 1 · builds: 0");
    const skippedEntry = sheetEntry(sheet, "## Trio 1 (seed.jsonl)");
    expect(skippedEntry).toContain("Gate: no_lesson — correction 0.01, preference 0.02, steering 0.00, confusion 0.05");
    expect(skippedEntry).toContain(strings.sheetGateSkipped);
    expect(skippedEntry).not.toContain(`${strings.sheetColExtractor}:`);
    const examinedEntry = sheetEntry(sheet, "## Trio 2 (seed.jsonl)");
    expect(examinedEntry).toContain("Gate: maybe_lesson — correction 0.01");
    expect(examinedEntry).toContain(`${strings.sheetColExtractor}:`);
    expect(examinedEntry).not.toContain(strings.sheetGateSkipped);
    const table = fs.readFileSync(path.join(outputDir, "running-table.md"), "utf-8");
    expect(table).toContain("Covered: 2 of 26 eligible trios");
    const rows = table.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Trio ref"));
    expect(rows).toHaveLength(1);
  });

  it("keeps a rejected trio's gate event off the trio that follows it", async () => {
    const outputDir = path.join(TEST_TMP, "skip-pairing");
    const skip = scoredGate({ routed: "skip" });

    await bootRun(
      outputDir,
      gateConfig("enforce", "flag"),
      [[{ kind: "attempt" }, { kind: "gate", event: skip }, { kind: "trio", event: trioExamined(1) }]],
      LIMITS,
    );

    const sheet = readSheet(outputDir);
    expect(sheetEntry(sheet, "## Trio 1 (seed.jsonl)")).toContain(strings.sheetGateSkipped);
    const following = sheetEntry(sheet, "## Trio 2 (seed.jsonl)");
    expect(following).not.toContain("Gate: ");
    expect(following).toContain(`${strings.sheetColExtractor}:`);
  });

  it("attaches the latest pending gate event to the trio that follows, replacing an earlier one", async () => {
    const outputDir = path.join(TEST_TMP, "pending-pairing");
    const first = scoredGate({
      decision: "maybe_lesson",
      answers: { correction: 0.9, preference: 0, steering: 0, confusion: 0 },
    });
    const second = scoredGate({ decision: "no_lesson", latencyMs: 5 });

    await bootRun(
      outputDir,
      gateConfig("shadow", "flag"),
      [
        [
          { kind: "attempt" },
          { kind: "gate", event: first },
          { kind: "gate", event: second },
          { kind: "trio", event: trioExamined(1) },
        ],
      ],
      LIMITS,
    );

    const receipt = readReceipt(outputDir);
    expect(receipt.gate).toMatchObject({ checks: 2, noLesson: 1, maybeLesson: 1 });
    const sheet = readSheet(outputDir);
    expect(sheet).toContain("Gate: no_lesson — correction 0.01");
    expect(sheet).not.toContain("correction 0.90");
  });
});

describe("pass loop and ceiling", () => {
  it("counts a pass whose trios were all skipped as progress", async () => {
    const outputDir = path.join(TEST_TMP, "skip-progress");

    const exitCode = await bootRun(
      outputDir,
      gateConfig("enforce", "flag"),
      [[{ kind: "attempt" }, { kind: "gate", event: scoredGate({ routed: "skip" }) }], []],
      LIMITS,
    );

    expect(exitCode).toBe(0);
    expect(loopState.passes).toBe(2);
    const receipt = readReceipt(outputDir);
    expect(receipt.gate.skipped).toBe(1);
    // Only the gate request was made; no extraction followed a rejected trio.
    expect(receipt.requests.count).toBe(1);
    expect(receipt.counts.triosExamined).toBe(0);
    expect(fs.readFileSync(path.join(outputDir, "running-table.md"), "utf-8")).toContain(
      "Covered: 1 of 26 eligible trios",
    );
  });

  it("declines a gate attempt at the request ceiling, records the refusal, and ends capped", async () => {
    const outputDir = path.join(TEST_TMP, "ceiling");
    const scored = scoredGate({ decision: "maybe_lesson", usage: { inputTokens: 7, outputTokens: 3 } });
    const declined = scoredGate({
      decision: "fallback",
      answers: null,
      fallbackReason: "over_budget",
      model: null,
      usage: null,
      attempts: 0,
      latencyMs: 0,
    });

    const exitCode = await bootRun(
      outputDir,
      gateConfig("shadow", "flag"),
      [
        [
          { kind: "attempt" },
          { kind: "gate", event: scored },
          { kind: "attempt" },
          { kind: "gate", event: declined },
          { kind: "trio", event: trioExamined(1) },
        ],
      ],
      { ...LIMITS, maxModelRequests: 1 },
    );

    expect(exitCode).toBe(3);
    // The first attempt counted, the second was declined without a trace.
    expect(loopState.attemptDecisions).toEqual([true, false]);
    const receipt = readReceipt(outputDir);
    expect(receipt.stop.kind).toBe("capped");
    expect(receipt.requests.count).toBe(1);
    expect(receipt.requests.refused).toBe(1);
    expect(receipt.gate).toMatchObject({
      checks: 2,
      maybeLesson: 1,
      fallbacks: { over_budget: 1 },
      requests: 1,
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    // Both events are recorded, but only the first one became a request.
    expect(gateEventLines(outputDir)).toHaveLength(2);
    expect(gateRequestTraces(outputDir)).toHaveLength(1);
  });
});

describe("--gate-mode", () => {
  const savedEnv: Record<string, string | undefined> = {};

  function makeSnapshot(name: string): string {
    const live = path.join(TEST_TMP, `live-${name}`);
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, "portrait.md"), "# Portrait\n", "utf-8");
    const snap = path.join(TEST_TMP, `snap-${name}`);
    snapshotPortraitState(live, snap);
    return snap;
  }

  function executeArgs(snap: string, outputDir: string): Record<string, string> {
    return {
      _: "execute",
      "run-type": "smoke",
      "max-model-requests": "5",
      "max-run-ms": "900000",
      "limits-source": "compass-table",
      scope: "all",
      "start-snapshot": snap,
      output: outputDir,
      "run-id": "run-gate-mode",
    };
  }

  /** Refuse at the confirmation (no --confirmed, no terminal): the block lands on stderr. */
  async function runToConfirmation(args: Record<string, string>): Promise<{ code: number; printed: string }> {
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const code = await executeRun(args, { confirmed: false, isTTY: false });
      return { code, printed: writeSpy.mock.calls.map((call) => String(call[0])).join("") };
    } finally {
      writeSpy.mockRestore();
    }
  }

  beforeEach(() => {
    savedEnv.PI_PORTRAIT_STATE_DIR = process.env.PI_PORTRAIT_STATE_DIR;
    savedEnv.PI_PORTRAIT_SESSION_DIRS = process.env.PI_PORTRAIT_SESSION_DIRS;
    delete process.env.PI_PORTRAIT_STATE_DIR;
    delete process.env.PI_PORTRAIT_SESSION_DIRS;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete savedEnv[key];
    }
  });

  it("refuses an unknown value with the approved message before any run artifact exists", async () => {
    const snap = makeSnapshot("bad-mode");
    const outputDir = path.join(TEST_TMP, "run-bad-mode");
    const args = executeArgs(snap, outputDir);
    args["gate-mode"] = "sideways";

    const { code, printed } = await runToConfirmation(args);

    expect(code).toBe(2);
    expect(printed).toBe(`${strings.invalidGateMode}\n`);
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it("carries a flag-selected mode into the confirmation and the manifest", async () => {
    const snap = makeSnapshot("flag-mode");
    const outputDir = path.join(TEST_TMP, "run-flag-mode");
    const args = executeArgs(snap, outputDir);
    args["gate-mode"] = "shadow";

    const { code, printed } = await runToConfirmation(args);

    expect(code).toBe(2);
    expect(printed).toContain(strings.confirmGate("shadow", LIVE_HASH));
    expect(printed).not.toContain(strings.confirmGateOff);
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf-8")) as {
      gate: GateRunConfig;
    };
    expect(manifest.gate).toEqual({ mode: "shadow", source: "flag", policyHash: LIVE_HASH, model: MODEL });
  });

  it("falls back to the settings snapshot's mode and records it as the source", async () => {
    const snap = makeSnapshot("settings-mode");
    const outputDir = path.join(TEST_TMP, "run-settings-mode");

    const { code, printed } = await runToConfirmation(executeArgs(snap, outputDir));

    expect(code).toBe(2);
    const snapshot = JSON.parse(fs.readFileSync(path.join(outputDir, "settings-snapshot.json"), "utf-8")) as {
      portraitSettings: { gateMode?: unknown };
    };
    const raw = snapshot.portraitSettings.gateMode;
    const modes = ["off", "shadow", "enforce"];
    const mode = typeof raw === "string" && modes.includes(raw) ? raw : "off";
    expect(printed).toContain(mode === "off" ? strings.confirmGateOff : strings.confirmGate(mode, LIVE_HASH));
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf-8")) as {
      gate: GateRunConfig;
    };
    expect(manifest.gate).toEqual({ mode, source: "settings", policyHash: LIVE_HASH, model: MODEL });
  });

  it("records the resolved gate at prepare time, flag or settings", async () => {
    const snap = makeSnapshot("prepare-mode");
    const workspace = path.join(TEST_TMP, "ws-gate");
    fs.mkdirSync(workspace, { recursive: true });
    const flagDir = path.join(TEST_TMP, "prepare-flag");
    const settingsDir = path.join(TEST_TMP, "prepare-settings");

    const withFlag = await prepareRun({
      scope: "all",
      outputDir: flagDir,
      runId: "run-prepare-flag",
      workspaceRoot: workspace,
      limits: LIMITS,
      suggested: null,
      startSnapshotDir: snap,
      gateModeArg: "enforce",
    });
    const withoutFlag = await prepareRun({
      scope: "all",
      outputDir: settingsDir,
      runId: "run-prepare-settings",
      workspaceRoot: workspace,
      limits: LIMITS,
      suggested: null,
      startSnapshotDir: snap,
    });

    expect(withFlag.gate).toEqual({ mode: "enforce", source: "flag", policyHash: LIVE_HASH, model: MODEL });
    expect(withoutFlag.gate.source).toBe("settings");
    expect(withoutFlag.gate.policyHash).toBe(LIVE_HASH);
    expect(withoutFlag.gate.model).toBe(MODEL);
    const flagManifest = JSON.parse(fs.readFileSync(path.join(flagDir, "manifest.json"), "utf-8")) as {
      gate: GateRunConfig;
    };
    expect(flagManifest.gate).toEqual(withFlag.gate);
  });
});
