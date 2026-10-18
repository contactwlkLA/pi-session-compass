# pi-session-compass — Development Plan

Revision: **0.12.0** · Status: **Draft for review** · Date: **2026-10-11 PDT**

Contract: [Architecture specification](architecture.md)

## 1. Delivery objective

Implement a conservative Jev gate before Portrait’s existing extractor, prove actual savings, and preserve work across extraction/build failures and restart. Deliver the existing Portrait workflow with mode off, shadow, or enforce; default to off until evaluation supports activation.

Build order is linear by intent: a measured foundation first (S1–S2), then recovery (S3), then the gate (S4), evaluation (S5), and handoff (S6). Later stages are designed to extend earlier ones, but known touch points exist: S3 replaces the old checkpoint files as the scan-position authority, so S1’s trio counter and harness must read the new snapshot; S3’s trio-boundary scan position can change trio boundaries relative to the S1 census; and S4 reuses S1’s request counter and confirmation flow.

Execute one stage per Pi session using [stage.md](stage.md) as the continuation index. Each stage has a task checklist; partial or blocked work resumes in the next session. Mark a stage complete only after milestone verification, then stop that session’s work. Missing task files are blockers, not permission to invent instructions. Milestones are verification checkpoints within the complete scope, not separate rewrites. No implementation, installation, live model call, or project mutation has been performed while drafting these documents.

Live-run limits are set per run type (`smoke`, `baseline`, `compare`, `probe`, `evaluate`, `collect`). Every live run takes finite limits through harness switches and the user’s start-of-run confirmation; the compass.md run-type table supplies the suggested values. This plan names run types, not numbers.

Working estimate: **16–27 active AI-assisted implementation and verification hours**, excluding waiting for credentials, user labeling, or missing package access. This assumes the full package can be made runnable and its existing tests can be recovered. The source-only archive is enough for design but insufficient for a clean package build. These are planning allowances, not measured durations. Labeling effort for Stage 5 is not included and is not yet estimated. The optional S2.T4 probe is not included either.

## 2. Stage sequence

A **stage** groups related work toward one outcome. A **task** is a checkable unit of work within that stage, identified as `S1.T1`, `S1.T2`, and so on. A **milestone** is the evidence that the stage is complete. Task checkboxes record implementation progress; issuing this document does not mark them complete.

| Stage | Work | Observable result | Allowance |
|---|---|---|---|
| S1 | Verify runtime, implement file selection with isolated output, instrument requests and limit controls, smoke-test, then measure the baseline | Passed smoke test with results sheet, baseline receipt with running table, and isolated selector/harness | 2–4 h |
| S2 | Correct return-tool termination and retry semantics, then check in with the user | Request trace showing successful tool calls end; retry-zero works; user continue/stop decision | 1–2 h (+0.5–1 h if the optional S2.T4 probe is taken) |
| S3 | Implement snapshot recovery, trio-boundary scan position, locking, and migration | Interrupted or failed work resumes from the last snapshot without losing candidates | 4–6 h |
| S4 | Add TypeSafe adapter, policy, modes, and bounded execution | Mocked off/shadow/enforce behavior and fail-open routing pass | 3–5 h |
| S5 | Build the evaluation set and run shadow comparisons | Held-out quality/cost report with raw counts and observed outputs | 3–5 h |
| S6 | Settings/diagnostics, operating instructions, acceptance, and handoff | Reviewable release candidate, rollback instructions, and evidence | 3–5 h |
| S7 | Fix the small open bugs, finish deferred help text and docs, one-place settings, investigate the rest | Bugs fixed or dispositioned in bugs.md; settings reviewable in one place | 3–5 h |
| S8 | Session report: log analytics, your interventions, lessons and their quality, behavior before and after the portrait | One read-only report command over a session folder ([stage-8-task.md](stage-8-task.md)) | 4–7 h |
| S9 | Better lessons: rules state situation, changed action, and reason, and come only from the user's reply | Extraction, building, and maintenance prompts revised and measured on the S8-04 trios ([stage-9-task.md](stage-9-task.md)) | 2–4 h |
| **Total** | | | **18–31 h** (+0.5–1 h with the optional probe) |

