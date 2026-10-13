# Stage 1 — Establish the baseline

Project: **pi-session-compass** · Revision: **0.1.1** · Status: **Not started**

Date: **2026-10-11**

Parent: [Development plan](plan.md), Stage 1. Contract: [Architecture](architecture.md). Operating rules: [AGENTS.md](../AGENTS.md); read before execution and install at the Portrait checkout root.

**Goal:** produce a reproducible measured baseline of the current pipeline. Allow harness/instrumentation edits in the implementation checkout; keep pipeline outputs isolated from the live portrait. Preserve filtering, termination, retries, extraction, and building behavior for measurement.

Use [stage.md](stage.md) for continuation. Execute **T1 → T2 → T3 → T4 → T5**, then stop at **M1**. Selector/isolation and limit controls must pass offline before any live call. Every live run takes limits through harness switches and the user’s start-of-run confirmation (see [compass.md](compass.md), rules 2–4): T4 uses run type `smoke`, T5 uses run type `baseline`. T1–T5 map to S1.T1–S1.T5 in the parent plan. Lines use checkbox, execution number, action.

Initial review uses one unbranched conversation path. Branch support is deferred; it is outside the current plan. If the selected source contains branches, stop and request suitable single-path input before live calls; do not combine branches or silently choose one.

## T1 — Establish runtime and source identity

- [ ] **1.** Read repository instructions; verify how Pi loads AGENTS.md and the exact launch command; record checkout, branch, commit, and existing changes.
- [ ] **2.** Collect the installed package manifest, lockfile/resolved dependencies, scripts, and tests.
- [ ] **3.** Verify and record Node, Pi, Portrait, and agent-core versions.
- [ ] **4.** Hash the supplied archive and installed source; explain pipeline-relevant differences.
- [ ] **5.** Save sanitized normalized settings: models, thinking, retries, batch size, cooldown, scan window, review, and maintenance.
- [ ] **6.** Run applicable existing build/tests; record missing dependencies and pre-existing failures. Verification runs both `npm test` (upstream suite; `vitest.config.ts` excludes `tests/compass/**`) and `npm run test:compass` (harness suite, `vitest.compass.config.ts`, isolated).

## T2 — Create the file-selecting, isolated fixture harness

- [ ] **1.** Implement file selection through a selection object with an extensible `scope` field (`all` keeps today’s behavior as the default; `file` is new) and an independent output path.
- [ ] **2.** Accept/copy/hash the user-selected session JSONL; select only that file, independent of age. Put the harness in `scripts/`, the copied session and starting snapshot in `fixtures/`, and a per-run subdirectory of `outputs/` holding the isolated portrait, archives, state/checkpoints, locks, and diagnostics. Use synthetic fixtures offline until the target is supplied.
- [ ] **3.** Establish the explicitly selected starting portrait/archive snapshot; save hashes and reusable copies.
- [ ] **4.** Provide a runnable selected-file harness entry point; freeze/list files and share the selection with pipeline/counter before model calls.
- [ ] **5.** Enumerate the selected file’s trios offline with source references; this is the trio census used to suggest limits. For the optional July seed only, explain differences from 26.
- [ ] **6.** Verify file scope, the unchanged `all` default, zero matches, invalid targets, counter agreement, repeatable snapshots, and isolated writes; never fall back to a wider scope.

## T3 — Instrument actual model requests and limit controls

- [ ] **1.** Locate the installed agentLoop's actual request/stream boundary, including tool-follow-up turns, and determine whether the provider layer retries requests below that boundary; if it does, count at the lower layer or record the undercount risk. If the installed core exposes no usable hook, report that and stop; do not patch dependencies without approval.
- [ ] **2.** Add run/request IDs and stage, attempt, and validation-round tags.
- [ ] **3.** Capture start/end, model/provider, outcome, elapsed time, and reported usage; mark unavailable usage unknown.
- [ ] **4.** Count examined/productive trios, candidates, insert/merge/skip decisions, failures, and cooldown time separately.
- [ ] **5.** Take limits from required switches (`--run-type`, `--max-model-requests`, `--max-run-ms`) with no built-in defaults; accept only finite positive values and refuse to start without them. Enforce cancellation and the ceilings at each inference boundary; the run deadline is wall-clock time and includes cooldowns.
- [ ] **6.** Implement the start-of-run confirmation: after offline selection and trio count and before any model request, show the run type, limits, selected file with its trio count, output directory, and the cost notes in the compass.md (rule 4). The user accepts the suggested limits, enters their own, or cancels. On a terminal the harness asks; when an agent launches it, the harness refuses without `--confirmed`, which the agent passes only after the user approves in the session. Record suggested and final values and their source in the manifest.
- [ ] **7.** Implement the readable outputs from the request traces and pipeline results: the smoke results sheet (T4.5) and the baseline running table (T5.4).
- [ ] **8.** Verify counting, limit stops, no automatic restart, and refusal to start without the switches, without confirmation, or with non-finite or non-positive values, using offline follow-up/retry fixtures; keep credentials out of receipts.

