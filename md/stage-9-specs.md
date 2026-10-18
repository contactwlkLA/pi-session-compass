# Stage 9 — Specs

Project: **pi-session-compass** · Revision: **0.1.0** · Status: **S9-01 approved; S9-02 done; Complete: round 2 prompts kept by the user (2026-10-18)**

Parent: [stage-9-task.md](stage-9-task.md). Rubric: [stage-8-specs.md](stage-8-specs.md) (S8-04, revised by the user).

**Coder rules and handoff format:** [stage-3b.md](stage-3b.md), section "Coder rules", unchanged, except: no spec audit for S9-02 (text only), and the handoff goes to `outputs/s9/handoff/<task_id>-r<round>.md`. Never write `~/.pi` or `~/.claude`.

## S9-01 — Prompt text (approved by the user, 2026-10-18)

Every change is a replacement of the exact lines shown. Lines not shown stay as they are. File: `src/prompts.ts` unless marked README.

### 1. EXTRACTION_PROMPT — which replies give a rule

Before:

```
Decide first: does this sequence reveal a lesson worth extracting? Return no
rules if the lesson only applies to this one decision, approval, or
acknowledgment, or if the rule would harm output in other situations (e.g.
favors speed over correctness or skips necessary steps). Otherwise extract one
rule per independent lesson. Lessons are independent when each demands a
behavior the others do not.
```

After:

```
Decide first: does this sequence reveal a lesson worth extracting? The lesson
must come from the user's reply: never draw a rule from what the agent did or
said on its own. Return no rules if the reply is an approval, an
acknowledgment, the next task step, or a pasted spec or task instructions; if
the lesson only applies to this one decision; or if the rule would harm output
in other situations (e.g. favors speed over correctness or skips necessary
steps). Otherwise extract one rule per independent lesson. Lessons are
independent when each demands a behavior the others do not.
```

### 2. EXTRACTION_PROMPT and POST_EXTRACTION_PROMPT — rule form

Before (in both prompts):

```
Rules MUST apply across many situations, not just the one shown.
Strip away the specific domain, files, and technologies — keep only
the reusable behavioral principle.
Write short behavioral principles, not conditional "when X, do Y" rules.
The agent will recognize when to apply the rule at runtime;
the rule just needs to tell it WHAT to do differently.
```

In POST_EXTRACTION_PROMPT the first line reads "Rules MUST apply across many situations, not tied to specific domain or context." It stays; only the five lines after it are replaced, by the last five lines of the After block.

After:

```
Rules MUST apply across many situations, not just the one shown.
Strip away the specific domain, files, and technologies, but describe the
situation in general terms. The portrait stores only the rule text, so each
rule must stand on its own and say three things: the situation a future agent
will recognize ("When ..."), what to do differently there, and why — the
user's concern behind the reply ("because ...").
```

### 3. EXTRACTION_PROMPT and POST_EXTRACTION_PROMPT — examples

Before (in both prompts):

```
Examples of well-extracted rules:
"Investigate root causes and build proper architecture instead of quick ad-hoc fixes"
"Prefer fixing the source over patching each consumer"
"Question assumptions before committing to an approach"
```

After:

```
Examples of well-extracted rules:
"When you notice something outside your instructions that you could change, ask before changing it, because the user decides what is in scope"
"When a bug shows up in several consumers, fix the shared source instead of patching each consumer, because separate patches drift apart and hide the cause"
"When an approach rests on an assumption you have not checked, check it before building on it, because rework after the fact costs the user more"
```

### 4. EXTRACTION_PROMPT — final check

Before:

```
Re-validate your rules against the summary before returning them.
```

After:

```
Re-validate your rules against the summary before returning them: each rule
names a situation, a changed action, and a reason, and the user's reply
supports all three.
```

### 5. POST_EXTRACTION_PROMPT — what to tighten and drop

Before:

