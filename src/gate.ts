// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The Jev gate in front of extraction: the mode, the run-scoped state (one
 * missing-key report, a failure limit that stops the gate for the rest of the
 * run), the call into the transport, and the result event the harness records.
 *
 * Every non-off check produces one event, skip included, and every path that
 * does not reach the API reports only a reason code — never the credential or
 * a payload.
 */

import { reportError } from "./error.js";
import { GATE_CONFIG } from "./gate-config.js";
import { emitGateAttempt, emitGateResult } from "./instrument.js";
import {
  buildGateState,
  callJev,
  JEV_POLICY,
  JEV_POLICY_HASH,
  type JevFallback,
  type JevTransport,
  routeGate,
} from "./jev.js";
import type { InteractionSequence } from "./types.js";

/** How the scan treats a gate result: off = no request, shadow = record only, enforce = skip rejects. */
export type GateMode = "off" | "shadow" | "enforce";

/** One gate result as the harness records it. */
export interface GateResultEvent {
  sourcePath: string;
  mode: GateMode;
  policyHash: string;
  decision: "no_lesson" | "maybe_lesson" | "fallback";
  routed: "extract" | "skip";
  answers: Record<string, number> | null;
  fallbackReason: string | null;
  model: string | null;
  attempts: number;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
}

/** What the scan does with the trio, plus the event to record (null in off mode). */
export interface GateCheck {
  decision: "extract" | "skip";
  event: GateResultEvent | null;
}

const GATE_ERROR_SOURCE = "gate error";
const KEY_MISSING_MESSAGE =
  "Jev gate skipped for this run: TYPESAFE_API_KEY is not set. Every trio goes to extraction.";
const FAILURE_LIMIT_MESSAGE =
  "Jev gate failed 3 times in a row and is off for the rest of this run. Every trio goes to extraction.";
/** Consecutive request failures after which the gate stays off for the run. */
const FAILURE_LIMIT: number = GATE_CONFIG.failureLimit;
const NO_ATTEMPTS = 0;
const NO_LATENCY_MS = 0;

let keyReported = false;
let consecutiveFailures = 0;
let checkStoppedForRun = false;

/** Start-of-run reset: the missing-key report, the failure count, and the stop all clear. */
export function resetGateRun(): void {
  keyReported = false;
  consecutiveFailures = 0;
  checkStoppedForRun = false;
}

/**
 * Only a fallback that follows a real request attempt counts toward the run's
 * failure limit; the reasons that never reach the API (`key_missing`,
 * `oversized_state`, `over_budget`, `check_stopped`) and a decline by the
 * budget hook before the first POST never count either.
 */
function countsTowardFailureLimit(result: JevFallback): boolean {
  if (result.attempts === 0) return false;
  return (
    result.reason === "timeout" ||
    result.reason === "network" ||
    result.reason === "invalid_response" ||
    result.reason.startsWith("http_")
  );
}

/** The process-wide transport: real fetch, wall clock, timer sleeps. */
function realTransport(): JevTransport {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * Gate one trio in the given mode. Off returns before anything is read; every
 * other mode returns one event — scored, or a fallback with its reason — and
 * only an enforce-mode `no_lesson` skips extraction.
 */
export async function checkTrio(trio: InteractionSequence, mode: GateMode, sourcePath: string): Promise<GateCheck> {
  if (mode === "off") return { decision: "extract", event: null };

  const base = { sourcePath, mode, policyHash: JEV_POLICY_HASH };
  const fallback = (reason: string, attempts: number, latencyMs: number): GateCheck => ({
    decision: "extract",
    event: {
      ...base,
      decision: "fallback",
      routed: "extract",
      answers: null,
      fallbackReason: reason,
      model: null,
      attempts,
      latencyMs,
      usage: null,
    },
  });
  const emit = (check: GateCheck): GateCheck => {
    if (check.event !== null) emitGateResult(check.event);
    return check;
  };

  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    if (!keyReported) {
      keyReported = true;
      reportError(KEY_MISSING_MESSAGE, GATE_ERROR_SOURCE);
    }
    return emit(fallback("key_missing", NO_ATTEMPTS, NO_LATENCY_MS));
  }
  if (checkStoppedForRun) return emit(fallback("check_stopped", NO_ATTEMPTS, NO_LATENCY_MS));

  const gateState = buildGateState(trio, JEV_POLICY);
  if (gateState.kind === "oversized") return emit(fallback("oversized_state", NO_ATTEMPTS, NO_LATENCY_MS));

  const result = await callJev(gateState.state, apiKey, JEV_POLICY, realTransport(), emitGateAttempt);
  if (result.kind === "scored") {
    consecutiveFailures = 0;
  } else if (countsTowardFailureLimit(result)) {
    consecutiveFailures++;
    if (consecutiveFailures >= FAILURE_LIMIT) {
      checkStoppedForRun = true;
      reportError(FAILURE_LIMIT_MESSAGE, GATE_ERROR_SOURCE);
    }
  }

  const decision = result.kind === "scored" ? routeGate(result, JEV_POLICY) : "fallback";
  const routed: "extract" | "skip" = mode === "enforce" && decision === "no_lesson" ? "skip" : "extract";
  return emit({
    decision: routed,
    event: {
      ...base,
      decision,
      routed,
      answers: result.kind === "scored" ? result.answers : null,
      fallbackReason: result.kind === "fallback" ? result.reason : null,
      model: result.kind === "scored" ? result.model : null,
      attempts: result.attempts,
      latencyMs: result.latencyMs,
      usage: result.kind === "scored" ? result.usage : null,
    },
  });
}
