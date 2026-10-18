// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Session report: read one Pi or Claude Code session log (or a folder of them)
 * read-only and write report.md and report.jsonl with the Effort, Tokens and
 * cost, Checks, and Agent questions sections measured per segment, plus
 * exchanges.jsonl: one line per prompt with agent text on both sides, for
 * compass score --exchanges. With --codes, the Your interventions section
 * counts the scores that command wrote back; with --lessons and --grades, the
 * Lessons section grades the rules the labels command listed. The remaining
 * section says "not scored" (Behavior says "not applicable" on Claude Code
 * logs). Offline: no model request, no network, nothing from src/.
 *
 * Usage:
 *   node_modules/.bin/jiti scripts/compass/report.ts \
 *     (--session <file.jsonl> | --dir <folder>) --output <dir> [--codes <scores.jsonl>] \
 *     [--lessons <lessons.jsonl> [--grades <grades.jsonl>]]
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { pathToFileURL } from "node:url";
import { strings } from "./strings.js";
import { parseArgv, sha256Text } from "./util.js";

export type LogFormat = "pi" | "claude-code";

export type CheckKind = "test" | "lint" | "typecheck";

const CHECK_KINDS: CheckKind[] = ["test", "lint", "typecheck"];

/** Bytes of the most recent agent text kept before a check call. */
const AGENT_TEXT_TAIL = 600;

/** The classifier's state ceiling: a bigger exchange is trimmed before scoring. */
export const EXCHANGE_CAP_BYTES = 32 * 1024;

/** An answer at or above this counts as a yes. */
const YES_THRESHOLD = 0.5;

export interface EffortCounts {
  prompts: number;
  turns: number;
  wallMs: number;
  modelMs: number;
  toolMs: number;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  peak: number;
}

export interface CheckCounts {
  runs: number;
  failed: number;
  fixed: number;
  expected: number;
}

export type CheckCountsByKind = Record<CheckKind, CheckCounts>;

export interface MeasuredRow {
  effort: EffortCounts;
  tokens: TokenCounts;
  costUsd: number | null;
  checks: CheckCountsByKind;
  questions: number;
}

export interface SegmentReport extends MeasuredRow {
  index: number;
  promptHead: string;
}

export interface SessionReport extends MeasuredRow {
  id: string;
  label: string;
  startMs: number;
  file: string;
  format: LogFormat;
  skippedLines: number;
  segments: SegmentReport[];
}

export interface TotalReport extends MeasuredRow {
  skippedFiles: number;
  sessions: number;
}

export interface UsageRec {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
}

export interface AssistantRec {
  key: string;
  durationMs: number;
  usage: UsageRec | null;
}

export interface CheckRunRec {
  order: number;
  segmentIndex: number;
  kind: CheckKind;
  failed: boolean;
  expected: boolean;
}

export interface ChangeRec {
  order: number;
  segmentIndex: number;
}

export interface SegmentInput {
  index: number;
  promptHead: string;
  promptText: string;
  firstAgentText: string;
  hasAgentText: boolean;
  firstTimestampMs: number;
  lastTimestampMs: number;
  assistants: AssistantRec[];
  toolResultDurationsMs: number[];
  turnDurationsMs: number[];
  toolPairMs: number[];
  checkRuns: CheckRunRec[];
  changes: ChangeRec[];
  lastAgentText: string;
}

export interface SessionInput {
  id: string;
  startTimestamp: string;
  startMs: number;
  file: string;
  format: LogFormat;
  skippedLines: number;
  segments: SegmentInput[];
  costUsd: number | null;
}

export interface EpisodeRec {
  kind: CheckKind;
  segmentIndex: number;
  fixed: boolean;
}

/** The three texts of one exchange, as the classifier receives them. */
export interface ExchangeFields {
  agentBefore: string;
  userFeedback: string;
  agentAfter: string;
}

/** One line of exchanges.jsonl: a prompt with the agent text before and after it. */
export interface ExchangeLine extends ExchangeFields {
  key: string;
  session: string;
  sessionId: string;
  file: string;
  index: number;
  trimmed: boolean;
}

/** An exchange plus the one join fact it does not print: its segment holds a change. */
export interface ExchangeRecord extends ExchangeLine {
  hasChange: boolean;
}

/** The five reply codes, counted for one prompt. */
export interface CodeFlags {
  approval: boolean;
  correction: boolean;
  holdBack: boolean;
  taskStep: boolean;
  chatter: boolean;
}

/** The Your interventions counts for one session or for the total. */
export interface InterventionCounts {
  approval: number;
  correction: number;
  holdBack: number;
  taskStep: number;
  chatter: number;
  correctionsFollowedByEdits: number;
}

/** One line of a scores file, as --codes reads it. */
export interface ScoreLine {
  key: string;
  verdict: string;
  answers: Record<string, number> | null;
}

/** One line of a lessons file, as --lessons reads it. */
interface LessonLine {
  ruleKey: string;
  key: string;
  sessionId: string;
  file: string;
  index: number;
  rule: string;
  sample: boolean;
}

/** One lesson grade, as --grades reads it. */
interface GradeLine {
  ruleKey: string;
  grade: "good" | "vague" | "wrong";
  userChecked: boolean;
}

/** A session's or the total's lessons counts. */
interface LessonCounts {
  rules: number;
  graded: number;
  good: number;
  vague: number;
  wrong: number;
  userChecked: boolean;
}

/**
 * Pi logs open with a `session` record carrying a `version`; Claude Code logs
 * put a string `sessionId` on every record. The first record of the file
 * decides; anything else is not a session log.
 */
export function detectFormat(firstRecord: Record<string, unknown> | null): LogFormat | null {
  if (firstRecord === null) return null;
  if (firstRecord.type === "session" && firstRecord.version !== undefined) return "pi";
  if (typeof firstRecord.sessionId === "string") return "claude-code";
  return null;
}

/** Remove heredoc bodies and quoted-string contents before command matching. */
export function cleanCommand(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  let heredocEnd: string | null = null;
  for (const line of lines) {
    if (heredocEnd !== null) {
      if (line.trim() === heredocEnd) heredocEnd = null;
      continue;
    }
    const start = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
    if (start) {
      heredocEnd = start[1];
      kept.push(line.slice(0, start.index));
      continue;
    }
    kept.push(line);
  }
  return kept
    .join("\n")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, " ")
    .trim();
}

/** Shell chunks are the parts between command separators. */
function commandChunks(cleaned: string): string[] {
  return cleaned.split(/[;&|\n]+/).filter((chunk) => chunk.trim() !== "");
}

/** Words of one chunk: shell metacharacters are separators, so knip.json is one word. */
function chunkWords(chunk: string): string[] {
  return chunk.split(/[^A-Za-z0-9_:./+@-]+/).filter((word) => word !== "");
}

