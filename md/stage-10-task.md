# Stage 10 — One name

Project: **pi-session-compass** · Revision: **0.1.0** · Status: **In progress**

Date: **2026-10-18**

Parent: [plan.md](plan.md). Finding: [bugs.md](bugs.md) B28. Operating rules: [AGENTS.md](../AGENTS.md).

**Goal (M10):** every document, link, install line, and user-facing string uses the project's name, pi-session-compass, for this project, and avtc-pi-portrait only as attribution. One Names table ([compass.md](compass.md)) is the source of truth, and an independent model has checked the documents against it.

## Fixed design

1. **Rename names only.** `package.json` name and links, README title, install line, and credit, and the settings-screen title. No behavior change.
2. **Keep data paths.** `/portrait:*` commands, `~/.pi/portrait/`, the settings file `avtc-pi-portrait-settings.json`, and the log folder `~/.pi/logs/avtc-pi-portrait/` keep their names, so existing portraits, settings, and logs keep working.
3. **Protected text:** README lines and the settings-screen title are shown before and after and approved by the user before they are applied.
4. **Prevent it next time:** [project-init.md](project-init.md) fills the Names table before any other work.

## Tasks

- [x] **S10-01** Package metadata: `package.json` and `package-lock.json` name, repository, bugs, homepage, and gallery image point to pi-session-compass. *Done 2026-10-18: npm test 588/588, test:compass 282/282.*
- [x] **S10-01a** Package version: 1.1.1 (inherited from avtc) replaced by 0.10.0 (user, 2026-10-18): pre-1.0 as AGENTS.md requires, minor number = stage; each later stage that changes the package bumps the minor; 1.0.0 is the user's call.
- [x] **S10-02** Names table in compass.md; names step in project-init.md.
- [x] **S10-03** README and settings-screen title (protected text). *Done 2026-10-18: user-approved text applied: README title, "Based on" credit line, install line, sample-portrait link; `src/settings-ui.ts` title.*
- [ ] **S10-04** Independent audit: another model runs [audit_document_alignment.md](audit_document_alignment.md); CC checks each finding and the user decides the fixes.
- [ ] **S10-05** Install check: install from GitHub, confirm the extension loads, including the `../avtc-pi-ui-components/index.ts` extension path. Needs the user's approval (it writes to `~/.pi`) and a decision on the branch or ref the README names (`main` still holds the upstream base).

**Allowance:** 1–2 h, plus your approvals and the external audit.

## Revision history

| Revision | Date | Change |
|---|---|---|
| 0.1.0 | 2026-10-18 | Drafted after the naming mix-up (B28); S10-01 to S10-03 done. |
