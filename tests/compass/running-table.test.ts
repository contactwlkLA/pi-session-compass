// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Running table: rendering of the cumulative per-trio rows, and the runPipeline
 * wiring that captures each row when its trio is examined (counts and portrait
 * size as of that moment, so build effects trail the extraction counts).
 *
 * The pipeline and model runtime are mocked; no model calls, no network.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunningRow, renderRunningTable, runPipeline } from "../../scripts/compass/pipeline-boot.js";
import { strings } from "../../scripts/compass/strings.js";
import type { CensusResult, Limits, RunSelection } from "../../scripts/compass/types.js";

const ROOT = process.cwd();
const TEST_TMP = path.join(ROOT, "outputs", "test-tmp", "running-table");

const LIMITS: Limits = { runType: "baseline", maxModelRequests: 50, maxRunMs: 900_000, source: "user-override" };

const loopState = vi.hoisted(() => ({
  hooks: null as Record<string, (event: unknown) => void> | null,
  portraitDir: "",
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
    loopState.hooks = hooks;
  },
}));

function writePortrait(dir: string, rules: string[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "portrait.md"),
    `# Portrait\n\n## Anticipation Rules\n${rules.join("\n")}\n`,
    "utf-8",
  );
}

vi.mock("../../src/pipeline.js", () => ({
  runPipelineLoop: async () => {
    const session = "/tmp/sessions/seed.jsonl";
    const emit = (hook: string, event: unknown) => loopState.hooks?.[hook]?.(event);
    emit("onTrioExamined", { sessionPath: session, notes: 2, notesText: ["a", "b"] });
    emit("onTrioExamined", { sessionPath: session, notes: 0, notesText: [] });
    writePortrait(loopState.portraitDir, ["r1", "r2", "r3"]);
    emit("onBuild", {
      decisions: [
        { action: "insert", candidate: "a", text: "r3" },
        { action: "merge", candidate: "b", text: "r2" },
      ],
      inserted: 1,
      evicted: 0,
    });
    emit("onTrioExamined", { sessionPath: session, notes: 1, notesText: ["c"] });
    return { totalSequences: 1, totalInserted: 1, totalEvicted: 0 };
  },
}));

function selectionFor(outputDir: string): RunSelection {
  return { scope: "file", runId: "t-running", outputDir, createdAt: new Date(0).toISOString() };
}

const CENSUS: CensusResult = { file: "seed.jsonl", sha256: "x", totalTrios: 26, nonEmptyLines: 100, trios: [] };

beforeEach(() => {
  loopState.hooks = null;
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
});

describe("running-table strings", () => {
  it("formats titles, coverage, and cells", () => {
    expect(strings.resultsSheetTitle("smoke")).toBe("compass smoke results — samples, not a measurement");
    expect(strings.runningTableTitle("baseline")).toBe("compass baseline — running table");
    expect(strings.runningTableCovered(10, 26)).toBe("Covered: 10 of 26 eligible trios");
    expect(strings.runningTableTrioRef(3, "seed.jsonl")).toBe("3 (seed.jsonl)");
    expect(strings.runningTableRate(4, 10)).toBe("4/10 (40%)");
    expect(strings.runningTableRate(1, 3)).toBe("1/3 (33%)");
    expect(strings.runningTableRate(0, 0)).toBe("0/0 (0%)");
    expect(strings.runningTableImS(2, 1, 0)).toBe("2 / 1 / 0");
    expect(strings.runningTablePortraitSize(14)).toBe("14 rules");
  });
});

describe("renderRunningTable", () => {
  const row: RunningRow = {
    file: "seed.jsonl",
    examined: 1,
    productive: 1,
    candidates: 2,
    inserted: 0,
    merged: 0,
    skipped: 0,
    portraitRules: 12,
  };

  it("renders the header, coverage line, note, and one row per trio", () => {
    const text = renderRunningTable("baseline", [row], 26);
    expect(text.split("\n")).toEqual([
      "compass baseline — running table",
      "",
      "Covered: 1 of 26 eligible trios",
      strings.runningTableNote,
      "",
      "| Trio ref | Trios examined | Cumulative productive rate | Cumulative candidates | Insert / merge / skip | Portrait size |",
      "|---|---|---|---|---|---|",
      "| 1 (seed.jsonl) | 1 | 1/1 (100%) | 2 | 0 / 0 / 0 | 12 rules |",
      "",
    ]);
  });

  it("omits the coverage line without a census", () => {
    const text = renderRunningTable("smoke", [], null);
    expect(text).not.toContain("Covered:");
    expect(text.startsWith("compass smoke — running table\n")).toBe(true);
  });
});

describe("runPipeline running table", () => {
  it("captures cumulative counts and portrait size as of each examined trio", async () => {
    const outputDir = path.join(TEST_TMP, "run");
    loopState.portraitDir = path.join(outputDir, "portrait");
    writePortrait(loopState.portraitDir, ["r1", "r2"]);
    fs.writeFileSync(
      path.join(outputDir, "settings-snapshot.json"),
      JSON.stringify({ portraitSettings: { model: "meta/test-model" }, hostPiSettings: {} }),
      "utf-8",
    );

    const exitCode = await runPipeline({
      limits: LIMITS,
      prepared: { selection: selectionFor(outputDir), census: CENSUS },
      outputDir,
      confirmMode: "flag",
    });

    expect(exitCode).toBe(0);
    const table = fs.readFileSync(path.join(outputDir, "running-table.md"), "utf-8");
    expect(table).toContain("Covered: 3 of 26 eligible trios");
    const rows = table.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Trio ref"));
    expect(rows).toEqual([
      "| 1 (seed.jsonl) | 1 | 1/1 (100%) | 2 | 0 / 0 / 0 | 2 rules |",
      "| 2 (seed.jsonl) | 2 | 1/2 (50%) | 2 | 0 / 0 / 0 | 2 rules |",
      "| 3 (seed.jsonl) | 3 | 2/3 (67%) | 3 | 1 / 1 / 0 | 3 rules |",
    ]);
    const sheet = fs.readFileSync(path.join(outputDir, "results-sheet.md"), "utf-8");
    expect(sheet.startsWith("compass baseline results — samples, not a measurement\n")).toBe(true);
  });
});
