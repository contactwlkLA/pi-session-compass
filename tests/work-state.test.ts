// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXTRACTION_PROMPT } from "../src/prompts.js";
import {
  loadLatestSnapshot,
  SnapshotCorruptError,
  type SnapshotState,
  SnapshotUnsupportedError,
  writeSnapshot,
} from "../src/snapshot-store.js";
import type { PendingCandidate } from "../src/types.js";
import { EXTRACTION_POLICY_REVISION, loadWorkState, saveWorkState, selectPendingForBuild } from "../src/work-state.js";

let portraitDir: string;

function checkpointsFile(): string {
  return path.join(portraitDir, "processed-sessions.json");
}

function snapshotsDir(): string {
  return path.join(portraitDir, "snapshots");
}

/** Recursive listing of portraitDir, relative paths, directories included, sorted. */
function tree(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push(rel);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    }
  };
  walk(portraitDir, "");
  return out;
}

function seedCheckpoints(): Record<string, { lastByte: number; boundaryDigest: string; sessionId: string }> {
  return { "/sessions/a.jsonl": { lastByte: 42, boundaryDigest: "d", sessionId: "s" } };
}

function needsBuildCandidate(): PendingCandidate {
  return {
    candidateId: "abc123:0",
    trioId: "abc123",
    sourcePath: "/sessions/a.jsonl",
    cwd: "/work",
    sessionId: "sess-1",
    entryIds: ["1", "2", "3"],
    policyRevision: EXTRACTION_POLICY_REVISION,
    text: "Always report X before Y.",
    stage: "needsBuild",
    reviewContext: null,
  };
}

function needsPostReviewCandidate(): PendingCandidate {
  return {
    candidateId: "abc123:1",
    trioId: "abc123",
    sourcePath: "/sessions/a.jsonl",
    cwd: null,
    sessionId: null,
    entryIds: [null, null, null],
    policyRevision: EXTRACTION_POLICY_REVISION,
    text: "Do Z when asked for W.",
    stage: "needsPostReview",
    reviewContext: { agentBefore: "before", userFeedback: "feedback", agentAfter: "after" },
  };
}

function stateWithCandidates(pendingCandidates: PendingCandidate[]): SnapshotState {
  return { scanPositions: seedCheckpoints(), pendingCandidates, publicationIntent: null };
}

