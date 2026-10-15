// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadLatestSnapshot,
  SNAPSHOT_SCHEMA_VERSION,
  SnapshotCorruptError,
  type SnapshotState,
  SnapshotUnsupportedError,
  writeSnapshot,
} from "../src/snapshot-store.js";

let portraitDir: string;
let portraitFile: string;
let archiveFile: string;

const NO_FILES: string[] = [];

function stateWith(lastByte: number): SnapshotState {
  return {
    scanPositions: { "/sessions/a.jsonl": { lastByte, boundaryDigest: "d", sessionId: "s" } },
    pendingCandidates: [],
    publicationIntent: null,
  };
}

function snapshotsDir(): string {
  return path.join(portraitDir, "snapshots");
}

function corruptMessage(dir: string, reason: string): string {
  return `Portrait snapshot ${dir} is corrupt (${reason}); processing stopped. Progress was not reset.`;
}

describe("snapshot store", () => {
  beforeEach(() => {
    portraitDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-store-"));
    portraitFile = path.join(portraitDir, "portrait.md");
    archiveFile = path.join(portraitDir, "archive.md");
    fs.writeFileSync(portraitFile, "# Portrait\n- rule one\n", "utf-8");
    fs.writeFileSync(archiveFile, "# Archive\n", "utf-8");
  });

  afterEach(() => {
    fs.rmSync(portraitDir, { recursive: true, force: true });
  });

  it("returns null when no snapshots directory exists", () => {
    expect(loadLatestSnapshot(portraitDir)).toBeNull();
  });

  it("round-trips state and file copies", () => {
    const dir = writeSnapshot(portraitDir, stateWith(42), [portraitFile, archiveFile]);
    const loaded = loadLatestSnapshot(portraitDir);
    expect(loaded?.dir).toBe(dir);
    expect(loaded?.state).toEqual(stateWith(42));
    expect(loaded?.manifest.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(Object.keys(loaded?.manifest.files ?? {}).sort()).toEqual([
      "files/0-portrait.md",
      "files/1-archive.md",
      "state.json",
    ]);
    expect(loaded?.manifest.sources["files/0-portrait.md"]).toBe(portraitFile);
    expect(fs.readFileSync(path.join(dir, "files/0-portrait.md"), "utf-8")).toBe("# Portrait\n- rule one\n");
  });

  it("keeps the previous snapshot and removes older ones", () => {
    const first = writeSnapshot(portraitDir, stateWith(1), NO_FILES);
    const second = writeSnapshot(portraitDir, stateWith(2), NO_FILES);
    expect(fs.existsSync(first)).toBe(true);
    const third = writeSnapshot(portraitDir, stateWith(3), NO_FILES);
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.existsSync(second)).toBe(true);
    expect(loadLatestSnapshot(portraitDir)?.dir).toBe(third);
    expect(loadLatestSnapshot(portraitDir)?.state).toEqual(stateWith(3));
  });

  it("keeps the previous snapshot active when a write is interrupted", () => {
    const first = writeSnapshot(portraitDir, stateWith(1), [portraitFile]);
    // An interrupted write: a half-written temporary directory, CURRENT untouched.
    const leftover = path.join(snapshotsDir(), "snap-000002.tmp");
    fs.mkdirSync(path.join(leftover, "files"), { recursive: true });
    fs.writeFileSync(path.join(leftover, "state.json"), "{ half", "utf-8");

    const loaded = loadLatestSnapshot(portraitDir);
    expect(loaded?.dir).toBe(first);
    expect(loaded?.state).toEqual(stateWith(1));

    const next = writeSnapshot(portraitDir, stateWith(2), NO_FILES);
    expect(path.basename(next)).toBe("snap-000002");
    expect(fs.existsSync(leftover)).toBe(false);
  });

  it("returns null when only an interrupted first write exists", () => {
    fs.mkdirSync(path.join(snapshotsDir(), "snap-000001.tmp"), { recursive: true });
    expect(loadLatestSnapshot(portraitDir)).toBeNull();
  });

  it("throws on a file whose digest no longer matches", () => {
    const dir = writeSnapshot(portraitDir, stateWith(1), [portraitFile]);
    fs.appendFileSync(path.join(dir, "files/0-portrait.md"), "- tampered\n");
    expect(() => loadLatestSnapshot(portraitDir)).toThrow(SnapshotCorruptError);
    expect(() => loadLatestSnapshot(portraitDir)).toThrow(
      corruptMessage(dir, "checksum mismatch in files/0-portrait.md"),
    );
  });

  it("throws on an altered state.json", () => {
    const dir = writeSnapshot(portraitDir, stateWith(1), NO_FILES);
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(stateWith(999)), "utf-8");
    expect(() => loadLatestSnapshot(portraitDir)).toThrow(corruptMessage(dir, "checksum mismatch in state.json"));
  });

  it("throws on a manifest that is not valid JSON", () => {
    const dir = writeSnapshot(portraitDir, stateWith(1), NO_FILES);
    fs.writeFileSync(path.join(dir, "manifest.json"), "{ not json", "utf-8");
    expect(() => loadLatestSnapshot(portraitDir)).toThrow(corruptMessage(dir, "manifest.json is not valid JSON"));
  });

  it("throws when CURRENT names a missing snapshot", () => {
    const dir = writeSnapshot(portraitDir, stateWith(1), NO_FILES);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(() => loadLatestSnapshot(portraitDir)).toThrow(
      corruptMessage(dir, "the active snapshot is missing or unreadable"),
    );
  });

  it("throws when CURRENT is missing but complete snapshots exist", () => {
    writeSnapshot(portraitDir, stateWith(1), NO_FILES);
    fs.rmSync(path.join(snapshotsDir(), "CURRENT"));
    expect(() => loadLatestSnapshot(portraitDir)).toThrow(
      corruptMessage(snapshotsDir(), "the active snapshot is missing or unreadable"),
    );
  });

  it("throws on an unsupported schema version", () => {
    const dir = writeSnapshot(portraitDir, stateWith(1), NO_FILES);
    const manifestPath = path.join(dir, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 2 }), "utf-8");
    expect(() => loadLatestSnapshot(portraitDir)).toThrow(SnapshotUnsupportedError);
    expect(() => loadLatestSnapshot(portraitDir)).toThrow(
      `Portrait snapshot ${dir} has unsupported schema version 2; processing stopped. Progress was not reset.`,
    );
  });
});
