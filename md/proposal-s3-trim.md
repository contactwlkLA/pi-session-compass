# Proposal — simple rollback for Stage 3 (architecture §6 cleanup, trimmed B-2)

Project: **pi-session-compass** · Revision: **0.1.0** · Status: **Draft — awaiting user approval**

Date: **2026-10-16**

**Why.** User direction (2026-10-15): "dont over-engineer crash-safe its not that important … we can always roll back to the last snapshot … all these are background data, not production data." Architecture §6 opens with "prefer simple rollback over exact mid-step continuity" but then specifies machinery that goes beyond it (a publication-intent boundary, a per-file edit guard, an interruption table, crash tests at every boundary). This proposal removes that machinery from the architecture, the plan, and the stage task, and leaves one small B-2 task.

**What already holds after B-1 (no new work):**

- Pending candidates survive failed extraction, review, and build, and a stopped run resumes them (S3-B1-01 to 03).
- Every examined trio ends in a snapshot that holds the scan position, the pending candidates, and copies of portrait.md, evicted.md and dropped.md (S3-B1-02b).
- Portrait files are written atomically (write to `.tmp`, then rename), so a crash never leaves a half-written file (src/storage.ts).
- A Git commit failure never drops candidates: the builder ignores the commit result (S3-B1-03 criterion 4).

**The one gap that remains:** a crash after a build wrote its files but before the snapshot that removes its candidates. The next run builds those candidates again. The builder sees the current portrait, which already holds those rules, so it normally skips or merges them. A rare duplicate is accepted; manual rollback covers anything worse.

## 1. architecture.md §6 — before / after

**Keep unchanged:** the §6 intro paragraph, "Snapshot" (except the publication-intent bullet), "Scan position", "Migration and reset".

**Snapshot, third bullet — remove:**

> - at most one publication intent: the intended digest of each portrait/archive file about to be written.

(The `publicationIntent` field stays in the stored state as `null` for format stability; nothing writes it.)

**Snapshot boundaries — replace the three-item list with:**

> 1. After a trio's candidates are saved together with the new scan position, in one snapshot. A successful empty extraction advances the scan position the same way without candidates; a failed extraction advances nothing.
> 2. After a build batch's files are written: the batch's candidates are removed, in one snapshot.

**Publishing a build — replace with:**

> Validate the builder's whole batch before writing anything: exactly one recognized action per submitted candidate; no duplicate, unknown, or missing candidate IDs; valid references; no conflicting operations. A valid all-skip batch completes without file writes. Write each affected file atomically, attempt the existing optional Git commit (a failure is recorded and never drops candidates), then take boundary 2.

**Restore on restart — replace the section (numbered steps and table) with "Recovery":**

> A restart needs no restore step. The newest complete snapshot holds the scan position and the pending candidates; the next run re-extracts what follows the position and builds what is pending. Portrait files are written atomically, so they are never half-written.
>
> If a crash falls between a build's file writes and boundary 2, the next run builds those candidates again; the builder sees the rules already in the portrait and normally skips or merges them. A rare duplicate rule is accepted: this is background data.
>
> To undo a bad state by hand, copy the portrait and archive files back from the newest snapshot (`snapshots/<CURRENT>/files/`) or use the portrait's Git history. Nothing restores files automatically, so external edits to the portrait are never overwritten by a restore.

**Also in §3's flowchart:** replace the nodes `I["Snapshot: publication intent"]` → `P["Write portrait files"]` → `A["Snapshot: acknowledge candidates"]` with `B -->|"valid complete decisions"| P["Write portrait files"]` → `A["Snapshot: remove built candidates"]`, and change `H["Stop; restore last snapshot on restart"]` to `H["Stop; resume from the last snapshot next run"]`.

## 2. plan.md Stage 3 — before / after

**S3.T2, last two sentences — replace** "Take snapshots at the three boundaries: … after publication completes." **with** "Take snapshots at two boundaries: after a trio's candidates are saved with the scan position, and after a build batch's files are written (removing its candidates)."

**S3.T4 — replace with:**

> **S3.T4 — Validate builds.** Strengthen whole-batch validation: exactly one action per candidate, valid references, and no conflicting operations. A valid all-skip batch completes without file writes. Git remains an optional audit layer; a Git failure never discards candidates.

**Verification — replace** the bullets "Crash after the first snapshot …", "Crash before, during, and after the portrait file writes …", "An external edit to a portrait file stops the restore …" **with:**

> - A run stopped after candidates were saved builds them next run without re-extraction.
> - Invalid builder output (missing, duplicate, or unknown candidate IDs; conflicting operations) is rejected before any write and retried; exhausted retries keep the candidates.

**M3 — replace** "restore invariants pass in isolated fixtures" **with** "pending-work and validation tests pass in isolated fixtures".

## 3. stage-3-task.md Part B — before / after

**B2 — replace items 1–6 with:**

> - [ ] **1.** Whole-batch validation: exactly one action per candidate; no duplicate, unknown, or missing candidate IDs; no conflicting operations. A valid all-skip batch completes without file writes.
> - [x] **2.** Snapshot boundaries: after a trio's candidates are saved with the scan position; after a build batch's files are written. *(bd56689, afc2712)*
> - [x] **3.** Git stays an optional audit layer; a Git failure never discards candidates. *(afc2712; buildPortrait ignores the commit result)*
> - [x] **4.** The harness reads the work state from the snapshot. *(4badf3a)*

**B3 — replace with:**

> - [ ] **1.** Invalid builder output and exhausted retries keep the candidates. *(a resumed stopped run is covered by tests/pending-build.test.ts)*
> - [x] **2.** File-mode runs leave pending candidates from other sources untouched. *(afc2712)*

**Protected text expected in Part B:** remove "the restore conflict report" (no restore). New validation messages go to the builder model, not the user; they follow the existing ones in `validateDecisions`, and CC will show their exact text for approval in the B-2 spec.

## 4. B-2 — one task (spec written after approval)

**S3-B2-01 — Whole-batch builder validation and all-skip without writes.** In `validateDecisions` (src/builder.ts), add: each of C1…Cn has exactly one decision (missing, duplicate, or unknown candidate references rejected); no two decisions merge into, or evict, the same existing position; no candidate is both inserted and merged. In `buildPortrait`/`applyDecisions`, a batch where every decision is `skip` returns a result without writing any file (today an empty decision list is treated as a failure; an all-skip list may rewrite unchanged files). Tests extend tests/builder.test.ts. Estimated one Pi session, medium.

**Dropped from B-2:** builder decision/write split (B2.1), publication intent (boundary b), restore with per-file edit guard (B2.4), crash tests at each boundary (B3.1, B3.3).

**Part C next.** Part C (locking, one-time migration with a legacy cutoff, lifecycle) should get the same simplicity check before its specs are written. Restore no longer exists, so C1.1 drops "restore" from the mutex list.

## Decision

Approve sections 1–4 as written, or mark changes. On approval CC applies the edits to architecture.md, plan.md and stage-3-task.md, retires this file into git history, and writes the S3-B2-01 spec.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.1.0 | 2026-10-16 | Draft for user approval. |
