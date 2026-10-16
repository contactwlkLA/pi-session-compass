# Stage 3 Part C — Task spec (Pi codes, Claude Code reviews)

Project: **pi-session-compass** · Revision: **0.1.0** · Status: **Approved (user, 2026-10-16)**

Date: **2026-10-16**

Parent: [stage-3-task.md](stage-3-task.md) Part C. Contract: [architecture.md](architecture.md) §3 (mutex) and §6 (migration and reset). Bugs: [bugs.md](bugs.md) B18, B19.

**Coder rules, spec audit, and handoff format:** [stage-3b.md](stage-3b.md), section "Coder rules". They apply unchanged; the handoff goes to `outputs/s3-c/handoff/<task_id>-r<round>.md` and the audit to `outputs/s3-c/handoff/<task_id>-audit.md`.

**Relay.** One fresh Pi session: audit first, then code after CC's answers.

**Scope (user-approved simplicity check, 2026-10-16).** Part C is one task. Already true in the code and not re-done: shutdown and reload never release the collect lock mid-run (src/index.ts `session_shutdown`; the run's `finally` releases it; SQLite releases it on process death); legacy scan positions are seeded once from `processed-sessions.json` when no snapshot exists, and the snapshot is the authority from its first save (src/work-state.ts). Dropped: migration backup, legacy cutoff, reconstructed assistant context, migration notice, reset-confirmation text change. No protected text in Part C.

## S3-C-01 — Reset takes the collect lock; per-run test temp dirs; snapshots/ ignored; lifecycle test

**Read:** src/commands/reset.ts (whole), src/commands/maintenance.ts (whole; the lock pattern to copy), src/index.ts lines 100–125 (`acquireCollectLock`/`releaseCollectLock`) and 356–390 (`session_shutdown`), src/git.ts lines 55–85 (`initGit`), tests/portrait.test.ts `describe("reset")` (~line 1838), tests/reload-lifecycle.test.ts (whole, 140 lines), tests/compass/compass-harness.test.ts (whole), the `TEST_TMP` lines of tests/compass/start-snapshot.test.ts, running-table.test.ts, receipt-sink-errors.test.ts, validation-rounds-receipt.test.ts, and tests/compass/offline-boundary.test.ts lines 150–170.

**Where and how (CC's plan):**

1. **Reset takes the collect lock (src/commands/reset.ts).** After the existing `lockHeld` and `uiSelect` checks and **before** the confirmation dialog, read `globalThis.__piPortraitAcquireCollectLock` / `__piPortraitReleaseCollectLock`. When both exist: if `await acquire()` is false, return the existing maintenance string `"👤 Collection already in progress."` (byte-identical to src/commands/maintenance.ts) without opening the dialog; otherwise wrap everything from the dialog to the end (cancel, success, and failure paths) in `try { … } finally { release(); }`. When either is absent (only in unit tests; src/index.ts always installs them), reset runs as today without locking. Reset's own strings are unchanged.
2. **Per-run test temp dirs (B19).** In every tests/compass file that builds `TEST_TMP` as `outputs/test-tmp/<name>`, make it unique per test file run: `fs.mkdtempSync(path.join(ROOT, "outputs", "test-tmp", "<name>-"))` (create `outputs/test-tmp` first with `recursive: true`). Keep each file's existing `rmSync` cleanup of its own `TEST_TMP`; never remove the shared `outputs/test-tmp` root. offline-boundary.test.ts keeps scanning the whole `outputs/test-tmp` root (read-only), and must tolerate a subdirectory vanishing mid-scan (skip on `ENOENT`).
3. **No live portrait in tests (B19).** tests/compass/compass-harness.test.ts must not read `~/.pi/portrait`. Replace `LIVE_PORTRAIT_DIR` with a fake portrait dir built inside `TEST_TMP` in `beforeAll` (portrait.md, evicted.md, dropped.md, processed-sessions.json, portrait-state.json with small fixed contents, plus a `.git` directory holding one small file, so the existing `.git` filter in the hashes test still has something to filter). The "leaves the live portrait untouched" test becomes "leaves the source portrait untouched" against that dir, with the same assertions. Remove the `os.homedir()` import if unused.
4. **snapshots/ ignored in new portrait repos (B18, src/git.ts).** Add `snapshots/\n` to the `.gitignore` content `initGit` writes. Existing repos are not touched. Update any test that asserts the exact `.gitignore` content.
5. **Lifecycle test (tests/reload-lifecycle.test.ts).** Add one test, copying the existing boot pattern: after `session_start`, acquire the collect lock through `globalThis.__piPortraitAcquireCollectLock()` (expect `true`), call `session_shutdown`, then assert `__piPortrait.collectCancelled === true` and that `tryAcquireSqliteMutex(<collect lock path>)` returns `null` (still held); then `globalThis.__piPortraitReleaseCollectLock()` and assert a fresh `tryAcquireSqliteMutex` succeeds (release it).

**Edge cases to cover:** reset with the collect lock busy opens no dialog and changes no file; reset cancelled at the dialog releases the lock; reset failing inside (e.g. an unwritable portrait dir, or a throwing `writePortrait` via a read-only file) releases the lock; reset with the lock functions absent behaves exactly as today (the existing reset tests keep passing unchanged).

**Acceptance criteria:**

1. Reset acquires the collect lock before the dialog and releases it on every path; a busy lock returns `"👤 Collection already in progress."` with no dialog and no file change.
2. No test under tests/compass reads or copies `~/.pi/portrait`, and every tests/compass temp dir is unique per test-file run.
3. `initGit` writes `snapshots/` into `.gitignore`.
4. `session_shutdown` during a held collect lock leaves it held and sets `collectCancelled`; the test proves it.
5. Tests in tests/portrait.test.ts `describe("reset")` (set the two lock globals with `vi.fn`-style stubs and delete them in `finally`): busy lock → message, no dialog call, portrait.md unchanged; free lock + "Yes, reset" → release called once; free lock + "Cancel" → release called once; acquire never called twice.
6. Existing tests pass. Run the B19 check below.

**Allowed scope:** src/commands/reset.ts, src/git.ts (the `.gitignore` content only), tests/portrait.test.ts (`describe("reset")` and any exact-`.gitignore` assertion), tests/reload-lifecycle.test.ts, tests/compass/*.test.ts, any tests/*.test.ts that asserts the exact `.gitignore` content.

**Constraints:** no new user-facing strings; reset's existing strings and the maintenance string unchanged. No changes to src/index.ts, the lock module, or the pipeline.

**Verification:**

```
npx vitest run tests/portrait.test.ts tests/reload-lifecycle.test.ts tests/collect-lock.test.ts
npm test
npm run test:compass
npm test & npm run test:compass & wait
```

The last line runs both suites at once (the B19 trigger); paste both results.

## CC review and gate (not for the coder)

Review per planner-prompt.md Step 2; ledger entry in md/ledger.jsonl. Check: the lock is taken before the dialog and released in a `finally` that covers cancel; the busy string is byte-identical to maintenance's; no `os.homedir()` or `.pi` path left in tests/compass; `TEST_TMP` cleanup never removes the shared root. Gate: `npm test`, `npm run test:compass`, `npx vitest run --maxWorkers=1`, and one concurrent run of both suites; then B18 and B19 FIXED in bugs.md, stage-3-task.md Part C and M3 checked, stage.md synced, commit and push. Stage 3 then closes with a checkpoint with the user before S4.

Planner difficulty: easy.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.1.0 | 2026-10-16 | S3-C-01 spec after the user-approved Part C simplicity check. |
