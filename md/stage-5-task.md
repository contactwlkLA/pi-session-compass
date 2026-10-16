# Stage 5 — Evaluate the Jev gate

Project: **pi-session-compass** · Revision: **0.2.0** · Status: **Approved (user, 2026-10-16)**

Date: **2026-10-16**

Parent: [Development plan](plan.md), Stage 5. Gate design: [stage-4-task.md](stage-4-task.md). Limits: [compass.md](compass.md). Operating rules: [AGENTS.md](../AGENTS.md). Bugs: [bugs.md](bugs.md).

**Goal (M5):** a reviewable decision, with held-out numbers, on whether the gate is worth enabling and under which policy. The ship default stays **off** unless the activation checks pass.

**Pilot first (user, 2026-10-16).** S5 runs as a pilot on two folders: TxnHunter-3 and agy-sessions-3 (30 sessions, about 350 trios). It proves the method and gives preliminary numbers. If the pilot shows the gate is worth it and the process is not a drag, a scale-up rerun on the largest folder, TxnHunter-dashboard-v3 (32 sessions, 744 replies), tests the frozen pilot policy on sessions the tuning never saw (S5-06).

## What we know (evidence, 2026-10-16)

1. **The shipped policy rejects nothing.** In the probe (outputs/probe/, 26 trios, policy `ad7880acdc3b`), 25 trios scored `maybe_lesson` and 1 fell back (`oversized_state`). The `steering` answer is ≥ 0.15 on every trio, even on "sure" (0.18), "yeah clean up plz" (0.19), and "it's in ./src_m3/" (0.21). The routing rule needs all four answers ≤ 0.10, so steering alone blocks every rejection.
2. **The extractor can't be the reference label.** In the S1 baseline it kept rules from 16 of 20 trios, including short replies. Human labels decide what counts as a lesson; extractor output is the second comparison (plan S5.T2).
3. **There is a corpus.** The live session store holds 180 session files and about 2,100 user replies across 23 project folders. That's enough for separate development and held-out sets.
4. **Gate calls are cheap; extraction is the cost.** A Jev call takes about 100 ms and about 1,000 input tokens. An extraction call runs at high thinking (S1: 150 requests and 56.9 min for 20 trios with building).

## How S5 runs

Pi codes two harness tasks from CC specs. CC runs the live scoring and extraction (user-confirmed limits each time), drafts labels, tunes on the development set only, and writes the report. The user approves the corpus, checks labels, and approves any change to the question text.

| Task | Plan tasks | Outcome | Who |
|---|---|---|---|
| S5-01 — Corpus and gate scoring | S5.T1, S5.T2 (freeze) | Frozen corpus copy, census, session-level dev/held-out split; gate-only scoring of a set (concurrent, cached by trio and policy hash) | Pi |
| S5-02 — Extraction cache, label sheet, scorer | S5.T2, S5.T3 (tooling) | Extraction-only run per trio (concurrent, cached by trio and extractor revision, no building); label sheet export/import; offline policy scorer and threshold sweep | Pi |
| S5-03 — Score, extract, label (dev + held-out) | S5.T2, S5.T3 | Gate scores and extractor output for both sets; labels drafted and checked; split and labels frozen before tuning | CC + user |
| S5-04 — Tune on dev, then test once on held-out | S5.T3, S5.T4 | Policy chosen on dev; one held-out evaluation; audit of rejects and misses; one paired off/enforce run for measured cost | CC |
| S5-05 — Pilot report | S5.T5 | Decision report with numerators, denominators, bounds, cost, and limitations; go/no-go for the scale-up | CC |
| S5-06 — Scale-up (if the pilot says go) | S5.T3–T5 | The frozen pilot policy scored on TxnHunter-dashboard-v3 (sampled for labeling); final activation report | CC + user |

## Fixed design

