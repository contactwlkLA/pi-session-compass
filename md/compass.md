# pi-session-compass

Revision: **0.2.0** · Planning ready; implementation not started.

pi-session-compass improves session-to-behavioral-rule collection with explicit session-file selection, recoverable work, and a Jev gate before expensive extraction. The gate writes no rules; the existing extractor and builder do that work. Features and performance gains remain unverified.

## Start

Put this document set in the intended checkout (AGENTS.md at the root, this file and the rest under `md/`; layout in [project-init.md](project-init.md)) and merge [AGENTS.md](../AGENTS.md) with existing rules. For first-time setup, read [project-init.md](project-init.md). Then start Pi there:

```bash
pi "Continue from md/stage.md. Execute the first unfinished stage and stop at its boundary."
```

[stage.md](stage.md) tracks completion; [stage-1-task.md](stage-1-task.md) tracks execution. Each session targets one stage. Partial or blocked work resumes that stage next time.

## Runtime limits by run type

Every live run needs finite, user-confirmed limits; there is no unlimited mode. The table holds stored defaults, which serve as suggestions. The user changes the table, and only when they ask.

**Project stage:** `pre-alpha`. This line is informational and holds no limits. At alpha or production the user re-sizes the values below.

| Run type | Used by | `maxModelRequests` | `maxRunMs` | Purpose |
|---|---|---|---|---|
| `smoke` | S1.T4 | **5** | **900000** (15 min) | Confirm the harness runs end to end and show sample output. |
| `baseline` | S1.T5 | **UNSET** | **UNSET** | Measured run of the current pipeline on the selected file. |
| `compare` | S2.T3 | **UNSET** | **UNSET** | Repaired-pipeline comparison on the same file and settings. |
| `probe` | S2.T4 (optional) | **UNSET** | **UNSET** | Optional Jev latency and rejection-share probe on the fixture trios. |
| `evaluate` | S5.T3 | **UNSET** | **UNSET** | Shadow evaluation on the frozen set. |
| `collect` | Normal use after handoff | **UNSET** | **UNSET** | Routine collection. |

Rules:

1. **The run type is declared, not inferred.** Each live run names its run type.
2. **Stored values are suggestions.** If the run type’s row is set, it is the suggested default. If it is UNSET, the agent suggests values from the trio count and states its basis and assumptions. The user accepts them, enters their own for that run, or cancels. Entered values must be finite positive integers. The table changes only when the user asks.
3. **Harness switches.** Limits reach the harness only as required switches: `--run-type`, `--max-model-requests`, and `--max-run-ms`. The harness has no built-in defaults and refuses to start without them.
4. **Confirmation at the start.** After the free offline selection and trio count, and before any model request, the harness shows the run type, limits, selected file with its eligible trio count, and output directory. It also states that each eligible trio needs at least one extraction request (a source-review lower bound, unmeasured), that the limits cap requests and wall-clock time and not spend, that extraction runs at high thinking so token cost is unknown until the provider reports usage, and that a capped run stops partway and is incomplete. On a terminal the harness asks. When an agent launches it, the harness refuses to run without `--confirmed`, which the agent passes only after the user approves the displayed values in the session. Unattended runs cannot start. Cancelling makes no model call.
5. **Manifests record provenance:** run type, suggested values, final values, and their source (compass.md row, agent suggestion, or user override).
6. **Counting:** include Jev, extractor, builder, review, and maintenance requests, failed attempts, retries, and tool-follow-ups. Retries inside the provider layer count too, or the undercount is recorded (S1.T3.1). One Jev request with multiple questions counts once. Local tool execution and offline mocks do not count. The run deadline is wall-clock time and includes cooldowns.
7. **Meaning of a cap:** a `smoke` run that ends by completion or by a cap, with its harness checks met, is a successful smoke result with no measurement claims. In every other run type, a capped run is incomplete and leaves its task and stage unchecked.

Stage 1 verifies selectable input and isolated output before live calls. Supply the test session path in Pi; runtime and package information is discovered in the checkout.

## Design and attribution

See [architecture.md](architecture.md) and [plan.md](plan.md) as needed. Based on **avtc-pi-portrait** by **avtc**; preserve its source copyright and license notices.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.1.0 | 2026-10-11 | Initial committed draft. |
| 0.2.0 | 2026-10-12 | Added the optional `probe` run type. |
