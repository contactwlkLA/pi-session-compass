# Stage 8 — Task specs (Pi codes, Claude Code reviews)

Project: **pi-session-compass** · Revision: **0.5.0** · Status: **S8-01 approved; S8-02 done; S8-03 ready (design and text approved by the user, 2026-10-18)**

Date: **2026-10-18**

Parent: [stage-8-task.md](stage-8-task.md) (fixed design 1–7).

**Coder rules, spec audit, and handoff format:** [stage-3b.md](stage-3b.md), section "Coder rules", unchanged, except that the audit and handoff go to `outputs/s8/handoff/<task_id>-audit.md` and `outputs/s8/handoff/<task_id>-r<round>.md`. Never write `~/.pi` or `~/.claude`; tests build their own logs in a temporary directory.

## S8-01 — Metric definitions and report text (approved by the user, 2026-10-18)

CC measured each fuzzy rule by hand on this project's Pi and Claude Code logs (outputs/s8/s8-01-definitions.md, local). Two changes to stage-8-task.md, approved with the definitions: "failed checks later fixed" moves into **Checks**, and review findings are counted in **Your interventions** as "Corrections followed by edits" (one log cannot show a review made in one tool and fixed in another); **Behavior** includes this project's relayed-spec Pi sessions in their own row, never mixed into the development rates.

### Inputs and segments

- **Pi log:** first record `{"type":"session","version":…}`. Records are `message` (roles `user`, `assistant`, `toolResult`, `system`), `custom` (e.g. `customType: "portrait-cache"`), `model_change`, `thinking_level_change`.
- **Claude Code log:** records carry `sessionId` and a `type` (`user`, `assistant`, `system`, `cost-state`, and others to ignore). Skip every record with `isSidechain: true`.
- **Prompt.** Pi: a `message` record with role `user`. Claude Code: a `user` record whose `origin.kind` is `"human"` (slash commands, task notifications, meta records, interruptions, and tool results are not prompts).
- **Segment:** a prompt and every record after it up to the next prompt. Records before the first prompt belong to no segment.

### Rules (per segment; a session sums its segments, the total sums sessions; peak is a maximum)

