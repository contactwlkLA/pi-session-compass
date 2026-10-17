# pi-session-compass — Implementation handoff

Revision: **0.1.0** · Date: **2026-10-17** · Status: **Draft for the S6 checkpoint**

Parent: [plan.md](plan.md) §8 (S6.T4, S6.T5). Stage record: [stage.md](stage.md). Bugs: [bugs.md](bugs.md).

## Delivered mode

**Gate mode `off`** (src/gate-config.ts `defaultMode`; settings key `gateMode`). Shadow and enforce are shipped and documented in README "Jev gate" but not enabled by default.

Unmet activation checks (outputs/s5/scale/scale-report.md, dashboard-v3 sample of 236 trios, user-checked labels):

| Check | Required | Measured | Met |
|---|---|---|---|
| 1. Corrections missed | none | 3 of 29 (implicit corrections phrased as requests, scored as steering) | no |
| 2. Lessons kept | ≥ 95% | 48 of 51 (94%) | no |
| 3. Total cost lower | lower than the ungated pipeline, measured | −47% cost, −38% time (one paired run, 19 trios; outputs/s5/paired-report.md) | yes |

The pilot held-out passed every check (0 of 17 corrections missed, 29 of 30 lessons kept; outputs/s5/pilot-report.md), but under D3 it was preliminary (30 lesson trios, below 60). Combined: lessons kept 77 of 81, corrections missed 3 of 46.

## Code

- Branch `s1/harness`, base `main` at 5cf30f5; 121 commits. Product code (src/, index.ts): 21 files, +2075 / −180. Release-candidate commit: the commit that adds this file (S6-03 checks ran on 0b9901b plus doc-only commits).
- Product changes, by stage: S2 termination and retry fixes (successful return-tool calls end the agent loop; `retries: 0` makes one attempt); S3 snapshots with simple rollback, typed extraction outcomes, pending candidates, trio-boundary scan position, whole-batch build validation, shared reset lock; S4 Jev adapter, off/shadow/enforce routing, one-file gate config; S5 frozen policy; S6 gate log (`<portrait dir>/gate-log.jsonl`).
- Harness (scripts/compass/, tests/compass/) is development tooling, not part of the package.

## Versions

| Item | Version |
|---|---|
| Package | avtc-pi-portrait 1.1.1 (`npm pack --dry-run`: 58 files) |
| Node | 24.19.0 |
| Pi CLI | 1.2.0 |
| @earendil-works/pi-agent-core, pi-ai, pi-coding-agent, pi-tui | 1.0.0 |
| avtc-pi-logger / avtc-pi-settings-ui / avtc-pi-ui-components | 1.0.3 / 1.0.12 / 1.0.7 |
| typebox | 1.3.27 |
| Dev: typescript, vitest, @biomejs/biome, knip, jscpd | 6.0.3, 4.1.10, 2.5.3, 6.26.0, 5.0.12 |
| Jev model | jev-1.13.0 (`https://api.typesafe.ai/v1/systemone`) |

## Tests

`npm test` 26 files, 560/560 (lint, typecheck, knip, dupes included); `npm run test:compass` 14 files, 216/216; both pass concurrent and single-worker (outputs/s6/exit-checks.md). Exit checks 1–8 pass. Open: B20 (one reload test passes without holding the lock), B21 (evaluator miss-bound denominator), B23 (one extra build request in the speed run, cause unconfirmed).

## Frozen policy and settings

- Policy `without-steering-0.30`, hash **f302de0ce97b**: skip when correction, preference, and confusion all score ≤ 0.30; steering is asked but ignored. Files: outputs/s5/policy/without-steering-0.30.json; freeze record outputs/s5/freeze.json (label and trio file digests).
- Gate config (src/gate-config.ts): state cap 32 KB, deadline 5000 ms, retry wait 500 ms, failure limit 3, four questions.
- Product defaults: src/schema.ts (docs/CONFIGURATION.md). Measured runs override `model` and `maintenanceModel` to `meta/muse-spark-1.3-contributor` at `thinkingLevel` high (each run's settings-snapshot.json).

## Fixtures and receipts

Local and gitignored (`fixtures/`, `outputs/`); keep the checkout's copies.

| Item | Path | Identity |
|---|---|---|
| S1 fixture session | fixtures/sessions/b75a1246a2ff-…019f732d….jsonl | sha256 b75a1246a2ff…, 26 trios |
| S1 start snapshot | fixtures/snapshots/s1-start | digest 51f057ec5cf3… |
| S5 pilot corpus | fixtures/s5-pilot | 30 sessions, 339 trios, seed s5-pilot |
| S5 scale corpus | fixtures/s5-scale | dashboard-v3, 699 trios (236 sampled, 463 untouched for a future held-out) |
| S1 baseline | outputs/s1-t5/baseline/receipt.json | 150 requests, 56.9 min, 20 trios, capped (accepted) |
| S2 compare | outputs/s2-t3/compare/receipt.json | 46 requests, 26.0 min, 20 trios |
| S5 paired run | outputs/s5/paired-off/, outputs/s5/paired-enforce/ | 19 trios; cost −47%, time −38% |
| S6 speed run | outputs/s6/speed/receipt.json | enforce: 65 requests, 26.1 min, 26 of 26 trios |

## Rollback

- **Gate off:** set `gateMode` to `off`; no Jev requests, every trio extracted; snapshots and recovery unchanged.
- **Bad portrait:** copy `portrait.md`, `evicted.md`, `dropped.md` from `snapshots/<CURRENT>/files/`, or restore from the portrait's git history; then `/reload`.
- **Downgrade to the upstream plugin:** not verified in S6. The legacy `processed-sessions.json` is kept in sync as a mirror of the scan positions, but pending candidates live only in the snapshot and an older plugin does not build them.

## Deferred

The rest of plan S6.T1 (settings and status help text, debug-path description, inert builder-prompt comments); the one-place settings view; a retuned policy for implicit corrections; B21; a verified downgrade path; README items from plan S6.T2 not in stage-6-task.md (input-file selection, explicit rescan).

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.1.0 | 2026-10-17 | First draft for the S6 checkpoint. |
