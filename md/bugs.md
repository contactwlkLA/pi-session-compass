# pi-session-compass — Bug journal

Revision: **0.4.0** · Updated: **2026-10-14**

A live record of every bug found while building and running the harness: harness, pipeline, test, or environment. Add an entry when a bug is found; update its status, fix commit, and evidence when it changes. Never delete an entry; a closed bug stays as history. Pipeline behaviors that a stage is meant to change are listed separately under Pipeline findings.

Status: **OPEN**, **FIXED** (commit), **WORKAROUND**, **WATCH** (seen once, not reproduced), **WONTFIX** (with reason).

## Harness and tests

| ID | Found | Area | Symptom | Cause | Status | Evidence |
|---|---|---|---|---|---|---|
| B1 | 2026-10-13 | harness | A crash before the try lost recorded sink errors from the receipt | Sink guard created inside the try | FIXED b48e557 | tests/compass/receipt-sink-errors.test.ts |
| B2 | 2026-10-14 | tests | llm-call backoff tests hit the 30 s timeout in 5 of 20 default-order runs | agentLoop mocked per file, lost across `vi.resetModules` | FIXED 12f199d (0 of 20 after) | stage-1-task.md T1.6 record |
| B3 | 2026-10-14 | harness launch | `node` refused to load `avtc-pi-settings-ui` (raw `.ts` under node_modules); `--import jiti/register` exposed only default exports | Node type stripping excludes node_modules; jiti's ESM hook wraps transpiled TS as a default export | WORKAROUND: launch through `node_modules/.bin/jiti scripts/compass/run.ts` (installed jiti, no package change) | stage.md harness launch |
| B4 | 2026-10-14 | harness | Re-running into an existing output dir failed with EACCES on `.git/objects` | `restoreSnapshot` copied over read-only git objects | FIXED 7331091 | tests/compass/start-snapshot.test.ts |
| B5 | 2026-10-14 | harness | Smoke attempt 1: 0 requests, 0 sequences | Isolated session root pointed one level too deep; discovery reads `<root>/<project>/*.jsonl` | FIXED 8585d0d | outputs/s1-t4/smoke-attempt1-no-discovery/; tests/compass/compass-harness.test.ts |
| B6 | 2026-10-14 | harness | Smoke attempt 2 exited 1 at the request cap with no receipt or traces | The cap guard threw inside pi-agent-core's detached loop promise: unhandled rejection | FIXED 2889423 (refused stream ends in an error message) | outputs/s1-t4/smoke-attempt2-cap-crash/; tests/compass/offline-boundary.test.ts |
| B7 | 2026-10-14 | tests | Offline cap/deadline checks passed while the live cap crashed | The checks called the counter directly, not through the real agentLoop | FIXED 2889423 | scripts/compass/offline-check.ts |
| B8 | 2026-10-14 | harness | A failed provider response (stopReason error/aborted) traced as `ok` | Counter did not read the response's stopReason/errorMessage | FIXED 095bfe2 | tests/compass/limits-counter.test.ts |
| B9 | 2026-10-14 | harness | Manifest `dirty: true` from untracked `private/` | `git status --porcelain` counted untracked files | FIXED 095bfe2 | tests/compass/start-snapshot.test.ts |
| B10 | 2026-10-14 | harness | Baseline attempt 1 stopped after 2 of 26 trios, "completed" | Harness ran one pipeline pass; the extension resumes on later timer ticks | FIXED da9987a (passes re-run until the scope is exhausted) | outputs/s1-t5/baseline-attempt1-one-pass/; tests/compass/running-table.test.ts |
| B11 | 2026-10-14 | harness | Results-sheet builder lines read `[insert] C1`, not the rule text | Sheet prints `decision.text ?? decision.candidate`; inserts carry only the candidate ID | OPEN (the final diff has the text) | outputs/s1-t5/baseline/results-sheet.md |
| B12 | 2026-10-14 | tests | One full `npm test` run failed 14 tests in tests/pipeline.test.ts ("expected +0 to be 1") | Unknown; order-dependent | WATCH (rerun passed; 0 of 20 default-order runs) | stage-1-task.md T1.6 record |
| B13 | 2026-10-13 | harness | A corrupt `hashes.json` exits 1 with a stack trace instead of the clean start-snapshot refusal | JSON parse error not mapped to SnapshotError | OPEN (no model call is made) | handoff 2026-10-14 |
| B14 | 2026-10-13 | harness | `RUN_TYPES` lacks `probe` | Added to the plan after the harness types | OPEN (needed before S2.T4) | scripts/compass/types.ts |
| B15 | 2026-10-14 | harness | Confirmation minutes print the raw division (100000 ms → 1.6666666666666667 min) | `confirmLimits` divides without rounding | OPEN (protected text; needs approval to change) | scripts/compass/strings.ts |
| B16 | 2026-10-13 | tests | MaxListenersExceededWarning in `npm test` | Not investigated | OPEN | npm test output |

