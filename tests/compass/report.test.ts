// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Session report: the segment metrics for Pi and Claude Code logs, the check
 * classifiers, episode closing, question detection, the rendered report
 * files, the refusal paths, and read-only handling. Every log is built in a
 * temp directory from small record helpers; no real session log is read.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ChangeRec,
  type CheckRunRec,
  checkKind,
  type FullReport,
  fixedEpisodes,
  isCheck,
  isExpected,
  isFailed,
  type MeasuredRow,
  measureSegment,
  renderMarkdown,
  main as runReport,
  type SegmentInput,
} from "../../scripts/compass/report.js";
import { strings } from "../../scripts/compass/strings.js";

const ROOT = process.cwd();
// Unique per test-file run so overlapping suite runs never share a directory.
const TEST_TMP_ROOT = path.join(ROOT, "outputs", "test-tmp");
fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
const TEST_TMP = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "report-"));

let idCounter = 0;

function nextId(prefix: string): string {
  idCounter++;
  return `${prefix}-${idCounter}`;
}

interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface ToolCallSpec {
  id: string;
  name: string;
  command: string | null;
}

interface AssistantSpec {
  text: string;
  toolCalls: ToolCallSpec[];
  usage: PiUsage | null;
  durationMs: number;
  timestamp: string;
}

interface ToolResultSpec {
  toolCallId: string;
  text: string;
  isError: boolean;
  durationMs: number;
  timestamp: string;
}

interface CcUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ToolUseSpec {
  id: string;
  name: string;
  command: string | null;
}

interface CcAssistantSpec {
  messageId: string;
  text: string;
  toolUses: ToolUseSpec[];
  usage: CcUsage | null;
  timestamp: string;
}

interface CcUserSpec {
  text: string;
  originKind: string | null;
  isMeta: boolean;
  timestamp: string;
}

interface CcToolResultSpec {
  toolUseId: string;
  text: string;
  isError: boolean;
  timestamp: string;
}

function piUser(text: string, timestamp: string): Record<string, unknown> {
  return {
    type: "message",
    id: nextId("rec"),
    timestamp,
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function piAssistant(spec: AssistantSpec): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (spec.text !== "") content.push({ type: "text", text: spec.text });
  for (const call of spec.toolCalls) {
    content.push({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: call.command === null ? {} : { command: call.command },
    });
  }
  return {
    type: "message",
    id: nextId("rec"),
    timestamp: spec.timestamp,
    message: {
      role: "assistant",
      content,
      durationMs: spec.durationMs,
      usage:
        spec.usage === null
          ? undefined
          : {
              input: spec.usage.input,
              output: spec.usage.output,
              cacheRead: spec.usage.cacheRead,
              cacheWrite: spec.usage.cacheWrite,
              cost: { total: spec.usage.cost },
            },
    },
  };
}

function piToolResult(spec: ToolResultSpec): Record<string, unknown> {
  return {
    type: "message",
    id: nextId("rec"),
    timestamp: spec.timestamp,
    message: {
      role: "toolResult",
      toolCallId: spec.toolCallId,
      isError: spec.isError,
      durationMs: spec.durationMs,
      content: [{ type: "text", text: spec.text }],
    },
  };
}

/** A Pi log: the session header first, then the records. */
function piSession(id: string, records: Record<string, unknown>[]): Record<string, unknown>[] {
  return [{ type: "session", version: 3, id, cwd: "/tmp/project", timestamp: "2026-10-18T10:00:00.000Z" }, ...records];
}

function ccUser(spec: CcUserSpec): Record<string, unknown> {
  return {
    type: "user",
    timestamp: spec.timestamp,
    origin: spec.originKind === null ? undefined : { kind: spec.originKind },
    isMeta: spec.isMeta,
    message: { role: "user", content: [{ type: "text", text: spec.text }] },
  };
}

function ccAssistant(spec: CcAssistantSpec): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (spec.text !== "") content.push({ type: "text", text: spec.text });
  for (const call of spec.toolUses) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.command === null ? {} : { command: call.command },
    });
  }
  return {
    type: "assistant",
    timestamp: spec.timestamp,
    message: {
      id: spec.messageId,
      content,
      usage:
        spec.usage === null
          ? undefined
          : {
              input_tokens: spec.usage.input,
              output_tokens: spec.usage.output,
              cache_read_input_tokens: spec.usage.cacheRead,
              cache_creation_input_tokens: spec.usage.cacheWrite,
            },
    },
  };
}

function ccToolResult(spec: CcToolResultSpec): Record<string, unknown> {
  return {
    type: "user",
    timestamp: spec.timestamp,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: spec.toolUseId, is_error: spec.isError, content: spec.text }],
    },
  };
}

function ccTurnDuration(durationMs: number, timestamp: string): Record<string, unknown> {
  return { type: "system", subtype: "turn_duration", durationMs, timestamp };
}

function ccCostState(totalCostUSD: number, timestamp: string): Record<string, unknown> {
  return { type: "cost-state", totalCostUSD, timestamp };
}

/** A Claude Code log: every record carries the session id. */
function ccSession(id: string, records: Record<string, unknown>[]): Record<string, unknown>[] {
  return records.map((record) => ({ ...record, sessionId: id }));
}

function writeLog(dir: string, name: string, records: Record<string, unknown>[]): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf-8");
  return file;
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

interface JsonlRow {
  level: string;
  session: string;
  index?: number;
  promptHead?: string;
  file?: string;
  format?: string;
  skippedLines?: number;
  skippedFiles?: number;
  effort: { prompts: number; turns: number; wallMs: number; modelMs: number; toolMs: number };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; peak: number };
  costUsd: number | null;
  checks: Record<string, { runs: number; failed: number; fixed: number; expected: number }>;
  questions: number;
}

