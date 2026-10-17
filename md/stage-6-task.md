# Stage 6 — Settings, acceptance, and handoff

Project: **pi-session-compass** · Revision: **0.3.0** · Status: **Approved (user, 2026-10-17)**

Date: **2026-10-17**

Parent: [Development plan](plan.md), Stage 6. Evidence: outputs/s5/pilot-report.md and outputs/s5/scale/scale-report.md. Operating rules: [AGENTS.md](../AGENTS.md). Bugs: [bugs.md](bugs.md).

**Goal (M6):** a release candidate with the gate shipped **off**, a gate log so shadow mode yields evidence in daily use, product docs that state the measured numbers, and a handoff.

**User decisions (2026-10-17):** ship default `off` and document shadow and enforce with the S5 numbers (option 1); add a gate log so shadow mode records its decisions in daily use (option 3, variant B). The user's energy is the constraint: few approvals, no label checks in S6.

| Task | Plan tasks | Outcome | Who |
|---|---|---|---|
| S6-01 — Gate log | S6.T1 (part) | Every non-off gate check appends one line to a log the user can inspect | Pi |
| S6-02 — Product docs | S6.T2 | README and docs/CONFIGURATION.md: gate modes, key, gate log, measured numbers, turning the gate off, rollback | CC (text user-approved) |
| S6-03 — Release checks and speed run | S6.T3 | Exit checks 1–8; one live run of the final version on the S1 fixture, compared with the S1 baseline | CC |
| S6-04 — Delivered mode and handoff | S6.T4, S6.T5 | Gate mode `off` recorded with the unmet activation checks; handoff evidence | CC |

## Fixed design

1. **Gate log file:** `<portrait dir>/gate-log.jsonl` (the portrait dir is `getPortraitDir()`, `~/.pi/portrait` by default). One JSON object per line, appended for every gate check in `shadow` or `enforce`; nothing in `off`.
2. **Fields:** `ts` (ISO time), `session` (source session file path), `sessionId`, `trioId` and `entryIds` (the trio's stable ID and its three record IDs, which locate it in the session file), `mode`, `policyHash`, `decision` (`extract` or `skip`), `result` (`no_lesson`, `maybe_lesson`, or the fallback reason), `answers` (or null), `model`, `attempts` (Jev requests the check used), `latencyMs`, `usage`. No trio text and no key.
3. **Failure-safe:** a failed log write never changes the scan, the decision, or the extraction; it is skipped silently (no user message, so no new protected text).
4. **Not committed:** the portrait repo stages named files only, so the log stays untracked; also add `gate-log.jsonl` to the `.gitignore` the plugin writes for a new portrait repo.
5. **No rotation:** about 600 bytes per trio (measured in the S6-03 speed run); documented, not managed.
6. **Speed run:** run type `compare`, the S1 fixture and the S1 start snapshot, final code with the gate in `enforce`; compared with the S1 baseline (150 requests, 56.9 min, capped) and the S2 compare run (46 requests, 26.0 min). Limits suggested at launch, user-confirmed. Needs `TYPESAFE_API_KEY`.

## Tasks

### S6-01 — Gate log (Pi)

- [x] **1.** Spec: [stage-6-specs.md](stage-6-specs.md) S6-01. Append the log line in the gate path (src/gate.ts or src/collector.ts, where the gate result is known), per design 1–3.
- [x] **2.** Add `gate-log.jsonl` to the `.gitignore` template in src/git.ts.
- [x] **3.** Tests in a temporary portrait dir: shadow and enforce each append one line per trio with the fields of design 2; off writes nothing; fallbacks are logged with their reason; a log write that throws leaves the decision and extraction unchanged; no key or trio text in the file.

### S6-02 — Product docs (CC; protected text, presented before writing)

- [x] **1.** README and docs/CONFIGURATION.md: the `gateMode` setting (off / shadow / enforce), `TYPESAFE_API_KEY`, the gate log and how to read it, turning the gate off.
- [x] **2.** Measured numbers, plainly: total cost −47% and time −38% with enforce (one paired run); lessons kept 77 of 81 and corrections missed 3 of 46 on sessions the policy was not tuned on; misses are implicit corrections phrased as requests. Enforce is not recommended yet.
- [x] **3.** Rollback: gate off keeps the recovery improvements; manual rollback from a snapshot after a failure. Product-doc style (no design references, no history framing).

### S6-03 — Release checks and speed run (CC)

- [x] **1.** Exit checks 1–8 (plan.md §8) against the release candidate, mapped to test files and earlier evidence; both full suites, single-worker and concurrent.
- [x] **2.** Speed run per design 6; report requests, time, tokens, and rules against the S1 baseline and S2 compare.

### S6-04 — Delivered mode and handoff (CC)

- [ ] **1.** Record the delivered mode `off` and the unmet activation checks (scale-up: corrections missed 3 of 29, lessons kept 94%).
- [ ] **2.** Handoff: commit, dependency versions, test results, frozen policy and settings, fixture references, receipts; sync plan.md, stage.md, compass.md, bugs.md, and the ledger. Checkpoint with the user.

## Deferred (not in S6)

- The rest of plan S6.T1: settings and status help text (candidate-batch units, stop reasons, pending work, bypass count), the debug-path description, removing inert builder-prompt HTML comments.
- The one-place settings view (plan §8 planning note).
- A retuned policy for implicit corrections (scale-report option 2); the untouched 463-trio dashboard-v3 split stays available as its held-out set.
- Bug B21 (evaluator's miss-bound denominator).

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.2.0 | 2026-10-17 | Approved by the user; the log locates a trio by trio ID and record IDs (line numbers are not available at the gate). |
| 0.3.0 | 2026-10-17 | Gate log adds `attempts` (user, after the S6-01 audit); S6-01, S6-02, S6-03 done; gate-log line about 600 bytes. |
