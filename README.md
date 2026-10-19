# pi-session-compass

Builds a behavioral portrait from your session history — learns your corrections and injects them into the system prompt so the agent anticipates them before responding.

Based on [avtc-pi-portrait](https://github.com/avtc/avtc-pi-portrait) by avtc.

## Features

- **System-prompt injection** — learned rules are appended to the system prompt, so the agent anticipates your corrections before it responds
- **Learns from real corrections** — extracts lessons from agent → user → agent interaction trios, filtering out approvals and extension-generated noise so only genuine feedback shapes the portrait
- **Optional Jev gate** — scores each trio with the Jev classifier before extraction, so trios with no lesson can skip the extraction call (off by default; see [Jev gate](#jev-gate))
- **LLM-curated ranking** — each candidate is ranked against your existing portrait (insert, merge, skip, or evict), keeping the most valuable rules on top
- **Automatic background dreaming** — runs on a timer (default off) to continuously learn from new sessions; enable via `/portrait:settings`
- **Maintenance** — automatically deduplicates, resolves contradictions, removes harmful rules, and promotes displaced rules back into freed slots as your portrait grows (also on demand via `/portrait:maintenance`)
- **Automatic + manual control** — run fully automatic, or drive it manually with `/portrait:collect`, `/portrait:stop`, `/portrait:pause`, `/portrait:resume`, and `/portrait:reset`
- **Live status widget** — real-time progress in the status bar (phase, trios processed, MB scanned, live token count)
- **Incremental scanning** — per-file checkpoints mean only new session data is processed each cycle
- **Cost control** — run dreaming on a cheaper model, with separate model overrides for extraction, post-extraction, and maintenance
- **Git-tracked history** — every portrait change is committed, giving you full auditability and easy recovery
- **Debug traceability** — opt-in dumps capture each extraction, maintenance, and backfill call's full input and streamed output, so you can trace unexpected rules back to their source interaction

A manual collect run with the live status widget showing progress:

![collect command and widget](assets/images/collect-command-and-widget.png)

## Installation

```bash
pi install git:github.com/contactwlkLA/pi-session-compass
```

## Starter Portrait (optional)

New installs start with an empty portrait and automatic collection disabled. Anticipation rules are extracted from your own sessions when you run `/portrait:collect`. To enable automatic background collection, open `/portrait:settings` and set `intervalMs` to a desired interval.

To get useful behavior from the start, you can seed a curated starter set of generic rules.

A ready-to-use sample lives in the repo at [`assets/portrait.sample.md`](./assets/portrait.sample.md):

```bash
# Copies only portrait.md — back up any existing portrait first
cp assets/portrait.sample.md ~/.pi/portrait/portrait.md
```

Notes:

- The sample is a **static starting point**. As you run collects and maintenance, the extension will rank, evolve, and replace these rules with ones learned from your own sessions.
- It's **not bundled** with the package — grab it from the [GitHub repo](https://github.com/contactwlkLA/pi-session-compass/blob/main/assets/portrait.sample.md).
- Run `/reload` to pick up the copied portrait if pi is already running.

## Configuration

Configure portrait with the `/portrait:settings` command (an interactive editor). Settings are stored in `~/.pi/agent/avtc-pi-portrait-settings.json`, apply globally across all projects, and are read fresh on every cycle — so manual edits take effect immediately.

The full setting reference (types, defaults, descriptions, tab layout) lives in [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md).

## Jev gate

The gate checks each interaction trio with TypeSafe's Jev classifier (`jev-1.13.0`) before extraction. It asks whether your reply corrects the agent, states a lasting preference, or shows confusion; when all three answers score 0.30 or lower, the trio counts as having no lesson. The gate is off by default.

| `gateMode` | Jev requests | Extraction |
|------------|--------------|------------|
| `off` (default) | none | every trio |
| `shadow` | one per trio | every trio; the gate's result is only logged |
| `enforce` | one per trio | skipped for trios the gate rates as no lesson |

Shadow and enforce need a TypeSafe API key in the `TYPESAFE_API_KEY` environment variable of the pi process. Each check sends the trio's text (agent response, your reply, agent response) to `https://api.typesafe.ai`. Without a key, or when Jev fails or takes longer than 5 seconds, the trio is extracted as if the gate were off; after three failed checks in a row, the gate stops checking until the next collection run.

**Measured results.** On one user's sessions that the gate was not tuned on, it kept 77 of 81 trios that held a lesson and missed 3 of 46 corrections. The missed corrections were phrased as requests, such as asking the agent to show a command instead of saying it was wrong. In one paired run on 19 trios, enforce cut total cost (extraction model plus Jev) by 47% and wall time by 38%. A missed correction is a lost rule, so enforce is not recommended yet; use shadow to see how the gate decides on your own sessions.

**Gate log.** In shadow and enforce, every check appends one JSON line to `~/.pi/portrait/gate-log.jsonl`: the time, session file, trio and record IDs, mode, policy hash, decision (`extract` or `skip`), result (`no_lesson`, `maybe_lesson`, or why the check fell back, such as `key_missing` or `timeout`), Jev's answers, request count, latency, and token usage. It holds no trio text and no key. Each line is about 600 bytes. The file is never rotated, so you can delete it at any time, and it is not committed to the portrait's git history. To count the trios that enforce would have skipped:

```bash
grep -c '"result":"no_lesson"' ~/.pi/portrait/gate-log.jsonl
```

**Turning the gate off.** Set `gateMode` to `off` in `/portrait:settings`. No Jev requests are made, nothing more is logged, and every trio is extracted. Snapshots and recovery work the same in every mode.

## Storage

All data is stored in `~/.pi/portrait/`:

- `portrait.md` — Active anticipation rules (line position = rank, top = most valuable)
- `evicted.md` — Mechanically evicted rules (displaced by rule limit)
- `dropped.md` — Semantically dropped rules (removed by maintenance: duplicates, contradictions, harmful rules)
- `processed-sessions.json` — Scan checkpoints (tracks last processed line per session)
- `portrait-state.json` — Pause state, last pipeline run, trio counts, maintenance counters
- `.portrait-lock` — Cross-process lock file with heartbeat
- `debug/` — Extractor, maintenance, and backfill debug dumps (see "Debug" section below)
- `snapshots/` — Collection progress snapshots (see "Recovery" below)
- `gate-log.jsonl` — Jev gate decisions in shadow and enforce (see "Jev gate")

## Recovery

Collection progress (scan positions and pending candidates) is saved as snapshots under `~/.pi/portrait/snapshots/`. After an interruption or a failed call, the next run resumes from the newest complete snapshot and redoes what followed it, so pending candidates are not lost. Portrait files are written atomically, so they are never half-written.

To undo a bad portrait by hand, copy `portrait.md`, `evicted.md`, and `dropped.md` back from the `files/` folder of the newest snapshot (the one named in `snapshots/CURRENT`), or restore them from the portrait's git history, then run `/reload`. Nothing is restored automatically, so your own edits to the portrait are never overwritten.

Before downgrading to an older version of the plugin, run `/portrait:collect` until `/portrait:status` shows no pending candidates: older versions keep the scan position but do not build pending candidates.

## Debug

Set `debugDumpLimit` to a positive number (e.g. `30`) to keep the most recent debug dumps under `~/.pi/portrait/debug/` (`0` = disabled, the default); older files are deleted automatically when the limit is exceeded. Each dump captures the full prompt and the LLM's response for one operation, so you can trace any rule back to the session interaction that produced it:

- `extraction-{timestamp}.txt` — one per extraction call (agent → user → agent trio → extracted rules)
- `maintenance-{timestamp}.txt` — one per maintenance run (dedup/contradiction/harmful-rule pass)
- `backfill-{timestamp}.txt` — one per maintenance backfill run (promoting evicted rules into freed slots)

## Commands

Portrait dreaming runs in two modes:

- **Automatic** — runs periodically on a timer (controlled by `intervalMs` in settings). Use `pause` / `resume` to toggle.
- **Manual** — one-shot trigger with `collect`. Use `stop` to cancel mid-run.

| Command | Description |
|---------|-------------|
| `/portrait:status` | Show current dreaming status (phase, timer, pause state) |
| `/portrait:settings` | Open the interactive settings editor (see [Configuration](./docs/CONFIGURATION.md)) |
| `/portrait:config` | Show every setting with its value and source (default or settings file), the fixed gate and collection values, and the environment variables |
| `/portrait:pause` | Pause automatic dreaming — stops the periodic timer. Manual `collect` runs are unaffected. (Lock holder only) |
| `/portrait:resume` | Resume automatic dreaming — restarts the timer and runs an immediate cycle. (Lock holder only) |
| `/portrait:collect [N]` | Run a one-shot manual collection. Optional `N` limits the number of session sequences to process. Runs in the background; use `/portrait:stop` to cancel. (Lock holder only) |
| `/portrait:stop` | Cancel a running manual `collect`. Does not affect the automatic timer. |
| `/portrait:maintenance` | Analyze and clean the portrait: remove duplicates, contradictions, and harmful rules, then promote evicted rules into freed slots. |
| `/portrait:reset` | Clear all portrait rules (portrait.md, evicted.md, dropped.md) and scan state. Preserves git history. Re-extracts from session history on next collect. (Lock holder only, requires confirmation) |

Cached portrait rules are refreshed from disk on `/reload`.

## How It Works

Portrait dreaming learns from **interaction trios** in your session history — an agent response, your correction or flag, and the agent's improved response. From each trio it extracts a **rule** that says when it applies, what to do differently, and why, ranks it against your existing portrait, and keeps the most valuable ones. The portrait is then appended to the system prompt on every agent turn, so the agent anticipates your corrections before it responds. Run `/portrait:maintenance` any time to deduplicate, resolve contradictions, generalize over-specific rules, and drop harmful ones.

## Full suite

Check out the full suite of related extensions, [avtc-pi](https://github.com/avtc/avtc-pi) — deterministic feature development, subagent delegation, working-memory, behavioral learning, parallel-work guardrails, durable decisions, notifications, and more.

Developed with [Z.ai](https://z.ai/subscribe?ic=N5IV4LLOOV) — get 10% off your subscription via this referral link.

## License

MIT