```
the right abstraction level. If the rule over-generalized (lost a key trigger,
action, or scope that was the actual lesson), tighten it. If the rule is already
well-formed, return it unchanged.
```

After:

```
the right abstraction level. If the rule over-generalized (lost a key trigger,
action, or scope that was the actual lesson) or is missing its situation,
changed action, or reason, tighten it from the interaction. If the rule is
already well-formed, return it unchanged.
```

Before:

```
Drop rules whose lesson only applies to one specific situation, and rules
that would harm output in other situations.
```

After:

```
Drop rules whose lesson only applies to one specific situation, rules the
user's reply does not support, and rules that would harm output in other
situations.
```

### 6. BUILDING_PROMPT — merge keeps situation and reason

Before:

```
  existing rule number to fold into, and text to the single-line combined
  rule that preserves every unique directive from both. That existing
```

After:

```
  existing rule number to fold into, and text to the single-line combined
  rule that preserves every unique directive from both, with the
  situation and reason of each. That existing
```

Before (JSON example):

```
    { "candidate": "C2", "action": "merge", "mergePosition": 7, "text": "Investigate root causes and build proper architecture instead of quick fixes or patching each consumer" },
```

After:

```
    { "candidate": "C2", "action": "merge", "mergePosition": 7, "text": "When a bug shows up in several consumers, find the root cause and fix the shared source instead of quick fixes or per-consumer patches, because patches drift apart and hide the cause" },
```

### 7. MAINTENANCE_PROMPT — keep situation and reason

Before:

```
- Generalize: rule is overly specific → rewrite to strip domain specifics while preserving the lesson
```

After:

```
- Generalize: rule is overly specific → rewrite to strip domain specifics while preserving the lesson, its situation, and its reason
```

Before:

```
Do NOT remove rules just because they seem conditional — conditional rules
may still be valid behavioral principles.
```

After:

```
Do NOT remove or shorten a rule because it states when it applies and why —
those parts are what let the agent use it. Do not invent a situation or reason
a rule does not already state.
```

Before:

```
- Must be a short behavioral principle, not a conditional "when X, do Y" rule
```

After:

```
- Must keep the situation it applies to and the reason, when it states them
```

### 8. README.md (line 130)

Before:

```
From each trio it extracts a short **behavioral principle**, ranks it against your existing portrait, and keeps the most valuable ones.
```

After:

```
From each trio it extracts a **rule** that says when it applies, what to do differently, and why, ranks it against your existing portrait, and keeps the most valuable ones.
```

## S9-02 — Apply the approved text

**Task:** make the eight S9-01 replacements exactly as written above, and nothing else. Each "Before" block occurs exactly once in its file (the rule-form and examples blocks once in each of the two prompts; for the rule-form block in POST_EXTRACTION_PROMPT, keep its first line and replace the five lines after it).

**Read:** this file (S9-01 and S9-02 only), src/prompts.ts, README.md (line 130).

**Allowed scope:** src/prompts.ts, README.md, and the handoff file.

**Acceptance:**

1. Every "After" block appears in its file with the same characters, line breaks, and indentation as above; no "Before" block remains.
2. No other line of src/prompts.ts or README.md changes (`git diff --stat` shows only these two files).
3. Both suites pass.

**Verification** (paste each result line):

```
npm test
npm run test:compass
git diff --stat
grep -c "when X, do Y" src/prompts.ts
```

The last command prints `0`.

**Handoff:** `outputs/s9/handoff/S9-02-r1.md`, sections as in the Coder rules.

## S9-03 — Round 1 result and round 2 text

