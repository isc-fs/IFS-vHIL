# ISC vHIL for VS Code

The vHIL's tests in VS Code's **Testing** panel: every test of `tests/unit`,
`tests/sim` and `tests/scenarios`, with Run and Cancel per test, file or
folder, one **status bar** item that says where things stand and runs
the tests again, and a **Systems** view (the vHIL icon) to open, run and
make systems. Runs go through `scripts/vhil-docker.sh` in the vHIL's Docker
image, as CI's jobs do, so the host needs Docker only (on macOS, the Colima
VM `scripts/vhil-docker.sh vm` makes).

## Before you start

- **Docker.** On macOS: `brew install colima docker docker-compose`; the
  extension starts the Colima VM itself. On Linux, Docker with vcan loaded.
- **The first run is heavy:** it pulls the vHIL's images (several GB; keep
  ~10 GB of disk free). Only when no image is published for your vHIL
  checkout does it build Renode from source instead (~30 min). The status
  bar says `vHIL: images needed` until then (click: pull them now).
- **Debug Test** needs the C/C++ extension (`ms-vscode.cpptools`) and the
  host's `arm-none-eabi-gdb` (`vhil.gdbPath`).
- `bin/vhil doctor` in the vHIL checkout checks the host; **vHIL: Diagnose**
  does the same from VS Code.

## Install

The newest extension, from the vHIL's `vscode-latest` release:

```sh
curl -fsSLo /tmp/vhil-tests.vsix https://github.com/isc-fs/IFS-vHIL/releases/download/vscode-latest/vhil-tests.vsix
code --install-extension /tmp/vhil-tests.vsix
```

(or **Extensions → … → Install from VSIX…** on the downloaded file). Every
change merged into `dev` is released: `vscode-v<version>` keeps each one, to
go back to. Once a day the extension looks for a newer one and offers to
install it (**vHIL: Check for extension updates** does it now;
`vhil.checkForUpdates` turns it off). A pull request's `.vsix` is its `vscode`
run's artifact. To build it yourself:

```sh
cd vscode && npm ci && npm run package
code --install-extension vhil-tests-*.vsix
```

Then open either:

- **A firmware repository** the catalogue builds (`IFS08-CE-ECU`,
  `IFS08-CE-AMS`, `IFS09-DV-uDV`, `stm32-can-bootloader`): you test your
  working tree, below. Nothing else to open.
- **The IFS-vHIL checkout**, to work on the vHIL itself: every test, the
  firmware from its refs.

## In a firmware repository

The extension recognises the repository by its `origin` or, in a fork, its
`upstream` (the catalogue's `repo:` in `catalog/firmware/`) and keeps its
own checkout of the vHIL in VS Code's extension storage: cloned the first
time, brought to `vhil.ref` (`dev`) once a day or with **vHIL: Update the
vHIL checkout**. It only fetches anything for a repository on the vHIL's
GitHub owner. A folder with an STM32 project (a top-level `.ioc`) it can't
set up shows `vHIL: not set up` in the status bar with the reason (not on
the owner, not in the catalogue, the clone failed); click it, or **vHIL:
Set up / Retry**, to try again.

- **What you test is your working tree.** Before each run of sim or
  scenario tests, it builds the open folder, uncommitted edits included,
  with the catalogue's recipe in the vHIL's image (`FW_LOCAL`,
  `vhil.system build --source`): a copy of the tree under `/vhil/fw/<id>@local`,
  incremental, your own `build/` left alone. A build error fails the run's
  tests with its last lines. The first run also builds what the tests need
  besides (the ECU, the AMS, the bootloader) from their refs.
- **The Testing panel lists the tests that run your firmware:** the sim
  tests with its marker (`ecu`, `ams`, `udv`; `bootloader` for the CAN
  bootloader) and the scenarios of the systems it is in. The unit tests,
  which test the vHIL itself, are left out.
- **The status bar** shows `vHIL ecu@local*` (`*`: uncommitted changes).

## Use

1. **Edit and save** your firmware.
2. **Run**: the Run button in the Testing panel (a test, a file, a system's
   scenarios, everything), or click the status bar to run the last run
   again. Docker is checked first (on macOS the Colima VM is started),
   images are pulled and missing firmware built as needed.
3. **Watch**: results come in as each test ends; the status bar counts
   (`vHIL 12/40`, then `vHIL 42` or `vHIL 3 failed`). A failure shows at
   its line, with the test's output. VS Code's Test Results keep the history
   and **Rerun Failed Tests**.
4. **Understand a failure**: its message shows, under the assertion, where
   each board's firmware was (exception, task, fault registers, the C
   frames: those in your working tree open at their line) and the last
   frames on the bus before it, decoded with the firmware's own `.def`
   contract. A build error is in **Problems** at its line instead.
