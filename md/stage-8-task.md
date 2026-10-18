# Stage 8 — Session report

Project: **pi-session-compass** · Revision: **0.1.0** · Status: **Draft for user review**

Date: **2026-10-18**

Parent: [plan.md](plan.md) (parked ideas from 2026-10-14; lesson-quality and behavior questions from S5). Operating rules: [AGENTS.md](../AGENTS.md). Bugs: [bugs.md](bugs.md).

**Goal (M8):** one harness command that reads a folder of Pi sessions (read-only) and writes one report: what the sessions cost, where the effort went, what compass learned from them, whether those lessons are good, and whether behavior changed after the portrait was loaded. Every number is counted from the logs or from a recorded classifier answer, never self-reported by an agent.

| Task | Covers | Outcome | Who | Your part |
|---|---|---|---|---|
| S8-01 — Metric definitions | every section | One page: each metric, its counting rule, and a real example from your sessions; the report's headings and labels | CC drafts | approve the definitions and the text |
| S8-02 — Log analytics | Effort, Tokens and cost, Checks, Bugs from reviews | `report` command, offline, per session and in total | Pi | none |
| S8-03 — Your interventions | corrections, hold-backs, approvals | Reply codes joined into the report | Pi; CC runs | confirm the Jev run's limits |
| S8-04 — Lessons | what compass learned, and its quality | Each extracted rule with its source trio; a graded sample | CC grades, Pi joins | spot-check the grades |
| S8-05 — Behavior | before vs after the portrait loaded | Correction and hold-back rates on development sessions, with counts | CC | none |

## Report sections (draft; S8-01 fixes the exact rules)

| Section | Metrics | Counted from |
|---|---|---|
| Effort | prompts, turns, wall time, model time, tool time | Pi log records and `durationMs` |
| Tokens and cost | input / output / cache read, peak context, cost | assistant `usage` |
| Checks | test, lint, and typecheck runs; failed runs; failures later fixed | bash tool calls and their results |
| Agent questions | turns that end by asking you something | final assistant text |
| Bugs from reviews | review findings, by severity, and how many the agent then fixed | a review step in the session that reports findings, followed by edits (rule and a hand-checked sample in S8-01) |
| Your interventions | corrections, hold-backs, approvals, task steps | reply codes (scripts/compass/questions/reply-codes-v1.json, Jev) |
| Lessons | rules extracted per session, each with its trio; grade good / vague / wrong | extraction cache (extract.ts) or a run's results sheet |
| Behavior | correction and hold-back rate per session, before and after the first `portrait-cache` entry | reply codes + Pi log custom entries |

## Fixed design

1. **Read-only input.** The command reads a session folder and writes only to `--output`. It never writes `~/.pi`.
2. **One tool.** The log counting moves into the repo (scripts/compass/report.ts) and replaces the local pi-session-report.py for the coder ledger too, so there is one counting rule.
3. **Offline first.** S8-02 needs no model. S8-03 is the only part with network requests (Jev, user-confirmed limits); the report shows its sections as "not scored" without them.
4. **No plugin change.** Harness only; src/, the gate, and the policy hash do not change.
5. **Protected text:** the report's headings, labels, and messages are approved in S8-01 before any coding.
6. **Honest gaps.** A section without enough data says so with its counts (for example, behavior with fewer than 5 development sessions after the portrait loaded).

## Tasks

- [ ] **S8-01** Metric definitions and report text (CC): each metric's counting rule with a real example; the "bugs from reviews" rule checked on a hand-labeled sample of review steps (precision and recall stated); the grading rubric for lessons; the report template. User approves.
- [ ] **S8-02** `report` command, log sections (Pi): Effort, Tokens and cost, Checks, Agent questions, Bugs from reviews; per session and total; markdown and JSONL; tests on frozen fixture logs. The ledger switches to it.
- [ ] **S8-03** Interventions (Pi, then a CC live run): the report reads score.ts reply-code output for the same folder; run type `evaluate`, limits suggested and user-confirmed at launch.
- [ ] **S8-04** Lessons (CC grades, Pi joins): rules joined to their source trios; CC grades a sample against the S8-01 rubric; the user spot-checks; the report shows grade counts with examples.
- [ ] **S8-05** Behavior (CC): before/after rates on development sessions only, with counts and the honest-gap rule; written into the report.

**Allowance:** 4–7 h, plus your approval of S8-01 and the S8-03 limits. Which session folder the first report covers is your pick at S8-03.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.1.0 | 2026-10-18 | Draft: session report (log analytics, interventions, lessons, behavior). |
