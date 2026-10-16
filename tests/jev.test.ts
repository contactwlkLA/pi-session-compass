// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The Jev gate's transport: the exact request on the wire, the deadline and
 * single-retry control flow, response validation, and the routing rule.
 * fetch, the clock, and the sleep are injected, so no test here reaches the
 * network; the abort path runs on fake timers.
 */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GATE_CONFIG } from "../src/gate-config.js";
import {
  buildGateState,
  callJev,
  type GateState,
  JEV_POLICY,
  JEV_POLICY_HASH,
  type JevPolicy,
  type JevResult,
  type JevTransport,
  type QuestionId,
  routeGate,
} from "../src/jev.js";

const Q_PREFIX = "In this exchange between a user and an AI coding agent, ";

/** The four approved questions, exactly as they go on the wire. */
const APPROVED_QUESTIONS = {
  correction: {
    type: "noul",
    instructions: `${Q_PREFIX}does the user's reply correct or push back on something the agent said or did?`,
    criteria: {
      true: "The user says the agent got something wrong (code, a claim, an assumption), missed something, or did something the user did not want.",
      false: "The user accepts the work, moves on, or asks something new without saying the agent got anything wrong.",
    },
  },
  preference: {
    type: "noul",
    instructions: `${Q_PREFIX}does the user's reply say how they want the agent to work or communicate with them?`,
    criteria: {
      true: "The user states a preference that could apply again later: how long or detailed answers should be, when to ask before acting, how much to change at once, which tools or style to use.",
      false: "The user only says what to do in this task (what to build, fix, or explain).",
    },
  },
  steering: {
    type: "noul",
    instructions: `${Q_PREFIX}does the user's reply change how the agent is going about the task?`,
    criteria: {
      true: "The user asks for a different method, a different order of steps, planning first, a narrower or wider scope, or a rethought decision.",
      false: "The user lets the agent carry on, or only adds task details.",
    },
  },
  confusion: {
    type: "noul",
    instructions: `${Q_PREFIX}does the user's reply show they had trouble following the agent?`,
    criteria: {
      true: "The user says they are lost or confused, cannot tell what changed or what to do next, or asks for a summary, clarification, or a slower pace.",
      false: "The user follows what the agent did and said without trouble.",
    },
  },
} as const;

const TEST_KEY = "gate-credential-placeholder-0000";
const TRIO: GateState = {
  agentBefore: "agent proposed a fix",
  userFeedback: "do it the other way round",
  agentAfter: "agent redid the fix",
};

const ANSWERS = {
  correction: { type: "noul", noul: 0.05 },
  preference: { type: "noul", noul: 0.02 },
  steering: { type: "noul", noul: 0.01 },
  confusion: { type: "noul", noul: 0 },
};

interface FakeClock {
  now: () => number;
  sleeps: number[];
  sleep: (ms: number) => Promise<void>;
}

/** A clock starting at 0; its sleep advances it the way waiting would. */
function startClock(): FakeClock {
  const held = { at: 0 };
  const sleeps: number[] = [];
  return {
    now: () => held.at,
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      held.at += ms;
    },
  };
}

function transportOf(fetchImpl: unknown, clock: FakeClock): JevTransport {
  return { fetch: fetchImpl as typeof fetch, now: clock.now, sleep: clock.sleep };
}

/** A body that is valid only when the answers below validate. */
function bodyWith(model: unknown, answers: unknown): string {
  return JSON.stringify({ model, answers, usage: { input_tokens: 12, output_tokens: 3 } });
}

function okResponse(answers: Record<string, unknown>): Response {
  return new Response(bodyWith("jev-1.13.0", answers), { status: 200 });
}

function statusResponse(status: number, headers: Record<string, string>): Response {
  return new Response("", { status, headers });
}

/** One request that never settles until its caller aborts it. */
function hangUntilAborted(init: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init.signal as AbortSignal;
    signal.addEventListener("abort", () => reject(new Error("request aborted")));
  });
}

/** A fetch that never settles until the caller aborts it. */
function hangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((_input: unknown, init: RequestInit) => hangUntilAborted(init));
}

const ALLOW = (): boolean => true;
const DECLINE = (): boolean => false;
const NEVER_SLEEP = async (): Promise<void> => undefined;

