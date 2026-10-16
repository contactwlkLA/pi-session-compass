// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import "./globals.js";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { getBgScanCheckpointsPath, getPortraitDir, getSessionDirs } from "./config.js";
import { appendDebug, openDebugDump } from "./debug.js";
import { reportError } from "./error.js";
import { extractContent } from "./filtering.js";
import { setCachedPipelineState } from "./footer.js";
import { emitTrioExamined } from "./instrument.js";
import { type CompleteRecord, readCompleteRecords } from "./jsonl-reader.js";
import { buildSingleUserMessage, callPortraitLlm, PAUSED } from "./llm-call.js";
import { EXTRACTION_PROMPT, POST_EXTRACTION_PROMPT } from "./prompts.js";
import { getPortraitSettings } from "./settings-ui.js";
import { loadPortraitState, loadScanCheckpoints, savePortraitState, saveScanCheckpoints } from "./storage.js";
import { type SessionEntry, TrioDetector } from "./trio-detector.js";
import type {
  BgScanCheckpoints,
  ExtractionResult,
  InteractionSequence,
  PipelineStopReason,
  PortraitPipelineState,
  ScanCheckpoint,
  ScanCheckpoints,
  ScanResults,
} from "./types.js";

interface DiscoveredFile {
  path: string;
  size: number;
  source: "main" | "subagent";
  checkpoint: ScanCheckpoint | undefined;
  mtimeMs: number;
}

export function discoverFiles(sessionDirs: string[], cutoff: number): DiscoveredFile[] {
  const files: DiscoveredFile[] = [];
  for (const sessionDir of sessionDirs) {
    if (!fs.existsSync(sessionDir)) continue;
    const projects = fs.readdirSync(sessionDir);
    for (const project of projects) {
      const projectDir = path.join(sessionDir, project);
      if (!fs.statSync(projectDir).isDirectory()) continue;
      const sessionFiles = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
      for (const f of sessionFiles) {
        const fullPath = path.join(projectDir, f);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size === 0 || stat.mtimeMs < cutoff) continue;
          const source: "main" | "subagent" = sessionDir.includes("subagent") ? "subagent" : "main";
          files.push({ path: fullPath, size: stat.size, source, checkpoint: undefined, mtimeMs: stat.mtimeMs });
        } catch {
          // File deleted or unreadable
        }
      }
    }
  }
  // Sort all files by mtime descending — most recent sessions scanned first
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

export const DEFAULT_MAX_FILES_PER_CYCLE = 10;
export const DEFAULT_MAX_RESULTS = Infinity;

/** sha256 hex digest of a record's text (its UTF-8 bytes without the line ending). */
function recordDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const FILE_START = 0;
const SCAN_ERROR_SOURCE = "scan error";

/** Stops scanning one session file; the scan reports it and continues with other files. */
class ScanFileStopped extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "ScanFileStopped";
  }
}

function sourceChangedError(filePath: string): ScanFileStopped {
  return new ScanFileStopped(
    filePath,
    `Stopped scanning ${filePath}: the file was truncated or rewritten after it was last scanned. Its scan position was kept.`,
  );
}

function malformedRecordError(filePath: string, offset: number): ScanFileStopped {
  return new ScanFileStopped(filePath, `Stopped scanning ${filePath}: malformed record at byte ${offset}.`);
}

async function firstRecordAt(filePath: string, startByte: number): Promise<CompleteRecord | undefined> {
  for await (const record of readCompleteRecords(filePath, startByte)) {
    return record;
  }
  return undefined;
}

/** Session id and working directory from a file's header record; null where absent. */
interface SessionHeader {
  id: string | null;
  cwd: string | null;
}

function sessionHeader(record: CompleteRecord | undefined): SessionHeader {
  const none: SessionHeader = { id: null, cwd: null };
  if (!record) return none;
  try {
    const header = JSON.parse(record.text);
    if (header?.type !== "session") return none;
    return {
      id: typeof header.id === "string" ? header.id : null,
      cwd: typeof header.cwd === "string" ? header.cwd : null,
    };
  } catch {
    return none;
  }
}

/**
 * Before resuming from a saved position, confirm the file is still the one that was scanned:
 * same header session id, not shorter than the position, and the record at the position
 * still has the saved digest. Positions saved without a digest resume unchecked.
 */
