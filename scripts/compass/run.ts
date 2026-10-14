// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Selected-file harness entry point (Stage 1, T2.4).
 *
 * Two subcommands:
 * - `prepare` — offline only, no model calls: freeze the selection, snapshot the
 *   live portrait state, capture sanitized settings, census the selected file,
 *   freeze the manifest. Prints the selection summary and census.
 * - `execute` — preparation + ungated pipeline run under confirmed limits
 *   (T4/T5). Requires --run-type/--max-model-requests/--max-run-ms/--limits-source
 *   and start-of-run confirmation (--confirmed for agent launch, y/N on a terminal).
 *
 * Env isolation must be installed before any src/config import; this module keeps
 * all src imports dynamic and sets PI_PORTRAIT_STATE_DIR / PI_PORTRAIT_SESSION_DIRS
 * (scope=file) before loading them.
 *
 * Usage:
 *   node run.js prepare --session <path> [--scope file] --output <dir>
 *   node run.js execute --session <path> --run-type smoke --max-model-requests 5 \
 *       --max-run-ms 900000 --limits-source compass-table --confirmed [--start-snapshot <dir>]
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { censusFile } from "./census.js";
import { renderConfirmation, resolveConfirmation } from "./confirmation.js";
import { LimitError, LimitReached, parseLimits, suggestedLimits } from "./limits.js";
import { buildManifestData, freezeManifest } from "./manifest.js";
import { freezeSelection, parseScope, SelectionError, writeSelection } from "./selection.js";
import { captureSettingsSnapshot } from "./settings.js";
import { restoreSnapshot, SnapshotError, snapshotPortraitState, treeDigest, verifySnapshot } from "./snapshot.js";
import { strings } from "./strings.js";
import type { CensusResult, Limits, RunSelection, StartPortrait } from "./types.js";
import { findWorkspaceRoot, parseArgv } from "./util.js";

function livePortraitDir(): string {
  return path.join(os.homedir(), ".pi", "portrait");
}

