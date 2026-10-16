// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Stage 1, T3.8 (boundary level) — exercises the REAL agentLoop with a scripted
 * mock streamFn in a child process (immune to vitest module mocks), verifying:
 * - attempts, retries, and tool-follow-up turns each cross the stream boundary
 *   and every crossing is counted, with usage and stage tags captured;
 * - at the request ceiling or deadline the boundary refuses without a request, and
 *   the real agent loop ends normally (no unhandled rejection), with no restart;
 * - refusal happens before any request when confirmation/limits are absent
 *   (covered by resolveConfirmation unit tests; this file covers the boundary).
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const JITI = path.join(ROOT, "node_modules", ".bin", "jiti");
const OFFLINE_CHECK = path.join(ROOT, "scripts", "compass", "offline-check.ts");

function ensureRunnable(): void {
  if (!fs.existsSync(JITI)) throw new Error("jiti runner missing from node_modules/.bin");
  if (!fs.existsSync(OFFLINE_CHECK)) throw new Error("offline-check.ts missing");
}

/** Default exec timeout (ms) for one scripted boundary scenario; pass null for no per-scenario timeout. */
const DEFAULT_SCENARIO_TIMEOUT_MS: number | null = 30_000;

interface CheckOutput {
  scenario: string;
  streamCalls: number;
  attempts: Array<{
    stage: string;
    attempt: number;
    ok: boolean;
    error?: string;
    usage?: { input?: number; output?: number };
  }>;
  result?: unknown;
  lastError?: string;
  stopKind?: string;
  refused?: number;
  requestCount?: number;
  boundaryUsages?: Array<{ input?: number; output?: number }>;
}

interface ExecScenarioOptions {
  scenario: string;
  timeoutMs: number | null;
}

async function execScenario(options: ExecScenarioOptions): Promise<CheckOutput> {
  ensureRunnable();
  const { stdout } = await execFileAsync(JITI, [OFFLINE_CHECK, "--scenario", options.scenario], {
    cwd: ROOT,
    ...(options.timeoutMs === null ? {} : { timeout: options.timeoutMs }),
  });
  return JSON.parse(stdout.trim()) as CheckOutput;
}

async function runScenario(scenario: string): Promise<CheckOutput> {
  return execScenario({ scenario, timeoutMs: DEFAULT_SCENARIO_TIMEOUT_MS });
}

describe("offline boundary checks", () => {
  it("counts a tool-follow-up turn as a second request in one attempt", { timeout: 180_000 }, async () => {
    const out = await execScenario({ scenario: "followup", timeoutMs: 150_000 });
    expect(out.streamCalls).toBe(2);
    expect(out.attempts).toHaveLength(1);
    expect(out.attempts[0]).toMatchObject({ stage: "offline-check", attempt: 1, ok: true });
    expect(out.result).toBeDefined();
    expect(out.lastError).toBeUndefined();
    // Two-turn usage: tool-call turn (7 in / 3 out) + text turn (9 in / 2 out).
    expect(out.boundaryUsages).toEqual([
      { input: 7, output: 3 },
      { input: 9, output: 2 },
    ]);
    expect(out.attempts[0].usage).toEqual({ input: 16, output: 5 });
    const boundarySums = (out.boundaryUsages ?? []).reduce<{ input: number; output: number }>(
      (sums, turn) => ({
        input: sums.input + (turn.input ?? 0),
        output: sums.output + (turn.output ?? 0),
      }),
      { input: 0, output: 0 },
    );
    expect(out.attempts[0].usage).toEqual(boundarySums);
  });

  it("ends the attempt after a terminating tool result with no follow-up request", { timeout: 180_000 }, async () => {
    const out = await execScenario({ scenario: "terminate", timeoutMs: 150_000 });
    expect(out.streamCalls).toBe(1);
    expect(out.attempts).toHaveLength(1);
    expect(out.attempts[0]).toMatchObject({ stage: "offline-check", attempt: 1, ok: true });
    expect(out.result).toBeDefined();
    expect(out.boundaryUsages).toEqual([{ input: 7, output: 3 }]);
  });

  it("counts retry attempts and their tool-follow-up turns", { timeout: 180_000 }, async () => {
    const out = await execScenario({ scenario: "retry", timeoutMs: 150_000 });
    expect(out.streamCalls).toBe(3);
    expect(out.attempts).toHaveLength(2);
    expect(out.attempts[0]).toMatchObject({ attempt: 1, ok: false });
    expect(out.attempts[1]).toMatchObject({ attempt: 2, ok: true });
    expect(out.result).toBeDefined();
    // Attempt 1 is one request (5 in / 1 out). Attempt 2 is two requests
    // (7 in / 3 out + 9 in / 2 out). Per-attempt usage must not leak across attempts.
    expect(out.boundaryUsages).toEqual([
      { input: 5, output: 1 },
      { input: 7, output: 3 },
      { input: 9, output: 2 },
    ]);
    expect(out.attempts[0].usage).toEqual({ input: 5, output: 1 });
    expect(out.attempts[1].usage).toEqual({ input: 16, output: 5 });
    const sumAll = (usages: Array<{ input?: number; output?: number }>): { input: number; output: number } =>
      usages.reduce<{ input: number; output: number }>(
        (sums, turn) => ({
          input: sums.input + (turn.input ?? 0),
          output: sums.output + (turn.output ?? 0),
        }),
        { input: 0, output: 0 },
      );
    const attemptSum = sumAll(out.attempts.map((attempt) => attempt.usage ?? {}));
    expect(attemptSum).toEqual({ input: 21, output: 6 });
    expect(attemptSum).toEqual(sumAll(out.boundaryUsages ?? []));
  });

  it("refuses at the request ceiling inside the real agent loop and ends normally", async () => {
    const out = await runScenario("cap");
    expect(out.stopKind).toBe("requests");
    expect(out.streamCalls).toBe(1);
    expect(out.requestCount).toBe(1);
    expect(out.refused).toBe(1);
    expect(out.attempts.map((a) => a.ok)).toEqual([false, false]);
    expect(out.result).toBeUndefined();
  });

  it("refuses at the run deadline inside the real agent loop and ends normally", async () => {
    const out = await runScenario("deadline");
    expect(out.stopKind).toBe("deadline");
    expect(out.streamCalls).toBe(1);
    expect(out.refused).toBe(1);
    expect(out.result).toBeUndefined();
  });

  it("run artifacts carry no credential-like strings", async () => {
    // prepare-level artifacts exercised under outputs/test-tmp by the harness tests;
    // scan any stray outputs here as well as the compiled boundary checker output.
    const hits: string[] = [];
    const scan = (dir: string): void => {
      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        // A sibling test's cleanup can remove a directory mid-scan; skip it.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          if (item.name !== "node_modules") scan(full);
        } else if (/\.(json|jsonl|md|log)$/.test(item.name)) {
          let text: string;
          try {
            text = fs.readFileSync(full, "utf-8");
          } catch (error) {
            // Same race at file granularity: the entry vanished after readdir listed it.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          const match = text.match(/sk-[A-Za-z0-9_-]{10,}/);
          if (match) hits.push(`${full}: ${match[0].slice(0, 8)}…`);
        }
      }
    };
    const tmpRoot = path.join(ROOT, "outputs", "test-tmp");
    if (fs.existsSync(tmpRoot)) scan(tmpRoot);
    expect(hits).toEqual([]);
  });
});
