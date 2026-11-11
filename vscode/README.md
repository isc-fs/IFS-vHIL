# ISC vHIL for VS Code

The vHIL's tests in VS Code's **Testing** panel: every test of `tests/unit`,
`tests/sim` and `tests/scenarios`, with Run and Cancel per test, file or
folder. Its tools in a **vHIL sidebar**: the VM, images, firmware and system
editor, every system with its tests, the last runs. Runs go through `scripts/vhil-docker.sh` in the vHIL's Docker
image, as CI's jobs do, so the host needs Docker only (on macOS, the Colima
VM `scripts/vhil-docker.sh vm` makes).

## Install

Download `vhil-tests-<version>.vsix` from the `vscode` workflow's run
(Actions → vscode → artifact), or build it:

```sh
cd vscode && npm ci && npm run package
code --install-extension vhil-tests-*.vsix
```

Open the IFS-vHIL checkout: the extension starts when the folder has
`scripts/vhil-docker.sh`.

## Use

- **Testing panel:** the three folders, their files and tests; the pytest
  markers are tags (`@can`, `@system_ams`) for the panel's filter. The list
  comes from `pytest --collect-only` in the container (about 20 s) and
  refreshes when a test file changes.
- **Run:** a unit test runs under pytest itself; a sim or scenario test
  under the `sim` / `scenarios` job, which finds the firmware the last
  `fw` built. Results come in as each test ends; a failure is shown at its
  line. The run's output is the test's output.
- **Cancel** stops the run's container.
- **Status bar** (`vHIL`): whether the Docker VM answers and which firmware
  is built (sim and scenario tests need ecu, ams and the bootloader). Click
  it for the actions.

### The vHIL sidebar

The vHIL icon in the activity bar opens four views. Their buttons show on
hover; right-click a system or a run for the rest.

- **Status:** the Docker VM (start it), the images (pull or rebuild), the
  firmware `fw` last built per board (build, or rebuild one board), the
  system editor (open; started here, stop), the firmware refs (settings).
  Checked when the view opens and after every command.
- **Systems:** every `systems/*.yaml` with its boards and how many sim tests
  and scenarios it has. Run its sim tests (by its `system_*` marker) or its
  scenarios, which show in the Testing panel; run its smoke suite, validate
  it, open its file.
- **Runs:** the last 20 runs, of tests or commands, with what passed and
  failed, how long and when. Click a test run for its output; run it again,
  or only its failures. A failed test opens in the Testing panel.
- **Tools:** a shell in the container, an IFS_HIL suite against the ECU or
  the AMS, firmware coverage, speed, pruning old firmware builds, exporting
  and importing a web app run.

A command runs as a VS Code task, in the terminal panel, where it can be
watched and stopped.

## Settings

| Setting | What | Script variable |
|---|---|---|
| `vhil.dockerContext` | Docker context (empty: `colima-vhil` on macOS, `default` elsewhere) | `VHIL_DOCKER_CONTEXT` |
| `vhil.ifsHilRef` | IFS_HIL ref for firmware builds | `IFS_HIL_REF` |
| `vhil.firmwareRefs` | firmware refs for **Build firmware**, e.g. `ecu=feat/x` | `FW_REFS` |
| `vhil.cpus` | cores per run, 4 as CI's runners (0: no limit) | `VHIL_DOCKER_CPUS` |
| `vhil.pytestArgs` | extra pytest arguments, e.g. `--vhil-trace` | |

## How it works

`vhil/pytest_vscode.py` is a pytest plugin: with `--vscode-out FILE` it
writes JSON lines, one per collected test (node id, file, line, markers) or
one when a test starts and ends (outcome, duration, failure and where). The
extension reads the file under `results/vscode/` while the run goes on.
`src/plan.ts` holds what a run executes and how its lines parse,
`src/sidebar.ts` what the sidebar shows (both tested by `npm test`);
`src/extension.ts` and `src/views.ts` are the VS Code side.

Not yet: debugging a test, the Robot smoke suites, Windows hosts (the script
is bash; WSL2 works as on Linux).

## Develop

```sh
npm ci
npm test            # compile + node --test
code --extensionDevelopmentPath="$PWD" ..   # an Extension Development Host on the repo
```