function readJsonl(outDir: string): JsonlRow[] {
  return fs
    .readFileSync(path.join(outDir, "report.jsonl"), "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as JsonlRow);
}

function readMarkdown(outDir: string): string {
  return fs.readFileSync(path.join(outDir, "report.md"), "utf-8");
}

function emptySegment(lastAgentText: string): SegmentInput {
  return {
    index: 1,
    promptHead: "prompt",
    firstTimestampMs: 0,
    lastTimestampMs: 0,
    assistants: [],
    toolResultDurationsMs: [],
    turnDurationsMs: [],
    toolPairMs: [],
    checkRuns: [],
    changes: [],
    lastAgentText,
  };
}

beforeEach(() => {
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
  fs.mkdirSync(TEST_TMP, { recursive: true });
  idCounter = 0;
});

afterEach(() => {
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
});

describe("report — Pi effort and tokens", () => {
  /**
   * Fixture (times are UTC on 2026-10-18):
   *   :00 header · :00 prompt A · :00:01 assistant (bash vitest, dur 140, usage 1000/100/500/50 $0.01)
   *   :02 toolResult (dur 174, "Tests  2 failed | 3 passed") · :03 assistant (edit, dur 200, usage 1200/200/600/60 $0.02)
   *   :04 toolResult (dur 30) · :05 assistant (bash vitest, dur 100, usage 1300/300/700/70 $0.0196)
   *   :06 toolResult (dur 100, "Tests  5 passed") · :10 prompt B · :11 assistant (bash lint, dur 60, usage 500/50/100/10 $0.005)
   *   :12 toolResult (dur 40)
   *
   * Expected:
   *   | row | prompts | turns | wallMs | modelMs | toolMs | in | out | cacheRead | cacheWrite | peak | costUsd | test r/f/x/e | lint r/f/x/e | questions |
   *   | seg 1 | 1 | 3 | 6000 | 440 | 304 | 3500 | 600 | 1800 | 180 | 2000 | 0.0496 | 2/1/1/0 | 0/0/0/0 | 1 |
   *   | seg 2 | 1 | 1 | 2000 | 60 | 40 | 500 | 50 | 100 | 10 | 600 | 0.005 | 0/0/0/0 | 1/0/0/0 | 0 |
   *   | session | 2 | 4 | 8000 | 500 | 344 | 4000 | 650 | 1900 | 190 | 2000 | 0.0546 | 2/1/1/0 | 1/0/0/0 | 1 |
   */
  it("measures a two-prompt Pi session exactly", async () => {
    const log = writeLog(
      path.join(TEST_TMP, "logs"),
      "pi.jsonl",
      piSession("01a14cf6deadbeef", [
        piUser("please fix the widget", "2026-10-18T10:00:00.000Z"),
        piAssistant({
          text: "looking at it",
          toolCalls: [{ id: "c1", name: "bash", command: "npx vitest run" }],
          usage: { input: 1000, output: 100, cacheRead: 500, cacheWrite: 50, cost: 0.01 },
          durationMs: 140,
          timestamp: "2026-10-18T10:00:01.000Z",
        }),
        piToolResult({
          toolCallId: "c1",
          text: "Tests  2 failed | 3 passed",
          isError: false,
          durationMs: 174,
          timestamp: "2026-10-18T10:00:02.000Z",
        }),
        piAssistant({
          text: "fixing",
          toolCalls: [{ id: "e1", name: "edit", command: null }],
          usage: { input: 1200, output: 200, cacheRead: 600, cacheWrite: 60, cost: 0.02 },
          durationMs: 200,
          timestamp: "2026-10-18T10:00:03.000Z",
        }),
        piToolResult({
          toolCallId: "e1",
          text: "edited",
          isError: false,
          durationMs: 30,
          timestamp: "2026-10-18T10:00:04.000Z",
        }),
        piAssistant({
          text: "done. Should I go ahead?",
          toolCalls: [{ id: "c2", name: "bash", command: "npx vitest run" }],
          usage: { input: 1300, output: 300, cacheRead: 700, cacheWrite: 70, cost: 0.0196 },
          durationMs: 100,
          timestamp: "2026-10-18T10:00:05.000Z",
        }),
        piToolResult({
          toolCallId: "c2",
          text: "Tests  5 passed",
          isError: false,
          durationMs: 100,
          timestamp: "2026-10-18T10:00:06.000Z",
        }),
        piUser("yes, continue", "2026-10-18T10:00:10.000Z"),
        piAssistant({
          text: "running lint",
          toolCalls: [{ id: "c3", name: "bash", command: "npx biome check src" }],
          usage: { input: 500, output: 50, cacheRead: 100, cacheWrite: 10, cost: 0.005 },
          durationMs: 60,
          timestamp: "2026-10-18T10:00:11.000Z",
        }),
        piToolResult({
          toolCallId: "c3",
          text: "checked",
          isError: false,
          durationMs: 40,
          timestamp: "2026-10-18T10:00:12.000Z",
        }),
      ]),
    );
    const outDir = path.join(TEST_TMP, "out");

    const { code } = await capture(() => runReport(["--session", log, "--output", outDir]));

    expect(code).toBe(0);
    const rows = readJsonl(outDir);
    const segments = rows.filter((row) => row.level === "segment");
    const session = rows.find((row) => row.level === "session");
    expect(segments).toHaveLength(2);
    expect(session).toBeDefined();
    if (session === undefined) return;

    expect(segments[0].effort).toEqual({ prompts: 1, turns: 3, wallMs: 6000, modelMs: 440, toolMs: 304 });
    expect(segments[0].tokens).toEqual({ input: 3500, output: 600, cacheRead: 1800, cacheWrite: 180, peak: 2000 });
    expect(segments[0].costUsd).toBe(0.0496);
    expect(segments[0].checks.test).toEqual({ runs: 2, failed: 1, fixed: 1, expected: 0 });
    expect(segments[0].checks.lint).toEqual({ runs: 0, failed: 0, fixed: 0, expected: 0 });
    expect(segments[0].questions).toBe(1);

    expect(segments[1].effort).toEqual({ prompts: 1, turns: 1, wallMs: 2000, modelMs: 60, toolMs: 40 });
    expect(segments[1].tokens).toEqual({ input: 500, output: 50, cacheRead: 100, cacheWrite: 10, peak: 600 });
    expect(segments[1].costUsd).toBe(0.005);
    expect(segments[1].checks.test).toEqual({ runs: 0, failed: 0, fixed: 0, expected: 0 });
    expect(segments[1].checks.lint).toEqual({ runs: 1, failed: 0, fixed: 0, expected: 0 });
    expect(segments[1].questions).toBe(0);

    expect(session.effort).toEqual({ prompts: 2, turns: 4, wallMs: 8000, modelMs: 500, toolMs: 344 });
    expect(session.tokens).toEqual({ input: 4000, output: 650, cacheRead: 1900, cacheWrite: 190, peak: 2000 });
    expect(session.costUsd).toBeCloseTo(0.0546, 10);
    expect(session.checks.test).toEqual({ runs: 2, failed: 1, fixed: 1, expected: 0 });
    expect(session.checks.lint).toEqual({ runs: 1, failed: 0, fixed: 0, expected: 0 });
    expect(session.questions).toBe(1);
    expect(session.skippedLines).toBe(0);
    expect(session.session).toBe("2026-10-18 01a14cf6");
  });
});

describe("report — Claude Code effort and tokens", () => {
  /**
   * Fixture (times are UTC on 2026-10-18):
   *   :00 prompt (origin human) · :01/:02/:03 assistant records, all message.id msg_1,
   *       the first with tool_use tu1 (Bash), each carrying usage 1000/100/500/50
   *   :05 tool_result tu1 ("Tests  5 passed") · :05 system turn_duration 5000
   *   :05 cost-state 0.03 · :06 cost-state 0.0496 · :07 user "/compact" (no origin)
   *   :08 user task notification (origin task-notification) · :09 sidechain assistant with usage
   *   :20 prompt 2 · :21 assistant msg_2 (usage 200/20/0/0) · :22 system turn_duration 1000
   *
   * Expected:
   *   | row | prompts | turns | wallMs | modelMs | toolMs | in | out | cacheRead | cacheWrite | peak | costUsd | questions |
   *   | seg 1 | 1 | 1 | 5000 | 1000 | 4000 | 1000 | 100 | 500 | 50 | 1550 | null | 0 |
   *   | seg 2 | 1 | 1 | 1000 | 1000 | 0 | 200 | 20 | 0 | 0 | 200 | null | 0 |
   *   | session | 2 | 2 | 6000 | 2000 | 4000 | 1200 | 120 | 500 | 50 | 1550 | 0.0496 | 0 |
   */
  it("measures turns, usage, and cost from a Claude Code log", async () => {
    const log = writeLog(
      path.join(TEST_TMP, "logs"),
      "cc.jsonl",
      ccSession("cccccccc-1111-2222-3333-444444444444", [
        ccUser({ text: "run the suite", originKind: "human", isMeta: false, timestamp: "2026-10-18T12:00:00.000Z" }),
        ccAssistant({
          messageId: "msg_1",
          text: "checking",
          toolUses: [{ id: "tu1", name: "Bash", command: "npx vitest run" }],
          usage: { input: 1000, output: 100, cacheRead: 500, cacheWrite: 50 },
          timestamp: "2026-10-18T12:00:01.000Z",
        }),
        ccAssistant({
          messageId: "msg_1",
          text: "still checking",
          toolUses: [],
          usage: { input: 1000, output: 100, cacheRead: 500, cacheWrite: 50 },
          timestamp: "2026-10-18T12:00:02.000Z",
        }),
        ccAssistant({
          messageId: "msg_1",
          text: "then this",
          toolUses: [],
          usage: { input: 1000, output: 100, cacheRead: 500, cacheWrite: 50 },
          timestamp: "2026-10-18T12:00:03.000Z",
        }),
        ccToolResult({
          toolUseId: "tu1",
          text: "Tests  5 passed",
          isError: false,
          timestamp: "2026-10-18T12:00:05.000Z",
        }),
        ccTurnDuration(5000, "2026-10-18T12:00:05.000Z"),
        ccCostState(0.03, "2026-10-18T12:00:05.500Z"),
        ccCostState(0.0496, "2026-10-18T12:00:06.000Z"),
        ccUser({ text: "/compact", originKind: null, isMeta: false, timestamp: "2026-10-18T12:00:07.000Z" }),
        ccUser({
          text: "task finished",
          originKind: "task-notification",
          isMeta: false,
          timestamp: "2026-10-18T12:00:08.000Z",
        }),
        {
          ...ccAssistant({
            messageId: "msg_side",
            text: "side work",
            toolUses: [],
            usage: { input: 9999, output: 9999, cacheRead: 9999, cacheWrite: 9999 },
            timestamp: "2026-10-18T12:00:09.000Z",
          }),
          isSidechain: true,
        },
        ccUser({ text: "again", originKind: "human", isMeta: false, timestamp: "2026-10-18T12:00:20.000Z" }),
        ccAssistant({
          messageId: "msg_2",
          text: "ok",
          toolUses: [],
          usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 },
          timestamp: "2026-10-18T12:00:21.000Z",
        }),
        ccTurnDuration(1000, "2026-10-18T12:00:22.000Z"),
      ]),
    );
    const outDir = path.join(TEST_TMP, "out");

    const { code } = await capture(() => runReport(["--session", log, "--output", outDir]));

    expect(code).toBe(0);
    const rows = readJsonl(outDir);
    const segments = rows.filter((row) => row.level === "segment");
    const session = rows.find((row) => row.level === "session");
    expect(segments).toHaveLength(2);
    expect(session).toBeDefined();
    if (session === undefined) return;

    expect(segments[0].effort).toEqual({ prompts: 1, turns: 1, wallMs: 5000, modelMs: 1000, toolMs: 4000 });
    expect(segments[0].tokens).toEqual({ input: 1000, output: 100, cacheRead: 500, cacheWrite: 50, peak: 1550 });
    expect(segments[0].costUsd).toBeNull();
    expect(segments[0].questions).toBe(0);

    expect(segments[1].effort).toEqual({ prompts: 1, turns: 1, wallMs: 1000, modelMs: 1000, toolMs: 0 });
    expect(segments[1].tokens).toEqual({ input: 200, output: 20, cacheRead: 0, cacheWrite: 0, peak: 200 });

    expect(session.effort).toEqual({ prompts: 2, turns: 2, wallMs: 6000, modelMs: 2000, toolMs: 4000 });
    expect(session.tokens).toEqual({ input: 1200, output: 120, cacheRead: 500, cacheWrite: 50, peak: 1550 });
    expect(session.costUsd).toBe(0.0496);
    expect(session.format).toBe("claude-code");
  });

  /**
   * Expected: the session row keeps costUsd null and the markdown says
   * "not recorded" in the Cost cell.
   */
  it("reports not recorded when the log has no cost-state record", async () => {
    const log = writeLog(
      path.join(TEST_TMP, "logs"),
      "cc-no-cost.jsonl",
      ccSession("cccccccc-0000-1111-2222-333333333333", [
        ccUser({ text: "hello", originKind: "human", isMeta: false, timestamp: "2026-10-18T13:00:00.000Z" }),
        ccAssistant({
          messageId: "msg_1",
          text: "hi",
          toolUses: [],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          timestamp: "2026-10-18T13:00:01.000Z",
        }),
        ccTurnDuration(1000, "2026-10-18T13:00:02.000Z"),
      ]),
    );
    const outDir = path.join(TEST_TMP, "out");

    const { code } = await capture(() => runReport(["--session", log, "--output", outDir]));

    expect(code).toBe(0);
    const session = readJsonl(outDir).find((row) => row.level === "session");
    expect(session?.costUsd).toBeNull();
    expect(readMarkdown(outDir)).toContain("| 2026-10-18 cccccccc | 10 | 5 | 0 | 0 | 10 | not recorded |");
  });
});

