# Stage 4 — Add the Jev gate and run limits

Project: **pi-session-compass** · Revision: **0.1.0** · Status: **Draft — awaiting user approval**

Date: **2026-10-16**

Parent: [Development plan](plan.md), Stage 4. Contract: [Architecture](architecture.md) §4 (Jev contract) and §5 (limits). Operating rules: [AGENTS.md](../AGENTS.md). Bugs: [bugs.md](bugs.md).

**Goal (M4):** the gate runs in shadow mode, and every error path keeps the trio's extraction opportunity or its pending work. S4 builds and verifies the gate; S5 measures whether it is worth enabling. Ship default: gate **off**.

**How S4 runs.** Pi codes two tasks from CC specs (one fresh Pi session each, audit then code), then CC runs one live check. Speed mode applies: bigger tasks, docs synced at the stage gate.

| Task | Plan tasks | Outcome | Who |
|---|---|---|---|
| S4-01 — Jev adapter and policy | S4.T1, S4.T2 (routing), S4.T4 (adapter cases) | `src/jev.ts`: policy, state, HTTP call, validation, routing decision; unit-tested with a mocked `fetch`; not wired | Pi |
| S4-02 — Wire the gate and the harness | S4.T2 (modes), S4.T3, S4.T4 (pipeline cases) | `gateMode` setting; gate step before extraction; run-scoped failure bypass; harness counts and records Jev requests; `--gate-mode` switch | Pi |
| S4-03 — Live wire check | — | One shadow `smoke` run against the real API (user-confirmed limits) proves the wire format and records model ID, latency and usage | CC |

No live call before S4-03. S4-03 needs `TYPESAFE_API_KEY` in the environment.

## Fixed design (from architecture.md §4, adapted to the code)

