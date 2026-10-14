// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Live-run boot for the harness execute path: installs registry, wrapped stream
 * function, instrumentation hooks, and settings into the same process, then
 * drives the unchanged runPipelineLoop (filtering, termination, retries,
 * extraction, building behavior preserved).
 *
 * No credentials are ever written to run artifacts: traces and receipts carry
 * model/provider/timing/usage only.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BuildEvent, CooldownEvent, TrioExaminedEvent } from "../../src/instrument.js";
import type { LlmAttemptEvent } from "../../src/llm-call.js";
import { emptyStats, RequestCounter } from "./counter.js";
import { strings } from "./strings.js";
import type { CensusResult, Limits, RunSelection } from "./types.js";

export interface SinkError {
  hook: string;
  error: string;
}

/** Wrap instrumentation callbacks so a throwing sink is recorded instead of breaking the run. */
export function createSinkGuard(): {
  sinkErrors: SinkError[];
  guardSink: (hook: string, fn: () => void) => void;
} {
  const sinkErrors: SinkError[] = [];
  const guardSink = (hook: string, fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      sinkErrors.push({ hook, error: error instanceof Error ? error.message : String(error) });
    }
  };
  return { sinkErrors, guardSink };
}

/** Fail the run when instrumentation sinks recorded errors. Returns the process exit code: 1 when sinkErrors is non-empty, 0 otherwise. Writes the receipt in both cases. */
export function failOnSinkErrors(
  write: (stop: "completed" | "capped" | "error", error: string | null) => void,
  sinkErrors: SinkError[],
): number {
  if (sinkErrors.length === 0) return 0;
  const sinkError = `instrumentation sink errors: ${sinkErrors.map((s) => `${s.hook}: ${s.error}`).join("; ")}`;
  write("error", sinkError);
  process.stderr.write(`compass harness: run failed: ${sinkError}\n`);
  return 1;
}

export interface BootOptions {
  limits: Limits;
  prepared: { selection: RunSelection; census: CensusResult | null };
  outputDir: string;
  confirmMode: string;
}

interface BuildRecord {
  index: number;
  decisions: { action: string; candidate?: string; text?: string }[];
  inserted: number;
  evicted: number;
  rulesAfter: string[];
}

function readRules(portraitDir: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(portraitDir, "portrait.md"), "utf-8");
    const start = raw.indexOf("## Anticipation Rules\n");
    if (start < 0) return [];
    return raw
      .slice(start + "## Anticipation Rules\n".length)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function diffRules(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const afterSet = new Set(after);
  const beforeSet = new Set(before);
  return { added: after.filter((r) => !beforeSet.has(r)), removed: before.filter((r) => !afterSet.has(r)) };
}