describe("report — check classifiers", () => {
  /**
   * Expected kinds (null = no check):
   *   | command | kind |
   *   | npx vitest run tests/a.test.ts 2>&1 \| tail | test |
   *   | cd /x && npm test > /tmp/l 2>&1; echo $? | test |
   *   | for i in 1 2; do npx vitest run; done | test |
   *   | timeout 600 npx vitest run | test |
   *   | npx tsc --noEmit | typecheck |
   *   | npx biome check --write src | lint |
   *   | npm run test:compass | test |
   *   | git add knip.json && git commit -m x | null |
   *   | heredoc whose body mentions vitest | null |
   *   | grep -E 'vitest|FAIL' log | null |
   */
  it("classifies check commands and non-checks", () => {
    const table: [string, string | null][] = [
      ["npx vitest run tests/a.test.ts 2>&1 | tail", "test"],
      ["cd /x && npm test > /tmp/l 2>&1; echo $?", "test"],
      ["for i in 1 2; do npx vitest run; done", "test"],
      ["timeout 600 npx vitest run", "test"],
      ["npx tsc --noEmit", "typecheck"],
      ["npx biome check --write src", "lint"],
      ["npm run test:compass", "test"],
      ["git add knip.json && git commit -m x", null],
      ["cat <<EOF\nthis mentions vitest\nEOF\necho done", null],
      ["grep -E 'vitest|FAIL' log", null],
    ];
    for (const [command, kind] of table) {
      expect(checkKind(command)).toBe(kind);
      expect(isCheck(command)).toBe(kind !== null);
    }
  });

  /**
   * Expected failures:
   *   | result text | isError | failed |
   *   | Tests  2 failed \| 3 passed | no | yes |
   *   | Tests  0 failed | no | no |
   *   | 5 passed | no | no |
   *   | × Some errors were emitted while running checks. | no | yes |
   *   | exit=1 | no | yes |
   *   | exit=0 | no | no |
   *   | error TS2304: Cannot find name | no | yes |
   *   | Found 0 errors | no | no |
   *   | clean text | yes | yes |
   */
  it("detects failed runs from the result", () => {
    const table: [string, boolean, boolean][] = [
      ["Tests  2 failed | 3 passed", false, true],
      ["Tests  0 failed", false, false],
      ["5 passed", false, false],
      ["× Some errors were emitted while running checks.", false, true],
      ["exit=1", false, true],
      ["exit=0", false, false],
      ["error TS2304: Cannot find name", false, true],
      ["Found 0 errors", false, false],
      ["clean text", true, true],
    ];
    for (const [text, isError, failed] of table) {
      expect(isFailed(text, isError)).toBe(failed);
    }
  });

  /**
   * Expected:
   *   | agent text before the call | expected |
   *   | Test first: this should fail | yes |
   *   | the current code must fail here | yes |
   *   | I expect the suite to fail | yes |
   *   | confirm the gate fails | yes |
   *   | all green now | no |
   */
  it("reads expected failures from the agent text", () => {
    const table: [string, boolean][] = [
      ["Test first: this should fail", true],
      ["the current code must fail here", true],
      ["I expect the suite to fail", true],
      ["confirm the gate fails", true],
      ["all green now", false],
    ];
    for (const [agentText, expected] of table) {
      expect(isExpected(agentText)).toBe(expected);
    }
  });
});

