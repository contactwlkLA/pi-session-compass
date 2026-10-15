# Stage 1 — Establish the baseline

Project: **pi-session-compass** · Revision: **0.4.1** · Status: **Complete (M1, baseline covers trios 1–20 by user decision)**

Date: **2026-10-14**

Parent: [Development plan](plan.md), Stage 1. Contract: [Architecture](architecture.md). Operating rules: [AGENTS.md](../AGENTS.md); read before execution and install at the Portrait checkout root.

**Goal:** produce a reproducible measured baseline of the current pipeline. Allow harness/instrumentation edits in the implementation checkout; keep pipeline outputs isolated from the live portrait. Preserve filtering, termination, retries, extraction, and building behavior for measurement.

Use [stage.md](stage.md) for continuation. Execute **T1 → T2 → T3 → T4 → T5**, then stop at **M1**. Selector/isolation and limit controls must pass offline before any live call. Every live run takes limits through harness switches and the user’s start-of-run confirmation (see [compass.md](compass.md), rules 2–4): T4 uses run type `smoke`, T5 uses run type `baseline`. T1–T5 map to S1.T1–S1.T5 in the parent plan. Lines use checkbox, execution number, action.

Initial review uses one unbranched conversation path. Branch support is deferred; it is outside the current plan. If the selected source contains branches, stop and request suitable single-path input before live calls; do not combine branches or silently choose one.

## T1 — Establish runtime and source identity

- [x] **1.** Read repository instructions; verify how Pi loads AGENTS.md and the exact launch command; record checkout, branch, commit, and existing changes. *(evidence: outputs/s1-t1/evidence.md, T1.1)*
- [x] **2.** Collect the installed package manifest, lockfile/resolved dependencies, scripts, and tests. *(evidence: outputs/s1-t1/evidence.md, T1.2)*
- [x] **3.** Verify and record Node, Pi, Portrait, and agent-core versions. *(evidence: outputs/s1-t1/evidence.md, T1.3)*
- [x] **4.** Hash the supplied archive and installed source; explain pipeline-relevant differences. *(evidence: outputs/s1-t1/evidence.md + archive-sha256.txt, T1.4; src/ identical across archive/installed/checkout)*
- [x] **5.** Save sanitized normalized settings: models, thinking, retries, batch size, cooldown, scan window, review, and maintenance. *(evidence: outputs/s1-t1/settings-snapshot.json, T1.5)*
- [x] **6.** Run applicable existing build/tests; record missing dependencies and pre-existing failures. Verification runs both `npm test` (upstream suite; `vitest.config.ts` excludes `tests/compass/**`) and `npm run test:compass` (harness suite, `vitest.compass.config.ts`, isolated). *(evidence: T1.6 baseline record below; `npm test` 15 files / 376 tests, `npm run test:compass` 3 files / 45 tests)*

  T1.6 baseline record:
  - Baseline environment: native WSL filesystem (~/compass-ext4). npm test: 15 files, 376 tests. npm run test:compass: 3 files, 45 tests.
  - Known intermittent: tests/llm-call.test.ts > attemptWithRetries backoff, the two tests "pauses with exponential backoff between attempts when the tool is not called" and "pushes an error-context nudge after a tool-not-called failure". Signature: each hits the 30 s test timeout, about 63 s total wall time. Observed on the unmodified fork base in 1 of 10 runs, and on the S1 tree without tests/compass in 2 of 10. Rule: rerun once. Fixed 2026-10-14: the agentLoop mock is shared from tests/setup.ts instead of mocked per file; the same failure (these two plus the two T3.2 validationRound tests in that file) occurred in 5 of 20 default-order runs before the fix and 0 of 20 after.
  - Unexplained intermittent (not a known flake): 2026-10-14, one full `npm test` run failed 14 tests in tests/pipeline.test.ts (runPipelineLoop, e.g. "expected +0 to be 1" for totalSequences); the immediate full rerun passed, the file passes alone, and 20 default-order `npx vitest run` runs had 0 failures. Treat a recurrence as a real failure and investigate.
  - On /mnt/i the suite also failed extension-idempotency (suite), cache-refresh and reload-lifecycle; these disappeared on the native filesystem and are not part of the baseline.

