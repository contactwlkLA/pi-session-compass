// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Collect keeps scanning while the last file still has trios: one runPipelineLoop call
 * covers the trios of every file up to maxSequences, remainingFiles counts a file whose
 * pass stopped at its limit before the file's end, and a file read to its end is done.
 *
 * The extraction LLM is mocked to return exactly one note per trio, so every detected
 * trio is productive. discoverFiles scans newest mtime first, so the older file is the
 * one scanned last.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, type vi } from "vitest";
import { buildPortrait } from "../src/builder.js";
import { scanSessions } from "../src/collector.js";
import { callPortraitLlm } from "../src/llm-call.js";
import { resetPipelineState, runPipelineLoop } from "../src/pipeline.js";
import type { PortraitSettings } from "../src/schema.js";
import type { PortraitPipelineState } from "../src/types.js";
import { DEFAULT_PIPELINE_STATE } from "../src/types.js";
import { setupTestSettings, teardownTestSettings } from "./settings-helpers.js";
import { getStubPortraitState, setTestConfig, useStubs } from "./setup.js";

const mockCallPortraitLlm = callPortraitLlm as unknown as ReturnType<typeof vi.fn>;
const mockBuildPortrait = buildPortrait as unknown as ReturnType<typeof vi.fn>;

let portraitDir: string;
let sessionDir: string;
let settings: PortraitSettings;

const HEADER = JSON.stringify({ type: "session", id: "collect-remaining-session" });

function assistantRecord(text: string): string {
  return JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
}

function userRecord(text: string): string {
  return JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
}

/**
 * The fixture, with the expected counts derived before the assertions:
 *
 * | file    | records (after the header) | productive trios | user feedback | trio completes at |
 * |---------|----------------------------|------------------|---------------|-------------------|
 * | a.jsonl | A1, U1, A2                 | 1                | U1            | A2, the last record |
 * | b.jsonl | B1, U2, B2, B3, U3, B4     | 2                | U2; U3        | B2 mid-file; B4 last |
 * | total   |                            | 3                |               |                   |
 *
 * a.jsonl is newer, so it is scanned first and b.jsonl is the file scanned last.
 */
const A_RECORDS = [HEADER, assistantRecord("A1 plan"), userRecord("U1 feedback"), assistantRecord("A2 reply")];
const B_RECORDS = [
  HEADER,
  assistantRecord("B1 plan"),
  userRecord("U2 feedback"),
  assistantRecord("B2 reply"),
  assistantRecord("B3 plan"),
  userRecord("U3 feedback"),
  assistantRecord("B4 reply"),
];
const ALL_FEEDBACK = ["U1 feedback", "U2 feedback", "U3 feedback"];

function writeSession(filePath: string, lines: string[], mtimeMs: number): void {
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
  const at = new Date(mtimeMs);
  fs.utimesSync(filePath, at, at);
}

/** Pull the user-feedback block out of the extraction prompt the SUT sends to the LLM. */
function userFeedbackFromPrompt(messages: unknown): string {
  const list = messages as Array<{ content: Array<{ text: string }> }>;
  const prompt = list[0]?.content?.[0]?.text ?? "";
  const match = /<user-feedback>\n([\s\S]*?)\n<\/user-feedback>/.exec(prompt);
  return match ? match[1] : "";
}

function freshState(): PortraitPipelineState {
  return { ...DEFAULT_PIPELINE_STATE };
}

/** The user feedback of every extraction call, in order. */
function extractedFeedback(): string[] {
  return mockCallPortraitLlm.mock.calls.map((call: unknown[]) => userFeedbackFromPrompt(call[0]));
}

describe("collect keeps scanning while the last file has trios", () => {
  beforeEach(() => {
    portraitDir = fs.mkdtempSync(path.join(os.tmpdir(), "collect-remaining-"));
    sessionDir = path.join(portraitDir, "sessions", "test-project");
    fs.mkdirSync(sessionDir, { recursive: true });
    setTestConfig({ portraitDir, sessionDirs: [path.join(portraitDir, "sessions")] });
    // Real collector and work state; no LLM or subprocess outside the extraction mock.
    useStubs({ builder: true, storage: true, footer: true, maintenanceCore: true, error: true, git: true });
    settings = setupTestSettings({
      debugDumpLimit: 0,
      postExtractionEnabled: false,
      rateLimitMs: 0,
      maintenanceEveryNRulesInserted: 200,
    });
    resetPipelineState();
    getStubPortraitState().rulesInsertedSinceMaintenance = 0;
    mockCallPortraitLlm.mockReset();
    mockBuildPortrait.mockReset();
    // Every batch builds successfully: one rule inserted, nothing evicted.
    mockBuildPortrait.mockResolvedValue({
      inserted: 1,
      merged: 0,
      evicted: 0,
      rules: [],
      evictedRules: [],
      droppedRules: [],
    });
    mockCallPortraitLlm.mockImplementation(async (messages: unknown) => {
      const userFeedback = userFeedbackFromPrompt(messages);
      return {
        notes: [userFeedback],
        summary: { agentBefore: "agent before", userFeedback, agentAfter: "agent after" },
      };
    });
  });

  afterEach(() => {
    teardownTestSettings();
    fs.rmSync(portraitDir, { recursive: true, force: true });
  });

  it("processes all three trios of two files in one run", async () => {
    const now = Date.now();
    writeSession(path.join(sessionDir, "a.jsonl"), A_RECORDS, now);
    writeSession(path.join(sessionDir, "b.jsonl"), B_RECORDS, now - 60_000);

    const stats = await runPipelineLoop(settings, 3, () => false, null);

    expect(stats.stopReason).toBeNull();
    expect(stats.totalSequences).toBe(3);
    expect(extractedFeedback()).toEqual(ALL_FEEDBACK);
  });

  it("counts a file with unread records after a limit stop as remaining", async () => {
    writeSession(path.join(sessionDir, "b.jsonl"), B_RECORDS, Date.now());

    const result = await scanSessions(portraitDir, freshState(), 10, 1);

    expect(result.results).toHaveLength(1);
    expect(result.remainingFiles).toBe(1);
  });

  it("does not count a file read to its end as remaining", async () => {
    writeSession(path.join(sessionDir, "a.jsonl"), A_RECORDS, Date.now());

    const result = await scanSessions(portraitDir, freshState(), 10, 1);

    expect(result.results).toHaveLength(1);
    expect(result.remainingFiles).toBe(0);
  });

  it.skipIf(!fs.existsSync("/proc/self/fd"))(
    "closes the session file read stream when a pass stops at its limit",
    async () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        writeSession(path.join(sessionDir, `b${i}.jsonl`), B_RECORDS, now - i * 60_000);
      }

      for (let i = 0; i < 5; i++) {
        const result = await scanSessions(portraitDir, freshState(), 10, 1);
        expect(result.results).toHaveLength(1);
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
      const openUnderPortrait = fs
        .readdirSync("/proc/self/fd")
        .map((name) => {
          try {
            return fs.readlinkSync(path.join("/proc/self/fd", name));
          } catch {
            return "";
          }
        })
        .filter((target) => target.startsWith(portraitDir));

      expect(openUnderPortrait).toEqual([]);
    },
  );
});
