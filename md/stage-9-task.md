# Stage 9 — Better lessons

Project: **pi-session-compass** · Revision: **0.1.0** · Status: **Complete (2026-10-18)**

Date: **2026-10-18**

Parent: [plan.md](plan.md). Finding from [stage-8-task.md](stage-8-task.md) S8-04: of 30 sampled rules, good 0, vague 16, wrong 14 under the user's rubric ([stage-8-specs.md](stage-8-specs.md), S8-04). Operating rules: [AGENTS.md](../AGENTS.md). Bugs: [bugs.md](bugs.md).

**Goal (M9):** the extractor writes rules that work on their own: the situation a future agent will recognize, what to do differently there, and why (the user's concern). Rules come only from the user's reply. Measured on the same trios as S8-04, with every grade checked by the user.

## Causes found in the prompts (src/prompts.ts)

| Finding (S8-04) | Cause | Where |
|---|---|---|
| 16 vague: no situation or reason | The prompts forbid them: "Write short behavioral principles, not conditional 'when X, do Y' rules. The agent will recognize when to apply the rule at runtime". The three examples are bare imperatives | `EXTRACTION_PROMPT`, `POST_EXTRACTION_PROMPT` |
| Situations would be stripped later | Maintenance quality gate: "Must be a short behavioral principle, not a conditional 'when X, do Y' rule"; merge text keeps "every unique directive" but says nothing about situation or reason | `MAINTENANCE_PROMPT`, `BUILDING_PROMPT` |
| 14 wrong: 9 from the agent's own behavior or a relayed spec, the rest misread approvals or task steps | No instruction that the lesson must come from the user's reply, or that an approval, a task step, or a pasted spec yields no rule | `EXTRACTION_PROMPT` |

Production runs the extraction, building, and maintenance prompts; post-extraction is off by default (`postExtractionEnabled: false`) and was off in the S8-04 run.

## Fixed design

1. **Prompts only.** `src/prompts.ts` text changes, plus the README sentence that calls a rule "a short behavioral principle". No code, schema, gate, or policy-hash change. The extraction revision (`EXTRACTION_POLICY_REVISION`) changes with the prompt, so the harness cache starts fresh.
2. **Same measurement as S8-04.** Same corpus (fixtures/s8-pi, 86 trios), same model and thinking (meta/muse-spark-1.3-contributor, high), post-extraction off. Graded: every new rule from the 26 trios behind the S8-04 sample of 30, with the S8-04 rubric unchanged.
3. **Live portrait untouched.** No change to `~/.pi`; existing portrait rules are not re-extracted or rewritten by this stage.
4. **Protected text:** every prompt and README line is shown before and after and approved by the user before Pi applies it (S9-01).
5. **Cost of longer rules:** rules get longer (median 10 words today; the rubric's good example has 30). S9-03 reports the median length and the portrait size in tokens at the 200-rule limit, since the portrait is added to every agent turn.

## Tasks

| Task | Outcome | Who | Your part |
|---|---|---|---|
| S9-01 — Prompt text | Exact before/after for the four prompts and the README line | CC drafts | approve the text |
| S9-02 — Apply | Approved text in src/prompts.ts and README; both suites green | Pi | none |
| S9-03 — Measure | Re-extraction of fixtures/s8-pi; grades of the 26 trios' new rules | CC runs and grades | confirm limits; check every grade |
| S9-04 — Decide | Keep the new prompts or revert | you | the decision |

- [x] **S9-01** Prompt text (CC): the before/after for `EXTRACTION_PROMPT`, `POST_EXTRACTION_PROMPT`, `MAINTENANCE_PROMPT` (quality gates), `BUILDING_PROMPT` (merge keeps situation and reason), the examples rewritten into situation, action, and reason, and the README sentence. Includes the source rule: the lesson comes from the user's reply; an approval, a task step, or a relayed spec gives no rule. *Done 2026-10-18: text approved by the user (stage-9-specs.md S9-01).*
- [x] **S9-02** Apply (Pi, short spec): the approved text only; `npm test` and `npm run test:compass` green. *Done 2026-10-18: accepted first pass (deepseek-flash, thinking high); CC rebuilt src/prompts.ts from HEAD plus the approved blocks and it is byte-identical; npm test 588/588, test:compass 282/282; outputs/s9/handoff/S9-02-r1.md.*
- [x] **S9-03** Measure (CC, live, run type `evaluate`): limits suggested 120 requests / 1800000 ms (S8-04 used 86 requests, 4.2 min), user-confirmed at launch. CC grades every new rule from the 26 trios; the user checks every grade. Report: grade counts beside S8-04, lessons lost (trios graded vague in S8-04, which hold a real lesson, that now give no rule), rules per trio, median rule length, portrait tokens at 200 rules. At most two prompt rounds; a second round's text is approved again. *Done 2026-10-18 in two rounds (stage-9-specs.md S9-03). Round 1: 19 rules, good 7 / vague 2 / wrong 10 (5 wrong rules restated an instruction). Round 2 (gap rule, user's reason, example 1 replaced): 86/86 trios, 86 requests, 2.0 min; 12 rules, good 9 / vague 2 / wrong 1, user-checked; sample trios good 5 / vague 2 / wrong 0; real lessons lost 3 of 9 (the user narrowed "lost" to real lessons, 2026-10-18). Run and draft grades by Pi at the user's choice; CC checked all 12. Evidence outputs/s9/extract-pi-r2/, outputs/s9/lessons-r2/.*
- [x] **S9-04** Decide (user): pass → keep, and update README/CONFIGURATION in product-doc style; fail → revert to the S8 prompts and record the result. *Done 2026-10-18: the user kept the round 2 prompts although lessons lost (3) missed the bar (at most 1); good and wrong met it. README updated in S9-02; CONFIGURATION has no rule-style text.*

**Pass (proposed, your call):** on the 26 trios, at least half of the new rules good, at most 4 wrong (S8-04: 14 of 30), and at most 1 of the 16 vague-graded trios lost.

**Out of scope:** the gate and its policy, B27 (S5 corpora no longer load), Behavior (needs avtc-pi-portrait reinstalled and development sessions), the deepseek-flash cost estimate.

**Allowance:** 2–4 h, plus your approval of S9-01, the S9-03 limits, and your grade checks.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.1.0 | 2026-10-18 | Drafted from the S8-04 finding (user chose "better lessons"), approved, and completed. |
