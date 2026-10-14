// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CensusResult, Limits, RunSelection, StartPortrait } from "./types.js";

export interface ManifestData {
  runType: Limits["runType"];
  suggested: { maxModelRequests: number; maxRunMs: number; source: string } | null;
  finalLimits: Limits;
  selection: RunSelection;
  census: { file: string; sha256: string; totalTrios: number } | null;
  settingsSnapshotPath: string;
  startPortrait: StartPortrait;
  sourceIdentity: { branch: string | null; commit: string | null; dirty: boolean };
  confirmed: { mode: string; at: string } | null;
}

/** Snapshot source/settings/fixture/selector revisions for one run. */
export function buildManifestData(input: {
  runType: Limits["runType"];
  suggested: ManifestData["suggested"];
  finalLimits: Limits;
  selection: RunSelection;
  census: CensusResult | null;
  settingsSnapshotPath: string;
  workspaceRoot: string;
  startPortrait: StartPortrait;
  confirmed: ManifestData["confirmed"];
}): ManifestData {
  let branch: string | null = null;
  let commit: string | null = null;
  let dirty = false;
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: input.workspaceRoot, encoding: "utf-8" }).trim();
    commit = execSync("git rev-parse HEAD", { cwd: input.workspaceRoot, encoding: "utf-8" }).trim();
    // Tracked changes only: untracked scratch files do not change the source under test.
    dirty =
      execSync("git status --porcelain --untracked-files=no", { cwd: input.workspaceRoot, encoding: "utf-8" }).trim()
        .length > 0;
  } catch {
    // git unavailable — manifest records nulls
  }
  return {
    runType: input.runType,
    suggested: input.suggested,
    finalLimits: input.finalLimits,
    selection: input.selection,
    census: input.census
      ? { file: input.census.file, sha256: input.census.sha256, totalTrios: input.census.totalTrios }
      : null,
    settingsSnapshotPath: input.settingsSnapshotPath,
    startPortrait: input.startPortrait,
    sourceIdentity: { branch, commit, dirty },
    confirmed: input.confirmed,
  };
}

/** Write the manifest (overwrite = a new manifest for a new run, per task T5.2). */
export function freezeManifest(runDir: string, manifest: ManifestData): string {
  fs.mkdirSync(runDir, { recursive: true });
  const filePath = path.join(runDir, "manifest.json");
  fs.writeFileSync(filePath, JSON.stringify({ frozenAt: new Date().toISOString(), ...manifest }, null, 2), "utf-8");
  return filePath;
}
