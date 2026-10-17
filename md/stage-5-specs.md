# Stage 5 — Task specs (Pi codes, Claude Code reviews)

Project: **pi-session-compass** · Revision: **0.8.0** · Status: **Approved (user, 2026-10-17)**

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

**Audit answers (CC, 2026-10-16; part of this spec; numbers refer to outputs/s5/handoff/S5-01-audit.md):**

1. **Blocker 1: as you propose.** corpus.ts collects every `--source` from its own argv; `parseArgv` stays as it is for the other flags.
2. **Blocker 2: as you propose.** probe.ts is not modified. score.ts builds probe-shaped rows with a local copy of the snippet rule (whitespace flattened, 90 characters, `…`), calls `renderTable`, and inserts the first column line by line: header cell `session`, separator `---`, the file name on each row.
3. **Risk 1 / Question 3: change the layout.** Copies go to `<output>/sessions/<n>-<source folder name>/<file name>`, with `n` the 1-based position of the source on the command line. No collision is possible, and no new string is needed.
4. **Risks 3–6: as you plan.** The first stop set wins and is reported; later results are still recorded. Create `<corpus>/cache` after P10 and before the first request. Tests always pass `--output`; score writes into the given folder and creates it. Put `CorpusSet` in types.ts and import it from both scripts.
5. **Noise 3: add `file`** (relative to the corpus) to each `scores.jsonl` row. All other Noise items: as you plan, including the zero-row test (13) and the determinism test (15).
6. **Question 1:** exit 2 for P1–P4 and the copy mismatch, 1 for an unexpected error.
7. **Question 2: option (a).** Reuse the existing `strings.frozenCopyMismatch`.
8. **Question 4: as you propose.** stderr for P1–P4, P6, P7, P10, P12 and the copy mismatch; stdout for P5, P8, P9, P11, P13.
9. **Question 5: verdict-based over all rows.** `scored + fallbacks + notRun` equals the selected rows; `cached` counts separately.
10. **Question 6:** drop `session` and add `corpus` (the absolute folder). `runType` is the given `--run-type`, `trios` is the number of selected rows, and `stop` uses P11's labels.
11. **Question 7: yes.** Exactly the four approved lines and the two existing ones, in the order `confirmLimits`, then `confirmLimitSource`, between the `Corpus:` and `Jev model:` lines, with no trailing blank line.
12. **Questions 8 and 9: as you plan.** A missing `freeze.json` or corpus file gives P6. P13 prints for every completed row, cached rows included.

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

## S5-02a — Extraction-only run, cached per trio

One new harness command, `extract.ts`, runs the production extractor on each trio of a frozen corpus set, several at a time, counted against run limits, and caches each result so a rerun never pays twice. No review, no building, no portrait. Every test mocks the model; no live call.

**Read:** scripts/compass/score.ts (whole: the checks, cache, worker pool, stop rules, outputs); scripts/compass/corpus.ts (`trioKey`); scripts/compass/pipeline-boot.ts lines 175–265 (settings snapshot, model runtime, model resolution, `wrapStreamFn`, attempt sink, `setCapturedModel`); scripts/compass/run.ts lines 1–30 and 215–230 (env isolation before any src import); scripts/compass/settings.ts (`captureSettingsSnapshot`); scripts/compass/counter.ts (`wrapStreamFn`, `refusedDuring`, `exhausted`, `stopReason`, `snapshot`); src/collector.ts lines 900–1020 (`callExtractionLlm`); src/llm-call.ts (`LlmAttemptEvent`, `setLlmAttemptSink`, `setCapturedModel`); src/work-state.ts (`EXTRACTION_POLICY_REVISION`). Test templates: tests/compass/score.test.ts, tests/compass/running-table.test.ts (mocked model calls).

