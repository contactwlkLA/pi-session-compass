# Coder comparison: discussion notes (2026-10-15)

Revision: **0.5.0** · Updated: **2026-10-15**

Short reminder of what was decided before starting Stage 3 work in `/home/wai/compass-ext4`.

## Setup
- Pair-programming mode. Claude Code (Opus 5.5) plans, writes task specs, reviews, keeps the ledger, verifies, and commits; it writes no implementation. Pi codes; the human relays.
- Coders run in Pi: Haiku 5.5 (Claude API) and MiMo v2.6 flash. More models may be added later.
- One model per Pi session; a model does not resume another session's context. From S3-B1-03 the user stays on MiMo v2.6 pro instead of alternating (user, 2026-10-15); Haiku cost is the obstacle, and other models (e.g. Sonnet 5.5) may be tried later. Tasks differ between coders and later tasks inherit earlier code. The comparison is rough by design; adjust as we go.

## Files
- `ledger.schema.json`: one record per task attempt. `coder` is a free-string model ID.
- `ledger.jsonl`: the ledger, one JSON object per line, kept by Claude Code.
- `planner-prompt.md`: the planner/reviewer procedure Claude Code follows from Stage 3 Part B.
- Coder handoffs: `outputs/s3-b/handoff/<task_id>-r<round>.md` (local, not committed).

## Decisions
- **Task size:** peak context is recorded per task, not enforced (user, 2026-10-15: real tasks here exceed 100K, and a task small enough to fit would be too easy to compare). Earlier target: keep each task, correction rounds included, under ~100K tokens of context. Split planned steps that would not fit. Restart the coder in a fresh session if a correction round nears 100K.
  - 100K is Haiku 5.5's price step (5x input/output price beyond 100K prompt tokens), not a documented quality limit.
- **Cost:** Pi's estimate is good enough; ballpark only. Keep raw tokens beside it, label `cost_source`, compare as ratios.
- **Harness fields:** filled by hand from Pi session logs (`~/.pi/agent/sessions/<project>/*.jsonl`) when convenient; null is fine. No probe script; no separate tooling project.
  - Peak context per call = input + cacheRead + cacheWrite (Pi's `input` excludes cached tokens).
- **Thinking level:** a level name is only a relative label within one model; it does not mean the same reasoning budget across models. MiMo v2.6 has a single effort level; whatever level Pi shows, it runs the same. Haiku ran S3-B1-01 at `high` and runs at `xhigh` from its next session (user, 2026-10-15). Keep it fixed within a task attempt; the ledger records it per attempt.
- **Speed:** the user expects Haiku to be much faster than MiMo 2.6 flash at similar quality. If only one HARNESS field gets filled, make it `coder_active_s` (from Pi timestamps; includes test run time).
- **MiMo variants:** 2.6 pro is the MiMo coder from S3-B1-02a (user, 2026-10-15): on Artificial Analysis it scores close to Haiku at xhigh, and it costs more than 2.6 flash. Flash may be added later as its own block.
- **`reasoning` token field:** a measured count, not a setting; optional, null is fine.
- **Inherited defects:** recorded with `inherited: true`; not counted against the current coder.
- **What to trust most:** first-pass acceptance, correction rounds, claim mismatches, scope discipline, verification run. Cost and time depend on the task.

## Project first: conflict resolutions (user, 2026-10-15)

The comparison is a side quest. Where it conflicts with the project rules (AGENTS.md), the project wins; anything unresolvable is dropped from the comparison and recorded here.

- **Model switch mid-task.** A correction round that needs a fresh Pi session gets the other model. The work continues; the ledger closes the attempt as `abandoned` with the note "session restart, model switched", and the new coder continues under `run_id` 2 with the earlier code counted as inherited.
- **Correction rounds.** At most two correction rounds per task (AGENTS.md repair rule), then the user decides. A task still failing is recorded `abandoned`.
- **Protected text.** The coder never writes user-facing text of its own. Specs quote user-approved strings exactly; any other user-facing string in a diff is a constraint violation.
- **Verification.** The coder runs `npm test` and `npm run test:compass` in full. Claude Code re-runs both, plus one single-worker run, before committing; only those re-runs count as gate evidence.
- **Commits and docs.** The coder does not commit and does not edit `md/`. Claude Code commits and pushes and keeps bugs.md.
- **A wrong spec.** Acceptance criteria are not loosened after the coder starts. If a spec is wrong, the task stops and the user decides; the fix becomes a new task.
- **Benchmark hidden from the coder.** The coder is not told about the comparison, but this file, the prompt, and the ledger are in `md/`, which Pi can read. Specs tell the coder to read only the files they name; full blinding is not possible and is not attempted.

## Known caveats
- Different tasks per coder; difficulty is the main confound.
- Single reviewer (Opus) judging a Claude and a non-Claude model; spot-check some verdicts.
- Providers differ (API, caching, thinking-level mapping) even inside Pi; recorded, not controlled.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.3.0 | 2026-10-15 | Thinking levels are per-model labels; Haiku moves to xhigh from its next session. |
| 0.4.0 | 2026-10-15 | MiMo coder is 2.6 pro, not flash. |
| 0.5.0 | 2026-10-15 | Stay on MiMo pro (no alternation); MiMo has one effort level; 100K is recorded, not a limit. |