describe("report — episodes", () => {
  function run(
    order: number,
    segmentIndex: number,
    kind: "test" | "lint" | "typecheck",
    failed: boolean,
    expected: boolean,
  ): CheckRunRec {
    return { order, segmentIndex, kind, failed, expected };
  }

  function change(order: number, segmentIndex: number): ChangeRec {
    return { order, segmentIndex };
  }

  /**
   * Expected (all runs of one kind per case):
   *   | case | runs (order: failed/expected, pass) | changes | episodes | fixed |
   *   | fail, edit, pass | 1 failed, 3 pass | 2 | 1 | 1 |
   *   | fail, pass without a change | 1 failed, 2 pass | — | 1 | 0 |
   *   | fail, fail, edit, pass | 1 failed, 2 failed, 4 pass | 3 | 1 | 1 |
   *   | fail, passing write check (change and pass) | 1 failed, 2 pass | 2 | 1 | 1 |
   *   | expected failure | 1 failed/expected, 2 pass | 2 | 0 | 0 |
   *   | fail, pass, edit, pass | 1 failed, 2 pass, 4 pass | 3 | 1 | 0 |
   */
  it("opens at a failure and closes at the first pass of its kind", () => {
    const table: { name: string; runs: CheckRunRec[]; changes: ChangeRec[]; episodes: number; fixed: number }[] = [
      {
        name: "fail, edit, pass",
        runs: [run(1, 1, "test", true, false), run(3, 1, "test", false, false)],
        changes: [change(2, 1)],
        episodes: 1,
        fixed: 1,
      },
      {
        name: "fail, pass without a change",
        runs: [run(1, 1, "test", true, false), run(2, 1, "test", false, false)],
        changes: [],
        episodes: 1,
        fixed: 0,
      },
      {
        name: "fail, fail, edit, pass",
        runs: [run(1, 1, "test", true, false), run(2, 1, "test", true, false), run(4, 1, "test", false, false)],
        changes: [change(3, 1)],
        episodes: 1,
        fixed: 1,
      },
      {
        name: "fail, passing write check",
        runs: [run(1, 1, "lint", true, false), run(2, 1, "lint", false, false)],
        changes: [change(2, 1)],
        episodes: 1,
        fixed: 1,
      },
      {
        name: "expected failure",
        runs: [run(1, 1, "test", true, true), run(2, 1, "test", false, false)],
        changes: [change(2, 1)],
        episodes: 0,
        fixed: 0,
      },
      {
        name: "fail, pass, edit, pass",
        runs: [run(1, 1, "test", true, false), run(2, 1, "test", false, false), run(4, 1, "test", false, false)],
        changes: [change(3, 1)],
        episodes: 1,
        fixed: 0,
      },
    ];
    for (const row of table) {
      const episodes = fixedEpisodes(row.runs, row.changes);
      expect(episodes, row.name).toHaveLength(row.episodes);
      expect(episodes.filter((episode) => episode.fixed).length, row.name).toBe(row.fixed);
    }
  });

  /** Expected: the episode is recorded in segment 1 and its fixed count lands there. */
  it("counts a cross-segment episode in the segment of its first failure", () => {
    const episodes = fixedEpisodes([run(1, 1, "test", true, false), run(3, 2, "test", false, false)], [change(2, 1)]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].segmentIndex).toBe(1);
    expect(episodes[0].fixed).toBe(true);

    const segmentOne = measureSegment(emptySegment(""), "pi", episodes);
    const segmentTwo = measureSegment({ ...emptySegment(""), index: 2 }, "pi", episodes);
    expect(segmentOne.checks.test.fixed).toBe(1);
    expect(segmentTwo.checks.test.fixed).toBe(0);
  });

  /** Expected: 2 runs, 1 failed, 1 expected, 0 fixed. */
  it("counts an expected failure under expected and not under fixed", () => {
    const runs = [run(1, 1, "test", true, true), run(2, 1, "test", false, false)];
    const segment = measureSegment({ ...emptySegment(""), checkRuns: runs }, "pi", fixedEpisodes(runs, [change(2, 1)]));
    expect(segment.checks.test).toEqual({ runs: 2, failed: 1, fixed: 0, expected: 1 });
  });
});

