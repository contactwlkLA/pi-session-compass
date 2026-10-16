// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Sink-guard receipt wiring in runPipeline:
 * a sink error recorded before a pipeline crash must reach the error receipt's
 * sinkErrors key, and a run that records none must not write that key at all.
 *
 * runPipeline imports the model runtime, the portrait pipeline, and the
 * instrumentation sinks dynamically; the mocks below replace them so the wiring
 * is exercised offline — no model calls, no network, no credentials.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPipeline } from "../../scripts/compass/pipeline-boot.js";
import { strings } from "../../scripts/compass/strings.js";
import type { Limits, RunSelection } from "../../scripts/compass/types.js";

const ROOT = process.cwd();
const TEST_TMP = path.join(ROOT, "outputs", "test-tmp", "receipt-sink-errors");

const LIMITS: Limits = { runType: "smoke", maxModelRequests: 5, maxRunMs: 900_000, source: "compass-table" };

/** Mutable controls shared with the module mocks (hoisted above the imports). */
const sinkState = vi.hoisted(() => ({
  mode: "clean" as "clean" | "sink-then-crash" | "sink-then-stop",
  hooks: null as Record<string, (event: unknown) => void> | null,
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
  setInstrumentHooks: (hooks: Record<string, (event: unknown) => void>) => {
    sinkState.hooks = hooks;
  },
}));

/** Emit a trio event whose `notes` getter throws, so the sink guard records an error. */
function emitPoisonedTrio(): void {
  const poison: { sessionPath: string; notes?: number } = { sessionPath: "/tmp/session.jsonl" };
  Object.defineProperty(poison, "notes", {
    get() {
      throw new Error("sink boom");
    },
  });
  sinkState.hooks?.onTrioExamined?.(poison);
}

vi.mock("../../src/pipeline.js", () => ({
  runPipelineLoop: async () => {
    if (sinkState.mode === "sink-then-crash") {
      // A poisoned event makes the internal "trioExamined" sink callback throw;
      // the guard records it, then the loop itself crashes.
      emitPoisonedTrio();
      throw new Error("pipeline crash");
    }
    if (sinkState.mode === "sink-then-stop") {
      // A poisoned event records a sink error, then the pass stops on a pipeline failure.
      emitPoisonedTrio();
      return { totalSequences: 1, totalInserted: 0, totalEvicted: 0, stopReason: "build_failed" };
    }
    return { totalSequences: 0, totalInserted: 0, totalEvicted: 0, stopReason: null };
  },
}));

function selectionFor(outputDir: string): RunSelection {
  return { scope: "all", runId: "t-sink", outputDir, createdAt: new Date(0).toISOString() };
}

function writeSettingsSnapshot(outputDir: string): void {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "settings-snapshot.json"),
    JSON.stringify({
      portraitSettings: { model: "meta/test-model" },
      hostPiSettings: { defaultProvider: "meta", defaultModel: "test-model" },
    }),
    "utf-8",
  );
}

function readReceipt(outputDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(outputDir, "receipt.json"), "utf-8")) as Record<string, unknown>;
}

beforeEach(() => {
  sinkState.mode = "clean";
  sinkState.hooks = null;
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
});

describe("runPipeline sink-error receipts", () => {
  it("keeps a sink error recorded before a pipeline crash in the error receipt", async () => {
    sinkState.mode = "sink-then-crash";
    const outputDir = path.join(TEST_TMP, "sink-then-crash");
    writeSettingsSnapshot(outputDir);

    const exitCode = await runPipeline({
      limits: LIMITS,
      prepared: { selection: selectionFor(outputDir), census: null },
      outputDir,
      confirmMode: "flag",
    });

    expect(exitCode).toBe(1);
    const receipt = readReceipt(outputDir);
    expect(receipt.sinkErrors).toEqual([{ hook: "trioExamined", error: "sink boom" }]);
    expect(receipt.stop).toMatchObject({ kind: "error" });
    expect(String(receipt.error)).toContain("pipeline crash");
  });

  it("reports error when a sink error and a pipeline stop land in the same run", async () => {
    sinkState.mode = "sink-then-stop";
    const outputDir = path.join(TEST_TMP, "sink-then-stop");
    writeSettingsSnapshot(outputDir);

    const exitCode = await runPipeline({
      limits: LIMITS,
      prepared: { selection: selectionFor(outputDir), census: null },
      outputDir,
      confirmMode: "flag",
    });

    expect(exitCode).toBe(1);
    const receipt = readReceipt(outputDir);
    expect(receipt.stop).toEqual({ kind: "error", reason: strings.errorSeeReceipt });
  });

  it("omits the sinkErrors key entirely when no sink error was recorded", async () => {
    const outputDir = path.join(TEST_TMP, "clean");
    writeSettingsSnapshot(outputDir);

    const exitCode = await runPipeline({
      limits: LIMITS,
      prepared: { selection: selectionFor(outputDir), census: null },
      outputDir,
      confirmMode: "flag",
    });

    expect(exitCode).toBe(0);
    const receipt = readReceipt(outputDir);
    expect("sinkErrors" in receipt).toBe(false);
    expect(receipt.stop).toMatchObject({ kind: "completed" });
  });
});
