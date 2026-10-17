# pi-session-compass — Label rubric

Project: **pi-session-compass** · Revision: **0.2.0** · Status: **D4 rule (b), decided by the user 2026-10-17**

Date: **2026-10-17**

How CC drafts the `lesson` / `no_lesson` label and the `correction` flag for each trio (stage-5-task.md D2, D4). It applies to dev and held-out alike. A trio is judged by the user's reply, read against the agent's message before it. Label files: `outputs/s5/labels/labels-<set>.jsonl`.

## Rules

**`lesson`** — any one of these:

1. **Correction** (`correction: true`, note `correction:`). The agent's content was wrong: a false claim or fact, a wrong assumption, a misread request or the wrong task, a missed requirement, a deliverable that does not work as the agent said, or an estimate or finding the user disputes. A pasted or quoted external audit finding about the agent's work counts too, even when the user phrases it as a question (“"Disable the remaining legacy Python-loop CLI" is this still a problem?”).
2. **Hold-back** (`correction: false`, note `hold-back:`). The agent acted, or was about to act, before the user agreed, and the user stops it, makes it wait, or asks it to undo. This includes "what are you doing" and "you went off and did stuff" after unrequested action.
3. **Hold-back reminder** (`correction: false`, note `hold-back reminder:`). In mid-session, the user restates "no writes", "no action", or "don't start until I say", before the agent has done anything wrong. A full task prompt's own constraints ("Do not modify `…/TxnHunter/2`") don't count; they belong to rule 5.
4. **Lasting preference** (`correction: false` unless rule 1 also applies). The user states how the agent should work beyond this one step: always, never, from now on, or a project-wide convention.

A reply that both holds back and corrects gets `correction: true` and a combined note (`hold-back + correction:`).

**`no_lesson`:**

5. A one-off task step: a command, file, analysis, plan, or commit to do now, with its scope constraints.
6. An approval or option pick, or declining a proposal the agent asked about first.
7. A question for information, a status check, pasted output, or evidence the user supplies.
8. Chatter, or the user explaining or reporting their own mistake.

When a reply mixes kinds, any `lesson` rule wins.

**Was the agent wrong, or early?** "You did the wrong task" is a correction (rule 1). "You did it before I said go" is a hold-back (rule 2).

## What the `correction` flag is for

The evaluator counts a **correction miss** when the gate rejects a trio flagged `correction: true`. The flag therefore marks the trios whose loss matters most: rules 1 and the combined cases. Hold-backs stay `lesson` but are not counted as correction misses.

## Rows with examples (dev drafts, 207 trios)

| Kind | Rule | Dev trios | `correction` | What it means | Example reply (session · trio) |
|---|---|---|---|---|---|
| Correction | 1 | 44 | true | The agent's content was wrong. | "nope i checked via /tree i said no suck thing. bring me the receipt" (019fe421 · 10)<br>"dood i said i want to decouple from openrouter...." (019f8360 · 4) |
| Hold-back | 2 | 8 | false | The agent moved before the user agreed; nothing it said was wrong. | "i said discuss. did u went ahead and performed write operations?" (01a05615 · 15)<br>"stop. i dont want you to do anything . just a few questions." (019fe79b · 7) |
| Hold-back reminder | 3 | 7 | false | Preventive: no trigger, the user restates the hold. | "you are just loading right, dont do any work" (01a05615 · 22)<br>"all agreed; no write or modifying file. give me … plan md file" (01a05615 · 32) |
| Hold-back + correction | 1 + 2 or 3 | 2 | true | One reply stops the agent and says something it did is wrong. | "dont dd *anything* until you get a go from me. 1) jobs seems to be done, but campaign status box still says running…" (019fe9ef · 10)<br>"no action. ; you dont see code-wiki?" (01a05615 · 20) |
| Lasting preference | 4 | 0 | false | No standalone case in dev; every preference found came inside a correction. | — |
| Task step | 5 | 146 in all `no_lesson` rows | false | Something to do now. | "get the time stamp from git log" (019fe79b · 27) |
| Approval or decline | 6 | | false | Go, an option, or no to a proposal the agent asked about. | "go" (019fe555 · 2); "a" (019fe79b · 29); "no dont do shit." (01a0ca25 · 16) |
| Question or evidence | 7 | | false | Information, status, or pasted output. | "did you include pytest?" (019fe79b · 5) |
| Chatter or own mistake | 8 | | false | Off-task, or the user's own slip. | "hello?:" (01a055f1 · 13); "ok that was a lesson learnt. i pasted the prompt expecting sol xhigh…" (019fe421 · 11) |

Dev totals: 61 `lesson` (46 flagged `correction`, 15 hold-back only), 146 `no_lesson` (after the user check so far).

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.1.0 | 2026-10-17 | Rubric for D4 rule (b), with corrections and hold-backs split and dev examples. |
| 0.2.0 | 2026-10-17 | Quoted audit findings count as corrections (user check of 019fe79b · 9). |
