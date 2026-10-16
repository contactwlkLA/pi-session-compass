// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Receipt validationRounds: per-stage attempt counts keyed by validation round,
 * aggregated from the attempt events, while the existing stages key stays
 * unchanged. Offline — the pipeline loop and src modules are mocked, no model
 * calls.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPipeline } from "../../scripts/compass/pipeline-boot.js";
import { strings } from "../../scripts/compass/strings.js";
import type { Limits, RunSelection } from "../../scripts/compass/types.js";

const ROOT = process.cwd();
// Unique per test-file run so overlapping suite runs never share a directory.
const TEST_TMP_ROOT = path.join(ROOT, "outputs", "test-tmp");
fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
const TEST_TMP = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "validation-rounds-receipt-"));

const LIMITS: Limits = { runType: "smoke", maxModelRequests: 5, maxRunMs: 900_000, source: "compass-table" };

const state = vi.hoisted(() => ({
  sink: null as ((event: unknown) => void) | null,
  events: [] as Record<string, unknown>[],
  sequences: 0,
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
  setLlmAttemptSink: (sink: ((event: unknown) => void) | null) => {
    state.sink = sink;
  },
  setCapturedModel: () => {},
}));

vi.mock("../../src/instrument.js", () => ({
  setInstrumentHooks: () => {},
}));

vi.mock("../../src/pipeline.js", () => ({
  runPipelineLoop: async () => {
    for (const event of state.events) state.sink?.(event);
    return { totalSequences: state.sequences, totalInserted: 0, totalEvicted: 0, stopReason: null };
  },
}));

function attemptEvent(stage: string, validationRound: number): Record<string, unknown> {
  return {
    stage,
    attempt: 1,
    validationRound,
    model: "test-model",
    provider: "meta",
    startedAtMs: 1,
    endedAtMs: 2,
    ok: true,
  };
}

function selectionFor(outputDir: string): RunSelection {
  return { scope: "all", runId: "t-rounds", outputDir, createdAt: new Date(0).toISOString() };
}

function writeSettingsSnapshot(outputDir: string): void {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "settings-snapshot.json"),
    JSON.stringify({ portraitSettings: { model: "meta/test-model" }, hostPiSettings: {} }),
    "utf-8",
  );
}

beforeEach(() => {
  state.sink = null;
  state.events = [];
  state.sequences = 0;
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
});

describe("receipt validationRounds", () => {
  it("aggregates attempt counts per stage and round, keeping stages unchanged", async () => {
    state.events = [
      attemptEvent("building", 1),
      attemptEvent("building", 1),
      attemptEvent("building", 1),
      attemptEvent("building", 1),
      attemptEvent("building", 2),
      attemptEvent("maintenance", 1),
    ];
    const outputDir = path.join(TEST_TMP, "run");
    writeSettingsSnapshot(outputDir);

    const exitCode = await runPipeline({
      limits: LIMITS,
      prepared: { selection: selectionFor(outputDir), census: null },
      outputDir,
      confirmMode: "flag",
    });

    expect(exitCode).toBe(0);
    const receipt = JSON.parse(fs.readFileSync(path.join(outputDir, "receipt.json"), "utf-8")) as {
      stages: Record<string, number>;
      validationRounds: Record<string, Record<string, number>>;
    };
    expect(receipt.validationRounds).toEqual({ building: { "1": 4, "2": 1 }, maintenance: { "1": 1 } });
    expect(receipt.stages).toEqual({ building: 5, maintenance: 1 });
  });
});

describe("receipt completion stop reason", () => {
  it("reports the pipeline's real processed-sequence count", async () => {
    state.events = [];
    state.sequences = 3;
    const outputDir = path.join(TEST_TMP, "run-seq");
    writeSettingsSnapshot(outputDir);

    const exitCode = await runPipeline({
      limits: LIMITS,
      prepared: { selection: selectionFor(outputDir), census: null },
      outputDir,
      confirmMode: "flag",
    });

    expect(exitCode).toBe(0);
    const receipt = JSON.parse(fs.readFileSync(path.join(outputDir, "receipt.json"), "utf-8")) as {
      stop: { reason: string };
    };
    expect(receipt.stop.reason).toBe(strings.stopCompleted(3));
  });
});
