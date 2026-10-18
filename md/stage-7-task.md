# Stage 7 — Fixes and deferred cleanup

Project: **pi-session-compass** · Revision: **0.8.0** · Status: **Approved (user, 2026-10-17)**

Date: **2026-10-18**

Parent: [handoff.md](handoff.md) (open bugs and deferred work). Operating rules: [AGENTS.md](../AGENTS.md). Bugs: [bugs.md](bugs.md).

**Goal (M7):** the small open bugs fixed, the deferred help text, prompt, and docs cleanup done, a one-place settings view chosen and built, and the remaining bugs investigated with a status for each. The gate stays `off`; the frozen policy f302de0ce97b is unchanged.

**Out of scope:** D4 (retuned policy; needs a new label round, so it waits for gate-log evidence from daily shadow use) and D5 (verified downgrade; replaced by one README instruction in S7-02).

| Task | Covers | Outcome | Who | Your part |
|---|---|---|---|---|
| S7-01 — Quick fixes | B11, B13, B14, B15, B20, B21 | Six small bugs fixed with tests | Pi | approve B15's new line (below) |
| S7-02 — Text batch | D1, D2, D6, D5 note | Settings and status help, debug path, prompt markers removed, harness doc, downgrade note | CC drafts, Pi applies | one approval round for all text |
| S7-03 — Settings in one place | D3 | Design note with options, then the chosen ones built | CC note, Pi codes | pick options |
| S7-04 — Investigations | P4, B16, P11, B23, P2 | Each gets FIXED, WONTFIX, or a precise follow-up in bugs.md | CC, Pi for any fix | B23 live run limits, if needed |

## Fixed design

1. **One Pi session per task**, specs in a new stage-7-specs.md written per task, audit first (stage-3b.md Coder rules). Both full suites after each task; commit and push under standing approval (b).
2. **No behavior change** to the gate, extraction, building, snapshots, or scan except where a task names it.
3. **Protected text** is presented exact before/after and applied only after approval; S7-02 batches it into one round.
4. **Spot mutants at every review** (planner-prompt.md Step 2, user 2026-10-18): 2–3 hand mutants per task, recorded in the ledger.

## Tasks

### S7-01 — Quick fixes (Pi)

- [x] **B11** Harness results sheet: an `insert` line shows the candidate's rule text, not `C1` (scripts/compass/pipeline-boot.ts, the sheet label).
- [x] **B13** A corrupt `hashes.json` in a start snapshot gives the existing snapshot refusal and exit code, not a stack trace (scripts/compass/snapshot.ts). No new text.
- [x] **B14** Add `probe` to `RUN_TYPES` (scripts/compass/types.ts), matching the compass.md table.
- [x] **B15** The confirmation line rounds minutes to one decimal. Protected text, proposed:
  - Before: `Limits: 100 model requests · 100000 ms (1.6666666666666667 min) wall clock`
  - After: `Limits: 100 model requests · 100000 ms (1.7 min) wall clock` (whole numbers stay whole: `5400000 ms (90 min)`)
- [x] **B20** tests/reload-lifecycle.test.ts: give the fake context `mode: "tui"` so the test really holds the lock. If it then fails, stop and report: that is a lock bug, not a test fix.
- [x] **B21** `evaluate policy`: the correction-miss bound uses the number of `correction: true` trios (held-out: `3 / 17`, not `3 / 30`).

### S7-02 — Text batch (CC drafts, user approves once, Pi applies)

- [x] **D2a** Debug path: the `debugDumpLimit` description says `<cwd>/.pi/portrait/debug/`; the dumps go to `~/.pi/portrait/debug/` (src/schema.ts).
- [x] **D2b** Remove the two `<!-- approved -->` markers inside the builder prompt (src/prompts.ts lines 111 and 133). They are sent to the model as prompt text. Check: the prompt equals the old one minus those two markers; no other prompt change.
- [x] **D1** Settings and status help text: candidate-batch units for `buildingBatchSize` and `maintenanceBackfillBatchSize`; `/portrait:status` shows the gate mode with the number of logged checks, and the pending candidates. The last run's stop reason is dropped (it is not stored today; user, 2026-10-17). Text approved 2026-10-17 (stage-7-specs.md S7-02).
- [x] **D6** Harness doc for selecting an input file, an independent output directory, the selected paths, and an explicit rescan. Proposed home: a new scripts/compass/README.md (the harness is not part of the plugin), not the product README.
- [x] **D5 note** README Recovery gains one line: before downgrading to an older version, run `/portrait:collect` until nothing is pending, because older versions do not build pending candidates.

### S7-03 — Settings in one place (CC note, user picks, Pi codes)

- [x] **1.** Design note (one page): option A, one config file in the style of src/gate-config.ts for models, limits, and cooldowns; option B, one settings screen listing every setting with its current value and source. Each option with what changes, its tests, and its risks. *Done 2026-10-18: outputs/s7/s7-03-design-note.md; CC added option C (docs only); the user chose A, B, and C and approved their text (stage-7-specs.md S7-03).*
- [x] **2.** The chosen options built and documented in docs/CONFIGURATION.md (protected text presented first): A, the internal constants in src/plugin-config.ts; B, `/portrait:config`; C, a fixed-values and environment section in docs/CONFIGURATION.md. *Done 2026-10-18: accepted first pass (outputs/s7/handoff/S7-03-r1.md).*

### S7-04 — Investigations (CC; Pi for any fix)

- [x] **T1** Tests for the S7-03 spot-mutant survivors (no source change): an empty `PI_PORTRAIT_*` env var shows `· default`; `portrait:config` is registered with its approved description; the lock poll and the footer timer use `PLUGIN_CONFIG.lockPollMs` and `PLUGIN_CONFIG.footerRefreshMs`. Each new test kills its mutant (CC re-runs the mutants at review). *Done 2026-10-18: 4 tests, 4 of 4 mutants killed (outputs/s7/handoff/S7-04-T1-r1.md).*
- [x] **T2** Fixes for P4, P11, and B16 in one Pi task (user 2026-10-18; stage-7-specs.md S7-04 T2). *Done 2026-10-18: accepted in round 2 (round 1 added B24, an open read stream; fixed in round 2); outputs/s7/handoff/S7-04-T2-r1.md, -r2.md.*
- [x] **P4** Offline test: does a manual collect over two files stop after the first productive trio of the last file? If yes, fix in the scan loop (spec'd as its own Pi task); if no, mark FIXED with the test.
- [x] **B16** Find the test that adds the listeners; fix the leak or raise the limit in that test only.
- [x] **P11** Decide what the correct pairing is for a user record before a file's first assistant text; test the detector against it; fix or mark WONTFIX with the reason.
- [x] **B23** Look for a recurrence in existing traces; if needed, one live run with `debugDumpLimit` > 0 (run type `compare`, limits suggested and user-confirmed at launch). *Done 2026-10-18: duplicate of P2, found in existing traces; no live run (bugs.md).*
- [x] **P2** Propose WONTFIX: zero-output responses come from the provider and are already counted. *Done 2026-10-18: WONTFIX, user-approved (bugs.md).*

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.6.0 | 2026-10-18 | Spot mutants at every review; S7-04 T1 adds the tests for the S7-03 survivors. |
| 0.7.0 | 2026-10-18 | S7-04: P2 WONTFIX, B23 closed; T2 fixes P4, P11, B16. |
| 0.8.0 | 2026-10-18 | S7-04 T2 done: P4, P11, B16 fixed; B24 found and fixed in review. |
