# UI/UX review (2026-11-09)

A first-time-user pass over the vHIL: the editor workspace (`/editor/`), runs
and replay, the CLI, the desktop app and the onboarding docs. The goal is a
tool a new team member (for example someone bringing up the SensorHub) can
use without asking. This is a proposal: nothing here is implemented.

**How it was reviewed.** The web app and editor ran locally from `dev`
(038ee17) with `docker compose` in dev auth mode (api, editor, proxy; no
worker, so no new runs and no firmware builds). Tasks walked in the browser:
open the app, create a system, add a board and a CAN bus, Check, switch
systems, open a past run, read State and Bus. Wiring ports by drag could not
be driven from the test browser, so wiring was reviewed from code. The CLI was
fed seven broken system files in the `ifs-vhil` image. The desktop app and
the docs were reviewed from source. SensorHub is not on `dev` yet (#384–#387),
so its path was reviewed from those branches. Screenshots: `docs/img/ux-review/`.

## What already works

- The State view explains itself: a run that ends in the bootloader shows
  "in bootloader · the app starts at 2 s" instead of blank values
  ([05](img/ux-review/05-state-in-bootloader.jpg)).
- Most `validate` messages say what and where: "board 'ecu': a mainlite
  needs a role (ecu, ams, udv)", "bus 'can_a' is can but 'ecu.PB9' is gpio".
- Run is blocked with a reason when the system is unsaved
  (`editor-run.js:61-67`), and empty states exist for Runs, State, Scenario
  and Artifacts.
- Keyboard shortcuts are complete and listed under `?`.

## Top findings

1. **The editor's own defaults fail its own Check.** A new CAN bus is named
   "CAN bus" (`vhil/editor.py:55`), and Check then reports
   `buses: 'CAN bus' does not match '^[A-Za-z_][A-Za-z0-9_]*$'` plus
   `buses.CAN bus.nodes: [] should be non-empty`. The first thing a new user
   adds is invalid, and the message is a regex
   ([03](img/ux-review/03-check-default-bus.jpg)).
2. **Unsaved work is dropped without a prompt.** Opening another system from
   the sidebar replaced a new, unsaved system; it was gone from the list. The
   only `confirm()` in the workspace is the branch takeover
   (`frontend/src/vhil/workspace.js:481`). Edits live only in the graph until
   "Commit…".
3. **"passed" can mean "nothing happened".** Run #5 of `ecu-ams` is green
   with 0 frames over 1.000 s: it ended inside the bootloader's 2 s window,
   so no app ran ([04](img/ux-review/04-passed-zero-frames.jpg)). A run with
   no expects passes when it reaches its end (`vhil/worker.py:1518`). The
   default "Run for 3000 ms" leaves 1 s of app time.
4. **Errors are not actionable at the edges.**
   - Web: a server-side failure shows as `could not open ux-test: 500
     Internal Server Error`; the cause (`GitError: the workspace has no
     commits`, `vhil/server/gitstore.py:114`) is only in the container log
     ([06](img/ux-review/06-create-500.jpg)).
   - CLI: a schema error dumps the whole parsed file, `{'kind': 'system',
     ...} is not valid under any of the given schemas`
     (`vhil/system.py:255`); a YAML typo prints a parser message with no
     file name (only `SystemError` is caught, `system.py:1504`); typos get
     no suggestion (`no connector or pin 'FDCAN9'` does not list FDCAN1–3,
     `no board 'mainlte'` does not offer `mainlite`); `validate -h` shows
     only `usage: system.py validate [-h] system`.
5. **No first-run guidance in the tool.** The welcome panel is turned off
   (`vhil/editor.py:121`), the canvas is empty with no hint, `?` lists only
   shortcuts, and Run is enabled with nothing open (it answers with a
   "Warning · Not run" toast; the reason is in the Log tab)
   ([01](img/ux-review/01-first-open.jpg)). A new system's first board lands
   half under the inspector and zoom buttons
   ([02](img/ux-review/02-new-system.jpg)).
6. **Two front doors, conflicting numbers.** README "Try it" uses
   `scripts/vhil-docker.sh`, CONTRIBUTING uses `bin/vhil`, and neither
   mentions the desktop app (only `docs/README.md:16` links it). First setup
   is "~15 min" in the app (`app/ui/app.js:97`) and "~30 min" in
   `bin/vhil:98` and `docs/development/setup.md:26`. The editor is at
   `:5000` in `setup.md:236` and `scripts/editor.sh:2`, but users reach it at
   `:8080/editor/`. The app waits 5 min for `ui` (`app/src-tauri/src/main.rs:35`)
   while a first image build can take ~30 min (inferred, not run).
7. **Vocabulary drifts between UI, docs and files.**

   | Concept | UI | Docs / CLI / file |
   |---|---|---|
   | saving | "Commit…", "Commit to branch" | "Save it to a branch" (`editor-run.js:62`), "Save" (`web-app.md:102`) |
   | checking | "Check" | `validate`, "valid system" |
   | attached chip | category "Models", pill "device" | `devices:` key, `catalog/models/` |
   | firmware branch | "app ref" | `firmware_ref` |
   | the app itself | "IFS vHIL", "workspace" | "editor", "shell", "web app" |
   | tests | "Tests", "Tests…", "Scenario tests" | scenarios, native tests |

8. **Internal jargon in the UI.** Bus properties "host netdev" and
   "arbitration" with no hint of when to touch them; "Sync 0.5 ms" in the top
   bar; Log lines from the graph library ("External application connected
   successfully", "Connection with communication server disrupted");
   "Scenarios of ux-test: no system 'ux-test'" on a new system; "1 id(s)
   declared differently by two firmwares" in Bus with no id named.
9. **Problems and Check are easy to misread.** Problems says "No problems:
   the system is valid." before Check has ever run. The Check button lives in
   the system inspector, which disappears while a node is selected, and
   clicking empty canvas does not deselect.
10. **The SensorHub path ends at "open the editor".** It has no catalogue
    firmware, `build` refuses (`system.py:296`), and the web app has no way
    to give a run an ELF, so a new user cannot run it from the UI at all;
    only `render --firmware` on the CLI.

## Proposed changes, ranked

Effort: S ≤ 1 day, M ≤ 1 week, L > 1 week.

| # | Change | Problem | Effort | Surface |
|---|---|---|---|---|
| 1 | Valid defaults: new buses get `can_1`, `can_2`…; a new bus with no nodes is a warning, not an error, until Run | Finding 1 | S | editor |
| 2 | Unsaved-changes guard: confirm before switching system, opening a branch or closing the tab; keep a local draft of a new system | Finding 2 | S | editor |
| 3 | Honest run results: "passed" only if expects ran; otherwise "completed" with a warning badge when no app started or 0 frames; default Run for 5000 ms or "N s after app start" | Finding 3 | S–M | worker, editor |
| 4 | Error translation layer: one formatter for schema errors (path + plain message + fix), used by CLI and editor; map server exceptions to their message, not 500 | Findings 1, 4 | M | `vhil/system.py`, `vhil/server/` |
| 5 | CLI polish: `help=`/`description=` on every subcommand, catch YAML errors with file:line, "did you mean" for board, connector and pin names, list valid connectors | Finding 4 | S | `vhil/system.py` |
| 6 | First-run panel: empty canvas shows "Open a system or create one", a 4-step getting-started card, Run disabled with a tooltip when nothing is open; centre and fit new nodes | Finding 5 | M | editor |
| 7 | One front door: README and CONTRIBUTING both start with the desktop app, then `bin/vhil`; one setup time; fix the `:5000` references; a "first 10 minutes" page that ends with CAN frames on screen | Finding 6 | S | docs |
| 8 | Glossary and naming pass: pick one word per row of the table above, apply it to UI labels and docs; add `docs/glossary.md` and link it from the `?` dialog | Findings 7, 8 | M | editor, docs |
| 9 | Property hints from the schema: fill missing `description`s in `schemas/vhil.schema.json` (system 4/11, firmware 2/11, platform 0/5) and show them as inspector tooltips | Finding 8 | M | schema, editor |
| 10 | Problems tab states "not checked yet" until Check runs; auto-check on edit (debounced); Check also in the top bar | Finding 9 | S | editor |
| 11 | Bring-your-own ELF for runs (upload or path in the worker's fw volume) so boards without catalogue firmware can run from the UI | Finding 10 | L | server, worker, editor |
| 12 | Desktop app: open only when images exist, show build progress, raise the 5 min wait or make it follow the build | Finding 6 | M | desktop app |
| 13 | Filter graph-library log lines out of the Log tab (or behind a "debug" source) | Finding 8 | S | editor |
| 14 | Name the id in "declared differently by two firmwares" and link to both definitions | Finding 8 | S | editor |

### Sprint 1 (about 2 weeks): stop the traps

Goal: a new user can create a system, Check it, run it and trust the result.

- **#1 Valid defaults.** `vhil/editor.py`: bus names from a counter
  (`can_1`…) instead of `BUS_NODE`; schema `minItems` stays, but the editor
  reports an empty bus as "bus can_1 has no nodes: wire a board's FDCAN to
  it". Done when a fresh "New system → add CAN bus → Check" shows one
  readable warning and no regex.
- **#2 Unsaved guard.** Workspace store: `beforeunload` plus a confirm on
  system/branch switch when `ws.dirty`; a new system's graph kept in
  `localStorage` until committed. Done when switching away asks, and a reload
  restores the draft.
- **#3 Honest results.** Worker: when a run has no expects, record
  `completed` (or `passed` with a `no-app` / `no-frames` flag) and show it as
  an amber badge in Runs. Default "Run for" 5000 ms. Done when run #5's case
  is amber with "the app never started (run ended at 1.0 s, auto-jump at 2 s)".
- **#5 CLI polish** and **#10 Problems states**: small, independent.
- **#7 One front door**: docs only; can go in parallel.

### Sprint 2 (about 2 weeks): make errors and words teach

- **#4 Error translation.** One `explain(error) -> (where, what, fix)` in
  `vhil/system.py` used by `validate`, the editor's Check and the API; FastAPI
  exception handler for `GitError` and `SystemError` returning their message.
  Done when the seven broken files used in this review each produce a
  one-line, file-and-key-located message with a fix.
- **#8 Glossary and naming** and **#9 schema descriptions**: one PR for
  words, one for tooltips.

### Later (ranked)

1. #6 First-run panel and node placement
2. #11 Bring-your-own ELF (unblocks SensorHub in the UI)
3. #12 Desktop app image/build progress
4. #13, #14 Log and Bus clean-ups

## Not covered

- Live sessions, Debug and Tests dialogs were reviewed from code and docs
  only (no worker was started, to avoid firmware builds).
- The desktop app was not installed or run; its findings are from source.
- Pointer-driven wiring on the canvas was not exercised.
