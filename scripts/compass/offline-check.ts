// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Offline boundary verification (T3.8): drives the REAL agentLoop from
 * pi-agent-core with a scripted mock streamFn through the instrumented
 * attemptWithRetries, and reports JSON to stdout.
 *
 * Runs in its own node process (compiled harness), so vitest module mocks
 * never interfere. No network, no credentials, no real model.
 *
 * Scenarios:
 *   followup — one attempt: tool-call turn + text follow-up turn = 2 counted requests.
 *   retry    — first attempt returns no tool call (failure), second attempt succeeds
 *              after the backoff; requests = 1 + 2 = 3, attempts = 2.
 *   cap      — real agentLoop, maxModelRequests=1: the first attempt's request is issued,
 *              the retry is refused at the ceiling (no request), the process ends normally.
 *   deadline — real agentLoop, maxRunMs exceeded during the first request: the retry is
 *              refused at the deadline.
 *
 * Usage: node offline-check.js --scenario <name>
 */

import { Type } from "typebox";

interface ScriptedMessage {
  role: string;
  content: Record<string, unknown>[];
  stopReason: string;
  usage?: { input?: number; output?: number };
}

function makeStream(message: ScriptedMessage): {
  [Symbol.asyncIterator](): AsyncIterator<never>;
  result: () => Promise<ScriptedMessage>;
} {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<never> {
      // No streamed events — result() resolves immediately, as a completed turn would.
    },
    async result(): Promise<ScriptedMessage> {
      return message;
    },
  };
}

const TOOL_MESSAGE: ScriptedMessage = {
  role: "assistant",
  content: [{ type: "toolCall", id: "c1", name: "probe_tool", arguments: { probe: "x" } }],
  stopReason: "toolUse",
  usage: { input: 7, output: 3 },
};

const TEXT_MESSAGE: ScriptedMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  stopReason: "end",
  usage: { input: 9, output: 2 },
};

const NO_TOOL_MESSAGE: ScriptedMessage = {
  role: "assistant",
  content: [{ type: "text", text: "no call" }],
  stopReason: "end",
  usage: { input: 5, output: 1 },
};

interface CheckResult {
  scenario: string;
  streamCalls: number;
  attempts: unknown[];
  failuresRecorded: number;
  result?: unknown;
  lastError?: string;
  stopKind?: string;
  /** Boundary calls refused at a ceiling (ceiling scenarios). */
  refused?: number;
  requestCount?: number;
  /** Per-turn boundary usages (input/output) in call order — present for usage scenarios. */
  boundaryUsages?: Array<{ input?: number; output?: number }>;
}

async function scenarioFollowup(): Promise<CheckResult> {
  const { attemptWithRetries, setLlmAttemptSink } = await import("../../src/llm-call.js");
  const { RequestCounter } = await import("./counter.js");
  const events: unknown[] = [];
  setLlmAttemptSink((event) => events.push(event));
  const counter = new RequestCounter({
    runType: "smoke",
    maxModelRequests: 100,
    maxRunMs: 600_000,
    source: "compass-table",
  });
  let streamCalls = 0;
  const script = [TOOL_MESSAGE, TEXT_MESSAGE];
  const probe = {
    name: "probe_tool",
    description: "probe",
    parameters: Type.Object({ probe: Type.String() }),
    execute: (_id: string, params: unknown) => {
      captured = params;
      return Promise.resolve({ content: [{ type: "text", text: "stored" }] });
    },
  };
  let captured: unknown;
  const context = { messages: [{ role: "system", content: "sys", timestamp: 0 }], tools: [probe] };
  const config = {
    model: { id: "spark", provider: "meta", api: "x" },
    convertToLlm: (messages: unknown) => messages,
    toolExecution: "sequential",
    reasoning: "low",
  };
  const { setDefaultStreamFn } = await import("@earendil-works/pi-agent-core");
  const countedStreamFn = counter.wrapStreamFn(() => {
    const turn = script[streamCalls] ?? TEXT_MESSAGE;
    streamCalls++;
    return makeStream(turn);
  });
  setDefaultStreamFn(countedStreamFn as never);

  const out = await attemptWithRetries<unknown>(
    [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 }],
    context as never,
    config as never,
    30_000,
    2,
    () => captured ?? undefined,
    "offline check",
    "offline-check",
    1,
  );
  setLlmAttemptSink(null);
  return {
    scenario: "followup",
    streamCalls,
    attempts: events,
    failuresRecorded: 0,
    result: out.result,
    lastError: out.lastError,
    boundaryUsages: counter.traces.map((trace) => trace.usage ?? {}),
  };
}

