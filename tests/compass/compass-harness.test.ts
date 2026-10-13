// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Stage 1, T2.6 — file scope, unchanged `all` default, zero matches, invalid
 * targets, census/counter agreement, repeatable snapshots, isolated writes.
 * Offline only; no model calls, no writes outside the workspace test tmp dir.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { censusFile, countTriosOnly } from "../../scripts/compass/census.js";
import { buildManifestData, freezeManifest } from "../../scripts/compass/manifest.js";
import {
  freezeSelection,
  parseScope,
  SelectionError,
  validateSessionFile,
  writeSelection,
} from "../../scripts/compass/selection.js";
import { hashTree, snapshotPortraitState, treeDigest } from "../../scripts/compass/snapshot.js";
import { sha256File } from "../../scripts/compass/util.js";

const ROOT = process.cwd();
const TEST_TMP = path.join(ROOT, "outputs", "test-tmp", "compass-harness");
const LIVE_PORTRAIT_DIR = path.join(os.homedir(), ".pi", "portrait");

interface SessionMessage {
  type: string;
  message: { role: string; content: unknown; timestamp: number; toolName?: string };
}

/** Minimal session entry writer for synthetic fixtures. */
function writeSession(filePath: string, turns: Array<{ role: string; text: string } | { raw: string }>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines: string[] = [];
  let ts = 1;
  for (const turn of turns) {
    if ("raw" in turn) {
      lines.push(turn.raw);
      continue;
    }
    const message: SessionMessage = {
      type: "message",
      message: {
        role: turn.role,
        content: turn.role === "assistant" ? [{ type: "text", text: turn.text }] : turn.text,
        timestamp: ts++,
      },
    };
    lines.push(JSON.stringify(message));
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
}

beforeEach(() => {
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
  fs.mkdirSync(TEST_TMP, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
});

describe("selection", () => {
  it("file scope freezes the copy with matching hashes and isolates exactly one file", () => {
    const source = path.join(TEST_TMP, "sessions", "three-trios.jsonl");
    writeSession(source, [
      { role: "assistant", text: "A1" },
      { role: "user", text: "fix that" },
      { role: "assistant", text: "A2" },
      { role: "assistant", text: "A3" },
      { role: "user", text: "no, do this" },
      { role: "assistant", text: "A4" },
      { role: "assistant", text: "A5" },
      { role: "user", text: "wrong again" },
      { role: "assistant", text: "A6" },
    ]);
    const outputDir = path.join(TEST_TMP, "outputs", "run-file");
    const fixturesDir = path.join(TEST_TMP, "fixtures");

    const selection = freezeSelection({ scope: "file", sourcePath: source, runId: "t1", outputDir, fixturesDir });
    expect(selection.scope).toBe("file");
    expect(selection.frozen).toBeDefined();
    expect(selection.frozen?.sha256).toBe(sha256File(source));
    expect(selection.frozen?.sizeBytes).toBe(fs.statSync(source).size);
    expect(sha256File(selection.frozen?.storedPath ?? "")).toBe(selection.frozen?.sha256);

    const isolated = selection.isolatedSessionDir ?? "";
    const files = fs.readdirSync(isolated).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    expect(sha256File(path.join(isolated, files[0]))).toBe(selection.frozen?.sha256);

    const selectionPath = writeSelection(outputDir, selection);
    expect(JSON.parse(fs.readFileSync(selectionPath, "utf-8")).scope).toBe("file");
  });

  it("all is the unchanged default scope with no frozen file", () => {
    expect(parseScope(undefined)).toBe("all");
    const outputDir = path.join(TEST_TMP, "outputs", "run-all");
    const selection = freezeSelection({ scope: "all", runId: "t1", outputDir });
    expect(selection.frozen).toBeUndefined();
    expect(selection.isolatedSessionDir).toBeUndefined();
    expect(fs.existsSync(path.join(outputDir, "sessions"))).toBe(false);
  });

  it.each([
    ["missing file", path.join(TEST_TMP, "nope.jsonl")],
    ["non-jsonl", __filename],
    ["empty file", path.join(TEST_TMP, "empty.jsonl")],
    ["directory", TEST_TMP],
  ])("invalid targets refuse without widening scope: %s", (_label, target) => {
    if (_label === "empty file") fs.writeFileSync(target, "", "utf-8");
    const outputDir = path.join(TEST_TMP, "outputs", "run-invalid");
    expect(() => freezeSelection({ scope: "file", sourcePath: target, runId: "t1", outputDir })).toThrow(
      SelectionError,
    );
    // Nothing was staged for the pipeline: no isolated dir, no partial selection.
    expect(fs.existsSync(path.join(outputDir, "sessions"))).toBe(false);
  });

  it("file scope without --session refuses", () => {
    const outputDir = path.join(TEST_TMP, "outputs", "run-nosession");
    expect(() => freezeSelection({ scope: "file", runId: "t1", outputDir })).toThrow(SelectionError);
  });

  it("validateSessionFile accepts a valid session file", () => {
    const source = path.join(TEST_TMP, "sessions", "ok.jsonl");
    writeSession(source, [{ role: "assistant", text: "hi" }]);
    expect(() => validateSessionFile(source)).not.toThrow();
  });
});

describe("census", () => {
  it("enumerates trios with ordered 1-based line references", async () => {
    const source = path.join(TEST_TMP, "sessions", "refs.jsonl");
    writeSession(source, [
      { raw: '{"type":"session_meta","cwd":"/tmp"}' },
      { role: "assistant", text: "A1" }, // line 2
      { role: "user", text: "fix that" }, // line 3
      { role: "assistant", text: "A2" }, // line 4 -> trio 1
      { role: "assistant", text: "A3" }, // line 5
      { role: "user", text: "yes" }, // line 6 (approval)
      { role: "assistant", text: "A4" }, // line 7 -> no trio
      { role: "user", text: "wrong again" }, // line 8
      { role: "assistant", text: "A5" }, // line 9 -> trio 2 (A4, line 8, line 9)
    ]);
    const census = await censusFile(source);
    expect(census.totalTrios).toBe(2);
    expect(census.nonEmptyLines).toBe(9);
    const [first, second] = census.trios;
    expect(first).toMatchObject({ trioIndex: 1, agentBeforeLine: 2, userFeedbackLine: 3, agentAfterLine: 4 });
    expect(second).toMatchObject({ trioIndex: 2, agentBeforeLine: 7, userFeedbackLine: 8, agentAfterLine: 9 });
  });

  it("zero matches is a valid result, not an error", async () => {
    const source = path.join(TEST_TMP, "sessions", "none.jsonl");
    writeSession(source, [
      { role: "assistant", text: "only me" },
      { role: "assistant", text: "still me" },
    ]);
    const census = await censusFile(source);
    expect(census.totalTrios).toBe(0);
    expect(census.trios).toEqual([]);
  });

  it("census count agrees with an independent detector pass", async () => {
    const source = path.join(TEST_TMP, "sessions", "agree.jsonl");
    writeSession(source, [
      { role: "assistant", text: "A1" },
      { role: "user", text: "u1" },
      { role: "assistant", text: "A2" },
      { raw: "not json at all" },
      { role: "user", text: "u2" },
      { role: "assistant", text: "A3" },
      { role: "user", text: "continue" }, // continuation — never a trio
      { role: "assistant", text: "A4" },
    ]);
    const [census, plain] = await Promise.all([censusFile(source), countTriosOnly(source)]);
    expect(census.totalTrios).toBe(plain);
    expect(census.totalTrios).toBe(2);
  });
});

describe("snapshots and manifests", () => {
  it("repeatable snapshots produce identical hashes", () => {
    const a = path.join(TEST_TMP, "snap-a");
    const b = path.join(TEST_TMP, "snap-b");
    const first = snapshotPortraitState(LIVE_PORTRAIT_DIR, a);
    const second = snapshotPortraitState(LIVE_PORTRAIT_DIR, b);
    expect(second.hashes).toEqual(first.hashes);
    expect(JSON.parse(fs.readFileSync(path.join(b, "hashes.json"), "utf-8"))).toEqual(first.hashes);
    for (const name of Object.keys(first.hashes).filter((k) => !k.startsWith(".git"))) {
      expect(fs.existsSync(path.join(a, name))).toBe(true);
    }
  });

  it("prepare-equivalent work leaves the live portrait untouched", () => {
    const before = treeDigest(hashTree(LIVE_PORTRAIT_DIR));
    const source = path.join(TEST_TMP, "sessions", "iso.jsonl");
    writeSession(source, [
      { role: "assistant", text: "A1" },
      { role: "user", text: "u1" },
      { role: "assistant", text: "A2" },
    ]);
    const outputDir = path.join(TEST_TMP, "outputs", "run-iso");
    const fixturesDir = path.join(TEST_TMP, "fixtures");
    const selection = freezeSelection({ scope: "file", sourcePath: source, runId: "iso", outputDir, fixturesDir });
    snapshotPortraitState(LIVE_PORTRAIT_DIR, path.join(fixturesDir, "snapshots", "iso"));
    writeSelection(outputDir, selection);
    freezeManifest(
      outputDir,
      buildManifestData({
        runType: "smoke",
        suggested: null,
        finalLimits: { runType: "smoke", maxModelRequests: 5, maxRunMs: 900_000, source: "compass-table" },
        selection,
        census: null,
        settingsSnapshotPath: path.join(outputDir, "settings-snapshot.json"),
        workspaceRoot: ROOT,
        confirmed: null,
      }),
    );
    expect(treeDigest(hashTree(LIVE_PORTRAIT_DIR))).toBe(before);
  });
});
