# Stage 3 Part A — Claude Code plan (planner and reviewer)

Project: **pi-session-compass** · Revision: **0.3.0** · Status: **Approved (user, 2026-10-14)**

Date: **2026-10-14**

> **Pi parked (user, 2026-10-14).** From Block A-2c, Claude Code both codes (from the brief) and reviews (this plan). The relay steps no longer apply; every other check stays.

Parent: [stage-3-task.md](stage-3-task.md) Part A. Pi's brief: [stage-3a-pi.md](stage-3a-pi.md). Operating rules: [AGENTS.md](../AGENTS.md).

**Roles.** Pi codes from the brief, one block per relay. CC plans, reviews each diff in the repo, verifies with full suites and an independent check, keeps the docs, and commits under the standing approval. The user relays blocks and approves protected text.

**Relay convention.** CC says **"Tell Pi: Block A-N"** with the exact line to paste. Nothing else in CC's messages is meant for Pi.

## Before Block A-1

- [x] **1.** User approves stage-3-task.md, this plan, the Pi brief, and strings S1–S4. Fill the approved strings into the brief; set all three docs to approved. *(user approved 2026-10-14)*
- [x] **2.** Commit and push the docs (and bugs.md P8–P10). Record the start commit for Part A. *(2ebb50a)*

## Per block: review loop

For each block A-1, A-2a, A-2b, A-2c, A-3:

- [ ] **1.** Relay line: `Read md/stage-3a-pi.md and do Block A-N only; stop and send the report.`
- [ ] **2.** On Pi's report: `git status` and `git diff` against the last commit. Files outside the block's allowed paths → reject.
- [ ] **3.** Review against the block checklist below. Run Pi's test files with `npx vitest run`.
- [ ] **4.** Run `npm test` and `npm run test:compass` in full; quote the raw results.
- [ ] **5.** Pass → save the reviewed diff to outputs/s3-a/<block>.patch and update the checkboxes in stage-3-task.md. A-1's tests fail by design until A-2c, so A-1 through A-2c are committed together once A-2c turns both suites green (standing approval b); A-3 commits on its own. Fail → one precise correction block for Pi. At most two correction rounds per problem, then report to the user.
- [ ] **6.** Record any new bug in bugs.md when found.

### Checklist A-1 (tests only)

- Only tests/ changed. Each of the 10 cases exists and asserts what the brief says.
- Failures are for the expected reason (lost trio, mid-record offset, swallowed error), not setup errors.
- The extraction mock does not make real model calls; temp dirs are cleaned up.

### Checklist A-2a (reader)

- Only src/jsonl-reader.ts and its test added; collector.ts untouched.
- No `encoding` on the stream; decoding after splitting; offsets exact on LF, CRLF, blank lines, and multibyte characters across chunks.
- Partial tail never yielded.

### Checklist A-2b (position)

- Saved positions are always 0 or a line start of an assistant-with-text record; no remaining `prevByte + bytesScanned` position arithmetic.
- Digest and `sessionId` saved with every position; legacy entries resume as before.
- `countPendingTrios` unchanged in behavior; `TrioDetector` change is additive.
- The catch is untouched in this block. A-1 tests 1–6 pass.

### Checklist A-2c (identity, catch, stop)

- The `try` covers only `JSON.parse`; PAUSED and all extraction/save errors propagate.
- Identity check runs only when `boundaryDigest` is present.
- `ScanFileStopped` is caught only in `scanSessions`, reported via `reportError`, position unchanged, other files continue.
- Strings S1, S2 match the approved text exactly. All A-1 tests pass.

### Checklist A-3 (snapshot store)

- Write order: tmp dir → fsync → rename → `CURRENT` replaced atomically. Previous snapshot kept.
- Corrupt and unsupported cases throw; `null` only when `snapshots/` is absent.
- Not imported anywhere in the pipeline yet.
- Strings S3, S4 match the approved text exactly.

## Independent acceptance (CC, after A-2c)

- [x] **1.** Write outputs/s3-a/scan-check.ts: copy the S1 fixture to a temp session root, run the production `scanSessions` pass by pass with a stub extractor that makes every trio productive (the worst case for P7), and list the examined trios.
- [x] **2.** Compare with the census (scripts/compass/census.ts) on the same file: expect **26 of 26**, the same trios in the same order. Also run it with every trio unproductive; expect 26 again.
- [x] **3.** Re-run outputs/s2-t3/trio-loss-replay.ts logic against the new code path; record the result in outputs/s3-a/scan-check.md.
- [x] **4.** Update P7, P8, P9 in bugs.md: FIXED with commit and evidence.

No live model runs in Part A.

Result: 26 of 26 in both variants; A-1 to A-2c committed in 47a95b5 (outputs/s3-a/scan-check.md).

## Part A gate

- [ ] **1.** Both full suites green, quoted raw, plus one single-worker run (`npx vitest run --maxWorkers=1`, bugs.md B17). Everything committed and pushed.
- [ ] **2.** Sync stage-3-task.md (A1, A2, gate), stage.md (last step, next step: Part B), bugs.md; bump revisions of changed docs.
- [ ] **3.** Write the handoff (~/handoff-*.md) after the gates pass.
- [ ] **4.** Report to the user: Done/Now/Next, scan-check result, test counts, open items. Wait before Part B.

## Risks to watch

- **Footer and KB progress** use the byte counters being changed; check the footer tests still mean the same thing.
- **Background counter** (`countPendingTrios`) starts from the new position with a fresh detector; by the invariant its counts stay consistent. Its own byte counting has the P9 pattern; leave it for Part C (C1.5) unless a test shows a wrong count.
- **Harness** reads checkpoint files only through the start snapshot copy; confirm `npm run test:compass` stays green.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.2.0 | 2026-10-14 | Review checklists follow the A-2 split (A-2a, A-2b, A-2c). |
| 0.3.0 | 2026-10-15 | Pi parked; acceptance done (26 of 26); gate adds a single-worker run (B17). |