describe("report — agent questions", () => {
  /**
   * Expected:
   *   | last agent text | questions |
   *   | All good.\nShould I go ahead? | 1 |
   *   | Really?\n\none\ntwo\nthree\nfour | 0 |
   *   | (empty) | 0 |
   */
  it("counts a segment whose last agent text ends in a question", () => {
    const table: [string, number][] = [
      ["All good.\nShould I go ahead?", 1],
      ["Really?\n\none\ntwo\nthree\nfour", 0],
      ["", 0],
    ];
    for (const [lastAgentText, questions] of table) {
      expect(measureSegment(emptySegment(lastAgentText), "pi", []).questions).toBe(questions);
    }
  });
});

function todayLocal(): string {
  const date = new Date();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

describe("report — rendering", () => {
  /**
   * Fixture: two Pi sessions, one prompt each for the second (3 prompts in 2
   * sessions, 2 segments). Expected cells:
   *   | row | prompts | turns | wall | model | tool | in | out | read | write | peak | cost | checks r/f/x/e | questions |
   *   | 2026-10-18 01a14cf6 | 1 | 3 | 4.0 min | 3.0 min | 3.0 min | 100 | 10 | 50 | 5 | 150 | $0.0496 | test 2/1/1/0 | 1 |
   *   | 2026-10-18 02b2c3d4 | 1 | 1 | 1.0 min | 1.0 min | 1.0 min | 200 | 20 | 100 | 10 | 300 | $0.0004 | lint 1/0/0/0 | 0 |
   *   | Total | 2 | 4 | 5.0 min | 4.0 min | 4.0 min | 300 | 30 | 150 | 15 | 300 | $0.0500 | 3/1/1/0 | 1 |
   */
  it("writes report.md byte-exact from the approved text and report.jsonl per prompt, session, and total", async () => {
    const logsDir = path.join(TEST_TMP, "logs");
    writeLog(
      logsDir,
      "a.jsonl",
      piSession("01a14cf6aaaaaaaa", [
        piUser("one", "2026-10-18T10:00:00.000Z"),
        piAssistant({
          text: "doing it",
          toolCalls: [{ id: "c1", name: "bash", command: "npx vitest run" }],
          usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 5, cost: 0.0496 },
          durationMs: 60000,
          timestamp: "2026-10-18T10:01:00.000Z",
        }),
        piToolResult({
          toolCallId: "c1",
          text: "Tests  2 failed | 3 passed",
          isError: false,
          durationMs: 60000,
          timestamp: "2026-10-18T10:01:30.000Z",
        }),
        piAssistant({
          text: "fixing",
          toolCalls: [{ id: "e1", name: "edit", command: null }],
          usage: null,
          durationMs: 120000,
          timestamp: "2026-10-18T10:02:00.000Z",
        }),
        piToolResult({
          toolCallId: "e1",
          text: "edited",
          isError: false,
          durationMs: 60000,
          timestamp: "2026-10-18T10:02:30.000Z",
        }),
        piAssistant({
          text: "done. Should I proceed?",
          toolCalls: [{ id: "c2", name: "bash", command: "npx vitest run" }],
          usage: null,
          durationMs: 0,
          timestamp: "2026-10-18T10:03:00.000Z",
        }),
        piToolResult({
          toolCallId: "c2",
          text: "Tests  5 passed",
          isError: false,
          durationMs: 60000,
          timestamp: "2026-10-18T10:04:00.000Z",
        }),
      ]),
    );
    writeLog(
      logsDir,
      "b.jsonl",
      piSession("02b2c3d4bbbbbbbb", [
        piUser("two", "2026-10-18T10:30:00.000Z"),
        piAssistant({
          text: "linting",
          toolCalls: [{ id: "c3", name: "bash", command: "npx biome check src" }],
          usage: { input: 200, output: 20, cacheRead: 100, cacheWrite: 10, cost: 0.0004 },
          durationMs: 60000,
          timestamp: "2026-10-18T10:30:30.000Z",
        }),
        piToolResult({
          toolCallId: "c3",
          text: "checked",
          isError: false,
          durationMs: 60000,
          timestamp: "2026-10-18T10:31:00.000Z",
        }),
      ]),
    );
    const outDir = path.join(TEST_TMP, "out");

    const { code, out } = await capture(() => runReport(["--dir", logsDir, "--output", outDir]));

    expect(code).toBe(0);
    expect(out).toBe(`${strings.reportDone(2, 2, outDir)}\n`);
    const expected = [
      strings.reportTitle(logsDir),
      strings.reportHeader(2, 2, "Pi", todayLocal()),
      "",
      strings.reportEffortHeading,
      strings.reportEffortColumns,
      "| --- | --- | --- | --- | --- | --- |",
      "| 2026-10-18 01a14cf6 | 1 | 3 | 4.0 min | 3.0 min | 3.0 min |",
      "| 2026-10-18 02b2c3d4 | 1 | 1 | 1.0 min | 1.0 min | 1.0 min |",
      `| ${strings.reportTotalRow} | 2 | 4 | 5.0 min | 4.0 min | 4.0 min |`,
      "",
      strings.reportTokensHeading,
      strings.reportTokensColumns,
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| 2026-10-18 01a14cf6 | 100 | 10 | 50 | 5 | 150 | $0.0496 |",
      "| 2026-10-18 02b2c3d4 | 200 | 20 | 100 | 10 | 300 | $0.0004 |",
      `| ${strings.reportTotalRow} | 300 | 30 | 150 | 15 | 300 | $0.0500 |`,
      "",
      strings.reportChecksHeading,
      strings.reportChecksColumns,
      "| --- | --- | --- | --- | --- |",
      "| 2026-10-18 01a14cf6 · test | 2 | 1 | 1 | 0 |",
      "| 2026-10-18 02b2c3d4 · lint | 1 | 0 | 0 | 0 |",
      `| ${strings.reportTotalRow} | 3 | 1 | 1 | 0 |`,
      "",
      strings.reportQuestionsHeading,
      strings.reportQuestionsColumns,
      "| --- | --- | --- |",
      "| 2026-10-18 01a14cf6 | 1 | 1 |",
      "| 2026-10-18 02b2c3d4 | 1 | 0 |",
      `| ${strings.reportTotalRow} | 2 | 1 |`,
      "",
      strings.reportInterventionsHeading,
      strings.reportNotScored,
      "Reply codes are model answers. Measured accuracy: correction precision 52%, recall 89%; hold-back precision 61%, recall 52%.",
      "",
      strings.reportLessonsHeading,
      strings.reportNotScored,
      "",
      strings.reportBehaviorHeading,
      strings.reportNotScored,
      "",
      strings.reportFooter,
    ].join("\n");
    expect(readMarkdown(outDir)).toBe(`${expected}\n`);

    const rows = readJsonl(outDir);
    expect(rows.filter((row) => row.level === "segment")).toHaveLength(2);
    expect(rows.filter((row) => row.level === "session")).toHaveLength(2);
    expect(rows.filter((row) => row.level === "total")).toHaveLength(1);
    expect(rows[rows.length - 1].level).toBe("total");
    expect(rows.map((row) => row.session)).toEqual([
      "2026-10-18 01a14cf6",
      "2026-10-18 01a14cf6",
      "2026-10-18 02b2c3d4",
      "2026-10-18 02b2c3d4",
      "Total",
    ]);
  });

  /** Expected: the Behavior section of a Claude Code report says not applicable. */
  it("says not applicable under Behavior on Claude Code logs", async () => {
    const log = writeLog(
      path.join(TEST_TMP, "logs"),
      "cc.jsonl",
      ccSession("cccccccc-1111-2222-3333-444444444444", [
        ccUser({ text: "hi", originKind: "human", isMeta: false, timestamp: "2026-10-18T12:00:00.000Z" }),
        ccAssistant({
          messageId: "msg_1",
          text: "hello",
          toolUses: [],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          timestamp: "2026-10-18T12:00:01.000Z",
        }),
        ccTurnDuration(1000, "2026-10-18T12:00:02.000Z"),
      ]),
    );
    const outDir = path.join(TEST_TMP, "out");

    const { code } = await capture(() => runReport(["--session", log, "--output", outDir]));

    expect(code).toBe(0);
    expect(readMarkdown(outDir)).toContain(`${strings.reportBehaviorHeading}\n${strings.reportNotApplicable}`);
    expect(readMarkdown(outDir)).not.toContain(`${strings.reportBehaviorHeading}\n${strings.reportNotScored}`);
  });
});

