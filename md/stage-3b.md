# Stage 3 Part B — Task specs (Pi codes, Claude Code reviews)

Project: **pi-session-compass** · Revision: **0.3.0** · Status: **Approved (user, 2026-10-15)**

Date: **2026-10-15**

Parent: [stage-3-task.md](stage-3-task.md) Part B. Contract: [architecture.md](architecture.md) §5 (outcomes) and §6. Bugs: [bugs.md](bugs.md) P10. Procedure: [planner-prompt.md](planner-prompt.md); side-quest rules: [NOTES.md](NOTES.md).

**Roles.** Pi writes the code and tests, one task per Pi session. Claude Code (CC) wrote these specs, reviews each diff, re-runs both full suites, keeps the ledger and bugs.md, and commits. The user relays and approves protected text.

**Relay.** For each task CC says **"Tell Pi: S3-B1-0N"** and gives one line to paste into a fresh Pi session:

`Read md/stage-3b.md, sections "Coder rules" and "S3-B1-0N", and do that task only. Write the handoff file, then stop.`

**Session split (user, 2026-10-15).** B-1 = S3-B1-01, S3-B1-02a, S3-B1-02b, S3-B1-03, S3-B1-04 (stage-3-task B1, B2.3 boundaries (a) and (c), B2.6). B-2 = builder split, validated publication, boundary (b), restore with edit guard, crash tests (B2.1, B2.2, B2.3(b), B2.4, B2.5, B3). B-2 specs are written after B-1 is committed, since they build on its code.

## Design decisions fixed before coding (CC)

These hold for every B-1 task; a coder may not change them.

1. **Outcomes.** Extraction and post-review return a typed outcome, `success` (zero or more rules) or `failed`. PAUSED keeps propagating as now. Only `success` advances the scan position. A failed extraction is never recorded as an empty result (P10).
2. **Trio ID.** sha256 hex of `${sessionId}\n${idBefore}\n${idUser}\n${idAfter}` when the header session id and all three record `id`s are strings; otherwise sha256 hex of the three records' texts joined by `\n`. Candidate ID: `${trioId}:${ordinal}`, ordinal from 0 in the rule list it came from.
3. **Work state lives in the snapshot.** `SnapshotState.scanPositions` and `pendingCandidates` (src/snapshot-store.ts) become the authority. When no snapshot exists yet, the first load seeds positions from `processed-sessions.json` (read only). After every snapshot write, positions are also written to `processed-sessions.json` as a mirror, read only by the background counter; Part C replaces the seed with a proper migration and retires the mirror.
4. **Snapshot boundaries in B-1.** (a) after each examined trio: the new scan position plus that trio's candidates, in one snapshot; (c) after a build batch has written its files: those candidates removed. Boundary (b), the publication intent, is B-2. Until B-2, a crash between a build's file writes and boundary (c) can insert the same rules twice; that window is known and B-2 closes it.
5. **A failed extraction, review, or build stops the run cleanly:** the pipeline reports one approved message, keeps all pending candidates, sets phase idle, skips auto-maintenance, and returns a `stopReason`.
6. **Reset (interim).** `/portrait:reset` also removes `<portraitDir>/snapshots/`, so a reset still restarts the scan. No reset text changes until Part C.

## Protected text (approved by the user, 2026-10-15)

Shown to the user as `Portrait ${source}: ${message}` (src/index.ts).

| ID | Source | Message | Task |
|---|---|---|---|
| T1 | `extraction error` | `Rule extraction failed for a trio in ${path}. Its scan position was kept; the trio will be extracted again on the next run.` | S3-B1-01 |
| T2 | `review error` | `Rule review failed; ${n} extracted ${n === 1 ? "rule was" : "rules were"} kept and will be reviewed on the next run.` | S3-B1-01, S3-B1-02b |
| T3 | `building error` | `Building failed; ${n} candidate ${n === 1 ? "rule was" : "rules were"} kept and will be built on the next run.` | S3-B1-03 |
| T4 | harness receipt (scripts/compass/strings.ts) | `stopped: ${stage} failed; pending work was kept (see diagnostics.log)` with `${stage}` one of `extraction`, `review`, `build` | S3-B1-04 |