| Section | Metric | Pi | Claude Code |
|---|---|---|---|
| Effort | Prompts | prompts | prompts |
| | Turns | assistant messages | distinct `message.id` of assistant records |
| | Wall time | last minus first record timestamp of the segment | sum of `system` records with `subtype: "turn_duration"` (`durationMs`) in the segment |
| | Tool time | sum of `toolResult` `durationMs` | per `tool_use` block, timestamp of the record carrying its `tool_result` minus the timestamp of the assistant record carrying the `tool_use` |
| | Model time | sum of assistant `durationMs` | wall time minus tool time, not below 0 |
| Tokens and cost | Input / Output / Cache read | `usage.input` / `output` / `cacheRead` | `usage.input_tokens` / `output_tokens` / `cache_read_input_tokens`, counted once per distinct `message.id` |
| | Cache write | `usage.cacheWrite` | `usage.cache_creation_input_tokens` |
| | Peak context | largest `input + cacheRead` of one assistant message | largest `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of one message |
| | Cost | sum of `usage.cost.total` | session level only: `totalCostUSD` of the last `cost-state` record; segments show `not recorded`; no record → `not recorded` |
| Checks | Check run | a bash tool call (Pi `toolCall` named `bash`, `arguments.command`; Claude Code `tool_use` named `Bash`, `input.command`) whose command, after removing heredoc bodies and quoted strings, runs a check tool as a command word | same |
| | Kind | test: `vitest`, `jest`, `pytest`, `npm test`, `npm run test…`, `cargo test`, `go test`; lint: `biome`, `eslint`, `ruff`, `npm run lint…`, `knip`, `jscpd`; typecheck: `tsc`, `mypy`, `pyright`, `npm run typecheck` (first match in that order) | same |
| | Failed | the result is an error (Pi `isError`; Claude Code `is_error`), or its text matches a failure marker: `N failed` (N ≥ 1), `FAIL`, a line starting with `×` or `✗`, `error TS`, `Found N error(s)` (N ≥ 1), a non-zero exit line (`exit code N`, `Exit code N`, `Command exited with code N`, `exit=N`, `EXIT:N`, N ≥ 1) | same |
| | Expected failure | a failed run whose most recent agent text before the call (last 600 characters) matches: `should fail`, `must fail`, `expect… to fail`, `confirm … fails`, `fails before`, `fails on the current`, `test-first`, `test first`, `mutant`, `reproduc`, `before the fix`, `failing test` (case-insensitive) | same |
| | Fixed in session | an episode (a failed, not expected run; following failed runs of the same kind join the episode) closes at the first later passing run of the same kind; it is fixed when a change lies between its first failure and that pass. A change is an edit or write tool call, or any bash call whose cleaned command contains `--write`, `--fix`, or `sed -i` (a check included: a passing `biome check --write` is both the change and the pass) | same |
| Agent questions | Turns ending with a question | segments whose last agent text has a line ending in `?` among its last 3 non-empty lines | same |
| Your interventions | codes | S8-03 | S8-03 |
| Lessons | grades | S8-04 | S8-04 |
| Behavior | rates | S8-05 | `not applicable` |

Measured on this project's logs: failed-run recall 104 of 114 before the last markers were added; fixed-in-session precision 16 of 20 (the false hits were expected failures and output-reading artifacts); questions 12 of 12.

### Lesson grades (S8-04)

| Grade | Meaning | Example (neutral) |
|---|---|---|
| good | supported by the user's reply, specific enough to change a future action, true beyond this task | the user is unhappy that the agent noticed a change outside its instructions and did not flag it → "Surface discretionary decisions as explicit choices needing confirmation at decision time" |
| vague | supported, but no concrete trigger or action | the user says an external audit overrides a stale requirement → "Prefer authoritative evidence over stale documentation" |
| wrong | not supported by the trio: a misread reply, a mispaired trio, or a one-off detail stated as a lasting rule | the user asks for an analysis of a new finding → a rule about confirming a no-write boundary |

Sample: every rule when there are 30 or fewer, else 30 drawn with a fixed seed.

### Behavior (S8-05)

Rates per trio, by period: **before** (Pi sessions with no `portrait-cache` record), **after** (development sessions with one), **after (relayed specs)** (this project's Pi sessions, whose prompts are specs relayed from CC). Fewer than 5 sessions on either side of a comparison → the line `too few sessions to compare (…)`.

### Report text (approved; exact)

```
# Session report: <input path>
Sessions: <n> · Prompts: <n> · Format: Pi | Claude Code · Generated: <ISO date>

## Effort             Session | Prompts | Turns | Wall time | Model time | Tool time
## Tokens and cost    Session | Input | Output | Cache read | Cache write | Peak context | Cost
## Checks             Session | Check runs | Failed | Fixed in session | Expected failures
## Agent questions    Session | Prompts | Turns ending with a question
## Your interventions Session | Approval | Correction | Hold-back | Task step | Chatter | Corrections followed by edits
   Reply codes are model answers. Measured accuracy: correction precision 52%, recall 89%; hold-back precision 61%, recall 52%.
## Lessons            Grade | Rules | Example
   Graded by CC on a sample of <n> of <m> rules; spot-checked by the user: <yes/no>.
## Behavior           Period | Sessions | Trios | Correction rate | Hold-back rate
   (period values: before, after, after (relayed specs))

not recorded · not scored · not applicable
too few sessions to compare (<n> before, <m> after; 5 needed on each side)
Footer: Counted from the session logs; no number is reported by an agent.
```

The header's format value is `Pi` or `Claude Code` (one of the two). The column layout in the block above is shorthand: each heading is a markdown `##` line followed by a markdown table with exactly those columns.

## S8-02 — `report` command: log sections

**Goal:** one offline command that reads one Pi or Claude Code session file or folder (read-only) and writes `report.md` and `report.jsonl` with the Effort, Tokens and cost, Checks, and Agent questions sections. The other three sections are present and say `not scored` (Behavior on Claude Code logs: `not applicable`). No model request, no network, no change to src/.

**Read:** md/stage-8-specs.md S8-01 (above; the rules table is the contract); scripts/compass/util.ts (`parseArgv`, `findWorkspaceRoot`); scripts/compass/strings.ts (style of the `strings` object); scripts/compass/score.ts lines 1–30 and 600–620 (file header and the `main` / `import.meta.url` entry pattern); knip.json (`entry`); tests/compass/score.test.ts (temp-dir test style).

