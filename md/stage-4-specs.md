# Stage 4 — Task specs (Pi codes, Claude Code reviews)

Project: **pi-session-compass** · Revision: **0.7.0** · Status: **Approved (user, 2026-10-16)**

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
       POST, cancelled by a timeout after `remaining` ms; headers Authorization Bearer, Content-Type json; body { model, state, questions }
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
     Results: `{ kind: "scored", answers: Record<QuestionId, number>, model: string, usage: { inputTokens, outputTokens } | null, attempts, latencyMs }` or `{ kind: "fallback", reason, attempts, latencyMs }`. **Validation:** body is JSON; `model` is a string; `answers` holds every question ID with `type === "noul"` and a finite `noul` in [0, 1] (extra keys ignored); `usage` is taken when both fields are numbers, else `null`. Results, errors, and logs carry only the reason code and HTTP status; the credential and the request and response payloads are excluded by design.
   - `routeGate(result, policy)`: `"no_lesson"` when `result.kind === "scored"` and every answer ≤ `threshold`; else `"maybe_lesson"`.
2. **src/gate.ts (new): modes and run-scoped state.**
   - `type GateMode = "off" | "shadow" | "enforce"`.
   - Module state, reset by `resetGateRun()`: `keyReported`, `consecutiveFailures`, `checkStoppedForRun`.
   - `checkTrio(trio, mode, sourcePath)` returns `{ decision: "extract" | "skip", event: GateResultEvent | null }`:
     - `off` → `{ extract, null }`, no request.
     - Key = `process.env.TYPESAFE_API_KEY`. Missing or empty → U1 once per run via `reportError(U1, "gate error")`, fallback `key_missing`, extract.
     - `checkStoppedForRun` → fallback `check_stopped`, extract, no request.
     - `buildGateState` oversized → fallback `oversized_state`, extract, no request; does not count as a failure.
     - Otherwise `callJev` with the real transport (`globalThis.fetch`, `Date.now`, a `setTimeout` sleep) and `beforeAttempt = emitGateAttempt`. A fallback after a real request attempt (`timeout`, `network`, `http_<status>`, `invalid_response`) adds 1 to `consecutiveFailures`; `key_missing`, `oversized_state`, `over_budget` and `check_stopped` never count; a scored result sets it to 0. On reaching 3: `checkStoppedForRun = true` and U2 once via `reportError(U2, "gate error")`.
     - Decision: `skip` only when `mode === "enforce"` and `routeGate` says `no_lesson`; otherwise `extract`.
     - Emit `emitGateResult(event)` for every non-off call (including fallbacks) and return the event too.
   - `GateResultEvent`: `{ sourcePath, mode, policyHash, decision: "no_lesson" | "maybe_lesson" | "fallback", routed: "extract" | "skip", answers: Record<string, number> | null, fallbackReason: string | null, model: string | null, attempts, latencyMs, usage }`.
3. **src/instrument.ts.** Add `onGateAttempt?: () => boolean` and `onGateResult?: (event: GateResultEvent) => void` to `InstrumentHooks`; `emitGateAttempt()` returns `hooks.onGateAttempt?.() ?? true` (no hook means allowed); `emitGateResult(event)`. Import the event type from src/gate.ts with `import type`.
4. **src/schema.ts.** Add `gateMode: GateMode` to `PortraitSettings` and a setting `{ id: "gateMode", label, description, type: "string", defaultValue: "off", presets: ["off", "shadow", "enforce"] }` with the approved S label and description; list it in the General tab after `enabled`. Bump the count in the header comment.
5. **src/collector.ts, `tryExtractTrio`.** First step: `const gate = await checkTrio(trio, settings.gateMode, sessionFile)`. When `gate.decision === "skip"`: call `savePosition()` (the same save as a successful empty extraction, no candidates), do not call `emitTrioExamined`, and return `"continue"`. Otherwise continue exactly as today.
6. **src/pipeline.ts.** Call `resetGateRun()` at the start of `runPipelineLoop`, before the first scan.

