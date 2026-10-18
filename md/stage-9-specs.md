# Stage 9 — Specs

Project: **pi-session-compass** · Revision: **0.1.0** · Status: **S9-01 approved; S9-02 ready**

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

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.1.0 | 2026-10-18 | S9-01 prompt text drafted. |
