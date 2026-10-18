// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Harness string and confirmation-block text: the minutes conversion, limit
 * source labels, model/thinking resolution, capped warning, thinking cost note,
 * the terminal-only own-limits hint, switch/source errors, run-outcome wording,
 * selection prefixes, and prepare-summary text.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ConfirmationInput,
  confirmationModel,
  renderConfirmation,
  resolveConfirmation,
} from "../../scripts/compass/confirmation.js";
import { parseLimits } from "../../scripts/compass/limits.js";
import { freezeSelection, parseScope } from "../../scripts/compass/selection.js";
import { strings } from "../../scripts/compass/strings.js";
import type { Limits, StartPortrait } from "../../scripts/compass/types.js";

const LIMITS: Limits = { runType: "smoke", maxModelRequests: 2, maxRunMs: 60_000, source: "compass-table" };
const START: StartPortrait = { source: "snapshot", dir: "/tmp/snap", digest: "d" };
const HASH = "ad7880acdc3b";

function render(overrides: Partial<ConfirmationInput>): string {
  return renderConfirmation({
    limits: LIMITS,
    scope: "file",
    selectionLabel: "/tmp/session.jsonl",
    trioCount: 26,
    outputDir: "/tmp/out",
    startPortrait: START,
    model: "meta/test-model",
    thinking: "high",
    gate: { mode: "off", source: "settings", policyHash: HASH },
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("A1 confirmLimits", () => {
  it("converts ms to minutes without a trailing .0", () => {
    expect(strings.confirmLimits(5, 900_000)).toBe("Limits: 5 model requests · 900000 ms (15 min) wall clock");
    expect(strings.confirmLimits(5, 90_000)).toBe("Limits: 5 model requests · 90000 ms (1.5 min) wall clock");
    expect(strings.confirmLimits(5, 5_400_000)).toBe("Limits: 5 model requests · 5400000 ms (90 min) wall clock");
  });

  it("rounds minutes to one decimal", () => {
    expect(strings.confirmLimits(100, 100_000)).toBe("Limits: 100 model requests · 100000 ms (1.7 min) wall clock");
  });
});

describe("A2 confirmSuggested removed", () => {
  it("no longer exists", () => {
    expect("confirmSuggested" in strings).toBe(false);
  });
});

describe("A3 confirmLimitSource", () => {
  it("labels each limits source", () => {
    expect(strings.confirmLimitSource("compass-table")).toBe("Limit source: compass.md table");
    expect(strings.confirmLimitSource("agent-suggestion")).toBe("Limit source: agent suggestion");
    expect(strings.confirmLimitSource("user-override")).toBe("Limit source: user override");
  });
});

describe("A4 confirmModel / confirmationModel", () => {
  it("renders the model and thinking", () => {
    expect(strings.confirmModel("meta/x", "high")).toBe("Model: meta/x · thinking: high");
  });

  it("prefers portraitSettings.model", () => {
    expect(
      confirmationModel({
        portraitSettings: { model: "meta/m1", thinkingLevel: "high" },
        hostPiSettings: { defaultProvider: "meta", defaultModel: "host" },
      }),
    ).toEqual({ model: "meta/m1", thinking: "high" });
  });

  it("falls back to the host default when portrait model is null", () => {
    expect(
      confirmationModel({
        portraitSettings: { model: null, thinkingLevel: "high" },
        hostPiSettings: { defaultProvider: "meta", defaultModel: "muse" },
      }),
    ).toEqual({ model: "meta/muse", thinking: "high" });
  });

  it("shows unknown when either value is missing", () => {
    expect(confirmationModel({})).toEqual({ model: "unknown", thinking: "unknown" });
    expect(confirmationModel({ portraitSettings: { model: "meta/m1" } })).toEqual({
      model: "meta/m1",
      thinking: "unknown",
    });
  });
});

describe("A5 confirmCapped", () => {
  it("shows when the request limit is below a known trio count", () => {
    expect(render({ limits: { ...LIMITS, maxModelRequests: 5 }, trioCount: 26 })).toContain(
      strings.confirmCapped(5, 26),
    );
  });

  it("does not show when the limit covers the trios", () => {
    expect(render({ limits: { ...LIMITS, maxModelRequests: 30 }, trioCount: 26 })).not.toContain(
      strings.confirmCapped(30, 26),
    );
  });

  it("does not show when no trio count is known", () => {
    const block = render({ trioCount: null });
    expect(block.includes("Capped:")).toBe(false);
  });
});

describe("A6 costNoteThinking", () => {
  it("uses the settings thinking value", () => {
    expect(strings.costNoteThinking("high")).toContain("high");
    expect(render({ thinking: "low" })).toContain(strings.costNoteThinking("low"));
    expect(render({ thinking: "low" })).not.toContain(strings.costNoteThinking("high"));
  });
});

describe("A7 askOwnLimits", () => {
  it("prints on a terminal, immediately before the prompt", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const asked: string[] = [];
    const result = await resolveConfirmation("BLOCK", {
      confirmed: false,
      isTTY: true,
      ask: async (question) => {
        asked.push(question);
        return "y";
      },
    });
    expect(result).toEqual({ proceed: true, mode: "prompt" });
    const written = stdout.mock.calls.map((call) => String(call[0]));
    expect(written[0]).toContain("BLOCK");
    expect(written[1]).toContain(strings.askOwnLimits);
    expect(asked).toEqual([strings.askProceed]);
  });

  it("does not print on a non-terminal", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const result = await resolveConfirmation("BLOCK", { confirmed: false, isTTY: false });
    expect(result.proceed).toBe(false);
    expect(stdout.mock.calls.map((call) => String(call[0])).join("")).not.toContain(strings.askOwnLimits);
  });

  it("does not print with --confirmed", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await resolveConfirmation("BLOCK", { confirmed: true, isTTY: true });
    expect(stdout.mock.calls.map((call) => String(call[0])).join("")).not.toContain(strings.askOwnLimits);
  });
});

