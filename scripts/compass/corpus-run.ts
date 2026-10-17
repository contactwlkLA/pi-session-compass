// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * What the corpus run commands share: the set and concurrency switches, the
 * freeze check, the key re-read that pairs every selected trio with its frozen
 * text, the append-only cache, and the worker pool that starts a new item only
 * while no stop is set. The commands keep their own messages, rows, stop rules,
 * and outputs; nothing here prints.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { InteractionSequence } from "../../src/types.js";
import { trioKey } from "./corpus.js";
import { readTrios } from "./probe.js";
import type { CorpusSet, CorpusTrio } from "./types.js";
import { sha256File } from "./util.js";

/** The set a run covers: one side of the corpus, or both. */
export type RunSet = CorpusSet | "all";

export const DEFAULT_CONCURRENCY = 4;
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 8;

/** The requested set, or null when the value names none of dev, heldout, all. */
export function parseSet(value: unknown): RunSet | null {
  if (value === "dev" || value === "heldout" || value === "all") return value;
  return null;
}

/** The worker count: the default when the switch is absent, an integer 1–8 otherwise, else null. */
export function parseConcurrency(value: unknown): number | null {
  const raw = typeof value === "string" ? value : `${DEFAULT_CONCURRENCY}`;
  const concurrency = Number(raw);
  if (!Number.isInteger(concurrency) || concurrency < MIN_CONCURRENCY || concurrency > MAX_CONCURRENCY) return null;
  return concurrency;
}

/** True when freeze.json still matches the sha256 of both index files. */
export function freezeMatches(corpusDir: string): boolean {
  let freeze: Record<string, unknown>;
  try {
    freeze = JSON.parse(fs.readFileSync(path.join(corpusDir, "freeze.json"), "utf-8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  const corpusHash = freeze["corpus.json"];
  const triosHash = freeze["trios.jsonl"];
  if (typeof corpusHash !== "string" || typeof triosHash !== "string") return false;
  const corpusJson = path.join(corpusDir, "corpus.json");
  const triosJsonl = path.join(corpusDir, "trios.jsonl");
  if (!fs.existsSync(corpusJson) || !fs.existsSync(triosJsonl)) return false;
  return sha256File(corpusJson) === corpusHash && sha256File(triosJsonl) === triosHash;
}

/**
 * The selected trios with the frozen copy's texts beside them, or null when a
 * file is unreadable or any trio's text no longer reproduces its key. Each
 * file is read once, and the texts come back in corpus order.
 */
export function loadSelected(
  corpusDir: string,
  set: RunSet,
): { selected: CorpusTrio[]; texts: InteractionSequence[] } | null {
  const selected: CorpusTrio[] = [];
  for (const line of fs.readFileSync(path.join(corpusDir, "trios.jsonl"), "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as CorpusTrio;
    if (set === "all" || row.set === set) selected.push(row);
  }
  const textsByFile = new Map<string, InteractionSequence[]>();
  const texts: InteractionSequence[] = [];
  for (const row of selected) {
    let fileTexts = textsByFile.get(row.file);
    if (fileTexts === undefined) {
      try {
        fileTexts = readTrios(path.join(corpusDir, row.file));
      } catch {
        return null;
      }
      textsByFile.set(row.file, fileTexts);
    }
    const trio: InteractionSequence | undefined = fileTexts[row.index - 1];
    if (trio === undefined || trioKey(row.sessionId, row.index, trio) !== row.key) return null;
    texts.push(trio);
  }
  return { selected, texts };
}

/**
 * The cache as a key → line map. An unreadable file, a line cut short by a
 * crash, and a line the caller's validator rejects are ignored; when a key
 * appears twice, the first line wins.
 */
export function loadCache<T>(cachePath: string, isValid: (value: T) => boolean): Map<string, T> {
  const cache = new Map<string, T>();
  let raw: string;
  try {
    raw = fs.readFileSync(cachePath, "utf-8");
  } catch {
    return cache;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: T;
    try {
      parsed = JSON.parse(line) as T;
    } catch {
      continue;
    }
    const key = (parsed as { key?: unknown }).key;
    if (typeof key !== "string" || !isValid(parsed) || cache.has(key)) continue;
    cache.set(key, parsed);
  }
  return cache;
}

/** Append one JSONL line to the cache (newline-terminated). */
export function appendCacheLine(cachePath: string, line: unknown): void {
  fs.appendFileSync(cachePath, `${JSON.stringify(line)}\n`, "utf-8");
}

export interface PoolOptions<R> {
  concurrency: number;
  size: number;
  /** False once a stop is set: a worker then takes no new position. */
  shouldStart: () => boolean;
  runOne: (position: number) => Promise<R>;
  onRow: (position: number, row: R) => void;
}

/**
 * Up to `concurrency` workers take positions from one queue in ascending
 * order. A running item finishes even after a stop; items never started are
 * left to the caller.
 */
export async function runPool<R>(options: PoolOptions<R>): Promise<void> {
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (!options.shouldStart()) return;
      const position = nextIndex;
      if (position >= options.size) return;
      nextIndex++;
      const row = await options.runOne(position);
      options.onRow(position, row);
    }
  };
  const workers: Promise<void>[] = [];
  for (let w = 0; w < options.concurrency; w++) workers.push(worker());
  await Promise.all(workers);
}

/** Every selected trio as a row: the recorded one, or the caller's not-run row when it never started. */
export function fillNotRun<R>(selected: CorpusTrio[], rows: Array<R | null>, makeNotRun: (trio: CorpusTrio) => R): R[] {
  return rows.map((row, position) => row ?? makeNotRun(selected[position]));
}
