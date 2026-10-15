// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Tests for the word-counting helper used by the streamed progress indicator.
 *
 * callPortraitLlm/attemptWithRetries accumulate words from text/thinking/tool-call
 * deltas and fire onProgress (throttled) so the footer can show a live count.
 * The counting logic is the testable core; the streaming loop itself is exercised
 * end-to-end (agentLoop is a real dependency).
 */
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
// agentLoop is the shared test-setup mock (a forwarder to the real loop); each test drives it
// with mockReturnValue so attemptWithRetries runs without a real LLM.
import { agentLoop, setDefaultStreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attemptWithRetries,
  countWords,
  NO_ATTEMPT_START_HOOK,
  NO_STAGE_TAG,
  retryDelayMs,
  setLlmAttemptSink,
} from "../src/llm-call.js";
import type { PortraitState } from "../src/types.js";
import { setupTestSettings, teardownTestSettings } from "./settings-helpers.js";

const mockAgentLoop = agentLoop as unknown as ReturnType<typeof vi.fn>;

describe("countWords", () => {
  it("returns 0 for empty string", () => {
    expect(countWords("")).toBe(0);
  });

  it("returns 0 for whitespace-only string", () => {
    expect(countWords("   \n\t  ")).toBe(0);
  });

  it("counts a single word", () => {
    expect(countWords("hello")).toBe(1);
  });

  it("counts space-separated words", () => {
    expect(countWords("one two three")).toBe(3);
  });

  it("collapses runs of whitespace (spaces, tabs, newlines)", () => {
    expect(countWords("one\ttwo\n\nthree   four")).toBe(4);
  });

  it("trims leading/trailing whitespace before counting", () => {
    expect(countWords("  one two  ")).toBe(2);
  });

  it("counts JSON-like tool-call deltas as words", () => {
    // toolcall_delta carries incremental JSON fragments — counted like any text
    expect(countWords('{"portrait":["rule 1","rule 2"]}')).toBe(3);
  });

  it("counts a single punctuation token as one word", () => {
    expect(countWords("{")).toBe(1);
  });
});

describe("retryDelayMs", () => {
  // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 10s.
  it("returns 1s (1000ms) for the first retry (attempt 0)", () => {
    expect(retryDelayMs(0)).toBe(1_000);
  });

  it("returns 2s (2000ms) for the second retry (attempt 1)", () => {
    expect(retryDelayMs(1)).toBe(2_000);
  });

  it("returns 4s (4000ms) for the third retry (attempt 2)", () => {
    expect(retryDelayMs(2)).toBe(4_000);
  });

  it("returns 8s (8000ms) for the fourth retry (attempt 3)", () => {
    expect(retryDelayMs(3)).toBe(8_000);
  });

  it("caps at 10s (10000ms) for the fifth retry and beyond", () => {
    // 2^4 = 16s, capped to 10s
    expect(retryDelayMs(4)).toBe(10_000);
    // 2^10 = 1024s, capped to 10s
    expect(retryDelayMs(10)).toBe(10_000);
  });
});

/** Build a no-op async iterable that yields nothing (simulates a stream that produces no tool call). */
function emptyStream() {
  return {
    async *[Symbol.asyncIterator]() {
      // yields nothing — resultExtractor() will return undefined → "tool not called"
    },
    async result() {
      /* no-op */
    },
  };
}

const NO_TOOL_CALLED_CONTEXT = "Previous call failed. Please return valid JSON using the tool.";