1. **Wire format (TypeSafe docs rechecked 2026-10-16).** `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY`, body `{ model, state, questions }`. `questions` is a map from our ID to `{ type: "noul", instructions, criteria: { true, false } }`. The response is `{ model, answers: { <id>: { type: "noul", noul } }, usage: { input_tokens, output_tokens } }`. Errors: 400 (including `max_tokens_exceeded`), 401, 413, 415, 422, 429, 529.
2. **Model pin:** `jev-1.13.0` (the current stable release; `jev-latest` points to it today, and `jev-1.14.0` shipped 2026-10-14 as `jev-preview`). Record the `model` the response returns.
3. **State:** `{ agentBefore, userFeedback, agentAfter }`, the same trio texts the extractor receives. If the UTF-8 JSON of the state exceeds 32 KiB, bypass with reason `oversized_state` (no request).
4. **Routing:** reject only when all four answers are present, of type `noul`, finite, in [0, 1], and each is ≤ 0.10. Anything else is a pass (scored) or a bypass (error); both go to extraction.
5. **Transport:** a total deadline of 5 s per trio covers every attempt and backoff. At most one retry, only for a network error, 429 or 529, waiting `Retry-After` when given (else 500 ms) and only if the wait fits the deadline. No retry for 400/401/413/415/422 or an invalid response.
6. **Bypass reasons** (one per bypassed trio): `no_key`, `oversized_state`, `timeout`, `http_<status>`, `network`, `invalid_response`, `gate_disabled` (after three consecutive failures in a run).
7. **Modes:** `off` (no Jev request, today's path), `shadow` (Jev request, decision recorded, every trio extracted), `enforce` (a rejected trio is not extracted; its scan position advances like a successful empty extraction).
8. **Run-scoped state:** a missing key is reported once per run and no gate request is made; three consecutive failures (any bypass except `oversized_state`) disable the gate for the rest of the run, reported once.
9. **Counting:** each Jev HTTP attempt is one model request (a retry is a second). The harness checks capacity before each attempt; a refusal stops the run like any other limit, before the trio's position moves. One request carries all four questions.
10. **Policy hash:** sha256 (first 12 hex) over the model pin, threshold, state cap, and the four questions' JSON; recorded on every gate result and in the harness manifest. Any change to these invalidates evaluation evidence (architecture §4).

## Protected text — for approval

**Q — the four Noul questions (sent to the Jev model).** IDs are response keys only; the model does not see them.

| ID | `instructions` | `criteria.true` | `criteria.false` |
|---|---|---|---|
| `correction` | Does the user's message (userFeedback) correct or challenge something the agent said or did in agentBefore? | The user points out a wrong assumption, a missed concern, an inaccurate claim, or an action they did not want, or pushes back on the agent's answer or approach. | The user accepts, continues, or asks something new without disputing anything the agent said or did. |
| `preference` | Does the user's message (userFeedback) express a preference about how the agent should communicate or work? | The user states how they want things done: style, length or depth of explanations, scope, process, or priorities. | The user only gives task content (what to build, fix, or answer) and says nothing about how the agent should communicate or work. |
| `steering` | Does the user's message (userFeedback) redirect how the agent approaches the work? | The user changes the method, the order of steps, the structure, or how a decision is framed. | The user lets the agent continue its current approach, or only adds task details. |
| `confusion` | Does the user's message (userFeedback) show difficulty following the agent's explanation or progress? | The user says they are lost, cannot tell what changed or what to do next, had to scroll or search to follow along, or asks the agent to clarify or reorient. | The user follows the agent's explanation and progress without trouble. |

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
| H3 | refusal for a bad `--gate-mode` | `--gate-mode must be off, shadow, or enforce` |

## Tasks

### S4-01 — Jev adapter and policy (Pi)

- [ ] **1.** `src/jev.ts`: policy constants (model pin, threshold, state cap, deadline, the Q table) and `JEV_POLICY_HASH`.
- [ ] **2.** `serializeGateState(trio)` and the 32 KiB check.
- [ ] **3.** `callJev(state, apiKey, fetchImpl, now, beforeAttempt)`: deadline, one retry, `Retry-After`, no retry on non-transient errors, response validation; returns `{ kind: "scored", answers, model, usage, attempts, latencyMs }` or `{ kind: "bypass", reason, attempts, latencyMs }`. `beforeAttempt` is called before each HTTP attempt (the harness counter hook) and may throw.
- [ ] **4.** `routeGate(result)`: `reject` only under the routing rule; else `pass`.
- [ ] **5.** Tests with a mocked `fetch` and clock: positive, low, mixed, and uncertain probabilities; missing, extra, or wrong-typed answers; NaN, negative, and >1 values; each error status; 429 with and without `Retry-After`; a retry that would overrun the deadline; timeout; network error; oversized state; the key never appears in any returned value or error text.

### S4-02 — Wire the gate and the harness (Pi)

- [ ] **1.** Setting `gateMode` (S text) in src/schema.ts; default `off`.
- [ ] **2.** In `tryExtractTrio` (src/collector.ts), before extraction: `off` skips the gate; `shadow` calls it and always extracts; `enforce` skips extraction on `reject` and saves the scan position as for a successful empty extraction.
- [ ] **3.** Run-scoped gate state (missing key → U1 once and no requests; three consecutive failures → U2 once and gate off for the run), reset at the start of each `runPipelineLoop`.
- [ ] **4.** Instrument hooks: `onGateAttempt` (called through `beforeAttempt`; the harness counts it and may refuse) and `onGateResult` (trio reference, mode, policy hash, decision, answers or bypass reason, model, latency, usage).
- [ ] **5.** Harness: `--gate-mode off|shadow|enforce` (default: the setting); manifest and receipt record mode, policy hash, and source; the counter counts Jev attempts under stage `gate`; traces and the results sheet carry each trio's gate result; the receipt adds gate totals (scored, rejected, bypassed by reason, Jev latency, Jev usage). H1–H3 as approved.
- [ ] **6.** Tests: shadow never skips extraction; enforce skips only on `reject` and advances the position; every bypass extracts; U1 and U2 once each; the counter refusing a gate attempt stops the run with the position unchanged; `/portrait:collect N` counts only productive trios; off makes no gate call.

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
| 0.1.0 | 2026-10-16 | Draft for user approval. |
