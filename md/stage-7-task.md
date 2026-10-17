# Stage 7 — Fixes and deferred cleanup

Project: **pi-session-compass** · Revision: **0.2.0** · Status: **Approved (user, 2026-10-17)**

Date: **2026-10-17**

Parent: [handoff.md](handoff.md) (open bugs and deferred work). Operating rules: [AGENTS.md](../AGENTS.md). Bugs: [bugs.md](bugs.md).

**Goal (M7):** the small open bugs fixed, the deferred help text, prompt, and docs cleanup done, a one-place settings view chosen and built, and the remaining bugs investigated with a status for each. The gate stays `off`; the frozen policy f302de0ce97b is unchanged.

**Out of scope:** D4 (retuned policy; needs a new label round, so it waits for gate-log evidence from daily shadow use) and D5 (verified downgrade; replaced by one README instruction in S7-02).

| Task | Covers | Outcome | Who | Your part |
|---|---|---|---|---|
| S7-01 — Quick fixes | B11, B13, B14, B15, B20, B21 | Six small bugs fixed with tests | Pi | approve B15's new line (below) |
| S7-02 — Text batch | D1, D2, D6, D5 note | Settings and status help, debug path, prompt markers removed, harness doc, downgrade note | CC drafts, Pi applies | one approval round for all text |
| S7-03 — Settings in one place | D3 | Design note with two options, then the chosen one built | CC note, Pi codes | pick an option |
| S7-04 — Investigations | P4, B16, P11, B23, P2 | Each gets FIXED, WONTFIX, or a precise follow-up in bugs.md | CC, Pi for any fix | B23 live run limits, if needed |

## Fixed design

1. **One Pi session per task**, specs in a new stage-7-specs.md written per task, audit first (stage-3b.md Coder rules). Both full suites after each task; commit and push under standing approval (b).
2. **No behavior change** to the gate, extraction, building, snapshots, or scan except where a task names it.
3. **Protected text** is presented exact before/after and applied only after approval; S7-02 batches it into one round.

## Tasks

### S7-01 — Quick fixes (Pi)

- [ ] **B11** Harness results sheet: an `insert` line shows the candidate's rule text, not `C1` (scripts/compass/pipeline-boot.ts, the sheet label).
- [ ] **B13** A corrupt `hashes.json` in a start snapshot gives the existing snapshot refusal and exit code, not a stack trace (scripts/compass/snapshot.ts). No new text.
- [ ] **B14** Add `probe` to `RUN_TYPES` (scripts/compass/types.ts), matching the compass.md table.
- [ ] **B15** The confirmation line rounds minutes to one decimal. Protected text, proposed:
  - Before: `Limits: 100 model requests · 100000 ms (1.6666666666666667 min) wall clock`
  - After: `Limits: 100 model requests · 100000 ms (1.7 min) wall clock` (whole numbers stay whole: `5400000 ms (90 min)`)
- [ ] **B20** tests/reload-lifecycle.test.ts: give the fake context `mode: "tui"` so the test really holds the lock. If it then fails, stop and report: that is a lock bug, not a test fix.
- [ ] **B21** `evaluate policy`: the correction-miss bound uses the number of `correction: true` trios (held-out: `3 / 17`, not `3 / 30`).

### S7-02 — Text batch (CC drafts, user approves once, Pi applies)

- [ ] **D2a** Debug path: the `debugDumpLimit` description says `<cwd>/.pi/portrait/debug/`; the dumps go to `~/.pi/portrait/debug/` (src/schema.ts).
- [ ] **D2b** Remove the two `<!-- approved -->` markers inside the builder prompt (src/prompts.ts lines 111 and 133). They are sent to the model as prompt text. Check: the prompt equals the old one minus those two markers; no other prompt change.
- [ ] **D1** Settings and status help text: candidate-batch units for `buildingBatchSize` and `maintenanceBackfillBatchSize`; `/portrait:status` shows the last run's stop reason, pending candidates, and gate mode with the last run's skip and fallback counts. CC inventories the current strings first.
- [ ] **D6** Harness doc for selecting an input file, an independent output directory, the selected paths, and an explicit rescan. Proposed home: a new scripts/compass/README.md (the harness is not part of the plugin), not the product README.
- [ ] **D5 note** README Recovery gains one line: before downgrading to an older version, run `/portrait:collect` until nothing is pending, because older versions do not build pending candidates.

### S7-03 — Settings in one place (CC note, user picks, Pi codes)

- [ ] **1.** Design note (one page): option A, one config file in the style of src/gate-config.ts for models, limits, and cooldowns; option B, one settings screen listing every setting with its current value and source. Each option with what changes, its tests, and its risks.
- [ ] **2.** The chosen option built and documented in docs/CONFIGURATION.md (protected text presented first).

### S7-04 — Investigations (CC; Pi for any fix)

- [ ] **P4** Offline test: does a manual collect over two files stop after the first productive trio of the last file? If yes, fix in the scan loop (spec'd as its own Pi task); if no, mark FIXED with the test.
- [ ] **B16** Find the test that adds the listeners; fix the leak or raise the limit in that test only.
- [ ] **P11** Decide what the correct pairing is for a user record before a file's first assistant text; test the detector against it; fix or mark WONTFIX with the reason.
- [ ] **B23** Look for a recurrence in existing traces; if needed, one live run with `debugDumpLimit` > 0 (run type `compare`, limits suggested and user-confirmed at launch).
- [ ] **P2** Propose WONTFIX: zero-output responses come from the provider and are already counted.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.1.0 | 2026-10-17 | Draft: quick fixes, text batch, settings in one place, investigations; D4 and D5 out of scope. |
| 0.2.0 | 2026-10-17 | Approved by the user, including B15's new line. |