Proceed S1 → S2 → S3 → S4 → S5 → S6. Policy development can use the seed sample without waiting for broader history, but enforce mode cannot pass Stage 5 on that sample alone.

Deferred and outside this plan: workspace/all-scope selection, public selection controls, and branch-aware review. Parked ideas from the user, 2026-10-14: session-length signal from the census trio count; corrections-per-session trend across ~/.pi/agent/sessions (free, offline); Jev per-trio probabilities as usage analytics. S8 schedules the session-analytics ideas. Seams that keep them additive: the selection object’s `scope` field, trio IDs derived from session and entry IDs, and the source path/cwd stored with pending candidates.

## 3. Stage 1 — establish the baseline

### Tasks

- [ ] **S1.T1 — Establish runtime and source identity.** Obtain the installed package manifest, dependency lock/report, scripts, tests, and runtime versions from the local implementation environment. Record archive/source hashes and exact Pi/core versions. Read any applicable repository working rules before editing, and verify how Pi loads AGENTS.md and the exact launch command (both inherited from earlier drafts, unverified).

- [ ] **S1.T2 — Create the isolated fixture harness.** Implement file selection through a selection object with an extensible `scope` field (`all` keeps today’s behavior as the default; `file` is new) plus an independent portrait output directory. Freeze/list the selected file before model calls; use the same selection for the scanner and background counter. Accept the user-selected session JSONL in file mode independent of age; the July sample is an optional offline seed fixture. Isolate all output/state/lock paths. A runnable selected-file entry point and synthetic checks must pass before live calls. Verify file scope, unchanged `all` default, zero matches, invalid targets, and counter agreement using temporary fixtures. Enumerate the selected file’s trios offline; this census is used to suggest limits.

- [ ] **S1.T3 — Instrument actual model requests and limit controls.** Instrument the actual model-request boundary, not merely the logical helper call, and determine whether the provider layer retries below that boundary (count at the lower layer or record the undercount). Count follow-up model turns, retries, validation retries, post-extraction, building, and maintenance separately. Take limits from required harness switches (`--run-type`, `--max-model-requests`, `--max-run-ms`) with no built-in defaults; accept only finite positive values; enforce the ceilings at the request boundary, with the deadline measured in wall-clock time including cooldowns. Implement the start-of-run confirmation: after the offline trio count and before any model request, show the run type, limits, file, trio count, output directory, and cost notes; the user accepts the suggestion, enters their own values, or cancels; agent-launched runs need `--confirmed`, passed only after the user approves in the session. Record suggested and final values with their source. Implement the smoke results sheet and the baseline running table. Verify counting, limit stops, and refusals (missing switches, no confirmation, invalid values) with offline mocks before any live call. Capture usage if exposed; unavailable usage must be marked unknown. If the installed core exposes no usable request-boundary hook, report it and stop rather than patching dependencies.

- [ ] **S1.T4 — Smoke test (run type `smoke`).** Confirm the harness runs end to end under confirmed `smoke` limits and show sample output. Pass criteria: the selector resolved the intended file; isolation held and the live portrait is unchanged; the counter counted actual requests, with at least one live request, cross-checked against provider-side usage where available; the run ended by completion or by a cap/deadline with no automatic restart; a receipt was written with run type, limits and provenance, traces, and stop reason; no credentials appear in artifacts; the results sheet (one entry per examined trio: trio reference, extractor output, builder decision if reached, portrait diff) was produced. A run that ends by completion or by a cap, with all criteria met, is a PASS. The smoke test makes no measurement claims, and the results sheet is samples, not a quality measurement.

