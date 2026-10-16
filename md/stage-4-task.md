# Stage 4 — Add the Jev gate and run limits

Project: **pi-session-compass** · Revision: **0.4.0** · Status: **Approved (user, 2026-10-16)**

Date: **2026-10-16**

Parent: [Development plan](plan.md), Stage 4. Contract: [Architecture](architecture.md) §4 (Jev contract) and §5 (limits). Operating rules: [AGENTS.md](../AGENTS.md). Bugs: [bugs.md](bugs.md).

**Goal (M4):** the gate runs in shadow mode, and every error path keeps the trio's extraction opportunity or its pending work. S4 builds and verifies the gate; S5 measures whether it is worth enabling. Ship default: gate **off**.

**How S4 runs.** Pi codes two tasks from CC specs (one fresh Pi session each, audit then code), then CC runs one live check. Speed mode applies: bigger tasks, docs synced at the stage gate.

| Task | Plan tasks | Outcome | Who |
|---|---|---|---|
| S4-01 — Jev adapter and plugin wiring | S4.T1, S4.T2, S4.T4 (adapter and pipeline cases) | `src/jev.ts` (policy, state, HTTP call, validation, routing) and `src/gate.ts` (modes, run-scoped fallback, hooks); `gateMode` setting; gate step before extraction | Pi |
| S4-02 — Harness | S4.T3, S4.T4 (limit cases) | Harness counts Jev attempts and stops them at the limit, records gate results, `--gate-mode` switch, H1–H3 | Pi |
| S4-03 — Live wire check | — | One shadow `smoke` run against the real API (user-confirmed limits) proves the wire format and records model ID, latency and usage | CC |

No live call before S4-03. S4-03 needs `TYPESAFE_API_KEY` in the environment.

## Fixed design (from architecture.md §4, adapted to the code)

