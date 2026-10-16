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
import { confirmationModel, renderConfirmation, resolveConfirmation } from "./confirmation.js";
import { LimitError, LimitReached, parseLimits, suggestedLimits } from "./limits.js";
import { buildManifestData, freezeManifest } from "./manifest.js";
import { freezeSelection, parseScope, SelectionError, writeSelection } from "./selection.js";
import { captureSettingsSnapshot } from "./settings.js";
import { restoreSnapshot, SnapshotError, snapshotPortraitState, treeDigest, verifySnapshot } from "./snapshot.js";
import { strings } from "./strings.js";
import type { CensusResult, GateRunConfig, Limits, RunSelection, StartPortrait } from "./types.js";
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
  /** Raw --gate-mode value; validated by executeRun, absent on the standalone prepare path. */
  gateModeArg?: string;
}

export interface PrepareResult {
  selection: RunSelection;
  census: CensusResult | null;
  settingsSnapshotPath: string;
  manifestPath: string;
  snapshotDir: string;
  startPortrait: StartPortrait;
  /** The run's gate selection as the manifest recorded it at the first freeze. */
  gate: GateRunConfig;
}

/** The shipped gate modes, read from the gate config (src imports here stay dynamic). */
async function gateModes(): Promise<readonly string[]> {
  const { GATE_CONFIG } = await import("../../src/gate-config.js");
  return GATE_CONFIG.modes;
}

/** The gate modes as a type, taken from the shared run config. */
type GateModeValue = GateRunConfig["mode"];

/**
 * Resolve the run's gate: the --gate-mode flag when given, else the snapshot
 * setting, else the shipped default — an unknown snapshot value falls back to
 * the default. Where the mode came from travels with it, plus the policy hash
 * and the pinned model. An out-of-range flag refuses with the mode error.
 */
async function resolveGate(
  flag: string | undefined,
  portraitSettings: Record<string, unknown>,
): Promise<GateRunConfig> {
  const { GATE_CONFIG } = await import("../../src/gate-config.js");
  const { JEV_POLICY_HASH } = await import("../../src/jev.js");
  const modes = GATE_CONFIG.modes as readonly string[];
  if (flag !== undefined && !modes.includes(flag)) throw new LimitError(strings.invalidGateMode);
  const snapshotMode = portraitSettings.gateMode;
  const fromSettings =
    typeof snapshotMode === "string" && modes.includes(snapshotMode) ? (snapshotMode as GateModeValue) : null;
  return {
    mode: flag !== undefined ? (flag as GateModeValue) : (fromSettings ?? GATE_CONFIG.defaultMode),
    source: flag !== undefined ? "flag" : "settings",
    policyHash: JEV_POLICY_HASH,
    model: GATE_CONFIG.model,
  };
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

  const { snapshotPath, portraitSettings } = await captureSettingsSnapshot(
    path.join(opts.outputDir, "settings-snapshot.json"),
  );
  const gate = await resolveGate(opts.gateModeArg, portraitSettings);

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
      gate,
      confirmed: null,
    }),
  );

  return { selection, census, settingsSnapshotPath: snapshotPath, manifestPath, snapshotDir, startPortrait, gate };
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
  const gateModeArg = typeof args["gate-mode"] === "string" ? args["gate-mode"] : undefined;

  let limits: Limits;
  try {
    limits = parseLimits(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  // A bad --gate-mode refuses here, before preparation writes any run artifact.
  if (gateModeArg !== undefined && !(await gateModes()).includes(gateModeArg)) {
    process.stderr.write(`${strings.invalidGateMode}\n`);
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
      gateModeArg,
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

  const settingsSnapshot = JSON.parse(fs.readFileSync(prepared.settingsSnapshotPath, "utf-8")) as unknown;
  const { model, thinking } = confirmationModel(settingsSnapshot);
  const block = renderConfirmation({
    limits,
    scope: prepared.selection.scope,
    selectionLabel: selectionLabel(prepared.selection, prepared.census),
    trioCount: prepared.census?.totalTrios ?? null,
    outputDir,
    startPortrait: prepared.startPortrait,
    model,
    thinking,
    gate: prepared.gate,
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
      gate: prepared.gate,
      confirmed: { mode: confirmation.mode, at: new Date().toISOString() },
    }),
  );

  const { runPipeline } = await import("./pipeline-boot.js");
  const exitCode = await runPipeline({
    limits,
    prepared,
    outputDir,
    confirmMode: confirmation.mode,
    gate: prepared.gate,
  });
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
      const frozen = prepared.selection.scope === "file" ? prepared.selection.frozen : undefined;
      const summary = [
        strings.prepareOutput(outputDir),
        frozen
          ? strings.prepareSelected(frozen.sourcePath, frozen.sha256.slice(0, 12), prepared.census?.totalTrios ?? 0)
          : strings.prepareSelectionAll,
        strings.prepareManifest(prepared.manifestPath),
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
        process.stderr.write(`${strings.limitReached(error.kind)}\n`);
        return 3;
      }
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      return 1;
    }
  }

  process.stderr.write(`${strings.usageHeader}\n${strings.usagePrepare}\n${strings.usageExecute}\n`);
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
