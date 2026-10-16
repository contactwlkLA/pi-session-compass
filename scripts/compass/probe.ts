// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Jev probe (run type `probe`): score every trio of one session file with the
 * gate's classifier and print one table. No extraction, no building, no
 * portrait access — only Jev requests, counted against the given limits.
 *
 * Usage:
 *   node probe.js --session <jsonl> --max-requests N --max-run-ms N [--output <dir>] [--confirmed]
 *
 * Without --confirmed it prints the run block and exits 2 (no request). The
 * credential comes from TYPESAFE_API_KEY and never reaches an output file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { buildGateState, callJev, JEV_POLICY, JEV_POLICY_HASH, type JevResult, routeGate } from "../../src/jev.js";
import { type SessionEntry, TrioDetector } from "../../src/trio-detector.js";
import type { InteractionSequence } from "../../src/types.js";
import { findWorkspaceRoot, parseArgv } from "./util.js";

const SNIPPET_CHARS = 90;
/** Failed requests in a row after which the probe stops (same limit as the plugin gate). */
const JEV_POLICY_FAILURE_LIMIT = 3;

interface ProbeRow {
  trio: number;
  userFeedback: string;
  verdict: "no_lesson" | "maybe_lesson" | "fallback" | "not_run";
  answers: Record<string, number> | null;
  reason: string | null;
  model: string | null;
  attempts: number;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
}