## T2 — Create the file-selecting, isolated fixture harness

- [x] **1.** Implement file selection through a selection object with an extensible `scope` field (`all` keeps today’s behavior as the default; `file` is new) and an independent output path. *(evidence: scripts/compass/selection.ts + scope tests)*
- [x] **2.** Accept/copy/hash the user-selected session JSONL; select only that file, independent of age. Put the harness in `scripts/`, the copied session and starting snapshot in `fixtures/`, and a per-run subdirectory of `outputs/` holding the isolated portrait, archives, state/checkpoints, locks, and diagnostics. Use synthetic fixtures offline until the target is supplied. *(evidence: fixtures/sessions/ frozen July seed + july-seed-receipt.json)*
- [x] **3.** Establish the explicitly selected starting portrait/archive snapshot; save hashes and reusable copies. *(evidence: fixtures/snapshots/s1-start/ frozen from the live ~/.pi/portrait, git HEAD 7b9c52e8, six files matching outputs/s1-t2.3/hashes-before.txt; user-confirmed 2026-10-13; runs start from it via execute --start-snapshot, tests/compass/start-snapshot.test.ts)*
- [x] **4.** Provide a runnable selected-file harness entry point; freeze/list files and share the selection with pipeline/counter before model calls. *(evidence: scripts/compass/run.ts `prepare`/`execute`; selection.json)*
- [x] **5.** Enumerate the selected file’s trios offline with source references; this is the trio census used to suggest limits. For the optional July seed only, explain differences from 26. *(evidence: scripts/compass/census.ts; July seed observed 26 = claimed 26, outputs/s1-census/)*
- [x] **6.** Verify file scope, the unchanged `all` default, zero matches, invalid targets, counter agreement, repeatable snapshots, and isolated writes; never fall back to a wider scope. *(evidence: tests/compass/compass-harness.test.ts, T2.6)*

## T3 — Instrument actual model requests and limit controls

- [x] **1.** Locate the installed agentLoop's actual request/stream boundary, including tool-follow-up turns, and determine whether the provider layer retries requests below that boundary; if it does, count at the lower layer or record the undercount risk. If the installed core exposes no usable hook, report that and stop; do not patch dependencies without approval. *(evidence: outputs/s1-t1/evidence.md, T3.1 addendum; provider retry default 0 for meta path)*
- [x] **2.** Add run/request IDs and stage, attempt, and validation-round tags. *(evidence: run ID in selection.json; request seq in counter.ts; stage, attempt and validationRound on attempt events in src/llm-call.ts, validationRound passed from the builder and maintenance validation loops and the extraction calls; receipt validationRounds in pipeline-boot.ts; tests/builder.test.ts, tests/maintenance.test.ts, tests/extraction.test.ts, tests/llm-call.test.ts, tests/compass/validation-rounds-receipt.test.ts)*
- [x] **3.** Capture start/end, model/provider, outcome, elapsed time, and reported usage; mark unavailable usage unknown. *(evidence: attempt events + counter.ts boundary traces; usage summed over attempt messages)*
- [x] **4.** Count examined/productive trios, candidates, insert/merge/skip decisions, failures, and cooldown time separately. *(evidence: src/instrument.ts hooks; counter.ts RunStats)*
- [x] **5.** Take limits from required switches (`--run-type`, `--max-model-requests`, `--max-run-ms`) with no built-in defaults; accept only finite positive values and refuse to start without them. Enforce cancellation and the ceilings at each inference boundary; the run deadline is wall-clock time and includes cooldowns. *(evidence: scripts/compass/limits.ts + counter.ts guard; refusal tests)*
- [x] **6.** Implement the start-of-run confirmation: after offline selection and trio count and before any model request, show the run type, limits, selected file with its trio count, output directory, and the cost notes in the compass.md (rule 4). The user accepts the suggested limits, enters their own, or cancels. On a terminal the harness asks; when an agent launches it, the harness refuses without `--confirmed`, which the agent passes only after the user approves in the session. Record suggested and final values and their source in the manifest. *(evidence: scripts/compass/confirmation.ts + strings.ts, all harness strings user-approved 2026-10-14 and the DRAFT header removed; tests/compass/strings.test.ts, limits-counter.test.ts)*
- [x] **7.** Implement the readable outputs from the request traces and pipeline results: the smoke results sheet (T4.5) and the baseline running table (T5.4). *(evidence: scripts/compass/pipeline-boot.ts writes results-sheet.md and running-table.md for every run type; renderRunningTable rows capture cumulative counts and portrait size when each trio is examined; strings user-approved 2026-10-14; tests/compass/running-table.test.ts)*
- [x] **8.** Verify counting, limit stops, no automatic restart, and refusal to start without the switches, without confirmation, or with non-finite or non-positive values, using offline follow-up/retry fixtures; keep credentials out of receipts. *(evidence: tests/compass/limits-counter.test.ts + offline-boundary.test.ts, T3.8)*