**Where and how (CC's plan):**

1. **src/collector.ts: export `callExtractionLlm`.** Add `export` only; no other change.
2. **scripts/compass/model-boot.ts (new): the model setup, shared.** Move steps 2–4 of `runPipeline` (model runtime from `~/.pi/agent` auth and models files, model resolution with the existing `modelUnavailable` / `noModelOverride` errors, `wrapStreamFn` installed as the default stream function, `setCapturedModel`) into one exported function. `runPipeline` calls it; its behavior, strings, receipts, and tests stay exactly as they are. The attempt sink stays with each caller.
3. **scripts/compass/corpus-run.ts (new): what score and extract share.** Move from score.ts, without changing its behavior: the freeze check, the key re-read, the `--set` and `--concurrency` parsing, cache reading (tolerant of a cut last line) and appending, the worker pool (start only while no stop is set, rows in corpus order), and the not-run row. score.ts imports them; its tests pass unchanged.
4. **scripts/compass/extract.ts (new).** Usage: `extract.ts --corpus <dir> --set dev|heldout|all --run-type <t> --max-model-requests N --max-run-ms N --limits-source <s> [--concurrency N] [--output <dir>] [--confirmed]`.
   - **Env isolation first:** set `PI_PORTRAIT_STATE_DIR` to `<output>/portrait` (created empty) before any src import. All src imports are dynamic, as in run.ts.
   - **Checks before any request,** in score's order: limits, `--set`, `--concurrency`, freeze, key re-read. Then capture the settings snapshot to `<output>/settings-snapshot.json`, boot the model (model-boot.ts; an access error is printed as run.ts prints it, exit 1), and compute the **extractor revision**: the first 12 hex of `sha256Text(`${EXTRACTION_POLICY_REVISION}\n${provider}/${id}\n${thinkingLevel}`)`.
   - **Cache:** `<corpus>/cache/extract-<revision>.jsonl`, one line per successful extraction: `{ key, notes, attempts, usage: { input, output }, latencyMs }`. Read before the run block; a hit makes no request. Failed extractions are not cached.
   - **Run block:** P14, P15, the existing limit and limit-source lines, P16, then P8's `Output:` line. Without `--confirmed`, print P9 and exit 2. No request before confirmation.
   - **Per trio:** `callExtractionLlm(trio, 0)` (dumps off). A `PAUSED` throw or a `failed` outcome makes the row `failed`. Attribute attempts and usage to the trio through an `AsyncLocalStorage` store, set around each call and read by the attempt sink, so concurrent trios never mix. A trio's `latencyMs` runs from its start to its finish.
   - **Stops:** the counter's ceiling (`request limit` / `time limit`, as in score); three failed extractions in a row in completion order, reset by a success (`three failed extractions in a row`). The first stop wins; running trios finish and are recorded; the rest are `not_run`.
   - **Outputs**, default `<root>/outputs/s5/extract-<set>-<timestamp>/`: `extract.jsonl` (one row per selected trio in corpus order: `{ key, set, sessionId, file, index, outcome, notes, attempts, usage, latencyMs, cached }`, with `outcome` one of `success`, `failed`, `not_run`; `notes` is `[]` unless `success`); `summary.json` (`runType`, `corpus`, `set`, `corpusFreeze`, `limits` with `source`, `confirmed: true`, `concurrency`, `model`, `thinkingLevel`, `revision`, `postExtractionEnabled` from the snapshot (recorded only; review never runs), `trios`, `cached`, `outcomes` counts, `requests`, `elapsedMs`, usage totals for this run's requests, `stop`). P17 per finished trio, P18 at the end. Exit codes as in score: 0, 3 (limit), 4 (three failures), 2 (refused), 1 (unexpected).
5. **scripts/compass/strings.ts:** P14–P18 exactly as approved. **knip.json:** add extract.ts as an entry.

**Edge cases to cover:** a cache hit for every trio (no request, model still booted, P15 shows them cached); a failed extraction (row `failed`, not cached, a rerun tries it again); two trios in flight whose attempts interleave (each row gets only its own usage); a limit reached with trios in flight; three failures in a row (exit 4); `postExtractionEnabled: true` in the snapshot (recorded, no review call).

**Acceptance criteria:**

1. `runPipeline` behaves as before (all existing compass tests pass unchanged), and score.ts behaves as before (its tests pass unchanged).
2. extract refuses before any request on each check, and without `--confirmed`.
3. Every model request passes the counter; requests never exceed the limit; cached trios make no request.
4. Rows come out in corpus order with up to N trios in flight; per-trio usage and attempts are exact under concurrency.
5. No change in src/ beyond the one `export`.

**Tests** (tests/compass/extract.test.ts, new): mock the model layer as running-table.test.ts does, with controllable per-call delays and usage; one test per acceptance criterion and per edge case.

**Allowed scope:** src/collector.ts (the `export` keyword only), scripts/compass/model-boot.ts (new), scripts/compass/corpus-run.ts (new), scripts/compass/extract.ts (new), scripts/compass/score.ts (moving shared code out only), scripts/compass/pipeline-boot.ts (calling model-boot only), scripts/compass/strings.ts, scripts/compass/types.ts, knip.json (entries only), tests/compass/extract.test.ts (new).

**Constraints:** P14–P18 exactly as approved; no other new user-facing text. Existing strings, receipts, and exit codes unchanged. Tests never read `~/.pi` and make no live request.

**Verification:**

```
npx vitest run --config vitest.compass.config.ts tests/compass/extract.test.ts tests/compass/score.test.ts
npm run test:compass
npm test
```

**Audit answers (CC, 2026-10-16; part of this spec; numbers refer to outputs/s5/handoff/S5-02a-audit.md):**

1. **Question 1: option (a).** extract prints P6, P7, and P12 verbatim for the shared checks, `compass score:` prefix included; the shared code takes the message from its caller or returns a result the caller prints. A missing `--corpus` keeps the P6 fall-through, as in score.
2. **Question 2:** the model access error prints `compass harness: ${accessError}` on stderr and exits 1, as `runPipeline` does.
3. **Question 3:** `summary.usage` is the counter snapshot's `usageTotals`.
4. **Question 4:** a `failed` row keeps the attempts and usage its own calls consumed.
5. **Question 5:** yes, `Extracted` counts cached successes, as P11 does.
6. **Question 6:** yes. Install the diagnostics sink as `runPipeline` does, writing to `<output>/diagnostics.log`; existing message text only.
7. **Risks 1–9 and Noise 1–13: as you plan.** In particular: `bootModel` returns the model or an error and `runPipeline` keeps its receipt, stderr, and exit lines where they are (Risk 1); move score code verbatim (Risk 2); drop an attempt event with no store (Risk 3); dynamic imports after isolation (Risk 4); mock `scripts/compass/settings.js` in extract.test so no test reads `~/.pi` (Risk 5); `retries: 0` and `timeoutMs: null` in the test snapshot (Risk 6); failing streams reject inside `result()` (Risk 8); P17 prints `1 rules` verbatim (Noise 5).

## S5-02b — Label sheet and offline policy scorer

Two offline commands. `labels.ts` writes a readable sheet of trios to label or check, and validates a labels file. `evaluate.ts` scores a candidate gate policy against the labels and sweeps thresholds on the development set. No network, no model.

**Read:** scripts/compass/corpus-run.ts and score.ts (row formats); scripts/compass/extract.ts (row format); scripts/compass/corpus.ts (`trios.jsonl` format); scripts/compass/util.ts; src/jev.ts (`JEV_POLICY`, `routeGate`, for the shipped rule). Test template: tests/compass/score.test.ts.

**Labels file** (`labels-<set>.jsonl`, written by CC): one line per trio, `{ key, label, correction, source, note }`. `label` is `lesson` or `no_lesson`; `correction` is a boolean; `source` is `cc-draft`, `cc-draft-user-checked`, or `user`; `note` is a string (may be empty).

**Where and how (CC's plan):**

1. **scripts/compass/labels.ts (new), `export`.** Usage: `labels.ts export --corpus <dir> --set dev|heldout --scores <scores.jsonl> --extract <extract.jsonl> [--labels <labels.jsonl>] --select all|review --seed <text> --output <file.md>`.
   - `all`: every trio of the set. `review` (needs `--labels`, else P27): every trio labeled `no_lesson`, every disagreement (labeled `lesson` with 0 extractor rules, or `no_lesson` with ≥ 1 rule), and a seeded 10% sample of the rest (the first `ceil(n / 10)` by `sha256Text(`${seed}\n${key}`)` order).
   - Sheet: P20, then per trio in corpus order: P21, P22, P23 plus one `  - ${rule}` line per rule, P24, then P25's three labeled blocks: the last 800 characters of agent before, the whole user reply, the first 800 characters of agent after, each in a fenced block.
2. **labels.ts `check`.** Usage: `labels.ts check --corpus <dir> --set dev|heldout --labels <labels.jsonl>`. Every key of the set appears exactly once, no key outside the set, every field valid. Each problem prints P26 to stderr (all problems, then exit 2). On success print P26's summary line (with the file's sha256) and exit 0.
3. **scripts/compass/evaluate.ts (new), `policy`.** Usage: `evaluate.ts policy --corpus <dir> --set dev|heldout --labels <l> --scores <s> --extract <e> --policy <policy.json> [--output <dir>]`. A policy file is `{ name, questions: [<ids>], thresholds: { <id>: number } }` (P33 when invalid). A trio is **rejected** when it was scored and every listed question's answer is ≤ its threshold; a fallback or unscored trio is never rejected. Report (P29, plus `evaluate.json` with every count, the rejected keys, and the missed `lesson` and correction keys): rejected of total; `lesson` trios kept of all `lesson` trios; correction misses (rejected trios labeled `correction: true`); the miss-rate bound `3 / (lesson trios)` when there are no misses, else the observed rate; extraction saved (the rejected trios' requests and tokens from `extract.jsonl`); gate cost (all scored trios' Jev tokens).
4. **evaluate.ts `sweep`.** Usage: `evaluate.ts sweep --corpus <dir> --set dev --labels <l> --scores <s> --extract <e> [--output <dir>]`. Refuses any set but `dev` (P28, exit 2). Rules: `all four` and `without steering`, thresholds 0.05 to 0.50 in steps of 0.05. Writes `sweep.md`: P30's header and one row per rule and threshold (rejected, lesson kept with percent, correction misses), plus `sweep.json`.
5. **Inputs must agree:** every key in the labels, scores, and extract files belongs to the corpus set given, and the scores and extract files cover the whole set (P26 problem lines, exit 2).
6. **scripts/compass/strings.ts:** P19–P33 exactly as approved. **knip.json:** add both commands as entries.

**Acceptance criteria:**

1. `review` selection is deterministic for a seed and includes every `no_lesson` label and every disagreement.
2. `check` reports every problem in one run.
3. The policy counts match a hand-computed example (tests with a small fixture of labels, scores, and extract rows), including fallbacks never rejected and the bound.
4. `sweep` refuses `heldout`.
5. No network access (tests stub `fetch` to fail), and no write outside `--output`.

**Tests** (tests/compass/labels.test.ts and tests/compass/evaluate.test.ts, new): one per acceptance criterion and each P26 problem kind.

**Allowed scope:** scripts/compass/labels.ts (new), scripts/compass/evaluate.ts (new), scripts/compass/strings.ts, scripts/compass/types.ts, knip.json (entries only), tests/compass/labels.test.ts (new), tests/compass/evaluate.test.ts (new).

**Constraints:** P19–P33 exactly as approved; no other new text. No change to src/ or to existing harness behavior.

**Verification:**

```
npx vitest run --config vitest.compass.config.ts tests/compass/labels.test.ts tests/compass/evaluate.test.ts
npm run test:compass
npm test
```

**Audit answers (CC, 2026-10-17; part of this spec; numbers refer to outputs/s5/handoff/S5-02b-audit.md):**

1. **Question 1: option (a), one new string P40** (`compass ${tool}: --set must be dev or heldout`, with `${tool}` `labels` or `evaluate`), exit 2. `labels` and `evaluate policy` accept only `dev` and `heldout`; `sweep` keeps P28.
2. **Question 2: your split.** P26 belongs to `labels check` only. Every item-5 agreement failure in `labels export`, `evaluate policy`, and `evaluate sweep` prints P32 once per offending file, exit 2.
3. **Question 3: as you propose.** A policy's ids come from the gate's four; a threshold for every listed id, in [0, 1]; nothing unlisted; otherwise P33, exit 2.
4. **Questions 4–9: your defaults.** `${n}` counts all trios of the set; `${pct}` is the rounded integer percent; `${bound}` is `3 / ${K}` with no misses, else `${m} / ${K}`; every command validates the files it reads; only a `success` row with no notes counts as 0 rules; `evaluate` defaults its output to `outputs/s5/<command>-<set>-<timestamp>`; a missing or unparseable input file prints P32.
5. **Risks 1–7 and Noise 1–12: as you plan.** Reuse `loadSelected` (score's text on a tampered corpus is accepted, as in extract); the P30 table gets a separator row; four-backtick fences; exit 2 for every refusal.

### Protected text P14–P33 (approved by the user, 2026-10-16)

| ID | Where | Text |
|---|---|---|
| P14 | extract: header | `compass extract — extraction only (no review, no building, no portrait)` |
| P15 | extract: corpus line | `Corpus: ${dir} · set ${set}: ${n} trios (${cached} cached, ${toRun} to extract)` |
| P16 | extract: model line | `Extractor: ${provider}/${id} · thinking ${thinking} · revision ${revision} · ${concurrency} at once` |
| P17 | extract: progress | `trio ${done}/${n}: ${rules} rules` or `trio ${done}/${n}: failed` |
| P18 | extract: end | `Extracted ${ok} · cached ${cached} · failed ${failed} · not run ${notRun} · requests ${requests} · stop: ${stop}` with `${stop}` one of `completed`, `request limit`, `time limit`, `three failed extractions in a row` |
| P19 | labels/evaluate: missing flag | `compass ${tool}: ${flag} is required` |
| P20 | sheet title | `# Label sheet — ${set}, ${n} trios (${selection})` |
| P21 | sheet entry header | `## ${file} · trio ${index} · ${key}` |
| P22 | sheet Jev line | `Jev: correction ${c}, preference ${p}, steering ${s}, confusion ${f}` (two decimals), or `Jev: fallback (${reason})`, or `Jev: not scored` |
| P23 | sheet extractor line | `Extractor: ${n} rules`, or `Extractor: failed`, or `Extractor: not run` |
| P24 | sheet label line | `Label: ${label} · correction ${yes\|no} · ${source}`, plus ` · ${note}` when the note is not empty, or `Label: (none)` |
| P25 | sheet text blocks | `Agent before (last 800 characters):` / `User reply:` / `Agent after (first 800 characters):` |
| P26 | labels: problems and summary | `compass labels: ${key} ${problem}` with `${problem}` one of `is missing`, `appears more than once`, `is not in set ${set}`, `has an invalid field: ${field}`; summary `Labels ${set}: ${n} trios · lesson ${l} · no_lesson ${nl} · corrections ${c} · sha256 ${sha}` |
| P27 | labels: review without labels | `compass labels: --select review needs --labels` |
| P28 | evaluate: sweep on held-out | `compass evaluate: the threshold sweep runs on dev only` |
| P29 | evaluate: policy report | `Policy ${name} on ${set}: rejected ${r} of ${n} · lesson kept ${k} of ${K} (${pct}%) · correction misses ${m} · miss bound ${bound} · extraction saved ${req} requests, ${in} in / ${out} out tokens · gate cost ${gin} in / ${gout} out tokens` |
| P30 | evaluate: sweep table header | `\| rule \| threshold \| rejected \| lesson kept \| correction misses \|` with rule names `all four` and `without steering` |
| P31 | labels: bad selection | `compass labels: --select must be all or review` |
| P32 | labels/evaluate: input mismatch | `compass ${tool}: ${file} does not cover set ${set} of ${corpus}` |
| P33 | evaluate: bad policy | `compass evaluate: ${file} is not a valid policy` |
| P40 | labels/evaluate: bad set *(approved by the user, 2026-10-17)* | `compass ${tool}: --set must be dev or heldout` |

## S5-02c — Reply codes: a second Jev question set, tallied

`score.ts` learns to send a question set read from a file instead of the gate's four questions, and to tally the answers per folder and session. The gate, `GATE_CONFIG`, its policy hash, and the plugin do not change. Every test mocks the network.

**Read:** scripts/compass/score.ts and scripts/compass/corpus-run.ts (whole); src/jev.ts (`JevPolicy`, `JevQuestion`, `callJev`'s answer validation, which iterates the policy's question ids); scripts/compass/strings.ts (P1–P18). Test template: tests/compass/score.test.ts.

**Question set file:** `{ "name": string, "questions": { <id>: { "type": "noul", "instructions": string, "criteria": { "true": string, "false": string } } } }`, 1 to 8 questions, ids matching `^[a-z_]{1,32}$`. Anything else gives P34, exit 2, before any request. The approved set is checked in as `scripts/compass/questions/reply-codes-v1.json` (texts R1–R5 below, each `instructions` = the gate's prefix `In this exchange between a user and an AI coding agent, ` + the question).

**Where and how (CC's plan):**

1. **score.ts `--questions <file>` (optional).** Without it, nothing changes. With it:
   - The policy sent is `JEV_POLICY` with `questions` replaced by the file's (a harness-side object; src/ unchanged). Its hash is the first 12 hex of `sha256Text(JSON.stringify({ model, name, questions }))`.
   - Cache: `<corpus>/cache/questions-<hash>.jsonl`, same rules as the gate cache (only scored results and `oversized_state`).
   - Rows: `verdict` is `scored`, `fallback`, or `not_run` (no gate routing); `answers` keyed by the set's ids.
   - The run block prints P35 in place of P8's `Jev model:` line. `scores-table.md` is not written (its columns are the gate's); `codes.md` is written instead (item 2). `summary.json` adds `questionSet: { name, hash, file }`.
   - Stops, counting, concurrency, exit codes, P9–P13: unchanged.
2. **`codes.md`** (written by score.ts with `--questions`): P36; then P37's table with one row per session (`folder` = the source folder name without its number prefix, `session` = file name, `trios` = scored rows) and one cell per question id: the count of scored rows whose answer is ≥ 0.50; then a P38 row with the totals per folder and one for all rows. Then for each question id, P39's heading and up to 10 rows with the highest answers ≥ 0.50, as P39 lines (reply snippet: whitespace flattened, 90 characters, `…`, as in scores-table).
3. **strings.ts:** P34–P39 exactly as approved. **New file** `scripts/compass/questions/reply-codes-v1.json` with R1–R5 exactly as approved.

**Acceptance criteria:**

1. Without `--questions`, score's output is byte-identical to today (existing tests pass unchanged).
2. With `--questions`, the request body carries exactly the file's questions; the cache file name uses the set's hash, never the gate's.
3. An invalid set file refuses before any request (P34).
4. `codes.md` counts match a hand-computed fixture.

**Tests:** extend tests/compass/score.test.ts (new `describe`), mocked fetch; criteria 1–4.

**Allowed scope:** scripts/compass/score.ts, scripts/compass/corpus-run.ts (only if a shared helper needs a parameter), scripts/compass/strings.ts, scripts/compass/questions/reply-codes-v1.json (new), tests/compass/score.test.ts (new `describe` only), knip.json (only if needed).

**Constraints:** P34–P39 and R1–R5 exactly as approved. No change to src/ or to score's behavior without `--questions`.

**Verification:**

```
npx vitest run --config vitest.compass.config.ts tests/compass/score.test.ts
npm run test:compass
npm test
```

**Audit answers (CC, 2026-10-17; part of this spec; numbers refer to outputs/s5/handoff/S5-02c-audit.md):**

1. **Blockers 1–2: your resolutions.** Add `scored` to `Verdict`; P11's first count adds `verdicts.scored ?? 0`; the gate cache keeps its four verdicts and the question cache gets its own validator (`scored`, `fallback`); a `scored` row resets the failure streak. Gate-mode output stays byte-identical.
2. **Question 1: P34 before the freeze and key checks**, as you propose.
3. **Questions 2–4: your defaults.** `${set}` is the literal `--set` value; `${n}` counts `scored` rows, cached included; a session with no scored rows keeps its row with `trios` 0; a missing, unreadable, or non-JSON file prints P34.
4. **Question 5: your rules, but strict.** Unknown keys, at the top level or in a question, print P34; the file means exactly what it says.
5. **Risks 1–5 and Noise 1–10: as you plan.** `summary.json.policyHash` stays the gate's hash beside `questionSet.hash`; codes.md gets a separator row under P37.

### Protected text R1–R5 and P34–P39 (approved by the user, 2026-10-17)

**R — reply-code questions** (`reply-codes-v1`; each `instructions` is the gate's prefix + the question):

| ID | Question (after the prefix) | `criteria.true` | `criteria.false` |
|---|---|---|---|
| R1 `approval` | is the user's reply only approving, confirming, or choosing among options the agent offered? | The user says go, yes, or ok, or picks an option the agent offered, and adds nothing else. | The user adds an instruction, a correction, a question, or a preference. |
| R2 `correction` | does the user's reply correct or push back on something the agent said or did? | The user says the agent got something wrong (code, a claim, an assumption), missed something, or did something the user did not want. | The user accepts the work, moves on, or asks something new without saying the agent got anything wrong. |
| R3 `hold_back` | does the user's reply hold the agent back because it acted, or was about to act, before the user agreed? | The user tells the agent to stop, wait, not act yet, or undo something it did without being asked. | The user does not hold the agent back. |
| R4 `task_step` | does the user's reply give the agent a new task or next step? | The user asks for something to be done next: a command to run, a file to read or write, an analysis, or a question to answer. | The reply only approves, corrects, holds the agent back, or chats. |
| R5 `chatter` | is the user's reply off-task? | Small talk, thanks, venting, or remarks unrelated to the work. | The reply is about the task. |

R2 is the gate's approved `correction` question, unchanged.

**P — harness strings:**

| ID | Where | Text |
|---|---|---|
| P34 | score: bad question set | `compass score: ${file} is not a valid question set` |
| P35 | score: model line with a question set | `Jev model: ${model} · questions ${name} (${hash}) · ${concurrency} at once` |
| P36 | codes.md title | `# Reply codes — ${name}, set ${set}, ${n} scored trios (an answer ≥ 0.50 counts as yes)` |
| P37 | codes.md table header | `\| folder \| session \| trios \| ${id} \| … \|` (one column per question id, in file order) |
| P38 | codes.md total rows | session cell `all` for a folder total; folder and session cells `all` for the grand total |
| P39 | codes.md examples | heading `## ${id}: top replies`; lines `- ${answer} · ${session} trio ${index} · ${reply}` |

## S5-04a — The gate decides on the tuned questions and threshold

The shipped gate adopts the policy tuned on dev and tested once on held-out: a scored trio is `no_lesson` when its `correction`, `preference`, and `confusion` answers are each at or below 0.30. `steering` is still asked, returned, and recorded, but no longer decides. The request body does not change. Every test mocks the network.

**Read:** src/gate-config.ts (whole); src/jev.ts (`JevPolicy`, `JEV_POLICY`, `JEV_POLICY_HASH`, `routeGate`); src/gate.ts (the `routeGate` call); scripts/compass/score.ts (gate-mode verdict and cache name); tests/jev.test.ts (policy, hash, and `routeGate` tests). Hash literal `ad7880acdc3b` appears in tests/compass/*.test.ts and tests/gate.test.ts.

**Where and how (CC's plan):**

1. **src/gate-config.ts.** `GateConfig` gains `routeQuestions: readonly QuestionId[]`, placed right after `threshold`, commented: the answers that decide a skip; a scored trio carries no lesson when each of them is at or below the threshold, and the other questions are still asked and recorded. Value `["correction", "preference", "confusion"]`. `threshold` becomes `0.3`, its comment updated to say it applies to the routing answers. Frozen with the rest.
2. **src/jev.ts.** `JevPolicy` gains `routeQuestions`; `JEV_POLICY` copies it. `JEV_POLICY_HASH` covers `{ model, threshold, routeQuestions, stateCapBytes, questions }` in that order. `routeGate` returns `no_lesson` only when every id in `policy.routeQuestions` has an answer at or below `policy.threshold`; an id with no answer gives `maybe_lesson`.
3. **Hash literals.** Where a test compares with the live `JEV_POLICY_HASH` (or a cache file name derived from it), update it to the new value. Where `ad7880acdc3b` is only an opaque fixture string (a receipt or confirmation text built from a literal), leave it. List each file and which case it was under `Done`.

**Acceptance criteria:**

1. `GATE_CONFIG.threshold` is 0.3 and `GATE_CONFIG.routeQuestions` is the three ids above, both frozen.
2. `routeGate`, table-driven: `steering` 0.90 with the other three ≤ 0.30 gives `no_lesson`; any routing answer 0.31 gives `maybe_lesson`; a routing answer of exactly 0.30 gives `no_lesson`; a missing routing answer gives `maybe_lesson`; a fallback is never `no_lesson`.
3. The hash covers `routeQuestions`: the existing expected-hash test recomputes it from the field list in item 2, and the new literal is pinned in tests/jev.test.ts.
4. The request body still carries all four questions unchanged (an existing or new body assertion).
5. No user-facing string changes.

**Allowed scope:** src/gate-config.ts, src/jev.ts, tests/jev.test.ts, tests/gate.test.ts (adapt only), tests/compass/*.test.ts (hash literal only, item 3).

**Constraints:** no change to the questions, model, endpoint, state cap, deadline, retry, failure limit, or modes; no new user-facing text.

**Verification:**

```
npx vitest run tests/jev.test.ts tests/gate.test.ts
npm run test:compass
npm test
```

## CC review and gate (not for the coder)

Review per planner-prompt.md Step 2; ledger entry in md/ledger.jsonl. Check: no request before the checks pass; the counter is the only path to a request; cache rules (only scored and `oversized_state`); split is by session and seeded; rows in corpus order; P1–P13 byte-exact; no key in any artifact. Then CC runs the freeze on D1's two folders (offline) and reports the census before any live scoring.

Planner difficulty: S5-01 medium; S5-02a medium-high (model-boot move, concurrency attribution); S5-02b medium; S5-02c easy; S5-04a easy.

S5-02a review: `runPipeline` unchanged; one `export` in src; usage attributed per trio under concurrency. S5-02b review: review selection, counts by hand on the fixture, sweep refuses held-out.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.6.0 | 2026-10-17 | S5-02b audit answers; P40 approved by the user. |
| 0.7.0 | 2026-10-17 | S5-02c audit answers (scored verdict, streak reset, strict set file). |
| 0.8.0 | 2026-10-17 | S5-04a spec: the gate decides on correction, preference, and confusion at 0.30 (user chose option a). |