describe("report — refusals", () => {
  /** Each case: exit 2, the approved message on stderr, and no file in --output. */
  it("refuses every bad invocation without writing anything", async () => {
    const logsDir = path.join(TEST_TMP, "logs");
    const piLog = writeLog(
      logsDir,
      "pi.jsonl",
      piSession("01a14cf6aaaaaaaa", [piUser("one", "2026-10-18T10:00:00.000Z")]),
    );
    writeLog(
      logsDir,
      "cc.jsonl",
      ccSession("cccccccc-1111-2222-3333-444444444444", [
        ccUser({ text: "hi", originKind: "human", isMeta: false, timestamp: "2026-10-18T12:00:00.000Z" }),
      ]),
    );
    const nonLog = writeLog(path.join(TEST_TMP, "other"), "notes.jsonl", [{ foo: 1 }]);
    const emptyDir = path.join(TEST_TMP, "empty");
    fs.mkdirSync(emptyDir, { recursive: true });
    const outDir = path.join(TEST_TMP, "out");
    const insideOut = path.join(logsDir, "out");

    const cases: { name: string; argv: string[]; message: string; output: string }[] = [
      { name: "no input switch", argv: ["--output", outDir], message: strings.reportUsage, output: outDir },
      {
        name: "no output switch",
        argv: ["--session", piLog],
        message: strings.reportUsage,
        output: outDir,
      },
      {
        name: "both input switches",
        argv: ["--session", piLog, "--dir", logsDir, "--output", outDir],
        message: strings.reportUsage,
        output: outDir,
      },
      {
        name: "a file that is not a log",
        argv: ["--session", nonLog, "--output", outDir],
        message: strings.reportNotALog(nonLog),
        output: outDir,
      },
      {
        name: "an empty folder",
        argv: ["--dir", emptyDir, "--output", outDir],
        message: strings.reportNoLogs(emptyDir),
        output: outDir,
      },
      {
        name: "a mixed folder",
        argv: ["--dir", logsDir, "--output", outDir],
        message: strings.reportMixedLogs(logsDir),
        output: outDir,
      },
      {
        name: "output inside the input folder",
        argv: ["--session", piLog, "--output", insideOut],
        message: strings.reportOutputRefused,
        output: insideOut,
      },
    ];
    for (const row of cases) {
      const { code, out, err } = await capture(() => runReport(row.argv));
      expect(code, row.name).toBe(2);
      expect(err, row.name).toBe(`${row.message}\n`);
      expect(out, row.name).toBe("");
      const written = fs.existsSync(row.output) ? fs.readdirSync(row.output) : [];
      expect(written, row.name).toEqual([]);
    }
  });
});

