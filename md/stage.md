# pi-session-compass — Stage continuation

Revision: **0.3.0** · Updated: **2026-10-14**

Select the first unchecked stage. A checked stage requires verified milestone evidence. Unchecked means not started, partial, or blocked; use the continuation fields below. Stop after that stage’s completion or a documented stopping condition.

- [x] **S1 — Baseline:** [stage-1-task.md](stage-1-task.md) · M1 · COMPLETE 2026-10-14 · baseline covers trios 1–20 of 26 by user decision · evidence outputs/s1-t5/baseline-attempt2-report.md
- [ ] **S2 — Termination and retries:** `stage-2-task.md` · M2 · NOT_STARTED · task file not yet created · ends with a user continue/stop decision
- [ ] **S3 — Recovery:** `stage-3-task.md` · M3 · NOT_STARTED · task file not yet created
- [ ] **S4 — Jev gate and limits:** `stage-4-task.md` · M4 · NOT_STARTED · task file not yet created
- [ ] **S5 — Quality and savings:** `stage-5-task.md` · M5 · NOT_STARTED · task file not yet created
- [ ] **S6 — Settings, acceptance, and handoff:** `stage-6-task.md` · M6 · NOT_STARTED · task file not yet created

## Continuation

- Active stage: **S2**
- Next unfinished step: **S2 — create stage-2-task.md with the user from plan.md Stage 2 (missing task file blocks S2 work)**
- Last completed step: **S1 (T1–T5, M1)**
- Outcome: **S1 COMPLETE: harness, smoke PASS, baseline on trios 1–20; branch s1/harness**
- Blocker: **stage-2-task.md does not exist**
- Pending user inputs: **approval of stage-2-task.md**
- Stage order: **plan order, S2.T1–T3 before the optional S2.T4 Jev probe (user decision 2026-10-14)**
- Limits: **suggested at launch from the [compass.md](compass.md) run-type table; confirmed by the user for every live run**
- Smoke result (S1.T4): **PASS** (2026-10-14, attempt 3, capped at 5 requests; outputs/s1-t4/smoke-result.md)
- Baseline result (S1.T5): **ACCEPTED, CAPPED** — 150 requests, 20 of 26 trios, 56.9 min; by user decision this is the S1 baseline and later comparisons use trios 1–20 (outputs/s1-t5/baseline-attempt2-report.md). Attempt 1 covered 2 trios (one pipeline pass; harness fixed in da9987a)
- Continue/stop decision (end of S2): **pending**
- Evidence: **outputs/s1-t1/; outputs/s1-t2.3/; outputs/s1-t4/; outputs/s1-t5/; fixtures/sessions/ (frozen July seed + receipt); fixtures/snapshots/s1-start/; scripts/compass/ + tests/compass/**
- Milestone evidence: **M1 — md/stage-1-task.md T1–T5 and M1 evidence; outputs/ and fixtures/ are local (gitignored)**
- Harness launch: **`node_modules/.bin/jiti scripts/compass/run.ts execute …` (installed jiti; allowed in .claude/settings.local.json)**
- Parked ideas (not in the plan): **session-length signal from the census trio count; corrections-per-session trend across ~/.pi/agent/sessions (free, offline); Jev per-trio probabilities as usage analytics**
- Known harness gap: **results-sheet builder lines label inserts by candidate ID (`[insert] C1`); the rule text appears in the final diff**

At session exit, update these fields and task checkboxes. Record a short evidence reference alongside each completed stage. A cap/blocker leaves its stage unchecked and identifies the next unfinished task. Do not skip it. If the selected task file is missing, report the missing file and stop; do not invent it.

Stage meanings and dependencies: [plan.md](plan.md). Operating rules: [AGENTS.md](../AGENTS.md).

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.3.0 | 2026-10-14 | S1 complete: by user decision the capped baseline (20 of 26 trios) is the baseline; S2 in plan order; parked ideas recorded; next step creates stage-2-task.md. |
| 0.2.8 | 2026-10-14 | T5 baseline attempt 2 capped (incomplete, 20 of 26 trios); awaiting the user's limit decision. |
| 0.2.7 | 2026-10-14 | T4 smoke PASS (attempt 3, after the discovery-root and cap-refusal repairs); next step T5.1. |
| 0.2.6 | 2026-10-14 | Decisions recorded: maintenance backfill calls are tagged "maintenance"; the harness launches with `node --import jiti/register` (installed jiti, no package change); smoke limits approved. |
| 0.2.5 | 2026-10-14 | T3.7 completed (running table; strings approved); next step T4. |
| 0.2.4 | 2026-10-14 | Pending inputs: added the maintenance backfill stage-tag decision. |
| 0.2.3 | 2026-10-14 | T3.6 completed (harness strings approved and applied); next step T3.7. |
| 0.2.2 | 2026-10-14 | T3.2 completed; next step T3.6. |
| 0.2.1 | 2026-10-14 | T2.3 completed; next step T3.2. |
| 0.2.0 | 2026-10-12 | S1 in progress on s1/harness; completed: T1.1–T1.6, T2.1–T2.2, T2.4–T2.6, T3.1, T3.3–T3.5, T3.8. Open: T2.3 (starting-portrait confirmation), T3.2 (validation-round tag), T3.6 (confirmation strings), T3.7 (baseline running table). Blocker: user decisions. |
| 0.1.0 | 2026-10-11 | Initial committed draft. |