/** Every trio of a session file, as the production detector emits them. */
export function readTrios(filePath: string): InteractionSequence[] {
  const detector = new TrioDetector();
  const trios: InteractionSequence[] = [];
  for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let entry: SessionEntry;
    try {
      entry = JSON.parse(line) as SessionEntry;
    } catch {
      continue;
    }
    const trio = detector.process(entry);
    if (trio) trios.push(trio);
  }
  return trios;
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1)}…` : flat;
}

function cell(value: number | undefined): string {
  return value === undefined ? "–" : value.toFixed(2);
}

/** The markdown table: one row per trio, highest maximum probability first within the original order kept by index. */
export function renderTable(rows: ProbeRow[]): string {
  const lines = [
    "| # | verdict | correction | preference | steering | confusion | user reply |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const row of rows) {
    const a = row.answers ?? {};
    const verdict = row.verdict === "fallback" ? `fallback (${row.reason})` : row.verdict;
    const reply = row.userFeedback.replace(/\|/g, "\\|");
    lines.push(
      `| ${row.trio} | ${verdict} | ${cell(a.correction)} | ${cell(a.preference)} | ${cell(a.steering)} | ${cell(a.confusion)} | ${reply} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function rowFor(index: number, trio: InteractionSequence, result: JevResult | null, reason: string | null): ProbeRow {
  const base = { trio: index, userFeedback: snippet(trio.userFeedback) };
  if (result === null) {
    return {
      ...base,
      verdict: reason === null ? "not_run" : "fallback",
      answers: null,
      reason,
      model: null,
      attempts: 0,
      latencyMs: 0,
      usage: null,
    };
  }
  if (result.kind === "fallback") {
    return {
      ...base,
      verdict: "fallback",
      answers: null,
      reason: result.reason,
      model: null,
      attempts: result.attempts,
      latencyMs: result.latencyMs,
      usage: null,
    };
  }
  return {
    ...base,
    verdict: routeGate(result, JEV_POLICY),
    answers: result.answers,
    reason: null,
    model: result.model,
    attempts: result.attempts,
    latencyMs: result.latencyMs,
    usage: result.usage,
  };
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgv(argv);
  const session = typeof args.session === "string" ? path.resolve(args.session) : null;
  const maxRequests = Number(args["max-requests"]);
  const maxRunMs = Number(args["max-run-ms"]);
  if (
    !session ||
    !fs.existsSync(session) ||
    !Number.isInteger(maxRequests) ||
    maxRequests < 1 ||
    !Number.isInteger(maxRunMs) ||
    maxRunMs < 1
  ) {
    process.stderr.write(
      "probe: --session <existing jsonl>, --max-requests N and --max-run-ms N (positive integers) are required\n",
    );
    return 2;
  }
  const root = findWorkspaceRoot();
  const runId = `probe-${new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "")}`;
  const outputDir =
    typeof args.output === "string" ? path.resolve(args.output) : path.join(root, "outputs", "probe", runId);
  const trios = readTrios(session);

  process.stdout.write(
    [
      "compass probe — Jev classifier only (no extraction, no building, no portrait)",
      `Session: ${session} — ${trios.length} trios`,
      `Limits: ${maxRequests} requests, ${Math.round(maxRunMs / 1000)} s`,
      `Jev model: ${JEV_POLICY.model} · policy ${JEV_POLICY_HASH} · deadline ${JEV_POLICY.deadlineMs} ms per trio`,
      `Output: ${outputDir}`,
      "",
    ].join("\n"),
  );
  if (args.confirmed !== "true") {
    process.stdout.write(
      "Not confirmed: pass --confirmed after the user approves these values. No request was made.\n",
    );
    return 2;
  }
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    process.stderr.write("probe: TYPESAFE_API_KEY is not set. No request was made.\n");
    return 2;
  }

  const startedAt = Date.now();
  let requests = 0;
  let stop: string | null = null;
  const beforeAttempt = (): boolean => {
    if (requests >= maxRequests) {
      stop = "requests";
      return false;
    }
    if (Date.now() - startedAt >= maxRunMs) {
      stop = "deadline";
      return false;
    }
    requests++;
    return true;
  };
  const transport = {
    fetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init),
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };

  const rows: ProbeRow[] = [];
  let consecutiveFailures = 0;
  for (const [i, trio] of trios.entries()) {
    if (stop !== null) {
      rows.push(rowFor(i + 1, trio, null, null));
      continue;
    }
    const state = buildGateState(trio, JEV_POLICY);
    if (state.kind === "oversized") {
      rows.push(rowFor(i + 1, trio, null, "oversized_state"));
      continue;
    }
    const result = await callJev(state.state, apiKey, JEV_POLICY, transport, beforeAttempt);
    rows.push(rowFor(i + 1, trio, result, null));
    // An authentication failure will not change on the next trio, and three failed requests
    // in a row mean the service is unusable for this run: stop instead of spending requests.
    if (result.kind === "fallback" && (result.reason === "http_401" || result.reason === "http_403")) {
      stop = result.reason;
    } else if (result.kind === "fallback" && result.attempts > 0) {
      consecutiveFailures++;
      if (consecutiveFailures >= JEV_POLICY_FAILURE_LIMIT) stop = "consecutive_failures";
    } else if (result.kind === "scored") {
      consecutiveFailures = 0;
    }
    process.stdout.write(`trio ${i + 1}/${trios.length}: ${rows[rows.length - 1].verdict}\n`);
  }

  const scored = rows.filter((r) => r.answers !== null);
  const summary = {
    runType: "probe",
    session,
    trios: trios.length,
    limits: { maxRequests, maxRunMs },
    stop: stop ?? "completed",
    requests,
    elapsedMs: Date.now() - startedAt,
    policyHash: JEV_POLICY_HASH,
    modelsReturned: [...new Set(scored.map((r) => r.model))],
    verdicts: rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
      return acc;
    }, {}),
    latencyMs: {
      mean: scored.length ? Math.round(scored.reduce((s, r) => s + r.latencyMs, 0) / scored.length) : null,
      max: scored.length ? Math.max(...scored.map((r) => r.latencyMs)) : null,
    },
    usage: scored.reduce(
      (acc, r) => ({
        inputTokens: acc.inputTokens + (r.usage?.inputTokens ?? 0),
        outputTokens: acc.outputTokens + (r.usage?.outputTokens ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0 },
    ),
  };

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "probe.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  fs.writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2), "utf-8");
  const table = renderTable(rows);
  fs.writeFileSync(
    path.join(outputDir, "probe-table.md"),
    `# Jev probe — ${path.basename(session)}\n\n${table}`,
    "utf-8",
  );
  process.stdout.write(`\n${table}\n${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