async function verifyScanPosition(filePath: string, checkpoint: ScanCheckpoint): Promise<void> {
  if (checkpoint.boundaryDigest === undefined) return;
  if (fs.statSync(filePath).size < checkpoint.lastByte) throw sourceChangedError(filePath);
  if (checkpoint.sessionId !== undefined) {
    const currentId = sessionHeader(await firstRecordAt(filePath, FILE_START)).id;
    if (currentId !== checkpoint.sessionId) throw sourceChangedError(filePath);
  }
  const boundary = await firstRecordAt(filePath, checkpoint.lastByte);
  if (
    !boundary ||
    boundary.offset !== checkpoint.lastByte ||
    recordDigest(boundary.text) !== checkpoint.boundaryDigest
  ) {
    throw sourceChangedError(filePath);
  }
}

export async function scanSessions(
  portraitDir: string,
  state: PortraitPipelineState,
  maxFilesPerCycle: number,
  maxResults: number,
): Promise<ScanResults> {
  const checkpoints = loadScanCheckpoints(portraitDir);
  const settings = getPortraitSettings();
  const maxAgeMs = settings.maxAgeDays * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  const sessionDirs = getSessionDirs();

  // Discover all files and calculate KB progress
  // Y (total remaining) = FilesTotal - CheckpointKB (already scanned in prior cycles)
  // X (session progress) = KB processed since this cycle started (starts at 0)
  const allFiles = discoverFiles(sessionDirs, cutoff);
  for (const f of allFiles) {
    f.checkpoint = checkpoints[f.path];
  }
  setCachedPipelineState(state); // Persist immediately so footer shows MB from scan start

  let filesProcessed = 0;
  let triosProcessed = state.triosProcessed;
  const totalKnownTrios = state.totalKnownTrios;
  const results: ExtractionResult[] = [];
  let sessionKB = state.scanSessionKB; // Continue accumulating from prior scanSessions calls
  let lastFooterUpdate = 0; // Throttle footer updates across all files

  for (const file of allFiles) {
    // Catch-up batching: stop after maxFilesPerCycle
    if (filesProcessed >= maxFilesPerCycle) {
      saveScanCheckpoints(portraitDir, checkpoints);
      const remaining = allFiles.length - allFiles.indexOf(file);
      return { results, triosProcessed, totalKnownTrios, remainingFiles: remaining, stopReason: null };
    }

    const _lastByte = file.checkpoint?.lastByte ?? 0;

    // Stream file from checkpoint, extracting trios immediately
    let scanResult: StreamAndExtractResult;
    try {
      scanResult = await streamAndExtract({
        sessionFile: file.path,
        fileSize: file.size,
        source: file.source,
        state,
        portraitDir,
        checkpoints,
        onProgress: (_trioCount: number, totalNonEmpty: number, bytesRead: number) => {
          // Progress callback — update session KB for footer
          state.lastProcessedFile = file.path;
          state.lastProcessedLine = totalNonEmpty;
          state.scanProgress = { bytesRead, totalBytes: file.size };
          state.scanSessionKB = sessionKB + Math.round(bytesRead / 1024);
          // Throttle footer updates to ~1 per second (across all files)
          const now = Date.now();
          if (now - lastFooterUpdate >= 1000) {
            lastFooterUpdate = now;
            setCachedPipelineState(state);
          }
        },
        onTrio: async (trioResult) => {
          results.push(trioResult);
          triosProcessed++;
          // Update footer with live trio count only (totalKnownTrios is managed by bg scanner)
          state.triosProcessed = triosProcessed;
          setCachedPipelineState(state);
        },
        maxTrios: maxResults - results.length,
      });
    } catch (err) {
      // A stopped file keeps its saved position; report it and scan the other files
      if (err instanceof ScanFileStopped) {
        reportError(err.message, SCAN_ERROR_SOURCE);
        continue;
      }
      // Only handle file-not-found/access errors on this session file — let everything else
      // bubble up, including filesystem errors raised while extracting its trios
      const msg = err instanceof Error ? err.message : "";
      const onThisFile = (err as NodeJS.ErrnoException | undefined)?.path === file.path;
      if (
        onThisFile &&
        (msg.includes("ENOENT") || msg.includes("EPERM") || msg.includes("EBUSY") || msg.includes("EACCES"))
      ) {
        delete checkpoints[file.path];
        continue;
      }
      throw err;
    }

    const { totalNonEmpty, bytesScanned, resumeByte, boundaryDigest, sessionId, stopReason } = scanResult;
    if (stopReason !== null) {
      // The file keeps the position of its last examined trio; the pass ends here.
      saveScanCheckpoints(portraitDir, checkpoints);
      state.triosProcessed = triosProcessed;
      setCachedPipelineState(state);
      const remaining = allFiles.length - allFiles.indexOf(file);
      return { results, triosProcessed, totalKnownTrios, remainingFiles: remaining, stopReason };
    }
    filesProcessed++;

    // Store the scan position the pass ended at: the record boundary a fresh
    // detector restarts from to rebuild this detector's state.
    checkpoints[file.path] = { lastByte: resumeByte, boundaryDigest, sessionId };
    if (bytesScanned > 0) {
      sessionKB += Math.round(bytesScanned / 1024);
    }

    state.lastProcessedFile = file.path;
    state.lastProcessedLine = totalNonEmpty;
    state.scanProgress = undefined; // Done with this file
    state.scanSessionKB = sessionKB;
    setCachedPipelineState(state); // Immediate footer update at file boundary

    // Stop early if we have enough results
    if (results.length >= maxResults) {
      saveScanCheckpoints(portraitDir, checkpoints);
      state.triosProcessed = triosProcessed;
      const remaining = allFiles.length - allFiles.indexOf(file) - 1;
      return { results, triosProcessed, totalKnownTrios, remainingFiles: remaining, stopReason: null };
    }

    // Yield to event loop every 10 files
    if (filesProcessed % 10 === 0) {
      await Promise.resolve();
    }
  }

  saveScanCheckpoints(portraitDir, checkpoints);
  state.triosProcessed = triosProcessed;

  return { results, triosProcessed, totalKnownTrios, remainingFiles: 0, stopReason: null };
}

