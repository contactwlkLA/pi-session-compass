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
 *   cap      — RequestCounter guard across 3 candidate calls with maxModelRequests=1:
 *              exactly 1 request issued, LimitReached(requests), loop stops, no restart.
 *   deadline — maxRunMs exceeded before the second request: LimitReached(deadline).
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
  stoppedEarly?: boolean;
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
  const events: unknown[] = [];
  setLlmAttemptSink((event) => events.push(event));
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
  setDefaultStreamFn((() => {
    const turn = script[streamCalls] ?? TEXT_MESSAGE;
    streamCalls++;
    return makeStream(turn);
  }) as never);

  const out = await attemptWithRetries<unknown>(
    [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 }],
    context as never,
    config as never,
    30_000,
    3,
    () => captured ?? undefined,
    "offline check",
    "offline-check",
  );
  setLlmAttemptSink(null);
  return {
    scenario: "retry",
    streamCalls,
    attempts: events,
    failuresRecorded: 0,
    result: out.result,
    lastError: out.lastError,
  };
}

async function scenarioCap(): Promise<CheckResult> {
  const { RequestCounter } = await import("./counter.js");
  const counter = new RequestCounter({
    runType: "smoke",
    maxModelRequests: 1,
    maxRunMs: 60_000,
    source: "compass-table",
  });
  const wrapped = counter.wrapStreamFn(() => makeStream(TEXT_MESSAGE));
  let honored = 0;
  let stopKind: string | undefined;
  for (let i = 0; i < 3; i++) {
    try {
      const stream = (await wrapped({ id: "spark", provider: "meta" }, {}, {})) as {
        result: () => Promise<unknown>;
      };
      await stream.result();
      honored++;
    } catch (error) {
      stopKind = (error as { kind?: string }).kind ?? "unknown";
      break; // pipeline loop breaks — no automatic restart
    }
  }
  return {
    scenario: "cap",
    streamCalls: counter.requestCount,
    attempts: [],
    failuresRecorded: 0,
    result: honored,
    stopKind,
    stoppedEarly: honored === 1,
  };
}

async function scenarioDeadline(): Promise<CheckResult> {
  const { RequestCounter } = await import("./counter.js");
  const counter = new RequestCounter({
    runType: "smoke",
    maxModelRequests: 100,
    maxRunMs: 40,
    source: "compass-table",
  });
  const wrapped = counter.wrapStreamFn(() => makeStream(TEXT_MESSAGE));
  let honored = 0;
  let stopKind: string | undefined;
  try {
    const stream = (await wrapped({ id: "spark", provider: "meta" }, {}, {})) as {
      result: () => Promise<unknown>;
    };
    await stream.result();
    honored++;
  } catch (error) {
    stopKind = (error as { kind?: string }).kind ?? "unknown";
  }
  await new Promise((resolve) => setTimeout(resolve, 60));
  try {
    await wrapped({ id: "spark", provider: "meta" }, {}, {});
    honored++;
  } catch (error) {
    stopKind = (error as { kind?: string }).kind ?? "unknown";
  }
  return {
    scenario: "deadline",
    streamCalls: counter.requestCount,
    attempts: [],
    failuresRecorded: 0,
    result: honored,
    stopKind,
    stoppedEarly: honored === 1,
  };
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