5. **See the buses**: the **vHIL Trace** panel (beside Terminal) shows the
   first failure of a run, or any test from **Show bus trace** (right-click
   it, or the link in its failure): one lane per CAN bus, pin or radio on
   virtual time, the failure marked; drag to zoom, filter by id, message,
   signal, bus or board, click a frame for its signals. The trace files
   (`docs/test-trace.md`) sit in `results/` of the vHIL checkout.
6. **Debug it**: **Debug Test** on a sim or scenario test (the Testing
   panel's debug button). The board (the open firmware's, else picked) waits
   before its first instruction; VS Code's debugger attaches with your
   `arm-none-eabi-gdb` (`vhil.gdbPath`; STM32CubeCLT ships one) through the
   C/C++ extension: set breakpoints in your C, continue, step. Every board
   stops while one is held, so no firmware timeout fires. Stop debugging and
   the test runs on to its result. With no breakpoint in a C, C++ or
   assembly file (or on a function), it stops at the app's `main`, after
   the CAN bootloader every board powers on through has handed over (a
   breakpoint on its address the session adds and removes): set
   breakpoints, then Continue. A vHIL checkout from before
   the debug hold says so instead of running. Limits: no memory or register
   writes (docs/debugger.md).

- **Testing panel:** the three folders; sim tests by file, scenarios by
  system. The pytest markers are tags (`@can`, `@system_ams`) for the
  panel's filter. The list comes from `pytest --collect-only` in the
  container (about 20 s) and refreshes when a test file changes.
  Right-click a system's scenarios: **Open a system in the system editor**.
- **Systems** (the vHIL icon in the activity bar): the stack's state
  (click: Diagnose), then each system you can test, with its boards. Click
  one to open it in the system editor; inline, **Open the system file**
  and **Run its scenarios**. **+** makes a new system: name it, then place
  boards and wire buses on the editor's empty canvas and save it with the
  editor's **Commit…** (a branch and PR on IFS-vHIL, from a firmware
  repository too). Signed in to GitHub (the editor's Team view, the desktop
  app or `vhil login`), the editor's server pushes and opens the pull
  request itself; signed out, VS Code offers to push the committed branch
  with your git and opens its pull request on GitHub; in a firmware repository, a branch committed
  but not pushed stays listed in the view (**Push and open a pull
  request**), since the checkout it lives in is VS Code's own. **Tools…** at the bottom in the vHIL repository.
- **Run on save**: the Testing panel's continuous run (the eye icon) runs
  the selection again whenever you save a source, header, linker script,
  `.ioc` or build file (`CMakeLists.txt`, `Makefile`, `*.cmake`, `*.mk`);
  a save during a run queues one more.
