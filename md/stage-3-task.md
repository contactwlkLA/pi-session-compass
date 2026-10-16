# Stage 3 — Preserve pending work and safe restore

Project: **pi-session-compass** · Revision: **0.5.0** · Status: **Approved (user, 2026-10-14)**

Date: **2026-10-14**

Parent: [Development plan](plan.md), Stage 3. Contract: [Architecture](architecture.md) §6. Operating rules: [AGENTS.md](../AGENTS.md). Bugs and findings: [bugs.md](bugs.md).

**Goal:** interrupted or failed work restores the last snapshot and redoes the step without losing candidates, and the scanner reaches every trio (P7). This stage edits `src/` (scanner, collector, storage, builder, pipeline, lifecycle) plus tests and the harness. It adds no gate and no new settings.

Use [stage.md](stage.md) for continuation. The stage runs in three parts, **A → B → C**, one part per session. Each part ends with both full suites green, a commit and push, and a checkpoint with the user before the next part starts. All six plan tasks are in scope; none is deferred.

| Part | Plan tasks | Outcome | Estimate |
|---|---|---|---|
| A — Scan position and snapshot store | S3.T3, S3.T1 | Scanner reaches all 26 census trios; snapshot module exists and is tested, not yet wired | ~2 h |
| B — Pending work, publication, restore | S3.T2, S3.T4 | Candidates survive failures and crashes; builds publish only after validation; restart restores and redoes | ~2.5 h |
| C — Locking, migration, lifecycle, M3 | S3.T5, S3.T6 | Shared lock, one-time legacy import, reset covers the snapshot; lifecycle safe; M3 verified | ~1.5 h |

Pair setup (user, 2026-10-14): Pi writes the code from a per-part brief; Claude Code plans, reviews, verifies, and commits. Part A: [stage-3a-pi.md](stage-3a-pi.md) (Pi) and [stage-3a-cc.md](stage-3a-cc.md) (CC). Pi wrote Blocks A-1 to A-2b; the user then parked Pi over Pi/mimo configuration problems (bugs.md E5), so Claude Code coded A-2c and A-3, with the same brief and review gates. From Part B (user, 2026-10-15), Pi codes again from per-task specs and Claude Code plans, reviews, keeps the coder ledger, and commits; see [NOTES.md](NOTES.md) and [planner-prompt.md](planner-prompt.md).

No live model runs are planned in this stage; M3 is verified on isolated fixtures. Any live run would need its own user-confirmed limits.

Protected text: each part lists the user-facing strings it is expected to add. Present the exact text to the user and wait for approval before applying it.

Scope guard: any fix beyond these lists is raised with the user before work starts. P2 (zero-output responses) stays out of scope.

## Part A — Scan position and snapshot store

### A1 — Trio-boundary scan position (S3.T3, fixes P7)

- [x] **1.** Turn outputs/s2-t3/trio-loss-replay.ts into failing tests: adjacent trios across passes, and a restarted scan that must emit the same trios as an uninterrupted one. Add cases for append-at-EOF, a partial final line, multibyte Unicode before the boundary, and a source file that no longer matches its saved identity.
- [x] **2.** Save the scan position only at a trio boundary: the byte offset of the start of the trio's closing assistant record. The next pass reconstructs that assistant message as context before the next user turn. Offsets count bytes, not characters.
- [x] **3.** Narrow the parse-error catches in the scanner to parsing alone, so they cannot swallow extraction or storage failures (P8). A malformed complete record stops that file with diagnostics; a partial tail is left for the next pass (P9). Before resuming, verify source identity and a stored boundary digest; a truncated or rewritten source stops that file instead of rescanning.
- [x] **4.** Offline census check: the scanner's trio list on the S1 fixture matches the census (26 trios), with no model calls. Update P7 in bugs.md with the fix commit and evidence. *(evidence: 47a95b5; outputs/s3-a/scan-check.md: 26 of 26; tests/scan-position.test.ts, tests/jsonl-reader.test.ts)*

### A2 — Snapshot storage (S3.T1)

- [x] **1.** Implement the snapshot module per architecture.md §6: a directory under the output directory holding a schema version, state, and copies of the portrait and archive files.
- [x] **2.** Write each new snapshot beside the previous one, flush it, then switch to it; at startup load the newest complete snapshot.
- [x] **3.** A corrupt or unsupported snapshot stops processing with an error; it never resets progress. Unit tests cover complete, partial (interrupted write), corrupt, and unsupported-version snapshots.
- [x] **4.** The module is not yet wired into the pipeline; the existing checkpoint file stays the scan-position store until Part B. *(evidence: 2edb1ab src/snapshot-store.ts, tests/snapshot-store.test.ts 11 tests)*

Protected text expected in Part A: the truncated-or-rewritten source report; the malformed-record report; the corrupt snapshot error; the unsupported snapshot error.

### Part A gate

- [x] **1.** Both full suites pass (`npm test`, `npm run test:compass`), raw results quoted. Commit and push. *(2026-10-15: `npm test` 19 files / 420 passed; `npm run test:compass` 8 files / 91 passed; single-worker 420 passed; 47a95b5, 2edb1ab)*
- [x] **2.** Sync this file, stage.md, and bugs.md. Report to the user and wait before Part B.