function matchesWords(words: string[], sequence: string[], prefix: boolean): boolean {
  for (let i = 0; i + sequence.length <= words.length; i++) {
    let hit = true;
    for (let j = 0; j < sequence.length; j++) {
      const last = j === sequence.length - 1;
      const matches = prefix && last ? words[i + j].startsWith(sequence[j]) : words[i + j] === sequence[j];
      if (!matches) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

const CHECK_PATTERNS: Record<CheckKind, { sequence: string[]; prefix: boolean }[]> = {
  test: [
    { sequence: ["vitest"], prefix: false },
    { sequence: ["jest"], prefix: false },
    { sequence: ["pytest"], prefix: false },
    { sequence: ["npm", "test"], prefix: false },
    { sequence: ["npm", "run", "test"], prefix: true },
    { sequence: ["cargo", "test"], prefix: false },
    { sequence: ["go", "test"], prefix: false },
  ],
  lint: [
    { sequence: ["biome"], prefix: false },
    { sequence: ["eslint"], prefix: false },
    { sequence: ["ruff"], prefix: false },
    { sequence: ["npm", "run", "lint"], prefix: true },
    { sequence: ["knip"], prefix: false },
    { sequence: ["jscpd"], prefix: false },
  ],
  typecheck: [
    { sequence: ["tsc"], prefix: false },
    { sequence: ["mypy"], prefix: false },
    { sequence: ["pyright"], prefix: false },
    { sequence: ["npm", "run", "typecheck"], prefix: false },
  ],
};

/** The check kind a cleaned command runs, first match in the test, lint, typecheck order. */
export function checkKind(command: string): CheckKind | null {
  const chunks = commandChunks(cleanCommand(command)).map(chunkWords);
  for (const kind of CHECK_KINDS) {
    for (const pattern of CHECK_PATTERNS[kind]) {
      if (chunks.some((words) => matchesWords(words, pattern.sequence, pattern.prefix))) return kind;
    }
  }
  return null;
}

/** Whether the cleaned command runs a check tool as a command word. */
export function isCheck(command: string): boolean {
  return checkKind(command) !== null;
}

const FAILURE_MARKERS: RegExp[] = [
  /(\d+) failed/,
  /\bFAIL\b/,
  /(?:^|\n)\s*[×✗]/,
  /error TS/,
  /Found (\d+) error/,
  /\bexit code (\d+)\b/i,
  /\bCommand exited with code (\d+)\b/,
  /\bexit=(\d+)\b/,
  /\bEXIT:(\d+)\b/,
];

/** A run failed when its result is an error or its text carries a failure marker. */
export function isFailed(resultText: string, isError: boolean): boolean {
  if (isError) return true;
  for (const marker of FAILURE_MARKERS) {
    const match = marker.exec(resultText);
    if (!match) continue;
    const count = match[1];
    if (count !== undefined && /^\d+$/.test(count) && Number(count) < 1) continue;
    return true;
  }
  return false;
}

const EXPECTED_MARKERS: RegExp[] = [
  /should fail/i,
  /must fail/i,
  /expect[\s\S]*to fail/i,
  /confirm[\s\S]*fails/i,
  /fails before/i,
  /fails on the current/i,
  /test-first/i,
  /test first/i,
  /mutant/i,
  /reproduc/i,
  /before the fix/i,
  /failing test/i,
];

/** Whether the agent text before a call declares the failure expected. */
export function isExpected(agentText: string): boolean {
  return EXPECTED_MARKERS.some((marker) => marker.test(agentText));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The text of message content: a string, or the text blocks joined with newlines. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of asArray(content)) {
    const record = asRecord(block);
    if (record !== null && record.type === "text") {
      const text = asString(record.text);
      if (text !== null) parts.push(text);
    }
  }
  return parts.join("\n");
}

/** Prompt heads and question lines work on whitespace-collapsed text. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

interface PendingCheck {
  order: number;
  segmentIndex: number;
  kind: CheckKind;
  expected: boolean;
}

interface PendingPair {
  startMs: number;
  segmentIndex: number;
}

interface SegmentBuilder {
  index: number;
  promptHead: string;
  promptText: string;
  firstMessageKey: string | null;
  firstAgentText: string;
  hasAgentText: boolean;
  firstTimestampMs: number;
  lastTimestampMs: number;
  assistants: AssistantRec[];
  seenAssistantKeys: Set<string>;
  toolResultDurationsMs: number[];
  turnDurationsMs: number[];
  toolPairMs: number[];
  checkRuns: CheckRunRec[];
  changes: ChangeRec[];
  lastAgentText: string;
}

interface BuilderState {
  format: LogFormat;
  order: number;
  eventOrder: number;
  segments: SegmentBuilder[];
  current: SegmentBuilder | null;
  pendingChecks: Map<string, PendingCheck>;
  pendingPairs: Map<string, PendingPair>;
  agentKey: string | null;
  agentText: string;
  priorAgentText: string;
  skippedLines: number;
  sessionId: string;
  startTimestamp: string;
  startMs: number;
  costUsd: number | null;
  sawStart: boolean;
}

function newBuilder(format: LogFormat): BuilderState {
  return {
    format,
    order: 0,
    eventOrder: 0,
    segments: [],
    current: null,
    pendingChecks: new Map(),
    pendingPairs: new Map(),
    agentKey: null,
    agentText: "",
    priorAgentText: "",
    skippedLines: 0,
    sessionId: "",
    startTimestamp: "",
    startMs: 0,
    costUsd: null,
    sawStart: false,
  };
}

function startSegment(state: BuilderState, promptText: string, timestampMs: number): void {
  if (state.current !== null) closeSegment(state);
  state.current = {
    index: state.segments.length + 1,
    promptHead: collapseWhitespace(promptText).slice(0, 48),
    promptText,
    firstMessageKey: null,
    firstAgentText: "",
    hasAgentText: false,
    firstTimestampMs: timestampMs,
    lastTimestampMs: timestampMs,
    assistants: [],
    seenAssistantKeys: new Set(),
    toolResultDurationsMs: [],
    turnDurationsMs: [],
    toolPairMs: [],
    checkRuns: [],
    changes: [],
    lastAgentText: "",
  };
  state.segments.push(state.current);
  state.agentKey = null;
  state.agentText = "";
  state.priorAgentText = "";
}

function closeSegment(state: BuilderState): void {
  if (state.current === null) return;
  state.current.lastAgentText = state.agentText !== "" ? state.agentText : state.priorAgentText;
  state.current = null;
}

/**
 * Agent text accumulates per message (same message key appends, a new key
 * replaces). The first message that carries text supplies the segment's first
 * agent text; a segment without text of its own has none to inherit.
 */
function appendAgentText(state: BuilderState, key: string, text: string): void {
  if (text === "") return;
  const segment = state.current;
  if (state.agentKey === key) {
    state.agentText = state.agentText === "" ? text : `${state.agentText}\n${text}`;
    if (segment !== null && segment.firstMessageKey === key)
      segment.firstAgentText = `${segment.firstAgentText}\n${text}`;
    return;
  }
  if (state.agentText !== "") state.priorAgentText = state.agentText;
  state.agentKey = key;
  state.agentText = text;
  if (segment !== null && segment.firstMessageKey === null) {
    segment.firstMessageKey = key;
    segment.firstAgentText = text;
    segment.hasAgentText = true;
  }
}

/** The most recent agent text before a call, last 600 characters. */
function agentTextTail(state: BuilderState): string {
  const text = state.agentText !== "" ? state.agentText : state.priorAgentText;
  return text.slice(-AGENT_TEXT_TAIL);
}

/** Tool names whose call is a change: an edit or write call. */
function isChangeToolName(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.endsWith("edit") || normalized.endsWith("write");
}

function isChangeCommand(command: string): boolean {
  const cleaned = cleanCommand(command);
  return cleaned.includes("--write") || cleaned.includes("--fix") || cleaned.includes("sed -i");
}

function timestampOf(record: Record<string, unknown>): number {
  const raw = record.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const text = asString(raw);
  if (text !== null) {
    const ms = Date.parse(text);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

/** A tool call: record the change or open a pending check run awaiting its result. */
function handleToolCall(
  state: BuilderState,
  id: string | null,
  name: string,
  command: string | null,
  timestampMs: number,
): void {
  const segment = state.current;
  if (segment === null) return;
  const order = state.eventOrder;
  state.eventOrder++;
  if (isChangeToolName(name) || (command !== null && isChangeCommand(command))) {
    segment.changes.push({ order, segmentIndex: segment.index });
  }
  if (state.format === "claude-code" && id !== null) {
    state.pendingPairs.set(id, { startMs: timestampMs, segmentIndex: segment.index });
  }
  if (name.toLowerCase() !== "bash" || command === null) return;
  const kind = checkKind(command);
  if (kind === null) return;
  const pending: PendingCheck = {
    order,
    segmentIndex: segment.index,
    kind,
    expected: isExpected(agentTextTail(state)),
  };
  if (id === null) {
    segment.checkRuns.push({ order, segmentIndex: segment.index, kind, failed: false, expected: pending.expected });
    return;
  }
  state.pendingChecks.set(id, pending);
}

/** A tool result closes its pending check run and, on Claude Code, its tool-time pair. */
function handleToolResult(
  state: BuilderState,
  id: string | null,
  text: string,
  isError: boolean,
  durationMs: number | null,
  timestampMs: number,
): void {
  if (state.current !== null && durationMs !== null) state.current.toolResultDurationsMs.push(durationMs);
  if (id !== null) {
    const pending = state.pendingChecks.get(id);
    if (pending !== undefined) {
      state.segments[pending.segmentIndex - 1].checkRuns.push({
        order: pending.order,
        segmentIndex: pending.segmentIndex,
        kind: pending.kind,
        failed: isFailed(text, isError),
        expected: pending.expected,
      });
      state.pendingChecks.delete(id);
    }
    const pair = state.pendingPairs.get(id);
    if (pair !== undefined) {
      const elapsed = timestampMs - pair.startMs;
      if (elapsed >= 0) state.segments[pair.segmentIndex - 1].toolPairMs.push(elapsed);
      state.pendingPairs.delete(id);
    }
  }
}

function piAssistant(state: BuilderState, record: Record<string, unknown>, timestampMs: number): void {
  const message = asRecord(record.message);
  if (message === null) return;
  const key = asString(record.id) ?? `record-${state.order}`;
  for (const block of asArray(message.content)) {
    const item = asRecord(block);
    if (item === null) continue;
    if (item.type === "text") {
      const text = asString(item.text);
      if (text !== null) appendAgentText(state, key, text);
      continue;
    }
    if (item.type === "toolCall") {
      const args = asRecord(item.arguments);
      handleToolCall(
        state,
        asString(item.id),
        asString(item.name) ?? "",
        args === null ? null : asString(args.command),
        timestampMs,
      );
    }
  }
  const segment = state.current;
  if (segment === null || segment.seenAssistantKeys.has(key)) return;
  segment.seenAssistantKeys.add(key);
  const usageRec = asRecord(message.usage);
  const costRec = usageRec === null ? null : asRecord(usageRec.cost);
  const usage: UsageRec | null =
    usageRec === null
      ? null
      : {
          input: asNumber(usageRec.input) ?? 0,
          output: asNumber(usageRec.output) ?? 0,
          cacheRead: asNumber(usageRec.cacheRead) ?? 0,
          cacheWrite: asNumber(usageRec.cacheWrite) ?? 0,
          costUsd: costRec === null ? null : asNumber(costRec.total),
        };
  segment.assistants.push({ key, durationMs: asNumber(message.durationMs) ?? 0, usage });
}

function piToolResult(state: BuilderState, record: Record<string, unknown>, timestampMs: number): void {
  const message = asRecord(record.message);
  if (message === null) return;
  handleToolResult(
    state,
    asString(message.toolCallId),
    contentText(message.content),
    message.isError === true,
    asNumber(message.durationMs),
    timestampMs,
  );
}

function applyPiRecord(state: BuilderState, record: Record<string, unknown>, timestampMs: number): void {
  const message = asRecord(record.message);
  if (message === null) return;
  const role = message.role;
  if (role === "user") {
    startSegment(state, contentText(message.content), timestampMs);
    return;
  }
  if (role === "assistant") {
    piAssistant(state, record, timestampMs);
    return;
  }
  if (role === "toolResult") piToolResult(state, record, timestampMs);
}

function claudeAssistant(state: BuilderState, record: Record<string, unknown>, timestampMs: number): void {
  const message = asRecord(record.message);
  if (message === null) return;
  const key = asString(message.id) ?? `record-${state.order}`;
  for (const block of asArray(message.content)) {
    const item = asRecord(block);
    if (item === null) continue;
    if (item.type === "text") {
      const text = asString(item.text);
      if (text !== null) appendAgentText(state, key, text);
      continue;
    }
    if (item.type === "tool_use") {
      const input = asRecord(item.input);
      handleToolCall(
        state,
        asString(item.id),
        asString(item.name) ?? "",
        input === null ? null : asString(input.command),
        timestampMs,
      );
    }
  }
  const segment = state.current;
  if (segment === null || segment.seenAssistantKeys.has(key)) return;
  segment.seenAssistantKeys.add(key);
  const usageRec = asRecord(message.usage);
  const usage: UsageRec | null =
    usageRec === null
      ? null
      : {
          input: asNumber(usageRec.input_tokens) ?? 0,
          output: asNumber(usageRec.output_tokens) ?? 0,
          cacheRead: asNumber(usageRec.cache_read_input_tokens) ?? 0,
          cacheWrite: asNumber(usageRec.cache_creation_input_tokens) ?? 0,
          costUsd: null,
        };
  segment.assistants.push({ key, durationMs: 0, usage });
}

function claudeUser(state: BuilderState, record: Record<string, unknown>, timestampMs: number): void {
  const message = asRecord(record.message);
  const content = message === null ? null : message.content;
  let hasToolResult = false;
  for (const block of asArray(content)) {
    const item = asRecord(block);
    if (item === null || item.type !== "tool_result") continue;
    hasToolResult = true;
    handleToolResult(
      state,
      asString(item.tool_use_id),
      contentText(item.content),
      item.is_error === true,
      null,
      timestampMs,
    );
  }
  const origin = asRecord(record.origin);
  const isHuman = origin !== null && origin.kind === "human";
  if (!isHuman || record.isMeta === true || hasToolResult) return;
  // A prompt's content is a string in real logs and an array of blocks elsewhere; both keep their text.
  startSegment(state, contentText(content), timestampMs);
}

function applyClaudeRecord(state: BuilderState, record: Record<string, unknown>, timestampMs: number): void {
  if (record.isSidechain === true) return;
  const type = record.type;
  if (type === "user") {
    claudeUser(state, record, timestampMs);
    return;
  }
  if (type === "assistant") {
    claudeAssistant(state, record, timestampMs);
    return;
  }
  if (type === "system" && record.subtype === "turn_duration") {
    const durationMs = asNumber(record.durationMs);
    if (state.current !== null && durationMs !== null) state.current.turnDurationsMs.push(durationMs);
    return;
  }
  if (type === "cost-state") {
    const cost = asNumber(record.totalCostUSD);
    if (cost !== null) state.costUsd = cost;
  }
}

function applyRecord(state: BuilderState, record: Record<string, unknown>, timestampMs: number): void {
  if (state.format === "pi") applyPiRecord(state, record, timestampMs);
  else applyClaudeRecord(state, record, timestampMs);
  if (state.current !== null) state.current.lastTimestampMs = timestampMs;
}

function toSegmentInput(builder: SegmentBuilder): SegmentInput {
  return {
    index: builder.index,
    promptHead: builder.promptHead,
    promptText: builder.promptText,
    firstAgentText: builder.firstAgentText,
    hasAgentText: builder.hasAgentText,
    firstTimestampMs: builder.firstTimestampMs,
    lastTimestampMs: builder.lastTimestampMs,
    assistants: builder.assistants,
    toolResultDurationsMs: builder.toolResultDurationsMs,
    turnDurationsMs: builder.turnDurationsMs,
    toolPairMs: builder.toolPairMs,
    checkRuns: builder.checkRuns,
    changes: builder.changes,
    lastAgentText: builder.lastAgentText,
  };
}

/**
 * Stream one session file line by line and return its segments with the
 * records each needs. Blank and malformed lines are skipped and counted;
 * tool calls and results are paired by id, and only measured fields are kept.
 */
export async function readSegments(file: string, format: LogFormat): Promise<SessionInput> {
  const state = newBuilder(format);
  const stream = fs.createReadStream(file, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === "") {
      state.skippedLines++;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      state.skippedLines++;
      continue;
    }
    const record = asRecord(parsed);
    if (record === null) {
      state.skippedLines++;
      continue;
    }
    state.order++;
    const timestampMs = timestampOf(record);
    if (state.sessionId === "") {
      const recordId = format === "pi" ? (state.order === 1 ? asString(record.id) : null) : asString(record.sessionId);
      if (recordId !== null) state.sessionId = recordId;
    }
    if (!state.sawStart && record.timestamp !== undefined && record.timestamp !== null) {
      state.startTimestamp = asString(record.timestamp) ?? "";
      state.startMs = timestampMs;
      state.sawStart = true;
    }
    applyRecord(state, record, timestampMs);
  }
  closeSegment(state);
  for (const pending of state.pendingChecks.values()) {
    state.segments[pending.segmentIndex - 1].checkRuns.push({
      order: pending.order,
      segmentIndex: pending.segmentIndex,
      kind: pending.kind,
      failed: false,
      expected: pending.expected,
    });
  }
  return {
    id: state.sessionId,
    startTimestamp: state.startTimestamp,
    startMs: state.startMs,
    file,
    format,
    skippedLines: state.skippedLines,
    segments: state.segments.map(toSegmentInput),
    costUsd: state.costUsd,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** The JSON-escaped size of one string value: its bytes between the two quotes. */
function escapedBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf-8") - 2;
}

function exchangeBytes(fields: ExchangeFields): number {
  return Buffer.byteLength(
    JSON.stringify({
      agentBefore: fields.agentBefore,
      userFeedback: fields.userFeedback,
      agentAfter: fields.agentAfter,
    }),
    "utf-8",
  );
}

/** Drop one character from the end, keeping a surrogate pair together. */
function dropLastCharacter(text: string): string {
  const last = text.slice(-2);
  return [...last].length === 1 && last.length === 2 ? text.slice(0, -2) : text.slice(0, -1);
}

/** Drop one character, keeping a surrogate pair together. */
function dropFirstCharacter(text: string): string {
  const first = text.slice(0, 2);
  return [...first].length === 1 && first.length === 2 ? text.slice(2) : text.slice(1);
}

/** The longest end of `text` whose JSON-escaped size fits `budget`. */
function keepSuffix(text: string, budget: number): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const kept = Math.ceil((low + high) / 2);
    if (escapedBytes(text.slice(text.length - kept)) <= budget) low = kept;
    else high = kept - 1;
  }
  let suffix = text.slice(text.length - low);
  while (suffix !== "" && escapedBytes(suffix) > budget) suffix = suffix.slice(1);
  return suffix;
}

/** The longest start of `text` whose JSON-escaped size fits `budget`. */
function keepPrefix(text: string, budget: number): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const kept = Math.ceil((low + high) / 2);
    if (escapedBytes(text.slice(0, kept)) <= budget) low = kept;
    else high = kept - 1;
  }
  let prefix = text.slice(0, low);
  while (prefix !== "" && escapedBytes(prefix) > budget) prefix = prefix.slice(0, -1);
  return prefix;
}

