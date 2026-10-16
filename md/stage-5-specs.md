# Stage 5 — Task specs (Pi codes, Claude Code reviews)

Project: **pi-session-compass** · Revision: **0.1.0** · Status: **Approved (user, 2026-10-16)**

Date: **2026-10-16**

Parent: [stage-5-task.md](stage-5-task.md) (pilot scope, fixed design, decisions D1–D3).

**Coder rules, spec audit, and handoff format:** [stage-3b.md](stage-3b.md), section "Coder rules", unchanged, except that the audit and handoff go to `outputs/s5/handoff/<task_id>-audit.md` and `outputs/s5/handoff/<task_id>-r<round>.md`. The rule "do not touch `~/.pi`" holds: the code you write takes the source folders as arguments, and every test uses temporary folders. CC runs the freeze on the real folders.

## S5-01 — Corpus freeze, session split, gate scoring

Two new harness commands. `corpus.ts` copies chosen session folders into a frozen corpus, counts every trio, and splits sessions into a development set and a held-out set. `score.ts` scores a set's trios with the Jev classifier, several at a time, counted against run limits, and caches results so a rerun never pays twice. No extraction, no building, no portrait. Every test mocks the network; no live call.

**Vocabulary:** `no_lesson`, `maybe_lesson`, `fallback` (with a reason), as in S4. A set is `dev` or `heldout`.

**Read:** scripts/compass/probe.ts (whole: `readTrios`, `renderTable`, the stop rules); scripts/compass/census.ts (`censusFile`); scripts/compass/counter.ts (`RequestCounter`: constructor, `gateAttempt`, `exhausted`, `stopReason`, `snapshot`); scripts/compass/limits.ts (`parseLimits`, `LimitError`); scripts/compass/util.ts (`parseArgv`, `sha256File`, `sha256Text`, `findWorkspaceRoot`); scripts/compass/strings.ts (`confirmLimits`, `confirmLimitSource`); src/jev.ts (`buildGateState`, `callJev`, `routeGate`, `JEV_POLICY`, `JEV_POLICY_HASH`); knip.json. Test templates: tests/compass/limits-counter.test.ts, tests/jev.test.ts (mocked fetch and clock).

