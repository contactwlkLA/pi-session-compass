# Stage 7 — Task specs (Pi codes, Claude Code reviews)

Project: **pi-session-compass** · Revision: **0.4.0** · Status: **Ready (stage-7-task.md approved by the user, 2026-10-17)**

Date: **2026-10-17**

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

## CC review and gate (not for the coder)

Review per planner-prompt.md Step 2; ledger entry in md/ledger.jsonl. Check: `candidateText` is read only by the harness; the B13 refusal makes no model request; B15 output matches the approved text byte for byte; B20 did not change src/; B21's report text is otherwise identical. Update md/bugs.md (status, fix commit, evidence) for each bug.

Planner difficulty: S7-01 easy; S7-02 easy.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.2.0 | 2026-10-17 | S7-01 audit answers. |
| 0.3.0 | 2026-10-17 | S7-02 text-batch spec with the user-approved text. |
| 0.4.0 | 2026-10-18 | S7-02 audit answers. |
