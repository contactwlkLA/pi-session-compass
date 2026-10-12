# pi-session-compass — Stage continuation

Revision: **0.1.0** · Updated: **2026-10-11**

Select the first unchecked stage. A checked stage requires verified milestone evidence. Unchecked means not started, partial, or blocked; use the continuation fields below. Stop after that stage’s completion or a documented stopping condition.

- [ ] **S1 — Baseline:** [stage-1-task.md](stage-1-task.md) · M1 · NOT_STARTED
- [ ] **S2 — Termination and retries:** `stage-2-task.md` · M2 · NOT_STARTED · task file not yet created · ends with a user continue/stop decision
- [ ] **S3 — Recovery:** `stage-3-task.md` · M3 · NOT_STARTED · task file not yet created
- [ ] **S4 — Jev gate and limits:** `stage-4-task.md` · M4 · NOT_STARTED · task file not yet created
- [ ] **S5 — Quality and savings:** `stage-5-task.md` · M5 · NOT_STARTED · task file not yet created
- [ ] **S6 — Settings, acceptance, and handoff:** `stage-6-task.md` · M6 · NOT_STARTED · task file not yet created

## Continuation

- Active stage: **S1**
- Next unfinished step: **S1.T1.1 — inspect repository instructions and checkout**
- Last completed step: **none**
- Outcome: **NOT_STARTED**
- Blocker: **none identified; inspect the checkout first**
- Pending user inputs: **session JSONL to test; initial portrait/archive snapshot**
- Limits: **suggested at launch from the [compass.md](compass.md) run-type table; confirmed by the user for every live run**
- Smoke result (S1.T4): **pending**
- Baseline result (S1.T5): **pending**
- Continue/stop decision (end of S2): **pending**
- Evidence: **none yet**
- Milestone evidence: **M1–M6 pending**

At session exit, update these fields and task checkboxes. Record a short evidence reference alongside each completed stage. A cap/blocker leaves its stage unchecked and identifies the next unfinished task. Do not skip it. If the selected task file is missing, report the missing file and stop; do not invent it.

Stage meanings and dependencies: [plan.md](plan.md). Operating rules: [AGENTS.md](../AGENTS.md).

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.1.0 | 2026-10-11 | Initial committed draft. |