async function scenarioRetry(): Promise<CheckResult> {
  const { attemptWithRetries, setLlmAttemptSink } = await import("../../src/llm-call.js");
  const { RequestCounter } = await import("./counter.js");
  const events: unknown[] = [];
  setLlmAttemptSink((event) => events.push(event));
  const counter = new RequestCounter({
    runType: "smoke",
    maxModelRequests: 100,
    maxRunMs: 600_000,
    source: "compass-table",
  });
  let streamCalls = 0;
  const script = [NO_TOOL_MESSAGE, TOOL_MESSAGE, TEXT_MESSAGE];
  const probe = {
    name: "probe_tool",
    description: "probe",
    parameters: Type.Object({ probe: Type.String() }),
    execute: (_id: string, params: unknown) => {
      captured = params;
      return Promise.resolve({ content: [{ type: "text", text: "stored" }] });
    },
  };
  let captured: unknown;
  const context = { messages: [{ role: "system", content: "sys", timestamp: 0 }], tools: [probe] };
  const config = {
    model: { id: "spark", provider: "meta", api: "x" },
    convertToLlm: (messages: unknown) => messages,
    toolExecution: "sequential",
    reasoning: "low",
  };
  const { setDefaultStreamFn } = await import("@earendil-works/pi-agent-core");
  const countedStreamFn = counter.wrapStreamFn(() => {
    const turn = script[streamCalls] ?? TEXT_MESSAGE;
    streamCalls++;
    return makeStream(turn);
  });
  setDefaultStreamFn(countedStreamFn as never);

  const out = await attemptWithRetries<unknown>(
    [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 }],
    context as never,
    config as never,
    30_000,
    3,
    () => captured ?? undefined,
    "offline check",
    "offline-check",
    1,
  );
  setLlmAttemptSink(null);
  return {
    scenario: "retry",
    streamCalls,
    attempts: events,
    failuresRecorded: 0,
    result: out.result,
    lastError: out.lastError,
    boundaryUsages: counter.traces.map((trace) => trace.usage ?? {}),
  };
}

/**
 * Drive the real agentLoop through attemptWithRetries until a ceiling refuses a request.
 * The scripted turn never calls the tool, so every attempt fails and the retry reaches the
 * ceiling; the process must finish normally (no unhandled rejection) with the refusal counted.
 */
async function scenarioCeiling(
  scenario: "cap" | "deadline",
  limits: { maxModelRequests: number; maxRunMs: number },
  delayMs: number,
): Promise<CheckResult> {
  const { attemptWithRetries, setLlmAttemptSink } = await import("../../src/llm-call.js");
  const { RequestCounter } = await import("./counter.js");
  const events: unknown[] = [];
  setLlmAttemptSink((event) => events.push(event));
  const counter = new RequestCounter({ runType: "smoke", ...limits, source: "compass-table" });
  let streamCalls = 0;
  const context = { messages: [{ role: "system", content: "sys", timestamp: 0 }], tools: [] };
  const config = {
    model: { id: "spark", provider: "meta", api: "x" },
    convertToLlm: (messages: unknown) => messages,
    toolExecution: "sequential",
    reasoning: "low",
  };
  const { setDefaultStreamFn } = await import("@earendil-works/pi-agent-core");
  setDefaultStreamFn(
    counter.wrapStreamFn(async () => {
      streamCalls++;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return makeStream(NO_TOOL_MESSAGE);
    }) as never,
  );

  const out = await attemptWithRetries<unknown>(
    [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 }],
    context as never,
    config as never,
    30_000,
    2,
    () => undefined,
    "offline check",
    "offline-check",
    1,
  );
  setLlmAttemptSink(null);
  const snapshot = counter.snapshot();
  return {
    scenario,
    streamCalls,
    attempts: events,
    failuresRecorded: 0,
    result: out.result,
    lastError: out.lastError,
    stopKind: snapshot.stopReason ?? undefined,
    refused: snapshot.refusedCount,
    requestCount: snapshot.requestCount,
  };
}

async function scenarioCap(): Promise<CheckResult> {
  return scenarioCeiling("cap", { maxModelRequests: 1, maxRunMs: 60_000 }, 0);
}

async function scenarioDeadline(): Promise<CheckResult> {
  return scenarioCeiling("deadline", { maxModelRequests: 100, maxRunMs: 40 }, 60);
}

export async function main(argv: string[]): Promise<number> {
  const flag = argv.indexOf("--scenario");
  const scenario = flag >= 0 ? argv[flag + 1] : undefined;
  let result: CheckResult;
  if (scenario === "followup") result = await scenarioFollowup();
  else if (scenario === "retry") result = await scenarioRetry();
  else if (scenario === "cap") result = await scenarioCap();
  else if (scenario === "deadline") result = await scenarioDeadline();
  else {
    process.stderr.write("offline-check: expected --scenario <followup|retry|cap|deadline>\n");
    return 2;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (process.argv[1]) {
  try {
    const { pathToFileURL } = await import("node:url");
    if (import.meta.url === pathToFileURL(process.argv[1]).href) {
      main(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (error) => {
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
          process.exit(1);
        },
      );
    }
  } catch {
    // imported as a module — do nothing
  }
}