**Round 1 (2026-10-18, revision f16cd6be5e7c):** 86/86 trios, 86 requests, 2.1 min, completed (limits 120 / 1800000 ms, agent-suggested, user-confirmed; a first launch was refused before any request for an invalid `--limits-source` value). 19 rules from 18 trios (S8-04: 66 from 43); median 213 characters (S8-04: 76), about 10.6K tokens at 200 rules. Grades of all 19, user-checked: good 7, vague 2, wrong 10 (the user regraded the small-steps rule from good to wrong: an instruction given before any mistake, with an invented reason). On the 26 sample trios: 9 rules, good 3, vague 2, wrong 4. Of the 16 trios graded vague in S8-04, 8 give no rule; 5 of those are relayed task specs and 1 is a terse follow-up with no lesson, so 2 real lessons were lost. Main fault: 5 of the 10 wrong rules restate an instruction the agent had not broken. Example 1 comes from the same trio as one good rule (701d95c2), so that grade may be a copy. Evidence: outputs/s9/extract-pi/, outputs/s9/lessons/.

**Measurement change for round 2 (user, 2026-10-18):** "lessons lost" counts the 10 S8-04 vague trios that hold a real lesson; the 5 relayed specs (35d23e26, ad994608, f5bc9ab6, 093fa5b0, 82debb8e) and the terse follow-up (a8c27bf0) are left out.

### Round 2 text (approved by the user, 2026-10-18)

**R2-1. EXTRACTION_PROMPT — a lesson needs a gap.** Before (the S9-01 text):

```
Decide first: does this sequence reveal a lesson worth extracting? The lesson
must come from the user's reply: never draw a rule from what the agent did or
said on its own. Return no rules if the reply is an approval, an
acknowledgment, the next task step, or a pasted spec or task instructions; if
the lesson only applies to this one decision; or if the rule would harm output
in other situations (e.g. favors speed over correctness or skips necessary
steps). Otherwise extract one rule per independent lesson. Lessons are
independent when each demands a behavior the others do not.
```

After:

```
Decide first: does this sequence reveal a lesson worth extracting? The lesson
must come from the user's reply: never draw a rule from what the agent did or
said on its own. A lesson needs a gap: the user corrects or pushes back on what
the agent did, or has to ask for something the agent should have offered. An
instruction for work the agent has not done yet is not a gap, even when it says
how to do the work. Return no rules if the reply is an approval, an
acknowledgment, an answer to the agent's question, the next task step, or a
pasted spec or task instructions; if the lesson only applies to this one
decision; or if the rule would harm output in other situations (e.g. favors
speed over correctness or skips necessary steps). Otherwise extract one rule
per independent lesson. Lessons are independent when each demands a behavior
the others do not.
```

**R2-2. EXTRACTION_PROMPT — the reason is the user's.** Before (the S9-01 text):

```
Re-validate your rules against the summary before returning them: each rule
names a situation, a changed action, and a reason, and the user's reply
supports all three.
```

After:

```
Re-validate your rules against the summary before returning them: each rule
names a situation, a changed action, and a reason, and the user's reply
supports all three. The reason is the user's concern shown in the reply, not a
general benefit you supply.
```

**R2-3. EXTRACTION_PROMPT and POST_EXTRACTION_PROMPT — example 1 from outside this corpus.** Before (in both prompts):

```
"When you notice something outside your instructions that you could change, ask before changing it, because the user decides what is in scope"
```

After:

```
"When you report a change as done, say what you did not verify, because the user relies on your report to decide what to check"
```

## S9-02 round 2 — Apply the round 2 text

**Task:** make the three replacements R2-1, R2-2, R2-3 (section "S9-03 — Round 1 result and round 2 text") exactly as written, and nothing else. R2-1 and R2-2 occur once, in EXTRACTION_PROMPT; R2-3 occurs twice, once in EXTRACTION_PROMPT and once in POST_EXTRACTION_PROMPT, and both are replaced.

**Read:** this file (sections "S9-02" and "S9-03 — Round 1 result and round 2 text"), src/prompts.ts.

**Allowed scope:** src/prompts.ts and the handoff file.

**Acceptance:**