describe("report — read-only input", () => {
  /** Expected: bytes and mtimes of every input file are unchanged by a run. */
  it("leaves the input files' bytes and mtimes untouched", async () => {
    const logsDir = path.join(TEST_TMP, "logs");
    const files = [
      writeLog(logsDir, "a.jsonl", piSession("01a14cf6aaaaaaaa", [piUser("one", "2026-10-18T10:00:00.000Z")])),
      writeLog(logsDir, "b.jsonl", piSession("02b2c3d4bbbbbbbb", [piUser("two", "2026-10-18T10:30:00.000Z")])),
    ];
    const before = files.map((file) => ({
      file,
      bytes: fs.readFileSync(file, "utf-8"),
      mtimeMs: fs.statSync(file).mtimeMs,
    }));

    const { code } = await capture(() => runReport(["--dir", logsDir, "--output", path.join(TEST_TMP, "out")]));

    expect(code).toBe(0);
    for (const snapshot of before) {
      expect(fs.readFileSync(snapshot.file, "utf-8")).toBe(snapshot.bytes);
      expect(fs.statSync(snapshot.file).mtimeMs).toBe(snapshot.mtimeMs);
    }
  });
});

describe("report — malformed and partial lines", () => {
  /** Expected: the cut line counts 1 skipped line; the rest still measures. */
  it("reports a cut last line as skipped and measures the rest", async () => {
    const logsDir = path.join(TEST_TMP, "logs");
    const log = writeLog(
      logsDir,
      "pi.jsonl",
      piSession("01a14cf6aaaaaaaa", [
        piUser("one", "2026-10-18T10:00:00.000Z"),
        piAssistant({
          text: "working",
          toolCalls: [],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
          durationMs: 30000,
          timestamp: "2026-10-18T10:00:30.000Z",
        }),
      ]),
    );
    fs.appendFileSync(log, '{"type":"message","id":"cut","timest', "utf-8");
    const outDir = path.join(TEST_TMP, "out");

    const { code } = await capture(() => runReport(["--session", log, "--output", outDir]));

    expect(code).toBe(0);
    const session = readJsonl(outDir).find((row) => row.level === "session");
    expect(session?.skippedLines).toBe(1);
    expect(session?.effort).toEqual({ prompts: 1, turns: 1, wallMs: 30000, modelMs: 30000, toolMs: 0 });
  });
});

