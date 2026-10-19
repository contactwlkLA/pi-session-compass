# pi-session-compass — Project initialization

Revision: **0.4.0** · State: **Stage 1 complete**

Date: **2026-10-11**

## Layout

AGENTS.md sits at the checkout root so Pi loads the rules automatically (unverified; checked in S1.T1.1). The upstream README.md stays at the root untouched as the product README. The planning documents, including compass.md, live in `md/`. Links inside `md/` reach AGENTS.md through `../`.

```text
checkout root/
├── README.md        upstream product README (unchanged)
├── AGENTS.md        operating rules, session-start routing, revisions
├── md/              planning documents (below)
├── src/             existing Portrait source; edited only as stages direct
├── scripts/         harness entry point, offline checks, table generators
├── fixtures/        frozen inputs: session JSONL, starting portrait/archive snapshots, hashes
├── outputs/         generated run artifacts, one subdirectory per run (never edited by hand)
└── package/dependency files   runtime evidence; verify locally
```

| File in `md/` | Role |
|---|---|
| [compass.md](compass.md) | Orientation, upstream attribution, run-type limits and the start-of-run confirmation rules |
| [stage.md](stage.md) | Stage checkboxes and continuation |
| [stage-1-task.md](stage-1-task.md) | Stage 1 execution checklist |
| [architecture.md](architecture.md) | Technical contracts |
| [plan.md](plan.md) | Stage sequence, tasks, verification and estimates |
| [timing.md](timing.md) | Estimate vs actual hours per stage; filled in by the user, not read at session start |
| [project-init.md](project-init.md) | This file |

Directories under `scripts/`, `fixtures/`, and `outputs/` are created as the stage that needs them runs; names inside them are chosen by S1.T2 and recorded in architecture.md. The `stage-N-task.md` files for later stages are added to `md/` when written.

## Initialize once

1. Identify the intended implementation checkout; inspect installed package/runtime information there before asking for missing materials.
2. Fill the Names table in [compass.md](compass.md) before any other work: the project and package name, the upstream it is based on and its attribution, the feature names, any upstream identifiers that stay, and the local folder. When the package keeps an upstream name, record that as a decision with the stage that renames it.
3. Place AGENTS.md at the checkout root and the other documents in `md/`; leave the upstream README.md alone. Merge AGENTS.md with existing repository rules, preserving unrelated instructions; resolve conflicts before dependent execution.
4. Verify document links. Read merged rules explicitly for the current session; refresh automatically loaded instructions as appropriate for the installed Pi version.
5. Read stage.md and the first unfinished stage task. Consult architecture/plan sections only when needed.

Stage 1 must build and verify the file selector and fully isolated output first, then verify request/deadline controls and the start-of-run confirmation offline, then run a live **smoke test** (confirms the harness runs and shows sample output), then a live **baseline** (the measurement). These capabilities are specified, not yet implemented. The user will identify the live session JSONL; synthetic fixtures can support independent offline work meanwhile. The starting portrait/archive snapshot needs an explicit selection. Limits are suggested at launch and confirmed by the user for every live run.

## Start or resume

From the checkout:

```bash
pi "Continue from md/stage.md. Execute only the first unfinished stage under AGENTS.md, update continuation, and stop at that stage boundary."
```

Unverified: this launch syntax, and the claim that Pi loads AGENTS.md automatically, were inherited from earlier drafts and are checked in S1.T1.1.

One session targets one stage. Interrupted/blocked work resumes the same stage. If the selected task file is missing, report it and stop; do not invent instructions. Every live run takes finite limits that the user confirms at the start; the compass.md run-type table supplies the suggested values, and the initial `smoke` row is **5 actual model requests and 15 minutes**. Preserve partial evidence and leave capped non-smoke work unchecked.

Expected Stage 1 evidence: source/runtime inventory, isolated selector/harness checks, offline limit and confirmation checks, smoke receipt with results sheet and PASS/FAIL, `baseline` run manifest, request traces, baseline receipt with running table, and task/stage status. M1 requires verified smoke and baseline completion, not merely an ended run; the S1 baseline is an accepted capped run (plan.md, M1 exception).

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.2.0 | 2026-10-12 | Added timing.md to the file table. |
| 0.3.0 | 2026-10-14 | State set to Stage 1 complete; noted the accepted capped S1 baseline. |
| 0.4.0 | 2026-10-18 | Setup step 2 fills the compass.md Names table before any other work. |
