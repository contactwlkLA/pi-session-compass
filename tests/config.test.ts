// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * /portrait:config: settings in schema order with their sources (default vs
 * the raw settings file, unreadable and non-object files falling back to
 * default), the fixed gate and collection blocks byte for byte, the
 * environment lines and key redaction, and the whole output for the no-file
 * case. The docs-drift test keeps the CONFIGURATION rows in step with
 * GATE_CONFIG and PLUGIN_CONFIG.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getConfig } from "../src/commands/config.js";
import { GATE_CONFIG } from "../src/gate-config.js";
import { PLUGIN_CONFIG } from "../src/plugin-config.js";
import { PORTRAIT_SCHEMA } from "../src/schema.js";
import { defaultPortraitSettings, setupTestSettings, teardownTestSettings } from "./settings-helpers.js";
import { setTestConfig } from "./setup.js";

const ENV_VARS = ["PI_PORTRAIT_STATE_DIR", "PI_PORTRAIT_SESSION_DIRS", "TYPESAFE_API_KEY"] as const;
const SENTINEL_KEY = "sentinel-key-8f3a";

let testRoot: string;
let settingsFile: string;
let portraitDir: string;
let sessionDirs: string[];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
  settingsFile = path.join(testRoot, "avtc-pi-portrait-settings.json");
  portraitDir = path.join(testRoot, "portrait");
  sessionDirs = [path.join(testRoot, "sessions"), path.join(testRoot, "more-sessions")];
  setTestConfig({ portraitDir, sessionDirs });
  savedEnv = Object.fromEntries(ENV_VARS.map((name) => [name, process.env[name]]));
  for (const name of ENV_VARS) delete process.env[name];
  setupTestSettings(null);
});

afterEach(() => {
  for (const name of ENV_VARS) {
    const saved = savedEnv[name];
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
  teardownTestSettings();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

/** The configured settings lines in schema order, one per setting. */
function expectedSettingsLines(): string[] {
  const defaults = defaultPortraitSettings(null) as unknown as Record<string, unknown>;
  return PORTRAIT_SCHEMA.settings.map(
    (setting) => `  ${setting.id}: ${JSON.stringify(defaults[setting.id])} · default`,
  );
}

/** The fixed blocks of the approved template, line for line. */
function expectedGateAndCollectionLines(): string[] {
  return [
    "Jev gate (fixed):",
    "  Model: jev-1.13.0",
    "  Endpoint: https://api.typesafe.ai/v1/systemone",
    "  Threshold: 0.3 (correction, preference, confusion)",
    "  Deadline: 5000 ms · retry wait 500 ms · failure limit 3",
    "  State cap: 32768 bytes",
    "Collection (fixed):",
    "  Files per scan: 100",
    "  Lock poll: 60000 ms",
    "  Retry backoff: 1000 ms doubling, capped at 10000 ms",
    "  Footer refresh: 5000 ms",
  ];
}

/** The 21 settings lines following the `Settings (…)` header. */
function settingsLinesOf(output: string): string[] {
  const lines = output.split("\n");
  const header = lines.findIndex((line) => line.startsWith("Settings ("));
  return lines.slice(header + 1, header + 22);
}

describe("getConfig settings sources", () => {
  it("lists 21 settings in schema order, all default, with no settings file", () => {
    const output = getConfig(settingsFile);
    const lines = output.split("\n");

    expect(PORTRAIT_SCHEMA.settings).toHaveLength(21);
    expect(lines[2]).toBe(`Settings (/portrait:settings, ${settingsFile}):`);
    expect(lines.slice(3, 24)).toEqual(expectedSettingsLines());
    expect(lines[24]).toBe("Jev gate (fixed):");
    expect(settingsLinesOf(output)).toHaveLength(21);
    expect(settingsLinesOf(output).every((line) => line.endsWith("· default"))).toBe(true);
  });

  it("labels stored keys as settings file and the rest as default", () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ model: "p/m", ruleLimit: 50 }), "utf-8");
    setupTestSettings({ model: "p/m", ruleLimit: 50 });

    const settingsLines = settingsLinesOf(getConfig(settingsFile));

    expect(settingsLines).toHaveLength(21);
    expect(settingsLines).toContain('  model: "p/m" · settings file');
    expect(settingsLines).toContain("  ruleLimit: 50 · settings file");
    const others = settingsLines.filter((line) => !line.startsWith("  model:") && !line.startsWith("  ruleLimit:"));
    expect(others).toHaveLength(19);
    expect(others.every((line) => line.endsWith("· default"))).toBe(true);
  });

  it("treats an unparseable settings file as all default without throwing", () => {
    fs.writeFileSync(settingsFile, "{not json", "utf-8");

    const settingsLines = settingsLinesOf(getConfig(settingsFile));

    expect(settingsLines).toHaveLength(21);
    expect(settingsLines.every((line) => line.endsWith("· default"))).toBe(true);
  });

  it("treats a settings file that is not a plain object as all default", () => {
    fs.writeFileSync(settingsFile, "[1,2]", "utf-8");

    const settingsLines = settingsLinesOf(getConfig(settingsFile));

    expect(settingsLines).toHaveLength(21);
    expect(settingsLines.every((line) => line.endsWith("· default"))).toBe(true);
  });
});

