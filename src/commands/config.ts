// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * /portrait:config: every setting with its value and where it came from, the
 * fixed gate and collection values, and the environment variables the plugin
 * reads. An unreadable settings file reports every source as `default` instead
 * of throwing; the gate key's value is never shown, only whether it is set.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getPortraitDir, getSessionDirs } from "../config.js";
import { GATE_CONFIG } from "../gate-config.js";
import { PLUGIN_CONFIG } from "../plugin-config.js";
import { PORTRAIT_SCHEMA } from "../schema.js";
import { getPortraitSettings } from "../settings-ui.js";

/**
 * The raw keys stored in the settings file, or null when the file is missing,
 * unreadable, or not a plain object (arrays count as not plain).
 */
function rawSettingIds(settingsFilePath: string): object | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsFilePath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** `env` when the variable holds a non-empty string, otherwise `default`. */
function envSource(name: string): string {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? "env" : "default";
}

/**
 * The full configuration text: header and rule, one line per setting in schema
 * order, then the fixed gate values, the fixed collection values, and the
 * environment. `settingsFilePath` is the raw file the sources are read from;
 * its content never changes the values shown, only their labels.
 */
export function getConfig(settingsFilePath: string): string {
  const settings = getPortraitSettings();
  const stored = rawSettingIds(settingsFilePath);

  const lines: string[] = [
    "👤 Portrait Configuration",
    "──────────────────────",
    `Settings (/portrait:settings, ${settingsFilePath}):`,
  ];
  for (const setting of PORTRAIT_SCHEMA.settings) {
    const value = (settings as unknown as Record<string, unknown>)[setting.id];
    const source = stored !== null && Object.hasOwn(stored, setting.id) ? "settings file" : "default";
    lines.push(`  ${setting.id}: ${JSON.stringify(value)} · ${source}`);
  }

  lines.push(
    "Jev gate (fixed):",
    `  Model: ${GATE_CONFIG.model}`,
    `  Endpoint: ${GATE_CONFIG.endpoint}`,
    `  Threshold: ${GATE_CONFIG.threshold} (${GATE_CONFIG.routeQuestions.join(", ")})`,
    `  Deadline: ${GATE_CONFIG.deadlineMs} ms · retry wait ${GATE_CONFIG.defaultRetryWaitMs} ms · failure limit ${GATE_CONFIG.failureLimit}`,
    `  State cap: ${GATE_CONFIG.stateCapBytes} bytes`,
    "Collection (fixed):",
    `  Files per scan: ${PLUGIN_CONFIG.filesPerScan}`,
    `  Lock poll: ${PLUGIN_CONFIG.lockPollMs} ms`,
    `  Retry backoff: ${PLUGIN_CONFIG.retryBackoffBaseMs} ms doubling, capped at ${PLUGIN_CONFIG.retryBackoffCapMs} ms`,
    `  Footer refresh: ${PLUGIN_CONFIG.footerRefreshMs} ms`,
    "Environment:",
    `  PI_PORTRAIT_STATE_DIR: ${getPortraitDir()} · ${envSource("PI_PORTRAIT_STATE_DIR")}`,
    `  PI_PORTRAIT_SESSION_DIRS: ${getSessionDirs().join(path.delimiter)} · ${envSource("PI_PORTRAIT_SESSION_DIRS")}`,
    `  TYPESAFE_API_KEY: ${
      typeof process.env.TYPESAFE_API_KEY === "string" && process.env.TYPESAFE_API_KEY.length > 0 ? "set" : "not set"
    }`,
  );
  return lines.join("\n");
}
