# Stage 4 — Task specs (Pi codes, Claude Code reviews)

Project: **pi-session-compass** · Revision: **0.1.0** · Status: **Approved (user, 2026-10-16)**

Date: **2026-10-16**

Parent: [stage-4-task.md](stage-4-task.md) (fixed design, approved text Q/U/S/H). Contract: [architecture.md](architecture.md) §4.

**Coder rules, spec audit, and handoff format:** [stage-3b.md](stage-3b.md), section "Coder rules", unchanged, except that the audit and handoff go to `outputs/s4/handoff/<task_id>-audit.md` and `outputs/s4/handoff/<task_id>-r<round>.md`.

## S4-01 — Jev adapter and plugin wiring

Add the Jev gate to the plugin: a transport-and-policy module, a gate step before extraction with three modes, and instrumentation hooks for the harness. No harness changes (S4-02). No live call: every test mocks `fetch`.

**Read:** md/stage-4-task.md sections "Fixed design" and "Protected text" (the Q, U1, U2 and S texts are the only approved strings); src/collector.ts lines 505–600 (`streamAndExtract`, `savePosition`, `tryExtractTrio`); src/pipeline.ts lines 125–160 (`runPipelineLoop` start); src/instrument.ts (whole); src/schema.ts lines 1–60 and 150–245 (interface, a boolean setting, the tab lists); src/error.ts (`reportError`); src/types.ts (`InteractionSequence`); tests/extraction-outcomes.test.ts (template for driving a scan through `tryExtractTrio` with the mocked extractor); tests/setup.ts (central mocks).

