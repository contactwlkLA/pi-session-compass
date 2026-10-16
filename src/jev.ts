// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The Jev gate's transport: the policy it applies (built from the gate config),
 * the gate state and its size cap, the HTTP call with a total deadline and at
 * most one retry, and the routing rule over scored answers.
 *
 * Nothing else in the package is imported except the gate config and types,
 * and every runtime dependency of the call (fetch, clock, sleep, budget check)
 * is injected, so tests drive each path with a mocked fetch and clock and no
 * network. Results and errors carry only the reason code and HTTP status: the
 * credential and the request and response payloads stay out of them by design.
 */

import { createHash } from "node:crypto";
import { GATE_CONFIG } from "./gate-config.js";
import type { InteractionSequence } from "./types.js";

/** The four question ids. They key the responses; the model never sees them. */
export type QuestionId = "correction" | "preference" | "steering" | "confusion";

/** One Noul question as it goes on the wire. */
export interface JevQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

/** The gate's fixed policy. Everything the policy hash covers lives here. */
export interface JevPolicy {
  model: string;
  threshold: number;
  stateCapBytes: number;
  deadlineMs: number;
  defaultRetryWaitMs: number;
  endpoint: string;
  questions: Record<QuestionId, JevQuestion>;
}

/** The trio texts sent as the gate's state, unchanged. */
export interface GateState {
  agentBefore: string;
  userFeedback: string;
  agentAfter: string;
}

/** The result of sizing the state: either usable, or over the policy's cap. */
export type GateStateResult = { kind: "ok"; state: GateState } | { kind: "oversized"; bytes: number };

/** Injected dependencies of one gate call: no module-level clock or network. */
export interface JevTransport {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** A parsed, validated 200 response. */
export interface JevScored {
  kind: "scored";
  answers: Record<QuestionId, number>;
  model: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  attempts: number;
  latencyMs: number;
}

/** A trio that falls back to extraction, with only a reason code and timings. */
export interface JevFallback {
  kind: "fallback";
  reason: string;
  attempts: number;
  latencyMs: number;
}

export type JevResult = JevScored | JevFallback;

/**
 * The frozen policy of the shipped gate, built from the gate config. The
 * nested values (questions included) are already frozen with the config they
 * came from, so only the policy object itself needs freezing here.
 */
export const JEV_POLICY: JevPolicy = {
  model: GATE_CONFIG.model,
  threshold: GATE_CONFIG.threshold,
  stateCapBytes: GATE_CONFIG.stateCapBytes,
  deadlineMs: GATE_CONFIG.deadlineMs,
  defaultRetryWaitMs: GATE_CONFIG.defaultRetryWaitMs,
  endpoint: GATE_CONFIG.endpoint,
  questions: GATE_CONFIG.questions,
};

Object.freeze(JEV_POLICY);

/** First 12 hex digits of sha256 over the hashed policy fields; recorded with every gate result. */
export const JEV_POLICY_HASH = createHash("sha256")
  .update(
    JSON.stringify({
      model: JEV_POLICY.model,
      threshold: JEV_POLICY.threshold,
      stateCapBytes: JEV_POLICY.stateCapBytes,
      questions: JEV_POLICY.questions,
    }),
  )
  .digest("hex")
  .slice(0, 12);

/** The trio's texts as the gate state, or their size when they exceed the cap. */
export function buildGateState(trio: InteractionSequence, policy: JevPolicy): GateStateResult {
  const state: GateState = {
    agentBefore: trio.agentBefore,
    userFeedback: trio.userFeedback,
    agentAfter: trio.agentAfter,
  };
  const bytes = Buffer.byteLength(JSON.stringify(state), "utf-8");
  if (bytes > policy.stateCapBytes) return { kind: "oversized", bytes };
  return { kind: "ok", state };
}

/**
 * One request's outcome: scored, a final failure, or a retryable failure with
 * the wait to apply before the next attempt.
 */
type AttemptOutcome =
  | {
      kind: "scored";
      model: string;
      answers: Record<QuestionId, number>;
      usage: { inputTokens: number; outputTokens: number } | null;
    }
  | { kind: "failed"; reason: string }
  | { kind: "transient"; reason: string; waitMs: number };

/**
 * Validate a 200 body: `model` a string, every question id present with
 * `type: "noul"` and a finite `noul` in [0, 1] (extra answers ignored), and
 * `usage` only when both of its fields are numbers. Returns null otherwise.
 */
function parseScoredBody(
  body: unknown,
  policy: JevPolicy,
): {
  model: string;
  answers: Record<QuestionId, number>;
  usage: { inputTokens: number; outputTokens: number } | null;
} | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.model !== "string") return null;
  if (typeof record.answers !== "object" || record.answers === null) return null;
  const rawAnswers = record.answers as Record<string, unknown>;
  const answers = {} as Record<QuestionId, number>;
  for (const id of Object.keys(policy.questions) as QuestionId[]) {
    const entry = rawAnswers[id];
    if (typeof entry !== "object" || entry === null) return null;
    const noul = entry as Record<string, unknown>;
    if (noul.type !== "noul") return null;
    if (typeof noul.noul !== "number" || !Number.isFinite(noul.noul) || noul.noul < 0 || noul.noul > 1) return null;
    answers[id] = noul.noul;
  }
  const usage = record.usage;
  let parsedUsage: { inputTokens: number; outputTokens: number } | null = null;
  if (typeof usage === "object" && usage !== null) {
    const raw = usage as Record<string, unknown>;
    if (typeof raw.input_tokens === "number" && typeof raw.output_tokens === "number") {
      parsedUsage = { inputTokens: raw.input_tokens, outputTokens: raw.output_tokens };
    }
  }
  return { model: record.model, answers, usage: parsedUsage };
}

