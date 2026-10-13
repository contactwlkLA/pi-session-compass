// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
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

/** Restore a snapshot into a (possibly fresh) portrait dir — the run's starting state. */
export function restoreSnapshot(snapshotDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of SNAPSHOT_FILES) {
    const src = path.join(snapshotDir, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(destDir, name));
  }
  const gitDir = path.join(snapshotDir, ".git");
  if (fs.existsSync(gitDir)) copyDirRecursive(gitDir, path.join(destDir, ".git"));
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