describe("policy", () => {
  it("pins the model and freezes the policy it hashes", () => {
    expect(JEV_POLICY.model).toBe("jev-1.13.0");
    expect(JEV_POLICY.threshold).toBe(0.1);
    expect(JEV_POLICY.stateCapBytes).toBe(32 * 1024);
    expect(JEV_POLICY.deadlineMs).toBe(5000);
    expect(JEV_POLICY.endpoint).toBe("https://api.typesafe.ai/v1/systemone");
    expect(Object.isFrozen(JEV_POLICY)).toBe(true);
    expect(Object.isFrozen(JEV_POLICY.questions.correction)).toBe(true);
    expect(Object.isFrozen(JEV_POLICY.questions.correction.criteria)).toBe(true);
    expect(() => {
      JEV_POLICY.threshold = 0.5;
    }).toThrow();
    expect(JEV_POLICY.threshold).toBe(0.1);
  });

  it("holds the approved questions byte-exact", () => {
    expect(JSON.stringify(JEV_POLICY.questions)).toBe(JSON.stringify(APPROVED_QUESTIONS));
    expect(JEV_POLICY.questions.correction.instructions.startsWith(Q_PREFIX)).toBe(true);
  });

  it("takes every policy value from the frozen gate config", () => {
    expect(GATE_CONFIG.defaultMode).toBe("off");
    expect(GATE_CONFIG.modes).toEqual(["off", "shadow", "enforce"]);
    expect(GATE_CONFIG.failureLimit).toBe(3);
    expect(JSON.stringify(GATE_CONFIG.questions)).toBe(JSON.stringify(APPROVED_QUESTIONS));
    expect(Object.isFrozen(GATE_CONFIG)).toBe(true);
    expect(Object.isFrozen(GATE_CONFIG.modes)).toBe(true);
    expect(Object.isFrozen(GATE_CONFIG.questions.correction.criteria)).toBe(true);
    expect(() => {
      GATE_CONFIG.threshold = 0.5;
    }).toThrow();
    expect(GATE_CONFIG.threshold).toBe(0.1);

    expect(JEV_POLICY.model).toBe(GATE_CONFIG.model);
    expect(JEV_POLICY.threshold).toBe(GATE_CONFIG.threshold);
    expect(JEV_POLICY.stateCapBytes).toBe(GATE_CONFIG.stateCapBytes);
    expect(JEV_POLICY.deadlineMs).toBe(GATE_CONFIG.deadlineMs);
    expect(JEV_POLICY.defaultRetryWaitMs).toBe(GATE_CONFIG.defaultRetryWaitMs);
    expect(JEV_POLICY.endpoint).toBe(GATE_CONFIG.endpoint);
    expect(JEV_POLICY.questions).toBe(GATE_CONFIG.questions);
  });

  it("keeps the shipped policy hash", () => {
    expect(JEV_POLICY_HASH).toBe("ad7880acdc3b");
  });

  it("hashes the model, threshold, state cap, and questions over 12 hex digits", () => {
    const expected = createHash("sha256")
      .update(
        JSON.stringify({
          model: "jev-1.13.0",
          threshold: 0.1,
          stateCapBytes: 32768,
          questions: APPROVED_QUESTIONS,
        }),
      )
      .digest("hex")
      .slice(0, 12);
    expect(JEV_POLICY_HASH).toBe(expected);
    expect(JEV_POLICY_HASH).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("buildGateState", () => {
  it("keeps the trio texts unchanged", () => {
    const built = buildGateState(TRIO, JEV_POLICY);
    expect(built).toEqual({ kind: "ok", state: TRIO });
  });

  it("sizes a state over the cap instead of sending it", () => {
    const capped: JevPolicy = { ...JEV_POLICY, stateCapBytes: 16 };
    const built = buildGateState(TRIO, capped);
    expect(built.kind).toBe("oversized");
    expect(built.kind === "oversized" && built.bytes).toBeGreaterThan(16);
  });

  it("sizes a 40 KiB trio over the shipped cap", () => {
    const bulky = { ...TRIO, agentBefore: "x".repeat(40 * 1024) };
    const built = buildGateState(bulky, JEV_POLICY);
    expect(built.kind).toBe("oversized");
  });
});

describe("request", () => {
  it("posts the exact body, endpoint, and headers", async () => {
    const clock = startClock();
    let rawBody = "";
    let rawUrl = "";
    const rawInits: RequestInit[] = [];
    const fetchMock = vi.fn((input: unknown, init: RequestInit) => {
      rawUrl = String(input);
      rawBody = String(init.body);
      rawInits.push(init);
      return Promise.resolve(okResponse(ANSWERS));
    });

    const result = await callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(fetchMock, clock), ALLOW);

    expect(result.kind).toBe("scored");
    expect(rawUrl).toBe("https://api.typesafe.ai/v1/systemone");
    expect(rawInits).toHaveLength(1);
    expect(rawInits[0]).toMatchObject({
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_KEY}`, "Content-Type": "application/json" },
    });
    expect(rawBody).toBe(JSON.stringify({ model: "jev-1.13.0", state: TRIO, questions: APPROVED_QUESTIONS }));
  });

  it("keeps the credential out of every result", async () => {
    const clock = startClock();
    const fetchMock = vi.fn(() => Promise.resolve(statusResponse(500, {})));
    const failed = await callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(fetchMock, clock), ALLOW);
    expect(failed.kind).toBe("fallback");
    expect(JSON.stringify(failed)).not.toContain(TEST_KEY);

    const scoredFetch = vi.fn(() => Promise.resolve(okResponse(ANSWERS)));
    const scored = await callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(scoredFetch, clock), ALLOW);
    expect(scored.kind).toBe("scored");
    expect(JSON.stringify(scored)).not.toContain(TEST_KEY);
  });
});

describe("scored responses", () => {
  it("returns the answers, the model the response named, and its usage", async () => {
    const clock = startClock();
    const fetchMock = vi.fn(() => Promise.resolve(okResponse(ANSWERS)));

    const result = await callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(fetchMock, clock), ALLOW);

    expect(result).toEqual({
      kind: "scored",
      answers: { correction: 0.05, preference: 0.02, steering: 0.01, confusion: 0 },
      model: "jev-1.13.0",
      usage: { inputTokens: 12, outputTokens: 3 },
      attempts: 1,
      latencyMs: 0,
    });
  });

  it("ignores extra answers and reports usage as null unless both fields are numbers", async () => {
    const clock = startClock();
    const extraAnswers = { ...ANSWERS, bonus: { type: "noul", noul: 0.9 } };
    const fetchMock = vi.fn(() => Promise.resolve(okResponse(extraAnswers)));
    const withExtra = await callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(fetchMock, clock), ALLOW);
    expect(withExtra.kind === "scored" && Object.keys(withExtra.answers)).toEqual([
      "correction",
      "preference",
      "steering",
      "confusion",
    ]);

    const partialUsage = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ model: "jev-1.13.0", answers: ANSWERS, usage: { input_tokens: 7 } }), {
          status: 200,
        }),
      ),
    );
    const partial = await callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(partialUsage, clock), ALLOW);
    expect(partial.kind === "scored" && partial.usage).toBeNull();
  });
});

describe("invalid 200 bodies", () => {
  const INVALID: [string, string][] = [
    ["a body that is not JSON", "not json at all"],
    ["a missing model", bodyWith(undefined, ANSWERS)],
    ["a model that is not a string", bodyWith(7, ANSWERS)],
    ["answers that are not a map", JSON.stringify({ model: "jev-1.13.0", answers: "all low" })],
    ["a missing question", bodyWith("jev-1.13.0", { ...ANSWERS, confusion: undefined })],
    ["a question of another type", bodyWith("jev-1.13.0", { ...ANSWERS, steering: { type: "bool", noul: 0 } })],
    ["a string probability", bodyWith("jev-1.13.0", { ...ANSWERS, correction: { type: "noul", noul: "0.05" } })],
    ["a probability above 1", bodyWith("jev-1.13.0", { ...ANSWERS, steering: { type: "noul", noul: 1.2 } })],
    ["a negative probability", bodyWith("jev-1.13.0", { ...ANSWERS, preference: { type: "noul", noul: -0.5 } })],
    [
      "a probability that is not finite",
      '{"model":"jev-1.13.0","answers":{"correction":{"type":"noul","noul":1e999},"preference":{"type":"noul","noul":0},"steering":{"type":"noul","noul":0},"confusion":{"type":"noul","noul":0}}}',
    ],
    [
      "a probability that is NaN",
      '{"model":"jev-1.13.0","answers":{"correction":{"type":"noul","noul":NaN},"preference":{"type":"noul","noul":0},"steering":{"type":"noul","noul":0},"confusion":{"type":"noul","noul":0}}}',
    ],
  ];

  it.each(INVALID)("falls back on %s with one attempt", async (_case, bodyText) => {
    const clock = startClock();
    const fetchMock = vi.fn(() => Promise.resolve(new Response(bodyText, { status: 200 })));

    const result = await callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(fetchMock, clock), ALLOW);

    expect(result).toMatchObject({ kind: "fallback", reason: "invalid_response", attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });
});

describe("http statuses", () => {
  it.each([400, 401, 413, 415, 422])("falls back on %i without a retry", async (status) => {
    const clock = startClock();
    const fetchMock = vi.fn(() => Promise.resolve(statusResponse(status, {})));

    const result = await callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(fetchMock, clock), ALLOW);

    expect(result).toMatchObject({ kind: "fallback", reason: `http_${status}`, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("falls back on 500 without a retry", async () => {
    const clock = startClock();
    const fetchMock = vi.fn(() => Promise.resolve(statusResponse(500, {})));

    const result = await callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(fetchMock, clock), ALLOW);

    expect(result).toMatchObject({ kind: "fallback", reason: "http_500", attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("retries", () => {
  it("retries a 429 after the default wait and scores the second attempt", async () => {
    const clock = startClock();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(429, {}))
      .mockImplementation(() => Promise.resolve(okResponse(ANSWERS)));

    const result = await callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(fetchMock, clock), ALLOW);

    expect(result).toMatchObject({ kind: "scored", attempts: 2, latencyMs: 500 });
    expect(clock.sleeps).toEqual([500]);
  });

  it("waits out a Retry-After of whole seconds", async () => {
    const clock = startClock();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(429, { "Retry-After": "3" }))
      .mockImplementation(() => Promise.resolve(okResponse(ANSWERS)));

    const result = await callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(fetchMock, clock), ALLOW);

    expect(result).toMatchObject({ kind: "scored", attempts: 2 });
    expect(clock.sleeps).toEqual([3000]);
  });

  it("retries at once when Retry-After is 0", async () => {
    const clock = startClock();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(429, { "Retry-After": "0" }))
      .mockImplementation(() => Promise.resolve(okResponse(ANSWERS)));

    const result = await callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(fetchMock, clock), ALLOW);

    expect(result).toMatchObject({ kind: "scored", attempts: 2 });
    expect(clock.sleeps).toEqual([0]);
  });

  it("uses the default wait when Retry-After is an HTTP date", async () => {
    const clock = startClock();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(429, { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }))
      .mockImplementation(() => Promise.resolve(okResponse(ANSWERS)));

    const result = await callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(fetchMock, clock), ALLOW);

    expect(result).toMatchObject({ kind: "scored", attempts: 2 });
    expect(clock.sleeps).toEqual([500]);
  });

  it("does not retry a 429 whose wait runs past the deadline", async () => {
    const clock = startClock();
    const fetchMock = vi.fn(() => Promise.resolve(statusResponse(429, { "Retry-After": "10" })));

    const result = await callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(fetchMock, clock), ALLOW);

    expect(result).toMatchObject({ kind: "fallback", reason: "http_429", attempts: 1 });
    expect(clock.sleeps).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 529 once and gives up with the status on the second", async () => {
    const clock = startClock();
    const fetchMock = vi.fn(() => Promise.resolve(statusResponse(529, { "Retry-After": "1" })));

    const result = await callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(fetchMock, clock), ALLOW);

    expect(result).toMatchObject({ kind: "fallback", reason: "http_529", attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(clock.sleeps).toEqual([1000]);
  });

  it("retries a network error once, then scores", async () => {
    const clock = startClock();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockImplementation(() => Promise.resolve(okResponse(ANSWERS)));

    const result = await callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(fetchMock, clock), ALLOW);

    expect(result).toMatchObject({ kind: "scored", attempts: 2 });
    expect(clock.sleeps).toEqual([500]);
  });

  it("falls back on network after the one retry", async () => {
    const clock = startClock();
    const fetchMock = vi.fn(() => Promise.reject(new Error("connection reset")));

    const result = await callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(fetchMock, clock), ALLOW);

    expect(result).toMatchObject({ kind: "fallback", reason: "network", attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(clock.sleeps).toEqual([500]);
  });
});

describe("deadline", () => {
  it("reports a timeout with no request once the deadline has passed", async () => {
    const now = vi.fn().mockReturnValueOnce(1000).mockReturnValue(7000);
    const fetchMock = vi.fn();

    const result = await callJev(
      TRIO,
      TEST_KEY,
      JEV_POLICY,
      { fetch: fetchMock as unknown as typeof fetch, now, sleep: NEVER_SLEEP },
      ALLOW,
    );

    expect(result).toMatchObject({ kind: "fallback", reason: "timeout", attempts: 0, latencyMs: 6000 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts a request still running when the deadline passes", async () => {
    vi.useFakeTimers();
    const clock = startClock();
    const fetchMock = hangingFetch();

    const pending = callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(fetchMock, clock), ALLOW);
    await vi.advanceTimersByTimeAsync(5000);

    const result = await pending;
    expect(result).toMatchObject({ kind: "fallback", reason: "timeout", attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("covers the retry wait inside the same deadline", async () => {
    vi.useFakeTimers();
    const clock = startClock();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(429, { "Retry-After": "4" }))
      .mockImplementation((_input: unknown, init: RequestInit) => hangUntilAborted(init));

    const pending = callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(fetchMock, clock), ALLOW);
    await vi.advanceTimersByTimeAsync(0); // first attempt, then its wait
    await vi.advanceTimersByTimeAsync(1000); // the retry runs out its share of the deadline

    const result = await pending;
    expect(result).toMatchObject({ kind: "fallback", reason: "timeout", attempts: 2 });
    expect(clock.sleeps).toEqual([4000]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("budget", () => {
  it("declines the first attempt without a request", async () => {
    const clock = startClock();
    const fetchMock = vi.fn();

    const result = await callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(fetchMock, clock), DECLINE);

    expect(result).toMatchObject({ kind: "fallback", reason: "over_budget", attempts: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("declines the retry after one attempt already sent", async () => {
    const clock = startClock();
    const fetchMock = vi.fn(() => Promise.resolve(statusResponse(429, {})));
    let allowed = true;
    const budget = (): boolean => {
      const answer = allowed;
      allowed = false;
      return answer;
    };

    const result = await callJev(TRIO, TEST_KEY, JEV_POLICY, transportOf(fetchMock, clock), budget);

    expect(result).toMatchObject({ kind: "fallback", reason: "over_budget", attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([500]);
  });
});

describe("routeGate", () => {
  const scored = (answers: Record<QuestionId, number>): JevResult => ({
    kind: "scored",
    answers,
    model: "jev-1.13.0",
    usage: null,
    attempts: 1,
    latencyMs: 1,
  });

  it("calls every answer at or below the threshold no_lesson", () => {
    const atThreshold = scored({ correction: 0.1, preference: 0.1, steering: 0.1, confusion: 0.1 });
    expect(routeGate(atThreshold, JEV_POLICY)).toBe("no_lesson");
    const under = scored({ correction: 0.05, preference: 0, steering: 0.09, confusion: 0.01 });
    expect(routeGate(under, JEV_POLICY)).toBe("no_lesson");
  });

  it("calls one answer above the threshold maybe_lesson", () => {
    const over = scored({ correction: 0.1000001, preference: 0, steering: 0, confusion: 0 });
    expect(routeGate(over, JEV_POLICY)).toBe("maybe_lesson");
  });

  it("routes a fallback to extraction", () => {
    const fallback: JevResult = { kind: "fallback", reason: "http_500", attempts: 1, latencyMs: 1 };
    expect(routeGate(fallback, JEV_POLICY)).toBe("maybe_lesson");
  });
});
