# Stage 6 — Task specs (Pi codes, Claude Code reviews)

Project: **pi-session-compass** · Revision: **0.2.0** · Status: **Ready (stage-6-task.md approved by the user, 2026-10-17)**

Date: **2026-10-17**

Parent: [stage-6-task.md](stage-6-task.md) (fixed design 1–5).

**Coder rules, spec audit, and handoff format:** [stage-3b.md](stage-3b.md), section "Coder rules", unchanged, except that the audit and handoff go to `outputs/s6/handoff/<task_id>-audit.md` and `outputs/s6/handoff/<task_id>-r<round>.md`. Do not touch `~/.pi`: every test uses the temporary portrait dir from tests/setup.ts.

## S6-01 — Gate log

Today shadow mode calls Jev on every trio but keeps nothing outside the test harness: the result goes only to an instrument hook nobody installs in normal use. Add a gate log: every gate check in `shadow` or `enforce` appends one JSON line to `<portrait dir>/gate-log.jsonl`, so the user can later see what the gate decided on real sessions. `off` writes nothing. A failed write never changes the scan.

**Read:** src/gate.ts (`GateResultEvent`, `GateCheck`, `checkTrio`); src/collector.ts (`tryExtractTrio`, around lines 545–590: the `checkTrio` call, the skip branch, and the `TrioIdentity` built from `trioIdentity(sessionId, records)`); src/git.ts (`initGit`, the `.gitignore` template); src/config.ts (`getPortraitDir`); tests/gate.test.ts (setup, mocks, and the "scan with the gate" block); tests/setup.ts (the test portrait dir).

**Where and how (CC's plan):**

1. **New src/gate-log.ts.** Exports `GATE_LOG_FILE = "gate-log.jsonl"`, an interface `GateLogEntry`, and `appendGateLog(portraitDir: string, entry: GateLogEntry): void`. The function appends `JSON.stringify(entry) + "\n"` to `path.join(portraitDir, GATE_LOG_FILE)` with `fs.appendFileSync`, inside a `try/catch` that swallows every error: no `reportError`, no rethrow, no console output. Header comment: one line per gate check in shadow or enforce; no trio text and no credential; a failed write is ignored so the scan is never affected.
2. **`GateLogEntry` fields, in this order:**

   | Field | Value |
   |---|---|
   | `ts` | `new Date().toISOString()` at the time of the check |
   | `session` | the resolved session file path (the `sourcePath` passed to `checkTrio`) |
   | `sessionId` | the session header id, or `null` |
   | `trioId` | `trioIdentity(sessionId, records)` |
   | `entryIds` | `records.map((record) => record.id)` |
   | `mode` | `event.mode` |
   | `policyHash` | `event.policyHash` |
   | `decision` | `event.routed` (`"extract"` or `"skip"`) |
   | `result` | `event.decision` when it is `no_lesson` or `maybe_lesson`; the `event.fallbackReason` when it is `fallback` |
   | `answers`, `model`, `attempts`, `latencyMs`, `usage` | copied from the event |

3. **src/collector.ts, `tryExtractTrio`.** Right after `checkTrio` returns and before the `if (gate.decision === "skip")` branch: when `gate.event !== null`, call `appendGateLog(portraitDir, …)`. Compute `trioIdentity(sessionId, records)` once and reuse it for the later `TrioIdentity` instead of computing it twice. Nothing else in the scan changes.
4. **src/git.ts, `initGit`.** Add `gate-log.jsonl` as a new line in the `.gitignore` template. Repos created before this change are not touched (`commitPortrait` stages named files only, so the log stays untracked there too).

**Acceptance criteria:**

1. Shadow scan of the two-trio session from tests/gate.test.ts with every Jev answer low: `gate-log.jsonl` in the test portrait dir has exactly 2 lines; each parses as JSON with every field of item 2; `decision` is `extract`, `result` is `no_lesson`, `mode` is `shadow`, `policyHash` equals `JEV_POLICY_HASH`, `session` is the resolved session path, `entryIds` has 3 entries, and the two `trioId`s differ and equal the trio IDs on the scan's examined results.
2. Enforce scan of the same session with low answers: 2 lines, both `decision` `skip`, `result` `no_lesson`, `mode` `enforce`.
3. Off scan: no `gate-log.jsonl` is created.
4. Shadow scan with `TYPESAFE_API_KEY` unset: 2 lines with `result` `key_missing`, `answers` and `model` `null`, `attempts` 0; both trios are extracted.
5. A failing write: make `gate-log.jsonl` a directory in the portrait dir before a shadow scan. The scan returns the same results and checkpoints as a normal shadow scan, does not throw, and `reportError` is not called for it.
6. The log file contains neither the test credential nor any trio text (assert on the raw file content for the key and for each user and assistant text in the fixture).
7. The `.gitignore` text written by `initGit` contains a `gate-log.jsonl` line (test it if an existing test covers `initGit`; otherwise say so under `Uncertain` and CC checks it by reading).
8. No new or changed user-facing string; existing tests pass unchanged except ones listed under `Done` as adapted.

**Audit answers (CC, 2026-10-17; part of this spec; numbers refer to outputs/s6/handoff/S6-01-audit.md):**

1. **Question 1: keep `attempts`** (user, 2026-10-17); stage-6-task.md design 2 now lists it.
2. **Question 2: yes.** Assert the `.gitignore` line in tests/gate-log.test.ts by calling `initGit` on a temp dir with the `setGitExec` seam stubbed.
3. **Question 3: yes.** The collector builds the whole entry, `ts` included; `appendGateLog` only serializes and appends.
4. **Risks and Noise: as you plan.** `session` is `event.sourcePath`; `sessionId` is `sessionId ?? null`; type `result` as `string`; one comment line in gate-log.ts mapping `decision` ← `event.routed` and `result` ← `event.decision` or `event.fallbackReason`; keep `resetGateRun()` in the copied setup; list any adapted tests/compass test under `Done`.

**Allowed scope:** src/gate-log.ts (new), src/collector.ts, src/git.ts, tests/gate-log.test.ts (new; copy the setup, mocks, and session writers from tests/gate.test.ts), tests/gate.test.ts (adapt only if needed), tests/compass/*.test.ts (adapt only if one breaks because the run's portrait dir now holds a gate log; list each).

**Constraints:** no change to gate decisions, the Jev request, modes, settings, run-scoped state, the instrument hooks, or extraction; no log rotation, no new setting; synchronous append (no new async step in the scan).

**Verification:**

```
npx vitest run tests/gate-log.test.ts tests/gate.test.ts
npm test
npm run test:compass
```

## CC review and gate (not for the coder)

Review per planner-prompt.md Step 2; ledger entry in md/ledger.jsonl. Check: the log is written before the skip branch, so enforce skips are logged; `off` never touches the file; the catch swallows without `reportError`; no trio text or key can reach the entry (fields are copied from the event and identity only); harness runs in shadow or enforce write the log inside the run's isolated portrait dir, never the live one.

Planner difficulty: S6-01 easy.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.1.0 | 2026-10-17 | S6-01 gate log spec. |
| 0.2.0 | 2026-10-17 | S6-01 audit answers. |