/**
 * The exchange as the classifier receives it: the prompt whole, the end of the
 * agent text before it, and the start of the agent text after it. Over the cap,
 * the after text gets at most a quarter of the room left by the prompt and the
 * before text the rest; null when the prompt alone does not fit.
 */
export function trimExchange(fields: ExchangeFields, cap: number): (ExchangeFields & { trimmed: boolean }) | null {
  if (exchangeBytes(fields) <= cap) return { ...fields, trimmed: false };
  const room = cap - exchangeBytes({ agentBefore: "", userFeedback: fields.userFeedback, agentAfter: "" });
  if (room < 0) return null;
  const afterShare = Math.floor(room / 4);
  const fitted = fitExchange(
    {
      agentBefore: keepSuffix(fields.agentBefore, room - afterShare),
      userFeedback: fields.userFeedback,
      agentAfter: keepPrefix(fields.agentAfter, afterShare),
    },
    cap,
  );
  return { ...fitted, trimmed: true };
}

/**
 * Shorten an over-cap exchange by characters until it fits: the end of the after
 * text goes first, then the start of the before text, so the kept parts stay at
 * the prompt's edge.
 */
export function fitExchange(fields: ExchangeFields, cap: number): ExchangeFields {
  let agentBefore = fields.agentBefore;
  let agentAfter = fields.agentAfter;
  while (exchangeBytes({ agentBefore, userFeedback: fields.userFeedback, agentAfter }) > cap) {
    if (agentAfter !== "") agentAfter = dropLastCharacter(agentAfter);
    else if (agentBefore !== "") agentBefore = dropFirstCharacter(agentBefore);
    else break;
  }
  return { agentBefore, userFeedback: fields.userFeedback, agentAfter };
}