**Where and how (CC's plan):**

1. **New scripts/compass/report.ts.** Usage `node_modules/.bin/jiti scripts/compass/report.ts (--session <file.jsonl> | --dir <folder>) --output <dir>`. Structure:
   - `detectFormat(firstRecord)` → `"pi" | "claude-code" | null` (Pi: `type === "session"` with a `version`; Claude Code: has a string `sessionId`).
   - `readSegments(file, format)`: streams the file line by line (`readline` over `fs.createReadStream`, not `readFileSync`: Claude Code logs reach tens of MB); skips blank and malformed lines and counts them as `skippedLines`; returns the session id (Pi header `id`; Claude Code `sessionId`), its start timestamp, and the segments with the records each needs. Pair tool calls and results by id (Pi `toolCall.id` ↔ `toolResult.toolCallId`; Claude Code `tool_use.id` ↔ `tool_result.tool_use_id`).
   - `measureSegment(segment, format)` → the S8-01 metrics for one segment; `isCheck(command)`, `checkKind(command)`, `isFailed(resultText, isError)`, `isExpected(agentText)` as separate exported functions so the tests can pin them.
   - `fixedEpisodes(checkRuns, changes)` works on the whole session (an episode in one segment may be fixed in a later one), counting each episode in the segment where its first failure happened.
   - `renderMarkdown(report)` and `renderJsonl(report)`; `main(argv)`.
   - `--dir`: every `*.jsonl` directly in the folder (no subfolders), sorted by name; each file's format is detected; a folder holding both formats is refused; a file of neither format is refused (`--session`) or counted in `skippedFiles` (`--dir`).
   - Read-only: input files are opened for reading only. `--output` is created if missing; it is refused when it resolves inside the input folder (or the input file's folder), inside `~/.pi`, or inside `~/.claude`.
2. **report.md layout.** The approved title and header line, then the seven sections in the approved order, each a `##` heading and a markdown table with the approved columns; one row per session (label: the session's start date `YYYY-MM-DD` and the first 8 characters of its id, e.g. `2026-10-18 01a14cf6`), sorted by start time, and a final row `Total` when there are 2 or more sessions. Checks: one row per session and kind that has runs, Session cell `<label> · <kind>`. Value formats: times in minutes with one decimal and the unit (`9.7 min`); tokens with thousands separators (`28,814`); cost `$` with 4 decimals, or `not recorded`. Your interventions and Lessons: the heading, then the line `not scored`. Behavior: `not scored` for Pi, `not applicable` for Claude Code. Your interventions keeps its approved accuracy line under the `not scored` line. The approved footer ends the file.
3. **report.jsonl.** One JSON object per line: every segment (`level: "segment"`, `session`, `index` from 1, `promptHead`: the prompt's first 48 characters with whitespace collapsed), every session (`level: "session"`, plus `file`, `format`, `skippedLines`), and one total (`level: "total"`, plus `skippedFiles`). Each object carries `effort {prompts, turns, wallMs, modelMs, toolMs}`, `tokens {input, output, cacheRead, cacheWrite, peak}`, `costUsd` (number or `null`), `checks {test, lint, typecheck}` each `{runs, failed, fixed, expected}`, `questions`. Times in ms, unrounded.
4. **Strings.** All report text goes into scripts/compass/strings.ts under a `// ── Session report ──` group: the approved report text above and the approved command messages below, verbatim.
5. **knip.json:** add `scripts/compass/report.ts` to `entry`.

**Command messages (approved by the user, 2026-10-18; exact):**

- `compass report: pass --session <file> or --dir <folder>, and --output <dir>.`
- `compass report: <path> is not a Pi or Claude Code session log.`
- `compass report: no session logs in <dir>.`
- `compass report: <dir> holds both Pi and Claude Code logs; pass one folder per tool.`
- `compass report: --output must not be inside the input, ~/.pi, or ~/.claude.`
- Done line (stdout): `compass report: <n> sessions, <m> prompts → <output>/report.md`
- Table row label: `Total`

Errors go to stderr with exit code 2; nothing is written to `--output` on an error.

**Tests — new tests/compass/report.test.ts.** Build every log in a temp dir with small helpers (`piSession(records)`, `ccSession(records)`); no real logs. Write the fixture values first, derive the expected counts into a table in a comment, then assert from the table (coder rules).

1. Pi effort and tokens: a 2-prompt session with known `durationMs`, timestamps, and usage → exact prompts, turns, wall, model, tool, tokens, peak, cost per segment and per session.
2. Claude Code effort and tokens: one API response split across 3 assistant records with the same `message.id` counts as 1 turn and its usage once; a sidechain record is ignored; a slash-command record and a task notification are not prompts; tool time from timestamps; model time = wall − tool; segment cost `not recorded`, session cost from the last of two `cost-state` records; a log without `cost-state` → `not recorded`.
3. `checkKind` / `isCheck` table: `npx vitest run tests/a.test.ts 2>&1 | tail` test; `cd /x && npm test > /tmp/l 2>&1; echo $?` test; `for i in 1 2; do npx vitest run; done` test; `timeout 600 npx vitest run` test; `npx tsc --noEmit` typecheck; `npx biome check --write src` lint; `npm run test:compass` test; `git add knip.json && git commit -m x` none; a heredoc whose body mentions `vitest` none; `grep -E 'vitest|FAIL' log` none.
4. `isFailed` table: `Tests  2 failed | 3 passed` yes; `Tests  0 failed` no (and plain `5 passed` no); `× Some errors were emitted while running checks.` yes; `exit=1` yes; `exit=0` no; `error TS2304: Cannot find name` yes; `Found 0 errors` no; `isError: true` with clean text yes.
5. Episodes: fail → edit → pass = 1 fixed; fail → pass with no change between = 0 fixed; fail, fail (same kind) → edit → pass = 1 episode, 1 fixed; fail → `biome check --write` → pass = 1 fixed; an expected failure (agent text "Test first: this should fail") → counted under expected, not fixed; a fail in segment 1 fixed in segment 2 is counted in segment 1.
6. Questions: last text ending `Should I go ahead?` yes; a `?` only in an earlier paragraph (4+ lines before the end) no; a segment with no agent text no.
7. Rendering: report.md for a 2-session Pi folder matches an expected string built from the approved text (title, header, the seven headings in order, the `Total` row, `not scored` lines, footer); Claude Code Behavior reads `not applicable`; report.jsonl has one segment line per prompt, one per session, one total.
8. Refusals, each with exit 2, the approved message, and no file in `--output`: no input switch; both `--session` and `--dir`; a non-log file; an empty folder; a mixed folder; `--output` inside the input folder.
9. Read-only: the input files' bytes and mtimes are unchanged after a run.
10. Malformed and partial lines: a log whose last line is cut mid-JSON reports `skippedLines: 1` and still measures the rest.

**Audit answers (CC, 2026-10-18; outputs/s8/handoff/S8-02-audit.md):**

1. **Blocker 1:** agreed; the rules table is amended (a change is any edit/write call or any bash call with `--write`, `--fix`, or `sed -i`, checks included).
2. **Episode edge:** as you propose. An episode closes at the first passing run of its kind and is fixed only when a change lies between its first failure and that pass, so `fail → pass → edit → pass` is 0 fixed. A single call that is both the change and the passing run counts as fixed. Add both cases to test 5.
3. **Not-scored sections and legend:** as you plan. `## Your interventions`, `not scored`, the accuracy line; `## Lessons`, `not scored`; `## Behavior`, `not scored` (Pi) or `not applicable` (Claude Code). The two legend lines are template documentation, not printed. The file ends with `Counted from the session logs; no number is reported by an agent.` (no `Footer: ` prefix). `Generated:` is `YYYY-MM-DD`.
4. **Pi timing:** confirmed on a real log: assistant and `toolResult` message records carry `message.durationMs` (140 and 174 in the current session), whatever the installed types declare. Wall time uses the record-level ISO `timestamp`.
5. **Claude Code prompts:** `type === "user" && origin?.kind === "human"`, skipping records with a `tool_result` block and `isMeta` records. In the measured logs slash commands, meta records, and interruptions have no `origin`, and task notifications have `origin.kind === "task-notification"`, so that test is enough. Do not add the leading-`/` rule: a typed prompt may start with a path.
6. **Risks 3 and 8:** as you plan (anchored markers; file-name order breaks start-time ties).

**Acceptance criteria:**

1. Every test above passes; `npm test` and `npm run test:compass` pass in full.
2. On this project's real logs (run by CC at review, not by the coder): the Pi folder's numbers for the S7-04 T2 round-2 segment match the ledger row (26 turns, 530 s model, 54 s tool, 28,814 / 19,525 / 5,590,016 tokens, peak 225,193, $0.0496) within rounding.
3. Report text and messages match the approved strings byte for byte; no other user-facing string is added.
4. No change to src/, the gate, its policy hash, or any existing harness command; no network or model request (the command imports nothing from src/ that boots a model).

**Allowed scope:** scripts/compass/report.ts (new), scripts/compass/strings.ts (the new group only), tests/compass/report.test.ts (new), knip.json (`entry` only).

**Verification:**

```
npx vitest run --config vitest.compass.config.ts tests/compass/report.test.ts
npm test
npm run test:compass
```

**Round 2 (CC review of r1, 2026-10-18):** r1 is accepted except one bug and two format nits. On this project's real logs the Pi numbers match the ledger exactly, and the three spot mutants are killed.

1. **Bug (md/bugs.md B25):** every Claude Code session is labelled `1969-12-31 …` and sorted as if it started at epoch 0. A Claude Code log opens with records that carry no `timestamp` (`mode`, `permission-mode`), and `readSegments` takes the session start from the first record. Fix: the session start is the first record that carries a `timestamp` (Pi: still the header). The session id stays as it is.
   - Test (fails on r1): a Claude Code log whose first two records are `{"type":"mode",…,"sessionId":…}` and `{"type":"permission-mode",…}` without `timestamp` gets the label date of the first timestamped record. Two such sessions are sorted by that start, not by file name.
2. **Nit:** the accuracy line has no leading spaces. The indent in the approved block was layout. Update the rendering test.
3. **Nit:** the Prompts, Turns, and Turns ending with a question columns use the thousands format too (`2,202`, not `2202`).
4. **Verification:** the S8-02 block; handoff outputs/s8/handoff/S8-02-r2.md (round-2 changes only).

## S8-03 — Your interventions: score every prompt

**Approved by the user, 2026-10-18 (design change to stage-8-task.md S8-03):** every prompt after the first is scored from the report's own segments, in Pi and Claude Code logs alike, instead of from a trio corpus (the trio detector reads only Pi logs and skips short approvals). The report writes the exchanges, `score.ts` scores them with the reply-code questions, and the report reads the scores back. Exchanges over the classifier's 32 KB limit are trimmed, not skipped. The Claude Code run sends this project's Claude Code prompts and the agent text around them to api.typesafe.ai (user-approved).

**Audit (shorter than before):** write only `Blockers` and `Questions` (one line `none` each if so); skip `Risks` and `Noise` unless something would break. Read only the Read list; do not search `node_modules`: the record shapes are in S8-01 and in the code you wrote in S8-02.

**Read:** scripts/compass/report.ts (your S8-02 code: segments, agent text, changes, rendering, `main`); scripts/compass/score.ts (whole `main`: checks order, confirmation block, cache, stop rules, outputs); scripts/compass/corpus-run.ts (`loadCache`, `appendCacheLine`); scripts/compass/strings.ts (`// ── Corpus scoring ──` and `// ── Session report ──`); scripts/compass/questions/reply-codes-v1.json; src/jev.ts (`buildGateState`, `JEV_POLICY.stateCapBytes`); tests/compass/score.test.ts (fetch mock and key handling); tests/compass/report.test.ts.

**Where and how (CC's plan):**

1. **Exchanges (report.ts).** For each session and each segment `i ≥ 2` where segment `i − 1` has agent text and segment `i` has agent text, one exchange: `agentBefore` = the last agent text of segment `i − 1`, `userFeedback` = the prompt text of segment `i`, `agentAfter` = the first agent text of segment `i` (agent text = the text blocks of one assistant message, Claude Code records grouped by `message.id`, as in S8-02). Other prompts get no exchange and are not counted. Each `report` run writes `exchanges.jsonl` next to report.md, one line per exchange: `key`, `session` (the label), `sessionId`, `file` (base name), `index` (segment index), `agentBefore`, `userFeedback`, `agentAfter`, `trimmed`.
   - **Key:** the first 16 hex characters of sha256 over `${sessionId}\n${index}\n${agentBefore}\n${userFeedback}\n${agentAfter}` (after trimming), like `trioKey` in corpus.ts.
   - **Trim:** size = `Buffer.byteLength(JSON.stringify({agentBefore, userFeedback, agentAfter}))`. When it is over `EXCHANGE_CAP_BYTES` (a report.ts constant, 32 × 1024; a test asserts it equals `JEV_POLICY.stateCapBytes`; report.ts itself imports nothing from src/): keep `userFeedback` whole, keep the **end** of `agentBefore` and the **start** of `agentAfter`, giving `agentAfter` at most a quarter of the room left after the prompt and `agentBefore` the rest; shorten by characters until the size is at most the cap; `trimmed: true`. A prompt that alone does not fit gets no exchange.
2. **Scoring (score.ts `--exchanges <file>`).** A second input mode beside `--corpus/--set`, which stays unchanged.
   - Checks before any request, in this order: limits; then the input mode: `--exchanges` with `--corpus` or `--set`, or `--exchanges` without `--questions`, is refused with `scoreInputConflict`; concurrency; question set; then the exchanges file: every line parses and has string `key`, `session`, `sessionId`, `file`, `agentBefore`, `userFeedback`, `agentAfter` and an integer `index`, keys are unique, else `scoreBadExchanges`.
   - Cache: `<folder of the exchanges file>/cache/questions-<question-set hash>.jsonl`, the same line shape and rules as the corpus question cache. Output: `--output`, default the folder of the exchanges file.
   - Confirmation block: `scoreHeader`, `scoreExchanges(file, n, cached, toScore)`, `confirmLimits`, `confirmLimitSource`, `scoreModelQuestions`, `scoreOutput`; then `--confirmed`, then `TYPESAFE_API_KEY`, as now.
   - Each exchange is scored like a trio (`buildGateState` → `callJev` with the question-set policy, the same counter, retries, stop rules, and concurrency); the progress line is `scoreProgressPrompt`; the done line is `scoreDone`. Writes `scores.jsonl` (one line per exchange in file order: `key`, `session`, `index`, `verdict`, `answers`, `reason`, `model`, `attempts`, `latencyMs`, `usage`, `cached`) and `summary.json` as now; no `codes.md` or score table in this mode.
3. **Join (report.ts `--codes <scores.jsonl>`).**
   - Every line must parse and carry a string `key` and a string `verdict`, else `reportBadCodes` (exit 2, nothing written).
   - A session is **scored** when every one of its exchanges has a line with `verdict: "scored"`; otherwise all its Your interventions cells read `not scored`. The `Total` row reads `not scored` when any session is not scored. A session with no exchanges is scored with zero counts.
   - Counts per scored session: Approval, Correction, Hold-back, Task step, Chatter = exchanges whose answer for `approval`, `correction`, `hold_back`, `task_step`, `chatter` is ≥ 0.5; Corrections followed by edits = exchanges with `correction` ≥ 0.5 whose segment contains a change (the S8-02 change rule).
   - Your interventions then renders as a table with the approved columns (thousands format), followed by the approved accuracy line; without `--codes` it stays as in S8-02 (`not scored`, accuracy line).
   - report.jsonl: each segment object gains `codes` (the five codes as booleans, or `null` when the segment has no scored exchange) and each session and total object gains `interventions` (the six counts, or `null` when not scored).

**Strings (approved by the user, 2026-10-18; exact):**

- `scoreExchanges`: `Exchanges: <file>: <n> prompts (<c> cached, <k> to score)`
- `scoreProgressPrompt`: `prompt <n>/<total>: <verdict>`
- `scoreBadExchanges`: `compass score: <file> is not a valid exchanges file.`
- `scoreInputConflict`: `compass score: pass either --corpus with --set, or --exchanges with --questions.`
- `reportBadCodes`: `compass report: <file> is not a scores file from compass score.`

**Tests.** Fixture values first, expected counts in a comment table, assertions from the table.

1. Exchanges: a 3-prompt Pi session gives 2 exchanges with the right three texts and indexes; a segment with no agent text before or after gives none; a Claude Code reply split across records with one `message.id` is one agent text; keys are stable across two runs.
2. Trim: a 40 KB `agentBefore` → `trimmed: true`, size ≤ cap, the prompt whole, `agentBefore` ends with the original's last 100 characters, `agentAfter` starts with the original's first 100 characters; a 33 KB prompt alone → no exchange; an exchange under the cap is unchanged with `trimmed: false`; `EXCHANGE_CAP_BYTES === JEV_POLICY.stateCapBytes`.
3. score `--exchanges` (fetch mocked as in score.test.ts): `--exchanges` with `--set`, and without `--questions`, are refused with `scoreInputConflict` and no request; a file with a missing field or a duplicate key → `scoreBadExchanges`, no request; without `--confirmed` the block shows the exchanges line and no request is made; a scored run writes scores.jsonl in file order; a rerun is served from the cache with zero requests; the request limit stops the run with the remaining lines `not run`.
4. Join: answers 0.49 and 0.5 → no and yes; a session with one missing line, and one with a `fallback` line, read `not scored`, and the `Total` row reads `not scored`; corrections followed by edits counts only correction exchanges whose segment has a change; a bad codes file → `reportBadCodes`, exit 2, nothing written; without `--codes` the section is unchanged from S8-02; report.md's Your interventions table for a 2-session fixture matches an expected string byte for byte.

**Acceptance criteria:**

1. Every test above passes; `npm test` and `npm run test:compass` pass in full.
2. The new strings match the approved text byte for byte; no other user-facing string is added or changed.
3. The corpus mode of score.ts behaves as before (its existing tests pass unchanged); no change to src/, the gate, or its policy hash.
4. No request without `--confirmed` and the key; report.ts makes no request and imports nothing from src/.

**Allowed scope:** scripts/compass/report.ts, scripts/compass/score.ts, scripts/compass/strings.ts (the new strings only), tests/compass/report.test.ts, tests/compass/score.test.ts (or a new tests/compass/score-exchanges.test.ts).

**Verification:**

```
npx vitest run --config vitest.compass.config.ts tests/compass/report.test.ts tests/compass/score.test.ts
npm test
npm run test:compass
```

**Audit answers (CC, 2026-10-18; outputs/s8/handoff/S8-03-audit.md):**

1. **Blocker 1 (summary.json):** as you propose. In exchanges mode, write the same object without `corpus`, `set`, and `corpusFreeze`, and add `exchanges: <file>` and `prompts: <n>`. Every other field stays.
2. **Blocker 2 (duplicate keys):** as you propose. The report keeps the first exchange per key (sessions in start-time order, then file name) and drops later duplicates, so its exchanges file is always valid input for score. Add a test with two copies of one log.
3. **Columns line:** yes, `reportInterventionsColumns` with the S8-01 approved columns; counts through `reportNumber`; a `Total` row only with 2+ sessions, as in the other sections.
4. **Segment codes in an unscored session:** `null` on every segment of a session that is not scored, so `codes` and `interventions` agree.
5. **Claude Code session id:** take it from the first record that carries a string `sessionId` (Pi: the header, unchanged). Add a test with a leading record that has none.
6. **Trim:** as you read it. Room = cap minus the size with both agent texts empty; `agentAfter` at most a quarter; on overshoot shrink `agentAfter` first, then `agentBefore`, re-measuring. An exchange whose prompt fits but leaves no room for either text is still written (`trimmed: true`, both texts empty); only a prompt that does not fit alone is skipped.
7. **Text-less segments:** track "segment has agent text of its own" separately, as you note, so a text-less segment never borrows its predecessor's text.

**After acceptance (CC):** two live runs, each with limits suggested by CC and confirmed by the user at launch (run type `evaluate`): this project's Pi folder (about 87 exchanges) and Claude Code folder (about 461). Then the report with `--codes` for each.

## CC review and gate (not for the coder)

Review per planner-prompt.md Step 2 with 2–3 spot mutants (in `isFailed`, the episode rule, the Claude Code turn de-duplication); ledger entry in md/ledger.jsonl. Run the command on this project's Pi folder and Claude Code folder and check acceptance criterion 2. After acceptance the ledger's harness fields come from report.jsonl instead of ~/.claude/tools/pi-session-report.py.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.3.0 | 2026-10-18 | S8-02 round 2: Claude Code session start (B25), two format nits. |
| 0.4.0 | 2026-10-18 | S8-03 spec: score every prompt from the report's segments (user-approved design and text). |
| 0.5.0 | 2026-10-18 | S8-03 audit answers. |