## Part B — Pending work, publication, restore

### B1 — Typed outcomes and pending candidates (S3.T2)

- [x] **1.** Split extraction success-empty from failure. A failed extraction leaves the trio eligible for retry and is never recorded as an empty result. *(78b8ffd S3-B1-01; P10)*
- [x] **2.** Derive trio IDs from the session header ID and entry IDs (or a hash of the trio's own records), never a whole-file hash. Derive candidate IDs from trio ID and ordinal. *(78b8ffd S3-B1-01)*
- [x] **3.** Store pending candidates with source path and cwd. Preserve raw candidates before the optional post-review. In file mode, drain only candidates from the selected file. *(335eb32, bd56689, afc2712; the harness passes the file filter in S3-B1-04)*
- [x] **4.** A failed review or build keeps its candidates and stops cleanly. *(bd56689, afc2712; tests/pending-build.test.ts)*

### B2 — Validated publication and restore (S3.T4)

- [ ] **1.** Separate builder decision calculation from file writes.
- [ ] **2.** Whole-batch validation: exactly one action per candidate, valid references, no conflicting operations. A valid all-skip batch completes without file writes.
- [ ] **3.** *(B-1: (a) bd56689 and (c) afc2712 done; (b) in B-2)* Wire the snapshot (A2) as the scan-position and pending-work authority, taken at the three boundaries: (a) after a trio's candidates are saved with the scan position; (b) after builder decisions are validated and the intended file digests are recorded, before any portrait file is written; (c) after publication completes.
- [ ] **4.** On restart, restore the last snapshot's state and files and redo what followed it, after a per-file edit guard: each portrait/archive file must equal the snapshot copy or the recorded intended digest; otherwise stop and report a conflict without overwriting.
- [ ] **5.** Git stays an optional audit layer; a Git failure never discards candidates.
- [x] **6.** Update the harness trio counter and reports to read the scan position from the snapshot. *(S3-B1-04: start snapshots carry `snapshots/`; no harness code reads scan positions; receipts report a pipeline stop)*

### B3 — Crash and failure tests

- [ ] **1.** Simulated crashes at each snapshot boundary: after (a) resume from saved candidates without re-extraction; before, during, and after the portrait writes, restore the snapshot's files and redo the build with no duplicate insertion.
- [ ] **2.** Invalid builder output and exhausted retries keep the candidates; an optional-review failure preserves the raw rules.
- [ ] **3.** An external edit to a portrait file stops the restore with a conflict.
- [ ] **4.** File-mode runs leave pending candidates from other sources untouched.

Protected text expected in Part B: the restore conflict report; the failed review/build stop message.

### Part B gate

- [ ] **1.** Both full suites pass, raw results quoted. Commit and push.
- [ ] **2.** Sync this file, stage.md, and bugs.md. Report to the user and wait before Part C.

## Part C — Locking, migration, lifecycle, M3

### C1 — Shared locking, migration, and reset (S3.T5)

- [ ] **1.** Migration, reset, maintenance, and restore use the collection mutex.
- [ ] **2.** Import old offsets once, with a backup, reconstructed assistant context, and a legacy cutoff that prevents automatic re-extraction. Old offsets point past a closing assistant record, so the import moves them back to the trio boundary or records the cutoff.
- [ ] **3.** Preserve the existing portrait; the legacy progress files become nonauthoritative. Migration states that old offsets cannot establish historical completeness.
- [ ] **4.** The reset confirmation includes the snapshot; reset clears it under the mutex.
- [ ] **5.** Advisory background counters read the new scan position and never write progress.

### C2 — Lifecycle and cancellation (S3.T6)

- [ ] **1.** Stop, pause, reload, and shutdown do not release the mutation lock while a writer is active.
- [ ] **2.** Keep the existing "stop after current step" behavior with bounded remote calls; promise no immediate abort for steps that cannot be interrupted.
- [ ] **3.** Existing cache and injection semantics stay intact (existing tests pass unchanged).

### C3 — Lifecycle tests

- [ ] **1.** Migration imports old offsets once; a second start does not re-import.
- [ ] **2.** Reset clears the snapshot under the mutex; legacy checkpoint files are no longer authoritative.
- [ ] **3.** A stop or reload during a write leaves the lock held until the writer finishes.

Protected text expected in Part C: the migration notice (including the historical-completeness statement); the reset confirmation text with the snapshot.

## Stage completion — M3

- [ ] **1.** All plan.md Stage 3 verification items pass on isolated fixtures (B3, C3, A1 tests). Old offsets cannot establish historical completeness, and migration says so.
- [ ] **2.** Both full suites pass, raw results quoted. Sync the task checks, stage.md, and bugs.md. Commit and push.
- [ ] **3.** Checkpoint with the user before S4.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.3.0 | 2026-10-15 | Part A complete (A1, A2, gate). |
| 0.4.0 | 2026-10-15 | Pi codes again from Part B; CC plans, reviews, and keeps the coder ledger. |
| 0.5.0 | 2026-10-16 | B1 done; B2.3 boundaries (a) and (c) and B2.6 done (S3-B1-01 to 04). |