## T4 — Smoke test (run type `smoke`)

Purpose: confirm the harness runs end to end and show sample output. This task makes no measurement claims.

- [x] **1.** Freeze source, fixture, settings, selector/selected files/output path, initial portrait/scan state, run type, and suggested/final limits with their source in a manifest. *(evidence: outputs/s1-t4/smoke/manifest.json — source commit, fixture sha256, settings snapshot, selection, start snapshot digest, run type, suggested/final limits with source; outputs/s1-t4/smoke-result.md)*
- [x] **2.** Verify model availability/authentication without exposing credentials; record access blockers. *(evidence: meta/muse-spark-1.3-contributor resolves in the registry; auth.json has an api-key entry for meta (value not read); live requests 1–4 returned usage — outputs/s1-t4/smoke-result.md)*
- [x] **3.** Run the ungated selected-file pipeline under the confirmed `smoke` limits only after T2/T3 verification. *(evidence: outputs/s1-t4/smoke/ — attempt 3 after two harness repairs, attempts 1–2 kept under outputs/s1-t4/)*
- [x] **4.** Verify smoke pass criteria: the selector resolved the intended file; isolation held and the live portrait is unchanged (hashes); the counter counted actual requests, with at least one live request, cross-checked against provider-side usage where available; the run ended by completion or by a cap/deadline without automatic restart (offline T3.8 covers the cap-stop logic); a receipt was written with run type, limits and provenance, request traces, and stop reason; no credentials appear in artifacts; the results sheet was produced. *(evidence: outputs/s1-t4/smoke-result.md criteria table; provider-side cross-check partial: response usage only)*
- [x] **5.** Produce the results sheet: one entry per examined trio with its trio reference, the extractor’s output (candidate rules or none), the builder’s insert/merge/skip decision if reached, and the portrait diff. Present these as samples, not a quality measurement. *(evidence: outputs/s1-t4/smoke/results-sheet.md + running-table.md; no build completed)*
- [x] **6.** Record the smoke result in stage.md as PASS or FAIL with the failing criterion. A run that ends by completion or by a cap, with all criteria met, is PASS. Record raw observations (requests, elapsed time, any usage) without projecting them to the full session. *(evidence: md/stage.md smoke result PASS; raw observations in outputs/s1-t4/smoke-result.md)*

## T5 — Baseline (run type `baseline`)

Purpose: produce the measured baseline that M1 requires. Runs only after the T4 smoke test passes.