describe("getConfig fixed blocks", () => {
  it("prints the Jev gate and Collection blocks byte for byte", () => {
    const lines = getConfig(settingsFile).split("\n");
    const start = lines.indexOf("Jev gate (fixed):");

    expect(start).toBeGreaterThan(0);
    expect(lines.slice(start, start + 11)).toEqual(expectedGateAndCollectionLines());
    expect(lines[start + 11]).toBe("Environment:");
  });
});

describe("getConfig environment lines", () => {
  it("shows default sources for unset variables", () => {
    const lines = getConfig(settingsFile).split("\n");

    expect(lines).toContain(`  PI_PORTRAIT_STATE_DIR: ${portraitDir} · default`);
    expect(lines).toContain(`  PI_PORTRAIT_SESSION_DIRS: ${sessionDirs.join(path.delimiter)} · default`);
    expect(lines).toContain("  TYPESAFE_API_KEY: not set");
  });

  it("labels an env-set session dir source as env (the dir itself is read at config load)", () => {
    process.env.PI_PORTRAIT_SESSION_DIRS = path.join(testRoot, "env-sessions");

    const line = getConfig(settingsFile)
      .split("\n")
      .find((entry) => entry.startsWith("  PI_PORTRAIT_SESSION_DIRS:"));

    expect(line).toBe(`  PI_PORTRAIT_SESSION_DIRS: ${sessionDirs.join(path.delimiter)} · env`);
  });

  it("labels an empty env value as default (only non-empty values count as env)", () => {
    process.env.PI_PORTRAIT_STATE_DIR = "";
    process.env.PI_PORTRAIT_SESSION_DIRS = "";

    const lines = getConfig(settingsFile).split("\n");

    expect(lines).toContain(`  PI_PORTRAIT_STATE_DIR: ${portraitDir} · default`);
    expect(lines).toContain(`  PI_PORTRAIT_SESSION_DIRS: ${sessionDirs.join(path.delimiter)} · default`);
  });

  it("shows the key as set without ever printing it", () => {
    process.env.TYPESAFE_API_KEY = SENTINEL_KEY;

    const output = getConfig(settingsFile);

    expect(output).toContain("  TYPESAFE_API_KEY: set");
    expect(output).not.toContain(SENTINEL_KEY);
  });
});

describe("getConfig whole output", () => {
  it("matches the approved template line by line with no settings file", () => {
    const expected = [
      "👤 Portrait Configuration",
      "──────────────────────",
      `Settings (/portrait:settings, ${settingsFile}):`,
      ...expectedSettingsLines(),
      ...expectedGateAndCollectionLines(),
      "Environment:",
      `  PI_PORTRAIT_STATE_DIR: ${portraitDir} · default`,
      `  PI_PORTRAIT_SESSION_DIRS: ${sessionDirs.join(path.delimiter)} · default`,
      "  TYPESAFE_API_KEY: not set",
    ];

    expect(getConfig(settingsFile).split("\n")).toEqual(expected);
  });
});

describe("CONFIGURATION fixed-value rows", () => {
  it("document the current gate and collection values", () => {
    const docs = fs.readFileSync(path.join(process.cwd(), "docs", "CONFIGURATION.md"), "utf-8");
    const rows = docs.split("\n");
    const rowStartingWith = (prefix: string): string => {
      const row = rows.find((line) => line.startsWith(prefix));
      expect(row, `no row starting with ${prefix}`).toBeDefined();
      return row ?? "";
    };

    expect(rowStartingWith("| Model ")).toContain(GATE_CONFIG.model);
    expect(rowStartingWith("| Endpoint ")).toContain(GATE_CONFIG.endpoint);
    expect(rowStartingWith("| Threshold ")).toContain(String(GATE_CONFIG.threshold));
    expect(rowStartingWith("| Failure limit ")).toContain(String(GATE_CONFIG.failureLimit));
    expect(rowStartingWith("| Files per scan ")).toContain(String(PLUGIN_CONFIG.filesPerScan));
  });
});
