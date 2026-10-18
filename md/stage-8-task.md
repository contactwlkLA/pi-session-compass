# Stage 8 — Session report

Project: **pi-session-compass** · Revision: **0.8.0** · Status: **Approved (user, 2026-10-18)**

Date: **2026-10-18**

Parent: [plan.md](plan.md) (parked ideas from 2026-10-14; lesson-quality and behavior questions from S5). Operating rules: [AGENTS.md](../AGENTS.md). Bugs: [bugs.md](bugs.md).

**Goal (M8):** one harness command that reads one session file or one session directory (read-only) and writes one report: what the sessions cost, where the effort went, what compass learned from them, whether those lessons are good, and whether behavior changed after the portrait was loaded. Every number is counted from the logs or from a recorded classifier answer, never self-reported by an agent.

| Task | Covers | Outcome | Who | Your part |
|---|---|---|---|---|
| S8-01 — Metric definitions | every section | One page: each metric, its counting rule, and a real example from your sessions; the report's headings and labels | CC drafts | approve the definitions and the text |
| S8-02 — Log analytics | Effort, Tokens and cost, Checks, Agent questions | `report` command, offline, per session and in total | Pi | none |
| S8-03 — Your interventions | corrections, hold-backs, approvals | Reply codes joined into the report | Pi; CC runs | confirm the Jev run's limits |
| S8-04 — Lessons | what compass learned, and its quality | Each extracted rule with its source trio; a graded sample | CC grades, Pi joins | spot-check the grades |
| S8-05 — Behavior | before vs after the portrait loaded | Correction and hold-back rates on development sessions, with counts | CC | none |

## Report sections (draft; S8-01 fixes the exact rules)

| Section | Metrics | Counted from |
|---|---|---|
| Effort | prompts, turns, wall time, model time, tool time | the session log's records and timings |
| Tokens and cost | input / output / cache read, peak context, cost | assistant `usage` (cost where the log records it) |
| Checks | test, lint, and typecheck runs; failed runs; failures later fixed | bash tool calls and their results |
| Agent questions | turns that end by asking you something | final assistant text |
| Your interventions | corrections, hold-backs, approvals, task steps | reply codes (scripts/compass/questions/reply-codes-v1.json, Jev) |
| Lessons | rules extracted per session, each with its trio; grade good / vague / wrong | extraction cache (extract.ts) or a run's results sheet |
| Behavior | correction and hold-back rate per session, before and after the first `portrait-cache` entry | reply codes + Pi log custom entries (Pi sessions only) |

## Fixed design

1. **One input, read-only.** The command takes one session file or one directory (a Pi session folder such as `~/.pi/agent/sessions/<project>/`, or a Claude Code project folder such as `~/.claude/projects/<project>/`) and writes only to `--output`. It never writes `~/.pi` or `~/.claude`.
2. **Each log on its own.** It reads Pi logs and Claude Code logs, each in its own format, and reports the input it was given. It never pairs or merges sessions across tools; a Pi folder and a Claude Code folder are two separate reports.
3. **One tool.** The log counting moves into the repo (scripts/compass/report.ts) and replaces the local pi-session-report.py for the coder ledger too, so there is one counting rule.
4. **Offline first.** S8-02 needs no model. S8-03 is the only part with network requests (Jev, user-confirmed limits); the report shows its sections as "not scored" without them.
5. **No plugin change.** Harness only; src/, the gate, and the policy hash do not change.
6. **Protected text:** the report's headings, labels, and messages are approved in S8-01 before any coding.
7. **Honest gaps.** A section without enough data says so with its counts (for example, behavior with fewer than 5 development sessions after the portrait loaded).

## Tasks

