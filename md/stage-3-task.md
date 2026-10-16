# Stage 3 — Preserve pending work

Project: **pi-session-compass** · Revision: **0.7.0** · Status: **Approved (user, 2026-10-14)**

Date: **2026-10-14**

Parent: [Development plan](plan.md), Stage 3. Contract: [Architecture](architecture.md) §6. Operating rules: [AGENTS.md](../AGENTS.md). Bugs and findings: [bugs.md](bugs.md).

**Goal:** interrupted or failed work resumes from the last snapshot without losing candidates, and the scanner reaches every trio (P7). This stage edits `src/` (scanner, collector, storage, builder, pipeline, lifecycle) plus tests and the harness. It adds no gate and no new settings.

Use [stage.md](stage.md) for continuation. The stage runs in three parts, **A → B → C**, one part per session. Each part ends with both full suites green, a commit and push, and a checkpoint with the user before the next part starts. All six plan tasks are in scope; none is deferred.

| Part | Plan tasks | Outcome | Estimate |
|---|---|---|---|
| A — Scan position and snapshot store | S3.T3, S3.T1 | Scanner reaches all 26 census trios; snapshot module exists and is tested, not yet wired | ~2 h |
| B — Pending work, build validation | S3.T2, S3.T4 | Candidates survive failures and crashes; builds publish only after whole-batch validation; a restart resumes from the snapshot | ~2.5 h |
| C — Locking, reset, lifecycle, M3 | S3.T5, S3.T6 | Reset takes the shared lock; lifecycle test; test hygiene (B18, B19); M3 verified | ~1 h |

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

## Part B — Pending work, build validation

### B1 — Typed outcomes and pending candidates (S3.T2)

- [x] **1.** Split extraction success-empty from failure. A failed extraction leaves the trio eligible for retry and is never recorded as an empty result. *(78b8ffd S3-B1-01; P10)*
- [x] **2.** Derive trio IDs from the session header ID and entry IDs (or a hash of the trio's own records), never a whole-file hash. Derive candidate IDs from trio ID and ordinal. *(78b8ffd S3-B1-01)*
- [x] **3.** Store pending candidates with source path and cwd. Preserve raw candidates before the optional post-review. In file mode, drain only candidates from the selected file. *(335eb32, bd56689, afc2712; the harness passes the file filter in S3-B1-04)*
- [x] **4.** A failed review or build keeps its candidates and stops cleanly. *(bd56689, afc2712; tests/pending-build.test.ts)*

### B2 — Build validation (S3.T4)

- [x] **1.** Whole-batch validation: exactly one action per candidate; no duplicate, unknown, or missing candidate IDs; no conflicting operations. A valid all-skip batch completes without file writes. *(S3-B2-01)*
- [x] **2.** Snapshot boundaries: after a trio's candidates are saved with the scan position; after a build batch's files are written. *(bd56689, afc2712)*
- [x] **3.** Git stays an optional audit layer; a Git failure never discards candidates. *(afc2712; buildPortrait ignores the commit result)*
- [x] **4.** The harness reads the work state from the snapshot. *(4badf3a)*

### B3 — Failure tests

- [x] **1.** Invalid builder output and exhausted retries keep the candidates. *(S3-B2-01; a resumed stopped run is covered by tests/pending-build.test.ts)*
- [x] **2.** File-mode runs leave pending candidates from other sources untouched. *(afc2712)*

Protected text expected in Part B: the failed review/build stop message. New validation messages go to the builder model, not the user; they follow the existing ones in `validateDecisions`, and their exact text is approved in the S3-B2-01 spec.

### Part B gate

- [x] **1.** Both full suites pass, raw results quoted. Commit and push. *(2026-10-16: `npm test` 23 files / 476 passed; `npm run test:compass` 8 files / 101 passed; single-worker 476 passed; S3-B2-01 commit)*
- [x] **2.** Sync this file, stage.md, and bugs.md. Report to the user and wait before Part C.

## Part C — Locking, migration, lifecycle, M3

One task, S3-C-01 ([stage-3c.md](stage-3c.md)), after the user-approved simplicity check (2026-10-16). No protected text.

### C1 — Shared locking, migration, and reset (S3.T5)

- [ ] **1.** Reset takes the collect lock, as collection and maintenance already do; a busy lock returns the existing "Collection already in progress." message.
- [x] **2.** With no snapshot, scan positions seed once from `processed-sessions.json`; the snapshot is the authority from its first save; the legacy file is a read-only mirror for the background counter. *(S3-B1-02a/02b)*
- [x] **3.** Reset clears the snapshot. *(S3-B1-02b)*
- [ ] **4.** New portrait repos ignore `snapshots/` (B18).

### C2 — Lifecycle and cancellation (S3.T6)

- [x] **1.** Stop, pause, reload, and shutdown do not release the collect lock while a writer is active; the run's `finally` releases it. *(existing src/index.ts behavior)*
- [x] **2.** Keep the existing "stop after current step" behavior with bounded remote calls.
- [ ] **3.** A test proves shutdown during a held collect lock keeps it held; existing cache and injection tests pass unchanged.

### C3 — Test hygiene

- [ ] **1.** tests/compass temp dirs are unique per run, and no test reads the live `~/.pi/portrait` (B19).

### Part C gate

- [ ] **1.** Both full suites pass, raw results quoted, plus single-worker and one concurrent run of both suites. Commit and push.
- [ ] **2.** Sync this file, stage.md, and bugs.md.

## Stage completion — M3

- [ ] **1.** All plan.md Stage 3 verification items pass on isolated fixtures (A1, B3, C tests). Old offsets cannot establish historical completeness.
- [ ] **2.** Both full suites pass, raw results quoted. Sync the task checks, stage.md, and bugs.md. Commit and push.
- [ ] **3.** Checkpoint with the user before S4.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.5.0 | 2026-10-16 | B1 done; B2.3 boundaries (a) and (c) and B2.6 done (S3-B1-01 to 04). |
| 0.6.0 | 2026-10-16 | Simple rollback (user-approved trim): B2 is build validation only; no publication intent, restore, edit guard, or per-boundary crash tests. Part B complete (S3-B2-01). |
| 0.7.0 | 2026-10-16 | Part C simplified to one task, S3-C-01 (user-approved): reset lock, B18, B19, lifecycle test; no migration machinery or protected text. |
