# Stage 3 Part A — Pi coding brief

Project: **pi-session-compass** · Revision: **0.4.0** · Status: **Approved (user, 2026-10-14)**

Date: **2026-10-14**

> **Pi parked (user, 2026-10-14).** Pi delivered Blocks A-1, A-2a and A-2b. Claude Code codes the remaining blocks (A-2c, A-3) from this brief, with the same review gates; see bugs.md E5.

Parent: [stage-3-task.md](stage-3-task.md) Part A. Contract: [architecture.md](architecture.md) §6 "Snapshot" and "Scan position". Bugs: [bugs.md](bugs.md) P7, P8, P9. Reviewer's plan: [stage-3a-cc.md](stage-3a-cc.md).

**Roles.** You (Pi) write the code and tests. Claude Code (CC) reviews your diff, runs both full suites, runs an independent acceptance check, and commits. The user relays one block at a time.

## Rules for every block

- Do **only** the block you were given, then stop and send the report below. Do not start the next block.
- Edit only `src/` and `tests/` (not `tests/compass/`, not `scripts/`, not `md/`, not README/CONFIGURATION). Do not enter `./private`. Do not touch `~/.pi`.
- Do not commit, push, or run live model runs. Do not upgrade dependencies.
- User-facing strings: use **exactly** the approved strings in "Approved strings" below. Do not add or reword any other user-facing text; if you think one is needed, stop and ask in your report.
- Follow the surrounding code style. Comments describe behavior; no design-doc references (§N, P7, "S3") in source comments.
- Run `npx vitest run <your test files>` and `npm test` before reporting. If something fails twice after a fix attempt, stop and report it; do not keep trying.

**Report format (end of every block):**

```
Block: A-N
Files changed: <list>
Tests added: <file: test names>
npx vitest run <files>: <raw summary line>
npm test: <raw summary line>
Deviations from the brief: <none | list with reason>
Open questions: <none | list>
```

## Background (read once)

- `src/collector.ts` `streamAndExtract` reads a session JSONL with `readline` from `checkpoints[file].lastByte`, runs each record through `TrioDetector`, extracts each trio, and saves a checkpoint. `scanSessions` then overwrites the checkpoint with `prevByte + bytesScanned` (the end of the last record read).
- **P7:** that end-of-record checkpoint lies past the trio's closing assistant record. The next pass starts a fresh `TrioDetector`, which has no `lastAssistant`, so a trio that opens with that record is never emitted. 6 of 26 trios in the S1 fixture are lost this way.
- **P8:** the `try/catch` in the record loop wraps both `JSON.parse` and `tryExtractTrio`, so any non-PAUSED extraction, review, or save error is swallowed as a "malformed line".
- **P9:** byte counting uses decoded `line` lengths: unterminated final lines are consumed (+1 byte that does not exist), blank lines are not counted, CRLF counts one short.

**The invariant to implement.** The scan position for a file is always either `0` or the **byte offset of the start of the record that last set the detector's `lastAssistant`**. Starting a fresh detector at that record rebuilds exactly the state an uninterrupted detector has at that point (`lastAssistant` set, `lastUser` cleared or stale-approval only, which never completes a trio). After an emitted trio this is the start of its closing assistant record. At EOF it is the start of the last assistant-with-text record, so an appended user turn plus reply still completes the trio. If the pass set no `lastAssistant`, the position stays where the pass started.

## Block A-1 — Failing tests for the scan position (no `src/` changes)

Create `tests/scan-position.test.ts`. Build synthetic session JSONL in a temp dir (a `{"type":"session","id":...}` header line, then `{"type":"message","message":{role,content}}` records). Mock the extraction LLM the way `tests/extraction.test.ts` does, with a stub that returns one note for every trio (every trio productive, which forces a new pass after each trio with `maxResults = 1`).

Helper: `scanAll(file)` calls `scanSessions` repeatedly (each call = one pass, `maxResults = 1`) until it returns no results, collecting the `userFeedback` of each examined trio in order. Compare with `uninterrupted(file)`: one `TrioDetector` over all records.

Tests (each asserts `scanAll` equals `uninterrupted`, plus the stated extra):