1. **Wire format (TypeSafe docs rechecked 2026-10-16).** `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY`, body `{ model, state, questions }`. `questions` is a map from our ID to `{ type: "noul", instructions, criteria: { true, false } }`. The response is `{ model, answers: { <id>: { type: "noul", noul } }, usage: { input_tokens, output_tokens } }`. Errors: 400 (including `max_tokens_exceeded`), 401, 413, 415, 422, 429, 529.
2. **Model pin:** `jev-1.13.0` (the current stable release; `jev-latest` points to it today, and `jev-1.14.0` shipped 2026-10-14 as `jev-preview`). Record the `model` the response returns.
3. **State:** `{ agentBefore, userFeedback, agentAfter }`, the same trio texts the extractor receives. If the UTF-8 JSON of the state exceeds 32 KiB, fall back with reason `oversized_state` (no request).
4. **Routing:** the result is `no_lesson` only when all four answers are present, of type `noul`, finite, in [0, 1], and each is ≤ 0.10. Anything else is `maybe_lesson` (scored) or a fallback (error); both go to extraction.
5. **Transport:** a total deadline of 5 s per trio covers every attempt and backoff. At most one retry, only for a network error, 429 or 529, waiting `Retry-After` when given (else 500 ms) and only if the wait fits the deadline. No retry for 400/401/413/415/422 or an invalid response.
6. **Fallback reasons** (one per trio that falls back to extraction): `key_missing`, `oversized_state`, `over_budget` (the run is out of budget), `timeout`, `http_<status>`, `network`, `invalid_response`, `check_stopped` (after three consecutive failures in a run).
7. **Modes:** `off` (no Jev request, today's path), `shadow` (Jev request, decision recorded, every trio extracted), `enforce` (a `no_lesson` trio is not extracted; its scan position advances like a successful empty extraction).
8. **Run-scoped state:** a missing key is reported once per run and no gate request is made; three consecutive failures (fallbacks after a real request attempt: `timeout`, `network`, `http_<status>`, `invalid_response`) disable the gate for the rest of the run, reported once.
9. **Counting:** each Jev HTTP attempt is one model request (a retry is a second). The harness checks capacity before each attempt; reaching the limit stops the run like any other limit, before the trio's position moves. One request carries all four questions.
10. **Policy hash:** sha256 (first 12 hex) over the model pin, threshold, state cap, and the four questions' JSON; recorded on every gate result and in the harness manifest. Any change to these invalidates evaluation evidence (architecture §4).

## Protected text (approved by the user, 2026-10-16)

**Q — the four Noul questions (sent to the Jev model; approved 2026-10-16).** IDs are response keys only; the model does not see them. Each `instructions` string is the prefix `In this exchange between a user and an AI coding agent, ` followed by the question.

| ID | `instructions` (after the prefix) | `criteria.true` | `criteria.false` |
|---|---|---|---|
| `correction` | does the user's reply correct or push back on something the agent said or did? | The user says the agent got something wrong (code, a claim, an assumption), missed something, or did something the user did not want. | The user accepts the work, moves on, or asks something new without saying the agent got anything wrong. |
| `preference` | does the user's reply say how they want the agent to work or communicate with them? | The user states a preference that could apply again later: how long or detailed answers should be, when to ask before acting, how much to change at once, which tools or style to use. | The user only says what to do in this task (what to build, fix, or explain). |
| `steering` | does the user's reply change how the agent is going about the task? | The user asks for a different method, a different order of steps, planning first, a narrower or wider scope, or a rethought decision. | The user lets the agent carry on, or only adds task details. |
| `confusion` | does the user's reply show they had trouble following the agent? | The user says they are lost or confused, cannot tell what changed or what to do next, or asks for a summary, clarification, or a slower pace. | The user follows what the agent did and said without trouble. |

**U — user-facing strings** (shown as `Portrait ${source}: ${message}`, as T1–T3 in stage-3b.md):

| ID | Source | Message |
|---|---|---|
| U1 | `gate error` | `Jev gate skipped for this run: TYPESAFE_API_KEY is not set. Every trio goes to extraction.` |
| U2 | `gate error` | `Jev gate failed 3 times in a row and is off for the rest of this run. Every trio goes to extraction.` |

**S — the setting** (`/portrait:settings`, General tab):

| Field | Text |
|---|---|
| label | `Jev gate` |
| description | `Checks each trio with the Jev classifier before extraction. Off: no check. Shadow: check and record, but extract every trio. Enforce: skip extraction for trios the gate rejects. Needs TYPESAFE_API_KEY.` |
| options | `off`, `shadow`, `enforce` (default `off`) |

**H — harness strings** (scripts/compass/strings.ts):

| ID | Where | Text |
|---|---|---|
| H1 | confirmation, when the mode is not `off` | `Jev gate: ${mode} (policy ${hash}) — each eligible trio also makes one Jev request (two with a retry).` |
| H2 | confirmation, when the mode is `off` | `Jev gate: off` |
| H3 | error for a bad `--gate-mode` | `--gate-mode must be off, shadow, or enforce` |

## Tasks

### S4-01 — Jev adapter and plugin wiring (Pi; spec in [stage-4-specs.md](stage-4-specs.md))

- [ ] **1.** `src/jev.ts`: policy constants (model pin, threshold, state cap, deadline, the Q table) and `JEV_POLICY_HASH`.
- [ ] **2.** `serializeGateState(trio)` and the 32 KiB check.
- [ ] **3.** `callJev(state, apiKey, fetchImpl, now, beforeAttempt)`: deadline, one retry, `Retry-After`, no retry on non-transient errors, response validation; returns `{ kind: "scored", answers, model, usage, attempts, latencyMs }` or `{ kind: "fallback", reason, attempts, latencyMs }`. `beforeAttempt` is called before each HTTP attempt (the harness counter hook) and may throw.
- [ ] **4.** `routeGate(result)`: `no_lesson` only under the routing rule; else `maybe_lesson`.
- [ ] **5.** Tests with a mocked `fetch` and clock: positive, low, mixed, and uncertain probabilities; missing, extra, or wrong-typed answers; NaN, negative, and >1 values; each error status; 429 with and without `Retry-After`; a retry that would overrun the deadline; timeout; network error; oversized state; the key never appears in any returned value or error text.

### S4-02 — Harness (Pi)

- [ ] **1.** *(in S4-01)* Setting `gateMode` (S text) in src/schema.ts; default `off`.
- [ ] **2.** *(in S4-01)* In `tryExtractTrio` (src/collector.ts), before extraction: `off` skips the gate; `shadow` calls it and always extracts; `enforce` skips extraction on `no_lesson` and saves the scan position as for a successful empty extraction.
- [ ] **3.** *(in S4-01)* Run-scoped gate state (missing key → U1 once and no requests; three consecutive failures → U2 once and gate off for the run), reset at the start of each `runPipelineLoop`.
- [ ] **4.** *(in S4-01)* Instrument hooks: `onGateAttempt` (called through `beforeAttempt`; the harness counts it and may decline it when over budget) and `onGateResult` (trio reference, mode, policy hash, decision, answers or fallback reason, model, latency, usage).
- [ ] **5.** Harness: `--gate-mode off|shadow|enforce` (default: the setting); manifest and receipt record mode, policy hash, and source; the counter counts Jev attempts under stage `gate`; traces and the results sheet carry each trio's gate result; the receipt adds gate totals (scored, `no_lesson`, fallbacks by reason, Jev latency, Jev usage). H1–H3 as approved.
- [ ] **6.** Tests: shadow never skips extraction; enforce skips only on `no_lesson` and advances the position; every fallback extracts; U1 and U2 once each; the counter declining a gate attempt (over budget) stops the run with the position unchanged; `/portrait:collect N` counts only productive trios; off makes no gate call.

### S4-03 — Live wire check (CC)

- [ ] **1.** With `TYPESAFE_API_KEY` set, run a `smoke` run in shadow mode on the S1 fixture from the frozen start snapshot. Suggested limits: the compass.md `smoke` row (5 requests, 15 min); the user confirms at launch.
- [ ] **2.** Check: Jev responses parse; the returned model is `jev-1.13.0`; each trio was extracted; Jev requests were counted; no key in any artifact. Record latency and usage per call in outputs/s4/.

### Stage gate — M4

- [ ] **1.** Both full suites, single-worker, and a concurrent run of both suites pass; commit and push.
- [ ] **2.** S4-03 passed, or is recorded as blocked on the key (M4 then waits on it).
- [ ] **3.** Sync this file, stage.md, bugs.md, and the ledger. Checkpoint with the user before S5.

## Out of scope

Threshold tuning, labels, held-out sets, and savings claims (S5). README/CONFIGURATION updates (S6). A fifth question (architecture §8). Long-context header. Any change to extraction, building, or snapshots.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.2.0 | 2026-10-16 | Approved: questions rewritten for coding-agent sessions; U, S, H texts; S4-01 now holds the adapter and the plugin wiring (knip rejects an unused module), S4-02 the harness. |
| 0.3.0 | 2026-10-16 | S4-01 audit: `limit_refused` added; only failures after a real request count toward the three. |
| 0.4.0 | 2026-10-16 | Plain vocabulary in the design and tasks (`no_lesson`, `maybe_lesson`, `fallback`, `over_budget`); approved texts unchanged. |