describe("attemptWithRetries backoff", () => {
  const context: AgentContext = {
    messages: [{ role: "system", content: "s", timestamp: Date.now() }],
    tools: [] as AgentTool[],
  };
  const config = {} as unknown as AgentLoopConfig;
  beforeEach(() => {
    mockAgentLoop.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pauses with exponential backoff between attempts when the tool is not called", async () => {
    // Regression: the "tool not called" path used to have NO backoff, so all retries fired
    // back-to-back and the retry dialog re-showed immediately after "Continue retrying".
    mockAgentLoop.mockReturnValue(emptyStream());

    vi.useFakeTimers();
    const delayResolved: boolean[] = [];
    // Track when each setTimeout-based backoff resolves (retryDelayMs: 1s, 2s for attempts 0,1)
    const realSetTimeout = setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((cb) => {
      delayResolved.push(false);
      const h = realSetTimeout(() => {
        delayResolved[delayResolved.length - 1] = true;
        cb();
      }, 0);
      return h as unknown as ReturnType<typeof setTimeout>;
    });

    // 3 attempts (1 initial + maxRetries=2) → 2 backoff waits (after attempt 0 and 1)
    const promise = attemptWithRetries<string>(
      [],
      context,
      config,
      5_000,
      2,
      () => undefined, // tool never called → always "tool not called"
      NO_TOOL_CALLED_CONTEXT,
      NO_STAGE_TAG,
      1,
      NO_ATTEMPT_START_HOOK,
    );

    await vi.runAllTimersAsync();
    const { lastError } = await promise;

    expect(lastError).toBe("LLM did not call the required extraction tool");
    expect(mockAgentLoop).toHaveBeenCalledTimes(3);
    // Two backoff delays occurred between the three attempts (proves attempts did NOT fire back-to-back)
    expect(delayResolved.length).toBe(2);
    expect(delayResolved).toEqual([true, true]);
  });

  it("pushes an error-context nudge after a tool-not-called failure", async () => {
    mockAgentLoop.mockReturnValue(emptyStream());

    vi.useFakeTimers();
    const messages: AgentMessage[] = [{ role: "user", content: "initial", timestamp: 0 }];

    const promise = attemptWithRetries<string>(
      messages,
      context,
      config,
      5_000,
      1, // 1 initial + 1 retry → 1 nudge after the first
      () => undefined,
      NO_TOOL_CALLED_CONTEXT,
      NO_STAGE_TAG,
      1,
      NO_ATTEMPT_START_HOOK,
    );
    await vi.runAllTimersAsync();
    await promise;

    // A user nudge carrying the errorContext + lastError was appended before the second attempt
    const nudgeTexts = messages
      .filter((m) => m.role === "user")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((c): c is { type: "text"; text: string } => typeof c === "object" && c.type === "text")
      .map((c) => c.text)
      .filter((t) => t.includes(NO_TOOL_CALLED_CONTEXT));
    expect(nudgeTexts.length).toBe(1);
    expect(nudgeTexts[0]).toContain("LLM did not call the required extraction tool");
  });
});

interface CapturedEvent {
  stage: string;
  attempt: number;
  validationRound: number;
  ok: boolean;
}

describe("attempt events carry validationRound", () => {
  const context: AgentContext = {
    messages: [{ role: "system", content: "s", timestamp: Date.now() }],
    tools: [] as AgentTool[],
  };
  const config = {} as unknown as AgentLoopConfig;

  beforeEach(() => {
    mockAgentLoop.mockReset();
  });

  it("emits the validationRound it was given", async () => {
    mockAgentLoop.mockReturnValue(emptyStream());
    const events: CapturedEvent[] = [];
    setLlmAttemptSink((event) => events.push(event));
    try {
      await attemptWithRetries<string>(
        [],
        context,
        config,
        5_000,
        1,
        () => "ok",
        "ctx",
        "building",
        2,
        NO_ATTEMPT_START_HOOK,
      );
    } finally {
      setLlmAttemptSink(null);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: "building", attempt: 1, validationRound: 2, ok: true });
  });
});

