// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * execute --start-snapshot <dir>: a frozen snapshot is verified
 * against its recorded hashes.json (including .git/HEAD), restored instead of
 * the live portrait, and refused with exit code 2 before confirmation or any
 * model request; the manifest records the starting portrait's provenance.
 * Offline only; all temp state lives under outputs/test-tmp/.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderConfirmation } from "../../scripts/compass/confirmation.js";
import { buildManifestData } from "../../scripts/compass/manifest.js";
import { executeRun, prepareRun } from "../../scripts/compass/run.js";
import {
  hashTree,
  restoreSnapshot,
  SnapshotError,
  snapshotPortraitState,
  treeDigest,
  verifySnapshot,
} from "../../scripts/compass/snapshot.js";
import { strings } from "../../scripts/compass/strings.js";
import type { Limits } from "../../scripts/compass/types.js";

const ROOT = process.cwd();
const TEST_TMP = path.join(ROOT, "outputs", "test-tmp", "start-snapshot");

const LIMITS: Limits = { runType: "smoke", maxModelRequests: 5, maxRunMs: 900_000, source: "compass-table" };

/** Minimal synthetic portrait dir with two snapshot files. */
function makePortraitDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "portrait.md"), "# Portrait\n", "utf-8");
  fs.writeFileSync(path.join(dir, "portrait-state.json"), '{"seq":1}', "utf-8");
}

/** Make dir a git repo with one commit so snapshotPortraitState records .git/HEAD. */
function commitAll(dir: string): void {
  execSync("git init -q", { cwd: dir, stdio: "pipe" });
  execSync("git add -A", { cwd: dir, stdio: "pipe" });
  execSync("git -c user.email=test@example.com -c user.name=test commit -q -m init", { cwd: dir, stdio: "pipe" });
}

function expectSnapshotError(fn: () => void, expected: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SnapshotError);
  expect((caught as Error).message).toBe(expected);
}

/** A frozen synthetic snapshot dir plus its source portrait dir. */
function frozenSnapshot(name: string): { live: string; snap: string } {
  const live = path.join(TEST_TMP, `live-${name}`);
  makePortraitDir(live);
  const snap = path.join(TEST_TMP, `snap-${name}`);
  snapshotPortraitState(live, snap);
  return { live, snap };
}

