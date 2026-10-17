# Stage 5 — Evaluate the Jev gate

Project: **pi-session-compass** · Revision: **0.5.0** · Status: **Approved (user, 2026-10-16)**

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
| S5-02 — Extraction cache, label sheet, scorer (coded as S5-02a extraction and S5-02b labels + scorer) | S5.T2, S5.T3 (tooling) | Extraction-only run per trio (concurrent, cached by trio and extractor revision, no building); label sheet export/import; offline policy scorer and threshold sweep | Pi |
| S5-02c — Reply codes (session-instrument idea, offline) | D4 evidence | `score.ts --questions <file>` sends a separate Jev question set (not the gate's); `codes.md` tallies codes per folder and session with top examples | Pi |
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

- **D4 — Labeling rule for task instructions and reminders: DECIDED, rule (b)** (user, 2026-10-17, after the reply-code evidence below; rubric in label-rubric.md). A task instruction is `no_lesson` unless it states a lasting preference; corrections, hold-backs, and mid-session hold-back reminders are `lesson`. Earlier: kept open for concrete evidence. Evidence so far (dev set only): steering follows the user's reply (rank correlation +0.42 with its length; agent text +0.22 before, +0.09 after); 36 dev trios score steering ≥ 0.5 with the other three ≤ 0.20, nearly all one-off next steps (option picks, task commands, questions, pasted shell commands). Candidates: (a) reviewer: a task instruction is `no_lesson` unless it states a lasting preference; (b) CC: also count corrections and repeated reminders about agent behavior ("wait for my go", "don't run ahead") as `lesson`. The user sees these reminders as frustration with models that run ahead, not as lessons, and doubts the portrait's usefulness unless the labeling changes. Related fact: the S1-start portrait already holds such rules ("Require explicit user approval … before executing consequential actions", "Respect requested scope … unsolicited implementation", "Distinguish exploration from execution"), yet the reminders recur. Reply codes (S5-02c, all 339 trios, set reply-codes-v1, outputs/s5/codes-all/): task_step 264, correction 105, approval 40, hold_back 23, chatter 9 (≥ 0.50; 110 trios carry two or more codes). 166 trios are task-step only, and the extractor found ≥ 1 rule in 117 of them, so rule (a) would drop those rules. 23 trios hold the agent back (20 with rules), spread over 11 of 27 sessions; rule (b) would keep them. Labels (S5-03 item 2) wait for D4; S5-02a/b and the extraction run do not depend on it.

## Tasks

### S5-01 — Corpus and gate scoring (Pi; spec to follow)

- [x] **1.** Corpus freeze: copy, receipt, census per file.
- [x] **2.** Session-level split with a seeded hash; frozen split file.
- [x] **3.** Gate-only scoring of a set: probe.ts generalized to many files, 4 concurrent, gate cache, counter and limits, results in jsonl and a table.
- [x] **4.** Tests: split is stable and leak-free; a cache hit makes no request; the limit stops new requests; no key in any artifact.

### S5-02 — Extraction cache, label sheet, scorer (Pi; spec to follow)

- [x] **1.** Extraction-only run per trio (no building), 4 concurrent, extraction cache, counted and limited.
- [x] **2.** Label sheet export (trio text, scores, extractor rules, blank label columns) and import back to jsonl.
- [x] **3.** Offline scorer: for a policy (thresholds, routing rule), report rejections, kept `lesson` trios, correction misses, and projected extraction savings; a threshold sweep that refuses to run on held-out labels.
- [x] **4.** Tests for each, with mocked requests.

### S5-02c — Reply codes (Pi; spec in stage-5-specs.md) *(user, 2026-10-17: a minor tweak, go ahead)*

The session-instrument skill's idea (count what kind of exchange each user reply is) measured offline from the session logs, not self-reported by the live agent. Harness only; the gate, its policy hash, and the plugin do not change.

- [x] **1.** `score.ts --questions <file>`: score a set with a question set from a file; its own cache and hash; no gate verdicts.
- [x] **2.** `codes.md`: per folder and per session, how many replies answer yes (≥ 0.50) to each code, plus the top replies per code.
- [x] **3.** Tests (mocked).
- [x] **4.** CC: score the pilot corpus with the reply-code set (user-confirmed limits); report the tally as D4 evidence.

### S5-03 — Score, extract, label (CC + user)

- [x] **1.** Live gate scoring and extraction on dev and held-out (run type `evaluate`; limits suggested at launch, user-confirmed).
- [x] **2.** Labels per D2; label and split files frozen with sha256 before any tuning.

### S5-04 — Tune and test (CC)

- [x] **1.** Tune on dev (design 8). Any question rewording goes to the user for approval first.
- [x] **2.** Freeze the chosen policy (hash), then score held-out once.
- [x] **3.** Audit all held-out misses and all predicted rejections (up to 200, sampled uniformly if more). *Done 2026-10-17: policy without-steering-0.30 (correction, preference, confusion all ≤ 0.30; steering ignored), chosen on dev (88 of 207 rejected, 60 of 60 lesson kept, 0 correction misses) and frozen with the labels (outputs/s5/freeze.json). Held-out once: 59 of 132 rejected, 29 of 30 lesson kept (97%), 0 of 17 corrections missed; the one miss is a hold-back reminder ("no action, ans only", all four answers ≤ 0.22). All 58 rejected `no_lesson` trios were user-checked. Evidence outputs/s5/heldout-test/.*
- [x] **3a.** S5-04a (Pi; spec in stage-5-specs.md; user chose it 2026-10-17): the shipped gate decides on correction, preference, and confusion at 0.30, so enforce runs the tuned policy.
- [x] **4.** One paired run on the same held-out slice from the same start snapshot: `off` and `enforce`, for measured total cost (limits user-confirmed). *Done 2026-10-17 on held-out 01a0b72d (19 trios): off 44 Meta requests, 23.9 min, $0.035 at the models.json rates; enforce 22 Meta + 19 Jev requests, 14.7 min, $0.018 Meta plus Jev (price unrecorded; break-even about $0.0009 per Jev request); portrait +15 vs +10 rules. Evidence outputs/s5/paired-report.md.*

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
| 0.3.0 | 2026-10-17 | D4 (labeling rule for task instructions and reminders) recorded as open; labels wait for it. |
| 0.4.0 | 2026-10-17 | S5-02c reply codes (session-instrument idea, offline) added (user). |
| 0.5.0 | 2026-10-17 | S5-02c done; D4 decided (rule b); labels frozen; policy tuned and tested; S5-04a added. |