/** The exchange's cache and score key: 16 hex characters over the session and the three texts. */
export function exchangeKey(sessionId: string, index: number, fields: ExchangeFields): string {
  return sha256Text(
    `${sessionId}\n${index}\n${fields.agentBefore}\n${fields.userFeedback}\n${fields.agentAfter}`,
  ).slice(0, 16);
}

/**
 * Every prompt that has agent text on both sides: the prompt of segment i, the
 * last agent text of segment i − 1, and the first agent text of segment i.
 */
export function buildExchanges(input: SessionInput): ExchangeRecord[] {
  const exchanges: ExchangeRecord[] = [];
  for (let position = 1; position < input.segments.length; position++) {
    const before = input.segments[position - 1];
    const after = input.segments[position];
    // A segment with text of its own keeps that text in lastAgentText; closeSegment only
    // borrows a predecessor's when the segment has none, so hasAgentText guards the borrow.
    if (!before.hasAgentText || !after.hasAgentText) continue;
    const fields = trimExchange(
      {
        agentBefore: before.lastAgentText,
        userFeedback: after.promptText,
        agentAfter: after.firstAgentText,
      },
      EXCHANGE_CAP_BYTES,
    );
    if (fields === null) continue;
    exchanges.push({
      key: exchangeKey(input.id, after.index, fields),
      session: sessionLabel(input),
      sessionId: input.id,
      file: path.basename(input.file),
      index: after.index,
      agentBefore: fields.agentBefore,
      userFeedback: fields.userFeedback,
      agentAfter: fields.agentAfter,
      trimmed: fields.trimmed,
      hasChange: after.changes.length > 0,
    });
  }
  return exchanges;
}