describe("work state", () => {
  beforeEach(() => {
    portraitDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-state-"));
  });

  afterEach(() => {
    fs.rmSync(portraitDir, { recursive: true, force: true });
  });

  it("seeds scan positions from processed-sessions.json when no snapshot exists", () => {
    fs.writeFileSync(checkpointsFile(), JSON.stringify(seedCheckpoints(), null, 2), "utf-8");
    const state = loadWorkState(portraitDir);
    expect(state.scanPositions).toEqual(seedCheckpoints());
    expect(state.pendingCandidates).toEqual([]);
    expect(state.publicationIntent).toBeNull();
  });

  it("writes nothing when loading without a snapshot", () => {
    loadWorkState(portraitDir);
    expect(tree()).toEqual([]);
    fs.writeFileSync(checkpointsFile(), JSON.stringify(seedCheckpoints(), null, 2), "utf-8");
    const before = tree();
    loadWorkState(portraitDir);
    expect(tree()).toEqual(before);
  });

  it("returns the latest snapshot state and writes nothing when loading it", () => {
    fs.writeFileSync(checkpointsFile(), JSON.stringify(seedCheckpoints(), null, 2), "utf-8");
    saveWorkState(portraitDir, stateWithCandidates([needsBuildCandidate()]));
    const before = tree();
    const state = loadWorkState(portraitDir);
    expect(tree()).toEqual(before);
    expect(state).toEqual(stateWithCandidates([needsBuildCandidate()]));
    expect(state).toEqual(loadLatestSnapshot(portraitDir)?.state);
  });

  it("rejects a corrupt snapshot and leaves processed-sessions.json unchanged", () => {
    const dir = writeSnapshot(portraitDir, stateWithCandidates([]), []);
    fs.writeFileSync(checkpointsFile(), JSON.stringify(seedCheckpoints(), null, 2), "utf-8");
    const checkpointsBefore = fs.readFileSync(checkpointsFile(), "utf-8");
    fs.appendFileSync(path.join(dir, "state.json"), " ", "utf-8");
    expect(() => loadWorkState(portraitDir)).toThrow(SnapshotCorruptError);
    expect(fs.readFileSync(checkpointsFile(), "utf-8")).toBe(checkpointsBefore);
    expect(fs.existsSync(snapshotsDir())).toBe(true);
  });

  it("rejects an unsupported snapshot", () => {
    const dir = writeSnapshot(portraitDir, stateWithCandidates([]), []);
    fs.writeFileSync(checkpointsFile(), JSON.stringify(seedCheckpoints(), null, 2), "utf-8");
    const manifestPath = path.join(dir, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 2 }), "utf-8");
    expect(() => loadWorkState(portraitDir)).toThrow(SnapshotUnsupportedError);
    expect(fs.readFileSync(checkpointsFile(), "utf-8")).toBe(JSON.stringify(seedCheckpoints(), null, 2));
  });

  it("copies only the portrait and archive files that exist", () => {
    const portraitFile = path.join(portraitDir, "portrait.md");
    const droppedFile = path.join(portraitDir, "dropped.md");
    fs.writeFileSync(portraitFile, "# Portrait\n", "utf-8");
    fs.writeFileSync(droppedFile, "# Dropped\n", "utf-8");
    saveWorkState(portraitDir, stateWithCandidates([]));
    const loaded = loadLatestSnapshot(portraitDir);
    expect(Object.keys(loaded?.manifest.files ?? {}).sort()).toEqual([
      "files/0-portrait.md",
      "files/1-dropped.md",
      "state.json",
    ]);
    expect(loaded?.manifest.sources).toEqual({
      "files/0-portrait.md": portraitFile,
      "files/1-dropped.md": droppedFile,
    });
  });

  it("mirrors the saved scan positions to processed-sessions.json", () => {
    saveWorkState(portraitDir, stateWithCandidates([needsBuildCandidate()]));
    expect(JSON.parse(fs.readFileSync(checkpointsFile(), "utf-8"))).toEqual(seedCheckpoints());
  });

  it("round-trips pending candidates through save and load", () => {
    const pendingCandidates = [needsBuildCandidate(), needsPostReviewCandidate()];
    saveWorkState(portraitDir, stateWithCandidates(pendingCandidates));
    expect(loadWorkState(portraitDir).pendingCandidates).toEqual(pendingCandidates);
  });

  it("uses the extraction prompt digest prefix as the policy revision", () => {
    expect(EXTRACTION_POLICY_REVISION).toBe(createHash("sha256").update(EXTRACTION_PROMPT).digest("hex").slice(0, 12));
  });
});

describe("selectPendingForBuild", () => {
  it("returns the needsBuild candidates in stored order and skips the other stages", () => {
    const first = needsBuildCandidate();
    const second: PendingCandidate = { ...needsBuildCandidate(), candidateId: "abc123:2", text: "Second rule." };
    const state = stateWithCandidates([needsPostReviewCandidate(), first, second]);
    expect(selectPendingForBuild(state, null)).toEqual([first, second]);
  });

  it("returns only the selected source's candidates when a filter path is given", () => {
    const first = needsBuildCandidate();
    const other: PendingCandidate = {
      ...needsBuildCandidate(),
      candidateId: "abc123:2",
      sourcePath: "/sessions/b.jsonl",
      text: "Other source rule.",
    };
    const state = stateWithCandidates([first, needsPostReviewCandidate(), other]);
    expect(selectPendingForBuild(state, "/sessions/a.jsonl")).toEqual([first]);
    expect(selectPendingForBuild(state, "/sessions/./a.jsonl")).toEqual([first]);
    expect(selectPendingForBuild(state, "/sessions/b.jsonl")).toEqual([other]);
    expect(selectPendingForBuild(state, null)).toEqual([first, other]);
  });
});