- [x] **1.** Report the T2.5 trio census and any smoke observations. Suggest `baseline` limits with their basis and assumptions (the compass.md row, if set). The user accepts them or enters their own at the start-of-run confirmation. Do not proceed without confirmed finite limits. *(evidence: census 26 trios; smoke observations; suggested 150 requests / 5400000 ms as agent suggestion, user-confirmed — outputs/s1-t5/baseline/manifest.json)*
- [x] **2.** Freeze a new manifest with run type `baseline`, the final limits and their source, and unchanged source/fixture/settings/selector/output revisions; if any changed since T4, invalidate affected evidence first. Restore the starting portrait/archive snapshot so the run starts from the recorded state. *(evidence: outputs/s1-t5/baseline/manifest.json — commit da9987a clean; fixture, settings snapshot and start-snapshot digest identical to T4; start restored from fixtures/snapshots/s1-start)*
- [x] **3.** Run the ungated selected-file baseline under the confirmed limits; retain traces, outputs, failures, and stop reason. *(evidence: outputs/s1-t5/baseline/ receipt, traces, sheets; attempt 1 (one pipeline pass, 2 trios) kept in outputs/s1-t5/baseline-attempt1-one-pass/)*
- [x] **4.** Report trio/candidate counts, requests by stage, retries/follow-ups, reported usage, total elapsed time, and cooldown contribution. Include the running table: for each trio, trios examined so far, cumulative productive rate, cumulative candidates, insert/merge/skip counts, and portrait size. Report what the run covered; do not extrapolate uncovered trios. *(evidence: outputs/s1-t5/baseline-attempt2-report.md + running-table.md; covers trios 1–20 only)*
- [x] **5.** Inspect a successful extraction and build trace for post-return requests; report observations without assuming savings. If the run never reached a build, record builder cost as unobserved. The user reviews a sample from the results sheet for quality; a measured quality comparison against labels belongs to Stage 5. *(evidence: 98 of 150 requests followed the attempt's first return-tool call — outputs/s1-t5/baseline-attempt2-report.md; user reviewed the results-sheet sample 2026-10-14: "I suppose it's fine")*
- [x] **6.** Save the receipt and starting snapshots for Stage 2. If the run was capped before covering the selected file, label it incomplete; the user may raise the limits and the run repeats from step 2. *(evidence: receipt and traces in outputs/s1-t5/baseline/, start snapshot fixtures/snapshots/s1-start/; run capped at 150 requests after 20 of 26 trios; by user decision 2026-10-14 this capped run is the S1 baseline: running past that budget is not acceptable, so the cap is itself the benchmark; comparisons check coverage within 150 requests and per-trio rates on trios 1–20 — plan.md, M1 exception)*

## Stage completion — M1

- [x] **1.** Verify T1–T5 evidence against consistent source/settings/fixture revisions. *(evidence: T4 and T5 share fixture b75a1246…, settings snapshot, start digest 51f057ec…; src/ unchanged between them, harness-only fixes)*
- [x] **2.** Confirm scope-isolation checks, a passed smoke test, a runnable harness, and a completed baseline measurement; state limitations. *(evidence: isolation hashes for every live run; smoke PASS; harness runnable via node_modules/.bin/jiti scripts/compass/run.ts; limitation: baseline covers 20 of 26 trios by user decision, one run, model output varies between runs)*
- [x] **3.** Update task checks and stage.md with verified M1 evidence, or an incomplete outcome/blocker and next step. Stop this session; a later continuation selects the first unfinished stage. *(evidence: md/stage.md)*

Discover package/runtime details from the Pi checkout before asking for uploads. Missing access, unconfirmed limits, or a reached ceiling in `baseline` leaves dependent checks and M1 pending; preserve partial evidence and the next unfinished task in stage.md.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.4.1 | 2026-10-14 | T5.6 evidence states why the capped baseline stands. |
| 0.4.0 | 2026-10-14 | T5 and M1 checked. By user decision the capped baseline (20 of 26 trios) is the S1 baseline. T1.6 record: an unexplained pipeline.test.ts intermittent failure. |
| 0.3.2 | 2026-10-14 | T4.1–T4.6 checked with evidence (smoke PASS). |
