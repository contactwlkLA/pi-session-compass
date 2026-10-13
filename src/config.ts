// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as os from "node:os";
import * as path from "node:path";

/** Overrides the state directory when PI_PORTRAIT_STATE_DIR is set. */
const STATE_DIR = process.env.PI_PORTRAIT_STATE_DIR || path.join(os.homedir(), ".pi", "portrait");

export function getPortraitDir(): string {
  return STATE_DIR;
}

export function getLockPath(): string {
  return path.join(STATE_DIR, "instance.lock.sqlite");
}

export function getCollectLockPath(): string {
  return path.join(STATE_DIR, "collect.lock.sqlite");
}

export function getSessionDirs(): string[] {
  const override = process.env.PI_PORTRAIT_SESSION_DIRS;
  if (override) {
    return override.split(path.delimiter).filter(Boolean);
  }
  return [path.join(os.homedir(), ".pi", "agent", "sessions")];
}

export function getBgScanCheckpointsPath(): string {
  return path.join(STATE_DIR, "bg-scan-checkpoints.json");
}
