# Stage 4 — Task specs (Pi codes, Claude Code reviews)

Project: **pi-session-compass** · Revision: **0.4.0** · Status: **Approved (user, 2026-10-16)**

Date: **2026-10-16**

Parent: [stage-4-task.md](stage-4-task.md) (fixed design, approved text Q/U/S/H). Contract: [architecture.md](architecture.md) §4.

**Coder rules, spec audit, and handoff format:** [stage-3b.md](stage-3b.md), section "Coder rules", unchanged, except that the audit and handoff go to `outputs/s4/handoff/<task_id>-audit.md` and `outputs/s4/handoff/<task_id>-r<round>.md`.

## S4-01 — Jev adapter and plugin wiring

**Vocabulary (CC, 2026-10-16):** use these terms in code, tests, and notes: a gate result is `no_lesson` (would skip extraction), `maybe_lesson`, or a `fallback` to extraction with a reason; a run with no request capacity left is `over_budget`. (The provider content filter stopped earlier sessions three times while reasoning about this module; plain wording is less likely to trip it.)

Add the Jev gate to the plugin: a transport-and-policy module, a gate step before extraction with three modes, and instrumentation hooks for the harness. No harness changes (S4-02). No live call: every test mocks `fetch`.

**Read:** md/stage-4-task.md sections "Fixed design" and "Protected text" (the Q, U1, U2 and S texts are the only approved strings); src/collector.ts lines 505–600 (`streamAndExtract`, `savePosition`, `tryExtractTrio`); src/pipeline.ts lines 125–160 (`runPipelineLoop` start); src/instrument.ts (whole); src/schema.ts lines 1–60 and 150–245 (interface, a boolean setting, the tab lists); src/error.ts (`reportError`); src/types.ts (`InteractionSequence`); tests/extraction-outcomes.test.ts (template for driving a scan through `tryExtractTrio` with the mocked extractor); tests/setup.ts (central mocks).

