// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { strings } from "./strings.js";

/**
 * Locate the workspace root by walking up from this module until a directory
 * contains both `md/compass.md` and `biome.json`. Works from the source tree
 * and from the compiled harness tree (outputs/<build>/scripts/compass/…).
 */
export function findWorkspaceRoot(startDir?: string): string {
  let dir = startDir ?? path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, "md", "compass.md")) && fs.existsSync(path.join(dir, "biome.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(strings.workspaceRootNotFound);
}

/** Read a `--flag value` / `--flag=value` argv into a map; positional args land under `_`. */
export function parseArgv(argv: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          out[arg.slice(2)] = next;
          i++;
        } else {
          out[arg.slice(2)] = "true";
        }
      }
    } else {
      const positional = out._;
      if (Array.isArray(positional)) positional.push(arg);
      else out._ = [arg];
    }
  }
  return out;
}

/** sha256 of a file's bytes. */
export function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** sha256 of a string's UTF-8 bytes. */
export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}
