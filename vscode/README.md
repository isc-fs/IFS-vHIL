# ISC vHIL for VS Code

The vHIL's tests in VS Code's **Testing** panel: every test of `tests/unit`,
`tests/sim` and `tests/scenarios`, with Run and Cancel per test, file or
folder, and one **status bar** item that says where things stand and runs
the tests again. Runs go through `scripts/vhil-docker.sh` in the vHIL's Docker
image, as CI's jobs do, so the host needs Docker only (on macOS, the Colima
VM `scripts/vhil-docker.sh vm` makes).

## Install

Download `vhil-tests-<version>.vsix` from the `vscode` workflow's run
(Actions → vscode → artifact), or build it:

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

The extension recognises the repository by its `origin` (the catalogue's
`repo:` in `catalog/firmware/`) and keeps its own checkout of the vHIL in
VS Code's extension storage: cloned the first time, brought to `vhil.ref`
(`dev`) once a day or with **vHIL: Update the vHIL checkout**. It only
fetches anything for a repository on the vHIL's GitHub owner.

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

- **Testing panel:** the three folders; sim tests by file, scenarios by
  system. The pytest markers are tags (`@can`, `@system_ams`) for the
  panel's filter. The list comes from `pytest --collect-only` in the
  container (about 20 s) and refreshes when a test file changes.
  Right-click a system's scenarios: **Open a system in the system editor**.
- **Cancel** stops the run's container.
- **Status bar:** `Docker not running` (click: Diagnose), `building
  ecu@local`, `12/40`, `42` or `3 failed` (click: run again).
- **vHIL: Diagnose:** Docker, images, firmware and the system editor, each
  with its fix (start the VM, pull images, build firmware, change the
  context, open the editor).
- **vHIL: Open the system editor** opens it in a tab, started if needed.
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

## How it works

`vhil/pytest_vscode.py` is a pytest plugin: with `--vscode-out FILE` it
writes JSON lines, one per collected test (node id, file, line, markers) or
one when a test starts and ends (outcome, duration, failure and where). The
extension reads the file under `results/vscode/` while the run goes on.
`src/plan.ts` holds what a run executes and how its lines parse,
`src/status.ts` what the status bar and Diagnose show, `src/systems.ts` the
systems and tools, `src/firmware.ts` which firmware a repository is and which
tests and systems run it (all tested by `npm test`); `src/extension.ts` is the
VS Code side.

Not yet: debugging a test, the Robot smoke suites, Windows hosts (the script
is bash; WSL2 works as on Linux).

## Develop

```sh
npm ci
npm test            # compile + node --test
code --extensionDevelopmentPath="$PWD" ..   # an Extension Development Host on the repo
```