## T4 — Smoke test (run type `smoke`)

Purpose: confirm the harness runs end to end and show sample output. This task makes no measurement claims.

- [ ] **1.** Freeze source, fixture, settings, selector/selected files/output path, initial portrait/scan state, run type, and suggested/final limits with their source in a manifest.
- [ ] **2.** Verify model availability/authentication without exposing credentials; record access blockers.
- [ ] **3.** Run the ungated selected-file pipeline under the confirmed `smoke` limits only after T2/T3 verification.
- [ ] **4.** Verify smoke pass criteria: the selector resolved the intended file; isolation held and the live portrait is unchanged (hashes); the counter counted actual requests, with at least one live request, cross-checked against provider-side usage where available; the run ended by completion or by a cap/deadline without automatic restart (offline T3.8 covers the cap-stop logic); a receipt was written with run type, limits and provenance, request traces, and stop reason; no credentials appear in artifacts; the results sheet was produced.
- [ ] **5.** Produce the results sheet: one entry per examined trio with its trio reference, the extractor’s output (candidate rules or none), the builder’s insert/merge/skip decision if reached, and the portrait diff. Present these as samples, not a quality measurement.
- [ ] **6.** Record the smoke result in stage.md as PASS or FAIL with the failing criterion. A run that ends by completion or by a cap, with all criteria met, is PASS. Record raw observations (requests, elapsed time, any usage) without projecting them to the full session.

## T5 — Baseline (run type `baseline`)

Purpose: produce the measured baseline that M1 requires. Runs only after the T4 smoke test passes.

- [ ] **1.** Report the T2.5 trio census and any smoke observations. Suggest `baseline` limits with their basis and assumptions (the compass.md row, if set). The user accepts them or enters their own at the start-of-run confirmation. Do not proceed without confirmed finite limits.
- [ ] **2.** Freeze a new manifest with run type `baseline`, the final limits and their source, and unchanged source/fixture/settings/selector/output revisions; if any changed since T4, invalidate affected evidence first. Restore the starting portrait/archive snapshot so the run starts from the recorded state.
- [ ] **3.** Run the ungated selected-file baseline under the confirmed limits; retain traces, outputs, failures, and stop reason.
- [ ] **4.** Report trio/candidate counts, requests by stage, retries/follow-ups, reported usage, total elapsed time, and cooldown contribution. Include the running table: for each trio, trios examined so far, cumulative productive rate, cumulative candidates, insert/merge/skip counts, and portrait size. Report what the run covered; do not extrapolate uncovered trios.
- [ ] **5.** Inspect a successful extraction and build trace for post-return requests; report observations without assuming savings. If the run never reached a build, record builder cost as unobserved. The user reviews a sample from the results sheet for quality; a measured quality comparison against labels belongs to Stage 5.
- [ ] **6.** Save the receipt and starting snapshots for Stage 2. If the run was capped before covering the selected file, label it incomplete; the user may raise the limits and the run repeats from step 2.

## Stage completion — M1

- [ ] **1.** Verify T1–T5 evidence against consistent source/settings/fixture revisions.
- [ ] **2.** Confirm scope-isolation checks, a passed smoke test, a runnable harness, and a completed baseline measurement; state limitations.
- [ ] **3.** Update task checks and stage.md with verified M1 evidence, or an incomplete outcome/blocker and next step. Stop this session; a later continuation selects the first unfinished stage.

Discover package/runtime details from the Pi checkout before asking for uploads. Missing access, unconfirmed limits, or a reached ceiling in `baseline` leaves dependent checks and M1 pending; preserve partial evidence and the next unfinished task in stage.md.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.1.1 | 2026-10-13 | S1 verification runs both `npm test` and `npm run test:compass` (harness suite split out of the default run). |
| 0.1.0 | 2026-10-11 | Initial committed draft. |
