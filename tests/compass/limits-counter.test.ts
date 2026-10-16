// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Stage 1, T3.8 (unit level) — limit parsing/refusal, ceiling enforcement, usage
 * capture, and start-of-run confirmation. The real-boundary checks (retries and
 * tool-follow-up counting through the actual agentLoop) live in offline-boundary.
 */

import { describe, expect, it } from "vitest";
import { renderConfirmation, resolveConfirmation } from "../../scripts/compass/confirmation.js";
import { RequestCounter } from "../../scripts/compass/counter.js";
import { LimitError, parseLimits, parsePositiveInt, suggestedLimits } from "../../scripts/compass/limits.js";
import { strings } from "../../scripts/compass/strings.js";
import type { GateRunConfig, Limits } from "../../scripts/compass/types.js";

const SMOKE: Limits = { runType: "smoke", maxModelRequests: 2, maxRunMs: 60_000, source: "compass-table" };
const GATE: GateRunConfig = {
  mode: "off",
  source: "settings",
  policyHash: "ad7880acdc3b",
  model: "jev-1.13.0",
};

describe("parseLimits", () => {
  it("accepts valid switches", () => {
    const limits = parseLimits({
      "run-type": "smoke",
      "max-model-requests": "5",
      "max-run-ms": "900000",
      "limits-source": "compass-table",
    });
    expect(limits).toEqual({ runType: "smoke", maxModelRequests: 5, maxRunMs: 900_000, source: "compass-table" });
  });

  it.each([
    ["run-type"],
    ["max-model-requests"],
    ["max-run-ms"],
    ["limits-source"],
  ])("refuses to start without --%s", (flag) => {
    const args = {
      "run-type": "smoke",
      "max-model-requests": "5",
      "max-run-ms": "900000",
      "limits-source": "compass-table",
    };
    delete args[flag as keyof typeof args];
    expect(() => parseLimits(args)).toThrow(LimitError);
  });

  it.each([
    ["0"],
    ["-1"],
    ["1.5"],
    ["abc"],
    ["NaN"],
    ["Infinity"],
    ["10x"],
    [""],
  ])("refuses non-finite or non-positive values: '%s'", (value) => {
    expect(() => parsePositiveInt(value, "max-model-requests")).toThrow(LimitError);
  });

  it("refuses unknown run types and unknown limit sources", () => {
    expect(() => parseLimits({ ...validArgs(), "run-type": "everything" })).toThrow(LimitError);
    expect(() => parseLimits({ ...validArgs(), "limits-source": "vibes" })).toThrow(LimitError);
  });

  it("stored table suggestions exist for smoke and are UNSET for baseline", () => {
    expect(suggestedLimits("smoke")).toEqual({ maxModelRequests: 5, maxRunMs: 900_000, source: "compass-table" });
    expect(suggestedLimits("baseline")).toBeNull();
  });
});

function validArgs(): Record<string, string> {
  return {
    "run-type": "smoke",
    "max-model-requests": "5",
    "max-run-ms": "900000",
    "limits-source": "compass-table",
  };
}

function simpleStream(result: () => Promise<unknown>) {
  return {
    async *[Symbol.asyncIterator]() {
      // No streamed events.
    },
    result,
  };
}