/** Run the ungated selected-file pipeline. Returns 0 on completion, 3 on a capped run. */
export async function runPipeline(opts: BootOptions): Promise<number> {
  const { limits, outputDir } = opts;
  const counter = new RequestCounter(limits);
  const stats = emptyStats();
  const attemptEvents: LlmAttemptEvent[] = [];
  const trioExamined: TrioExaminedEvent[] = [];
  const builds: BuildRecord[] = [];
  const cooldowns: CooldownEvent[] = [];
  let buildIndex = 0;

  const onShutdown: Array<() => void> = [];
  process.once("SIGINT", () => counter.abort());
  onShutdown.push(() => process.removeAllListeners("SIGINT"));
  // Created before the try so sink errors recorded before a crash still reach the error receipt.
  const { sinkErrors, guardSink } = createSinkGuard();

  try {
    // 1. Settings: the frozen, sanitized run snapshot (never live global files at run time).
    const settingsSnapshot = JSON.parse(fs.readFileSync(path.join(outputDir, "settings-snapshot.json"), "utf-8"));
    const runSettings = settingsSnapshot.portraitSettings;

    // 2. Model runtime from the operator's pi config (auth.json/models.json) — read only.
    const agentDir = path.join(os.homedir(), ".pi", "agent");
    const { ModelRuntime, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
    const { setDefaultStreamFn } = await import("@earendil-works/pi-agent-core");
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
    });
    const registry = new ModelRegistry(runtime);

    // 3. Resolve the portrait model; record access blockers, never credentials.
    const settingsUi = await import("../../src/settings-ui.js");
    settingsUi._setGetPortraitSettings(() => ({ ...runSettings }));
    const modelString: string | null = runSettings.model ?? null;
    let model: { provider: string; id: string };
    if (modelString) {
      const slash = modelString.indexOf("/");
      const found = slash > 0 ? registry.find(modelString.slice(0, slash), modelString.slice(slash + 1)) : undefined;
      if (!found) {
        const accessError = `model '${modelString}' unavailable: not found in the model registry`;
        writeReceipt(opts, counter, stats, "error", accessError, attemptEvents, cooldowns, null);
        process.stderr.write(`compass harness: ${accessError}\n`);
        return 1;
      }
      model = found;
    } else {
      // No override configured — use the operator's default model.
      const host = settingsSnapshot.hostPiSettings as { defaultProvider?: string; defaultModel?: string };
      const found =
        host.defaultProvider && host.defaultModel ? registry.find(host.defaultProvider, host.defaultModel) : undefined;
      if (!found) {
        const accessError = "no portrait model override and no resolvable host default model";
        writeReceipt(opts, counter, stats, "error", accessError, attemptEvents, cooldowns, null);
        process.stderr.write(`compass harness: ${accessError}\n`);
        return 1;
      }
      model = found;
    }

    // 4. Install the counter at the usable request hook: the wrapped default streamFn.
    const portraitDir = path.join(outputDir, "portrait");
    const rulesBeforeRun = readRules(portraitDir);
    const wrapped = counter.wrapStreamFn((m: unknown, ctx: unknown, options: unknown) =>
      registry.streamSimple(
        m as Parameters<typeof registry.streamSimple>[0],
        ctx as Parameters<typeof registry.streamSimple>[1],
        options as Parameters<typeof registry.streamSimple>[2],
      ),
    );
    setDefaultStreamFn(wrapped as never);

    const llmCall = await import("../../src/llm-call.js");
    llmCall.setLlmAttemptSink((event: LlmAttemptEvent) => {
      guardSink("attempt", () => {
        attemptEvents.push(event);
        if (!event.ok) stats.failures++;
      });
    });
    llmCall.setCapturedModel(model as never, registry as never);

    const { setInstrumentHooks } = await import("../../src/instrument.js");
    setInstrumentHooks({
      onTrioExamined: (event: TrioExaminedEvent) => {
        guardSink("trioExamined", () => {
          stats.triosExamined++;
          if (event.notes > 0) stats.triosProductive++;
          stats.candidates += event.notes;
          trioExamined.push(event);
        });
      },
      onBuild: (event: BuildEvent) => {
        guardSink("build", () => {
          buildIndex++;
          for (const decision of event.decisions) {
            if (decision.action === "insert") stats.inserted++;
            else if (decision.action === "merge") stats.merged++;
            else stats.skipped++;
          }
          stats.evicted += event.evicted;
          const rulesAfter = readRules(portraitDir);
          builds.push({
            index: buildIndex,
            decisions: event.decisions,
            inserted: event.inserted,
            evicted: event.evicted,
            rulesAfter,
          });
        });
      },
      onCooldown: (event: CooldownEvent) => {
        guardSink("cooldown", () => {
          stats.cooldownMs += event.ms;
          cooldowns.push(event);
        });
      },
    });

    // 5. Missing UI in a headless run: log errors to diagnostics instead of dialogs.
    const diagnosticsPath = path.join(outputDir, "diagnostics.log");
    globalThis.__piPortraitReportError = ((message: string, source: string) => {
      fs.appendFileSync(diagnosticsPath, `${new Date().toISOString()} [${source}] ${message}\n`, "utf-8");
    }) as never;

    const { runPipelineLoop } = await import("../../src/pipeline.js");
    const pipelineStats = await runPipelineLoop(runSettings, Number.POSITIVE_INFINITY, () => counter.exhausted());

    const capped = counter.stopReason !== null;
    const sinkExit = failOnSinkErrors(
      (stop, error) => writeReceipt(opts, counter, stats, stop, error, attemptEvents, cooldowns, sinkErrors),
      sinkErrors,
    );
    if (sinkExit !== 0) return sinkExit;
    writeReceipt(
      opts,
      counter,
      stats,
      capped ? "capped" : "completed",
      null,
      attemptEvents,
      cooldowns,
      null,
      pipelineStats,
    );
    writeSheet(opts, limits.runType, trioExamined, builds, rulesBeforeRun, readRules(portraitDir));
    return capped ? 3 : 0;
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    writeReceipt(
      opts,
      counter,
      stats,
      "error",
      message,
      attemptEvents,
      cooldowns,
      sinkErrors.length > 0 ? sinkErrors : null,
    );
    process.stderr.write(`compass harness: run failed: ${message}\n`);
    return 1;
  } finally {
    for (const release of onShutdown) release();
    try {
      const llmCall = await import("../../src/llm-call.js");
      llmCall.setLlmAttemptSink(null);
      const { setInstrumentHooks } = await import("../../src/instrument.js");
      setInstrumentHooks({});
    } catch {
      // teardown is best-effort
    }
  }
}

function stopLine(stop: "completed" | "capped" | "error", counter: RequestCounter): string {
  if (stop === "completed") return strings.stopCompleted(1);
  if (stop === "error") return "error — see receipt for details";
  if (counter.stopReason === "requests") return strings.stopRequestLimit(counter.snapshot().requestCount);
  if (counter.stopReason === "deadline") return strings.stopDeadline(counter.snapshot().elapsedMs);
  return strings.stopCancelled;
}