**Edge cases to cover:** a 200 with a non-JSON body; an answer of `"0.05"` (string) or `1.2`; `Retry-After: 0`; `Retry-After` as an HTTP date (falls back to the default wait); a 429 whose wait does not fit the deadline (one attempt, fallback `http_429`); `beforeAttempt` false on the retry (fallback `over_budget` after one attempt); an empty `TYPESAFE_API_KEY`; three consecutive request failures followed by a fourth trio (no request); a run of five trios with no key set (U1 once, no U2, no request); a scored result between two failures resets the count; `oversized_state` never counts toward the three.

**Audit answers (CC, 2026-10-16; part of this spec):** (1) Blocker: add `tests/pipeline.test.ts` and `tests/extraction-outcomes.test.ts` to Allowed scope, but only for the one-line `gateMode: "off"` type fix. (2) `over_budget` is a real fallback reason and does not count toward the three; stage-4-task.md design 6 and 8 are synced. (3) Risk 5: `key_missing` does **not** count toward the three either. A run with no key set reports U1 once and makes no requests; U2 never fires without a request. Only fallbacks that follow a real request attempt count (`timeout`, `network`, `http_<status>`, `invalid_response`). (4) Noise 2: `attempts` counts POSTs actually sent. Increment it after `beforeAttempt` and the deadline check, right before `fetch`, so a first-iteration timeout reports 0. (5) Acceptance 2: don't parse the md file at runtime. Put the approved strings as literals in tests/jev.test.ts and assert the serialized body against them; CC checks those literals byte-exact against stage-4-task.md in review. (6) Risks 1, 2, 4: type-only imports both ways. In each gate test, call `resetGateRun()` in `beforeEach`, stub `globalThis.fetch` with a mock that fails by default (so an accidental live call fails at once; tests make no live requests), and set/restore `TYPESAFE_API_KEY` per test. Use fake timers for the abort path. (7) Noise 3, 4, 5, 7: as you propose (branch on `kind` before `routeGate`; deep-freeze; hash literal order; your extra tests). (8) Risk 3 (an enforce skip is not counted as an examined trio) is left for S4-02. (9) `over_budget` falls back to extraction on purpose: the counter then declines the extraction request too, extraction fails, and the run stops with the trio's position unchanged, the same path as any request over the limit today. No special stop is needed in the gate.

**Acceptance criteria:**

1. `callJev` follows the control flow above; tests cover every edge case listed and every fallback reason, with a mocked `fetch`, `now` and `sleep` (no real timers or network).
2. The request body is exactly `{ model: "jev-1.13.0", state, questions }` with the approved Q texts byte-exact; tests/jev.test.ts holds the approved strings as literals and asserts the serialized body against them (no runtime parsing of md files; CC checks the literals against stage-4-task.md in review).
3. `routeGate` returns `no_lesson` only when all four answers are ≤ 0.10; 0.10 itself gives `no_lesson`, 0.1000001 gives `maybe_lesson`.
4. Off makes no `fetch` call; shadow always extracts; enforce skips extraction only on `no_lesson` and saves the scan position with no candidates; every fallback extracts.
5. U1 and U2 appear once per run each, byte-exact, with source `gate error`; `resetGateRun` clears both.
6. No test output, result, or error contains the API key (a test sets a synthetic placeholder credential and asserts it appears in no result or `reportError` message).
7. Existing tests pass; the `gateMode` default is `off`, so existing scans make no gate call.

**Allowed scope:** src/jev.ts (new), src/gate.ts (new), src/instrument.ts, src/schema.ts, src/collector.ts (`tryExtractTrio` only), src/pipeline.ts (the reset call only), tests/jev.test.ts (new), tests/gate.test.ts (new), tests/setup.ts (only if a central mock must learn the new modules), and, for the one-line `gateMode: "off"` type fix only, tests/pipeline.test.ts and tests/extraction-outcomes.test.ts.

**Constraints:** no new dependencies; no SDK. Only the approved Q, U1, U2 and S texts. No harness changes. Do not touch extraction, building, snapshots, or the scan loop beyond the `tryExtractTrio` step.

**Verification:**

```
npx vitest run tests/jev.test.ts tests/gate.test.ts tests/extraction-outcomes.test.ts tests/pipeline.test.ts
npm test
npm run test:compass
```

