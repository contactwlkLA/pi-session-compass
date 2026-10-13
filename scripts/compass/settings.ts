// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PORTRAIT_SETTINGS_FILE = path.join(os.homedir(), ".pi", "agent", "avtc-pi-portrait-settings.json");
const HOST_SETTINGS_FILE = path.join(os.homedir(), ".pi", "agent", "settings.json");

function redact(value: unknown, key = ""): unknown {
  if (/key|secret|token|password|credential/i.test(key) && typeof value === "string") return "[REDACTED]";
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

interface SchemaDefault {
  id: string;
  defaultValue: unknown;
}

/**
 * Normalized settings snapshot: schema defaults + on-disk overrides + relevant host
 * pi settings. Redacts key-like fields defensively (these files contain no credentials).
 */
export async function captureSettingsSnapshot(outPath: string): Promise<{
  snapshotPath: string;
  portraitSettings: Record<string, unknown>;
  overriddenKeys: string[];
}> {
  const { PORTRAIT_SCHEMA } = await import("../../src/schema.js");
  const defaults: Record<string, unknown> = {};
  for (const setting of PORTRAIT_SCHEMA.settings as SchemaDefault[]) {
    defaults[setting.id] = setting.defaultValue;
  }
  let overrides: Record<string, unknown> = {};
  try {
    overrides = JSON.parse(fs.readFileSync(PORTRAIT_SETTINGS_FILE, "utf-8"));
  } catch {
    // no overrides file — defaults only
  }
  let host: Record<string, unknown> = {};
  try {
    host = JSON.parse(fs.readFileSync(HOST_SETTINGS_FILE, "utf-8"));
  } catch {
    // no host settings — leave blank
  }
  const snapshot = redact({
    capturedAt: new Date().toISOString(),
    portraitSettings: { ...defaults, ...overrides },
    overriddenKeys: Object.keys(overrides),
    hostPiSettings: {
      defaultProvider: host.defaultProvider,
      defaultModel: host.defaultModel,
      defaultThinkingLevel: host.defaultThinkingLevel,
    },
    note: "sanitized: key/secret/token-like values redacted",
  }) as { capturedAt: string; portraitSettings: Record<string, unknown>; overriddenKeys: string[] };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2), "utf-8");
  return {
    snapshotPath: outPath,
    portraitSettings: snapshot.portraitSettings,
    overriddenKeys: snapshot.overriddenKeys,
  };
}