1. **Corpus.** Copy the approved session files into `fixtures/corpus/` (gitignored), with a receipt listing source paths and sha256 hashes. The live store is only read, never written. Every later step reads the copy.
2. **Split by session, before any tuning.** Assign each session file to dev or held-out by a seeded hash of its session ID (about 50/50), so trios from one session never land in both sets. Freeze the split file with its sha256. The held-out set is not looked at while tuning.
3. **Trios come from the census, not the scan.** Scoring and extraction enumerate trios the way the census does (as probe.ts does), so the scan bug that drops 6 of 26 trios (bugs.md P7) doesn't shrink the sets.
4. **Caches.** Gate results are keyed by `trioId` + policy hash. Extraction results are keyed by `trioId` + extractor revision (prompt hash + model + thinking level). A cache hit makes no request and counts zero. Both caches live under `outputs/s5/cache/`.
5. **Concurrency (harness only).** Scoring and extraction issue up to 4 requests at once. Every request still passes the request counter before it starts. Building stays sequential, and the plugin stays sequential (architecture.md §3).
6. **Labels.** One label per trio: `lesson` (a reusable lesson about how the user wants the agent to work) or `no_lesson`, plus a `correction` yes/no flag. Each label records its source (`user` or `cc-draft, user-checked`).
7. **Sizes, set before tuning (rule of three).** Held-out needs at least 60 trios labeled `lesson` (a miss rate bound of about 5%) and records how many are corrections. If the held-out set comes out smaller, the result is preliminary and the gate stays in shadow.
8. **Tuning order.** First the routing rule and thresholds, computed offline from cached scores (free). For example: per-question thresholds, or leaving `steering` out of the rejection rule. Rewording a question comes second, only if the first step can't meet the checks. New question text is protected text and needs approval; it gives a new policy hash, so the dev set is rescored.
9. **Activation checks (plan S5.T5):** no held-out correction misses; ≥ 95% of held-out `lesson` trios kept; lower measured total cost than the repaired ungated pipeline (gate + extraction + building, from the paired run).

## Decisions (user, 2026-10-16)

- **D1 — Corpus:** TxnHunter-3 and agy-sessions-3 for the pilot. compass-ext4 and .pi-agent stay out (they are about this tool). Sessions found later in a backup can join only before the split is frozen.
- **D2 — Labels:** CC drafts every label from a written rubric. The user checks every trio drafted `no_lesson`, every disagreement with the extractor, and a 10% random sample of the rest; the sheet records what the user changed.
- **D3 — Size:** every trio in the two pilot folders. The pilot result is labeled preliminary if held-out has fewer than 60 `lesson` trios or few corrections.

## Tasks

### S5-01 — Corpus and gate scoring (Pi; spec to follow)

- [ ] **1.** Corpus freeze: copy, receipt, census per file.
- [ ] **2.** Session-level split with a seeded hash; frozen split file.
- [ ] **3.** Gate-only scoring of a set: probe.ts generalized to many files, 4 concurrent, gate cache, counter and limits, results in jsonl and a table.
- [ ] **4.** Tests: split is stable and leak-free; a cache hit makes no request; the limit stops new requests; no key in any artifact.

### S5-02 — Extraction cache, label sheet, scorer (Pi; spec to follow)

- [ ] **1.** Extraction-only run per trio (no building), 4 concurrent, extraction cache, counted and limited.
- [ ] **2.** Label sheet export (trio text, scores, extractor rules, blank label columns) and import back to jsonl.
- [ ] **3.** Offline scorer: for a policy (thresholds, routing rule), report rejections, kept `lesson` trios, correction misses, and projected extraction savings; a threshold sweep that refuses to run on held-out labels.
- [ ] **4.** Tests for each, with mocked requests.

### S5-03 — Score, extract, label (CC + user)

- [ ] **1.** Live gate scoring and extraction on dev and held-out (run type `evaluate`; limits suggested at launch, user-confirmed).
- [ ] **2.** Labels per D2; label and split files frozen with sha256 before any tuning.

### S5-04 — Tune and test (CC)

- [ ] **1.** Tune on dev (design 8). Any question rewording goes to the user for approval first.
- [ ] **2.** Freeze the chosen policy (hash), then score held-out once.
- [ ] **3.** Audit all held-out misses and all predicted rejections (up to 200, sampled uniformly if more).
- [ ] **4.** One paired run on the same held-out slice from the same start snapshot: `off` and `enforce`, for measured total cost (limits user-confirmed).

### S5-05 — Pilot report (CC)

- [ ] **1.** Pilot report in outputs/s5/: checks with numerators and denominators, the rule-of-three bound, measured cost, labeling and run cost (kept separate from operating cost), time spent, and corpus limitations.
- [ ] **2.** Sync stage docs; checkpoint with the user: scale up (S5-06) or stop.

### S5-06 — Scale-up (CC + user; only on the user's go)

- [ ] **1.** Corpus freeze and census of TxnHunter-dashboard-v3; label a uniform sample sized to the activation checks (design 7).
- [ ] **2.** Score with the frozen pilot policy (no tuning on this folder); run extraction on the sample; audit as S5-04 item 3.
- [ ] **3.** Final activation report; sync stage docs; checkpoint with the user before S6.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.1.0 | 2026-10-16 | Draft: evidence, five tasks, fixed design, decisions D1–D3. |
| 0.2.0 | 2026-10-16 | Pilot on TxnHunter-3 + agy-sessions-3; D1–D3 decided; S5-06 scale-up on TxnHunter-dashboard-v3 after a go. |