- [ ] **S1.T5 — Baseline (run type `baseline`).** After the smoke test passes, report the trio census and suggest `baseline` limits with their basis; the user accepts or enters their own at the start-of-run confirmation. Run the ungated selected-file pipeline from the recorded starting portrait under the confirmed limits. Baseline evidence must state the selected root/scope/target/file list/output directory, input corpus, starting portrait, settings, run type and final limits with their source, initial scan/work state, model versions, examined trios, candidates, actual requests by stage, cooldown contribution, elapsed time, and observed failures. Include the running table (trios examined so far, cumulative productive rate, cumulative candidates, insert/merge/skip counts, portrait size, per trio). If the July seed is used, compare its observed trio count with 26 and explain discrepancies; other sessions have their own counts. Report only what the run covered, with no extrapolation of uncovered trios. If no build was reached, record builder cost as unobserved. The user reviews a sample of results for quality. A capped baseline is incomplete and may be repeated after the user raises the limits.

**Milestone M1:** verified file selection/isolation, limit controls and start-of-run confirmation, a passed smoke test, a runnable harness, and a completed declared baseline measurement with its evidence. A capped or blocked baseline retains its partial evidence but does not satisfy M1. No speedup claim before this point.

**M1 exception:** by user decision on 2026-10-14, the S1 baseline is the capped `baseline` run: 150 requests, 20 of 26 trios, 56.9 minutes. Running past that budget is not acceptable for this workload, so the cap is itself the benchmark: the unchanged pipeline cannot cover one 26-trio session within 150 requests. M1 was checked on that basis; later comparisons use the same file and settings.

## 4. Stage 2 — terminate successful calls and fix retries

### Tasks

- [ ] **S2.T1 — Verify termination compatibility.** Inspect the installed agent-core type and loop for `terminate` behavior, including batches of tool results. If unsupported, stop this patch and document the compatible alternative; do not silently upgrade Pi.

- [ ] **S2.T2 — Patch terminal returns and retry handling.** Patch successful captures for all four return tools. Keep extraction summary validation errors nonterminal. Clear captured responses before retries and validation rounds. Fix retry semantics to initial attempt + configured retries, with budget checks for every resulting request.

- [ ] **S2.T3 — Verify repairs and measure their effect.** Use controlled model/stream fixtures to verify successful termination, invalid-tool repair, missing-tool response, timeout after capture, and retry-zero behavior. Run one bounded live comparison (run type `compare`) on the same corpus and settings, under limits the user confirms at launch. Preserve before/after traces. Against the capped S1 baseline (M1 exception), report whether the run covers all 26 trios within the baseline budget (150 requests), its elapsed time, and per-trio requests and time on trios 1–20, which both runs cover.

- [ ] **S2.T4 — Optional: Jev latency and rejection-share probe (run type `probe`).** Skippable; nothing else in the plan depends on it, and S4 is built against mocks either way. A standalone script in `scripts/`, outside the pipeline, sends each eligible trio of the S1 fixture to Jev once in the four-question format of architecture.md §4 and records latency, the four probabilities, and errors. It needs `TYPESAFE_API_KEY` and user-confirmed `probe` limits (see compass.md). Present the question wording to the user for approval before use, and keep the drafts for S4. Report the median and spread of G, the share of trios at or below the 0.10 rejection rule, and an indicative break-even using E and p from S1. It makes no safety claim: missed lessons need the Stage 5 labels.
- [ ] **S2.T5 — Checkpoint with the user.** Report the repaired baseline’s measured productive rate and requests per trio, and whether the run covered the whole file. If the probe was run, include its G and rejection share. Ask the user to choose: raise the limit and rerun for fuller coverage, proceed to S3, or stop. Record the decision in stage.md. Do not start S3 without it.

**Milestone M2:** the repaired ungated baseline is established and the user’s continue/stop decision is recorded. All later savings compare primarily against this version, not the original wasteful loop.