1. Every "After" block of R2-1 to R2-3 appears in src/prompts.ts with the same characters, line breaks, and indentation; no "Before" block remains.
2. No other line changes (`git diff --stat` shows only src/prompts.ts).
3. Both suites pass.

**Verification** (paste each result line):

```
npm test
npm run test:compass
git diff --stat
grep -c "not a gap" src/prompts.ts
grep -c "say what you did not verify" src/prompts.ts
```

The last two commands print `1` and `2`.

**Handoff:** `outputs/s9/handoff/S9-02-r2.md`, sections as in the Coder rules.

## S9-03 round 2 — Run, list, and draft grades (Pi, user's choice, 2026-10-18)

The user approved this live run in this session (run type `evaluate`, limits 120 requests / 1800000 ms, agent-suggested, user-confirmed), so `--confirmed` may be passed for this one command. Run nothing else live.

1. `node_modules/.bin/jiti scripts/compass/extract.ts --corpus fixtures/s8-pi --set all --run-type evaluate --max-model-requests 120 --max-run-ms 1800000 --limits-source agent-suggestion --concurrency 8 --output outputs/s9/extract-pi-r2 --confirmed` — expect `stop: completed`. If it stops otherwise, write the handoff with the output and stop.
2. `node_modules/.bin/jiti scripts/compass/labels.ts lessons --corpus fixtures/s8-pi --extract outputs/s9/extract-pi-r2/extract.jsonl --seed s8-lessons --output outputs/s9/lessons-r2`
3. Draft a grade for every rule in outputs/s9/lessons-r2/lessons.jsonl with the rubric in md/stage-8-specs.md, section "Lesson grades (S8-04)", and the round 1 grades in outputs/s9/lessons/grades.jsonl as worked examples. Write `outputs/s9/lessons-r2/grades.jsonl`, one line per rule: `ruleKey`, `grade`, `userChecked: false`, `note` (one short clause quoting the user's reply).
4. In the handoff, add a table: rules, trios with rules, median rule length in characters; grade counts over all rules; and on the 26 sample trios (the trio keys of the `ruleKey`s in outputs/s8/lessons/grades.jsonl) the rule count and grade counts; then which of these 10 trios give no rule: 700813423d65251b, 9cafffbe3ab1061b, 0922e6e8f1a9e267, 701d95c25ae32d8a, cccd9ef69a1e67a3, c78d1a4c870c2ff9, 95a460b6b4b0ff51, 78063df7842ccc92, afa654c778a0bc26, c65426706bebb52f.

**Allowed writes:** outputs/s9/extract-pi-r2/, outputs/s9/lessons-r2/, the handoff `outputs/s9/handoff/S9-03-r2.md`. No source, test, or md change.

### Round 2 result

Revision 687f44b6fa67 (HEAD 6616dbe plus the uncommitted R2 text): 86/86 trios, 86 requests, 2.0 min, completed (same limits, user-approved; run and draft grades by Pi at the user's choice; CC read all 12 against their trios and agreed). 12 rules from 12 trios; median 220 characters. All 12: good 9, vague 2, wrong 1 (round 1: 7 / 2 / 10; S8-04 sample: 0 / 16 / 14). On the 26 sample trios: 7 rules, good 5, vague 2, wrong 0. Real lessons lost: 3 of 9 (9cafffbe, cccd9ef6, 95a460b6; c6542670 is left out, since the user graded its reply an instruction, not a lesson). Grades user-checked. Pass bar: good 71% (needs 50%) met; wrong 0 (at most 4) met; lost 3 (at most 1) not met. **S9-04 (user, 2026-10-18): keep the round 2 prompts.** Evidence: outputs/s9/extract-pi-r2/, outputs/s9/lessons-r2/, outputs/s9/handoff/S9-03-r2.md.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.1.0 | 2026-10-18 | S9-01 prompt text, S9-02 apply specs, S9-03 results and round 2 text; round 2 kept by the user. |