describe("RequestCounter", () => {
  it("enforces the request ceiling with no automatic restart", async () => {
    const counter = new RequestCounter(SMOKE);
    const wrapped = counter.wrapStreamFn(() => simpleStream(async () => ({ usage: { input: 1, output: 2 } })));
    const model = { id: "spark", provider: "meta" };

    let honored = 0;
    let refusal: { stopReason?: string; errorMessage?: string } | undefined;
    for (let i = 0; i < 5; i++) {
      const message = (await (await wrapped(model, {}, {})).result()) as { stopReason?: string; errorMessage?: string };
      if (message.stopReason === "error") {
        refusal = message;
        break; // pipeline loop stops — no automatic restart
      }
      honored++;
    }
    expect(honored).toBe(2);
    expect(refusal?.errorMessage).toBe(strings.limitReached("requests"));
    expect(counter.exhausted()).toBe(true);
    const snapshot = counter.snapshot();
    expect(snapshot.requestCount).toBe(2);
    expect(snapshot.refusedCount).toBe(1);
    expect(snapshot.stopReason).toBe("requests");
    expect(snapshot.traces).toHaveLength(2);
    expect(snapshot.traces.every((t) => t.outcome === "ok")).toBe(true);
    expect(snapshot.usageTotals).toEqual({ input: 2, output: 4, unknown: 0 });
  });

  it("enforces the wall-clock deadline including idle time", async () => {
    let now = 1_000;
    const counter = new RequestCounter(
      { runType: "smoke", maxModelRequests: 100, maxRunMs: 50, source: "compass-table" },
      () => now,
    );
    const wrapped = counter.wrapStreamFn(() => simpleStream(async () => ({})));
    await (await wrapped({ id: "m", provider: "p" }, {}, {})).result();
    now += 60;
    const refused = await wrapped({ id: "m", provider: "p" }, {}, {});
    const events: unknown[] = [];
    for await (const event of refused) events.push(event);
    expect(events).toMatchObject([{ type: "error", error: { stopReason: "error" } }]);
    expect(await refused.result()).toMatchObject({ errorMessage: strings.limitReached("deadline") });
    expect(counter.snapshot()).toMatchObject({ requestCount: 1, refusedCount: 1, stopReason: "deadline" });
    expect(counter.exhausted()).toBe(true);
  });

  it("refuses without issuing a request once capped, and records aborts", async () => {
    const counter = new RequestCounter(SMOKE);
    let calls = 0;
    const wrapped = counter.wrapStreamFn(() => {
      calls++;
      return simpleStream(async () => ({}));
    });
    counter.abort();
    expect(await (await wrapped({ id: "m", provider: "p" }, {}, {})).result()).toMatchObject({
      stopReason: "error",
      errorMessage: strings.limitReached("aborted"),
    });
    expect(calls).toBe(0);
    expect(counter.snapshot().refusedCount).toBe(1);
    expect(counter.exhausted()).toBe(true);
  });

  it("records failed requests with their error", async () => {
    const counter = new RequestCounter(SMOKE);
    const wrapped = counter.wrapStreamFn(() =>
      simpleStream(async () => {
        throw new Error("boom");
      }),
    );
    await expect((await wrapped({ id: "m", provider: "p" }, {}, {})).result()).rejects.toThrow("boom");
    expect(counter.traces[0].outcome).toBe("error");
    expect(counter.traces[0].error).toBe("boom");
    expect(counter.stats.failures).toBe(1);
    expect(counter.snapshot().usageTotals.unknown).toBe(1);
  });

  it("records a provider error that resolves as an error message", async () => {
    const counter = new RequestCounter(SMOKE);
    const wrapped = counter.wrapStreamFn(() =>
      simpleStream(async () => ({ stopReason: "error", errorMessage: "upstream 500", usage: { input: 0, output: 0 } })),
    );
    await (await wrapped({ id: "m", provider: "p" }, {}, {})).result();
    expect(counter.traces[0]).toMatchObject({ outcome: "error", error: "upstream 500", stopReason: "error" });
    expect(counter.stats.failures).toBe(1);
  });

  it("guard passes below ceilings", () => {
    const counter = new RequestCounter(SMOKE);
    expect(() => counter.guard()).not.toThrow();
    expect(counter.exhausted()).toBe(false);
  });
});

describe("resolveConfirmation", () => {
  const block = renderConfirmation({
    limits: SMOKE,
    scope: "file",
    selectionLabel: "/tmp/session.jsonl",
    trioCount: 3,
    outputDir: "/tmp/out",
    startPortrait: { source: "live", dir: "/tmp/portrait", digest: "0" },
    model: "meta/test-model",
    thinking: "high",
    gate: GATE,
  });

  it("renders run type, limits, source, model, selection, output dir, and cost notes", () => {
    expect(block).toContain(strings.confirmRunType("smoke"));
    expect(block).toContain(strings.confirmLimits(2, 60_000));
    expect(block).toContain(strings.confirmLimitSource("compass-table"));
    expect(block).toContain(strings.confirmModel("meta/test-model", "high"));
    expect(block).toContain(strings.confirmSelection("/tmp/session.jsonl", 3));
    expect(block).toContain(strings.confirmOutputDir("/tmp/out"));
    expect(block).toContain(strings.costNoteSpend);
  });

  it("proceeds on --confirmed without prompting", async () => {
    const result = await resolveConfirmation(block, { confirmed: true, isTTY: false });
    expect(result).toEqual({ proceed: true, mode: "flag" });
  });

  it("refuses agent launches without --confirmed", async () => {
    const result = await resolveConfirmation(block, { confirmed: false, isTTY: false });
    expect(result.proceed).toBe(false);
    if (!result.proceed) expect(result.mode).toBe("non-tty");
  });

  it("asks on a terminal and honors yes/no", async () => {
    const yes = await resolveConfirmation(block, { confirmed: false, isTTY: true, ask: async () => "y" });
    expect(yes).toEqual({ proceed: true, mode: "prompt" });
    const no = await resolveConfirmation(block, { confirmed: false, isTTY: true, ask: async () => "n" });
    expect(no.proceed).toBe(false);
  });
});