T1 and T4 are new beyond the stage-3-task list. Without T4, a stopped run's receipt would say "completed — the selected scope was covered", which is false.

## Coder rules

- Do **only** the task you were given, then write the handoff and stop. Do not start another task.
- Read only the files the task names, plus files they import if you need a signature. Do not read other `md/` files. Do not enter `./private`. Do not touch `~/.pi`.
- Modify only the files in the task's **Allowed scope**. The handoff file is the one exception.
- Do not commit, push, or run live model runs. Do not add or upgrade dependencies.
- User-facing strings: use **exactly** the approved strings quoted in the task. Add or reword no other user-facing text; if you think one is needed, say so under `Uncertain`.
- Follow the surrounding code style. Source comments describe behavior; no design-doc references (§N, P10, "S3", "B-1") in source or test comments.
- The repo lint forbids optional parameters; add required parameters and update every caller in scope.
- Before declaring done, run every command under **Verification** and paste each result line.
- If a fix attempt fails twice, stop and report under `Not done`.
- Do not add measurement, logging of your own performance, or commentary on your own quality.

**Handoff.** Write `outputs/s3-b/handoff/<task_id>-r<round>.md` (round 1 unless told otherwise) with exactly these sections:

1. `Done`: what was implemented, mapped to acceptance criteria by number
2. `Not done`: anything incomplete or skipped, and why
3. `Ran`: each command executed and its result, pasted not paraphrased
4. `Changed files`: every file touched
5. `Uncertain`: anything you are unsure about

## S3-B1-01 — Typed extraction and review outcomes; trio identity

A failed extraction currently returns empty notes, so the trio is recorded as examined-with-no-rules and the scan moves past it; a failed post-review returns `[]` and silently drops the rules. Make both return a typed outcome. On failure the scan position for that file stays at the previous boundary, the pass stops, and the pipeline stops cleanly. Also give every examined trio a stable trio ID and its candidates IDs, carried on `ExtractionResult`.

**Read:** src/collector.ts, src/trio-detector.ts, src/types.ts, src/pipeline.ts, src/llm-call.ts (`callPortraitLlm` signature and return values only), tests/extraction.test.ts, tests/pipeline.test.ts, tests/scan-position.test.ts, tests/setup.ts.

**Interfaces (fixed):**

```ts
// src/collector.ts (module-internal)
type ExtractionOutcome =
  | { kind: "success"; notes: string[]; summary: ExtractionSummary; dumpPath: string | null }
  | { kind: "failed" };
type ReviewOutcome = { kind: "success"; notes: string[] } | { kind: "failed" };

// src/types.ts
export type PipelineStopReason = "extraction_failed" | "review_failed" | "build_failed";
export interface ExtractionResult {
  behaviorNotes: string[];
  sessionPath: string;
  source: "main" | "subagent";
  trioId: string;
  candidateIds: string[];          // `${trioId}:${i}`, one per behaviorNotes entry
  sessionId: string | null;        // header id
  cwd: string | null;              // header cwd
  entryIds: (string | null)[];     // [before, user, after] record ids
}
// ScanResults gains:  stopReason: PipelineStopReason | null
// PipelineStats (src/pipeline.ts) gains: stopReason: PipelineStopReason | null
```

**Acceptance criteria:**