describe("report — session start", () => {
  /**
   * Fixture: two Claude Code logs whose first two records are mode and
   * permission-mode records carrying no timestamp. Expected:
   *   | file | first timestamped record | label | row order |
   *   | b-earlier.jsonl | 2026-10-17T23:00:00Z | 2026-10-17 bbbbbbbb | 1 |
   *   | a-later.jsonl | 2026-10-18T09:00:00Z | 2026-10-18 aaaaaaaa | 2 |
   */
  it("labels and sorts sessions by the first record carrying a timestamp", async () => {
    const logsDir = path.join(TEST_TMP, "logs");
    writeLog(
      logsDir,
      "a-later.jsonl",
      ccSession("aaaaaaaa-0000-0000-0000-000000000000", [
        { type: "mode", mode: "tui" },
        { type: "permission-mode", mode: "acceptEdits" },
        ccUser({ text: "later", originKind: "human", isMeta: false, timestamp: "2026-10-18T09:00:00.000Z" }),
        ccAssistant({
          messageId: "msg_1",
          text: "ok",
          toolUses: [],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          timestamp: "2026-10-18T09:00:01.000Z",
        }),
      ]),
    );
    writeLog(
      logsDir,
      "b-earlier.jsonl",
      ccSession("bbbbbbbb-0000-0000-0000-000000000000", [
        { type: "mode", mode: "tui" },
        { type: "permission-mode", mode: "acceptEdits" },
        ccUser({ text: "earlier", originKind: "human", isMeta: false, timestamp: "2026-10-17T23:00:00.000Z" }),
        ccAssistant({
          messageId: "msg_1",
          text: "ok",
          toolUses: [],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          timestamp: "2026-10-17T23:00:01.000Z",
        }),
      ]),
    );
    const outDir = path.join(TEST_TMP, "out");

    const { code } = await capture(() => runReport(["--dir", logsDir, "--output", outDir]));

    expect(code).toBe(0);
    const sessions = readJsonl(outDir).filter((row) => row.level === "session");
    expect(sessions.map((row) => row.session)).toEqual(["2026-10-17 bbbbbbbb", "2026-10-18 aaaaaaaa"]);
  });
});

describe("report — number grouping", () => {
  function measuredRow(prompts: number, turns: number, questions: number): MeasuredRow {
    return {
      effort: { prompts, turns, wallMs: 0, modelMs: 0, toolMs: 0 },
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, peak: 0 },
      costUsd: null,
      checks: {
        test: { runs: 0, failed: 0, fixed: 0, expected: 0 },
        lint: { runs: 0, failed: 0, fixed: 0, expected: 0 },
        typecheck: { runs: 0, failed: 0, fixed: 0, expected: 0 },
      },
      questions,
    };
  }

  /** Expected: the Prompts, Turns, and question columns read 2,202, not 2202. */
  it("groups thousands in the Prompts, Turns, and question columns", () => {
    const row = measuredRow(2202, 2202, 2202);
    const report: FullReport = {
      inputPath: "logs",
      format: "pi",
      generatedDate: "2026-10-18",
      skippedFiles: 0,
      sessions: [
        {
          ...row,
          id: "01a14cf6aaaaaaaa",
          label: "2026-10-18 01a14cf6",
          startMs: 0,
          file: "logs/a.jsonl",
          format: "pi",
          skippedLines: 0,
          segments: [],
        },
      ],
      total: { ...row, skippedFiles: 0, sessions: 1 },
    };

    const md = renderMarkdown(report);

    expect(md).toContain("| 2026-10-18 01a14cf6 | 2,202 | 2,202 | 0.0 min | 0.0 min | 0.0 min |");
    expect(md).toContain("| 2026-10-18 01a14cf6 | 2,202 | 2,202 |");
    expect(md).not.toContain("| 2202 |");
  });
});