describe("A8/A9 switches and source", () => {
  it("A8 missingSwitch names every required switch", () => {
    expect(strings.missingSwitch("run-type")).toContain(
      "pass --run-type, --max-model-requests, --max-run-ms, and --limits-source.",
    );
  });

  it("A9 invalidLimitSource text and caller", () => {
    expect(strings.invalidLimitSource("vibes")).toBe(
      "compass harness: invalid value for --limits-source ('vibes') — expected compass-table, agent-suggestion, or user-override.",
    );
    expect(() =>
      parseLimits({
        "run-type": "smoke",
        "max-model-requests": "5",
        "max-run-ms": "900000",
        "limits-source": "vibes",
      }),
    ).toThrow(strings.invalidLimitSource("vibes"));
  });
});

describe("A10 stopCompleted", () => {
  it("uses the singular for one sequence and plural otherwise", () => {
    expect(strings.stopCompleted(1)).toBe("completed — the selected scope was covered (1 sequence processed)");
    expect(strings.stopCompleted(3)).toBe("completed — the selected scope was covered (3 sequences processed)");
  });
});

describe("A11 selection error prefixes", () => {
  it("carries the harness prefix", () => {
    expect(strings.selectionNotFound("/x")).toBe("compass harness: selection target not found: /x");
    expect(strings.selectionNotAFile("/x")).toBe("compass harness: selection target is not a file: /x");
    expect(strings.selectionNotJsonl("/x")).toBe("compass harness: selection target must be a .jsonl session file: /x");
    expect(strings.selectionEmpty("/x")).toBe("compass harness: selection target is empty: /x");
  });
});

