// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as readline from "node:readline";
import { strings } from "./strings.js";
import type { Limits, StartPortrait } from "./types.js";

export interface ConfirmationInput {
  limits: Limits;
  scope: "all" | "file";
  /** Selected file path (scope=file) or a scope description (scope=all). */
  selectionLabel: string;
  trioCount: number;
  outputDir: string;
  startPortrait: StartPortrait;
}

/** Render the start-of-run confirmation block (compass.md rule 4). */
export function renderConfirmation(input: ConfirmationInput): string {
  const { limits } = input;
  const lines = [
    strings.confirmHeader,
    strings.confirmRunType(limits.runType),
    limits.source === "compass-table"
      ? strings.confirmSuggested(limits.maxModelRequests, limits.maxRunMs, "compass.md table")
      : limits.source === "agent-suggestion"
        ? strings.confirmSuggested(limits.maxModelRequests, limits.maxRunMs, "agent suggestion")
        : strings.confirmLimits(limits.maxModelRequests, limits.maxRunMs),
    input.scope === "all"
      ? strings.confirmSelectionAll(input.trioCount)
      : strings.confirmSelection(input.selectionLabel, input.trioCount),
    strings.confirmOutputDir(input.outputDir),
    input.startPortrait.source === "snapshot"
      ? strings.confirmStartSnapshot(input.startPortrait.dir)
      : strings.confirmStartLive(input.startPortrait.dir),
    "",
    strings.costNoteLowerBound,
    strings.costNoteSpend,
    strings.costNoteThinking,
    strings.costNoteCapped,
  ];
  return lines.join("\n");
}

export interface ConfirmOptions {
  /** --confirmed was passed (agent launch after user approval in session). */
  confirmed: boolean;
  /** Whether stdin is a terminal (interactive prompt allowed). */
  isTTY?: boolean;
  /** Injected prompt for tests; defaults to an interactive y/N question. */
  ask?: (question: string) => Promise<string>;
}

export type ConfirmResult =
  | { proceed: true; mode: "flag" | "prompt" }
  | { proceed: false; mode: "refused" | "prompt" | "non-tty"; reason: string };

/**
 * Resolve the start-of-run gate:
 * - `--confirmed` → proceed (agent launch, user already approved in session).
 * - Interactive terminal → show the block and ask y/N.
 * - Anything else → refuse without a model request.
 */
export async function resolveConfirmation(block: string, opts: ConfirmOptions): Promise<ConfirmResult> {
  if (opts.confirmed) return { proceed: true, mode: "flag" };
  const isTTY = opts.isTTY ?? process.stdin.isTTY === true;
  if (!isTTY) {
    process.stderr.write(`${block}\n${strings.refuseNoConfirm}\n`);
    return { proceed: false, mode: "non-tty", reason: strings.refuseNoConfirm };
  }
  process.stdout.write(`${block}\n`);
  const ask =
    opts.ask ??
    ((question: string) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return new Promise<string>((resolve) =>
        rl.question(question, (answer) => {
          rl.close();
          resolve(answer);
        }),
      );
    });
  const answer = (await ask(strings.askProceed)).trim().toLowerCase();
  if (answer === "y" || answer === "yes") return { proceed: true, mode: "prompt" };
  return { proceed: false, mode: "prompt", reason: strings.cancelled };
}
