# Stage 2 — Terminate successful calls and fix retries

Project: **pi-session-compass** · Revision: **0.1.0** · Status: **In progress (approved by the user 2026-10-14)**

Date: **2026-10-14**

Parent: [Development plan](plan.md), Stage 2. Contract: [Architecture](architecture.md). Operating rules: [AGENTS.md](../AGENTS.md). Bugs and findings: [bugs.md](bugs.md).

**Goal:** stop each LLM call at its first valid return-tool result, make `retries` mean initial attempt + N retries, and measure the effect against the capped S1 baseline. This stage edits `src/` (the termination and retry repairs) plus tests and harness reporting. It adds no gate, snapshots, or new settings.

Use [stage.md](stage.md) for continuation. Execute **T1 → T2 → T3 → T5**. T4 (Jev probe) is optional and runs only if the user asks for it at T5 or before. T1–T5 map to S2.T1–S2.T5 in the parent plan. The live run in T3 uses run type `compare`. Its limits are suggested at launch (150 requests / 5400000 ms, the baseline budget) and confirmed by the user. They are not pre-approved.

Scope guard: the zero-output responses (P2) are counted and reported in T3, not fixed here. Any fix that grows beyond T2's list is raised with the user before work starts.

## T1 — Verify termination compatibility

- [x] **1.** Confirm `terminate` in the installed agent-core (`@earendil-works/pi-agent-core` 1.0.0). A tool result's `terminate: true` ends the loop only when every call in the batch terminates (`shouldTerminateToolBatch`). Record how a mixed batch behaves (a return tool plus another tool, or two return calls) and how `toolExecution: "sequential"` affects this. *(evidence: outputs/s2-t1/termination-note.md: supported; a mixed batch costs one follow-up request; no Pi upgrade, E3 stays deferred)*
- [x] **2.** Write the mechanism down in a short T1 note under outputs/s2-t1/, citing file and line. If the behavior cannot support the patch, stop and document the alternative. Do not upgrade Pi.

## T2 — Patch terminal returns and retry handling

- [x] **1.** On a successful capture, return `terminate: true` from all four return tools: `return_extraction`, `return_post_extraction`, `return_building`, `return_maintenance`. Extraction's summary validation errors stay nonterminal, so the model can repair in the same attempt. *(evidence: src/collector.ts, builder.ts, maintenance-core.ts; tests/extraction.test.ts, builder.test.ts, maintenance.test.ts)*
- [x] **2.** Clear the captured response before each retry and each validation round, so a stale capture can never satisfy a later attempt. *(evidence: src/llm-call.ts reads a result only after a terminating capture in the current attempt (bugs.md P6); tests/llm-call.test.ts stale-capture cases, mutation-checked)*
- [x] **3.** Retry semantics: `retries: N` runs 1 + N attempts, so `retries: 0` runs exactly one (P5). Every resulting request still passes through the counter and limit guard. Update the code comment and the tests. If the README or CONFIGURATION states the old meaning, note the fix for S6. *(evidence: src/llm-call.ts `attempt <= maxRetries`; schema.ts and docs/CONFIGURATION.md already state 1 + N, so no doc change; tests/llm-call.test.ts, scripts/compass/offline-check.ts)*
- [x] **4.** P3: the building stage's failure message names "extraction". Fixing it is a protected-text change. Present the exact before and after to the user, apply it only after approval, or leave it recorded as open. *(evidence: user approved 2026-10-14: `LLM did not return a result through ${toolName}`, fallback `the required tool`; de8b168)*
- [x] **5.** Record each bug found in bugs.md as it is found. Update P1, P3, and P5 with their fix commits. *(evidence: md/bugs.md P1, P3, P5, P6)*

## T3 — Verify repairs and measure their effect

- [x] **1.** Offline verification with controlled model and stream fixtures covers: termination after one valid return (no follow-up request), repair of an invalid tool call, a response with no tool call, a timeout after capture, retry-zero (one attempt), retries-N (1 + N attempts), and a stale capture cleared between attempts. *(evidence: tests/llm-call.test.ts real agent loop with scripted turns; tests/compass/offline-boundary.test.ts `terminate` scenario: 1 counted request)*
- [x] **2.** Both full suites pass (`npm test`, `npm run test:compass`), with the raw results quoted. *(evidence 2026-10-14: `npm test` 16 files / 392 tests passed; `npm run test:compass` 8 files / 91 tests passed)*
- [x] **3.** Freeze a `compare` manifest: the same fixture, settings snapshot, and start snapshot (fixtures/snapshots/s1-start) as the S1 baseline, at the new source commit. Restore the start snapshot. Run a dry launch without `--confirmed`, show its block, and launch only after the user confirms the limits. *(evidence: outputs/s2-t3/compare/manifest.json, commit 94c9e26 clean; fixture, settings and start digest identical to S1; limits 150 / 5400000 ms user-confirmed 2026-10-14)*
- [x] **4.** Run the live `compare` in the background and keep its traces, receipt, sheets, and stop reason under outputs/s2-t3/. *(evidence: outputs/s2-t3/compare/: completed, 46 requests, 26.0 min; isolation hashes unchanged)*
- [x] **5.** Report against the baseline (outputs/s1-t5/baseline-attempt2-report.md): whether all 26 trios were covered within 150 requests; elapsed time; per-trio requests and time on trios 1–20; requests made after the first return-tool call (P1); zero-output responses (P2); requests by stage; and usage. Report what was covered and do not extrapolate. One run each, so model variance is a stated limitation. *(evidence: outputs/s2-t3/compare-report.md: same 20 trios, 150 → 46 requests, 56.9 → 26.0 min, post-return requests 96 → 0; 6 census trios unreachable in both runs, bugs.md P7)*

## T4 — Optional: Jev latency and rejection-share probe (run type `probe`)

Skipped unless the user asks for it. If requested, this file gets its steps (B14 `probe` in RUN_TYPES, question wording for approval, `TYPESAFE_API_KEY`, confirmed `probe` limits) before any work starts.

## T5 — Checkpoint with the user

- [ ] **1.** Report the repaired run's productive rate, requests per trio, and whether it covered the whole file.
- [ ] **2.** Ask the user to choose: raise the limit and rerun for fuller coverage, run the T4 probe, proceed to S3, or stop. Record the decision in stage.md. Do not start S3 without it.

## Stage completion — M2

- [ ] **1.** The repaired ungated baseline is established (T3 evidence), and the user's continue/stop decision is recorded (T5).
- [ ] **2.** Sync the task checks, stage.md, and bugs.md. Commit and push after both full suites pass.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.1.0 | 2026-10-14 | Initial draft from plan.md Stage 2. |
