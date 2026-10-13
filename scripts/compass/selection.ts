// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as path from "node:path";
import { strings } from "./strings.js";
import type { FrozenFile, RunSelection, Scope } from "./types.js";
import { findWorkspaceRoot, sha256File } from "./util.js";

/** Invalid selection targets throw this; the harness never falls back to a wider scope. */
export class SelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectionError";
  }
}

/** Scope defaults to `all` (today's behavior); `file` is the new isolated scope. */
export function parseScope(raw: string | undefined): Scope {
  if (raw === undefined || raw === "all") return "all";
  if (raw === "file") return "file";
  throw new SelectionError(`unknown scope '${raw}' — valid scopes: all, file`);
}

/** Validate the user-selected session file. Throws SelectionError; never widens scope. */
export function validateSessionFile(filePath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new SelectionError(strings.selectionNotFound(filePath));
  }
  if (!stat.isFile()) throw new SelectionError(strings.selectionNotAFile(filePath));
  if (!filePath.endsWith(".jsonl")) throw new SelectionError(strings.selectionNotJsonl(filePath));
  if (stat.size === 0) throw new SelectionError(strings.selectionEmpty(filePath));
}

export interface FreezeOptions {
  scope: Scope;
  /** Required for scope=file. */
  sourcePath?: string;
  runId: string;
  outputDir: string;
  /** Override for tests; defaults to <workspace>/fixtures. */
  fixturesDir?: string;
}

/**
 * Freeze the selection:
 * - scope=file: validate + hash the source, copy it to fixtures/sessions/<sha>-<name>
 *   (canonical frozen copy), then place exactly that one file into
 *   <outputDir>/sessions/selected/<name> — the only directory the pipeline may scan.
 * - scope=all: no file copy; the pipeline keeps scanning the real session dirs.
 */
export function freezeSelection(opts: FreezeOptions): RunSelection {
  const createdAt = new Date().toISOString();
  if (opts.scope === "all") {
    return { scope: "all", runId: opts.runId, outputDir: opts.outputDir, createdAt };
  }
  const sourcePath = opts.sourcePath;
  if (!sourcePath) throw new SelectionError("scope=file requires --session <path>");
  validateSessionFile(sourcePath);

  const sha256 = sha256File(sourcePath);
  const fixturesDir = opts.fixturesDir ?? path.join(findWorkspaceRoot(), "fixtures");
  const baseName = path.basename(sourcePath);
  const storedPath = path.join(fixturesDir, "sessions", `${sha256.slice(0, 12)}-${baseName}`);
  fs.mkdirSync(path.dirname(storedPath), { recursive: true });
  if (!fs.existsSync(storedPath) || sha256File(storedPath) !== sha256) {
    fs.copyFileSync(sourcePath, storedPath);
  }

  const isolatedSessionDir = path.join(opts.outputDir, "sessions", "selected");
  fs.mkdirSync(isolatedSessionDir, { recursive: true });
  // Exactly one .jsonl in the isolated dir — remove any stale extras from a reused output dir.
  for (const existing of fs.readdirSync(isolatedSessionDir)) {
    if (existing.endsWith(".jsonl")) fs.rmSync(path.join(isolatedSessionDir, existing));
  }
  const isolatedFile = path.join(isolatedSessionDir, baseName);
  fs.copyFileSync(storedPath, isolatedFile);
  if (sha256File(isolatedFile) !== sha256) {
    throw new SelectionError(`frozen copy hash mismatch for ${isolatedFile}`);
  }

  const frozen: FrozenFile = { sourcePath, storedPath, sha256, sizeBytes: fs.statSync(sourcePath).size };
  return { scope: "file", runId: opts.runId, outputDir: opts.outputDir, frozen, isolatedSessionDir, createdAt };
}

/** Persist the selection so the pipeline and counter share it before any model call. */
export function writeSelection(runDir: string, selection: RunSelection): string {
  fs.mkdirSync(runDir, { recursive: true });
  const filePath = path.join(runDir, "selection.json");
  fs.writeFileSync(filePath, JSON.stringify(selection, null, 2), "utf-8");
  return filePath;
}
