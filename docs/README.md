# Docs index

**Start here:** [`CONTRIBUTING.md`](../CONTRIBUTING.md) (setup, first PR),
then [`vision.md`](vision.md) (where the project is going) and the hard
invariants in [`CLAUDE.md`](../CLAUDE.md#hard-invariants).

## Working on the vHIL

| Doc | What it covers |
|---|---|
| [development/setup.md](development/setup.md) | Docker jobs, native setup, debugging failing tests, branching, PRs, releases |
| [development/adding-a-board.md](development/adding-a-board.md) | How to add a new board or MCU, step by step, with a definition of done |
| [ci.md](ci.md) | CI policy, labels (`full-ci`), impact selection, fingerprints |
| [test-coverage.md](test-coverage.md) | What the vHIL's own test suite covers |
| [debugger.md](debugger.md) | GDB on an emulated board |
| [development/web-app.md](development/web-app.md) | Web app login and GitHub App credentials |
| [deploy.md](deploy.md) | Deploying the web app on a host |

## How the emulation works

| Doc | What it covers |
|---|---|
| [can-bus.md](can-bus.md) | The CAN bus model: arbitration, bit time, ACK, sync quantum |
| [cpu-timing.md](cpu-timing.md) | How fast the emulated core runs firmware (`cpu.mips`) |
| [performance.md](performance.md), [performance/rounds.md](performance/rounds.md) | Emulation speed and the speed-up rounds |
| [cosim.md](cosim.md) | Co-simulation port for plants |
| [integration-contract.md](integration-contract.md) | What external tools (plants, sims, scenario writers) can rely on |
| [m8-plan.md](m8-plan.md) | The tractive-system plant |

## Boards

| Doc | What it covers |
|---|---|
| [backplanes/](backplanes/README.md) | The MainLite's backplanes (ECU, AMS, uDV): pin maps cited to schematics |
| [boards/sensorhub.md](boards/sensorhub.md) | SensorHub (STM32L496): brief and bring-up plan |

## Editor and web app

| Doc | What it covers |
|---|---|
| [scenarios.md](scenarios.md) | Scenarios: runs as data, with stimuli and expectations |
| [state-view.md](state-view.md) | The editor's state panel |
| [live-session.md](live-session.md) | Live sessions |
| [architecture/editor-workspace.md](architecture/editor-workspace.md) | Editor frontend design |
| [architecture/m5-web-app.md](architecture/m5-web-app.md) | Shared web app architecture |

## Background

| Doc | What it covers |
|---|---|
| [vision.md](vision.md) | Roadmap and milestones |
| [proposal.md](proposal.md) | The original Phase 0/1 design and findings |
| [proposals/](proposals/) | The Renode fork study and patch notes |
| [analysis/](analysis/) | IFS_HIL test mapping, investigations (e.g. AMS #641) |
