# pi-session-compass — Stage continuation

Revision: **0.19.0** · Updated: **2026-10-16**

Select the first unchecked stage. A checked stage requires verified milestone evidence. Unchecked means not started, partial, or blocked; use the continuation fields below. Stop after that stage’s completion or a documented stopping condition.

- [x] **S1 — Baseline:** [stage-1-task.md](stage-1-task.md) · M1 · COMPLETE 2026-10-14 · baseline covers trios 1–20 of 26 by user decision · evidence outputs/s1-t5/baseline-attempt2-report.md
- [x] **S2 — Termination and retries:** [stage-2-task.md](stage-2-task.md) · M2 · COMPLETE 2026-10-14 · same 20 trios in 46 requests / 26.0 min (baseline 150 / 56.9 min) · user decision: proceed to S3 · evidence outputs/s2-t3/compare-report.md
- [x] **S3 — Recovery:** [stage-3-task.md](stage-3-task.md) · M3 · COMPLETE 2026-10-16 · user: proceed to S4 · Parts A, B, C done (simple rollback, user-approved trims); evidence outputs/s3-a/, outputs/s3-b/handoff/, outputs/s3-c/handoff/
- [x] **S4 — Jev gate and limits:** [stage-4-task.md](stage-4-task.md) · M4 · COMPLETE 2026-10-16 · user: proceed to S5 · specs in [stage-4-specs.md](stage-4-specs.md) · evidence outputs/s4/s4-03-wire-check.md
- [ ] **S5 — Quality and savings:** [stage-5-task.md](stage-5-task.md) · M5 · IN_PROGRESS · pilot approved 2026-10-16 (TxnHunter-3 + agy-sessions-3)
- [ ] **S6 — Settings, acceptance, and handoff:** `stage-6-task.md` · M6 · NOT_STARTED · task file not yet created

## Continuation

- Active stage: **S5**
- Next unfinished step: **S5-02c (reply codes; R1–R5, P34–P39 approved): Pi audits and codes in a FRESH session (should now start on flash). Then score the pilot with the reply-code set (user-confirmed limits) as D4 evidence. Labels (S5-03 item 2) wait for D4 (open)**
- Roles (user, 2026-10-15): **Pi is no longer parked. Pi codes, one model per Pi session (the user switches models between sessions). Claude Code plans, writes task specs, reviews, keeps the ledger (md/ledger.jsonl, schema md/ledger.schema.json), verifies, and commits; it writes no implementation. The coder comparison is a side quest: where it conflicts with the project, the project wins (resolutions in NOTES.md)**
- Last completed step: **S5-02b accepted first pass on mimo-v2.6-pro (labels.ts export/check, evaluate.ts policy/sweep; P40 approved); pilot extraction done (339/339, 249 with rules). Before that: S5-02a accepted first pass (8834981): extract command, shared model boot; S5-02c (reply codes, session-instrument idea offline) added and its R1–R5/P34–P39 approved; ledger gained unplanned_stops (980245b). Before that: S5-01 accepted first pass (875173f); pilot corpus frozen (fixtures/s5-pilot, seed s5-pilot: 30 sessions, 339 trios, dev 16/207, held-out 14/132); live gate scoring of all 339 (8.3 s, 339 requests, 9 no_lesson; outputs/s5/score-all/). Before that: S4-03 PASS (shadow smoke, 2 Jev calls scored, jev-1.13.0, no key in artifacts; outputs/s4/s4-03-wire-check.md); S4 gate green (549/123, single-worker, concurrent). Before that: S4-02 accepted first pass (mimo-v2.6-flash): src/gate-config.ts holds every gate value (policy hash unchanged, ad7880acdc3b); harness `--gate-mode`, gate request counting, receipt/trace/sheet gate records; npm test 549/549, test:compass 123/123. Probe (0a7ef53, live): 26 trios, 0 `no_lesson` at threshold 0.1**
- Outcome: **S2 COMPLETE: termination, capture reset and retry fixes; compare run 46 requests / 26.0 min on the pipeline's 20 trios; branch s1/harness**
- Blocker: **none**
- Pending user inputs: **none**
- User direction (2026-10-15/16): **do not over-engineer crash safety. Simple-rollback trim approved 2026-10-16 and applied to architecture.md §6, plan.md S3 and stage-3-task.md Part B: no publication intent, no automatic restore or edit guard, no per-boundary crash tests; B-2 = S3-B2-01. Part C gets the same simplicity check before its spec. Extraction cache and prefix runs wait for S5 (user, 2026-10-16)**
- Stage order: **plan order, S2.T1–T3 before the optional S2.T4 Jev probe (user decision 2026-10-14)**
- Limits: **suggested at launch from the [compass.md](compass.md) run-type table; confirmed by the user for every live run**
- Smoke result (S1.T4): **PASS** (2026-10-14, attempt 3, capped at 5 requests; outputs/s1-t4/smoke-result.md)
- Baseline result (S1.T5): **ACCEPTED, CAPPED** — 150 requests, 20 of 26 trios, 56.9 min; by user decision this is the S1 baseline: running past that budget is not acceptable, so the cap is itself the benchmark; later comparisons check coverage within 150 requests and per-trio rates on trios 1–20 (outputs/s1-t5/baseline-attempt2-report.md). Attempt 1 covered 2 trios (one pipeline pass; harness fixed in da9987a) Correction (S2.T3, bugs.md P7): the pipeline detects only 20 of the census's 26 trios, so the baseline reached every trio the pipeline can reach; "trios 1–20" is pipeline order, and six trios are lost to a scan bug, not to the cap.
- Continue/stop decision (end of S2): **proceed to S3 (user, 2026-10-14); S2.T4 Jev probe skipped; `TYPESAFE_API_KEY` not set, needed by S5 live runs at the latest**
- Evidence: **outputs/s2-t1/; outputs/s2-t3/; outputs/s1-t1/; outputs/s1-t2.3/; outputs/s1-t4/; outputs/s1-t5/; fixtures/sessions/ (frozen July seed + receipt); fixtures/snapshots/s1-start/; scripts/compass/ + tests/compass/**
- Milestone evidence: **M1 — md/stage-1-task.md T1–T5 and M1 evidence; outputs/ and fixtures/ are local (gitignored)**
- Harness launch: **`node_modules/.bin/jiti scripts/compass/run.ts execute …` (installed jiti; allowed in .claude/settings.local.json)**
- Bug journal: **[bugs.md](bugs.md) — add an entry when a bug is found; update status, fix commit, and evidence when it changes**

At session exit, update these fields and task checkboxes. Record a short evidence reference alongside each completed stage. A cap/blocker leaves its stage unchecked and identifies the next unfinished task. Do not skip it. If the selected task file is missing, report the missing file and stop; do not invent it.

Stage meanings and dependencies: [plan.md](plan.md). Operating rules: [AGENTS.md](../AGENTS.md).

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.17.0 | 2026-10-16 | S4 complete; S5 pilot plan approved. |
| 0.18.0 | 2026-10-16 | S5-01 done; pilot corpus frozen and scored. |
| 0.19.0 | 2026-10-17 | S5-02a done; S5-02c added; D4 open; extraction run live. |
