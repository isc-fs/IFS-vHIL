# Sharing a run

A finished run, saved as one file a teammate opens on their own machine
(#373, Sprint 3). Until the vHIL runs on a shared server, each laptop keeps
its own run history; a `.vhilrun` file carries a run from one to another.

## Export

- **App or browser:** in the editor's **Runs** view, ↓ next to a finished run
  saves `run-<id>-<system>.vhilrun`. The desktop app puts it in Downloads and
  shows it in the file manager.
- **Terminal:** `vhil export <id> [-o file|dir]` (default: the current
  directory).

A queued or running run can't be exported until it has finished.

## Import

- **App or browser:** **Import…** in the Runs view, or drop the file on the
  list. The run opens in the replay.
- **Terminal:** `vhil import <file>`.

An imported run is a new run here, with its own id. It's read-only and marked
*imported*; its tooltip says whose run it was, at which branch, and when it
was exported. It shows in Runs but not in the Tests view's last results (it
ran elsewhere), and the Debug tab has no firmware sources for it.

## What a file holds

A zip (`vhil/server/bundle.py`):

| Entry | What |
|---|---|
| `run.json` | `format` (1), who exported it and when, and the run's record: system, refs, firmware commits, scenario, state, summary |
| `contract.json` | the run's CAN contract, made where the firmware was built, so its frames decode on a machine that never built it |
| `results/` | the run's directory: `trace.jsonl`, JUnit, logs, the system snapshot |

The run's token (`runs.py`) is never in it: an import gets a new one.

## Limits and checks

An import refuses a file that isn't a bundle, a newer `format` than this vHIL
reads, a record whose fields don't check out, and any entry outside
`results/`, with `..`, or that is a link. It caps the upload at 1 GiB
(`VHIL_IMPORT_MAX_MB`), the unpacked size at twice that (counted as it
writes) and the files at 20 000.

## Later

Re-running an imported run here and comparing the two timelines (#373,
"Later").