## Pipeline findings (src/, measured in S1; targets of later stages)

| ID | Found | Observation | Evidence | Planned handling |
|---|---|---|---|---|
| P1 | 2026-10-14 | 98 of 150 baseline requests came after the attempt's first return-tool call; one build attempt called its return tool 9 times (188 s) | outputs/s1-t5/baseline-attempt2-report.md | S2.T2: fixed 54620a4 (the four return tools set `terminate: true` on success, verified offline); live effect measured in S2.T3 |
| P2 | 2026-10-14 | 8 zero-output responses (no output tokens: 5 `stop`, 2 `aborted`, 1 `toolUse`), most after 56–69 s; first build attempts failed this way in smoke and baseline | same report; outputs/s1-t4/smoke-result.md | Counted in S2 (not fixed): 1 in the compare run (outputs/s2-t3/compare-report.md) |
| P3 | 2026-10-14 | 9 failed building attempts with the message "LLM did not call the required extraction tool" (the message names extraction for the building stage) | outputs/s1-t5/baseline/traces.jsonl | S2.T2.4: fixed de8b168; user-approved wording `LLM did not return a result through <tool>` |
| P4 | 2026-10-14 | `runPipelineLoop` returns after its first productive sequence when it came from the last discovered file (`remainingFiles` counts only later files); the rest waits for the next timer tick | src/collector.ts `scanSessions`; B10 | Recorded; S3 replaces the scan position |
| P5 | 2026-10-12 | `retries: N` means N attempts in total, so `retries: 0` makes no attempt | plan.md S2.T2 | S2.T2: fixed 54620a4 (1 + N attempts); tests/llm-call.test.ts |
| P6 | 2026-10-14 | Return-tool captures live in closures that are never reset, so a retry or validation round with no valid tool call returns the previous round's capture as a success | outputs/s2-t1/termination-note.md | S2.T2: fixed 54620a4 (results count only after a terminating capture in the current attempt); tests/llm-call.test.ts |
| P7 | 2026-10-14 | The pipeline examines 20 of the census's 26 trios: after a productive trio, `scanSessions` sets the checkpoint past the trio's closing assistant record (collector.ts, `prevByte + bytesScanned`), and the next pass starts with a fresh detector, so a following trio that opens with that record is never detected. Affects S1 baseline and S2 compare equally; the S1 report's "trios 21–26 not examined" is wrong (the baseline reached every trio the pipeline can reach) | outputs/s2-t3/compare-report.md; outputs/s2-t3/trio-loss-replay.ts | S3.T3 (trio-boundary scan position, adjacent trios) |
| P8 | 2026-10-14 | The scanner's `catch` around each record wraps both `JSON.parse` and the trio's extraction, post-review, `onTrio`, and checkpoint save; any error other than PAUSED is swallowed as a "malformed line", the scan continues, and the next productive trio moves the checkpoint past the failed one | src/collector.ts streamAndExtract (try/catch around `detector.process` and `tryExtractTrio`) | S3 Part A (A1: narrow the catch to parsing) |
| P9 | 2026-10-14 | Scanner byte accounting can put the resume offset mid-record: an unterminated final line (a record still being written) is parsed, fails, and is counted as `length + 1` bytes; blank lines are skipped without counting; CRLF line ends count one byte short | src/collector.ts streamAndExtract `bytesRead`, scanSessions `prevByte + bytesScanned` | S3 Part A (A1: read only complete newline-terminated records with exact byte offsets) |
| P10 | 2026-10-14 | A failed extraction (no valid return after retries) returns empty notes, so it is recorded as an empty result and the checkpoint advances past the trio | src/collector.ts callExtractionLlm `if (!result)` | S3 Part B (B1: typed outcomes) |

## Environment

| ID | Found | Observation | Status |
|---|---|---|---|
| E1 | 2026-10-12 | On /mnt/i the suite also failed extension-idempotency, cache-refresh and reload-lifecycle | Moved to the native filesystem (~/compass-ext4) |
| E2 | 2026-10-14 | The user's own Pi session writes ~/.pi/portrait/instance.lock.sqlite-journal during runs | Exclude lock files when comparing live-portrait hashes |
| E3 | 2026-10-14 | Pi CLI 1.2.0 is available; 1.1.0 is installed and recorded | Upgrade only with the user's approval, at a stage boundary |

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.2.0 | 2026-10-14 | P6 (stale captures) added; P1, P3, P5, P6 fixed in S2.T2. |
| 0.3.0 | 2026-10-14 | P7 (adjacent trios lost across passes) added; P2 counted in the compare run. |
| 0.4.0 | 2026-10-14 | P8–P10 (scanner catch scope, byte accounting, failed extraction recorded as empty) added. |