/** The sessions' exchanges with any repeated key dropped, first one wins. */
export function dedupeExchanges(bySession: ExchangeRecord[][]): ExchangeRecord[][] {
  const seen = new Set<string>();
  return bySession.map((exchanges) =>
    exchanges.filter((exchange) => {
      if (seen.has(exchange.key)) return false;
      seen.add(exchange.key);
      return true;
    }),
  );
}

/** exchanges.jsonl: one line per exchange, in session order then segment order. */
export function renderExchanges(bySession: ExchangeRecord[][]): string {
  const lines: string[] = [];
  for (const exchanges of bySession) {
    for (const exchange of exchanges) {
      lines.push(
        JSON.stringify({
          key: exchange.key,
          session: exchange.session,
          sessionId: exchange.sessionId,
          file: exchange.file,
          index: exchange.index,
          agentBefore: exchange.agentBefore,
          userFeedback: exchange.userFeedback,
          agentAfter: exchange.agentAfter,
          trimmed: exchange.trimmed,
        }),
      );
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** The file's JSON objects, one per non-empty line, or null when it is missing or unparseable. */
function readJsonl(file: string): Record<string, unknown>[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const entries: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    const record = asRecord(parsed);
    if (record === null) return null;
    entries.push(record);
  }
  return entries;
}

/** A scores file as a key → line map; null when a line is unreadable or lacks key and verdict. */
export function parseScores(file: string): Map<string, ScoreLine> | null {
  const entries = readJsonl(file);
  if (entries === null) return null;
  const scores = new Map<string, ScoreLine>();
  for (const record of entries) {
    const key = asString(record.key);
    const verdict = asString(record.verdict);
    if (key === null || verdict === null) return null;
    const answers = asRecord(record.answers);
    const values: Record<string, number> = {};
    if (answers !== null) {
      for (const [id, value] of Object.entries(answers)) {
        const answer = asNumber(value);
        if (answer !== null) values[id] = answer;
      }
    }
    if (!scores.has(key)) scores.set(key, { key, verdict, answers: answers === null ? null : values });
  }
  return scores;
}

/** The lessons rows by rule key in file order, or null when a line is not a row or a key repeats. */
function parseLessons(file: string): Map<string, LessonLine> | null {
  const entries = readJsonl(file);
  if (entries === null) return null;
  const lines = new Map<string, LessonLine>();
  for (const record of entries) {
    const ruleKey = asString(record.ruleKey);
    const key = asString(record.key);
    const sessionId = asString(record.sessionId);
    const sourceFile = asString(record.file);
    const rule = asString(record.rule);
    const index = asNumber(record.index);
    if (ruleKey === null || key === null || sessionId === null || sourceFile === null || rule === null) return null;
    if (index === null || !Number.isInteger(index)) return null;
    if (typeof record.sample !== "boolean") return null;
    if (lines.has(ruleKey)) return null;
    lines.set(ruleKey, {
      ruleKey,
      key,
      sessionId,
      file: sourceFile,
      index,
      rule,
      sample: record.sample,
    });
  }
  return lines;
}

/** The grades by rule key, or null when a line is not a grade for a unique listed rule. */
function parseGrades(file: string, lessons: Map<string, LessonLine>): Map<string, GradeLine> | null {
  const entries = readJsonl(file);
  if (entries === null) return null;
  const grades = new Map<string, GradeLine>();
  for (const record of entries) {
    const ruleKey = asString(record.ruleKey);
    const grade = record.grade;
    if (ruleKey === null || !lessons.has(ruleKey) || grades.has(ruleKey)) return null;
    if (grade !== "good" && grade !== "vague" && grade !== "wrong") return null;
    if (typeof record.userChecked !== "boolean") return null;
    if (record.note !== undefined && typeof record.note !== "string") return null;
    grades.set(ruleKey, { ruleKey, grade, userChecked: record.userChecked });
  }
  return grades;
}

function emptyChecks(): CheckCountsByKind {
  return {
    test: { runs: 0, failed: 0, fixed: 0, expected: 0 },
    lint: { runs: 0, failed: 0, fixed: 0, expected: 0 },
    typecheck: { runs: 0, failed: 0, fixed: 0, expected: 0 },
  };
}

function emptyRow(): MeasuredRow {
  return {
    effort: { prompts: 0, turns: 0, wallMs: 0, modelMs: 0, toolMs: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, peak: 0 },
    costUsd: null,
    checks: emptyChecks(),
    questions: 0,
  };
}

function addRow(target: MeasuredRow, source: MeasuredRow): void {
  target.effort.prompts += source.effort.prompts;
  target.effort.turns += source.effort.turns;
  target.effort.wallMs += source.effort.wallMs;
  target.effort.modelMs += source.effort.modelMs;
  target.effort.toolMs += source.effort.toolMs;
  target.tokens.input += source.tokens.input;
  target.tokens.output += source.tokens.output;
  target.tokens.cacheRead += source.tokens.cacheRead;
  target.tokens.cacheWrite += source.tokens.cacheWrite;
  target.tokens.peak = Math.max(target.tokens.peak, source.tokens.peak);
  if (source.costUsd !== null) target.costUsd = (target.costUsd ?? 0) + source.costUsd;
  for (const kind of CHECK_KINDS) {
    target.checks[kind].runs += source.checks[kind].runs;
    target.checks[kind].failed += source.checks[kind].failed;
    target.checks[kind].fixed += source.checks[kind].fixed;
    target.checks[kind].expected += source.checks[kind].expected;
  }
  target.questions += source.questions;
}

/**
 * Episode closing over the whole session: an episode opens at a failed run that
 * was not expected, later failed runs of the same kind join it, and it closes at
 * the first later passing run of that kind. It is fixed when a change lies
 * between its first failure and that pass; a passing run that is itself the
 * change counts. Each episode is counted in the segment of its first failure.
 */
export function fixedEpisodes(checkRuns: CheckRunRec[], changes: ChangeRec[]): EpisodeRec[] {
  const runs = [...checkRuns].sort((a, b) => a.order - b.order);
  const changeOrders = [...changes].sort((a, b) => a.order - b.order).map((change) => change.order);
  const open: Partial<Record<CheckKind, { firstFailureOrder: number; segmentIndex: number }>> = {};
  const episodes: EpisodeRec[] = [];
  for (const run of runs) {
    const active = open[run.kind];
    if (run.failed) {
      if (active === undefined && !run.expected)
        open[run.kind] = { firstFailureOrder: run.order, segmentIndex: run.segmentIndex };
      continue;
    }
    if (active === undefined) continue;
    episodes.push({
      kind: run.kind,
      segmentIndex: active.segmentIndex,
      fixed: changeOrders.some((order) => order > active.firstFailureOrder && order <= run.order),
    });
    delete open[run.kind];
  }
  for (const kind of CHECK_KINDS) {
    const active = open[kind];
    if (active !== undefined) episodes.push({ kind, segmentIndex: active.segmentIndex, fixed: false });
  }
  return episodes;
}

/** The last three non-empty lines hold a line ending in a question mark. */
function endsWithQuestion(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.slice(-3).some((line) => line.endsWith("?"));
}

/** The report's metrics for one segment. */
export function measureSegment(segment: SegmentInput, format: LogFormat, episodes: EpisodeRec[]): SegmentReport {
  const toolMs = format === "pi" ? sum(segment.toolResultDurationsMs) : sum(segment.toolPairMs);
  const wallMs =
    format === "pi" ? Math.max(0, segment.lastTimestampMs - segment.firstTimestampMs) : sum(segment.turnDurationsMs);
  const modelMs =
    format === "pi" ? sum(segment.assistants.map((assistant) => assistant.durationMs)) : Math.max(0, wallMs - toolMs);
  const tokens: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, peak: 0 };
  let costSum = 0;
  let costRecorded = false;
  for (const assistant of segment.assistants) {
    const usage = assistant.usage;
    if (usage === null) continue;
    tokens.input += usage.input;
    tokens.output += usage.output;
    tokens.cacheRead += usage.cacheRead;
    tokens.cacheWrite += usage.cacheWrite;
    const context = format === "pi" ? usage.input + usage.cacheRead : usage.input + usage.cacheRead + usage.cacheWrite;
    tokens.peak = Math.max(tokens.peak, context);
    if (usage.costUsd !== null) {
      costSum += usage.costUsd;
      costRecorded = true;
    }
  }
  const checks = emptyChecks();
  for (const run of segment.checkRuns) {
    const counts = checks[run.kind];
    counts.runs++;
    if (run.failed) counts.failed++;
    if (run.failed && run.expected) counts.expected++;
  }
  for (const episode of episodes) {
    if (episode.segmentIndex === segment.index && episode.fixed) checks[episode.kind].fixed++;
  }
  return {
    index: segment.index,
    promptHead: segment.promptHead,
    effort: { prompts: 1, turns: segment.assistants.length, wallMs, modelMs, toolMs },
    tokens,
    costUsd: costRecorded ? costSum : null,
    checks,
    questions: endsWithQuestion(segment.lastAgentText) ? 1 : 0,
  };
}

function localDateOf(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The session's start date: the date as the log wrote it, else local. */
function startDateOf(input: SessionInput): string {
  const written = /^(\d{4}-\d{2}-\d{2})/.exec(input.startTimestamp);
  if (written !== null) return written[1];
  return localDateOf(new Date(input.startMs));
}

/** Row label: the session's start date and the first 8 characters of its id. */
export function sessionLabel(input: SessionInput): string {
  return `${startDateOf(input)} ${input.id.slice(0, 8)}`;
}

export function measureSession(input: SessionInput): SessionReport {
  const episodes = fixedEpisodes(
    input.segments.flatMap((segment) => segment.checkRuns),
    input.segments.flatMap((segment) => segment.changes),
  );
  const segments = input.segments.map((segment) => measureSegment(segment, input.format, episodes));
  const row = emptyRow();
  for (const segment of segments) addRow(row, segment);
  return {
    id: input.id,
    label: sessionLabel(input),
    startMs: input.startMs,
    file: input.file,
    format: input.format,
    skippedLines: input.skippedLines,
    segments,
    effort: row.effort,
    tokens: row.tokens,
    costUsd: input.format === "claude-code" ? input.costUsd : row.costUsd,
    checks: row.checks,
    questions: row.questions,
  };
}

export function measureTotal(sessions: SessionReport[], skippedFiles: number): TotalReport {
  const row = emptyRow();
  for (const session of sessions) addRow(row, session);
  return {
    skippedFiles,
    sessions: sessions.length,
    effort: row.effort,
    tokens: row.tokens,
    costUsd: row.costUsd,
    checks: row.checks,
    questions: row.questions,
  };
}

export interface FullReport {
  inputPath: string;
  format: LogFormat;
  generatedDate: string;
  skippedFiles: number;
  sessions: SessionReport[];
  total: TotalReport;
  exchanges: ExchangeRecord[][];
  scores: Map<string, ScoreLine> | null;
  lessons: Map<string, LessonLine> | null;
  grades: Map<string, GradeLine> | null;
}

/** The five codes for one prompt: an answer at or above 0.5 is a yes. */
function flagsOf(answers: Record<string, number> | null): CodeFlags {
  const answer = (id: string): boolean => (answers?.[id] ?? 0) >= YES_THRESHOLD;
  return {
    approval: answer("approval"),
    correction: answer("correction"),
    holdBack: answer("hold_back"),
    taskStep: answer("task_step"),
    chatter: answer("chatter"),
  };
}

/** One session's join: its counts when every exchange scored, and each prompt's codes. */
interface SessionJoin {
  interventions: InterventionCounts | null;
  codes: Map<number, CodeFlags>;
}

/**
 * A session is scored when every one of its exchanges has a scored line; its
 * counts and per-prompt codes then come from those answers. A session with no
 * exchanges is scored with zero counts.
 */
function joinSession(exchanges: ExchangeRecord[], scores: Map<string, ScoreLine> | null): SessionJoin {
  const none: SessionJoin = { interventions: null, codes: new Map() };
  if (scores === null) return none;
  for (const exchange of exchanges) {
    const line = scores.get(exchange.key);
    if (line === undefined || line.verdict !== "scored") return none;
  }
  const counts: InterventionCounts = {
    approval: 0,
    correction: 0,
    holdBack: 0,
    taskStep: 0,
    chatter: 0,
    correctionsFollowedByEdits: 0,
  };
  const codes = new Map<number, CodeFlags>();
  for (const exchange of exchanges) {
    const line = scores.get(exchange.key);
    const flags = flagsOf(line === undefined ? null : line.answers);
    codes.set(exchange.index, flags);
    if (flags.approval) counts.approval++;
    if (flags.correction) counts.correction++;
    if (flags.holdBack) counts.holdBack++;
    if (flags.taskStep) counts.taskStep++;
    if (flags.chatter) counts.chatter++;
    if (flags.correction && exchange.hasChange) counts.correctionsFollowedByEdits++;
  }
  return { interventions: counts, codes };
}

function joinReport(report: FullReport): SessionJoin[] {
  return report.sessions.map((_session, position) => joinSession(report.exchanges[position] ?? [], report.scores));
}

/** The total row: the sum of every session's counts, or null when any session is not scored. */
function totalInterventions(joins: SessionJoin[]): InterventionCounts | null {
  const total: InterventionCounts = {
    approval: 0,
    correction: 0,
    holdBack: 0,
    taskStep: 0,
    chatter: 0,
    correctionsFollowedByEdits: 0,
  };
  for (const join of joins) {
    const counts = join.interventions;
    if (counts === null) return null;
    total.approval += counts.approval;
    total.correction += counts.correction;
    total.holdBack += counts.holdBack;
    total.taskStep += counts.taskStep;
    total.chatter += counts.chatter;
    total.correctionsFollowedByEdits += counts.correctionsFollowedByEdits;
  }
  return total;
}

function formatLabel(format: LogFormat): string {
  return format === "pi" ? "Pi" : "Claude Code";
}

function tableRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function separatorRow(headerRow: string): string {
  const columns = headerRow.split("|").length - 2;
  return tableRow(Array.from({ length: columns }, () => "---"));
}

function effortRow(label: string, row: MeasuredRow): string {
  return tableRow([
    label,
    strings.reportNumber(row.effort.prompts),
    strings.reportNumber(row.effort.turns),
    strings.reportMinutes(row.effort.wallMs),
    strings.reportMinutes(row.effort.modelMs),
    strings.reportMinutes(row.effort.toolMs),
  ]);
}

function tokensRow(label: string, row: MeasuredRow): string {
  return tableRow([
    label,
    strings.reportNumber(row.tokens.input),
    strings.reportNumber(row.tokens.output),
    strings.reportNumber(row.tokens.cacheRead),
    strings.reportNumber(row.tokens.cacheWrite),
    strings.reportNumber(row.tokens.peak),
    strings.reportCost(row.costUsd),
  ]);
}

function checkCells(row: MeasuredRow): string[] {
  const totals = emptyChecks().test;
  for (const kind of CHECK_KINDS) {
    totals.runs += row.checks[kind].runs;
    totals.failed += row.checks[kind].failed;
    totals.fixed += row.checks[kind].fixed;
    totals.expected += row.checks[kind].expected;
  }
  return [`${totals.runs}`, `${totals.failed}`, `${totals.fixed}`, `${totals.expected}`];
}

function questionRow(label: string, row: MeasuredRow): string {
  return tableRow([label, strings.reportNumber(row.effort.prompts), strings.reportNumber(row.questions)]);
}

/** Your interventions: the counts table when scores were read, the not-scored text otherwise. */
function renderInterventions(report: FullReport): string {
  if (report.scores === null) {
    return [strings.reportInterventionsHeading, strings.reportNotScored, strings.reportAccuracyLine].join("\n");
  }
  const joins = joinReport(report);
  const countsCells = (counts: InterventionCounts | null): string[] =>
    counts === null
      ? Array.from({ length: 6 }, () => strings.reportNotScored)
      : [
          strings.reportNumber(counts.approval),
          strings.reportNumber(counts.correction),
          strings.reportNumber(counts.holdBack),
          strings.reportNumber(counts.taskStep),
          strings.reportNumber(counts.chatter),
          strings.reportNumber(counts.correctionsFollowedByEdits),
        ];
  const rows = report.sessions.map((session, position) =>
    tableRow([session.label, ...countsCells(joins[position].interventions)]),
  );
  if (report.sessions.length >= 2)
    rows.push(tableRow([strings.reportTotalRow, ...countsCells(totalInterventions(joins))]));
  // A blank line keeps the accuracy line out of the table's last row.
  return [
    [
      strings.reportInterventionsHeading,
      strings.reportInterventionsColumns,
      separatorRow(strings.reportInterventionsColumns),
      ...rows,
    ].join("\n"),
    strings.reportAccuracyLine,
  ].join("\n\n");
}

/** The counted rules for a set of session ids, with their grades. */
function lessonCounts(
  lessonLines: LessonLine[],
  grades: Map<string, GradeLine>,
  sessionIds: Set<string>,
): LessonCounts {
  const counts: LessonCounts = { rules: 0, graded: 0, good: 0, vague: 0, wrong: 0, userChecked: true };
  for (const line of lessonLines) {
    if (!sessionIds.has(line.sessionId)) continue;
    counts.rules++;
    const grade = grades.get(line.ruleKey);
    if (grade === undefined) continue;
    counts.graded++;
    if (grade.grade === "good") counts.good++;
    if (grade.grade === "vague") counts.vague++;
    if (grade.grade === "wrong") counts.wrong++;
    if (!grade.userChecked) counts.userChecked = false;
  }
  counts.userChecked = counts.graded > 0 && counts.userChecked;
  return counts;
}

/** A rule text as one table cell: whitespace collapsed and the column separator escaped. */
function ruleCell(text: string): string {
  return collapseWhitespace(text).replace(/\|/g, "\\|");
}

/** Lessons: the grade table when rules were counted and graded, the not-scored text otherwise. */
function renderLessons(report: FullReport): string {
  const notScored = [strings.reportLessonsHeading, strings.reportNotScored].join("\n");
  if (report.lessons === null) return notScored;
  const lessonLines = [...report.lessons.values()];
  const grades = report.grades ?? new Map<string, GradeLine>();
  const ids = new Set(report.sessions.map((session) => session.id));
  const counts = lessonCounts(lessonLines, grades, ids);
  if (counts.rules === 0 || counts.graded === 0) return notScored;
  const rows = ["good", "vague", "wrong"].map((grade) => {
    const graded = lessonLines.filter((line) => ids.has(line.sessionId) && grades.get(line.ruleKey)?.grade === grade);
    const example = graded.length === 0 ? strings.reportNoExample : ruleCell(graded[0].rule);
    return tableRow([grade, strings.reportNumber(graded.length), example]);
  });
  return [
    [
      strings.reportLessonsHeading,
      strings.reportLessonsColumns,
      separatorRow(strings.reportLessonsColumns),
      ...rows,
    ].join("\n"),
    strings.reportLessonsLine(counts.graded, counts.rules, counts.userChecked),
  ].join("\n\n");
}

/** The report.md body: the approved title and header, the seven sections, the footer. */
export function renderMarkdown(report: FullReport): string {
  const totalLabel = strings.reportTotalRow;
  const withTotal = report.sessions.length >= 2;

  const effortRows = report.sessions.map((session) => effortRow(session.label, session));
  if (withTotal) effortRows.push(effortRow(totalLabel, report.total));
  const effortSection = [
    strings.reportEffortHeading,
    strings.reportEffortColumns,
    separatorRow(strings.reportEffortColumns),
    ...effortRows,
  ].join("\n");

  const tokenRows = report.sessions.map((session) => tokensRow(session.label, session));
  if (withTotal) tokenRows.push(tokensRow(totalLabel, report.total));
  const tokensSection = [
    strings.reportTokensHeading,
    strings.reportTokensColumns,
    separatorRow(strings.reportTokensColumns),
    ...tokenRows,
  ].join("\n");

  const checkRows: string[] = [];
  for (const session of report.sessions) {
    for (const kind of CHECK_KINDS) {
      const counts = session.checks[kind];
      if (counts.runs === 0) continue;
      checkRows.push(
        tableRow([
          strings.reportCheckRowLabel(session.label, kind),
          `${counts.runs}`,
          `${counts.failed}`,
          `${counts.fixed}`,
          `${counts.expected}`,
        ]),
      );
    }
  }
  if (withTotal) checkRows.push(tableRow([totalLabel, ...checkCells(report.total)]));
  const checksSection = [
    strings.reportChecksHeading,
    strings.reportChecksColumns,
    separatorRow(strings.reportChecksColumns),
    ...checkRows,
  ].join("\n");

  const questionRows = report.sessions.map((session) => questionRow(session.label, session));
  if (withTotal) questionRows.push(questionRow(totalLabel, report.total));
  const questionsSection = [
    strings.reportQuestionsHeading,
    strings.reportQuestionsColumns,
    separatorRow(strings.reportQuestionsColumns),
    ...questionRows,
  ].join("\n");

  const interventionsSection = renderInterventions(report);
  const lessonsSection = renderLessons(report);
  const behaviorSection = [
    strings.reportBehaviorHeading,
    report.format === "pi" ? strings.reportNotScored : strings.reportNotApplicable,
  ].join("\n");

  return `${[
    `${strings.reportTitle(report.inputPath)}\n${strings.reportHeader(
      report.sessions.length,
      report.total.effort.prompts,
      formatLabel(report.format),
      report.generatedDate,
    )}`,
    effortSection,
    tokensSection,
    checksSection,
    questionsSection,
    interventionsSection,
    lessonsSection,
    behaviorSection,
    strings.reportFooter,
  ].join("\n\n")}\n`;
}

/** Each session's lessons counts in report order, or nulls without --lessons. */
function sessionLessonCounts(report: FullReport): Array<LessonCounts | null> {
  if (report.lessons === null) return report.sessions.map(() => null);
  const lines = [...report.lessons.values()];
  const grades = report.grades ?? new Map<string, GradeLine>();
  return report.sessions.map((session) => lessonCounts(lines, grades, new Set([session.id])));
}

/** The total object's lessons counts, or null without --lessons. */
function totalLessonCounts(report: FullReport): LessonCounts | null {
  if (report.lessons === null) return null;
  const lines = [...report.lessons.values()];
  const grades = report.grades ?? new Map<string, GradeLine>();
  return lessonCounts(lines, grades, new Set(report.sessions.map((session) => session.id)));
}

/** The report.jsonl body: one object per segment, per session, and one total. */
export function renderJsonl(report: FullReport): string {
  const lines: string[] = [];
  const joins = joinReport(report);
  const lessonCountsBySession = sessionLessonCounts(report);
  report.sessions.forEach((session, position) => {
    const codes = joins[position].codes;
    for (const segment of session.segments) {
      lines.push(
        JSON.stringify({
          level: "segment",
          session: session.label,
          index: segment.index,
          promptHead: segment.promptHead,
          effort: segment.effort,
          tokens: segment.tokens,
          costUsd: segment.costUsd,
          checks: segment.checks,
          questions: segment.questions,
          codes: codes.get(segment.index) ?? null,
        }),
      );
    }
    lines.push(
      JSON.stringify({
        level: "session",
        session: session.label,
        file: session.file,
        format: session.format,
        skippedLines: session.skippedLines,
        effort: session.effort,
        tokens: session.tokens,
        costUsd: session.costUsd,
        checks: session.checks,
        questions: session.questions,
        interventions: joins[position].interventions,
        lessons: lessonCountsBySession[position],
      }),
    );
  });
  lines.push(
    JSON.stringify({
      level: "total",
      session: strings.reportTotalRow,
      skippedFiles: report.skippedFiles,
      effort: report.total.effort,
      tokens: report.total.tokens,
      costUsd: report.total.costUsd,
      checks: report.total.checks,
      questions: report.total.questions,
      interventions: totalInterventions(joins),
      lessons: totalLessonCounts(report),
    }),
  );
  return `${lines.join("\n")}\n`;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function shownOutput(outputArg: string): string {
  const trimmed = outputArg.replace(/[\\/]+$/, "");
  return trimmed === "" ? outputArg : trimmed;
}

async function firstRecord(file: string): Promise<Record<string, unknown> | null> {
  const stream = fs.createReadStream(file, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = asRecord(parsed);
      if (record !== null) return record;
    }
    return null;
  } finally {
    rl.close();
    stream.destroy();
  }
}

const EXIT_REFUSED = 2;

function refuse(message: string): number {
  process.stderr.write(`${message}\n`);
  return EXIT_REFUSED;
}

interface Candidate {
  file: string;
  format: LogFormat;
}

/** Read one session log or a folder of them read-only and write the report files. */
export async function main(argv: string[]): Promise<number> {
  const args = parseArgv(argv);
  const sessionArg = typeof args.session === "string" ? args.session : null;
  const dirArg = typeof args.dir === "string" ? args.dir : null;
  const outputArg = typeof args.output === "string" ? args.output : null;
  const lessonsArg = typeof args.lessons === "string" ? args.lessons : null;
  const gradesArg = typeof args.grades === "string" ? args.grades : null;
  if (gradesArg !== null && lessonsArg === null) return refuse(strings.labelsMissingFlag("report", "--lessons"));
  if (outputArg === null || (sessionArg === null) === (dirArg === null)) return refuse(strings.reportUsage);
  const codesArg = typeof args.codes === "string" ? args.codes : null;
  const scores = codesArg === null ? null : parseScores(codesArg);
  if (scores === null && codesArg !== null) return refuse(strings.reportBadCodes(codesArg));
  let lessons: Map<string, LessonLine> | null = null;
  let grades: Map<string, GradeLine> | null = null;
  if (lessonsArg !== null) {
    lessons = parseLessons(lessonsArg);
    if (lessons === null) return refuse(strings.reportBadLessons(lessonsArg));
    if (gradesArg !== null) {
      grades = parseGrades(gradesArg, lessons);
      if (grades === null) return refuse(strings.reportBadGrades(gradesArg, lessonsArg));
    }
  }

  const inputPath = sessionArg !== null ? sessionArg : String(dirArg);
  const inputDir = sessionArg !== null ? path.dirname(path.resolve(sessionArg)) : path.resolve(String(dirArg));
  const candidates: Candidate[] = [];
  let skippedFiles = 0;

  if (sessionArg !== null) {
    const format =
      fs.existsSync(sessionArg) && fs.statSync(sessionArg).isFile()
        ? detectFormat(await firstRecord(sessionArg))
        : null;
    if (format === null) return refuse(strings.reportNotALog(sessionArg));
    candidates.push({ file: sessionArg, format });
  } else {
    const dir = String(dirArg);
    const names = fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? fs.readdirSync(dir).sort() : [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      if (!fs.statSync(file).isFile()) continue;
      const format = detectFormat(await firstRecord(file));
      if (format === null) {
        skippedFiles++;
        continue;
      }
      candidates.push({ file, format });
    }
    if (candidates.length === 0) return refuse(strings.reportNoLogs(dir));
    const formats = new Set(candidates.map((candidate) => candidate.format));
    if (formats.size > 1) return refuse(strings.reportMixedLogs(dir));
  }

  const outputResolved = path.resolve(outputArg);
  const home = os.homedir();
  const forbidden = [inputDir, path.join(home, ".pi"), path.join(home, ".claude")];
  if (forbidden.some((parent) => isInside(outputResolved, parent))) return refuse(strings.reportOutputRefused);

  const inputs: SessionInput[] = [];
  for (const candidate of candidates) inputs.push(await readSegments(candidate.file, candidate.format));
  inputs.sort((a, b) => a.startMs - b.startMs || a.file.localeCompare(b.file));
  const sessions = inputs.map((input) => measureSession(input));
  const total = measureTotal(sessions, skippedFiles);
  const exchanges = dedupeExchanges(inputs.map((input) => buildExchanges(input)));
  const report: FullReport = {
    inputPath,
    format: candidates[0].format,
    generatedDate: localDateOf(new Date()),
    skippedFiles,
    sessions,
    total,
    exchanges,
    scores,
    lessons,
    grades,
  };

  fs.mkdirSync(outputResolved, { recursive: true });
  fs.writeFileSync(path.join(outputResolved, "report.md"), renderMarkdown(report), "utf-8");
  fs.writeFileSync(path.join(outputResolved, "report.jsonl"), renderJsonl(report), "utf-8");
  fs.writeFileSync(path.join(outputResolved, "exchanges.jsonl"), renderExchanges(exchanges), "utf-8");
  process.stdout.write(`${strings.reportDone(sessions.length, total.effort.prompts, shownOutput(outputArg))}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exit(1);
    },
  );
}
