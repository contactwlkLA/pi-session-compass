// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * buildPortrait's validation loop tags each call with validationRound=1 on the
 * first try and +1 after every failed validation, stage "building" unless the
 * caller passes stageTag (maintenance backfill passes "maintenance").
 * llm-call is mocked centrally, so this observes the arguments
 * that produce the attempt events.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type vi } from "vitest";
import { buildPortrait } from "../src/builder.js";
import { initGit, resetGitExec, setGitExec } from "../src/git.js";
import { type BuildEvent, setInstrumentHooks } from "../src/instrument.js";
import { callPortraitLlm } from "../src/llm-call.js";
import { installRecordingGit } from "./git-recorder.js";
import { setupTestSettings, teardownTestSettings } from "./settings-helpers.js";

const mockCallPortraitLlm = callPortraitLlm as unknown as ReturnType<typeof vi.fn>;

// Route git through the recording runner (no subprocesses): tests assert on commit attempts.
const recording = installRecordingGit();

beforeAll(() => {
  setGitExec(recording.runner);
});

afterAll(() => {
  resetGitExec();
});

let portraitDir: string;

function writeTestPortrait(dir: string, rules: string[]): void {
  const content = `# User Portrait\n\n## Anticipation Rules\n${rules.join("\n")}\n`;
  fs.writeFileSync(path.join(dir, "portrait.md"), content, "utf-8");
}

beforeEach(() => {
  mockCallPortraitLlm.mockReset();
  portraitDir = path.join(os.tmpdir(), `portrait-builder-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(portraitDir, { recursive: true });
  initGit(portraitDir);
  setupTestSettings(null);
});

afterEach(() => {
  setInstrumentHooks({});
  teardownTestSettings();
  fs.rmSync(portraitDir, { recursive: true, force: true });
});

describe("buildPortrait validationRound", () => {
  it("tags a failed validation then a passed one as building rounds 1 then 2", async () => {
    writeTestPortrait(portraitDir, ["rule 1"]);
    mockCallPortraitLlm
      .mockResolvedValueOnce({ decisions: [{ action: "merge", candidate: "C1" }] }) // invalid: no mergePosition
      .mockResolvedValueOnce({ decisions: [{ action: "skip", candidate: "C1" }] });

    const result = await buildPortrait(portraitDir, ["candidate one"], undefined);

    expect(result).toBeDefined();
    expect(mockCallPortraitLlm).toHaveBeenCalledTimes(2);
    const stages = mockCallPortraitLlm.mock.calls.map((call) => call[8]);
    const rounds = mockCallPortraitLlm.mock.calls.map((call) => call[9]);
    expect(stages).toEqual(["building", "building"]);
    expect(rounds).toEqual([1, 2]);
  });

  it("tags attempts with the stageTag option when given", async () => {
    writeTestPortrait(portraitDir, ["rule 1"]);
    mockCallPortraitLlm.mockResolvedValueOnce({ decisions: [{ action: "skip", candidate: "C1" }] });

    await buildPortrait(portraitDir, ["candidate one"], { skipPersist: true, stageTag: "maintenance" });

    expect(mockCallPortraitLlm.mock.calls.map((call) => call[8])).toEqual(["maintenance"]);
  });
});

describe("return_building tool", () => {
  it("ends the agent loop on a successful capture", async () => {
    writeTestPortrait(portraitDir, ["rule 1"]);
    mockCallPortraitLlm.mockResolvedValueOnce({ decisions: [{ action: "skip", candidate: "C1" }] });

    await buildPortrait(portraitDir, ["candidate one"], undefined);

    const tool = mockCallPortraitLlm.mock.calls[0][2] as AgentTool;
    const toolResult = await tool.execute("call-1", { decisions: [] }, undefined, () => {});
    expect(toolResult.terminate).toBe(true);
  });
});

describe("buildPortrait whole-batch validation", () => {
  it("an all-skip batch writes no file and records no commit", async () => {
    writeTestPortrait(portraitDir, ["rule 1"]);
    const portraitPath = path.join(portraitDir, "portrait.md");
    const bytesBefore = fs.readFileSync(portraitPath);
    const mtimeBefore = fs.statSync(portraitPath).mtimeMs;
    const logBefore = recording.getCommitLog(portraitDir);
    // initGit seeds dropped.md and evicted.md with headers — they must stay untouched.
    const droppedBefore = fs.readFileSync(path.join(portraitDir, "dropped.md"), "utf-8");
    const evictedBefore = fs.readFileSync(path.join(portraitDir, "evicted.md"), "utf-8");
    mockCallPortraitLlm.mockResolvedValueOnce({ decisions: [{ action: "skip", candidate: "C1" }] });

    const result = await buildPortrait(portraitDir, ["candidate text"], undefined);

    expect(result).toEqual({ inserted: 0, merged: 0, evicted: 0, rules: [], evictedRules: [], droppedRules: [] });
    expect(fs.readFileSync(portraitPath)).toEqual(bytesBefore);
    expect(fs.statSync(portraitPath).mtimeMs).toBe(mtimeBefore);
    expect(fs.readFileSync(path.join(portraitDir, "dropped.md"), "utf-8")).toBe(droppedBefore);
    expect(fs.readFileSync(path.join(portraitDir, "evicted.md"), "utf-8")).toBe(evictedBefore);
    expect(recording.getCommitLog(portraitDir)).toBe(logBefore);
  });

  it("retries a reply missing a candidate and applies the complete one", async () => {
    writeTestPortrait(portraitDir, ["rule 1"]);
    mockCallPortraitLlm
      .mockResolvedValueOnce({ decisions: [{ action: "insert", candidate: "C1", beforePosition: 1 }] }) // missing C2
      .mockResolvedValueOnce({
        decisions: [
          { action: "insert", candidate: "C1", beforePosition: 1 },
          { action: "skip", candidate: "C2" },
        ],
      });

    const result = await buildPortrait(portraitDir, ["NEW1", "NEW2"], undefined);

    expect(result?.inserted).toBe(1);
    expect(mockCallPortraitLlm).toHaveBeenCalledTimes(2);
    expect(mockCallPortraitLlm.mock.calls.map((call) => call[9])).toEqual([1, 2]);
    const followUpMessages = mockCallPortraitLlm.mock.calls[1][0] as Array<{
      role: string;
      content: Array<{ type: string; text: string }>;
    }>;
    expect(followUpMessages[1].content[0].text).toBe(
      "Missing decisions for C2. Return exactly one decision for each candidate C1 to C2.",
    );
    expect(fs.readFileSync(path.join(portraitDir, "portrait.md"), "utf-8")).toContain("NEW1");
    expect(recording.getLatestCommit(portraitDir)).toContain("1 rule added");
  });
});

describe("build event candidateText", () => {
  it("resolves the candidate's text onto the emitted decision", async () => {
    writeTestPortrait(portraitDir, ["rule 1"]);
    const events: BuildEvent[] = [];
    setInstrumentHooks({ onBuild: (event) => events.push(event) });
    mockCallPortraitLlm.mockResolvedValueOnce({
      decisions: [{ action: "insert", candidate: "C1", beforePosition: 1 }],
    });

    await buildPortrait(portraitDir, ["candidate one"], undefined);

    expect(events).toHaveLength(1);
    expect(events[0].decisions).toEqual([{ action: "insert", candidate: "C1", candidateText: "candidate one" }]);
  });
});