describe("callPortraitLlm continue-retrying", () => {
  afterEach(() => {
    teardownTestSettings();
    delete globalThis.__piPortrait;
  });

  it("keeps the same validationRound across the Continue-retrying loop", async () => {
    mockAgentLoop.mockReset();
    // First loop run: no tool call (fails). Second run (after "Continue retrying"): the tool captures.
    let loopRuns = 0;
    mockAgentLoop.mockImplementation((_messages: AgentMessage[], loopContext: AgentContext) => {
      loopRuns++;
      if (loopRuns < 2) return emptyStream();
      return {
        async *[Symbol.asyncIterator]() {
          await loopContext.tools?.[0]?.execute("call-1", {}, undefined, () => {});
        },
        async result() {
          /* no-op */
        },
      };
    });
    setupTestSettings({ retries: 0, model: "test/test-model", timeoutMs: 5_000 });

    const actual = await vi.importActual<typeof import("../src/llm-call.js")>("../src/llm-call.js");
    const fakeModel = { id: "test-model", provider: "test", api: "test" } as unknown as Model<Api>;
    const fakeRegistry = {
      find: () => fakeModel,
      getAvailable: () => [fakeModel],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
    } as unknown as ModelRegistry;
    actual.setCapturedModel(fakeModel, fakeRegistry);

    const events: CapturedEvent[] = [];
    actual.setLlmAttemptSink((event) => events.push(event));
    globalThis.__piPortrait = { uiSelect: async () => "Continue retrying" } as unknown as PortraitState;

    const tool = {
      name: "return_building",
      description: "test tool",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: undefined, terminate: true }),
    } as unknown as AgentTool;

    let result: string | symbol | undefined;
    try {
      result = await actual.callPortraitLlm<string>(
        [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 }],
        "system",
        tool,
        () => "done",
        "error context",
        undefined,
        undefined,
        undefined,
        "building",
        2,
      );
    } finally {
      actual.setLlmAttemptSink(null);
    }

    expect(result).toBe("done");
    expect(events.map((e) => [e.stage, e.attempt, e.validationRound, e.ok])).toEqual([
      ["building", 1, 2, false],
      ["building", 1, 2, true],
    ]);
  });
});

/** One scripted assistant turn for the real agent loop. */
interface ScriptedTurn {
  role: "assistant";
  content: Record<string, unknown>[];
  stopReason: string;
}

const TEXT_TURN: ScriptedTurn = { role: "assistant", content: [{ type: "text", text: "no call" }], stopReason: "stop" };

function returnCall(value: string): Record<string, unknown> {
  return { type: "toolCall", id: `call-${value}`, name: "return_probe", arguments: { value } };
}

function toolTurn(...calls: Record<string, unknown>[]): ScriptedTurn {
  return { role: "assistant", content: calls, stopReason: "toolUse" };
}

function scriptedStream(turn: ScriptedTurn) {
  return {
    async *[Symbol.asyncIterator]() {
      // No streamed events — result() resolves as a completed turn would.
    },
    async result() {
      return turn;
    },
  };
}

/** A return tool shaped like the portrait's: "bad" is a repairable input error, anything else a terminal capture. */
function makeReturnTool(): { tool: AgentTool; state: { captured: string | null } } {
  const state: { captured: string | null } = { captured: null };
  const tool = {
    name: "return_probe",
    label: "Return probe",
    description: "Return a probe value.",
    parameters: Type.Object({ value: Type.String() }),
    execute: async (_toolCallId: string, params: unknown) => {
      const { value } = params as { value: string };
      if (value === "bad")
        return { content: [{ type: "text" as const, text: "repair the value" }], details: undefined };
      state.captured = value;
      return { content: [{ type: "text" as const, text: "stored" }], details: undefined, terminate: true };
    },
  } as unknown as AgentTool;
  return { tool, state };
}