**Where and how (CC's plan):**

1. **src/jev.ts (new): policy, state, transport, routing.** No imports from the rest of `src/` except types.
   - `JEV_POLICY` (a frozen object): `model: "jev-1.13.0"`, `threshold: 0.1`, `stateCapBytes: 32 * 1024`, `deadlineMs: 5000`, `defaultRetryWaitMs: 500`, `endpoint: "https://api.typesafe.ai/v1/systemone"`, `questions` (the four Q entries, keyed `correction`, `preference`, `steering`, `confusion`, each `{ type: "noul", instructions: PREFIX + question, criteria: { true, false } }`, texts exactly as approved). Export the type `JevPolicy` so tests can pass a variant with a short deadline.
   - `JEV_POLICY_HASH`: first 12 hex of sha256 over `JSON.stringify({ model, threshold, stateCapBytes, questions })`.
   - `buildGateState(trio: InteractionSequence, policy: JevPolicy)`: returns `{ kind: "ok", state }` with `state = { agentBefore, userFeedback, agentAfter }` (the texts unchanged), or `{ kind: "oversized", bytes }` when `Buffer.byteLength(JSON.stringify(state))` exceeds `stateCapBytes`.
   - `callJev(state, apiKey, policy, transport, beforeAttempt)`, with `transport: { fetch: typeof fetch; now: () => number; sleep: (ms: number) => Promise<void> }` and `beforeAttempt: () => boolean` (false means the run is out of budget). Control flow:
     ```
     start = now(); attempts = 0
     loop (at most 2 attempts):
       if !beforeAttempt(): return fallback("over_budget")          // no request made
       remaining = start + deadlineMs - now(); if remaining <= 0: return fallback("timeout")
       attempts++                                                   // counts POSTs actually sent
       POST with AbortController aborted after `remaining` ms; headers Authorization Bearer, Content-Type json; body { model, state, questions }
       abort → fallback("timeout")
       other fetch throw → transient "network"
       status 200 → parse + validate (below) → scored, or fallback("invalid_response")
       status 429 / 529 → transient "http_<status>"
       any other status → fallback("http_<status>")                   // no retry
       transient: if attempts == 2 → fallback(reason)
                  wait = Retry-After as whole seconds × 1000 when it parses as a non-negative integer, else defaultRetryWaitMs
                  if now() + wait >= start + deadlineMs → fallback(reason)
                  await sleep(wait); continue
     ```
     Results: `{ kind: "scored", answers: Record<QuestionId, number>, model: string, usage: { inputTokens, outputTokens } | null, attempts, latencyMs }` or `{ kind: "fallback", reason, attempts, latencyMs }`. **Validation:** body is JSON; `model` is a string; `answers` holds every question ID with `type === "noul"` and a finite `noul` in [0, 1] (extra keys ignored); `usage` is taken when both fields are numbers, else `null`. Never put the key, the request body, or the response body in a result, an error, or a log.
   - `routeGate(result, policy)`: `"no_lesson"` when `result.kind === "scored"` and every answer ≤ `threshold`; else `"maybe_lesson"`.
2. **src/gate.ts (new): modes and run-scoped state.**
   - `type GateMode = "off" | "shadow" | "enforce"`.
   - Module state, reset by `resetGateRun()`: `keyReported`, `consecutiveFailures`, `disabledForRun`.
   - `checkTrio(trio, mode, sourcePath)` returns `{ decision: "extract" | "skip", event: GateResultEvent | null }`:
     - `off` → `{ extract, null }`, no request.
     - Key = `process.env.TYPESAFE_API_KEY`. Missing or empty → U1 once per run via `reportError(U1, "gate error")`, fallback `no_key`, extract.
     - `disabledForRun` → fallback `gate_disabled`, extract, no request.
     - `buildGateState` oversized → fallback `oversized_state`, extract, no request; does not count as a failure.
     - Otherwise `callJev` with the real transport (`globalThis.fetch`, `Date.now`, a `setTimeout` sleep) and `beforeAttempt = emitGateAttempt`. A fallback after a real request attempt (`timeout`, `network`, `http_<status>`, `invalid_response`) adds 1 to `consecutiveFailures`; `no_key`, `oversized_state`, `over_budget` and `gate_disabled` never count; a scored result sets it to 0. On reaching 3: `disabledForRun = true` and U2 once via `reportError(U2, "gate error")`.
     - Decision: `skip` only when `mode === "enforce"` and `routeGate` says `no_lesson`; otherwise `extract`.
     - Emit `emitGateResult(event)` for every non-off call (including fallbacks) and return the event too.
   - `GateResultEvent`: `{ sourcePath, mode, policyHash, decision: "no_lesson" | "maybe_lesson" | "fallback", routed: "extract" | "skip", answers: Record<string, number> | null, fallbackReason: string | null, model: string | null, attempts, latencyMs, usage }`.
3. **src/instrument.ts.** Add `onGateAttempt?: () => boolean` and `onGateResult?: (event: GateResultEvent) => void` to `InstrumentHooks`; `emitGateAttempt()` returns `hooks.onGateAttempt?.() ?? true` (no hook means allowed); `emitGateResult(event)`. Import the event type from src/gate.ts with `import type`.
4. **src/schema.ts.** Add `gateMode: GateMode` to `PortraitSettings` and a setting `{ id: "gateMode", label, description, type: "string", defaultValue: "off", presets: ["off", "shadow", "enforce"] }` with the approved S label and description; list it in the General tab after `enabled`. Bump the count in the header comment.
5. **src/collector.ts, `tryExtractTrio`.** First step: `const gate = await checkTrio(trio, settings.gateMode, sessionFile)`. When `gate.decision === "skip"`: call `savePosition()` (the same save as a successful empty extraction, no candidates), do not call `emitTrioExamined`, and return `"continue"`. Otherwise continue exactly as today.
6. **src/pipeline.ts.** Call `resetGateRun()` at the start of `runPipelineLoop`, before the first scan.

**Edge cases to cover:** a 200 with a non-JSON body; an answer of `"0.05"` (string) or `1.2`; `Retry-After: 0`; `Retry-After` as an HTTP date (falls back to the default wait); a 429 whose wait does not fit the deadline (one attempt, fallback `http_429`); `beforeAttempt` false on the retry (fallback `over_budget` after one attempt); an empty `TYPESAFE_API_KEY`; three consecutive request failures followed by a fourth trio (no request); a keyless run of five trios (U1 once, no U2, no request); a scored result between two failures resets the count; `oversized_state` never counts toward the three.

**Audit answers (CC, 2026-10-16; part of this spec):** (1) Blocker: add `tests/pipeline.test.ts` and `tests/extraction-outcomes.test.ts` to Allowed scope, but only for the one-line `gateMode: "off"` type fix. (2) `over_budget` is a real fallback reason and does not count toward the three; stage-4-task.md design 6 and 8 are synced. (3) Risk 5: `no_key` does **not** count toward the three either. A keyless run reports U1 once and makes no requests; U2 never fires without a request. Only fallbacks that follow a real request attempt count (`timeout`, `network`, `http_<status>`, `invalid_response`). (4) Noise 2: `attempts` counts POSTs actually sent. Increment it after `beforeAttempt` and the deadline check, right before `fetch`, so a first-iteration timeout reports 0. (5) Acceptance 2: don't parse the md file at runtime. Put the approved strings as literals in tests/jev.test.ts and assert the serialized body against them; CC checks those literals byte-exact against stage-4-task.md in review. (6) Risks 1, 2, 4: type-only imports both ways. In each gate test, call `resetGateRun()` in `beforeEach`, stub `globalThis.fetch` with a mock that fails by default (so a leak can never reach the network), and set/restore `TYPESAFE_API_KEY` per test. Use fake timers for the abort path. (7) Noise 3, 4, 5, 7: as you propose (branch on `kind` before `routeGate`; deep-freeze; hash literal order; your extra tests). (8) Risk 3 (an enforce skip is not counted as an examined trio) is left for S4-02. (9) `over_budget` falls back to extraction on purpose: the counter then declines the extraction request too, extraction fails, and the run stops with the trio's position unchanged, the same path as any request over the limit today. No special stop is needed in the gate.

**Acceptance criteria:**

1. `callJev` follows the control flow above; tests cover every edge case listed and every fallback reason, with a mocked `fetch`, `now` and `sleep` (no real timers or network).
2. The request body is exactly `{ model: "jev-1.13.0", state, questions }` with the approved Q texts byte-exact; tests/jev.test.ts holds the approved strings as literals and asserts the serialized body against them (no runtime parsing of md files; CC checks the literals against stage-4-task.md in review).
3. `routeGate` returns `no_lesson` only when all four answers are ≤ 0.10; 0.10 itself gives `no_lesson`, 0.1000001 gives `maybe_lesson`.
4. Off makes no `fetch` call; shadow always extracts; enforce skips extraction only on `no_lesson` and saves the scan position with no candidates; every fallback extracts.
5. U1 and U2 appear once per run each, byte-exact, with source `gate error`; `resetGateRun` clears both.
6. No test output, result, or error contains the API key (a test uses a recognizable fake key and searches all results and `reportError` calls for it).
7. Existing tests pass; the `gateMode` default is `off`, so existing scans make no gate call.

**Allowed scope:** src/jev.ts (new), src/gate.ts (new), src/instrument.ts, src/schema.ts, src/collector.ts (`tryExtractTrio` only), src/pipeline.ts (the reset call only), tests/jev.test.ts (new), tests/gate.test.ts (new), tests/setup.ts (only if a central mock must learn the new modules), and, for the one-line `gateMode: "off"` type fix only, tests/pipeline.test.ts and tests/extraction-outcomes.test.ts.

**Constraints:** no new dependencies; no SDK. Only the approved Q, U1, U2 and S texts. No harness changes. Do not touch extraction, building, snapshots, or the scan loop beyond the `tryExtractTrio` step.

**Verification:**

```
npx vitest run tests/jev.test.ts tests/gate.test.ts tests/extraction-outcomes.test.ts tests/pipeline.test.ts
npm test
npm run test:compass
```

## CC review and gate (not for the coder)

Review per planner-prompt.md Step 2; ledger entry in md/ledger.jsonl. Check: no path makes a request in `off` mode or without a key; the deadline covers the retry wait; `Retry-After` never extends past the deadline; no key, body, or response text in results, errors, or logs; Q texts byte-exact; `skip` happens only under enforce and `no_lesson`; a skipped trio saves its position without candidates.

Planner difficulty: S4-01 medium.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.2.0 | 2026-10-16 | S4-01 audit answers. |
| 0.3.0 | 2026-10-16 | Body synced with the audit answers (re-audit round 2). |
| 0.4.0 | 2026-10-16 | Plain vocabulary (`no_lesson`, `maybe_lesson`, `fallback`, `over_budget`) after three provider content-filter stops; answer (9) on `over_budget`. |