1. **Adjacent trios:** A1 U1 A2 U2 A3 U3 A4 → 3 trios, none lost (P7).
2. **Approval and continuation turns** between trios: approval users never produce a trio; results equal.
3. **Multibyte Unicode** (emoji, CJK) in records before each boundary; results equal and every saved `lastByte` is the byte offset of a line start (check `buf[lastByte - 1] === 0x0A`, or `lastByte === 0`).
4. **Partial tail:** the file ends with half a record and no newline. The pass does not consume it (saved position ≤ its start). Then append the rest of the record plus a reply; the next pass emits the trio.
5. **Append at EOF:** scan to the end with a pending user turn (A1 U1, no reply); append A2; the next pass emits (A1, U1, A2).
6. **Blank lines and CRLF:** records separated by `\n\n` and by `\r\n`; positions stay on line starts; results equal.
7. **Source rewritten:** after a pass, replace the file with different content of equal or greater length. The next pass stops that file with the "rewritten" diagnostic (see Approved strings S1) and does not advance or reset its position.
8. **Truncated source:** shrink the file below the saved position → the same diagnostic, position unchanged.
9. **Malformed complete record** (newline-terminated, invalid JSON) → that file stops with the malformed diagnostic (S2); position stays before the record; other files continue.
10. **Errors are not swallowed (P8):** the extraction stub throws `new Error("boom")` → `scanSessions` rejects with "boom"; the saved position is still the previous boundary.

Expected now: tests 1, 3–10 fail (2 may pass). Report which fail and why, in one line each.

## Block A-2a — Byte-exact record reader (P9)

