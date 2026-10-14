// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { strings } from "./strings.js";
import type { Limits, RunType } from "./types.js";
import { RUN_TYPES } from "./types.js";

/** Missing/invalid switches throw this — the harness refuses to start. */
export class LimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitError";
  }
}

/** Thrown at an inference boundary when a ceiling or the deadline is hit. */
export class LimitReached extends Error {
  readonly kind: "requests" | "deadline" | "aborted";
  constructor(kind: "requests" | "deadline" | "aborted") {
    super(`limit reached: ${kind}`);
    this.name = "LimitReached";
    this.kind = kind;
  }
}

/** Stored suggestions from the compass.md run-type table (UNSET rows have none). */
const TABLE_SUGGESTIONS: Partial<Record<RunType, Pick<Limits, "maxModelRequests" | "maxRunMs" | "source">>> = {
  smoke: { maxModelRequests: 5, maxRunMs: 900_000, source: "compass-table" },
};

/** Suggested limits for a run type, or null when the table row is UNSET. */
export function suggestedLimits(runType: RunType): Pick<Limits, "maxModelRequests" | "maxRunMs" | "source"> | null {
  return TABLE_SUGGESTIONS[runType] ?? null;
}

/** Parse a strictly finite positive integer or throw LimitError. */
export function parsePositiveInt(raw: string | undefined, flag: string): number {
  if (raw === undefined || raw === "") throw new LimitError(strings.missingSwitch(flag));
  if (!/^[0-9]+$/.test(raw)) throw new LimitError(strings.invalidLimit(flag, raw));
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new LimitError(strings.invalidLimit(flag, raw));
  return value;
}

export function parseRunType(raw: string | undefined): RunType {
  if (raw === undefined || raw === "") throw new LimitError(strings.missingSwitch("run-type"));
  if (!RUN_TYPES.includes(raw as RunType)) throw new LimitError(strings.invalidRunType(raw));
  return raw as RunType;
}

/**
 * Parse the required switches. No built-in defaults exist: missing, non-finite,
 * or non-positive values all refuse the run. `--limits-source` records where the
 * final values came from (manifest provenance, compass.md rule 5).
 */
const LIMIT_SOURCES = ["compass-table", "agent-suggestion", "user-override"] as const;

export function parseLimits(args: Record<string, string | string[]>): Limits {
  const str = (key: string): string | undefined => {
    const v = args[key];
    return typeof v === "string" ? v : undefined;
  };
  const sourceRaw = str("limits-source");
  if (!sourceRaw) throw new LimitError(strings.missingSwitch("limits-source"));
  if (!(LIMIT_SOURCES as readonly string[]).includes(sourceRaw)) {
    throw new LimitError(strings.invalidLimitSource(sourceRaw));
  }
  return {
    runType: parseRunType(str("run-type")),
    maxModelRequests: parsePositiveInt(str("max-model-requests"), "max-model-requests"),
    maxRunMs: parsePositiveInt(str("max-run-ms"), "max-run-ms"),
    source: sourceRaw as Limits["source"],
  };
}