/** Retry-After as milliseconds: a whole non-negative number of seconds, else the default wait. */
function parseRetryAfter(headerValue: string | null, defaultWaitMs: number): number {
  if (headerValue === null) return defaultWaitMs;
  const trimmed = headerValue.trim();
  if (!/^\d+$/.test(trimmed)) return defaultWaitMs;
  return Number(trimmed) * 1000;
}

/**
 * One POST, cancelled if it is still running when `remainingMs` runs out.
 * A 200 must parse and validate, 429 and 529 are retryable with their
 * Retry-After wait, and every other status is final.
 */
async function postJev(
  state: GateState,
  apiKey: string,
  policy: JevPolicy,
  transport: JevTransport,
  remainingMs: number,
): Promise<AttemptOutcome> {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), remainingMs);
  try {
    let response: Response;
    try {
      response = await transport.fetch(policy.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: policy.model, state, questions: policy.questions }),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) return { kind: "failed", reason: "timeout" };
      return { kind: "transient", reason: "network", waitMs: policy.defaultRetryWaitMs };
    }
    if (response.status === 200) {
      let text: string;
      try {
        text = await response.text();
      } catch {
        if (controller.signal.aborted) return { kind: "failed", reason: "timeout" };
        return { kind: "failed", reason: "invalid_response" };
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return { kind: "failed", reason: "invalid_response" };
      }
      const scored = parseScoredBody(body, policy);
      if (scored === null) return { kind: "failed", reason: "invalid_response" };
      return { kind: "scored", ...scored };
    }
    if (response.status === 429 || response.status === 529) {
      return {
        kind: "transient",
        reason: `http_${response.status}`,
        waitMs: parseRetryAfter(response.headers.get("retry-after"), policy.defaultRetryWaitMs),
      };
    }
    return { kind: "failed", reason: `http_${response.status}` };
  } finally {
    clearTimeout(abortTimer);
  }
}

/**
 * Score one trio's state against the policy's questions.
 *
 * `beforeAttempt` runs before every POST: false means the run is out of
 * budget, and no request is made. A total deadline covers all attempts and
 * waits; at most one retry, only for a network error, 429 or 529, and only
 * when its wait fits the deadline.
 */
export async function callJev(
  state: GateState,
  apiKey: string,
  policy: JevPolicy,
  transport: JevTransport,
  beforeAttempt: () => boolean,
): Promise<JevResult> {
  const start = transport.now();
  let attempts = 0;
  const timings = (): { attempts: number; latencyMs: number } => ({ attempts, latencyMs: transport.now() - start });
  const giveUp = (reason: string): JevFallback => ({ kind: "fallback", reason, ...timings() });

  for (;;) {
    if (!beforeAttempt()) return giveUp("over_budget");
    const remaining = start + policy.deadlineMs - transport.now();
    if (remaining <= 0) return giveUp("timeout");
    attempts++; // a POST is on the wire from here
    const attempt = await postJev(state, apiKey, policy, transport, remaining);
    if (attempt.kind === "scored") {
      return { kind: "scored", answers: attempt.answers, model: attempt.model, usage: attempt.usage, ...timings() };
    }
    if (attempt.kind === "failed") return giveUp(attempt.reason);
    // Retryable: once, and only while the wait still fits the deadline.
    if (attempts >= 2) return giveUp(attempt.reason);
    if (transport.now() + attempt.waitMs >= start + policy.deadlineMs) return giveUp(attempt.reason);
    await transport.sleep(attempt.waitMs);
  }
}

/** `no_lesson` only when a scored result's every answer is at or below the threshold. */
export function routeGate(result: JevResult, policy: JevPolicy): "no_lesson" | "maybe_lesson" {
  if (result.kind === "scored" && Object.values(result.answers).every((value) => value <= policy.threshold)) {
    return "no_lesson";
  }
  return "maybe_lesson";
}