## 5. Stage 3 — preserve pending work

### Tasks

- [ ] **S3.T1 — Implement snapshot storage.** Implement the architecture’s snapshot: a directory under the output directory holding a schema version, state, and copies of the portrait and archive files. Write each snapshot beside the previous one, flush it, then switch; at startup use the newest complete snapshot. A corrupt or unsupported snapshot stops processing, never resets progress.

- [ ] **S3.T2 — Preserve typed outcomes and pending candidates.** Split extraction success-empty from failure. Derive trio IDs from the session header ID and entry IDs (or a hash of the trio’s own records), never a whole-file hash; derive candidate IDs from trio ID and ordinal. Preserve raw candidates before optional post-review. Store source path/cwd with pending candidates; in file mode drain only those matching the selected file. Take snapshots at two boundaries: after a trio’s candidates are saved with the scan position, and after a build batch’s files are written (removing its candidates). A failed review/build keeps its candidates and stops cleanly.

- [ ] **S3.T3 — Implement the trio-boundary scan position.** Save the scan position only at a trio boundary, at the start of the trio’s closing assistant record, so the next scan can reconstruct the assistant message before the next user turn. Handle complete JSONL boundaries, Unicode byte offsets, partial tails, appended records, source identity mismatch, and adjacent trios. Limit parse-error catches to parsing so they cannot swallow extraction or snapshot failures; report malformed complete records.

- [ ] **S3.T4 — Validate builds.** Strengthen whole-batch validation: exactly one action per candidate, valid references, and no conflicting operations. A valid all-skip batch completes without file writes. Git remains an optional audit layer; a Git failure never discards candidates.

- [ ] **S3.T5 — Integrate shared locking, migration, and reset.** Make reset use the collection mutex, as collection and maintenance already do. With no snapshot yet, seed scan positions once from the legacy progress file; from the first snapshot on, the snapshot is the authority and the legacy file is a read-only mirror for the advisory background counter. Preserve the existing portrait. Reset clears the snapshot.

- [ ] **S3.T6 — Verify lifecycle and cancellation behavior.** Ensure stop/pause/reload/shutdown do not release the mutation lock while a writer remains active. Do not promise immediate abort for operations that cannot be interrupted; retain the existing “stop after current step” behavior with bounded remote calls. Existing cache/injection semantics stay intact.

### Verification

Necessary failure tests:

- Extraction failure leaves the trio eligible for retry and is never recorded as an empty result.
- A run stopped after candidates were saved builds them next run without re-extraction.
- Invalid builder output (missing, duplicate, or unknown candidate IDs; conflicting operations) is rejected before any write and retried; exhausted retries keep the candidates.
- An all-skip result completes without file writes; an optional-review failure preserves raw rules.
- Restarted scanning emits the same trios as uninterrupted scanning, including append-at-EOF cases.
- File-mode runs leave pending candidates from other sources untouched.
- Legacy positions seed the scan once, reset clears the snapshot under the mutex, and legacy checkpoint files are no longer authoritative.

**Milestone M3:** pending-work and validation tests pass in isolated fixtures. Old offsets cannot establish historical completeness.

## 6. Stage 4 — add the Jev gate and run limits

### Tasks

- [ ] **S4.T1 — Implement the Jev adapter and question policy.** Implement a small direct-HTTP adapter to TypeSafe, using the documented wire shape and a credential from the environment. Pin the tested model. Send correction, preference, steering, and confusion Nouls together. Keep the policy text, hash, threshold, and state serialization in one versioned module.

- [ ] **S4.T2 — Implement modes and conservative routing.** Add off/shadow/enforce settings. Start with the proposed all-probabilities-≤0.10 rejection threshold, 32 KiB state cap, five-second total gate deadline, and one transient retry. These are tunable proposals. Validate every required answer before rejection; missing key, provider failure, invalid data, or oversized state bypasses to extraction.

