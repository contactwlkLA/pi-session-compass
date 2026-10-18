// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as readline from "node:readline";
import {
  extractAssistantText,
  extractContent,
  isContinuation,
  isExtensionMessage,
  stripSkillBlocks,
} from "../../src/filtering.js";
import type { SessionEntry } from "../../src/trio-detector.js";
import { TrioDetector } from "../../src/trio-detector.js";
import type { CensusResult, CensusTrio } from "./types.js";
import { sha256File } from "./util.js";

/**
 * Offline trio census: streams a session JSONL through the production TrioDetector
 * with no LLM calls, recording 1-based line references for each complete trio.
 * The line-tracking mirror of the detector's state uses the same filtering helpers,
 * so counts are checked for agreement against a plain detector pass in tests.
 */
export async function censusFile(filePath: string): Promise<CensusResult> {
  const detector = new TrioDetector();
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const trios: CensusTrio[] = [];
  let lineNo = 0;
  let nonEmptyLines = 0;
  let prevAssistantLine = 0;
  let prevUserLine = 0;

  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    nonEmptyLines++;

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // malformed line — same skip as the detector/countPendingTrios
    }
    const typed = entry as { type?: unknown; message?: { role?: unknown; content?: unknown; toolName?: unknown } };
    if (typed.type !== "message" || !typed.message) continue;
    const detected = typed as SessionEntry;
    const msg = detected.message as { role?: string; content?: unknown; toolName?: string } | undefined;
    if (!msg) continue;
    const isAssistantWithText = msg.role === "assistant" && extractAssistantText(msg.content).length > 0;
    const isUserCandidate = msg.role === "user" || (msg.role === "toolResult" && msg.toolName === "ask_user_question");

    const trio = detector.process(detected);
    if (trio) {
      trios.push({
        trioIndex: trios.length + 1,
        agentBeforeLine: prevAssistantLine,
        userFeedbackLine: prevUserLine,
        agentAfterLine: lineNo,
      });
      // Detector clears lastUser and advances lastAssistant on emission.
      prevUserLine = 0;
      prevAssistantLine = lineNo;
      continue;
    }
    if (isAssistantWithText) {
      prevAssistantLine = lineNo;
      // The detector clears the pending user turn on every assistant text that completes no trio.
      prevUserLine = 0;
    }
    if (isUserCandidate) {
      const content = stripSkillBlocks(extractContent(msg.content));
      if (content && !isContinuation(content) && !isExtensionMessage(content)) prevUserLine = lineNo;
    }
  }

  return {
    file: filePath,
    sha256: sha256File(filePath),
    totalTrios: trios.length,
    nonEmptyLines,
    trios,
  };
}

/** Count trios in a single pass with a bare detector (agreement reference for tests). */
export async function countTriosOnly(filePath: string): Promise<number> {
  const detector = new TrioDetector();
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let total = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (detector.process(entry)) total++;
    } catch {
      // malformed line — skip
    }
  }
  return total;
}