beforeEach(() => {
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
  fs.mkdirSync(TEST_TMP, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
});

describe("verifySnapshot", () => {
  it("accepts an intact frozen snapshot and returns its recorded hashes", () => {
    const live = path.join(TEST_TMP, "live-git");
    makePortraitDir(live);
    commitAll(live);
    const snap = path.join(TEST_TMP, "snap-git");
    const { hashes } = snapshotPortraitState(live, snap);
    expect(hashes[".git/HEAD"]).toBeDefined();
    expect(verifySnapshot(snap)).toEqual(hashes);
  });

  it("refuses a tampered file with the approved mismatch string", () => {
    const { snap } = frozenSnapshot("tampered");
    fs.writeFileSync(path.join(snap, "portrait.md"), "# tampered\n", "utf-8");
    expectSnapshotError(() => verifySnapshot(snap), strings.startSnapshotMismatch("portrait.md", snap));
  });

  it("refuses a snapshot whose .git/HEAD no longer matches", () => {
    const live = path.join(TEST_TMP, "live-head");
    makePortraitDir(live);
    commitAll(live);
    const snap = path.join(TEST_TMP, "snap-head");
    snapshotPortraitState(live, snap);
    const hashesPath = path.join(snap, "hashes.json");
    const hashes = JSON.parse(fs.readFileSync(hashesPath, "utf-8")) as Record<string, string>;
    hashes[".git/HEAD"] = "0".repeat(40);
    fs.writeFileSync(hashesPath, JSON.stringify(hashes, null, 2), "utf-8");
    expectSnapshotError(() => verifySnapshot(snap), strings.startSnapshotMismatch(".git/HEAD", snap));
  });

  it("refuses a missing hashes.json", () => {
    const snap = path.join(TEST_TMP, "no-hashes");
    fs.mkdirSync(snap, { recursive: true });
    expectSnapshotError(() => verifySnapshot(snap), strings.startSnapshotNoHashes(snap));
  });

  it("refuses a missing snapshot directory", () => {
    const snap = path.join(TEST_TMP, "absent");
    expectSnapshotError(() => verifySnapshot(snap), strings.startSnapshotNotFound(snap));
  });
});

describe("snapshots/ directory in a frozen snapshot", () => {
  it("copies snapshots/ with nested files and restores the same tree", () => {
    const live = path.join(TEST_TMP, "live-work");
    makePortraitDir(live);
    fs.mkdirSync(path.join(live, "snapshots", "nested"), { recursive: true });
    fs.writeFileSync(path.join(live, "snapshots", "state.json"), '{"seq":2}', "utf-8");
    fs.writeFileSync(path.join(live, "snapshots", "nested", "file.md"), "nested\n", "utf-8");
    const snap = path.join(TEST_TMP, "snap-work");
    const { hashes } = snapshotPortraitState(live, snap);
    expect(hashes["snapshots/state.json"]).toBeDefined();
    expect(hashes["snapshots/nested/file.md"]).toBeDefined();
    expect(verifySnapshot(snap)).toEqual(hashes);

    const restored = path.join(TEST_TMP, "restored-work");
    restoreSnapshot(snap, restored);
    // The restored set (snapshot files, git, snapshots/) equals the source's.
    expect(hashTree(restored)).toEqual(hashTree(live));
  });

  it("refuses a tampered snapshots file with the approved mismatch string", () => {
    const live = path.join(TEST_TMP, "live-work-tamper");
    makePortraitDir(live);
    fs.mkdirSync(path.join(live, "snapshots"), { recursive: true });
    fs.writeFileSync(path.join(live, "snapshots", "state.json"), '{"seq":2}', "utf-8");
    const snap = path.join(TEST_TMP, "snap-work-tamper");
    snapshotPortraitState(live, snap);
    fs.writeFileSync(path.join(snap, "snapshots", "state.json"), '{"seq":99}', "utf-8");
    expectSnapshotError(() => verifySnapshot(snap), strings.startSnapshotMismatch("snapshots/state.json", snap));
  });

  it("records no snapshot keys when the source has no snapshots directory", () => {
    const { snap } = frozenSnapshot("no-work");
    const hashes = JSON.parse(fs.readFileSync(path.join(snap, "hashes.json"), "utf-8")) as Record<string, string>;
    expect(Object.keys(hashes).some((key) => key.startsWith("snapshots/"))).toBe(false);
  });
});

describe("prepareRun with --start-snapshot", () => {
  it("restores from the snapshot, records source snapshot, and skips the live snapshot", async () => {
    const live = path.join(TEST_TMP, "live-restore");
    makePortraitDir(live);
    const snap = path.join(TEST_TMP, "snap-restore");
    snapshotPortraitState(live, snap);
    const workspace = path.join(TEST_TMP, "ws-snapshot");
    const outputDir = path.join(TEST_TMP, "run-snapshot");
    fs.mkdirSync(workspace, { recursive: true });

    const result = await prepareRun({
      scope: "all",
      outputDir,
      runId: "run-snapshot",
      workspaceRoot: workspace,
      limits: LIMITS,
      suggested: null,
      startSnapshotDir: snap,
    });

    expect(result.startPortrait.source).toBe("snapshot");
    expect(result.startPortrait.dir).toBe(snap);
    expect(result.startPortrait.digest).toBe(treeDigest(verifySnapshot(snap)));
    expect(fs.readFileSync(path.join(outputDir, "portrait", "portrait.md"), "utf-8")).toBe("# Portrait\n");
    expect(fs.existsSync(path.join(workspace, "fixtures", "snapshots", "run-snapshot"))).toBe(false);
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf-8")) as { startPortrait: unknown };
    expect(manifest.startPortrait).toEqual(result.startPortrait);
  });

  it("without the switch snapshots live and records source live", async () => {
    const workspace = path.join(TEST_TMP, "ws-live");
    const outputDir = path.join(TEST_TMP, "run-live");
    fs.mkdirSync(workspace, { recursive: true });

    const result = await prepareRun({
      scope: "all",
      outputDir,
      runId: "run-live",
      workspaceRoot: workspace,
      limits: LIMITS,
      suggested: null,
    });

    expect(result.startPortrait.source).toBe("live");
    expect(result.startPortrait.dir).toBe(path.join(workspace, "fixtures", "snapshots", "run-live"));
    expect(fs.existsSync(path.join(result.startPortrait.dir, "hashes.json"))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf-8")) as { startPortrait: { source: string } };
    expect(manifest.startPortrait.source).toBe("live");
  });

  it("refuses a tampered snapshot before the run starts", async () => {
    const { snap } = frozenSnapshot("refuse-prep");
    fs.writeFileSync(path.join(snap, "portrait.md"), "# tampered\n", "utf-8");
    const workspace = path.join(TEST_TMP, "ws-refuse-prep");
    const outputDir = path.join(TEST_TMP, "run-refuse-prep");
    fs.mkdirSync(workspace, { recursive: true });

    await expect(
      prepareRun({
        scope: "all",
        outputDir,
        runId: "run-refuse-prep",
        workspaceRoot: workspace,
        limits: LIMITS,
        suggested: null,
        startSnapshotDir: snap,
      }),
    ).rejects.toBeInstanceOf(SnapshotError);
  });
});

describe("executeRun --start-snapshot refusals", () => {
  function baseArgs(snap: string, outputDir: string): Record<string, string | string[]> {
    return {
      _: ["execute"],
      "run-type": "smoke",
      "max-model-requests": "5",
      "max-run-ms": "900000",
      "limits-source": "compass-table",
      scope: "all",
      "start-snapshot": snap,
      output: outputDir,
      "run-id": "run-refuse",
    };
  }

  async function refusal(args: Record<string, string | string[]>): Promise<{ code: number; printed: string }> {
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const code = await executeRun(args, { confirmed: true });
      return { code, printed: writeSpy.mock.calls.map((call) => String(call[0])).join("") };
    } finally {
      writeSpy.mockRestore();
    }
  }

  it("refuses a tampered snapshot with exit code 2 and the exact approved string", async () => {
    const { snap } = frozenSnapshot("refuse-exec");
    fs.writeFileSync(path.join(snap, "portrait.md"), "# tampered\n", "utf-8");

    const { code, printed } = await refusal(baseArgs(snap, path.join(TEST_TMP, "run-refuse-1")));
    expect(code).toBe(2);
    expect(printed).toBe(`${strings.startSnapshotMismatch("portrait.md", snap)}\n`);
  });

  it("refuses a snapshot without hashes.json with the exact approved string", async () => {
    const snap = path.join(TEST_TMP, "no-hashes-exec");
    fs.mkdirSync(snap, { recursive: true });

    const { code, printed } = await refusal(baseArgs(snap, path.join(TEST_TMP, "run-refuse-2")));
    expect(code).toBe(2);
    expect(printed).toBe(`${strings.startSnapshotNoHashes(snap)}\n`);
  });

  it("refuses a missing snapshot directory with the exact approved string", async () => {
    const snap = path.join(TEST_TMP, "absent-exec");

    const { code, printed } = await refusal(baseArgs(snap, path.join(TEST_TMP, "run-refuse-3")));
    expect(code).toBe(2);
    expect(printed).toBe(`${strings.startSnapshotNotFound(snap)}\n`);
  });
});

describe("confirmation block", () => {
  it("shows the frozen-snapshot line with the switch and the live line without it", () => {
    const common = {
      limits: LIMITS,
      scope: "all" as const,
      selectionLabel: "all",
      trioCount: 0,
      outputDir: "/tmp/out",
      model: "meta/test-model",
      thinking: "high",
    };
    const snapshotBlock = renderConfirmation({
      ...common,
      startPortrait: { source: "snapshot", dir: "/tmp/snapshot-dir", digest: "d" },
    });
    expect(snapshotBlock).toContain(strings.confirmStartSnapshot("/tmp/snapshot-dir"));
    const liveBlock = renderConfirmation({
      ...common,
      startPortrait: { source: "live", dir: "/tmp/live-dir", digest: "d" },
    });
    expect(liveBlock).toContain(strings.confirmStartLive("/tmp/live-dir"));
  });
});

describe("restoreSnapshot", () => {
  it("restores over an earlier attempt's portrait dir, read-only git objects and leftovers included", () => {
    const live = path.join(TEST_TMP, "live-again");
    makePortraitDir(live);
    commitAll(live);
    const snap = path.join(TEST_TMP, "snap-again");
    snapshotPortraitState(live, snap);
    const dest = path.join(TEST_TMP, "run-again", "portrait");

    restoreSnapshot(snap, dest);
    fs.writeFileSync(path.join(dest, "leftover.md"), "from an earlier attempt\n", "utf-8");
    fs.writeFileSync(path.join(dest, "portrait.md"), "# Changed\n", "utf-8");
    restoreSnapshot(snap, dest);

    expect(fs.existsSync(path.join(dest, "leftover.md"))).toBe(false);
    expect(fs.readFileSync(path.join(dest, "portrait.md"), "utf-8")).toBe("# Portrait\n");
    expect(execSync("git rev-parse HEAD", { cwd: dest, encoding: "utf-8" }).trim()).toBe(
      verifySnapshot(snap)[".git/HEAD"],
    );
  });
});

describe("manifest source identity", () => {
  it("is dirty for tracked changes only, not untracked files", () => {
    const workspace = path.join(TEST_TMP, "ws-dirty");
    makePortraitDir(workspace);
    commitAll(workspace);
    const manifestFor = () =>
      buildManifestData({
        runType: "smoke",
        suggested: null,
        finalLimits: LIMITS,
        selection: { scope: "all", runId: "t", outputDir: workspace, createdAt: new Date(0).toISOString() },
        census: null,
        settingsSnapshotPath: "",
        workspaceRoot: workspace,
        startPortrait: { source: "live", dir: workspace, digest: "d" },
        confirmed: null,
      });

    fs.writeFileSync(path.join(workspace, "scratch.txt"), "untracked\n", "utf-8");
    expect(manifestFor().sourceIdentity.dirty).toBe(false);
    fs.writeFileSync(path.join(workspace, "portrait.md"), "# Edited\n", "utf-8");
    expect(manifestFor().sourceIdentity.dirty).toBe(true);
  });
});