**Where and how (CC's plan):**

1. **src/jev.ts (new): policy, state, transport, routing.** No imports from the rest of `src/` except types.
   - `JEV_POLICY` (a frozen object): `model: "jev-1.13.0"`, `threshold: 0.1`, `stateCapBytes: 32 * 1024`, `deadlineMs: 5000`, `defaultRetryWaitMs: 500`, `endpoint: "https://api.typesafe.ai/v1/systemone"`, `questions` (the four Q entries, keyed `correction`, `preference`, `steering`, `confusion`, each `{ type: "noul", instructions: PREFIX + question, criteria: { true, false } }`, texts exactly as approved). Export the type `JevPolicy` so tests can pass a variant with a short deadline.
   - `JEV_POLICY_HASH`: first 12 hex of sha256 over `JSON.stringify({ model, threshold, stateCapBytes, questions })`.
   - `buildGateState(trio: InteractionSequence, policy: JevPolicy)`: returns `{ kind: "ok", state }` with `state = { agentBefore, userFeedback, agentAfter }` (the texts unchanged), or `{ kind: "oversized", bytes }` when `Buffer.byteLength(JSON.stringify(state))` exceeds `stateCapBytes`.
   - `callJev(state, apiKey, policy, transport, beforeAttempt)`, with `transport: { fetch: typeof fetch; now: () => number; sleep: (ms: number) => Promise<void> }` and `beforeAttempt: () => boolean` (false means the run refused the request). Control flow:
     ```
     start = now(); attempts = 0
     loop (at most 2 attempts):
       if !beforeAttempt(): return bypass("limit_refused")          // no request made
       attempts++
       remaining = start + deadlineMs - now(); if remaining <= 0: return bypass("timeout")
       POST with AbortController aborted after `remaining` ms; headers Authorization Bearer, Content-Type json; body { model, state, questions }
       abort → bypass("timeout")
       other fetch throw → transient "network"
       status 200 → parse + validate (below) → scored, or bypass("invalid_response")
       status 429 / 529 → transient "http_<status>"
       any other status → bypass("http_<status>")                   // no retry
       transient: if attempts == 2 → bypass(reason)
                  wait = Retry-After as whole seconds × 1000 when it parses as a non-negative integer, else defaultRetryWaitMs
                  if now() + wait >= start + deadlineMs → bypass(reason)
                  await sleep(wait); continue
     ```
     Results: `{ kind: "scored", answers: Record<QuestionId, number>, model: string, usage: { inputTokens, outputTokens } | null, attempts, latencyMs }` or `{ kind: "bypass", reason, attempts, latencyMs }`. **Validation:** body is JSON; `model` is a string; `answers` holds every question ID with `type === "noul"` and a finite `noul` in [0, 1] (extra keys ignored); `usage` is taken when both fields are numbers, else `null`. Never put the key, the request body, or the response body in a result, an error, or a log.
   - `routeGate(result, policy)`: `"reject"` when `result.kind === "scored"` and every answer ≤ `threshold`; else `"pass"`.
2. **src/gate.ts (new): modes and run-scoped state.**
   - `type GateMode = "off" | "shadow" | "enforce"`.
   - Module state, reset by `resetGateRun()`: `keyReported`, `consecutiveFailures`, `disabledForRun`.
   - `checkTrio(trio, mode, sourcePath)` returns `{ decision: "extract" | "skip", event: GateResultEvent | null }`:
     - `off` → `{ extract, null }`, no request.
     - Key = `process.env.TYPESAFE_API_KEY`. Missing or empty → U1 once per run via `reportError(U1, "gate error")`, bypass `no_key`, extract.
     - `disabledForRun` → bypass `gate_disabled`, extract, no request.
     - `buildGateState` oversized → bypass `oversized_state`, extract, no request; does not count as a failure.
     - Otherwise `callJev` with the real transport (`globalThis.fetch`, `Date.now`, a `setTimeout` sleep) and `beforeAttempt = emitGateAttempt`. A bypass other than `oversized_state` and `limit_refused` adds 1 to `consecutiveFailures`; a scored result sets it to 0. On reaching 3: `disabledForRun = true` and U2 once via `reportError(U2, "gate error")`.
     - Decision: `skip` only when `mode === "enforce"` and `routeGate` says `reject`; otherwise `extract`.
     - Emit `emitGateResult(event)` for every non-off call (including bypasses) and return the event too.
   - `GateResultEvent`: `{ sourcePath, mode, policyHash, decision: "reject" | "pass" | "bypass", routed: "extract" | "skip", answers: Record<string, number> | null, bypassReason: string | null, model: string | null, attempts, latencyMs, usage }`.
3. **src/instrument.ts.** Add `onGateAttempt?: () => boolean` and `onGateResult?: (event: GateResultEvent) => void` to `InstrumentHooks`; `emitGateAttempt()` returns `hooks.onGateAttempt?.() ?? true` (no hook means allowed); `emitGateResult(event)`. Import the event type from src/gate.ts with `import type`.
4. **src/schema.ts.** Add `gateMode: GateMode` to `PortraitSettings` and a setting `{ id: "gateMode", label, description, type: "string", defaultValue: "off", presets: ["off", "shadow", "enforce"] }` with the approved S label and description; list it in the General tab after `enabled`. Bump the count in the header comment.
5. **src/collector.ts, `tryExtractTrio`.** First step: `const gate = await checkTrio(trio, settings.gateMode, sessionFile)`. When `gate.decision === "skip"`: call `savePosition()` (the same save as a successful empty extraction, no candidates), do not call `emitTrioExamined`, and return `"continue"`. Otherwise continue exactly as today.
6. **src/pipeline.ts.** Call `resetGateRun()` at the start of `runPipelineLoop`, before the first scan.

**Edge cases to cover:** a 200 with a non-JSON body; an answer of `"0.05"` (string) or `1.2`; `Retry-After: 0`; `Retry-After` as an HTTP date (falls back to the default wait); a 429 whose wait does not fit the deadline (one attempt, bypass `http_429`); `beforeAttempt` false on the retry (bypass `limit_refused` after one attempt); an empty `TYPESAFE_API_KEY`; three consecutive bypasses followed by a fourth trio (no request); a scored result between two failures resets the count; `oversized_state` never counts toward the three.

**Acceptance criteria:**

1. `callJev` follows the control flow above; tests cover every edge case listed and every bypass reason, with a mocked `fetch`, `now` and `sleep` (no real timers or network).
2. The request body is exactly `{ model: "jev-1.13.0", state, questions }` with the approved Q texts byte-exact; a test compares the serialized `questions` with the stage-4-task.md table.
3. `routeGate` rejects only when all four answers are ≤ 0.10; 0.10 itself rejects, 0.1000001 passes.
4. Off makes no `fetch` call; shadow always extracts; enforce skips extraction only on `reject` and saves the scan position with no candidates; every bypass extracts.
5. U1 and U2 appear once per run each, byte-exact, with source `gate error`; `resetGateRun` clears both.
6. No test output, result, or error contains the API key (a test uses a recognizable fake key and searches all results and `reportError` calls for it).
7. Existing tests pass; the `gateMode` default is `off`, so existing scans make no gate call.

**Allowed scope:** src/jev.ts (new), src/gate.ts (new), src/instrument.ts, src/schema.ts, src/collector.ts (`tryExtractTrio` only), src/pipeline.ts (the reset call only), tests/jev.test.ts (new), tests/gate.test.ts (new), tests/setup.ts (only if a central mock must learn the new modules), and tests that assert the settings count or the General tab list.

**Constraints:** no new dependencies; no SDK. Only the approved Q, U1, U2 and S texts. No harness changes. Do not touch extraction, building, snapshots, or the scan loop beyond the `tryExtractTrio` step.

**Verification:**

```
npx vitest run tests/jev.test.ts tests/gate.test.ts tests/extraction-outcomes.test.ts tests/pipeline.test.ts
npm test
npm run test:compass
```

## CC review and gate (not for the coder)

Review per planner-prompt.md Step 2; ledger entry in md/ledger.jsonl. Check: no path makes a request in `off` mode or without a key; the deadline covers the retry wait; `Retry-After` never extends past the deadline; no key, body, or response text in results, errors, or logs; Q texts byte-exact; `skip` happens only under enforce and reject; a skipped trio saves its position without candidates.

Planner difficulty: S4-01 medium.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.1.0 | 2026-10-16 | S4-01 spec. |