- [ ] **S4.T3 — Extend limit controls to the Jev path.** Reuse the Stage 1 switches, confirmation, and counter. Enforce at the actual request boundary for every inference attempt across Jev, repairs, reviews, building, and auto-maintenance; check cancellation/deadlines inside scanning. Multiple Jev questions in one request count once. Keep `/portrait:collect N` as a separate productive target. If extraction capacity is exhausted, stop before committing a would-be passed trio; if building capacity expires, leave candidates pending.

- [ ] **S4.T4 — Verify gate behavior and failure paths.** Verify mocked positive, low, mixed, and uncertain probabilities; wrong/missing answers; non-finite values; missing key; transient backoff; nonretryable errors; oversized state; gate deadline; bypass after repeated failures; and budget exhaustion with no productive result. Confirm shadow never skips extraction.

**Milestone M4:** the gate can operate in shadow mode and all error paths preserve extraction opportunity or pending work.

## 7. Stage 5 — evaluate policy and savings

### Notes for planning (user, 2026-10-16)

- **Shorter measurement runs.** The scanner reads the frozen session in order, so a copy cut off after trio k holds exactly trios 1–k. Measure on a short prefix and compare trio by trio with the S1 baseline's rows for those trios; no new baseline is needed. Per-trio extraction and gate decisions compare cleanly; builder outcomes do not, since the portrait accumulates.
- **Extraction cache (do first).** Key stored extraction results by `trioId` + `policyRevision` and reuse them in comparison runs; only the stage under test (gate, builder) makes model requests. Harness-only; reused results count as zero requests.
- **Parallel extraction and gate calls (harness only).** Per-trio extraction and Jev calls are independent, so a measurement run can issue a few at once (e.g. 4) within provider rate limits; building stays sequential. The plugin stays sequential (architecture.md §3).

### Tasks

- [ ] **S5.T1 — Prepare policy-development fixtures.** Use the supplied session for development examples, including confusion, a warning against a wrong start, mixed instructions, and one-word approvals. Treat previous candidate examples as human hypotheses, not model-produced positives. Do not expand deterministic exclusions broadly without testing short refusals/corrections.

- [ ] **S5.T2 — Label and freeze development and held-out sets.** Select additional session trios and freeze development/held-out splits before threshold tuning. Human labels identify potential reusable behavioral lessons; extractor outputs supply a second comparison. Save disagreements and the relevant source references. Label correction-type cases explicitly. Size the held-out set to the activation criteria in S5.T5.

- [ ] **S5.T3 — Run paired quality and cost comparisons.** Before running shadow (run type `evaluate`), the user confirms an evaluation budget adequate for the frozen set at launch; do not presume the `smoke` row is sufficient. Record Jev predictions, extractor outputs, original/repaired baseline cost, and the projected/observed enforce route. When comparing end-to-end builds, reset to identical starting portraits and replay the same candidate order. Account for all gate, extractor, builder, retry, and maintenance usage; do not infer total savings solely from rejected-trio count.

- [ ] **S5.T4 — Audit predicted rejections and missed lessons.** Review all held-out misses and a uniform random audit of up to 200 predicted rejections, or all if fewer. The audit’s useful-lesson rate among rejects is distinct from retained-positive recall. If outputs or usage are missing, say what cannot be concluded. Include labeling/model-run cost separately from operating cost.

- [ ] **S5.T5 — Produce the activation decision report.** Proposed activation checks: no held-out correction misses, ≥95% human-labeled useful-trio retention, and lower measured total cost than the repaired ungated baseline. Set minimum sample sizes before tuning: zero misses in n labeled cases supports only a miss rate of about 3/n at 95% confidence (rule of three), so bounding the miss rate at 5% needs about 60 labeled positives, and 1% about 300. Report numerators, denominators, and the resulting bound. If the set is smaller, label the result preliminary and remain in shadow. Publish elapsed time and corpus limitations. Do not choose a favorable threshold on the held-out split and still call it held out.