describe("A12 scope and frozen-copy errors", () => {
  it("has the approved text", () => {
    expect(strings.unknownScope("bogus")).toBe("compass harness: unknown scope 'bogus' — valid scopes: all, file");
    expect(strings.scopeFileNeedsSession).toBe("compass harness: scope=file requires --session <path>");
    expect(strings.frozenCopyMismatch("/f")).toBe("compass harness: frozen copy hash mismatch for /f");
  });

  it("is thrown by the callers", () => {
    expect(() => parseScope("bogus")).toThrow(strings.unknownScope("bogus"));
    expect(() => freezeSelection({ scope: "file", runId: "t", outputDir: "/tmp/out" })).toThrow(
      strings.scopeFileNeedsSession,
    );
  });
});

describe("A13 prepare all-files summary", () => {
  it("uses the plain all-session-files line", () => {
    expect(strings.prepareSelectionAll).toBe("selection: all session files");
  });
});

describe("A14 stopPipelineFailed", () => {
  it("renders the pipeline failure line for each stop stage", () => {
    expect(strings.stopPipelineFailed("extraction")).toBe(
      "stopped: extraction failed; pending work was kept (see diagnostics.log)",
    );
    expect(strings.stopPipelineFailed("review")).toBe(
      "stopped: review failed; pending work was kept (see diagnostics.log)",
    );
    expect(strings.stopPipelineFailed("build")).toBe(
      "stopped: build failed; pending work was kept (see diagnostics.log)",
    );
  });
});

describe("H strings (gate)", () => {
  it("H1 shows the mode, the policy hash, and the extra request, right after the model line", () => {
    const block = render({ gate: { mode: "shadow", source: "flag", policyHash: HASH } });
    const expected =
      "Jev gate: shadow (policy ad7880acdc3b) — each eligible trio also makes one Jev request (two with a retry).";
    expect(block).toContain(expected);
    const lines = block.split("\n");
    const modelIndex = lines.findIndex((line) => line.startsWith("Model: "));
    expect(modelIndex).toBeGreaterThan(0);
    expect(lines[modelIndex + 1]).toBe(expected);
    expect(strings.confirmGate("enforce", HASH)).toBe(
      "Jev gate: enforce (policy ad7880acdc3b) — each eligible trio also makes one Jev request (two with a retry).",
    );
  });

  it("H2 shows the plain off line and never the policy line", () => {
    const block = render({ gate: { mode: "off", source: "settings", policyHash: HASH } });
    expect(block).toContain("Jev gate: off");
    expect(block).not.toContain("Jev gate: shadow");
    expect(block).not.toContain("policy ");
    expect(strings.confirmGateOff).toBe("Jev gate: off");
  });

  it("H3 refuses an unknown gate mode in the approved text", () => {
    expect(strings.invalidGateMode).toBe("--gate-mode must be off, shadow, or enforce");
  });

  it("H4 renders the decision with four two-decimal scores or the fallback reason", () => {
    expect(strings.sheetGate("no_lesson") + strings.sheetGateScores(0.01, 0.02, 0, 0.05)).toBe(
      "Gate: no_lesson — correction 0.01, preference 0.02, steering 0.00, confusion 0.05",
    );
    expect(strings.sheetGate("maybe_lesson") + strings.sheetGateScores(0.9, 1, 0.555, 0)).toBe(
      "Gate: maybe_lesson — correction 0.90, preference 1.00, steering 0.56, confusion 0.00",
    );
    expect(strings.sheetGate("fallback") + strings.sheetGateFallback("http_500")).toBe(
      "Gate: fallback — fallback: http_500",
    );
  });

  it("H5 states that no extraction ran for a rejected trio", () => {
    expect(strings.sheetGateSkipped).toBe("Extractor: not run (gate: no_lesson, enforce mode)");
  });

  it("H6 documents --gate-mode on the execute line", () => {
    expect(strings.usageExecute).toBe(
      "  execute  --session <jsonl> --run-type <t> --max-model-requests N --max-run-ms N --limits-source <s> " +
        "[--confirmed] [--start-snapshot <dir>] [--gate-mode off|shadow|enforce]",
    );
  });
});