**Where and how (CC's plan):**

1. **scripts/compass/corpus.ts (new): `freeze`.** Usage: `corpus.ts --source <dir> [--source <dir> …] --output <dir> --seed <text>`. All flags required (P1). Offline: no network, no model, no write outside `--output`.
   - Refuse when a source is not a directory (P2) or `--output` already exists (P3). Never overwrite a frozen corpus.
   - For each source, take its `*.jsonl` files (not recursive), sorted by name. Copy each to `<output>/sessions/<source folder name>/<file name>` and check the copy's sha256 against the source.
   - **Session ID:** the `id` of the file's first entry with `type: "session"`; else the file name without `.jsonl`.
   - **Trios:** run `readTrios` (texts) and `censusFile` (line references) on the copy. If their counts differ, stop with P4 and delete nothing (the output stays for inspection).
   - **Split by session:** `set = parseInt(sha256Text(`${seed}\n${sessionId}`).slice(0, 8), 16) % 2 === 0 ? "dev" : "heldout"`. Every trio takes its session's set.
   - **Trio key:** the first 16 hex of `sha256Text(`${sessionId}\n${index}\n${agentBefore}\n${userFeedback}\n${agentAfter}`)`, with `index` 1-based within the file.
   - **Write** `<output>/trios.jsonl`, one line per trio in source, file, and index order: `{ key, set, sessionId, file, index, lines: { agentBefore, userFeedback, agentAfter }, chars: { agentBefore, userFeedback, agentAfter } }`, with `file` relative to `<output>`. Write `<output>/corpus.json`: `{ seed, createdAt, sources: [{ dir, files: [{ name, sha256, sessionId, set, trios }] }], totals: { sessions, trios, dev: { sessions, trios }, heldout: { sessions, trios } } }`. Last, write `<output>/freeze.json`: `{ "corpus.json": <sha256>, "trios.jsonl": <sha256> }`.
   - Print P5 and return 0.
2. **scripts/compass/score.ts (new).** Usage: `score.ts --corpus <dir> --set dev|heldout|all --run-type <t> --max-model-requests N --max-run-ms N --limits-source <s> [--concurrency N] [--output <dir>] [--confirmed]`.
   - **Checks before any request, in this order:** limits via `parseLimits` (its errors, exit 2); `--set` (P7, exit 2); `--concurrency`, default 4, an integer from 1 to 8 (P12, exit 2); `freeze.json` matches the sha256 of `corpus.json` and `trios.jsonl` (P6, exit 2); each selected trio's text, re-read from the frozen copy with `readTrios`, gives back its key (P6, exit 2).
   - **Cache:** `<corpus>/cache/gate-<JEV_POLICY_HASH>.jsonl`, append-only, one line per result: `{ key, verdict, answers, reason, model, attempts, latencyMs, usage }`. Read it first; a trio with a cached line makes no request and reports `cached: true`. Cache only `scored` results and `oversized_state` fallbacks. Every other fallback is left out, so a rerun tries it again.
   - **Run block:** print P8, using the existing `confirmLimits` and `confirmLimitSource` lines. Without `--confirmed`, print P9 and exit 2. Without `TYPESAFE_API_KEY`, print P10 and exit 2. Neither makes a request.
   - **Counting:** one `RequestCounter(limits)`. `beforeAttempt` is `() => counter.gateAttempt(JEV_POLICY.model)`. Each HTTP attempt counts once; a retry counts again.
   - **Concurrency:** a pool of `--concurrency` workers takes trios from one queue in corpus order. A worker starts a trio only while no stop is set. Rows are written in corpus order, whatever order they finish in.
   - **Stops** (the same rules as probe.ts): the counter declines (request limit or time limit); an `http_401` or `http_403` result; three failed requests in a row (fallbacks with `attempts > 0`), counted in completion order and reset by a scored result. After a stop, trios already running finish and are recorded; trios not started are `not_run`.
   - **Outputs**, default `<root>/outputs/s5/score-<set>-<timestamp>/`: `scores.jsonl` (one row per selected trio: `{ key, set, sessionId, index, verdict, answers, reason, model, attempts, latencyMs, usage, cached }`, with `verdict` one of `no_lesson`, `maybe_lesson`, `fallback`, `not_run`); `scores-table.md` (`renderTable` from probe.ts with one extra first column, the session file name; the trio column is the index within the file); `summary.json` (probe.ts summary fields plus `set`, `corpusFreeze` (the sha256 of `freeze.json`), `concurrency`, `cached`, `limits` with `source`, and `confirmed: true`). Print P13 for each trio as it finishes and P11 at the end.
   - **Exit codes:** 0 completed; 3 stopped by a limit; 4 stopped by an auth error or three failures; 2 refused before any request; 1 unexpected error.
3. **scripts/compass/strings.ts.** Add P1–P13 exactly as approved. No other user-facing text.
4. **knip.json.** Add both new scripts as entries, as probe.ts is.

**Edge cases to cover:** a session file without a `session` entry (the file name becomes the session ID); an empty session file (0 trios, still listed); two sources with the same file name (separate subfolders); a duplicate trio text in one file (different keys, because the index is in the key); `--set all`; a cache hit for every trio (no request is made, but the key check still runs first, so a run without a key is refused even when everything is cached); a corpus edited after the freeze (P6); a limit reached with 4 trios running (those 4 are recorded, the rest `not_run`, exit 3); an auth error mid-run (exit 4).

**Acceptance criteria:**

1. `freeze` copies, checks, and splits as above; the same seed and files always give the same sets and keys; no session has trios in both sets.
2. `score` refuses before any request on each P6, P7, P9, P10, P12 path and on a `parseLimits` error.
3. Requests are counted once per HTTP attempt, never exceed the limit, and stop the run as described; cached trios make no request.
4. Rows come out in corpus order with up to N requests in flight; the stop rules match probe.ts.
5. No output file contains the API key.
6. Existing tests pass.

**Tests** (tests/compass/corpus.test.ts and tests/compass/score.test.ts, new; write small session files into a temporary folder; mock `globalThis.fetch`, which fails by default; set and restore `TYPESAFE_API_KEY` per test): one test per acceptance criterion and per edge case; a concurrency test that proves at most N fetches are pending at once and rows stay in corpus order when responses arrive out of order; the key never appears in `scores.jsonl`, `summary.json`, `scores-table.md`, or the cache.

**Allowed scope:** scripts/compass/corpus.ts (new), scripts/compass/score.ts (new), scripts/compass/strings.ts, scripts/compass/types.ts, knip.json (entries only), tests/compass/corpus.test.ts (new), tests/compass/score.test.ts (new). probe.ts is imported, not modified.

**Constraints:** P1–P13 exactly as approved. No change to src/, to existing harness behavior, or to existing strings. Tests never read `~/.pi` and make no live request.

**Verification:**

```
npx vitest run --config vitest.compass.config.ts tests/compass/corpus.test.ts tests/compass/score.test.ts
npm run test:compass
npm test
```

### Protected text P1–P13 (approved by the user, 2026-10-16)

| ID | Where | Text |
|---|---|---|
| P1 | corpus: missing flags | `compass corpus: --source <dir> (one or more), --output <dir> and --seed <text> are required` |
| P2 | corpus: bad source | `compass corpus: ${dir} is not a directory` |
| P3 | corpus: output exists | `compass corpus: ${dir} already exists; a frozen corpus is never overwritten` |
| P4 | corpus: count mismatch | `compass corpus: ${file} has ${a} trios by the detector and ${b} by the census; nothing was frozen` |
| P5 | corpus: done | `Corpus frozen: ${sessions} sessions, ${trios} trios · dev ${devSessions} sessions / ${devTrios} trios · held-out ${heldSessions} sessions / ${heldTrios} trios → ${dir}` |
| P6 | score: corpus changed | `compass score: the corpus at ${dir} changed after it was frozen; no request was made` |
| P7 | score: bad set | `compass score: --set must be dev, heldout, or all` |
| P8 | score: run block | `compass score — Jev classifier only (no extraction, no building, no portrait)` / `Corpus: ${dir} · set ${set}: ${n} trios (${cached} cached, ${toScore} to score)` / *(existing limits and limit-source lines)* / `Jev model: ${model} · policy ${hash} · ${concurrency} at once` / `Output: ${dir}` |
| P9 | score: not confirmed | `Not confirmed: pass --confirmed after the user approves these values. No request was made.` |
| P10 | score: no key | `compass score: TYPESAFE_API_KEY is not set. No request was made.` |
| P11 | score: end | `Scored ${scored} · cached ${cached} · fallbacks ${fallbacks} · not run ${notRun} · requests ${requests} · stop: ${stop}` with `${stop}` one of `completed`, `request limit`, `time limit`, `auth error`, `three failed requests in a row` |
| P12 | score: bad concurrency | `compass score: --concurrency must be an integer from 1 to 8` |
| P13 | score: progress | `trio ${done}/${n}: ${verdict}` |

## CC review and gate (not for the coder)

Review per planner-prompt.md Step 2; ledger entry in md/ledger.jsonl. Check: no request before the checks pass; the counter is the only path to a request; cache rules (only scored and `oversized_state`); split is by session and seeded; rows in corpus order; P1–P13 byte-exact; no key in any artifact. Then CC runs the freeze on D1's two folders (offline) and reports the census before any live scoring.

Planner difficulty: S5-01 medium.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.1.0 | 2026-10-16 | S5-01 spec; P1–P13 approved by the user. |