function writeReceipt(
  opts: BootOptions,
  counter: RequestCounter,
  stats: ReturnType<typeof emptyStats>,
  stop: "completed" | "capped" | "error",
  error: string | null,
  attempts: LlmAttemptEvent[],
  cooldowns: CooldownEvent[],
  sinkErrors: Array<{ hook: string; error: string }> | null,
  pipelineStats?: { totalSequences: number; totalInserted: number; totalEvicted: number },
): void {
  const snapshot = counter.snapshot();
  const receipt = {
    runType: opts.limits.runType,
    limits: { final: opts.limits, source: opts.limits.source },
    stop: { kind: stop, reason: stopLine(stop, counter) },
    ...(error ? { error } : {}),
    requests: { count: snapshot.requestCount, elapsedMs: snapshot.elapsedMs, usageTotals: snapshot.usageTotals },
    stages: attempts.reduce<Record<string, number>>((acc, event) => {
      acc[event.stage] = (acc[event.stage] ?? 0) + 1;
      return acc;
    }, {}),
    validationRounds: attempts.reduce<Record<string, Record<string, number>>>((acc, event) => {
      const stage = acc[event.stage] ?? {};
      const round = String(event.validationRound);
      stage[round] = (stage[round] ?? 0) + 1;
      acc[event.stage] = stage;
      return acc;
    }, {}),
    counts: {
      triosExamined: stats.triosExamined,
      triosProductive: stats.triosProductive,
      candidates: stats.candidates,
      inserted: stats.inserted,
      merged: stats.merged,
      skipped: stats.skipped,
      evicted: stats.evicted,
      failures: stats.failures,
      cooldownMs: stats.cooldownMs,
      ...(pipelineStats ? { pipeline: pipelineStats } : {}),
    },
    cooldownDetail: cooldowns,
    ...(sinkErrors === null ? {} : { sinkErrors }),
    selection: opts.prepared.selection,
    census: opts.prepared.census
      ? { file: opts.prepared.census.file, totalTrios: opts.prepared.census.totalTrios }
      : null,
    provenance: {
      startedAt: new Date(Date.now() - snapshot.elapsedMs).toISOString(),
      endedAt: new Date().toISOString(),
    },
  };
  fs.mkdirSync(opts.outputDir, { recursive: true });
  fs.writeFileSync(path.join(opts.outputDir, "receipt.json"), JSON.stringify(receipt, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(opts.outputDir, "traces.jsonl"),
    [
      ...attempts.map((a) => JSON.stringify({ kind: "attempt", ...a })),
      ...snapshot.traces.map((t) => JSON.stringify({ kind: "boundary", ...t })),
    ]
      .map((line) => `${line}\n`)
      .join(""),
    "utf-8",
  );
}

function writeSheet(
  opts: BootOptions,
  runType: Limits["runType"],
  trios: TrioExaminedEvent[],
  builds: BuildRecord[],
  rulesBefore: string[],
  rulesAfter: string[],
): void {
  const { added, removed } = diffRules(rulesBefore, rulesAfter);
  const lines: string[] = [
    runType === "smoke" ? strings.smokeSheetTitle : strings.baselineSheetTitle,
    "",
    `Selected scope: ${opts.prepared.selection.scope}${
      opts.prepared.selection.frozen ? ` — ${opts.prepared.selection.frozen.sourcePath}` : ""
    }`,
    `Trios examined: ${trios.length} · builds: ${builds.length} · portrait rules: ${rulesBefore.length} → ${rulesAfter.length}`,
    "",
  ];
  trios.forEach((trio, i) => {
    const ref = `${path.basename(trio.sessionPath)}`;
    const extractor =
      trio.notes > 0 ? trio.notesText.map((note) => `  - ${note}`).join("\n") : "  - (none — non-productive trio)";
    lines.push(`## Trio ${i + 1} (${ref})`, `${strings.sheetColExtractor}:`, extractor, "");
  });
  builds.forEach((build) => {
    lines.push(`## Build ${build.index}`, `${strings.sheetColBuilder}:`);
    for (const decision of build.decisions) {
      const label = decision.text ?? decision.candidate ?? "(no text)";
      lines.push(`  - [${decision.action}] ${label}`);
    }
    lines.push(`${strings.sheetColPortrait}: +${build.inserted} inserted · ${build.evicted} evicted`, "");
  });
  lines.push(
    "## Final portrait diff",
    `Added (${added.length}):`,
    ...added.map((r) => `  + ${r}`),
    `Removed (${removed.length}):`,
    ...removed.map((r) => `  - ${r}`),
  );
  fs.writeFileSync(path.join(opts.outputDir, "results-sheet.md"), `${lines.join("\n")}\n`, "utf-8");
}