/** Load bg scan checkpoints from dedicated file (avoids race with main state file) */
function loadBgScanCheckpoints(): BgScanCheckpoints {
  const filePath = getBgScanCheckpointsPath();
  try {
    const raw: Record<string, unknown> = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (typeof raw !== "object" || raw === null) return {};
    // Migrate old field names and clean up orphans
    for (const key of Object.keys(raw)) {
      const cp = raw[key] as Record<string, number | undefined>;
      if (cp.lastByte === undefined) cp.lastByte = cp.lastLine ?? 0;
      if (cp.extractionCheckpointByte === undefined) cp.extractionCheckpointByte = cp.extractionCheckpointLine ?? 0;
      // Remove orphan old fields after migration
      delete cp.lastLine;
      delete cp.extractionCheckpointLine;
    }
    return raw as BgScanCheckpoints;
  } catch {
    return {};
  }
}

/** Save bg scan checkpoints to dedicated file */
function saveBgScanCheckpoints(checkpoints: BgScanCheckpoints): void {
  const filePath = getBgScanCheckpointsPath();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(checkpoints), "utf-8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * Fast background scan: count total pending trios across all remaining files.
 * No LLM calls — parses entries and detects complete trios immediately.
 * Maintains its own checkpoint map so it doesn't re-scan on each /collect.
 * Uses extraction checkpoints (lastByte) to know which region is pending.
 * Yields to event loop periodically to avoid blocking.
 */
export async function countPendingTrios(portraitDir: string, maxAgeDays: number | undefined): Promise<number> {
  const settings = getPortraitSettings();
  const maxAgeMs = (maxAgeDays ?? settings.maxAgeDays) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  const sessionDirs = getSessionDirs();

  const allFiles = discoverFiles(sessionDirs, cutoff);
  const extractionCheckpoints = loadScanCheckpoints(portraitDir);
  const _state = loadPortraitState(portraitDir);
  const bgCheckpoints = loadBgScanCheckpoints();

  let totalTrios = 0;
  let changed = false;

  for (let i = 0; i < allFiles.length; i++) {
    // Yield to event loop every 5 files, check cancellation
    if (i % 5 === 0 && i > 0) {
      await Promise.resolve();
      // Save checkpoints every 50 files to avoid losing progress on crash
      if (i % 50 === 0 && changed) saveBgScanCheckpoints(bgCheckpoints);
      const gstate = globalThis.__piPortrait;
      if (gstate?.collectCancelled || gstate?.bgScanCancelled) {
        // Save partial progress
        if (changed) saveBgScanCheckpoints(bgCheckpoints);
        return totalTrios;
      }
      // Update running total for live footer display
      const updated = loadPortraitState(portraitDir);
      updated.totalKnownTrios = totalTrios;
      savePortraitState(portraitDir, updated);
      // Update cache without overwriting phase (collect owns phase)
      const cached = globalThis.__piPortraitPipelineState;
      if (cached) {
        cached.totalKnownTrios = totalTrios;
      }
    }

    const file = allFiles[i];
    const extCp = extractionCheckpoints[file.path];
    const extCheckedByte = extCp?.lastByte ?? 0;
    const bgCp = bgCheckpoints[file.path];

    // If extraction checkpoint hasn't changed since last bg scan, use cached count
    if (bgCp && bgCp.extractionCheckpointByte === extCheckedByte) {
      totalTrios += bgCp.triosCount;
      continue;
    }

    // Extraction advanced — must re-scan from new checkpoint.
    // Cached count is stale (included trios now in extracted region).

    try {
      const fileStream = fs.createReadStream(file.path, { encoding: "utf-8", start: extCheckedByte });
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      let fileTrios = 0;
      let bytesScanned = 0;
      const detector = new TrioDetector();

      for await (const line of rl) {
        if (!line.trim()) {
          bytesScanned += 1; // just the newline
          continue;
        }

        // Yield to event loop every ~50 lines for cancellation checks
        bytesScanned += Buffer.byteLength(line, "utf-8") + 1;

        try {
          const entry = JSON.parse(line);
          const trio = detector.process(entry);
          if (trio) fileTrios++;
        } catch {
          // Malformed line — skip
        }
      }

      // Update bg checkpoint
      bgCheckpoints[file.path] = {
        lastByte: bytesScanned,
        triosCount: fileTrios,
        extractionCheckpointByte: extCheckedByte,
      };
      changed = true;

      totalTrios += fileTrios;
    } catch {
      // File unreadable — skip
    }
  }

  // Save bg scan checkpoints
  if (changed) {
    saveBgScanCheckpoints(bgCheckpoints);
  }

  return totalTrios;
}

/**
 * Stream a session file line-by-line, building entries and extracting trios incrementally.
 * Returns immediately when maxResults trios are found, without reading the rest of the file.
 */
interface StreamAndExtractOptions {
  sessionFile: string;
  fileSize: number;
  source: "main" | "subagent";
  state: PortraitPipelineState;
  portraitDir: string;
  checkpoints: ScanCheckpoints;
  onProgress: (trios: number, totalNonEmpty: number, bytesRead: number) => void;
  onTrio: (result: ExtractionResult) => Promise<void>;
  maxTrios: number;
}

/** Stop reasons a scan pass can end with (the build stop is set by the pipeline). */
type ScanStopReason = Extract<PipelineStopReason, "extraction_failed" | "review_failed">;

/** What one streaming pass over a session file reports back. */
interface StreamAndExtractResult {
  triosFound: number;
  totalNonEmpty: number;
  bytesScanned: number;
  resumeByte: number;
  boundaryDigest: string | undefined;
  sessionId: string | undefined;
  /** Set when the pass ended at a failed trio; the saved position is then not updated from this result. */
  stopReason: ScanStopReason | null;
}

/** A record a trio is built from: its id when present, and its exact text. */
interface TrioRecord {
  id: string | null;
  text: string;
}

/** What the trio loop does after one trio: keep going, reach the pass limit, or stop on a failure. */
type TrioStep = "continue" | "limit" | ScanStopReason;

/**
 * Stable identity of a trio (sha256 hex). Uses the session id and the three record ids when all
 * are present; otherwise the three record texts, so the same trio keeps its identity across passes.
 */
function trioIdentity(sessionId: string | undefined, records: readonly TrioRecord[]): string {
  const ids = records.map((record) => record.id);
  const input =
    sessionId !== undefined && ids.every((id) => id !== null)
      ? [sessionId, ...ids].join("\n")
      : records.map((record) => record.text).join("\n");
  return createHash("sha256").update(input).digest("hex");
}

async function streamAndExtract(opts: StreamAndExtractOptions): Promise<StreamAndExtractResult> {
  const { sessionFile, source, portraitDir, checkpoints, onProgress, onTrio, maxTrios } = opts;

  const savedCheckpoint = checkpoints[sessionFile];
  if (savedCheckpoint) await verifyScanPosition(sessionFile, savedCheckpoint);
  const checkpointByte = savedCheckpoint?.lastByte ?? FILE_START;
  const records = readCompleteRecords(sessionFile, checkpointByte);
  // The header is read on every pass, so a resumed pass knows the session id and cwd too.
  const header = sessionHeader(await firstRecordAt(sessionFile, FILE_START));
  const sessionId = header.id ?? undefined;

  let triosFound = 0;
  let bytesRead = 0; // bytes read since resume (for progress)

  // Trio detection is delegated to TrioDetector (shared with countPendingTrios)
  // to keep the two paths consistent. resumeByte tracks the record boundary a
  // fresh detector must restart from to rebuild this detector's state.
  const detector = new TrioDetector();
  let resumeByte = checkpointByte;
  let boundaryDigest = checkpoints[sessionFile]?.boundaryDigest;
  // The most recent records that set the trio's agent-before and user texts.
  let lastAssistantRecord: TrioRecord | undefined;
  let lastUserRecord: TrioRecord | undefined;

  // Helper to save checkpoint mid-file (after each trio extraction)
  function saveMidFileCheckpoint() {
    checkpoints[sessionFile] = {
      lastByte: resumeByte,
      boundaryDigest,
      sessionId,
    };
    saveScanCheckpoints(portraitDir, checkpoints);
  }

  // Helper to try extracting a complete trio (agent→user→agent)
  async function tryExtractTrio(
    trio: InteractionSequence,
    records: [TrioRecord, TrioRecord, TrioRecord],
  ): Promise<TrioStep> {
    const settings = getPortraitSettings();
    const extraction = await callExtractionLlm(
      { agentBefore: trio.agentBefore, userFeedback: trio.userFeedback, agentAfter: trio.agentAfter },
      settings.debugDumpLimit,
    );
    if (extraction.kind === "failed") {
      reportError(
        `Rule extraction failed for a trio in ${sessionFile}. Its scan position was kept; the trio will be extracted again on the next run.`,
        "extraction error",
      );
      return "extraction_failed";
    }
    const review: ReviewOutcome = settings.postExtractionEnabled
      ? await postExtractRules(
          extraction.notes,
          extraction.summary,
          extraction.dumpPath,
          settings.postExtractionModel || undefined,
        )
      : { kind: "success", notes: extraction.notes };
    if (review.kind === "failed") {
      const rawCount = extraction.notes.length;
      reportError(
        `Rule review failed; ${rawCount} extracted ${rawCount === 1 ? "rule was" : "rules were"} kept and will be reviewed on the next run.`,
        "review error",
      );
      return "review_failed";
    }
    const validated = review.notes;
    emitTrioExamined({ sessionPath: sessionFile, notes: validated.length, notesText: validated });
    if (validated.length > 0) {
      const trioId = trioIdentity(sessionId, records);
      const result: ExtractionResult = {
        behaviorNotes: validated,
        sessionPath: sessionFile,
        source,
        trioId,
        candidateIds: validated.map((_, index) => `${trioId}:${index}`),
        sessionId: sessionId ?? null,
        cwd: header.cwd,
        entryIds: records.map((record) => record.id),
      };
      await onTrio(result);
      triosFound++;
    }
    // Save the scan position after every examined trio (even if no notes — prevents re-extraction)
    saveMidFileCheckpoint();
    return triosFound >= maxTrios ? "limit" : "continue";
  }

  for await (const record of records) {
    const recordBytes = record.length + 1; // +1 for newline
    bytesRead += recordBytes;

    // Parse entry — SessionMessageEntry wraps AgentMessage inside a `message` field.
    // Only parsing is guarded: extraction and checkpoint errors (including PAUSED) propagate.
    let entry: SessionEntry & { id?: unknown };
    try {
      entry = JSON.parse(record.text);
    } catch {
      throw malformedRecordError(sessionFile, record.offset);
    }
    if (entry === null || typeof entry !== "object") throw malformedRecordError(sessionFile, record.offset);
    if (entry.type === "message") {
      const current: TrioRecord = { id: typeof entry.id === "string" ? entry.id : null, text: record.text };
      // Captured before this record updates the detector's state: they are the trio's before and user records.
      const beforeRecord = lastAssistantRecord;
      const userRecord = lastUserRecord;
      // Delegate trio detection to TrioDetector
      const trio = detector.process(entry);
      if (detector.lastRecordSetLastUser) lastUserRecord = current;
      if (detector.lastRecordSetLastAssistant) {
        lastAssistantRecord = current;
        resumeByte = record.offset;
        boundaryDigest = recordDigest(record.text);
      }
      if (trio && beforeRecord && userRecord) {
        const step = await tryExtractTrio(trio, [beforeRecord, userRecord, current]);
        onProgress(triosFound, bytesRead, bytesRead);
        if (step === "limit") {
          return {
            triosFound,
            totalNonEmpty: bytesRead,
            bytesScanned: bytesRead,
            resumeByte,
            boundaryDigest,
            sessionId,
            stopReason: null,
          };
        }
        if (step !== "continue") {
          return {
            triosFound,
            totalNonEmpty: bytesRead,
            bytesScanned: bytesRead,
            resumeByte,
            boundaryDigest,
            sessionId,
            stopReason: step,
          };
        }
      }
    }

    // Report progress every ~50 lines worth of bytes
    if (bytesRead % (50 * 200) < recordBytes) {
      // ~every 50 lines (avg 200 bytes/line)
      onProgress(triosFound, bytesRead, bytesRead);
    }
  }

  return {
    triosFound,
    totalNonEmpty: bytesRead,
    bytesScanned: bytesRead,
    resumeByte,
    boundaryDigest,
    sessionId,
    stopReason: null,
  };
}

/**
 * Build a tool call summary.
 * - read/grep/find/ls/web_search/web_fetch/recall: compact summary only
 * - write/edit: full content (what agent wrote — user may correct this)
 * - bash: full command
 * - ask_user_question: full question text
 * - todo tools / plan_tracker / phase_ready / fork: compact summary
 * - subagent: task description + agent name
 * - unknown: compact summary
 */
export function summarizeToolCall(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return `[${name}]`;
  const a = args as Record<string, unknown>;
  switch (name) {
    case "read":
      return `[read: ${a.path || "?"}${a.offset ? `:${a.offset}` : ""}]`;
    case "grep":
      return `[grep: "${a.pattern || "?"}" in ${a.path || "?"}]`;
    case "find":
      return `[find: ${a.pattern || "?"} in ${a.path || "?"}]`;
    case "ls":
      return `[ls: ${a.path || "?"}]`;
    case "write": {
      const content = a.content || "";
      return `[write: ${a.path || "?"}]\n${content}`;
    }
    case "edit": {
      const edits = (a.edits as Array<{ oldText?: string; newText?: string }> | undefined) || [];
      const diffs = edits.map((e) => `---\n${e.oldText || ""}\n+++\n${e.newText || ""}`).join("\n");
      return `[edit: ${a.path || "?"}]\n${diffs}`;
    }
    case "bash":
      return `[bash: ${a.command || "?"}]`;
    case "powershell":
      // PowerShell shell tool (pi ≥ 0.84.3) — same command-shaped input as bash.
      return `[powershell: ${a.command || "?"}]`;
    case "ask_user_question": {
      const questions = (a.questions as Array<{ question?: string; options?: string[] }> | undefined) || [];
      const qText = questions.map((q) => `${q.question || "?"} (${(q.options || []).join("/")})`).join("; ");
      return `[ask_user_question: ${qText}]`;
    }
    case "subagent": {
      const task = a.task || "?";
      const agent = a.agent || "?";
      return `[subagent: ${agent}] ${task}`;
    }
    case "web_search":
      return `[web_search: ${a.query || "?"}]`;
    case "web_fetch":
      return `[web_fetch: ${a.url || "?"}]`;
    case "recall":
      return `[recall: ${a.id || "?"}]`;
    case "owl_recall": {
      // session-owl's memory browser (ids[] / query params — unlike pi-observational-memory's `recall` id param).
      const ids = (a.ids as string[] | undefined) || [];
      if (ids.length > 0) return `[owl_recall: ${ids.join(",")}]`;
      const query = typeof a.query === "string" && a.query ? a.query : null;
      return query ? `[owl_recall: ?q ${query}]` : "[owl_recall: *]";
    }
    case "plan_tracker":
      return `[plan_tracker: ${a.action || "?"}]`;
    case "phase_ready":
      return "[phase_ready]";
    case "task_ready_advance":
      return `[task_ready_advance: ${a.taskToActivate ?? "finish"}]`;
    case "user_decision_add":
      return `[user_decision_add: ${a.summary || "?"}]`;
    case "user_decision_list":
      return "[user_decision_list]";
    case "user_decision_detail":
      return `[user_decision_detail: ${a.id ?? "?"}]`;
    case "fork":
      return "[fork]";
    case "todo_init":
    case "todo_add":
    case "todo_update":
    case "todo_complete":
    case "todo_list":
      return `[${name}]`;
    default: {
      const argsStr = JSON.stringify(args);
      const truncated = argsStr.length > 200 ? `${argsStr.substring(0, 200)}...` : argsStr;
      return `[${name}: ${truncated}]`;
    }
  }
}

/**
 * Build a tool result summary based on tool type.
 * - write/edit: skip (content is in the tool call, result is just confirmation)
 * - bash: skip (command is in the tool call, output is noise)
 * - subagent: full result (delegated work output)
 * - read/grep/find/ls/web_search/web_fetch/recall: skip (research material — tool call summary is enough)
 * - todo tools / plan_tracker / phase_ready / ask_user_question / fork: skip
 * - unknown: skip (tool call summary is enough)
 */
export function summarizeToolResult(content: unknown, toolName: string | undefined): string {
  const text = extractContent(content);
  if (!text) return "";

  // Skip tools where result is confirmation/workflow noise or research material
  // (tool call summary already provides enough context)
  if (
    toolName &&
    (toolName === "write" ||
      toolName === "edit" ||
      toolName === "read" ||
      toolName === "grep" ||
      toolName === "find" ||
      toolName === "ls" ||
      toolName === "web_search" ||
      toolName === "web_fetch" ||
      toolName === "recall" ||
      toolName === "owl_recall" ||
      toolName === "bash" ||
      toolName === "powershell" ||
      toolName.startsWith("todo_") ||
      toolName === "plan_tracker" ||
      toolName === "phase_ready" ||
      toolName === "ask_user_question" ||
      toolName === "task_ready_advance" ||
      toolName.startsWith("user_decision_") ||
      toolName === "fork")
  ) {
    return "";
  }

  // Subagent: full result (delegated work output)
  if (toolName === "subagent") {
    return text;
  }

  // All other tools: skip (tool call summary provides enough context)
  return "";
}

interface ExtractionSummary {
  agentBefore: string;
  userFeedback: string;
  agentAfter: string;
}

interface ExtractionCapture {
  notes: string[];
  summary: ExtractionSummary;
}

type ExtractionOutcome =
  | { kind: "success"; notes: string[]; summary: ExtractionSummary; dumpPath: string | null }
  | { kind: "failed" };

type ReviewOutcome = { kind: "success"; notes: string[] } | { kind: "failed" };

async function callExtractionLlm(sequence: InteractionSequence, dumpLimit: number): Promise<ExtractionOutcome> {
  const userText = `<agent-before>
${sequence.agentBefore}
</agent-before>

<user-feedback>
${sequence.userFeedback}
</user-feedback>

<agent-after>
${sequence.agentAfter}
</agent-after>`;

  // Debug dump: write what the extractor agent sees (system prompt + user message).
  // openDebugDump returns null when debugDumpLimit <= 0 (dumps disabled) — appendDebug then no-ops.
  const dumpPath = openDebugDump(getPortraitDir(), "extraction", dumpLimit);
  appendDebug(
    dumpPath,
    `=== Extraction Agent Input ===
--- SYSTEM PROMPT ---
${EXTRACTION_PROMPT}

--- TOOL ---
${JSON.stringify({ name: "return_extraction", description: "Return extracted behavior notes with interaction summary.", input_schema: { type: "object", properties: { summary: { type: "object", properties: { agentBefore: { type: "string" }, userFeedback: { type: "string" }, agentAfter: { type: "string" } }, required: ["agentBefore", "userFeedback", "agentAfter"] }, behaviorNotes: { type: "array", items: { type: "string" } } }, required: ["summary", "behaviorNotes"] } }, null, 2)}

--- USER MESSAGE ---
${userText}
`,
  );

  // Define return tool
  let captured: ExtractionCapture | null = null;

  const returnExtractionTool: AgentTool = {
    name: "return_extraction",
    label: "Return extraction",
    description: "Return extracted behavior notes with interaction summary.",
    parameters: Type.Object({
      summary: Type.Object({
        agentBefore: Type.String(),
        userFeedback: Type.String(),
        agentAfter: Type.String(),
      }),
      behaviorNotes: Type.Array(Type.String()),
    }),
    execute: async (_toolCallId: string, params: unknown) => {
      const typedParams = params as { summary: ExtractionSummary; behaviorNotes: string[] };
      if (
        !typedParams.summary?.agentBefore?.trim() ||
        !typedParams.summary.userFeedback?.trim() ||
        !typedParams.summary.agentAfter?.trim()
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: "The summary is required with all three fields (agentBefore, userFeedback, agentAfter) non-empty.",
            },
          ],
          details: undefined,
        };
      }
      captured = { notes: typedParams.behaviorNotes, summary: typedParams.summary };
      return {
        content: [{ type: "text" as const, text: `Extracted ${typedParams.behaviorNotes.length} notes` }],
        details: undefined,
        terminate: true,
      };
    },
  };

  // Build messages
  const messages = buildSingleUserMessage(userText);

  // Call shared LLM helper
  const result = await callPortraitLlm<ExtractionCapture>(
    messages,
    EXTRACTION_PROMPT,
    returnExtractionTool,
    () => captured ?? undefined,
    "Previous extraction failed. Please return valid JSON using return_extraction.",
    undefined,
    undefined,
    undefined,
    "extraction",
    1,
  );

  if (result === PAUSED) throw new Error("PAUSED");
  if (!result) {
    appendDebug(dumpPath, "\n=== Extraction Agent Output ===\n(none)\n");
    return { kind: "failed" };
  }
  const { notes, summary } = result;
  const rulesLines = notes.join("\n") || "(none)";
  const extractionOutput = [
    "\n=== Extraction Agent Output ===",
    `Agent before: ${summary.agentBefore}`,
    `User feedback: ${summary.userFeedback}`,
    `Agent after: ${summary.agentAfter}`,
    "Rules:",
    rulesLines,
    "",
  ].join("\n");
  appendDebug(dumpPath, extractionOutput);
  return { kind: "success", notes, summary, dumpPath };
}