describe("callPortraitLlm termination and capture reset (real agent loop, scripted turns)", () => {
  let actual: typeof import("../src/llm-call.js");
  let script: Array<ScriptedTurn | ((signal: AbortSignal | undefined) => Promise<ScriptedTurn>)>;
  let streamCalls: number;
  let events: CapturedEvent[];

  beforeEach(async () => {
    const loop = globalThis.__portraitAgentLoop;
    if (loop) {
      loop.fn.mockReset();
      loop.fn.mockImplementation(loop.impl);
    }
    actual = await vi.importActual<typeof import("../src/llm-call.js")>("../src/llm-call.js");
    const fakeModel = { id: "test-model", provider: "test", api: "test" } as unknown as Model<Api>;
    const fakeRegistry = {
      find: () => fakeModel,
      getAvailable: () => [fakeModel],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
    } as unknown as ModelRegistry;
    actual.setCapturedModel(fakeModel, fakeRegistry);
    script = [];
    streamCalls = 0;
    events = [];
    actual.setLlmAttemptSink((event) => events.push(event));
    setDefaultStreamFn(((_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => {
      const turn = script[streamCalls] ?? TEXT_TURN;
      streamCalls++;
      if (typeof turn === "function") {
        return { ...scriptedStream(TEXT_TURN), result: () => turn(options.signal) };
      }
      return scriptedStream(turn);
    }) as unknown as Parameters<typeof setDefaultStreamFn>[0]);
  });

  afterEach(() => {
    actual.setLlmAttemptSink(null);
    teardownTestSettings();
    vi.useRealTimers();
  });

  async function call(tool: AgentTool, state: { captured: string | null }) {
    return actual.callPortraitLlm<string>(
      [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 }],
      "system",
      tool,
      () => state.captured ?? undefined,
      "error context",
      undefined,
      undefined,
      undefined,
      "extraction",
      1,
    );
  }

  it("ends the attempt after a successful capture with no follow-up request", async () => {
    setupTestSettings({ retries: 0, model: "test/test-model", timeoutMs: 5_000 });
    const { tool, state } = makeReturnTool();
    script = [toolTurn(returnCall("ok"))];
    expect(await call(tool, state)).toBe("ok");
    expect(streamCalls).toBe(1);
    expect(events.map((e) => e.ok)).toEqual([true]);
  });

  it("keeps a repairable return error nonterminal so the model repairs within the attempt", async () => {
    setupTestSettings({ retries: 0, model: "test/test-model", timeoutMs: 5_000 });
    const { tool, state } = makeReturnTool();
    script = [toolTurn(returnCall("bad")), toolTurn(returnCall("ok"))];
    expect(await call(tool, state)).toBe("ok");
    expect(streamCalls).toBe(2);
    expect(events.map((e) => e.ok)).toEqual([true]);
  });

  it("makes exactly one attempt with retries 0 when the tool is never called", async () => {
    setupTestSettings({ retries: 0, model: "test/test-model", timeoutMs: 5_000 });
    const { tool, state } = makeReturnTool();
    script = [TEXT_TURN];
    expect(await call(tool, state)).toBeUndefined();
    expect(streamCalls).toBe(1);
    expect(events.map((e) => [e.attempt, e.ok])).toEqual([[1, false]]);
  });

  it("runs one initial attempt plus the configured retries", async () => {
    vi.useFakeTimers();
    setupTestSettings({ retries: 2, model: "test/test-model", timeoutMs: 5_000 });
    const { tool, state } = makeReturnTool();
    script = [TEXT_TURN, TEXT_TURN, TEXT_TURN];
    const pending = call(tool, state);
    await vi.runAllTimersAsync();
    expect(await pending).toBeUndefined();
    expect(streamCalls).toBe(3);
    expect(events.map((e) => e.attempt)).toEqual([1, 2, 3]);
  });

  it("never returns a capture left over from an earlier validation round", async () => {
    setupTestSettings({ retries: 0, model: "test/test-model", timeoutMs: 5_000 });
    const { tool, state } = makeReturnTool();
    script = [toolTurn(returnCall("round-1")), TEXT_TURN];
    expect(await call(tool, state)).toBe("round-1");
    // Round 2 reuses the same tool closure; its model turn makes no tool call.
    expect(await call(tool, state)).toBeUndefined();
    expect(events.map((e) => e.ok)).toEqual([true, false]);
  });

  it("does not return an earlier round's capture after an invalid return call", async () => {
    setupTestSettings({ retries: 0, model: "test/test-model", timeoutMs: 5_000 });
    const { tool, state } = makeReturnTool();
    script = [toolTurn(returnCall("round-1")), toolTurn(returnCall("bad")), TEXT_TURN];
    expect(await call(tool, state)).toBe("round-1");
    // Round 2: the only return call is a repairable error and the model then gives up.
    expect(await call(tool, state)).toBeUndefined();
  });

  it("keeps a capture when the attempt times out after it", async () => {
    setupTestSettings({ retries: 0, model: "test/test-model", timeoutMs: 50 });
    const { tool, state } = makeReturnTool();
    // A mixed batch (valid return + unknown tool) does not terminate, so the loop makes a
    // follow-up request; that request outlives the attempt timeout and is aborted.
    script = [
      toolTurn(returnCall("ok"), { type: "toolCall", id: "call-2", name: "other_tool", arguments: {} }),
      (signal) =>
        new Promise<ScriptedTurn>((resolve) => {
          signal?.addEventListener("abort", () => resolve({ role: "assistant", content: [], stopReason: "aborted" }));
        }),
    ];
    expect(await call(tool, state)).toBe("ok");
    expect(streamCalls).toBe(2);
    expect(events.map((e) => e.ok)).toEqual([true]);
  });
});
