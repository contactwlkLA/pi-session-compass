# Stage 7 — Task specs (Pi codes, Claude Code reviews)

Project: **pi-session-compass** · Revision: **0.5.0** · Status: **Ready (stage-7-task.md approved by the user, 2026-10-17)**

Date: **2026-10-18**

Parent: [stage-7-task.md](stage-7-task.md) (fixed design 1–3).

**Coder rules, spec audit, and handoff format:** [stage-3b.md](stage-3b.md), section "Coder rules", unchanged, except that the audit and handoff go to `outputs/s7/handoff/<task_id>-audit.md` and `outputs/s7/handoff/<task_id>-r<round>.md`. Do not touch `~/.pi`: every test uses the temporary portrait dir from tests/setup.ts.

## S7-01 — Quick fixes

Six independent small bugs from md/bugs.md. Fix each with a test; change nothing else. One string changes (item 4, user-approved); no other user-facing string is added or changed.

**Read:** md/bugs.md rows B11, B13, B14, B15, B20, B21; scripts/compass/pipeline-boot.ts (`onBuild` and the results-sheet builder lines, around 245–260 and 560–570); src/instrument.ts (`BuildEvent`); src/builder.ts (`emitBuild` call around line 155, `resolveCandidateText` around line 182); scripts/compass/snapshot.ts (`verifySnapshot`); scripts/compass/strings.ts (`startSnapshot*`, `confirmLimits`); scripts/compass/types.ts (`RUN_TYPES`); md/compass.md (run-type table); tests/reload-lifecycle.test.ts (`fakeCtx`); src/index.ts (the `session_start` handler, line ~326: it returns unless `ctx.mode === "tui"` and `PI_SUBAGENT_PARENT_PID` is unset); scripts/compass/evaluate.ts (`Counts`, `missBound`); the matching tests in tests/compass/ (strings, start-snapshot, gate-harness or running-table for the sheet, limits-counter, evaluate).

