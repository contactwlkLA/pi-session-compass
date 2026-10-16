// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Durable snapshots of collection progress.
 *
 * A snapshot is a directory `<portraitDir>/snapshots/snap-<seq>` holding `state.json`, copies of
 * the portrait and archive files under `files/`, and `manifest.json` (schema version plus the
 * sha256 of every other file in the snapshot). A new snapshot is written beside the previous one
 * as `snap-<seq>.tmp`, flushed, renamed into place, and only then made active by atomically
 * replacing the `CURRENT` file. An interrupted write therefore leaves the previous snapshot
 * active. Loading verifies every digest; a corrupt or unsupported snapshot throws and is never
 * treated as empty.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PendingCandidate, ScanCheckpoint } from "./types.js";

export const SNAPSHOT_SCHEMA_VERSION = 1;

const SNAPSHOTS_DIR = "snapshots";
const CURRENT_FILE = "CURRENT";
const MANIFEST_FILE = "manifest.json";
const STATE_FILE = "state.json";
const FILES_DIR = "files";
const SNAPSHOT_PREFIX = "snap-";
const TMP_SUFFIX = ".tmp";
const SEQ_DIGITS = 6;
const NO_SNAPSHOT_SEQ = 0;

/** Progress held by a snapshot. */
export interface SnapshotState {
  scanPositions: Record<string, ScanCheckpoint>;
  pendingCandidates: PendingCandidate[];
  publicationIntent: Record<string, string> | null;
}

export interface SnapshotManifest {
  schemaVersion: number;
  seq: number;
  createdAt: string;
  /** sha256 hex of every file in the snapshot except the manifest, by path relative to it. */
  files: Record<string, string>;
  /** Original absolute path of each copied portrait/archive file, by its path in the snapshot. */
  sources: Record<string, string>;
}

export interface LoadedSnapshot {
  /** Absolute path of the snapshot directory. */
  dir: string;
  manifest: SnapshotManifest;
  state: SnapshotState;
}

export class SnapshotCorruptError extends Error {
  constructor(dir: string, reason: string) {
    super(`Portrait snapshot ${dir} is corrupt (${reason}); processing stopped. Progress was not reset.`);
    this.name = "SnapshotCorruptError";
  }
}

export class SnapshotUnsupportedError extends Error {
  constructor(dir: string, version: unknown) {
    super(
      `Portrait snapshot ${dir} has unsupported schema version ${String(version)}; processing stopped. Progress was not reset.`,
    );
    this.name = "SnapshotUnsupportedError";
  }
}

const MISSING_OR_UNREADABLE = "the active snapshot is missing or unreadable";
const checksumMismatch = (file: string): string => `checksum mismatch in ${file}`;
const notValidJson = (file: string): string => `${file} is not valid JSON`;

function snapshotsRoot(portraitDir: string): string {
  return path.join(portraitDir, SNAPSHOTS_DIR);
}

