// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { LimitReached } from "./limits.js";
import type { CounterSnapshot, Limits, TraceEntry } from "./types.js";

/** Run-level counters fed by the pipeline instrumentation hooks (src/instrument.ts). */
export interface RunStats {
  triosExamined: number;
  triosProductive: number;
  candidates: number;
  inserted: number;
  merged: number;
  skipped: number;
  evicted: number;
  failures: number;
  cooldownMs: number;
}

export function emptyStats(): RunStats {
  return {
    triosExamined: 0,
    triosProductive: 0,
    candidates: 0,
    inserted: 0,
    merged: 0,
    skipped: 0,
    evicted: 0,
    failures: 0,
    cooldownMs: 0,
  };
}

interface StreamLike {
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
  result(): Promise<unknown>;
}

/**
 * Counts every real model request at the streamFn boundary — including retries and
 * tool-follow-up turns — and enforces the request ceiling, the wall-clock deadline
 * (cooldowns included), and cancellation before each request starts.
 */
export class RequestCounter {
  readonly limits: Limits;
  readonly stats: RunStats = emptyStats();
  traces: TraceEntry[] = [];
  requestCount = 0;
  stopReason: CounterSnapshot["stopReason"] = null;
  private aborted = false;
  private readonly startedAtMs: number;
  private readonly now: () => number;

  constructor(limits: Limits, now?: () => number) {
    this.limits = limits;
    this.now = now ?? Date.now;
    this.startedAtMs = this.now();
  }

  elapsedMs(): number {
    return this.now() - this.startedAtMs;
  }

  /** Cooperative cancellation for the pipeline loop's shouldCancel. */
  abort(): void {
    this.aborted = true;
    if (!this.stopReason) this.stopReason = "aborted";
  }

  /** True when the run must not start another request. */
  exhausted(): boolean {
    if (this.stopReason) return true;
    if (this.aborted) return true;
    if (this.requestCount >= this.limits.maxModelRequests) {
      this.stopReason = "requests";
      return true;
    }
    if (this.elapsedMs() >= this.limits.maxRunMs) {
      this.stopReason = "deadline";
      return true;
    }
    return false;
  }

  /** Throws LimitReached instead of issuing a request over a ceiling. */
  guard(): void {
    if (this.aborted) {
      this.stopReason ??= "aborted";
      throw new LimitReached("aborted");
    }
    if (this.requestCount >= this.limits.maxModelRequests) {
      this.stopReason = "requests";
      throw new LimitReached("requests");
    }
    if (this.elapsedMs() >= this.limits.maxRunMs) {
      this.stopReason = "deadline";
      throw new LimitReached("deadline");
    }
  }

  /**
   * Wrap a streamFn so every invocation:
   * passes the guard first (no request is issued over a ceiling),
   * and gets a trace entry with outcome/usage captured from result()/iterator errors.
   */
  wrapStreamFn(streamFn: (model: unknown, context: unknown, options: unknown) => unknown) {
    return async (model: unknown, context: unknown, options: unknown): Promise<StreamLike> => {
      this.guard();
      const m = model as { id?: string; provider?: string };
      const entry: TraceEntry = {
        seq: ++this.requestCount,
        model: m.id ?? "unknown",
        provider: m.provider ?? "unknown",
        startedAtMs: this.now(),
        endedAtMs: this.now(),
        outcome: "ok",
      };
      this.traces.push(entry);

      const stream = (await streamFn(model, context, options)) as StreamLike;
      const finalizeError = (error: unknown): void => {
        entry.endedAtMs = this.now();
        entry.outcome = "error";
        entry.error = error instanceof Error ? error.message : String(error);
        this.stats.failures++;
      };
      const finalizeOk = (message: unknown): void => {
        entry.endedAtMs = this.now();
        const usage = (message as { usage?: { input?: number; output?: number } } | null)?.usage;
        if (usage && (typeof usage.input === "number" || typeof usage.output === "number")) {
          entry.usage = {
            ...(typeof usage.input === "number" ? { input: usage.input } : {}),
            ...(typeof usage.output === "number" ? { output: usage.output } : {}),
          };
        }
      };
      return {
        async *[Symbol.asyncIterator]() {
          try {
            yield* stream;
          } catch (error) {
            finalizeError(error);
            throw error;
          }
        },
        async result(): Promise<unknown> {
          try {
            const message = await stream.result();
            finalizeOk(message);
            return message;
          } catch (error) {
            finalizeError(error);
            throw error;
          }
        },
      };
    };
  }

  snapshot(): CounterSnapshot {
    const usageTotals = { input: 0, output: 0, unknown: 0 };
    for (const trace of this.traces) {
      if (!trace.usage) {
        usageTotals.unknown++;
        continue;
      }
      if (typeof trace.usage.input === "number") usageTotals.input += trace.usage.input;
      if (typeof trace.usage.output === "number") usageTotals.output += trace.usage.output;
    }
    return {
      requestCount: this.requestCount,
      elapsedMs: this.elapsedMs(),
      stopReason: this.stopReason,
      traces: this.traces,
      usageTotals,
    };
  }
}
