# Contributing to IFS-vHIL

New here? This page gets you from clone to your first PR. Everything runs in
Docker: you don't install Renode or a toolchain on your machine.

## 1. What this repo is (5 minutes)

The vHIL runs the car's real firmware images on emulated boards, in virtual
time, so tests can run on every PR without the physical bench. Read:

- [`README.md`](README.md): the overview and the repo layout.
- [`docs/README.md`](docs/README.md): an index of every doc, with what to read
  first.
- [`CLAUDE.md`](CLAUDE.md#hard-invariants): the **hard invariants**. These are
  the rules every change must keep. The most important ones:
  - (1) run the car's firmware unchanged, and model the hardware instead of
    patching the firmware;
  - (9) the car is ground truth, not either bench;
  - (10) every address and IRQ is cited from the vendor's header.

## 2. Set up (once, ~30 minutes)

```sh
git clone https://github.com/isc-fs/IFS-vHIL && cd IFS-vHIL
git switch dev
scripts/vhil-docker.sh vm       # macOS only: a Colima VM (needs `brew install colima docker`)
scripts/vhil-docker.sh image    # builds the Docker images, Renode included (the slow step)
scripts/vhil-docker.sh fw       # builds the ECU and AMS firmware into the vhil-data volume
```

Details, Linux hosts and troubleshooting:
[`docs/development/setup.md`](docs/development/setup.md).

## 3. Run things

```sh
scripts/vhil-docker.sh unit                                  # host-only tests + validate every system (~1 min)
scripts/vhil-docker.sh sim tests/sim/test_ams_boot.py        # one native test file on the emulated AMS
scripts/vhil-docker.sh sim -k heartbeat                      # tests matching a name
scripts/vhil-docker.sh editor                                # system editor: http://localhost:8080/editor/
scripts/vhil-docker.sh shell                                 # a shell in the image (Renode, Python, toolchain)
```

When a native test fails, its report has a snapshot of every board: PC,
registers, fault registers and the FreeRTOS tasks. Re-run it with
`--vhil-trace` to see how the firmware got there
([setup.md, "When a native test fails"](docs/development/setup.md#when-a-native-test-fails)).
To step through firmware, use [GDB](docs/debugger.md).

## 4. Make a change

1. Branch **off `dev`**: `git switch -c feat/<short-slug> origin/dev`. Use the
   `fix/`, `docs/`, `chore/` and `test/` prefixes as fits.
2. Commit in small steps:
   - conventional subjects such as `feat(platform): add STM32L496 GPIO`;
   - a body that explains *why*;
   - one concern per commit;
   - no AI co-author lines.
3. Open a PR **into `dev`**: `gh pr create --base dev`. Include:
   - a **Summary** of 1–3 bullets;
   - a **Test plan** checklist;
   - `Part of #<issue>`.
4. CI:
   - every PR runs `unit`;
   - label the PR **`full-ci`** if it can change what the emulated firmware
     does (models, platforms, catalogue, systems, tests, workflows); that
     runs the heavy jobs your paths select;
   - docs-only PRs need no label.
   [`docs/ci.md`](docs/ci.md) has the details.
5. PRs merge with a **merge commit**, never squash, once CI is green.
   `main` is release-only: nobody pushes there.

## 5. Where things are

| You want to… | Look at |
|---|---|
| add a board or a chip | [`docs/development/adding-a-board.md`](docs/development/adding-a-board.md) |
| add a device model (sensor, transceiver) | `models/renode/*.cs` + `catalog/models/*.yaml`, step 3 of that guide |
| wire boards into a system | `systems/*.yaml`; [`CLAUDE.md` "Systems are data"](CLAUDE.md#systems-are-data) |
| understand the CAN bus model | [`docs/can-bus.md`](docs/can-bus.md) |
| understand CPU speed and timing | [`docs/cpu-timing.md`](docs/cpu-timing.md) |
| write a native test | `tests/sim/` (copy a `test_*_boot.py`), `vhil/sim.py` |
| see what a board's backplane routes | [`docs/backplanes/`](docs/backplanes/README.md) |

## 6. Ask

Open an issue for anything unclear, including a doc that confused you: that's
a bug in the docs. Ask Raúl for repo access and review.