- **One run at a time:** a run started while another goes (the status bar,
  a system's scenarios, Debug Test, the Testing panel) waits for it. A run
  of tests a refresh has since replaced runs the current ones.
- **Listing** happens once per vHIL checkout commit in a firmware
  repository: reopening the window shows the tests at once.
- **System files** (the vHIL repository): any change to `systems/*.yaml`
  (a save, a checkout, a revert) validates it; its errors show in Problems
  at the line they name.
- **Cancel** stops the run's script and its container.
- **Status bar:** `Docker not running` (click: Diagnose), `images needed`
  (click: pull them), `building ecu@local`, `12/40`, `42`, `3 failed` or
  `5 skipped` (nothing ran) (click: run again). Docker down or an image
  pull that fails is not a result: the tests are skipped and the bar says
  what's wrong. Checking it starts no container (`vhil-docker.sh status`).
- **vHIL: Diagnose:** Docker (and its CLI), images (here, published, or
  built from source), firmware, the system editor and the debugger, each
  with its fix (start the VM, pull images, build firmware, change a
  setting, open the editor).
- **The editor's Run** in a firmware repository runs your working tree too:
  the top bar's `<id>@local` toggle (on) builds it, uncommitted edits
  included, before each Run, Live or pytest run; off, the catalogue's or
  the board's refs.
- **vHIL: Open the system editor** opens it in a tab, started if needed
  (on localhost:8080 for your own vHIL checkout, the `vhil.webPort` setting
  or `VHIL_WEB_PORT` if set; each firmware repository gets a vHIL and a port
  of its own, so its editor runs beside yours and builds its own working
  tree). It frames only this checkout's vHIL, on this checkout's code: if
  another vHIL holds the port (the desktop app's, another clone's) it asks
  before stopping it, and one of this checkout's started at an older commit
  (after a pull, a switch or **Update vHIL**) is restarted first
  (`vhil-docker.sh stack`, `/api/health`'s `started_ref`).
  **vHIL: Stop the vHIL** stops its containers (`vhil stop`), whoever
  started them. The tab waits while its terminal runs, and
  says so if it exits; Retry starts it again. Opening another system in an open tab asks the editor
  to switch, or, with an editor that can't, asks before reloading it. The
  tab's **Open in the browser** button opens the same page outside VS Code,
  and the tab offers it too when the editor doesn't load in 15 s.
- **vHIL: New part…** (the vHIL repository only): a sensor or chip on a
  bus. It asks for its id, name, buses (I2C, SPI, UART), I2C address and ID
  register, and optionally a system, board and bus to wire it to, then runs
  `python -m vhil.part new` in the container: its model, tests, test marker
  and CI rule are written, and the model and tests open. Its tests pass as
  generated; the datasheet's behaviour goes in the TODOs
  (`docs/development/adding-a-part.md`).
- **vHIL: Tools…** (the vHIL repository only): a shell in the container,
  an IFS_HIL suite, coverage, speed, a smoke suite, validating a system,
  pruning firmware builds, exporting and importing a web app run.

A command runs as a VS Code task, in the terminal panel, where it can be
watched and stopped.

## Settings

| Setting | What | Script variable |
|---|---|---|
| `vhil.dockerContext` | Docker context (empty: `colima-vhil` on macOS, `default` elsewhere; Docker Desktop: `desktop-linux`) | `VHIL_DOCKER_CONTEXT` |
| `vhil.ifsHilRef` | IFS_HIL ref for firmware builds | `IFS_HIL_REF` |
| `vhil.firmwareRefs` | firmware refs for **Build firmware**, e.g. `ecu=feat/x` | `FW_REFS` |
| `vhil.cpus` | cores per run, 4 as CI's runners (0: no limit) | `VHIL_DOCKER_CPUS` |
| `vhil.pytestArgs` | extra pytest arguments, e.g. `--vhil-trace` | |
| `vhil.repository` | the vHIL a firmware repository is tested with (empty: `https://github.com/isc-fs/IFS-vHIL`) | |
| `vhil.ref` | its branch or tag (empty: `dev`) | |
| `vhil.checkForUpdates` | look for a newer extension once a day (default on) | |
| `vhil.gdbPath` | the host's GDB for **Debug Test** (empty: `arm-none-eabi-gdb`) | |

## How it works

`vhil/pytest_vscode.py` is a pytest plugin: with `--vscode-out FILE` it
writes JSON lines, one per collected test (node id, file, line, markers) or
one when a test starts and ends (outcome, duration, failure and where). The
extension reads the file under `results/vscode/` while the run goes on.
`src/plan.ts` holds what a run executes and how its lines parse,
`src/status.ts` what the status bar and Diagnose show, `src/systems.ts` the
systems and tools, `src/systemsView.ts` what the Systems view lists, `src/firmware.ts` which firmware a repository is and which
tests and systems run it (all tested by `npm test`); `src/extension.ts` is the
VS Code side.

Not yet: the Robot smoke suites, Windows hosts (the script
is bash; WSL2 works as on Linux).

## Develop

```sh
npm ci
npm test            # compile + node --test
code --extensionDevelopmentPath="$PWD" ..   # an Extension Development Host on the repo
```
