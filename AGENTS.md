## Text Review

**Protected text** = prompt/skill/agent markdown (files under `agents/`, `skills/`, `.pi/`) + user-facing strings in extension code and documents (`notify()`, dialogs, status messages, errors).

**Rule:** Any add/modify/remove of protected text → present exact before/after to user → wait for approval → apply.

### Approved Text

Protected text in design doc must be:
1. Presented to user for approval before writing to the doc.
2. Marked `<!-- approved -->` adjacent to the approved text. Markers needed only in -design docs. No need to add them to source code or prompts.

Once approved, text can be applied directly during implementation. Any subsequent change to approved text (from review, revalidation, etc.) must be re-presented to user before applying.

## Conventions

- `npm test` runs the full build/lint/test suite.
- use `npx vitest run` to run specific tests.
- Update tests and documentation when behavior changes.
- Follow existing prompts and code style.
- **Source comments and product docs (README, CONFIGURATION) stay free of design-doc references and historical framing** — no §N, D27, R2-8, "Design ref", "has moved to"/"formerly"/"is now"/"no longer", or "(module.ts)" breadcrumbs. Design-doc and plan-section references belong in design docs and the `.featyard/` artifact docs (plans, research, reviews) that trace to them.

---

# pi-session-compass — Agent operating rules

Revision: **0.2.0** · 2026-10-12

These rules apply in addition to the repository rules above; they do not replace them. Where they would conflict, follow the repository rules and ask the user.

## Start and scope

- Read md/stage.md at session start, then the first unfinished stage’s task file. Read the run-type table in md/compass.md; consult other documents only as needed. Report a missing task file and stop rather than inventing instructions or skipping a blocked stage.
- Layout: planning docs live in `md/`; harness and check code in `scripts/`; frozen inputs in `fixtures/`; every generated run artifact (portrait copies, snapshots, receipts, traces, results sheets) only under `outputs/`, one subdirectory per run. Edit `src/` only for the instrumentation and repairs a stage calls for.
- One session targets one stage. Follow explicit user/repository instructions; resolve material conflicts before dependent execution. Briefly state the authorized outcome, allowed edits, and completion evidence.
- **Unclear goal, requirement, scope, acceptance criterion, or authorization: ask one focused question and wait. Do not substitute an assumption.** Silence, a reversible action, or a written proposal is not approval. Routine choices may proceed within clear scope; verify facts and mark unknown evidence honestly.
- Continue independent work only when its goal and authorization are clear. If the overall goal is unclear, pause implementation. Discover accessible checkout/runtime facts before asking the user to supply them.

## Execute and stop

- Check tasks only after verification; preserve user changes and evidence. Use at most two diagnosis → targeted repair → verification cycles per distinct problem, then report the failure; application model-retry semantics are separate.
- **Verification is reported only from a full run.** Before reporting a code change verified, or asking to commit it, run `npm test` and `npm run test:compass` in full and quote the raw result of every run; a partial run is reported as partial. A failure of a test listed as known-intermittent in the T1.6 baseline in md/stage-1-task.md, with the same failure message recorded there, is rerun once; if the rerun passes, report it as the known flake. A failure with any other message or duration is a real failure.
- **Limits are user-confirmed for every live run.** The row for the run type in md/compass.md is the suggested default; if it is UNSET, suggest values with their basis and assumptions. Pass `--run-type`, `--max-model-requests`, and `--max-run-ms` to the harness (it has no defaults). Show the user the run type, limits, selected file with its trio count, and output directory, and pass `--confirmed` only after the user approves them in this session. Accept only finite positive values. Unattended runs never self-confirm. Count inference attempts across all models, including retries and follow-ups; several questions in one Jev request count once. Never raise a ceiling on your own, edit the md/compass.md table unless asked, or evade a cap by automatic restart. Record the run type, suggested and final limits, and their source in every run manifest.
- Verify isolation and limit controls offline before live calls.
- A `smoke` run that ends by completion or by a cap, with its checks met, is a successful smoke result with no measurement claims. A capped run of any other type is incomplete: leave the task and stage unchecked and preserve partial evidence.
- Stop on user instruction, reached limits, loss of isolation/control, or the stage boundary. Complete clearly authorized independent work when prerequisites are missing.
- At exit, synchronize task checkboxes and stage.md: outcome, stage status, next unfinished task, blocker, and evidence path. Check the stage only after its milestone is verified. Never check a stage because the session merely ended.
- On re-entry, verify source/settings/fixture revisions and invalidate affected evidence if changed. Resume the first unfinished stage after its prerequisite or clarification is resolved. Keep secrets out of artifacts/messages; give brief task-transition/blocker updates.

## Compatibility with the repository rules

- **Protected text:** the Text Review rule above covers any user-facing string this project adds or changes in `src/` or the harness, including the start-of-run confirmation prompt and its cost notes, diagnostics, and errors. The stage task names those strings first; present the exact text and wait for approval before applying.
- **Product docs:** the README.md and CONFIGURATION rule above applies to upstream's product docs, not to the planning documents in `md/` or this file, which are design documents. At the settings and handoff stage, update README.md and CONFIGURATION for new behavior in product-doc style, with no design-doc references or historical framing.
- **Tests:** `npm test` runs the repository's suite (it excludes `tests/compass`), `npm run test:compass` runs the harness's own tests, and `npx vitest run` runs specific tests. S1.T1.6 records their baseline results before any edit; update tests when behavior changes.
- **Approval markers:** `<!-- approved -->` markers belong in design documents only. The planning documents here are not named `-design` and need none.

## Revision numbering

Each document carries MAJOR.MINOR.PATCH in its header and history table. All start at 0.1.0 at the first commit and stay pre-1.0 while planning.

- **Minor (0.X.0):** meaning, scope, behavior, contract, or structure changes, including adding, removing, or reordering a stage, task, rule, or limit.
- **Patch (0.X.Y):** wording, typos, formatting, or other changes with no change in meaning.
- **1.0.0:** set by the user when the document set is approved for implementation. Afterward the same rules apply, and a major bump is the user’s call.
- Documents refer to each other by file name only, never by revision number, so a bump touches only the file that changed.
- At session exit, bump each changed document by these rules and add a history row. Never bump a document that did not change.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.2.0 | 2026-10-12 | Added the verification-reporting rule; Tests bullet names test:compass. |
| 0.1.0 | 2026-10-11 | Initial committed draft. |
