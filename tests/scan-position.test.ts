// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Scan-position tests: restarting a scan must emit the same trios in the same order as an
 * uninterrupted detector over the same session file.
 *
 * One scanSessions call with maxResults = 1 is one pass. The extraction LLM is mocked to
 * return exactly one note per trio — the trio's user feedback — so every detected trio is
 * productive and the pass ends at it, forcing the next pass to resume. scanAll runs passes
 * until a pass returns no results and collects the notes of every examined trio in order.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, type vi } from "vitest";
import { scanSessions } from "../src/collector.js";
import { reportError } from "../src/error.js";
import { callPortraitLlm } from "../src/llm-call.js";
import type { SessionEntry } from "../src/trio-detector.js";
import { TrioDetector } from "../src/trio-detector.js";
import type { PortraitPipelineState } from "../src/types.js";
import { DEFAULT_PIPELINE_STATE } from "../src/types.js";
import { setupTestSettings, teardownTestSettings } from "./settings-helpers.js";
import { setTestConfig, useStubs } from "./setup.js";

const mockCallPortraitLlm = callPortraitLlm as unknown as ReturnType<typeof vi.fn>;
const mockReportError = reportError as unknown as ReturnType<typeof vi.fn>;

let portraitDir: string;
let sessionDir: string;

const SESSION_ID = "scan-position-session";
const HEADER = JSON.stringify({ type: "session", id: SESSION_ID });
const REWRITTEN_ERROR = (filePath: string): string =>
  `Stopped scanning ${filePath}: the file was truncated or rewritten after it was last scanned. Its scan position was kept.`;
const MALFORMED_ERROR = (filePath: string, offset: number): string =>
  `Stopped scanning ${filePath}: malformed record at byte ${offset}.`;

function assistantRecord(text: string): string {
  return JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
}

function userRecord(text: string): string {
  return JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
}

/** Write complete records: each on its own LF-terminated line. */
function writeSession(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
}

function parseRecord(line: string): SessionEntry | null {
  try {
    return JSON.parse(line) as SessionEntry;
  } catch {
    return null;
  }
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

function readCheckpoint(filePath: string): number | undefined {
  const checkpointFile = path.join(portraitDir, "processed-sessions.json");
  if (!fs.existsSync(checkpointFile)) return undefined;
  const all = JSON.parse(fs.readFileSync(checkpointFile, "utf-8")) as Record<string, { lastByte?: number }>;
  return all[filePath]?.lastByte;
}

/** The saved position, or fail: tests that require a saved position call this. */
function savedPosition(filePath: string): number {
  const position = readCheckpoint(filePath);
  if (position === undefined) throw new Error(`no scan position was saved for ${filePath}`);
  return position;
}

interface PassOutcome {
  feedback: string[];
  positions: number[];
}

/** Run passes (maxResults = 1 each) until a pass returns no results. */
async function scanPasses(filePath: string): Promise<PassOutcome> {
  const feedback: string[] = [];
  const positions: number[] = [];
  for (let pass = 0; pass < 100; pass++) {
    const result = await scanSessions(portraitDir, freshState(), 10, 1);
    const position = readCheckpoint(filePath);
    if (position !== undefined) positions.push(position);
    for (const item of result.results) feedback.push(item.behaviorNotes[0]);
    if (result.results.length === 0) return { feedback, positions };
  }
  throw new Error("scanPasses did not converge after 100 passes");
}

async function scanAll(filePath: string): Promise<string[]> {
  return (await scanPasses(filePath)).feedback;
}

/** The trios one uninterrupted TrioDetector emits over the whole file. */
function uninterrupted(filePath: string): string[] {
  const detector = new TrioDetector();
  const feedback: string[] = [];
  for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const entry = parseRecord(line);
    if (!entry) continue;
    const trio = detector.process(entry);
    if (trio) feedback.push(trio.userFeedback);
  }
  return feedback;
}

