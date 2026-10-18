// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * /portrait:status additions: the gate-log line count behind the gate mode, the
 * pending-candidate count from the snapshot (or an unreadable marker instead of
 * a throw), and both lines at their stated positions. Also pins the builder
 * prompt after the two approved-marker removals: no comment markers remain and
 * both edited lines end where they should.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getStatus } from "../src/commands/status.js";
import { GATE_LOG_FILE } from "../src/gate-log.js";
import { BUILDING_PROMPT } from "../src/prompts.js";
import type { SnapshotState } from "../src/snapshot-store.js";
import type { PendingCandidate } from "../src/types.js";
import { saveWorkState } from "../src/work-state.js";
import { setupTestSettings, teardownTestSettings } from "./settings-helpers.js";
import { setTestConfig } from "./setup.js";

let portraitDir: string;

beforeEach(() => {
  portraitDir = fs.mkdtempSync(path.join(os.tmpdir(), "status-test-"));
  setTestConfig({ portraitDir });
});

afterEach(() => {
  teardownTestSettings();
  fs.rmSync(portraitDir, { recursive: true, force: true });
});

/** The line following the first line with the given prefix, or undefined. */
function lineAfter(lines: string[], prefix: string): string | undefined {
  const index = lines.findIndex((line) => line.startsWith(prefix));
  return index === -1 ? undefined : lines[index + 1];
}

function statusLines(): string[] {
  return getStatus().split("\n");
}

function pendingCandidate(trioId: string): PendingCandidate {
  return {
    candidateId: `${trioId}:0`,
    trioId,
    sourcePath: path.join(portraitDir, "sessions", "seed.jsonl"),
    cwd: null,
    sessionId: null,
    entryIds: [null, null, null],
    policyRevision: "abc123def456",
    text: "Always confirm the target before deleting.",
    stage: "needsBuild",
    reviewContext: null,
  };
}

describe("getStatus gate log line", () => {
  it("reports the default mode and zero checks with no gate log", () => {
    setupTestSettings(null);

    const lines = statusLines();

    expect(lineAfter(lines, "State:")).toBe("Gate: off · 0 checks logged");
    expect(lineAfter(lines, "  Rule limit:")).toBe("  Pending candidates: 0");
  });

  it("counts a three-line gate log under the shadow mode", () => {
    setupTestSettings({ gateMode: "shadow" });
    fs.writeFileSync(path.join(portraitDir, GATE_LOG_FILE), '{"a":1}\n{"a":2}\n{"a":3}\n', "utf-8");

    const lines = statusLines();

    expect(lineAfter(lines, "State:")).toBe("Gate: shadow · 3 checks logged");
  });

  it("reports a directory at the gate-log path as zero checks without throwing", () => {
    setupTestSettings(null);
    fs.mkdirSync(path.join(portraitDir, GATE_LOG_FILE), { recursive: true });

    expect(() => getStatus()).not.toThrow();
    expect(lineAfter(statusLines(), "State:")).toBe("Gate: off · 0 checks logged");
  });
});

describe("getStatus pending candidates line", () => {
  it("counts the candidates saved in the snapshot", () => {
    setupTestSettings(null);
    const state: SnapshotState = {
      scanPositions: {},
      pendingCandidates: [pendingCandidate("trio-a"), pendingCandidate("trio-b")],
      publicationIntent: null,
    };
    saveWorkState(portraitDir, state);

    const lines = statusLines();

    expect(lineAfter(lines, "  Rule limit:")).toBe("  Pending candidates: 2");
  });

  it("reports an unreadable snapshot as unknown without throwing", () => {
    setupTestSettings(null);
    // CURRENT names a snapshot that does not exist — loadWorkState throws.
    const snapshots = path.join(portraitDir, "snapshots");
    fs.mkdirSync(snapshots, { recursive: true });
    fs.writeFileSync(path.join(snapshots, "CURRENT"), "missing-snapshot\n", "utf-8");

    expect(() => getStatus()).not.toThrow();
    expect(lineAfter(statusLines(), "  Rule limit:")).toBe("  Pending candidates: unknown (snapshot unreadable)");
  });
});

describe("BUILDING_PROMPT after the approved-marker removals", () => {
  it("carries no comment markers and keeps both edited lines intact", () => {
    expect(BUILDING_PROMPT).not.toContain("<!--");
    expect(BUILDING_PROMPT).toContain(
      "Positions are stable — inserting candidates does not renumber existing entries.\n",
    );
    expect(BUILDING_PROMPT).toContain('"evictPositions": [12, 15] },\n');
  });
});