/**
 * Post-extraction validation: re-evaluate extracted rules using summarized interaction context.
 * Rules that pass quality gates are returned (possibly refined).
 * Rules that fail are silently dropped.
 * Appends results to the extraction dump file.
 */
async function postExtractRules(
  rules: string[],
  summary: ExtractionSummary,
  dumpPath: string | null,
  modelOverride: string | undefined,
): Promise<ReviewOutcome> {
  if (rules.length === 0) return { kind: "success", notes: [] };

  const rulesBlock = rules.join("\n");
  const interactionBlock = [
    `<agent-before>\n${summary.agentBefore}\n</agent-before>`,
    `<user-feedback>\n${summary.userFeedback}\n</user-feedback>`,
    `<agent-after>\n${summary.agentAfter}\n</agent-after>`,
    `<rules>\n${rulesBlock}\n</rules>`,
  ].join("\n\n");
  appendDebug(
    dumpPath,
    `\n=== Post-Extraction Input ===
--- SYSTEM PROMPT ---
${POST_EXTRACTION_PROMPT}

--- TOOL ---
${JSON.stringify({ name: "return_post_extraction", description: "Return validated behavior notes.", input_schema: { type: "object", properties: { behaviorNotes: { type: "array", items: { type: "string" } } }, required: ["behaviorNotes"] } }, null, 2)}

--- USER MESSAGE ---
${interactionBlock}
`,
  );

  // Define return tool (same schema as extraction)
  let extractedNotes: string[] | null = null;

  const returnTool: AgentTool = {
    name: "return_post_extraction",
    label: "Return post-extraction results",
    description: "Return validated behavior notes.",
    parameters: Type.Object({
      behaviorNotes: Type.Array(Type.String()),
    }),
    execute: async (_toolCallId: string, params: unknown) => {
      const typedParams = params as { behaviorNotes: string[] };
      extractedNotes = typedParams.behaviorNotes;
      return {
        content: [{ type: "text" as const, text: `Validated ${typedParams.behaviorNotes.length} notes` }],
        details: undefined,
        terminate: true,
      };
    },
  };

  // Build messages
  const messages = buildSingleUserMessage(interactionBlock);

  // Call shared LLM helper
  const result = await callPortraitLlm<string[]>(
    messages,
    POST_EXTRACTION_PROMPT,
    returnTool,
    () => extractedNotes ?? undefined,
    "Previous post-extraction failed. Please return valid JSON using return_post_extraction.",
    modelOverride,
    undefined,
    undefined,
    "post_extraction",
    1,
  );

  if (result === PAUSED) throw new Error("PAUSED");
  // Append to extraction dump file with kept/rejected breakdown
  const resultLines = (result ?? []).join("\n") || "(none)";
  appendDebug(dumpPath, `\n=== Post-Extraction Output ===\n${resultLines}\n`);
  if (result === undefined) return { kind: "failed" };
  return { kind: "success", notes: result };
}
