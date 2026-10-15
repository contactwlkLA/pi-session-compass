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

Revision: **0.7.0** · 2026-10-14

Adds to the repository rules above. On conflict, follow the repository rules and ask the user.

## Start and scope

- **Before the first reply,** read md/stage.md and the first unfinished stage’s task file; they override handoffs. Read the md/compass.md run-type table; other documents as needed. If the task file is missing, report it and stop; never invent instructions or skip a blocked stage.
- **Handoffs are written only after the gates pass** (full test runs green, work committed and pushed, stage docs synced). On re-entry, run `git status`: if HEAD differs from the handoff’s commit or the tree is not clean, review what changed and invalidate affected evidence before new work. Resume the first unfinished stage once its prerequisite or clarification is resolved.
- **Layout:** `md/` planning docs; `scripts/` harness and checks; `fixtures/` frozen inputs; `outputs/<run>/` every generated artifact (portrait copies, snapshots, receipts, traces, results sheets). Edit `src/` only for instrumentation and repairs a stage calls for.
- One session, one stage. State the authorized outcome, allowed edits, and completion evidence. Resolve material conflicts before dependent work.
- **Unclear goal, scope, acceptance criterion, or authorization: ask one focused question and wait; never substitute an assumption.** Silence, a reversible action, or a proposal is not approval. Routine choices within clear scope may proceed. If the overall goal is unclear, pause implementation. Discover checkout and runtime facts before asking the user; mark unknown evidence as unknown.
- Do not enter `./private`.

## Execute and stop

- Check a task only after verification; preserve user changes and evidence.
- **Bug journal:** record every bug found (harness, pipeline, test, or environment) in md/bugs.md when it is found, and update its status, fix commit, and evidence when it changes; never delete an entry.
- **Repairs:** at most two diagnose → repair → verify cycles per problem, then report the failure. Application model-retry semantics are separate.
- **Verify with full runs.** Before reporting a change verified or asking to commit, run `npm test` and `npm run test:compass` in full and quote each raw result; label partial runs as partial. A test listed as known-intermittent in the T1.6 record (md/stage-1-task.md) that fails with the recorded message is rerun once; if the rerun passes, report the known flake. Any other failure is real.
- **Flaky test files or shared test setup/mocks:** verify a change with 20 default-order runs and report the failure count.
- **Live-run limits are user-confirmed every time, except under a standing approval below.** Suggest the md/compass.md row; if UNSET, suggest values with their basis and assumptions. Pass `--run-type`, `--max-model-requests`, `--max-run-ms` (no defaults; finite positive values only). Show the run type, limits, file with trio count, and output directory; pass `--confirmed` only after the user approves them in this session. Unattended runs never self-confirm beyond a standing approval. Count every inference attempt across models, including retries and follow-ups; one multi-question Jev request counts once. Never raise a ceiling, edit the compass.md table unasked, or restart to evade a cap. Record run type, suggested and final limits, and their source in each manifest.
- Verify isolation and limit controls offline before live calls.
- A `smoke` run ending by completion or cap with its checks met is a success with no measurement claims. Any other capped run is incomplete: leave its task and stage unchecked and keep partial evidence.
- **Standing approvals** (granted by the user 2026-10-14; the user may withdraw them at any time): (a) after a fix that touches only harness code or tests (`scripts/`, `tests/`), relaunch the same live run (same run type, limits, file, and starting snapshot) without a new confirmation, once the fix is in md/bugs.md and both full test suites pass; record the relaunch and its approval source in the run's notes; (b) commit and push once both full test suites pass. They never cover raised limits, a new run type, protected text, `src/` changes, or the user's live `~/.pi` data.
- **Waiting on the user:** finish authorized independent work first, then send a push notification naming the one decision needed. While the user is away, run already-approved long work (live runs, test loops) instead of idling.
- Stop on user instruction, reached limits, lost isolation or control, or the stage boundary. Finish clearly authorized independent work when prerequisites are missing.
- **At exit,** sync task checkboxes and stage.md (outcome, status, next task, blocker, evidence path). Check a stage only after its milestone is verified, never because the session ended.
- Keep secrets out of artifacts and messages. Give brief updates at task transitions and blockers.

## Reporting to the user

- **Status board first:** a progress reply opens with one-line **Done**, **Now**, **Next**, using md/stage.md task IDs.
- **One ask per message:** one command block, paste, or decision, ending with the check that confirms it. Name the next step without its commands.
- **No repeated asks:** never re-request output already received; if it is needed again, say what changed and why.

## Compatibility with the repository rules

- **Protected text** includes every user-facing string this project adds or changes in `src/` or the harness: the confirmation prompt, cost notes, diagnostics, errors. The stage task lists them; present the exact text and wait for approval before applying.
- **Product docs:** the README/CONFIGURATION rule covers upstream’s product docs, not `md/` or this file, which are design documents. At the settings-and-handoff stage, update README and CONFIGURATION for new behavior in product-doc style.
- **Tests:** `npm test` runs the repository suite (excludes `tests/compass`); `npm run test:compass` runs the harness suite; `npx vitest run` runs specific tests. S1.T1.6 records their baselines. Update tests when behavior changes.
- **Approval markers** belong only in `-design` docs; the `md/` planning docs need none.

## Revision numbering

Each document carries MAJOR.MINOR.PATCH in its header and history table, starting at 0.1.0 and staying pre-1.0 while planning.

- **Minor:** meaning, scope, behavior, contract, or structure changes, including adding, removing, or reordering a stage, task, rule, or limit.
- **Patch:** wording, typos, or formatting, with no change in meaning.
- **1.0.0** (document set approved for implementation) and any later major bump are the user’s call.
- Documents refer to each other by file name, never by revision.
- At exit, bump each changed document and add a history row; never bump an unchanged one.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.7.0 | 2026-10-14 | Standing approvals (relaunch after a harness-only fix; commit and push after green suites) and push-notify when waiting on the user. |
| 0.6.0 | 2026-10-14 | Added the bug-journal rule (md/bugs.md). |
| 0.5.0 | 2026-10-14 | Handoffs are written only after the gates pass; re-entry runs a git status drift check. Condensed the project rules' wording with no other change in meaning. |
| 0.4.0 | 2026-10-14 | Session start reads stage.md and the task file before the first reply; handoffs do not replace them. Added the repeated-runs rule for order-dependent failures. |
| 0.3.0 | 2026-10-12 | Added the Reporting to the user section: status board, one instruction set per message, no repeated asks. Added a rule not to enter ./private (the user's scratch directory) |
| 0.2.0 | 2026-10-12 | Added the verification-reporting rule; Tests bullet names test:compass. |
| 0.1.0 | 2026-10-11 | Initial committed draft. |