function makeRunId(): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "")}`;
}

export interface PrepareOptions {
  scope: string;
  sessionPath?: string;
  outputDir: string;
  runId: string;
  workspaceRoot: string;
  limits: Limits | null;
  suggested: { maxModelRequests: number; maxRunMs: number; source: string } | null;
  /** When set, restore from this frozen snapshot instead of snapshotting live. */
  startSnapshotDir?: string;
}

export interface PrepareResult {
  selection: RunSelection;
  census: CensusResult | null;
  settingsSnapshotPath: string;
  manifestPath: string;
  snapshotDir: string;
  startPortrait: StartPortrait;
}

/** Offline preparation: freeze selection, snapshot state/settings, census, manifest. */
export async function prepareRun(opts: PrepareOptions): Promise<PrepareResult> {
  fs.mkdirSync(opts.outputDir, { recursive: true });

  const selection = freezeSelection({
    scope: parseScope(opts.scope),
    sourcePath: opts.sessionPath,
    runId: opts.runId,
    outputDir: opts.outputDir,
  });
  writeSelection(opts.outputDir, selection);

  // Resolve the starting portrait: a verified frozen snapshot when --start-snapshot
  // is given, otherwise a fresh snapshot of the live state (reusable across runs).
  let startPortrait: StartPortrait;
  let snapshotDir: string;
  if (opts.startSnapshotDir) {
    const hashes = verifySnapshot(opts.startSnapshotDir);
    snapshotDir = opts.startSnapshotDir;
    startPortrait = { source: "snapshot", dir: snapshotDir, digest: treeDigest(hashes) };
  } else {
    snapshotDir = path.join(opts.workspaceRoot, "fixtures", "snapshots", opts.runId);
    const { hashes } = snapshotPortraitState(livePortraitDir(), snapshotDir);
    startPortrait = { source: "live", dir: snapshotDir, digest: treeDigest(hashes) };
  }
  // The run starts from the recorded initial state.
  restoreSnapshot(snapshotDir, path.join(opts.outputDir, "portrait"));

  const { snapshotPath } = await captureSettingsSnapshot(path.join(opts.outputDir, "settings-snapshot.json"));

  let census: CensusResult | null = null;
  if (selection.scope === "file" && selection.frozen) {
    census = await censusFile(selection.frozen.storedPath);
    fs.writeFileSync(path.join(opts.outputDir, "census.json"), JSON.stringify(census, null, 2), "utf-8");
  }

  const manifestPath = freezeManifest(
    opts.outputDir,
    buildManifestData({
      runType: opts.limits?.runType ?? "smoke",
      suggested: opts.suggested,
      finalLimits:
        opts.limits ?? ({ runType: "smoke", maxModelRequests: 0, maxRunMs: 0, source: "user-override" } as Limits),
      selection,
      census,
      settingsSnapshotPath: snapshotPath,
      workspaceRoot: opts.workspaceRoot,
      startPortrait,
      confirmed: null,
    }),
  );

  return { selection, census, settingsSnapshotPath: snapshotPath, manifestPath, snapshotDir, startPortrait };
}

function selectionLabel(selection: RunSelection, census: CensusResult | null): string {
  if (selection.scope === "file" && selection.frozen) return selection.frozen.sourcePath;
  return `all${census ? ` (${census.totalTrios} trios in last census)` : ""}`;
}

/** execute — preparation plus the ungated selected-file run under confirmed limits. */
export async function executeRun(
  args: Record<string, string | string[]>,
  opts: { confirmed: boolean; isTTY?: boolean },
): Promise<number> {
  const root = findWorkspaceRoot();
  const runId = typeof args["run-id"] === "string" ? args["run-id"] : makeRunId();
  const outputDir = typeof args.output === "string" ? path.resolve(args.output) : path.join(root, "outputs", runId);
  const scope = typeof args.scope === "string" ? args.scope : "file";
  const sessionPath = typeof args.session === "string" ? args.session : undefined;
  const startSnapshotArg = typeof args["start-snapshot"] === "string" ? args["start-snapshot"] : undefined;
  const startSnapshotDir = startSnapshotArg ? path.resolve(startSnapshotArg) : undefined;

  let limits: Limits;
  try {
    limits = parseLimits(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const suggested = limits.source === "compass-table" ? { ...tableSuggested(limits.runType) } : null;

  let prepared: PrepareResult;
  try {
    prepared = await prepareRun({
      scope,
      sessionPath,
      outputDir,
      runId,
      workspaceRoot: root,
      limits,
      suggested,
      startSnapshotDir,
    });
  } catch (error) {
    if (error instanceof SnapshotError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  // Install isolation before any pipeline import.
  process.env.PI_PORTRAIT_STATE_DIR = path.join(outputDir, "portrait");
  if (prepared.selection.scope === "file" && prepared.selection.isolatedSessionDir) {
    process.env.PI_PORTRAIT_SESSION_DIRS = prepared.selection.isolatedSessionDir;
  }

  const block = renderConfirmation({
    limits,
    scope: prepared.selection.scope,
    selectionLabel: selectionLabel(prepared.selection, prepared.census),
    trioCount: prepared.census?.totalTrios ?? 0,
    outputDir,
    startPortrait: prepared.startPortrait,
  });
  const confirmation = await resolveConfirmation(block, { confirmed: opts.confirmed, isTTY: opts.isTTY });
  if (!confirmation.proceed) return 2;

  // Re-freeze the manifest with confirmation provenance (execute step 2).
  freezeManifest(
    outputDir,
    buildManifestData({
      runType: limits.runType,
      suggested: suggested,
      finalLimits: limits,
      selection: prepared.selection,
      census: prepared.census,
      settingsSnapshotPath: prepared.settingsSnapshotPath,
      workspaceRoot: root,
      startPortrait: prepared.startPortrait,
      confirmed: { mode: confirmation.mode, at: new Date().toISOString() },
    }),
  );

  const { runPipeline } = await import("./pipeline-boot.js");
  const exitCode = await runPipeline({ limits, prepared, outputDir, confirmMode: confirmation.mode });
  return exitCode;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgv(argv);
  const positional = args._ as string[] | undefined;
  const command = positional?.[0];

  if (command === "prepare") {
    const root = findWorkspaceRoot();
    const runId = typeof args["run-id"] === "string" ? args["run-id"] : makeRunId();
    const outputDir = typeof args.output === "string" ? path.resolve(args.output) : path.join(root, "outputs", runId);
    try {
      const prepared = await prepareRun({
        scope: typeof args.scope === "string" ? args.scope : "file",
        sessionPath: typeof args.session === "string" ? args.session : undefined,
        outputDir,
        runId,
        workspaceRoot: root,
        limits: null,
        suggested: null,
      });
      const summary = [
        `output: ${outputDir}`,
        prepared.selection.scope === "file" && prepared.selection.frozen
          ? `selected: ${prepared.selection.frozen.sourcePath} (sha256 ${prepared.selection.frozen.sha256.slice(0, 12)}…, ${prepared.census?.totalTrios ?? 0} trios)`
          : "selection: all session files (today's behavior)",
        `manifest: ${prepared.manifestPath}`,
      ];
      process.stdout.write(`${summary.join("\n")}\n`);
      return 0;
    } catch (error) {
      const message = error instanceof SelectionError || error instanceof LimitError ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      return 2;
    }
  }

  if (command === "execute") {
    const confirmed = args.confirmed === "true";
    try {
      return await executeRun(args, { confirmed });
    } catch (error) {
      if (error instanceof LimitReached) {
        process.stderr.write(`compass harness: limit reached (${error.kind}) — run incomplete, evidence preserved.\n`);
        return 3;
      }
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      return 1;
    }
  }

  process.stderr.write(
    `compass harness: expected 'prepare' or 'execute'.\n` +
      "  prepare  --session <jsonl> [--scope file|all] [--output <dir>]\n" +
      "  execute  --session <jsonl> --run-type <t> --max-model-requests N --max-run-ms N --limits-source <s> [--confirmed] [--start-snapshot <dir>]\n",
  );
  return 2;
}

if (process.argv[1]) {
  try {
    if (import.meta.url === pathToFileURL(process.argv[1]).href) {
      void main(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (error) => {
          process.stderr.write(`${strings.cancelled}\n${error instanceof Error ? error.message : String(error)}\n`);
          process.exit(1);
        },
      );
    }
  } catch {
    // Imported as a module (tests) — do nothing.
  }
}

function tableSuggested(runType: Limits["runType"]): { maxModelRequests: number; maxRunMs: number; source: string } {
  const suggestion = suggestedLimits(runType);
  return suggestion ? { ...suggestion } : { maxModelRequests: 0, maxRunMs: 0, source: "compass-table" };
}