1. `callExtractionLlm` returns `{ kind: "failed" }` when `callPortraitLlm` returns `undefined`, and `postExtractRules` returns `{ kind: "failed" }` when the review call returns `undefined`. PAUSED still throws `Error("PAUSED")` from both.
2. On a failed extraction or review: `scanSessions` returns `stopReason` `"extraction_failed"` / `"review_failed"`, the failed trio is not in `results`, no `emitTrioExamined` is sent for it, and the saved position for that file equals the position before the trio (a later pass with a succeeding stub emits that same trio). It calls `reportError` once with T1 (source `extraction error`, `${path}` = the session file path) or T2 (source `review error`, `${n}` = number of raw rules) exactly as approved.
3. A successful extraction with zero rules, and a review that keeps zero rules, still advance the position as today; `stopReason` is `null`.
4. `runPipelineLoop` stops on a non-null scan `stopReason`: builds any results already returned, makes no further scan pass, sets `pipelinePhase` to `"idle"`, skips auto-maintenance, and returns that `stopReason`. Normal runs return `stopReason: null`.
5. `TrioDetector` gains an additive getter `lastRecordSetLastUser` (true when the record just processed set the pending user text); `countPendingTrios` behavior is unchanged.
6. Every `ExtractionResult` carries `trioId`, `candidateIds`, `sessionId`, `cwd`, `entryIds` per design decision 2. The header (first record) is read once per pass, so a resumed pass has `sessionId` and `cwd` too.
7. Tests in a new `tests/extraction-outcomes.test.ts`: (a) failed extraction → criterion 2, then retry succeeds and emits the trio; (b) failed review with `postExtractionEnabled` → criterion 2; (c) zero-rule success advances; (d) `runPipelineLoop` stop → criterion 4, builder not called after the stop; (e) the same trio has the same `trioId` in an uninterrupted scan and in a scan restarted mid-file; (f) appending records does not change earlier trio IDs; (g) two trios have different IDs; (h) the ID uses entry ids when present and the record-text fallback when they are absent; (i) `candidateIds` are `${trioId}:0`, `${trioId}:1`.
8. Existing tests pass. Change an existing test only where it asserted failure-as-empty behavior, and list each change under `Done`.

**Allowed scope:** src/collector.ts, src/trio-detector.ts, src/types.ts, src/pipeline.ts, src/commands/collect.ts (only to keep compiling), tests/extraction-outcomes.test.ts (new), tests/extraction.test.ts, tests/pipeline.test.ts, tests/scan-position.test.ts, tests/trio-detector.test.ts.

**Constraints:** no snapshot use yet (S3-B1-02); keep `processed-sessions.json` as the position store in this task. No new dependencies. T1 and T2 exactly as quoted above.

**Verification:**

```
npx vitest run tests/extraction-outcomes.test.ts tests/extraction.test.ts tests/pipeline.test.ts tests/scan-position.test.ts tests/trio-detector.test.ts
npm test
npm run test:compass
```

## S3-B1-02a — Work-state module: pending candidates and scan positions in the snapshot

Add the module that makes the snapshot the store for scan positions and pending candidates. This task builds and tests the module only; the scanner starts using it in S3-B1-02b.

**Read:** src/snapshot-store.ts, src/storage.ts (`loadScanCheckpoints`, `saveScanCheckpoints`), src/types.ts, src/prompts.ts (export names only), tests/snapshot-store.test.ts, tests/setup.ts.

**Interfaces (fixed):**

```ts
// src/types.ts
export interface PendingCandidate {
  candidateId: string;
  trioId: string;
  sourcePath: string;             // path.resolve() of the session file
  cwd: string | null;
  sessionId: string | null;
  entryIds: (string | null)[];
  policyRevision: string;         // EXTRACTION_POLICY_REVISION
  text: string;
  stage: "needsPostReview" | "needsBuild";
  reviewContext: InteractionSequence | null; // the extraction summary; set only for needsPostReview
}

// src/work-state.ts (new)
export const EXTRACTION_POLICY_REVISION: string; // first 12 hex chars of sha256(EXTRACTION_PROMPT)
export function loadWorkState(portraitDir: string): SnapshotState;
export function saveWorkState(portraitDir: string, state: SnapshotState): void;
// src/snapshot-store.ts: SnapshotState.pendingCandidates becomes PendingCandidate[]
```

**Acceptance criteria:**

