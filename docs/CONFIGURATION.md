# Configuration

Configure portrait via the `/portrait:settings` command, which opens an interactive settings editor. Settings are stored in `~/.pi/agent/avtc-pi-portrait-settings.json` and apply globally across all projects. They are read fresh from disk on every cycle, so changes made by hand (or by another pi instance) take effect immediately — no reload needed.

## General

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch for the portrait extension (background collection + injection) |
| `gateMode` | string | `off` | Jev gate before extraction: `off` (no check), `shadow` (check and log, extract every trio), `enforce` (skip trios the gate rates as no lesson). Needs `TYPESAFE_API_KEY`; see [Jev gate](../README.md#jev-gate) |
| `intervalMs` | duration | `Off` | Background collection interval. Off = manual-only (collect via `/portrait:collect`) |
| `startupDelayMs` | duration | `2s` | One-time delay after the app starts before the first background collection |
| `ruleLimit` | number | `200` | Maximum number of portrait rules kept (highest-value first; lowest-value evicted when exceeded) |
| `maxAgeDays` | number | `30` | Only scan session files modified within this many days (filters by file mtime) |

## Building

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `model` | model | (session) | Extraction + building model. Default = the session model |
| `thinkingLevel` | thinking-level | `high` | Reasoning depth for extraction/building LLM calls |
| `maxTokens` | number | `8192` | Maximum output tokens per extraction/building LLM call |
| `timeoutMs` | duration | `3m` | Aborts an extraction/building LLM call if it runs longer than this. Infinite = no limit |
| `retries` | number | `3` | Retry attempts before the failure dialog (0 = one attempt, no retries). Exponential backoff between retries: 1s, 2s, 4s, 8s, capped at 10s |
| `buildingBatchSize` | number | `1` | How many extracted candidates to process per building LLM call |
| `rateLimitMs` | duration | `5s` | Minimum spacing between LLM calls (applied after every extraction and builder call) |
| `debugDumpLimit` | number | `0` | Debug dumps kept under `~/.pi/portrait/debug/` (`0` = disabled) |
| `postExtractionEnabled` | boolean | `false` | Review and refine extracted rules (keep, rewrite, or drop) before they enter the portrait |
| `postExtractionModel` | model | (session) | Model for the post-extraction pass. Default = the session model |

## Maintenance

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `maintenanceModel` | model | (session) | Maintenance model (pruning, merging, re-ranking). Default = the session model |
| `maintenanceEveryNRulesInserted` | number | `200` | Run maintenance after every N rules inserted (0 = never) |
| `maintenanceBackfillBatchSize` | number | `20` | How many evicted rules to re-evaluate per maintenance backfill LLM call |
| `maintenanceMaxTokens` | number | `0` | Maximum output tokens per maintenance LLM call (0 = provider default) |
| `maintenanceTimeoutMs` | duration | `1h` | Aborts a maintenance run if it runs longer than this. Off = no deadline (runs to completion) |

## Fixed values and environment

These values are not in `/portrait:settings`. `/portrait:config` shows them with the settings.

### Jev gate

Set in `src/gate-config.ts`; changing one changes the gate's policy hash.

| Value | Current | Meaning |
|---|---|---|
| Model | `jev-1.13.0` | Classifier release every gate request is pinned to |
| Endpoint | `https://api.typesafe.ai/v1/systemone` | Where every gate request is sent |
| Threshold | `0.3` | A trio is skipped when its correction, preference, and confusion answers are all at or below this |
| Deadline | 5 s | Total time one gate check may take, retry included |
| Retry wait | 0.5 s | Wait before the single retry when the response gives no Retry-After |
| Failure limit | 3 | Failed checks in a row after which the gate stops checking until the next collection run |
| State cap | 32 KB | A larger trio is extracted without a gate check |

### Collection

Set in `src/plugin-config.ts`.

| Value | Current | Meaning |
|---|---|---|
| Files per scan | 100 | Session files one scan step reads before it returns |
| Lock poll | 60 s | How often an instance without the lock checks whether it can take it |
| Retry backoff | 1 s, doubling, capped at 10 s | Wait between retries of a failed LLM call |
| Footer refresh | 5 s | How often the status footer updates |

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `PI_PORTRAIT_STATE_DIR` | `~/.pi/portrait` | Where the portrait and its state are kept |
| `PI_PORTRAIT_SESSION_DIRS` | `~/.pi/agent/sessions` | Session folders to scan; separate several with `:` (`;` on Windows) |
| `TYPESAFE_API_KEY` | not set | API key for the Jev gate; needed by `shadow` and `enforce` |

## Setting types

- **duration** — entered as a human-friendly string (`5m`, `2s`, `1h`) in the editor; stored as milliseconds. Duration settings have an `Ms` suffix in their key. Some durations offer an Off/Infinite preset (stored as `null`).
- **number** — integer. Some use `0` as a sentinel (e.g. `maintenanceMaxTokens: 0` = provider default).
- **model** — a `provider/model-id` string, or `null` to use the current session model.
- **boolean** — `true` / `false`.
- **thinking-level** — one of pi's reasoning levels (off, minimal, low, medium, high, xhigh).
- **string** — one of the listed presets (e.g. `gateMode`: `off`, `shadow`, `enforce`).

See the [`/portrait:settings`](../README.md#commands) command to edit these interactively.