**Where and how (CC's plan):**

1. **B11 — sheet shows the rule text for inserts.** `BuildEvent` decisions gain an optional `candidateText` (the candidate's text, resolved in src/builder.ts with the existing `resolveCandidateText(d.candidate, candidates)` when the decision names a candidate and the ID resolves). This is instrumentation only: nothing else in building reads it. In the sheet builder, the label becomes `decision.text ?? decision.candidateText ?? decision.candidate ?? strings.sheetNoText`. A merge keeps its merged `text`; a skip shows the candidate's text.
2. **B13 — corrupt hashes.json.** In `verifySnapshot`, wrap the `JSON.parse` of hashes.json; on a parse error, or a parsed value that is not an object of string values, throw `new SnapshotError(strings.startSnapshotMismatch("hashes.json", dir))`. The caller's existing refusal path (message, exit code, no model request) handles it unchanged.
3. **B14 — `probe` run type.** Add `"probe"` to `RUN_TYPES` in compass.md table order (`smoke`, `baseline`, `compare`, `probe`, `evaluate`, `collect`). Its limits stay UNSET (no stored suggestion), like `baseline`.
4. **B15 — rounded minutes (approved text).** `confirmLimits` prints minutes rounded to one decimal, with no trailing `.0`: `Math.round(runMs / 6000) / 10`. Approved before/after: `Limits: 100 model requests · 100000 ms (1.6666666666666667 min) wall clock` → `Limits: 100 model requests · 100000 ms (1.7 min) wall clock`. Unchanged: `900000 ms (15 min)`, `90000 ms (1.5 min)`, `5400000 ms (90 min)`.
5. **B20 — the reload test holds the lock.** Give `fakeCtx` in tests/reload-lifecycle.test.ts `mode: "tui"` and make sure `PI_SUBAGENT_PARENT_PID` is unset for the test (restore it after), so `acquireLock()` runs. Add an assertion that the lock is held after `session_start` and released after `session_shutdown`. **If the test then fails, do not change src/: stop, report the failure under `Not done`, and write the handoff.**
6. **B21 — correction-miss bound.** `missBound` divides by `counts.correctionTrios`, not `counts.lessonTrios` (`3 / ${correctionTrios}` with no misses, `${misses} / ${correctionTrios}` otherwise). The report line text is otherwise unchanged.

**Acceptance criteria:**

1. B11: a sheet test with one build of an insert (no `text`), a merge (with `text`), and a skip shows the insert's and the skip's candidate text and the merge's text; an unresolvable candidate ID still shows the ID.
2. B13: a start snapshot whose hashes.json is `{not json` and one whose hashes.json is `[1,2]` are both refused with the `startSnapshotMismatch` text naming `hashes.json`, the existing exit code, and no model request; no stack trace on stderr.
3. B14: `parseLimits` (or the run-type parser) accepts `--run-type probe`; its stored suggestion is UNSET; the existing run-type tests still pass.
4. B15: `confirmLimits(100, 100_000)` gives the approved after-text; the existing A1 expectations (`15 min`, `1.5 min`) and a `5_400_000` case (`90 min`) pass.
5. B20: the reload test asserts the lock is held after `session_start` and released after `session_shutdown`, and passes — or the handoff reports its failure as stated in item 5.
6. B21: the held-out-shaped fixture with 4 lesson trios of which 2 carry `correction: true` and no misses reports `3 / 2`; with one miss, `1 / 2`. Update the existing evaluate test expectations (`1 / 4`, `3 / 4`) only if their fixtures' correction count differs from their lesson count, and list each under `Done`.
7. No other user-facing string added or changed; no change to gate, extraction, building decisions, snapshots, or scan behavior.

**Audit answers (CC, 2026-10-17; part of this spec; numbers refer to outputs/s7/handoff/S7-01-audit.md):**

1. **Question 1: option (b).** Add tests/builder.test.ts to the allowed scope for one test that drives `buildPortrait` with the existing LLM mock and asserts the emitted event: an insert of `C1` carries `candidateText`, an unresolvable `C9` carries none.
2. **Noise (B11): as you plan.** Add `candidateText?: string` to `BuildRecord.decisions` in pipeline-boot.ts; spread `candidateText` only when it resolves.
3. **Risk (B13): yes.** Reject arrays and any non-string value (`Array.isArray`, per-value `typeof === "string"`); `{}` stays as it is.
4. **Noise (B21): as you read it.** Use the existing dev fixture; update its expectations to `1 / 2` and `3 / 2` and list them under `Done`.
5. **Risks (B20) and the rest: as you plan.** Assert "held" between `session_start` and `session_shutdown`, and "released" with `tryAcquireSqliteMutex` after shutdown; delete and restore `PI_SUBAGENT_PARENT_PID`. Half-minute rounding (`105000 ms` → `1.8 min`) is fine; note it in the handoff.

**Allowed scope:** src/instrument.ts, src/builder.ts (the `emitBuild` call only), scripts/compass/pipeline-boot.ts, scripts/compass/snapshot.ts, scripts/compass/strings.ts (`confirmLimits` only), scripts/compass/types.ts, scripts/compass/evaluate.ts, tests/reload-lifecycle.test.ts, tests/builder.test.ts (one added test, audit answer 1), and the tests/compass/*.test.ts files that cover these (adapt or add; list each).

**Constraints:** no change to md/compass.md; no new setting; no new dependency.

**Verification:**

```
npx vitest run tests/reload-lifecycle.test.ts
npx vitest run --config vitest.compass.config.ts
npm test
npm run test:compass
```

## S7-02 — Text batch (user-approved text)

Apply the user-approved text below exactly, byte for byte. Nothing else changes. Every string here was approved by the user on 2026-10-17; do not reword any of it.

**Read:** src/schema.ts (`buildingBatchSize`, `debugDumpLimit`, `maintenanceBackfillBatchSize` descriptions); src/prompts.ts (lines 111 and 133); src/commands/status.ts (`getStatus`); src/work-state.ts (`loadWorkState`); src/gate-log.ts (`GATE_LOG_FILE`); README.md ("Recovery"); docs/CONFIGURATION.md; tests that assert these strings (grep for each before-text).

**Changes:**

1. **src/schema.ts descriptions** (before → after):
   - `debugDumpLimit`: `Maximum debug dump files kept under <cwd>/.pi/portrait/debug/ (0 = no dumps).` → `Maximum debug dump files kept under ~/.pi/portrait/debug/ (0 = no dumps).`
   - `buildingBatchSize`: `How many extraction trios to process per building LLM call.` → `How many extracted candidates to process per building LLM call.`
   - `maintenanceBackfillBatchSize`: `How many rules to re-evaluate per maintenance backfill LLM call.` → `How many evicted rules to re-evaluate per maintenance backfill LLM call.`
2. **src/prompts.ts:** delete the text ` <!-- approved -->` (leading space included) at the end of lines 111 and 133. No other prompt character changes.
3. **src/commands/status.ts, `getStatus`:** two new lines.
   - Right after the `State: …` line: `Gate: ${settings.gateMode} · ${n} checks logged`, where `n` is the number of lines in `path.join(portraitDir, GATE_LOG_FILE)`; `0` when the file is missing or unreadable (never throw).
   - Right after the `  Rule limit: …` line: `  Pending candidates: ${loadWorkState(portraitDir).pendingCandidates.length}`; if `loadWorkState` throws, `  Pending candidates: unknown (snapshot unreadable)`.
4. **README.md, section "Recovery":** append this paragraph after the existing last paragraph of the section:

   ```
   Before downgrading to an older version of the plugin, run `/portrait:collect` until `/portrait:status` shows no pending candidates: older versions keep the scan position but do not build pending candidates.
   ```
5. **docs/CONFIGURATION.md:** none of its rows change (they already say "extracted candidates" and "evicted rules"); check and report.
6. **New file scripts/compass/README.md**, exactly:

````
# compass harness

Development harness for measured runs of the portrait pipeline on one selected session file. It is not part of the plugin package.

## Select a file and an output directory

```bash
node_modules/.bin/jiti scripts/compass/run.ts prepare --session <file.jsonl> --output outputs/<run>
```

`prepare` validates and hashes the file, freezes a copy under `fixtures/sessions/`, copies it into `<output>/sessions/`, counts its trios (`census.json`), and records the selection (`selection.json`, `manifest.json`). It makes no model request. Without `--output`, the run goes to `outputs/<run-id>`. `--scope all` scans your real session folders instead of one isolated file; use it only when you mean to.

## Run

```bash
node_modules/.bin/jiti scripts/compass/run.ts execute --session <file.jsonl> --output outputs/<run> \
  --run-type <type> --max-model-requests <n> --max-run-ms <ms> --limits-source <source> \
  [--start-snapshot <dir>] [--gate-mode off|shadow|enforce] [--confirmed]
```

`execute` prepares the run the same way, then runs the pipeline on the isolated copy. Portrait state lives in `<output>/portrait/`, and the live `~/.pi/portrait` is never written. Before the first model request it shows the run type, limits, file, trio count, and output directory, and it stops when either limit is reached. Without `--confirmed` it asks on a terminal and refuses when it is not on one.

## Inspect the selected paths

`selection.json` names the source file, its frozen copy, and its sha256. `manifest.json` adds the limits and their source, the start snapshot, and the source commit. Results: `receipt.json`, `traces.jsonl`, `running-table.md`, `results-sheet.md`, and `portrait/gate-log.jsonl` when the gate is on.

## Rescan

Each run starts from its own output directory, so a rescan is a new `execute` with a new `--output`. Pass `--start-snapshot <dir>` to start every run from the same frozen portrait so the runs compare.
````

**Acceptance criteria:**

1. The three schema descriptions equal the after-texts; any test asserting a before-text is updated (list each).
2. `BUILDING_PROMPT` contains no `<!--`; a test asserts it, and that removing the two markers from the old text (git show HEAD:src/prompts.ts, or a copy of the old literal in the test) gives the new prompt exactly.
3. New tests/status.test.ts (temp portrait dir from tests/setup.ts): with no gate log, `Gate: off · 0 checks logged`; with a 3-line gate log and `gateMode` `shadow`, `Gate: shadow · 3 checks logged`; with 2 pending candidates saved via `saveWorkState`, `  Pending candidates: 2`; with a corrupt snapshot, `  Pending candidates: unknown (snapshot unreadable)` and `getStatus` does not throw. Each new line sits at the stated position.
4. README and scripts/compass/README.md match the text above byte for byte; `npm run lint:design-refs` passes.
5. No other string, setting, or behavior changes.

**Audit answers (CC, 2026-10-17; part of this spec; numbers refer to outputs/s7/handoff/S7-02-audit.md):**

1. **Criterion 2: neither variant.** No `git show` in a test (it breaks outside a git checkout and passes trivially after the commit), and no copied prompt literal (dupes). The test asserts that `BUILDING_PROMPT` contains no `<!--`, and that it contains the two edited lines with their remaining text and a line end after them (`…does not renumber existing entries.\n` and `…"evictPositions": [12, 15] },\n`). CC checks the exact one-line diffs at review with `git diff`.
2. **Risks and Noise: as you plan.** Corrupt-snapshot fixture: `CURRENT` naming a missing snapshot; `setTestConfig` for the portrait dir; count non-empty gate-log lines; a directory or unreadable `gate-log.jsonl` gives `0`.

**Allowed scope:** src/schema.ts, src/prompts.ts, src/commands/status.ts, README.md, scripts/compass/README.md (new), tests/status.test.ts (new), tests that assert a changed string (adapt; list each).

**Verification:**

```
npx vitest run tests/status.test.ts
npm test
npm run test:compass
```

## S7-03 — Settings in one place (user-approved text)

The user chose all three options from the design note (outputs/s7/s7-03-design-note.md): A, then B and C, which read A's file. Every user-facing string below was approved by the user on 2026-10-18; apply it byte for byte and do not reword it. The three-space list indent of the fenced blocks below is not part of the text.

**Read:** src/collector.ts (`DEFAULT_MAX_FILES_PER_CYCLE`, `DEFAULT_MAX_RESULTS`, `scanSessions`); src/pipeline.ts (the `scanSessions(portraitDir, pipelineState, 100, SINGLE_RESULT)` call); src/index.ts (`startLockPoll`, the `60_000`; command registration); src/llm-call.ts (`retryDelayMs`); src/footer.ts (`startStatusTimer`, the `5000`); src/gate-config.ts; src/config.ts; src/schema.ts (`PORTRAIT_SCHEMA`, `globalPath`); src/settings-ui.ts; src/commands/status.ts (header style); tests/settings-helpers.ts; tests/llm-call.test.ts (backoff tests); README.md ("Commands"); docs/CONFIGURATION.md.

**Changes:**

1. **A — new src/plugin-config.ts** in the style of src/gate-config.ts (file comment, an interface with a doc comment per value, one exported const `PLUGIN_CONFIG`):
   - `filesPerScan: 100` — read by the `scanSessions` call in src/pipeline.ts in place of the literal `100`;
   - `lockPollMs: 60_000` — read by `startLockPoll` in src/index.ts;
   - `retryBackoffBaseMs: 1_000` and `retryBackoffCapMs: 10_000` — read by `retryDelayMs` in src/llm-call.ts (`Math.min(base * 2 ** attempt, cap)`);
   - `footerRefreshMs: 5000` — read by `startStatusTimer` in src/footer.ts.
   Delete the unused exports `DEFAULT_MAX_FILES_PER_CYCLE` and `DEFAULT_MAX_RESULTS` from src/collector.ts (grep first; if anything reads them, stop and report). No value changes; no behavior changes.
2. **B — new src/commands/config.ts** exporting `getConfig(settingsFilePath: string): string`, and a new command in src/index.ts registered after `portrait:status`:

   ```ts
   pi.registerCommand("portrait:config", {
     description: "Show every portrait setting and fixed value with its source",
     handler: async (_args, ctx) => {
       ctx.ui.notify(getConfig(PORTRAIT_SCHEMA.globalPath(undefined)), "info");
     },
   });
   ```

   `getConfig` returns exactly these lines, joined with `\n`:

   ```
   👤 Portrait Configuration
   ──────────────────────
   Settings (/portrait:settings, <settingsFilePath>):
     <id>: <value> · <source>
   Jev gate (fixed):
     Model: jev-1.13.0
     Endpoint: https://api.typesafe.ai/v1/systemone
     Threshold: 0.3 (correction, preference, confusion)
     Deadline: 5000 ms · retry wait 500 ms · failure limit 3
     State cap: 32768 bytes
   Collection (fixed):
     Files per scan: 100
     Lock poll: 60000 ms
     Retry backoff: 1000 ms doubling, capped at 10000 ms
     Footer refresh: 5000 ms
   Environment:
     PI_PORTRAIT_STATE_DIR: <dir> · <source>
     PI_PORTRAIT_SESSION_DIRS: <dirs> · <source>
     TYPESAFE_API_KEY: <set | not set>
   ```

   - The rule line under "──────" is the same 22 characters as in `getStatus`.
   - **Settings:** one line per setting, in `PORTRAIT_SCHEMA.settings` order (21 lines), indented two spaces. `<value>` is `JSON.stringify` of the value from `getPortraitSettings()` (e.g. `null`, `"high"`, `180000`). `<source>` is `settings file` when the raw JSON object in `settingsFilePath` has that id as an own key, else `default`. A missing, unreadable, or non-object file means every source is `default`; `getConfig` never throws for it.
   - **Jev gate and Collection lines:** every number and name comes from `GATE_CONFIG` and `PLUGIN_CONFIG` (no literals in config.ts); the threshold's parenthesis lists `GATE_CONFIG.routeQuestions` joined with `, `.
   - **Environment:** `<dir>` is `getPortraitDir()`; `<dirs>` is `getSessionDirs()` joined with `path.delimiter`. `<source>` is `env` when `PI_PORTRAIT_STATE_DIR` (or `PI_PORTRAIT_SESSION_DIRS`) is a non-empty string in `process.env`, else `default`. `TYPESAFE_API_KEY` shows `set` when it is a non-empty string, else `not set`; the key's value is never printed.
3. **README.md, "Commands" table:** add this row right after the `/portrait:settings` row:

   ```
   | `/portrait:config` | Show every setting with its value and source (default or settings file), the fixed gate and collection values, and the environment variables |
   ```
4. **C — docs/CONFIGURATION.md:** insert this section right before `## Setting types`, followed by one blank line:

   ```
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
   ```

**Acceptance criteria:**

1. **A:** src/plugin-config.ts holds the five values; the four consumers read them; no literal `100` (scan call), `60_000`, `1_000`/`10_000` (backoff), or `5000` (footer) remains at those sites; the two dead exports are gone. The existing backoff tests pass unchanged (1, 2, 4, 8, 10 s).
2. **B:** new tests/config.test.ts, temp files only (settings file in a temp dir; `setTestConfig` for the portrait dir; `setupTestSettings` for values; save and restore every env var a test sets):
   - with no settings file: 21 setting lines in schema order, each `· default`, and `getConfig` does not throw;
   - with a file holding `{"model": "p/m", "ruleLimit": 50}` and settings to match: `  model: "p/m" · settings file`, `  ruleLimit: 50 · settings file`, every other setting `· default`;
   - with a file that is not valid JSON: every source `default`, no throw;
   - the Jev gate and Collection lines equal the template above;
   - `PI_PORTRAIT_STATE_DIR` unset → `· default`; `TYPESAFE_API_KEY` set to a sentinel → `  TYPESAFE_API_KEY: set` and the sentinel appears nowhere in the output; unset → `  TYPESAFE_API_KEY: not set`;
   - the whole output for the no-file case matches the template line by line (header, rule, section headings, order).
   Because src/config.ts reads `PI_PORTRAIT_STATE_DIR` once at load, the env-source test checks the source label only, not a changed dir.
3. **C:** docs/CONFIGURATION.md and the README row match the text above byte for byte. A test (in tests/config.test.ts) reads docs/CONFIGURATION.md and asserts that the rows Model, Endpoint, Threshold, Failure limit, and Files per scan carry `GATE_CONFIG.model`, `GATE_CONFIG.endpoint`, `GATE_CONFIG.threshold`, `GATE_CONFIG.failureLimit`, and `PLUGIN_CONFIG.filesPerScan`, so the docs cannot drift from the code silently.
4. `npm run lint:design-refs` passes; no source comment references a design doc or a former value.
5. No other string, setting, value, or behavior changes. The policy hash is unchanged (src/gate-config.ts is read, not edited).

**Audit answers (CC, 2026-10-18; part of this spec; outputs/s7/handoff/S7-03-audit.md):**

1. **Non-object file:** yes, a JSON array (or any value that is not a plain object) counts as not an object: every source is `default`.
2. **`PI_SETTINGS_PORTRAIT`:** out of scope; `getConfig` reads only `settingsFilePath`. No change for it.

**Allowed scope:** src/plugin-config.ts (new), src/collector.ts (delete the two exports), src/pipeline.ts, src/index.ts, src/llm-call.ts, src/footer.ts, src/commands/config.ts (new), README.md, docs/CONFIGURATION.md, tests/config.test.ts (new), tests that break only because an import moved (adapt; list each).

**Verification:**

```
npx vitest run tests/config.test.ts tests/llm-call.test.ts
npm test
npm run test:compass
```

## CC review and gate (not for the coder)

Review per planner-prompt.md Step 2; ledger entry in md/ledger.jsonl. Check: `candidateText` is read only by the harness; the B13 refusal makes no model request; B15 output matches the approved text byte for byte; B20 did not change src/; B21's report text is otherwise identical. Update md/bugs.md (status, fix commit, evidence) for each bug.

Planner difficulty: S7-01 easy; S7-02 easy; S7-03 medium.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.3.0 | 2026-10-17 | S7-02 text-batch spec with the user-approved text. |
| 0.4.0 | 2026-10-18 | S7-02 audit answers. |
| 0.5.0 | 2026-10-18 | S7-03 spec: options A, B, and C with the user-approved text; audit answers. |
