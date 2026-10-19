# pi-session-compass — Audit: document and name alignment

Revision: **0.1.0** · Date: **2026-10-18** · For: an independent reviewer model (read-only)

## Why this audit exists

This project's names got tangled. The project is **pi-session-compass**, but the package, the README, and one settings-screen title kept the name of the plugin it is based on, **avtc-pi-portrait**. A quick-start draft then told people to install avtc's original plugin instead of this project. The same kind of tangle has happened in earlier projects. Your job is to find every place where a name, a link, or an instruction points at the wrong thing.

## Rules for you

- **Read only.** Do not edit, commit, install, or run anything that writes. Report findings; the user decides the fixes.
- Do not enter `./private`, `outputs/`, `fixtures/`, `node_modules/`, or anything under `~/.pi` or `~/.claude`.
- Scope: every tracked file (`git ls-files`), mainly `README.md`, `docs/`, `md/`, `AGENTS.md`, `package.json`, `src/`, `scripts/`, and `tests/`.
- The source of truth for names is the **Names** table in [compass.md](compass.md). Audit that table too: if it is wrong or incomplete, say so.
- Quote what you find, with `file:line`. Mark anything you could not verify as unverified.

## Names (copied from compass.md for convenience; compass.md wins on any difference)

| Thing | Name |
|---|---|
| This project and its package | pi-session-compass (`github.com/contactwlkLA/pi-session-compass`) |
| The plugin it is based on | avtc-pi-portrait by avtc (attribution only) |
| The feature | portrait (`/portrait:*`, `~/.pi/portrait/`) |
| Kept upstream identifiers | `~/.pi/agent/avtc-pi-portrait-settings.json`, `~/.pi/logs/avtc-pi-portrait/` |
| Development harness | compass harness (`scripts/compass/`, `tests/compass/`) |
| Working method | compass document set (AGENTS.md, `md/`) |
| Local checkout | `compass-ext4` (a folder name, never the project's name) |

## State when this audit was written

- `package.json` and `package-lock.json`: name, repository, bugs, homepage, and gallery image now point to pi-session-compass. Both full suites passed after the change (`npm test` 588/588, `npm run test:compass` 282/282).
- `README.md` title, install line, and sample-portrait link, and the settings-screen title in `src/settings-ui.ts`, now say pi-session-compass (user-approved text). README credits avtc-pi-portrait in a "Based on" line.
- The project's work is on branch `s1/harness`. `main` still holds the upstream base (5cf30f5), so `pi install git:github.com/contactwlkLA/pi-session-compass` without a ref would install upstream code. Unverified.
- `package.json` `pi.extensions` lists `../avtc-pi-ui-components/index.ts`, a path outside the package root. It resolves when the package sits in `node_modules` next to that dependency (npm install). Whether it resolves for a git or local-path install is unverified.

## Checks

For each check, list every finding, or write "none found".

1. **Right name for the right thing.** Each use of `pi-session-compass`, `avtc-pi-portrait`, `portrait`, `compass`, and `compass-ext4` matches its meaning in the Names table. Allowed: avtc-pi-portrait as attribution; the kept settings-file and log-folder names; history in `md/` that describes what was true at the time (for example, "the user removed avtc-pi-portrait from the Pi runtime").
2. **Bare "compass".** Each use of "compass" on its own: say which meaning it has (project, harness, or document set) and whether a reader could take it for another.
3. **Install and usage instructions install this project.** Every install command, link, and "how to use" line leads to pi-session-compass, not to the upstream npm package or repository, and states any branch or ref it needs.
4. **Links resolve.** Every repository, issue, raw-file, and document link points to a place that exists for this project (for example, the cover image and `assets/portrait.sample.md` on the branch the README names).
5. **Attribution kept.** avtc's copyright and license notices are kept (LICENSE, SPDX headers, README credit), and nothing presents avtc's work as this project's, or this project's changes as avtc's.
6. **Upstream content under this project's name.** Sections of README written by and about the upstream author (for example, "Full suite" and the "Developed with" referral link): flag each, and say whether it reads as this project's own claim.
7. **User-facing strings in `src/`.** Every name a user sees (settings screen, notifications, status lines, errors, log folder) matches the Names table.
8. **Product docs stay clean.** `README.md` and `docs/CONFIGURATION.md` carry no design-doc references, no history wording ("formerly", "is now", "no longer", "has moved to"), no stage IDs, and no local paths such as `/home/...` or `compass-ext4`.
9. **Planning docs agree with each other.** `md/compass.md`, `md/project-init.md`, `md/handoff.md`, `md/stage.md`, and `md/plan.md` describe the same project, package, repository, and branch.
10. **Missing names.** Things that have a name in use but no row in the Names table (for example, the Jev gate, the session report, the ledger). Say whether each needs a row.

## Commands that help (all read-only)

```bash
git ls-files | xargs grep -n -I -i 'avtc-pi-portrait'
git ls-files | xargs grep -n -I -i 'pi-session-compass'
git ls-files | xargs grep -n -I -w -i 'compass'
git ls-files | xargs grep -n -I 'compass-ext\|/home/'
git ls-files | xargs grep -n -I 'github.com/'
git show main:package.json | head -5
git log --oneline -1 main; git log --oneline -1 s1/harness
```

## Report format

One table, most serious first:

| # | Check | File:line | What it says (quoted) | What it should say or point to | Severity |
|---|---|---|---|---|---|

Severity: **wrong** (sends a reader to the wrong thing, or claims something untrue), **ambiguous** (a reader could take it two ways), **minor** (wording only). After the table, write one paragraph on whether the Names table itself is complete and correct, and one line per unverified item.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.1.0 | 2026-10-18 | First version, written with the package rename. |