## S4-02 — One gate config file; harness counts and records the gate

Two parts. First, every gate value moves into one file the user can review. Second, the harness learns the gate: it selects the mode, counts each Jev request against the run limits, and records every gate result in the receipt, traces, results sheet, and running table. Every test mocks the network; no live call.

**Vocabulary:** as in S4-01 (`no_lesson`, `maybe_lesson`, `fallback`, `over_budget`).

**Read:** src/jev.ts and src/gate.ts (whole); src/schema.ts (the `gateMode` entry); src/collector.ts lines 548–565 (the `checkTrio` step); scripts/compass/counter.ts (whole); scripts/compass/pipeline-boot.ts lines 100–135 (`renderRunningTable`), 156–345 (`runPipeline`), 393–515 (`writeReceipt`, `writeSheet`); scripts/compass/run.ts lines 130–215 (`executeRun`); scripts/compass/confirmation.ts lines 1–70; scripts/compass/manifest.ts (whole); scripts/compass/strings.ts (whole); md/stage-4-task.md sections "Protected text" (H1–H3) and "S4-02". Test templates: tests/compass/running-table.test.ts (mocked `runPipelineLoop` with `loopState`), tests/compass/strings.test.ts, tests/gate.test.ts.

**Where and how (CC's plan):**

1. **src/gate-config.ts (new): the single review point (user, 2026-10-16).** One exported frozen object, `GATE_CONFIG`, holding every gate value, each with a one-line comment that says what it decides: `defaultMode` (`"off"`), `model`, `endpoint`, `threshold`, `stateCapBytes`, `deadlineMs`, `defaultRetryWaitMs`, `failureLimit` (3), and `questions` (the four Q entries, built from the prefix exactly as in S4-01). A short file header says: this file is the whole gate setup; nothing else hard-codes a gate value; any change here changes the policy hash. Then:
   - src/jev.ts: `JEV_POLICY` is built from `GATE_CONFIG` (same fields and types, still deep-frozen); `JEV_POLICY_HASH` keeps the same field order (`model`, `threshold`, `stateCapBytes`, `questions`), so the hash value does not change.
   - src/gate.ts: `FAILURE_LIMIT` comes from `GATE_CONFIG.failureLimit`.
   - src/schema.ts: the `gateMode` setting's `defaultValue` is `GATE_CONFIG.defaultMode`.
   - Remove the moved literals from src/jev.ts and src/gate.ts. U1 and U2 stay in src/gate.ts (they are messages, not configuration).
   - The tests keep the approved strings as literals (a test checks that `GATE_CONFIG` matches them), and `JEV_POLICY_HASH` is unchanged from S4-01 (assert the S4-01 value).
2. **src/collector.ts.** Pass `path.resolve(sessionFile)` to `checkTrio`, so a gate event's `sourcePath` matches the candidates' `sourcePath`.
3. **scripts/compass/counter.ts.** Add `gateAttempt(): boolean` to `RequestCounter`: run the same checks as `guard()`; when a ceiling is reached, record the refusal time as `wrapStreamFn` does and return `false`; otherwise increment `requestCount`, push a `TraceEntry` with `model` = the Jev model, `provider: "typesafe"`, `stage: "gate"`, `outcome: "ok"`, and return `true`. A declined gate attempt stops nothing by itself: the trio falls back to extraction, the counter declines that request too, and the run stops as for any limit (S4-01 answer 9).
4. **scripts/compass/run.ts.** Parse `--gate-mode` (`off`, `shadow`, `enforce`); when absent, use the settings snapshot's `gateMode`. An invalid value prints H3 to stderr and exits 2 before any model request. Pass the mode and its source (`"flag"` or `"settings"`) to the confirmation, the manifest, and `runPipeline`.
5. **Confirmation (scripts/compass/confirmation.ts).** Add H1 or H2 (approved) after the model line. H1 shows the mode and `JEV_POLICY_HASH`.
6. **Manifest (scripts/compass/manifest.ts).** Add `gate: { mode, source, policyHash, model }`.
7. **scripts/compass/pipeline-boot.ts.**
   - Before the pass loop: `runSettings.gateMode = opts.gateMode` (the getter already returns `runSettings`).
   - Hooks: `onGateAttempt: () => counter.gateAttempt()`; `onGateResult` appends the event to `gateEvents`, updates `stats` (`gateChecks`, `gateNoLesson`, `gateMaybeLesson`, `gateFallbacks` by reason, `gateSkipped` for `routed: "skip"`, summed `gateLatencyMs`, summed Jev usage), and holds the event as `pendingGate` for the trio that follows.
   - `onTrioExamined`: attach `pendingGate` (if any) to the trio's sheet entry, then clear it. A `routed: "skip"` event becomes its own sheet entry at once (no trio event follows it).
   - Pass loop: count progress as `triosExamined + gateSkipped`, so a pass whose trios were all skipped still counts as progress.
   - Receipt: a `gate` block `{ mode, source, policyHash, model, checks, noLesson, maybeLesson, skipped, fallbacks: { <reason>: n }, requests, latencyMsTotal, usage: { inputTokens, outputTokens } }`; `stages.gate` = gate requests; `traces.jsonl` gets one `{ kind: "gate", ...event }` line per event.
   - Results sheet: under each trio, the H4 line when a gate event is attached. A skipped trio gets its own entry: the existing trio header, then H5 instead of the extractor output.
   - Running table: the coverage line counts examined plus skipped trios. The table rows stay per examined trio.
8. **scripts/compass/strings.ts.** Add H1–H5; change `usageExecute` to H6.

**Edge cases to cover:** `--gate-mode` absent with snapshot `gateMode` missing (treat as `off`); `--gate-mode enforce` with every trio `no_lesson` (the pass loop still ends, coverage counts the skipped trios, no extraction requests); a gate attempt declined at the request ceiling (trace not pushed, refusal time recorded, run ends capped); a fallback (no answers) on the sheet; off mode leaves the receipt's `gate` block with zero counts and no `gate` traces.

**Acceptance criteria:**

1. `GATE_CONFIG` is the only place any gate value is written in `src/`; `JEV_POLICY_HASH` equals its S4-01 value; the setting default reads from it.
2. `--gate-mode` parses and validates (H3, exit 2); mode and source reach the confirmation (H1/H2), the manifest, and the pipeline settings.
3. Each Jev attempt counts as one request with `stage: "gate"`; at the ceiling a gate attempt is declined, and the run ends `capped` with the trio's position unchanged.
4. The receipt `gate` block, `stages.gate`, the `gate` trace lines, the sheet's H4/H5 lines, and the coverage count are correct for shadow, enforce (with skips), fallback, and off runs.
5. Tests in tests/compass (copy the mocked-pipeline pattern; drive `onGateAttempt`/`onGateResult` from the mock) cover criteria 2–4 and every edge case; tests/jev.test.ts and tests/gate.test.ts cover criterion 1.
6. Existing tests pass.

**Allowed scope:** src/gate-config.ts (new), src/jev.ts, src/gate.ts, src/schema.ts (the default only), src/collector.ts (the `checkTrio` argument only), scripts/compass/counter.ts, scripts/compass/run.ts, scripts/compass/confirmation.ts, scripts/compass/manifest.ts, scripts/compass/pipeline-boot.ts, scripts/compass/strings.ts, scripts/compass/types.ts, tests/jev.test.ts, tests/gate.test.ts, tests/compass/*.test.ts.

**Constraints:** H1–H6 exactly as approved; no other new user-facing strings. Existing receipt fields, exit codes, and strings unchanged except `usageExecute` (H6). No changes to extraction, building, or snapshots.

**Verification:**

```
npx vitest run tests/jev.test.ts tests/gate.test.ts
npm run test:compass
npm test
```

**Audit answers (CC, 2026-10-16; part of this spec; numbers refer to outputs/s4/handoff/S4-02-audit.md):**

1. **Blocker 1: option (a).** `prepareRun` resolves the gate once: `mode = flag ?? snapshot.gateMode ?? "off"`, `source = flag ? "flag" : "settings"`. It takes the raw flag as an optional `PrepareOptions` field and returns the resolved gate in `PrepareResult`. `executeRun` validates the raw flag next to `parseLimits` (H3, exit 2, before `prepareRun` writes anything), then reuses the one resolved gate for the confirmation, the manifest re-freeze, and `runPipeline`. Standalone `prepare` keeps no `--gate-mode` flag and records `source: "settings"`.
2. **Blocker 2: write `stages.gate` only when gate requests > 0.** An off run's receipt keeps `stages` exactly as today, and validation-rounds-receipt.test.ts:131 stays unchanged. The `gate` block is always present (zeros in off runs).
3. **Risk 1 / Question 2: exclude `stage: "gate"` traces from `requests.usageTotals`.** Jev usage goes only into the `gate` block.
4. **Risk 4: no static src import in counter.ts.** The new method is `gateAttempt(model: string): boolean`; pipeline-boot calls it as `onGateAttempt: () => counter.gateAttempt(opts.gate.model)`. The constructor does not change. Together with Noise 1, no harness file statically imports a src value.
5. **Risk 5 / Noise 6: wrap, as you propose, and record the error.** If `gateAttempt` throws, record the error the way `guardSink` does (so it reaches the receipt's sink errors), then return `false`. The trio then falls back with `over_budget` and goes to extraction.
6. **Risks 2, 3, 6–9: as you describe.** Keep the spec wording on the refusal time (Risk 6); pin the `pendingGate` cases in tests (Risk 7); move both progress sites and the coverage line together (Risk 8); gate totals go only into the `gate` block, never into `counts` (Risk 9).
7. **Noise 1–5, 7, 8, 10: as you propose.** Carry one resolved `gate` record `{ mode, source, policyHash, model }` on `BootOptions`, filled in run.ts through dynamic imports. Use your stat and receipt names. Put the `kind: "gate"` trace lines after the existing groups. `renderRunningTable` takes a required `covered` count. Add the extra tests you list.
8. **Question 1: header, then H4, then H5.** A skipped trio's entry shows its gate scores (H4) and then H5 in place of the extractor output.
9. **Question 3: treat an unknown snapshot `gateMode` as `off`.** The confirmation then shows H2, so the user sees it before confirming. No new string.
10. **Question 4: composed evidence is enough.** Use the counter-decline unit test, S4-01's `over_budget` to extraction test, and the existing test that pins the position after an extraction failure. Do not add a non-mocked pipeline test.
11. **Question 5 / Noise 13:** `scripts/compass/probe.ts` and the `knip.json` entry are committed (0a7ef53, a separate probe tool). Do not modify them. Keep `JEV_POLICY`, `JEV_POLICY_HASH`, `buildGateState`, `callJev`, and `routeGate` exported from src/jev.ts with unchanged names and values, so probe.ts keeps working. Criterion 1 covers `src/` only. Your verification runs include the probe files; report any failure that comes from them instead of fixing it.

## CC review and gate (not for the coder)

Review per planner-prompt.md Step 2; ledger entry in md/ledger.jsonl. Check: no path makes a request in `off` mode or without a key; the deadline covers the retry wait; `Retry-After` never extends past the deadline; no key, body, or response text in results, errors, or logs; Q texts byte-exact; `skip` happens only under enforce and `no_lesson`; a skipped trio saves its position without candidates.

Planner difficulty: S4-01 medium; S4-02 medium.

S4-02 review: `GATE_CONFIG` is the only gate-value source; hash unchanged; each gate attempt counted once and declined at the ceiling; H1–H6 byte-exact; the sheet pairs each gate event with its own trio.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.5.0 | 2026-10-16 | Neutral prose from Pi's filter review (credential, timeout and test wording); `key_missing`, `check_stopped`, `checkStoppedForRun`. |
| 0.6.0 | 2026-10-16 | S4-02 spec (single gate config file, harness gate counting and records); H4–H6 approved by the user. |
| 0.7.0 | 2026-10-16 | S4-02 audit answers (gate resolved in `prepareRun`; `stages.gate` only when non-zero; `gateAttempt(model)`; sheet order header, H4, H5). |