**Milestone M5:** a reviewable quality/cost decision exists. Illustrative bridge estimates, including 4×, remain unmeasured unless this evaluation establishes them.

## 8. Stage 6 — settings, acceptance, and handoff

### Notes for planning (user, 2026-10-16)

- **User-friendly setup.** The end product's configuration should be reviewable from one place, not spread across files: extend the single-file approach used for the gate (src/gate-config.ts, S4-02) to the rest of the plugin's setup (extraction and building models, limits, cooldowns), or present all of it in one settings view. Not urgent; plan it here.

### Tasks

- [ ] **S6.T1 — Update user-facing settings and diagnostics.** Update settings/status help with actual candidate-batch units, run stop reasons, pending work, mode, bypass count, and evaluated policy/model. Correct the debug-path description and remove inert builder-prompt HTML comments in an isolated change. Verify prompt cleanup separately from gate effects.

- [ ] **S6.T2 — Write operating and rollback instructions.** Document how to enable shadow, inspect evidence, activate enforce after evaluation, turn the gate off, roll back by hand from a snapshot after a failure, select an input file and an independent output directory, inspect selected paths, rescan explicitly, and migrate back safely. Gate-off rollback retains the recovery improvements. Downgrade rollback requires preserving pending candidates from the snapshot; the older plugin resumes from the legacy progress file, which stays in sync as a mirror. It is not just replacing package files.

- [ ] **S6.T3 — Validate the release candidate.** Run the exit checks below and retain the results.

- [ ] **S6.T4 — Set the delivered gate mode.** Use the evaluation evidence to choose off, shadow, or enforce; state any unmet activation criterion.

- [ ] **S6.T5 — Assemble the implementation handoff.** Package the diff/commit, version records, evidence, and operating instructions listed below; synchronize the design documents with the final scope.

### Exit checks

Complete these checks once against the release candidate; repeat only when a relevant change or unresolved failure warrants it:

1. Clean package build and applicable existing tests pass.
2. Successful return-tool calls terminate as verified by request-boundary evidence; `retries: 0` makes one attempt.
3. Gate-off and shadow preserve the repaired baseline’s extraction opportunity and pending-work semantics.
4. Enforce rejects only valid all-low answers under the evaluated policy; failure paths bypass or stop recoverably.
5. Snapshot, scan-position, and recovery tests pass without silent loss of candidates.
6. Run budgets stop unproductive scans and model retries without skipping unfinished work, and no live run starts without confirmed finite limits.
7. Migration/lifecycle/maintenance/reset and file-selection checks pass in temporary directories; tests leave the live portrait untouched.
8. Evaluation evidence supports activation, or the delivered configuration remains off/shadow with the limitation stated.

Handoff contents: implementation diff/commit, exact dependency versions, test results, migration/rollback instructions, frozen policy/settings, fixture references, and measured baseline/evaluation receipts. Keep the document set, stage/task continuation, compass.md run-type table, and final scope synchronized. Do not ship enforce by default merely because its code is complete.

**Milestone M6:** release candidate and handoff evidence are complete, with the delivered gate mode stated.

**Delivered (2026-10-17):** gate mode `off`. Activation checks 1 and 2 are unmet on the scale-up folder (corrections missed 3 of 29, lessons kept 94%); check 3 is met. Handoff: [handoff.md](handoff.md). Stage 6 ran a narrowed scope ([stage-6-task.md](stage-6-task.md)); the rest of S6.T1 and S6.T2 is deferred there.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.10.0 | 2026-10-17 | Stage 7 (fixes and deferred cleanup) added; tasks in stage-7-task.md. |
| 0.11.0 | 2026-10-18 | Stage 8 (session report) added; draft tasks in stage-8-task.md. |
| 0.12.0 | 2026-10-18 | Stage 9 (better lessons) added and completed. |
