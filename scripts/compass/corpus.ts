// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Frozen corpus builder: copy the chosen session folders into one output
 * directory, verify every copy, count each session's trios twice (the detector
 * and the census, which must agree), split each session into the development
 * or the held-out set from the seed, and hash the result. Offline — no network,
 * no model, and no write outside --output. A directory that already exists is
 * never overwritten.
 *
 * Usage:
 *   node corpus.js --source <dir> [--source <dir> …] --output <dir> --seed <text>
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { InteractionSequence } from "../../src/types.js";
import { censusFile } from "./census.js";
import { readTrios } from "./probe.js";
import { strings } from "./strings.js";
import type { CorpusSet, CorpusTrio } from "./types.js";
import { parseArgv, sha256File, sha256Text } from "./util.js";

/** One file as it is copied into the corpus, tagged with its source position. */
interface CopyPlan {
  sourceIndex: number;
  sourceDir: string;
  name: string;
  sourcePath: string;
  destPath: string;
}

/** One frozen session file as corpus.json records it. */
interface FrozenFile {
  name: string;
  sha256: string;
  sessionId: string;
  set: CorpusSet;
  trios: number;
}

/** Every --source value in command-line order; parseArgv keeps only the last repeat of a flag. */
function sourceArgs(argv: string[]): string[] {
  const sources: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        sources.push(next);
        i++;
      }
    } else if (arg.startsWith("--source=")) {
      sources.push(arg.slice("--source=".length));
    }
  }
  return sources;
}

/** The session id: the id of the first session entry, else the file name without `.jsonl`. */
function sessionIdOf(filePath: string, fallback: string): string {
  for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: unknown; id?: unknown };
    try {
      entry = JSON.parse(line) as { type?: unknown; id?: unknown };
    } catch {
      continue;
    }
    if (entry.type === "session") {
      return typeof entry.id === "string" && entry.id.length > 0 ? entry.id : fallback;
    }
  }
  return fallback;
}

/** The set a session belongs to: the seed hashed with the session id decides it. */
function setOf(seed: string, sessionId: string): CorpusSet {
  return parseInt(sha256Text(`${seed}\n${sessionId}`).slice(0, 8), 16) % 2 === 0 ? "dev" : "heldout";
}

/** The stable id of one trio: the session, its position, and its three texts. */
export function trioKey(sessionId: string, index: number, trio: InteractionSequence): string {
  return sha256Text(`${sessionId}\n${index}\n${trio.agentBefore}\n${trio.userFeedback}\n${trio.agentAfter}`).slice(
    0,
    16,
  );
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgv(argv);
  const sources = sourceArgs(argv).map((dir) => path.resolve(dir));
  const outputArg = typeof args.output === "string" ? args.output : null;
  const seed = typeof args.seed === "string" ? args.seed : null;
  if (sources.length === 0 || outputArg === null || seed === null) {
    process.stderr.write(`${strings.corpusMissingFlags}\n`);
    return 2;
  }
  const output = path.resolve(outputArg);

  for (const dir of sources) {
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(dir).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      process.stderr.write(`${strings.corpusNotDirectory(dir)}\n`);
      return 2;
    }
  }
  if (fs.existsSync(output)) {
    process.stderr.write(`${strings.corpusOutputExists(output)}\n`);
    return 2;
  }

  // Every source's jsonl files, sorted by name, each destined for its own numbered folder.
  const plans: CopyPlan[] = [];
  sources.forEach((sourceDir, index) => {
    const folder = `${index + 1}-${path.basename(sourceDir)}`;
    const names = fs
      .readdirSync(sourceDir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
    for (const name of names) {
      const sourcePath = path.join(sourceDir, name);
      if (!fs.statSync(sourcePath).isFile()) continue;
      plans.push({
        sourceIndex: index,
        sourceDir,
        name,
        sourcePath,
        destPath: path.join(output, "sessions", folder, name),
      });
    }
  });

  // Copy and verify first: a mismatch stops here with the copies left behind for inspection.
  fs.mkdirSync(output, { recursive: true });
  for (const plan of plans) {
    fs.mkdirSync(path.dirname(plan.destPath), { recursive: true });
    fs.copyFileSync(plan.sourcePath, plan.destPath);
    if (sha256File(plan.sourcePath) !== sha256File(plan.destPath)) {
      process.stderr.write(`${strings.frozenCopyMismatch(plan.sourcePath)}\n`);
      return 2;
    }
  }

  // Count both ways on the copy; a disagreement stops before any index file exists.
  const trioRows: CorpusTrio[] = [];
  const sourcesOut: { dir: string; files: FrozenFile[] }[] = [];
  const totals = {
    sessions: 0,
    trios: 0,
    dev: { sessions: 0, trios: 0 },
    heldout: { sessions: 0, trios: 0 },
  };
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const files: FrozenFile[] = [];
    for (const plan of plans.filter((candidate) => candidate.sourceIndex === sourceIndex)) {
      const detectorTrios = readTrios(plan.destPath);
      const census = await censusFile(plan.destPath);
      if (detectorTrios.length !== census.totalTrios) {
        process.stderr.write(
          `${strings.corpusCountMismatch(plan.sourcePath, detectorTrios.length, census.totalTrios)}\n`,
        );
        return 2;
      }
      const sessionId = sessionIdOf(plan.destPath, path.basename(plan.name, ".jsonl"));
      const set = setOf(seed, sessionId);
      const relative = path.relative(output, plan.destPath);
      for (const [position, trio] of detectorTrios.entries()) {
        const index = position + 1;
        const lines = census.trios[position];
        trioRows.push({
          key: trioKey(sessionId, index, trio),
          set,
          sessionId,
          file: relative,
          index,
          lines: {
            agentBefore: lines.agentBeforeLine,
            userFeedback: lines.userFeedbackLine,
            agentAfter: lines.agentAfterLine,
          },
          chars: {
            agentBefore: trio.agentBefore.length,
            userFeedback: trio.userFeedback.length,
            agentAfter: trio.agentAfter.length,
          },
        });
      }
      files.push({
        name: plan.name,
        sha256: sha256File(plan.destPath),
        sessionId,
        set,
        trios: detectorTrios.length,
      });
      totals.sessions++;
      totals.trios += detectorTrios.length;
      const bucket = totals[set];
      bucket.sessions++;
      bucket.trios += detectorTrios.length;
    }
    sourcesOut.push({ dir: sources[sourceIndex], files });
  }

  const triosPath = path.join(output, "trios.jsonl");
  fs.writeFileSync(triosPath, `${trioRows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf-8");
  const corpusPath = path.join(output, "corpus.json");
  fs.writeFileSync(
    corpusPath,
    `${JSON.stringify({ seed, createdAt: new Date().toISOString(), sources: sourcesOut, totals }, null, 2)}\n`,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(output, "freeze.json"),
    `${JSON.stringify({ "corpus.json": sha256File(corpusPath), "trios.jsonl": sha256File(triosPath) }, null, 2)}\n`,
    "utf-8",
  );
  process.stdout.write(
    `${strings.corpusFrozen(
      totals.sessions,
      totals.trios,
      totals.dev.sessions,
      totals.dev.trios,
      totals.heldout.sessions,
      totals.heldout.trios,
      output,
    )}\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exit(1);
    },
  );
}