1. `loadWorkState` returns the latest snapshot's state. With no snapshot it returns `{ scanPositions: loadScanCheckpoints(portraitDir), pendingCandidates: [], publicationIntent: null }` and writes nothing. `SnapshotCorruptError` and `SnapshotUnsupportedError` propagate; they are never turned into an empty state.
2. `saveWorkState` calls `writeSnapshot` with whichever of `portrait.md`, `evicted.md`, `dropped.md` exist in `portraitDir`, then writes `scanPositions` to `processed-sessions.json` (the mirror).
3. `EXTRACTION_POLICY_REVISION` is the first 12 hex characters of sha256 of `EXTRACTION_PROMPT`.
4. Tests in a new `tests/work-state.test.ts`: criterion 1 (seed from `processed-sessions.json`, and no file written by a load; a corrupt snapshot rejects and leaves `processed-sessions.json` unchanged; an unsupported one rejects); criterion 2 (only existing files are copied, checked through `loadLatestSnapshot`'s manifest; the mirror equals the saved positions; a `PendingCandidate` round-trips through save and load); criterion 3.
5. Existing tests pass.

**Allowed scope:** src/work-state.ts (new), src/snapshot-store.ts (the `pendingCandidates` type only), src/types.ts, tests/work-state.test.ts (new), tests/snapshot-store.test.ts; for type fixes only: tests/portrait.test.ts, tests/compass/receipt-sink-errors.test.ts, tests/compass/running-table.test.ts, tests/compass/validation-rounds-receipt.test.ts.

**Constraints:** no caller of the new module yet; src/collector.ts and src/pipeline.ts unchanged. No change to snapshot layout, manifest, or error strings. No user-facing text.

**Verification:**

```
npx vitest run tests/work-state.test.ts tests/snapshot-store.test.ts
npm test
npm run test:compass
```

## S3-B1-02b — Scanner saves through the work state (boundary a); reset clears it

Make the scanner read and save scan positions through the work-state module. Each examined trio ends in one snapshot holding the new scan position and that trio's candidates. With post-review enabled, the raw rules are saved before the review runs and replaced (or removed) after it. Reset also clears the snapshot.

**Read:** src/work-state.ts, src/collector.ts, src/types.ts, src/commands/reset.ts, tests/work-state.test.ts, tests/scan-position.test.ts, tests/extraction-outcomes.test.ts, tests/setup.ts.

**Interfaces (fixed):** as in S3-B1-02a; no new exports.

**Acceptance criteria:**

1. `scanSessions` takes positions from `loadWorkState`, not from `loadScanCheckpoints`, and makes no direct `saveScanCheckpoints` call; every position save goes through `saveWorkState`.
2. Post-review disabled: after a successful extraction one `saveWorkState` call stores the new position and the trio's candidates (`stage: "needsBuild"`, all `PendingCandidate` fields set). A zero-rule success stores the position only. A failed extraction writes no snapshot.
3. Post-review enabled: first one snapshot with the new position and the raw rules as `needsPostReview` (with `reviewContext`); then the review. Success replaces them with the kept rules as `needsBuild` (new ordinals over the kept list, `reviewContext: null`) or removes them when none are kept, in a second snapshot. Failure keeps the raw `needsPostReview` candidates and returns `stopReason: "review_failed"` with T2.
4. `/portrait:reset` additionally removes `<portraitDir>/snapshots/` (recursive, force). No reset text changes.
5. Tests (extend tests/work-state.test.ts or add tests/scan-work-state.test.ts): criterion 2 (all three cases, checked through `loadLatestSnapshot`), criterion 3 (success, all dropped, failure), criterion 4, and a corrupt snapshot makes `scanSessions` reject without seeding from `processed-sessions.json`. Existing scan-position restart tests still pass with positions coming from the snapshot.

**Allowed scope:** src/collector.ts, src/types.ts, src/commands/reset.ts, tests/work-state.test.ts, tests/scan-work-state.test.ts (new), tests/scan-position.test.ts, tests/extraction.test.ts, tests/extraction-outcomes.test.ts, tests/portrait.test.ts (reset tests, and type fixes); for type fixes only: tests/compass/receipt-sink-errors.test.ts, tests/compass/running-table.test.ts, tests/compass/validation-rounds-receipt.test.ts.

**Constraints:** src/work-state.ts unchanged unless a criterion here cannot be met without it (then say so under `Uncertain`). The pipeline still builds from `scanResults.results` in this task (S3-B1-03 switches it); candidates stay pending. T2 exactly as quoted.

**Verification:**

```
npx vitest run tests/work-state.test.ts tests/scan-work-state.test.ts tests/scan-position.test.ts tests/extraction.test.ts tests/extraction-outcomes.test.ts tests/portrait.test.ts
npm test
npm run test:compass
```

## S3-B1-03 — Build from pending candidates; acknowledge after the build (boundary c)

The pipeline builds from the snapshot's pending candidates instead of the scan's in-memory results, removes them after a successful build, and keeps them when a build fails. A run first finishes work left pending by an earlier run before it scans further.

**Read:** src/pipeline.ts, src/work-state.ts, src/collector.ts (`postExtractRules` and the post-review part of the scan only), src/builder.ts (`buildPortrait` signature and return), src/types.ts, src/index.ts and src/commands/collect.ts (the `runPipelineLoop` calls only), tests/pipeline.test.ts, tests/work-state.test.ts, tests/setup.ts.

**Interfaces (fixed):**

```ts
// src/work-state.ts
/** needsBuild candidates in stored order; when sourceFilter is a path, only those whose sourcePath equals path.resolve(sourceFilter). */
export function selectPendingForBuild(state: SnapshotState, sourceFilter: string | null): PendingCandidate[];
// src/collector.ts
/** Review every needsPostReview group (by trioId) with its reviewContext; same outcome handling as during a scan. */
export async function reviewPendingCandidates(portraitDir: string, sourceFilter: string | null): Promise<PipelineStopReason | null>;
// src/pipeline.ts
export async function runPipelineLoop(settings, maxSequences, shouldCancel, sourceFilter: string | null): Promise<PipelineStats>;
```

**Acceptance criteria:**

1. At the start of `runPipelineLoop`, before the first scan: `reviewPendingCandidates`, then build the pending `needsBuild` candidates (criterion 2). A stop here ends the run as in S3-B1-01 criterion 4.
2. After each scan pass, the pipeline builds `selectPendingForBuild(loadWorkState(dir), sourceFilter)` in batches of `buildingBatchSize`, passing candidate texts to `buildPortrait` as today. After a batch succeeds, `saveWorkState` removes exactly that batch's candidate IDs (boundary c); the counters (`totalInserted`, `rulesInsertedSinceMaintenance`) update as today.
3. When `buildPortrait` returns `undefined`, no candidate is removed, `reportError` is called once with T3 (source `building error`, `${n}` = pending `needsBuild` count after the failure), and the run stops with `stopReason: "build_failed"` (S3-B1-01 criterion 4).
4. A Git commit failure inside the build does not keep or drop candidates differently: a batch whose files were written is acknowledged.
5. `selectPendingForBuild` with a path returns only that source's candidates, and building leaves other sources' candidates in the snapshot untouched.
6. Every caller passes `sourceFilter`: src/index.ts and src/commands/collect.ts pass `null`; scripts/compass/pipeline-boot.ts passes `null` (S3-B1-04 changes it).
7. Tests (extend tests/pipeline.test.ts or add tests/pending-build.test.ts): a candidate saved by one run and not built (simulate a crash after boundary a) is built by the next run with no re-extraction; build failure keeps the candidates and gives T3 and `build_failed`; successful batches are acknowledged and a second run builds nothing; source filter (criterion 5); a pending `needsPostReview` group is reviewed at the start of the next run.

**Allowed scope:** src/pipeline.ts, src/work-state.ts, src/collector.ts, src/types.ts, src/index.ts (the call only), src/commands/collect.ts (the call only), scripts/compass/pipeline-boot.ts (the call only), tests/pipeline.test.ts, tests/pending-build.test.ts (new), tests/work-state.test.ts, tests/extraction-outcomes.test.ts; for type fixes only: tests/portrait.test.ts, tests/compass/receipt-sink-errors.test.ts, tests/compass/running-table.test.ts, tests/compass/validation-rounds-receipt.test.ts.

**Constraints:** builder internals unchanged (B-2 splits them). No boundary (b) and no publication intent. T3 exactly as quoted.

**Verification:**

```
npx vitest run tests/pipeline.test.ts tests/pending-build.test.ts tests/work-state.test.ts tests/extraction-outcomes.test.ts
npm test
npm run test:compass
```

## S3-B1-04 — Harness reads the new work state

The harness must carry the snapshot in its start-state copies, read pass stops, and report a stopped run truthfully.

**Read:** scripts/compass/snapshot.ts, scripts/compass/pipeline-boot.ts, scripts/compass/strings.ts, scripts/compass/types.ts, scripts/compass/selection.ts, src/pipeline.ts (`PipelineStats`), tests/compass/start-snapshot.test.ts, tests/compass/strings.test.ts, tests/compass/compass-harness.test.ts.

**Acceptance criteria:**

1. `snapshotPortraitState` and `restoreSnapshot` also copy the `snapshots/` directory when present; `hashes.json` lists each copied file under `snapshots/...`, so `verifySnapshot` checks them.
2. The harness pass loop stops when a pass returns a non-null `stopReason` and writes the receipt with a new stop kind `"stopped"` and outcome string T4 (`stage` = `extraction` / `review` / `build` for `extraction_failed` / `review_failed` / `build_failed`). A stopped run is not reported as completed.
3. In `scope=file`, pipeline-boot passes the selected file's path inside the isolated session dir as `sourceFilter`; in `scope=all` it passes `null`.
4. Any harness code that reads scan positions reads them through `loadWorkState`. If none does, say so under `Done`.
5. Tests in tests/compass: a start snapshot with a `snapshots/` directory round-trips and a changed snapshot file fails `verifySnapshot`; a stopped pass yields stop kind `"stopped"` and T4; strings test covers T4.

**Allowed scope:** scripts/compass/snapshot.ts, scripts/compass/pipeline-boot.ts, scripts/compass/strings.ts, scripts/compass/types.ts, tests/compass/*.test.ts.

**Constraints:** no `src/` changes. Existing receipt fields and strings unchanged; T4 exactly as quoted.

**Verification:**

```
npx vitest run tests/compass
npm test
npm run test:compass
```

## CC review and gate (not for the coder)

Per task, following planner-prompt.md Step 2: handoff check, claim check against `git diff` and pasted output, scope check against Allowed scope, unrequested hunks, constraints, verification run, acceptance criteria, verdict; then the ledger entry in md/ledger.jsonl. At most two correction rounds per task.

- **S3-B1-01:** the outcome type is used at both call sites; no path still maps `undefined` to `[]`; position unchanged on failure (check the test asserts the saved value, not just results); T1/T2 byte-exact.
- **S3-B1-02a:** load never writes; corrupt/unsupported never seed from legacy; only existing files copied.
- **S3-B1-02b:** one snapshot per examined trio (two with review); no remaining `saveScanCheckpoints` in the scan path; corrupt snapshot never seeds from legacy.
- **S3-B1-03:** acknowledgement removes only the built batch; failure path removes nothing; start-of-run drain precedes scanning.
- **S3-B1-04:** receipt never says completed after a stop; `hashes.json` covers snapshot files.

Commits: S3-B1-01, S3-B1-02a, and S3-B1-04 each on their own; S3-B1-02b and S3-B1-03 together (S3-B1-02b alone leaves candidates pending that nothing builds). Each after CC's re-run of `npm test`, `npm run test:compass`, and `npx vitest run --maxWorkers=1` (standing approval b).

Planner difficulty (fixed before each task starts, for the ledger): S3-B1-01 medium; S3-B1-02a easy; S3-B1-02b medium; S3-B1-03 medium; S3-B1-04 easy. Sizing: S3-B1-01 peaked at 143,667 tokens of context, so each later spec keeps a shorter read list.

**B-1 gate:** all five accepted and committed; P10 in bugs.md FIXED with commit and evidence; stage-3-task.md B1.1–B1.4, B2.3 (a, c), B2.6 checked; stage.md synced; report to the user before B-2.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.1.0 | 2026-10-15 | B-1 task specs (S3-B1-01 to S3-B1-04) and protected text T1–T4, for approval. |
| 0.2.0 | 2026-10-15 | Approved by the user, with T1–T4. |
| 0.3.0 | 2026-10-15 | S3-B1-02 split into 02a (module) and 02b (scanner wiring, reset) for the ~100K context target; type-fix scope added (user-approved). |