describe("scan position across passes", () => {
  beforeEach(() => {
    portraitDir = path.join(os.tmpdir(), `scan-position-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    sessionDir = path.join(portraitDir, "sessions", "test-project");
    fs.mkdirSync(sessionDir, { recursive: true });
    setTestConfig({ portraitDir, sessionDirs: [path.join(portraitDir, "sessions")] });
    // The malformed/rewritten/truncated diagnostics travel the reportError route; keep it a
    // recording no-op so the tests can assert the exact message and source.
    useStubs({ error: true });
    // One note per trio, post-extraction off: every examined trio yields exactly one result.
    setupTestSettings({ debugDumpLimit: 0, postExtractionEnabled: false });
    mockCallPortraitLlm.mockReset();
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

  it("emits every adjacent trio across passes", async () => {
    const file = path.join(sessionDir, "adjacent.jsonl");
    writeSession(file, [
      HEADER,
      assistantRecord("A1 initial plan"),
      userRecord("U1 add error handling"),
      assistantRecord("A2 added error handling"),
      userRecord("U2 add tests"),
      assistantRecord("A3 added tests"),
      userRecord("U3 write docs"),
      assistantRecord("A4 wrote docs"),
    ]);

    const expected = uninterrupted(file);
    expect(expected).toEqual(["U1 add error handling", "U2 add tests", "U3 write docs"]);
    expect(await scanAll(file)).toEqual(expected);
  });

  it("treats approval and continuation turns as non-trios between passes", async () => {
    const file = path.join(sessionDir, "approvals.jsonl");
    writeSession(file, [
      HEADER,
      assistantRecord("A1 initial plan"),
      userRecord("U1 tighten the check"),
      assistantRecord("A2 tightened the check"),
      userRecord("looks good"),
      assistantRecord("A3 next step"),
      userRecord("continue"),
      userRecord("U2 one more fix"),
      assistantRecord("A4 applied the fix"),
    ]);

    const feedback = await scanAll(file);
    expect(feedback).toEqual(uninterrupted(file));
    expect(feedback).toEqual(["U1 tighten the check", "U2 one more fix"]);
    expect(feedback).not.toContain("looks good");
    expect(feedback).not.toContain("continue");
  });

  it("keeps saved positions on record starts around multibyte records", async () => {
    const file = path.join(sessionDir, "multibyte.jsonl");
    writeSession(file, [
      HEADER,
      assistantRecord("🚀 plan: 写一个解析器 for émojis"),
      userRecord("🎯先写测试 — 优先级最高🧪"),
      assistantRecord("✅ 完成了测试 ✔ 一切正常"),
      userRecord("日本語のフィードバック 🐛 ログを追加"),
      assistantRecord("修复しました🔧 ログを追加しました"),
    ]);

    const expected = uninterrupted(file);
    expect(expected).toHaveLength(2);
    const { feedback, positions } = await scanPasses(file);
    const buf = fs.readFileSync(file);
    for (const position of positions) {
      expect(position === 0 || buf[position - 1] === 0x0a).toBe(true);
    }
    expect(feedback).toEqual(expected);
  });

  it("leaves an unterminated final record for the next pass", async () => {
    const file = path.join(sessionDir, "partial-tail.jsonl");
    const userLine = userRecord("U2 the feedback that got cut off mid-record");
    const half = Math.floor(userLine.length / 2);
    fs.writeFileSync(
      file,
      `${[HEADER, assistantRecord("A1 initial plan"), userLine.slice(0, half)].join("\n")}`,
      "utf-8",
    );
    const partialStart = Buffer.byteLength(`${HEADER}\n${assistantRecord("A1 initial plan")}\n`, "utf-8");

    const firstPass = await scanSessions(portraitDir, freshState(), 10, 1);
    expect(firstPass.results).toEqual([]);
    expect(savedPosition(file)).toBeLessThanOrEqual(partialStart);

    fs.appendFileSync(file, `${userLine.slice(half)}\n${assistantRecord("A2 reply arrived")}\n`);
    const expected = uninterrupted(file);
    expect(expected).toEqual(["U2 the feedback that got cut off mid-record"]);
    expect(await scanAll(file)).toEqual(expected);
  });

  it("completes a pending turn when the reply is appended at EOF", async () => {
    const file = path.join(sessionDir, "append-reply.jsonl");
    writeSession(file, [HEADER, assistantRecord("A1 initial plan"), userRecord("U1 waiting for a reply")]);

    expect(await scanAll(file)).toEqual([]);
    fs.appendFileSync(file, `${assistantRecord("A2 the reply arrived")}\n`);

    const expected = uninterrupted(file);
    expect(expected).toEqual(["U1 waiting for a reply"]);
    expect(await scanAll(file)).toEqual(expected);
  });

  it("restarts at the last assistant record and matches an uninterrupted scan (user before the first assistant)", async () => {
    const file = path.join(sessionDir, "user-first.jsonl");
    writeSession(file, [HEADER, userRecord("U1 feedback before any assistant"), assistantRecord("A1 first plan")]);

    // The pass over [U1, A1] examines nothing and saves its position at A1.
    expect(await scanAll(file)).toEqual([]);

    fs.appendFileSync(file, `${assistantRecord("A2 second plan")}\n`);
    const expected = uninterrupted(file);
    expect(expected).toEqual([]);
    expect(await scanAll(file)).toEqual(expected);
  });

  it("keeps saved positions on record starts across blank lines and CRLF endings", async () => {
    const file = path.join(sessionDir, "blank-crlf.jsonl");
    const lfSegment = [HEADER, assistantRecord("A1 first plan"), "", userRecord("U1 first feedback")].join("\n");
    const crlfSegment = [
      assistantRecord("A2 second plan"),
      userRecord("U2 second feedback"),
      assistantRecord("A3 third plan"),
    ].join("\r\n");
    fs.writeFileSync(file, `${lfSegment}\n${crlfSegment}\r\n`, "utf-8");

    const expected = uninterrupted(file);
    expect(expected).toEqual(["U1 first feedback", "U2 second feedback"]);
    const { feedback, positions } = await scanPasses(file);
    const buf = fs.readFileSync(file);
    for (const position of positions) {
      expect(position === 0 || buf[position - 1] === 0x0a).toBe(true);
    }
    expect(feedback).toEqual(expected);
  });

  it("stops a rewritten source without moving its saved position", async () => {
    const file = path.join(sessionDir, "rewritten.jsonl");
    writeSession(file, [
      HEADER,
      assistantRecord("A1 original plan"),
      userRecord("U1 original feedback"),
      assistantRecord("A2 original reply"),
    ]);
    const firstPass = await scanSessions(portraitDir, freshState(), 10, 1);
    expect(firstPass.results).toHaveLength(1);
    const position = savedPosition(file);
    const originalSize = fs.statSync(file).size;

    writeSession(file, [
      HEADER,
      assistantRecord("A1 replacement plan with extra padding text so the file only grows in size"),
      userRecord("U2 replacement feedback with extra padding text so the file only grows in size"),
      assistantRecord("A2 replacement reply with extra padding text so the file only grows in size"),
      assistantRecord("A3 more replacement content with extra padding text so the file only grows"),
      userRecord("U3 still more replacement content with extra padding text so the file only grows"),
      assistantRecord("A4 final replacement content with extra padding text so the file only grows"),
    ]);
    expect(fs.statSync(file).size).toBeGreaterThanOrEqual(originalSize);

    await scanSessions(portraitDir, freshState(), 10, 1);
    expect(mockReportError).toHaveBeenCalledWith(REWRITTEN_ERROR(file), "scan error");
    expect(savedPosition(file)).toBe(position);
  });

  it("stops a truncated source without moving its saved position", async () => {
    const file = path.join(sessionDir, "truncated.jsonl");
    writeSession(file, [
      HEADER,
      assistantRecord("A1 original plan"),
      userRecord("U1 original feedback"),
      assistantRecord("A2 original reply"),
    ]);
    const firstPass = await scanSessions(portraitDir, freshState(), 10, 1);
    expect(firstPass.results).toHaveLength(1);
    const position = savedPosition(file);

    fs.writeFileSync(file, `${HEADER}\n`, "utf-8");
    expect(fs.statSync(file).size).toBeLessThan(position);

    await scanSessions(portraitDir, freshState(), 10, 1);
    expect(mockReportError).toHaveBeenCalledWith(REWRITTEN_ERROR(file), "scan error");
    expect(savedPosition(file)).toBe(position);
  });

  it("stops a malformed record before its offset and keeps other files scanning", async () => {
    const bad = path.join(sessionDir, "malformed.jsonl");
    const good = path.join(sessionDir, "complete.jsonl");
    const badPrefix = `${[HEADER, assistantRecord("A1 waiting"), userRecord("U1 waiting for a reply")].join("\n")}\n`;
    const malformedRecord = '{"type":"message","message":{broken';
    fs.writeFileSync(bad, `${badPrefix}${malformedRecord}\n`, "utf-8");
    const malformedStart = Buffer.byteLength(badPrefix, "utf-8");
    writeSession(good, [
      HEADER,
      assistantRecord("B1 other plan"),
      userRecord("B1 other feedback"),
      assistantRecord("B2 other reply"),
    ]);

    expect(uninterrupted(bad)).toEqual([]);
    const expected = uninterrupted(good);
    expect(expected).toEqual(["B1 other feedback"]);
    expect(await scanAll(bad)).toEqual(expected);
    expect(mockReportError).toHaveBeenCalledWith(MALFORMED_ERROR(bad, malformedStart), "scan error");
    expect(readCheckpoint(bad) ?? 0).toBeLessThan(malformedStart);
  });

  it("propagates extraction failures and keeps the saved position", async () => {
    const file = path.join(sessionDir, "extraction-error.jsonl");
    writeSession(file, [
      HEADER,
      assistantRecord("A1 first plan"),
      userRecord("U1 first feedback"),
      assistantRecord("A2 first reply"),
      userRecord("U2 second feedback"),
      assistantRecord("A3 second reply"),
      userRecord("U3 third feedback"),
      assistantRecord("A4 third reply"),
    ]);

    let extractionCalls = 0;
    mockCallPortraitLlm.mockImplementation(async (messages: unknown) => {
      extractionCalls++;
      if (extractionCalls > 1) throw new Error("boom");
      const userFeedback = userFeedbackFromPrompt(messages);
      return {
        notes: [userFeedback],
        summary: { agentBefore: "agent before", userFeedback, agentAfter: "agent after" },
      };
    });

    const firstPass = await scanSessions(portraitDir, freshState(), 10, 1);
    expect(firstPass.results).toHaveLength(1);
    const position = savedPosition(file);

    await expect(scanSessions(portraitDir, freshState(), 10, 1)).rejects.toThrow("boom");
    expect(savedPosition(file)).toBe(position);
  });
});
