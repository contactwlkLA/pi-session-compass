// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { strings } from "./strings.js";
import { sha256File, sha256Text } from "./util.js";

/** State files copied by a portrait/archive snapshot (lock files are runtime-only). */
export const SNAPSHOT_FILES = [
  "portrait.md",
  "evicted.md",
  "dropped.md",
  "portrait-state.json",
  "processed-sessions.json",
  "bg-scan-checkpoints.json",
] as const;

/** Directory holding the work-state snapshots (scan positions and pending candidates). */
const WORK_STATE_DIR = "snapshots";

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const item of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, item.name);
    const to = path.join(dest, item.name);
    if (item.isDirectory()) copyDirRecursive(from, to);
    else if (item.isFile()) fs.copyFileSync(from, to);
  }
}

/**
 * Snapshot the live portrait state (state files + git archive) into destDir.
 * Writes hashes.json so a second snapshot can be proven byte-identical (repeatable).
 * Read-only with respect to the source directory.
 */
export function snapshotPortraitState(
  sourceDir: string,
  destDir: string,
): { hashesPath: string; hashes: Record<string, string> } {
  fs.mkdirSync(destDir, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const name of SNAPSHOT_FILES) {
    const src = path.join(sourceDir, name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(destDir, name);
    fs.copyFileSync(src, dest);
    hashes[name] = sha256File(dest);
  }
  const workDir = path.join(sourceDir, WORK_STATE_DIR);
  if (fs.existsSync(workDir)) {
    const destWorkDir = path.join(destDir, WORK_STATE_DIR);
    copyDirRecursive(workDir, destWorkDir);
    for (const [name, hash] of Object.entries(hashTree(destWorkDir))) {
      hashes[`${WORK_STATE_DIR}/${name}`] = hash;
    }
  }
  const gitDir = path.join(sourceDir, ".git");
  if (fs.existsSync(gitDir)) {
    copyDirRecursive(gitDir, path.join(destDir, ".git"));
    try {
      hashes[".git/HEAD"] = execSync("git rev-parse HEAD", { cwd: sourceDir, encoding: "utf-8" }).trim();
    } catch {
      hashes[".git/HEAD"] = "unresolvable";
    }
  }
  const hashesPath = path.join(destDir, "hashes.json");
  fs.writeFileSync(hashesPath, JSON.stringify(hashes, null, 2), "utf-8");
  return { hashesPath, hashes };
}

/**
 * Restore a snapshot into a run's portrait dir — the run's starting state.
 * The dir is cleared first: leftovers from an earlier attempt would survive the
 * copy, and read-only git objects cannot be overwritten in place.
 */
export function restoreSnapshot(snapshotDir: string, destDir: string): void {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of SNAPSHOT_FILES) {
    const src = path.join(snapshotDir, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(destDir, name));
  }
  const workDir = path.join(snapshotDir, WORK_STATE_DIR);
  if (fs.existsSync(workDir)) copyDirRecursive(workDir, path.join(destDir, WORK_STATE_DIR));
  const gitDir = path.join(snapshotDir, ".git");
  if (fs.existsSync(gitDir)) copyDirRecursive(gitDir, path.join(destDir, ".git"));
}

/** A frozen snapshot that is missing or does not match its recorded hashes. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

/**
 * Verify a frozen snapshot against its recorded hashes.json. Every listed entry
 * must still hash the same; `.git/HEAD` is checked with `git rev-parse HEAD` in
 * the snapshot dir. Returns the recorded hashes; throws SnapshotError on the
 * first mismatch so a run refuses before any model request.
 */
export function verifySnapshot(dir: string): Record<string, string> {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new SnapshotError(strings.startSnapshotNotFound(dir));
  }
  const hashesPath = path.join(dir, "hashes.json");
  if (!fs.existsSync(hashesPath)) {
    throw new SnapshotError(strings.startSnapshotNoHashes(dir));
  }
  let hashes: Record<string, string>;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(hashesPath, "utf-8"));
    const isStringMap =
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((value) => typeof value === "string");
    if (!isStringMap) throw new Error("hashes.json is not an object of string values");
    hashes = parsed as Record<string, string>;
  } catch {
    throw new SnapshotError(strings.startSnapshotMismatch("hashes.json", dir));
  }
  for (const [name, expected] of Object.entries(hashes)) {
    if (name === ".git/HEAD") {
      let actual: string;
      try {
        actual = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
      } catch {
        throw new SnapshotError(strings.startSnapshotMismatch(name, dir));
      }
      if (actual !== expected) throw new SnapshotError(strings.startSnapshotMismatch(name, dir));
      continue;
    }
    const filePath = path.join(dir, name);
    if (!fs.existsSync(filePath) || sha256File(filePath) !== expected) {
      throw new SnapshotError(strings.startSnapshotMismatch(name, dir));
    }
  }
  return hashes;
}

/** Hash every regular file under dir (relative paths sorted) — for isolation checks. */
export function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string, prefix: string): void => {
    if (!fs.existsSync(current)) return;
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) walk(path.join(current, item.name), rel);
      else if (item.isFile()) out[rel] = sha256File(path.join(current, item.name));
    }
  };
  walk(dir, "");
  return out;
}

/** Stable digest of a hash tree for equality comparisons. */
export function treeDigest(hashes: Record<string, string>): string {
  const keys = Object.keys(hashes).sort();
  return sha256Text(keys.map((k) => `${k}:${hashes[k]}`).join("\n"));
}