1. Create `src/jsonl-reader.ts` exporting an async generator `readCompleteRecords(filePath, startByte)` that yields `{ offset, length, text }` for each complete record: `offset` is the absolute byte offset of the record's first byte, `length` its byte length without the line ending (the `\n` and, for CRLF, the `\r`), `text` the UTF-8 decoding of exactly those bytes.
2. Read raw `Buffer` chunks from `startByte` (no `encoding` option), split on `0x0A`, carry an incomplete segment across chunk boundaries, and decode only after splitting. Strip one trailing `\r` from a record. Skip blank (or whitespace-only) records without yielding them; their bytes still count toward later offsets.
3. An unterminated final segment is a partial tail: never yield it.
4. Create `tests/jsonl-reader.test.ts`: offsets on LF, CRLF, and blank lines; multibyte characters split across a chunk boundary (use one record larger than the stream's 64 KiB read chunk, with multibyte characters around the boundary; the API has no chunk-size parameter, since the repo lint forbids optional parameters); a partial tail is not yielded; a later append completes it; a non-zero `startByte` at a line start.
5. Do not change `collector.ts` yet.

Expected: the new reader tests pass; Block A-1 tests are unchanged (still failing).

## Block A-2b — Trio-boundary scan position (P7)

1. In `streamAndExtract`, replace `readline` with `readCompleteRecords`. Keep the `try/catch` and PAUSED handling exactly as they are in this block (A-2c changes them).
2. **Detector boundary.** Make `TrioDetector` report whether the record just processed set `lastAssistant` (for example a returned flag or a getter); the change is additive and `countPendingTrios` behaves the same.
3. **Position.** `streamAndExtract` tracks `resumeByte`: the absolute offset of the record that last set `lastAssistant` (initially the start offset). It returns `resumeByte` and its **boundary digest**: sha256 hex of exactly the `length` bytes the reader reported for that record (no `\n`, no `\r`). Save it after each examined trio (replacing `saveMidFileCheckpoint(lastUserBytePos)`) and at the end of the pass. `scanSessions` stores the returned position directly; remove `prevByte + bytesScanned` as the position. Keep the KB/footer progress counters as they are.
4. **Checkpoint shape.** Extend `ScanCheckpoint` (src/types.ts) to `{ lastByte: number; boundaryDigest?: string; sessionId?: string }`. `sessionId` is the header's `id` (first record). Save both fields with every position. Old entries without `boundaryDigest` resume from `lastByte` as before (migration comes later). Do not verify them yet (A-2c).

Expected: Block A-1 tests 1–6 pass; 7–10 may still fail. Existing tests pass; update an existing test only if it asserted the old end-of-record checkpoint, and list each such change under Deviations.

## Block A-2c — Identity check, narrow catch, per-file stop (P8)

1. **Identity check before resuming** (only when `boundaryDigest` is present): the file's header `id` must equal `sessionId`, the file size must be ≥ `lastByte`, and the record starting at `lastByte` must hash to `boundaryDigest`. Otherwise stop that file with S1; do not change its checkpoint.
2. **Narrow the catch.** The `try/catch` covers only `JSON.parse`. A complete record that fails to parse stops that file with S2 (offset = the record's `offset`); the position stays at the last boundary. Extraction, review, `onTrio`, and checkpoint errors propagate; PAUSED keeps propagating as now.
3. **Stopping a file.** Throw a typed `ScanFileStopped` error (own class, carries `path` and the message) inside `streamAndExtract`; `scanSessions` catches only that class, calls `reportError(message, "scan error")` (src/error.ts, the existing route), skips the file for the rest of the pass, and continues with other files.

Expected: all Block A-1 tests pass, and all existing tests.

## Block A-3 — Snapshot store module (not wired)

Create `src/snapshot-store.ts` (not `snapshot.ts`; the harness already has `scripts/compass/snapshot.ts`) and `tests/snapshot-store.test.ts`.

- **Layout** under `<portraitDir>/snapshots/`: one directory per snapshot, `snap-<seq>` with a zero-padded increasing sequence number, and a `CURRENT` file naming the active one.
- **Content:** `manifest.json` = `{ schemaVersion: 1, seq, createdAt, files: { <relative name>: <sha256 hex> } }`, where `files` covers every file in the snapshot directory except `manifest.json` itself, including `state.json`; `state.json` = `{ scanPositions: Record<path, ScanCheckpoint>, pendingCandidates: [], publicationIntent: null }` (types exported; the last two fill in Part B); `files/` = copies of the portrait and archive files passed in by the caller.
- **`writeSnapshot(portraitDir, state, filePaths)`:** write into `snap-<seq>.tmp/`, fsync each file and the directory, rename to `snap-<seq>`, then replace `CURRENT` atomically (write tmp, fsync, rename). Keep the previous snapshot; delete older ones (keep the last two).
- **`loadLatestSnapshot(portraitDir)`:** returns `null` only when `snapshots/` does not exist. Read `CURRENT`, verify every file in the manifest by sha256, parse `state.json`. A leftover `.tmp` directory is ignored (an interrupted write; the previous snapshot stays current).
- **Errors:** missing/unreadable `CURRENT` target, digest mismatch, or unparsable JSON → throw `SnapshotCorruptError` with message S3 and the matching S3 reason. `schemaVersion !== 1` → `SnapshotUnsupportedError` with message S4. Never return `null` or an empty state for these cases.
- **Tests:** round trip; two writes keep the previous; interrupted write (`.tmp` left, `CURRENT` unchanged) loads the previous; corrupt file digest; corrupt JSON; missing target; unsupported version; `null` when no `snapshots/` directory.
- Do not call this module from the pipeline yet.

## Approved strings

Use these exactly (user-approved 2026-10-14). `${...}` are template-literal placeholders.

- **S1** — rewritten or truncated source: `Stopped scanning ${path}: the file was truncated or rewritten after it was last scanned. Its scan position was kept.`
- **S2** — malformed complete record: `Stopped scanning ${path}: malformed record at byte ${offset}.`
- **S3** — corrupt snapshot: `Portrait snapshot ${dir} is corrupt (${reason}); processing stopped. Progress was not reset.`
- **S3 reasons** (the `${reason}` in S3, one per case): active snapshot missing or unreadable (`CURRENT` absent, unreadable, or naming a missing directory): `the active snapshot is missing or unreadable`; digest mismatch: `checksum mismatch in ${file}`; unparsable JSON: `${file} is not valid JSON`. `${file}` is the name relative to the snapshot directory.
- **S4** — unsupported snapshot version: `Portrait snapshot ${dir} has unsupported schema version ${version}; processing stopped. Progress was not reset.`

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.2.0 | 2026-10-14 | Block A-2 split into A-2a (reader), A-2b (position), A-2c (identity, catch, stop). |
| 0.3.0 | 2026-10-14 | Pi audit fixes: chunk-boundary test without a size parameter; exact digest bytes for CRLF; manifest covers state.json; S3 reason texts (user-approved). |
| 0.4.0 | 2026-10-15 | Pi parked after A-2b; Claude Code codes A-2c and A-3 from this brief. |