describe("RequestCounter.gateAttempt", () => {
  it("counts one gate request with a gate-tagged trace and no usage", () => {
    const counter = new RequestCounter(SMOKE);

    expect(counter.gateAttempt("jev-1.13.0")).toBe(true);

    expect(counter.requestCount).toBe(1);
    expect(counter.traces).toHaveLength(1);
    expect(counter.traces[0]).toMatchObject({
      model: "jev-1.13.0",
      provider: "typesafe",
      outcome: "ok",
      stage: "gate",
    });
  });

  it("declines at the request ceiling without counting or tracing, and records the refusal", () => {
    const counter = new RequestCounter({ ...SMOKE, maxModelRequests: 1 });
    expect(counter.gateAttempt("jev-1.13.0")).toBe(true);

    expect(counter.gateAttempt("jev-1.13.0")).toBe(false);

    expect(counter.requestCount).toBe(1);
    expect(counter.traces).toHaveLength(1);
    expect(counter.stopReason).toBe("requests");
    expect(counter.refusalTimes).toHaveLength(1);
    expect(counter.snapshot().refusedCount).toBe(1);
  });

  it("keeps gate traces out of the receipt's usage totals", () => {
    const counter = new RequestCounter(SMOKE);
    counter.gateAttempt("jev-1.13.0");

    expect(counter.snapshot().usageTotals).toEqual({ input: 0, output: 0, unknown: 0 });
    expect(counter.snapshot().requestCount).toBe(1);
  });
});

describe("createSinkGuard", () => {
  it("runs callbacks normally and records throwing sinks with their hook name", async () => {
    const { createSinkGuard } = await import("../../scripts/compass/pipeline-boot.js");
    const { sinkErrors, guardSink } = createSinkGuard();
    let ran = 0;
    guardSink("attempt", () => {
      ran++;
    });
    guardSink("build", () => {
      throw new Error("boom");
    });
    guardSink("cooldown", () => {
      throw "plain string failure";
    });
    expect(ran).toBe(1);
    expect(sinkErrors).toEqual([
      { hook: "build", error: "boom" },
      { hook: "cooldown", error: "plain string failure" },
    ]);
  });

  it("returns the fallback from a throwing value hook and records the error", async () => {
    const { createSinkGuard } = await import("../../scripts/compass/pipeline-boot.js");
    const { sinkErrors, guardValue } = createSinkGuard();

    expect(guardValue("gateAttempt", false, () => true)).toBe(true);
    expect(
      guardValue("gateAttempt", false, () => {
        throw new Error("boom");
      }),
    ).toBe(false);

    expect(sinkErrors).toEqual([{ hook: "gateAttempt", error: "boom" }]);
  });
});

describe("failOnSinkErrors", () => {
  it("writes an error receipt with the sink errors and returns exit code 1", async () => {
    const { failOnSinkErrors } = await import("../../scripts/compass/pipeline-boot.js");
    const calls: Array<{ stop: string; error: string | null }> = [];
    const exitCode = failOnSinkErrors(
      (stop, error) => {
        calls.push({ stop, error });
      },
      [
        { hook: "build", error: "boom" },
        { hook: "cooldown", error: "plain string failure" },
      ],
    );
    expect(exitCode).toBe(1);
    expect(calls).toEqual([
      {
        stop: "error",
        error: "instrumentation sink errors: build: boom; cooldown: plain string failure",
      },
    ]);
  });

  it("writes nothing and returns exit code 0 when no sink errors were recorded", async () => {
    const { failOnSinkErrors } = await import("../../scripts/compass/pipeline-boot.js");
    let writes = 0;
    const exitCode = failOnSinkErrors(() => {
      writes++;
    }, []);
    expect(exitCode).toBe(0);
    expect(writes).toBe(0);
  });
});