function snapshotName(seq: number): string {
  return `${SNAPSHOT_PREFIX}${String(seq).padStart(SEQ_DIGITS, "0")}`;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Write a file and flush it to disk before returning. */
function writeFileSynced(filePath: string, data: Buffer | string): void {
  const fd = fs.openSync(filePath, "w");
  try {
    fs.writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf-8") : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Flush a directory entry list (renames, new files). Some platforms cannot open a directory
 * for fsync; there the rename itself is the best available guarantee.
 */
function syncDir(dirPath: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dirPath, "r");
    fs.fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EISDIR" && code !== "EPERM" && code !== "EINVAL" && code !== "EBADF") throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Sequence numbers of complete snapshot directories, ascending. */
function completeSeqs(root: string): number[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => name.startsWith(SNAPSHOT_PREFIX) && !name.endsWith(TMP_SUFFIX))
    .map((name) => Number(name.slice(SNAPSHOT_PREFIX.length)))
    .filter((seq) => Number.isInteger(seq) && seq > NO_SNAPSHOT_SEQ)
    .sort((a, b) => a - b);
}

function readCurrentName(root: string): string | undefined {
  try {
    const name = fs.readFileSync(path.join(root, CURRENT_FILE), "utf-8").trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a new snapshot of `state` and the given portrait/archive files, then make it active.
 * Keeps the previously active snapshot; removes older ones and leftovers of interrupted writes.
 * Returns the new snapshot's directory.
 */
export function writeSnapshot(portraitDir: string, state: SnapshotState, filePaths: string[]): string {
  const root = snapshotsRoot(portraitDir);
  fs.mkdirSync(root, { recursive: true });
  const previousName = readCurrentName(root);
  const seq = Math.max(NO_SNAPSHOT_SEQ, ...completeSeqs(root)) + 1;
  const name = snapshotName(seq);
  const tmpDir = path.join(root, `${name}${TMP_SUFFIX}`);
  const finalDir = path.join(root, name);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmpDir, FILES_DIR), { recursive: true });

  const digests: Record<string, string> = {};
  const stateBytes = Buffer.from(JSON.stringify(state, null, 2), "utf-8");
  writeFileSynced(path.join(tmpDir, STATE_FILE), stateBytes);
  digests[STATE_FILE] = sha256(stateBytes);

  const sources: Record<string, string> = {};
  filePaths.forEach((filePath, index) => {
    const copyName = `${index}-${path.basename(filePath)}`;
    const relative = `${FILES_DIR}/${copyName}`;
    const bytes = fs.readFileSync(filePath);
    writeFileSynced(path.join(tmpDir, FILES_DIR, copyName), bytes);
    digests[relative] = sha256(bytes);
    sources[relative] = path.resolve(filePath);
  });
  syncDir(path.join(tmpDir, FILES_DIR));

  const manifest: SnapshotManifest = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    seq,
    createdAt: new Date().toISOString(),
    files: digests,
    sources,
  };
  writeFileSynced(path.join(tmpDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  syncDir(tmpDir);

  fs.renameSync(tmpDir, finalDir);
  syncDir(root);

  const currentTmp = path.join(root, `${CURRENT_FILE}${TMP_SUFFIX}`);
  writeFileSynced(currentTmp, `${name}\n`);
  fs.renameSync(currentTmp, path.join(root, CURRENT_FILE));
  syncDir(root);

  for (const entry of fs.readdirSync(root)) {
    if (!entry.startsWith(SNAPSHOT_PREFIX) || entry === name || entry === previousName) continue;
    fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  }
  return finalDir;
}

function readJson(dir: string, relative: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, relative), "utf-8");
  } catch {
    throw new SnapshotCorruptError(dir, MISSING_OR_UNREADABLE);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SnapshotCorruptError(dir, notValidJson(relative));
  }
}

/**
 * Load the active snapshot after verifying it. Returns null when no snapshot has ever been
 * completed (no `snapshots/` directory, or only an interrupted first write). Throws
 * SnapshotCorruptError or SnapshotUnsupportedError otherwise; never returns an empty state
 * for a damaged snapshot.
 */
export function loadLatestSnapshot(portraitDir: string): LoadedSnapshot | null {
  const root = snapshotsRoot(portraitDir);
  if (!fs.existsSync(root)) return null;

  const currentName = readCurrentName(root);
  if (currentName === undefined) {
    if (completeSeqs(root).length === 0) return null;
    throw new SnapshotCorruptError(root, MISSING_OR_UNREADABLE);
  }
  const dir = path.join(root, currentName);
  if (!fs.existsSync(dir)) throw new SnapshotCorruptError(dir, MISSING_OR_UNREADABLE);

  const manifest = readJson(dir, MANIFEST_FILE) as Partial<SnapshotManifest> | null;
  if (manifest === null || typeof manifest !== "object") {
    throw new SnapshotCorruptError(dir, notValidJson(MANIFEST_FILE));
  }
  if (manifest.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new SnapshotUnsupportedError(dir, manifest.schemaVersion);
  }
  const files = manifest.files ?? {};
  if (files[STATE_FILE] === undefined) throw new SnapshotCorruptError(dir, checksumMismatch(STATE_FILE));
  for (const [relative, digest] of Object.entries(files)) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(dir, relative));
    } catch {
      throw new SnapshotCorruptError(dir, checksumMismatch(relative));
    }
    if (sha256(bytes) !== digest) throw new SnapshotCorruptError(dir, checksumMismatch(relative));
  }

  const state = readJson(dir, STATE_FILE) as SnapshotState;
  return { dir, manifest: manifest as SnapshotManifest, state };
}
