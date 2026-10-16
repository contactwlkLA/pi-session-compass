// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Work state: scan positions and pending candidates.
 *
 * The latest snapshot is the authority for both. With no snapshot yet, the scan positions are
 * seeded from `processed-sessions.json` and there are no pending candidates; a load writes
 * nothing. A save writes a new snapshot — copying whichever of `portrait.md`, `evicted.md`, and
 * `dropped.md` exist — and then mirrors the scan positions to `processed-sessions.json` for the
 * readers that still use that file. A corrupt or unsupported snapshot throws and is never
 * replaced by a seed.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { EXTRACTION_PROMPT } from "./prompts.js";
import { loadLatestSnapshot, type SnapshotState, writeSnapshot } from "./snapshot-store.js";
import { loadScanCheckpoints, saveScanCheckpoints } from "./storage.js";
import type { PendingCandidate } from "./types.js";

const WORK_FILES = ["portrait.md", "evicted.md", "dropped.md"];
const POLICY_REVISION_LENGTH = 12;

/** Fingerprint of the extraction prompt in force; recorded on every saved candidate. */
export const EXTRACTION_POLICY_REVISION: string = createHash("sha256")
  .update(EXTRACTION_PROMPT)
  .digest("hex")
  .slice(0, POLICY_REVISION_LENGTH);

/**
 * The work state of the latest snapshot. When no snapshot exists yet, the scan positions are
 * seeded from `processed-sessions.json` and the candidates are empty. Throws
 * SnapshotCorruptError or SnapshotUnsupportedError for a damaged snapshot instead of seeding.
 */
export function loadWorkState(portraitDir: string): SnapshotState {
  const loaded = loadLatestSnapshot(portraitDir);
  if (loaded !== null) return loaded.state;
  return {
    scanPositions: loadScanCheckpoints(portraitDir),
    pendingCandidates: [],
    publicationIntent: null,
  };
}

/**
 * The `needsBuild` candidates in stored order. When `sourceFilter` is a path, only the candidates
 * whose sourcePath equals its resolved form are selected.
 */
export function selectPendingForBuild(state: SnapshotState, sourceFilter: string | null): PendingCandidate[] {
  const sourcePath = sourceFilter === null ? null : path.resolve(sourceFilter);
  return state.pendingCandidates.filter(
    (candidate) => candidate.stage === "needsBuild" && (sourcePath === null || candidate.sourcePath === sourcePath),
  );
}

/**
 * Write `state` as a new snapshot — with copies of the portrait and archive files that exist in
 * `portraitDir` — then mirror the scan positions to `processed-sessions.json`.
 */
export function saveWorkState(portraitDir: string, state: SnapshotState): void {
  const filePaths = WORK_FILES.map((name) => path.join(portraitDir, name)).filter((filePath) =>
    fs.existsSync(filePath),
  );
  writeSnapshot(portraitDir, state, filePaths);
  saveScanCheckpoints(portraitDir, state.scanPositions);
}