- [x] **S8-01** Metric definitions and report text (CC): each metric's counting rule with a real example; the "bugs from reviews" rule checked by CC on a sample from Pi and Claude Code sessions (precision and recall stated); the grading rubric for lessons; the report template. User approves. *Done 2026-10-18: approved by the user (stage-8-specs.md S8-01). Changes: failed checks later fixed move into Checks; review findings are counted under Your interventions as corrections followed by edits; Behavior adds an after (relayed specs) row for this project's Pi sessions.*
- [x] **S8-02** `report` command, log sections (Pi): `--session <file>` or `--dir <folder>`; Pi and Claude Code log formats; Effort, Tokens and cost, Checks, Agent questions; per session and total; markdown and JSONL; tests on synthetic logs of both formats built in the tests. The ledger switches to it. *Done 2026-10-18: accepted in round 2 (1533b60; B25 fixed in round 2); outputs/s8/handoff/S8-02-r1.md, -r2.md.*
- [x] **S8-03** Interventions (Pi, then a CC live run): every prompt after the first is scored from the report's own segments (Pi and Claude Code; long exchanges trimmed to the classifier's 32 KB limit); `score.ts --exchanges` scores them with the reply codes and the report reads them back with `--codes` (user, 2026-10-18; stage-8-specs.md S8-03); run type `evaluate`, limits suggested and user-confirmed at launch. *Done 2026-10-18 (af67f86; B26 fixed in round 2): live runs Pi 91 / 91 and Claude Code 471 / 471 scored, 0 fallbacks (limits 120 / 300000 and 600 / 900000 ms, agent-suggested, user-confirmed); reports outputs/s8/final-pi/, outputs/s8/final-cc/. The Claude Code session that ran the scoring reads not scored (it grew after the exchanges were frozen); a rerun scores only its new prompts from the cache.*
- [x] **S8-04** Lessons (CC grades, Pi joins): rules joined to their source trios; CC grades a sample against the S8-01 rubric; the user spot-checks; the report shows grade counts with examples. *Done 2026-10-18: code accepted first pass (7d623fc; deepseek-flash, thinking max). Live extraction on fixtures/s8-pi (26 finished Pi sessions, 86 trios): 86 requests, 4.2 min, completed (limits 120 / 1800000 ms, agent-suggested, user-confirmed; a first launch was refused before any request for an invalid `--limits-source` value and relaunched with the same limits). 66 rules, 30 sampled (seed s8-lessons). The user revised the rubric while grading (good needs situation, changed action, and reason in the rule itself; stage-8-specs.md). Grades, user-checked: good 0, vague 16, wrong 14. Finding: the extractor writes bare imperatives with no situation or reason; 9 of the 14 wrong rules come from the agent's own behavior or a relayed spec. The last finished session (01a14dea) has no rules (Lessons not scored). Evidence outputs/s8/lessons/, outputs/s8/final-pi-lessons/, outputs/s8/final-pi-01a14dea/.*
- [x] **S8-05** Behavior (CC): before/after rates on development sessions only, with counts and the honest-gap rule; written into the report. *Done 2026-10-18: Pi-coded (user: build the section now), accepted in round 2 (thinking high; round 2 added a one-side-short test after a surviving spot mutant). The report sorts sessions by `portrait-cache` record into before / after, `--relayed-specs` moves portrait-loaded sessions to the relayed row, rates come from the S8-03 codes. Data gap: no development session has run with the portrait loaded (the portrait-loaded sessions outside this project are setup chores), so the comparison prints too few sessions to compare (0 before, 0 after); this project's relayed specs: 18 sessions, 91 trios, correction 15.4%, hold-back 5.5%. The user removed avtc-pi-portrait from the Pi runtime on 2026-10-18, so the after group grows only after a reinstall. Full report: outputs/s8/final-pi-s8/report.md.*

**Allowance:** 4–7 h, plus your approval of S8-01 and the S8-03 limits. Which session file or folder the first report covers is your pick at S8-03.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.6.0 | 2026-10-18 | S8-03 scores every prompt from the report's segments, Pi and Claude Code (user). |
| 0.7.0 | 2026-10-18 | S8-03 done. |
| 0.8.0 | 2026-10-18 | S8-04 and S8-05 done; lesson rubric revised by the user; S8 complete. |
