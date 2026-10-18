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
