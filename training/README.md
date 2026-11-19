# vHIL training

A training simulator for new electrical members. You get the whole car's
electrical system, emulated: the ECU and the AMS run the team's real
firmware on virtual MainLite boards, wired as on the car, with the shutdown
circuit, the tractive system and the accumulator around them. Each puzzle
has one fault seeded into it, in the hardware or the firmware. Your job is
to find where it is, then fix it.

The aim is that you understand how the car's E/E system works, not only
how to debug firmware: why the AIRs close in the order they do, what opens
the shutdown circuit, what the AMS watches, what the ECU and the AMS say to
each other on CAN.

## Start

```bash
scripts/vhil-docker.sh server
```

Then open <http://localhost:8080/training/>. The page has three columns:

- **Left: the job card and the steps.** Read the brief, then go through the
  steps: run the car, investigate, name the fault's location, then repair or
  fix it. Hints are staged: ask for one only when you're stuck.
- **Middle: the car.** The E/E diagram is drawn from your run at the time
  under the cursor. Scrub or play the timeline and watch which switch
  opens, which relay drops, which bus goes quiet. Click any part to read
  what it does.
- **Right: the instruments.**
  - **Multimeter:** click a pin dot on a board. It shows the level at the
    cursor, the MCU pin, its net, and where it leaves the module (backplane
    connector pins), with links to the backplane wiring
    (`docs/backplanes/`) and the MainLite pin model.
  - **Scope:** up to four channels over the whole run (pins, firmware
    state, plant values such as the DC-link voltage).
  - **CAN trace:** every frame on every bus, decoded with the firmware's
    own CAN definitions.
  - **Log:** what the boards printed.

## How a puzzle is graded

1. **Name the location.** Pick the part and its position, for example
   "cell temperature sensor, module 3, slot 7". A repair is only accepted
   where the fault is, so toggling parts until the car works doesn't
   solve anything. Every attempt is counted.
2. **Repair or fix.**
   - Hardware fault: "Replace the part" runs the car again with the fault
     removed.
   - Firmware fault: "Open the source" shows the board's file your car was
     built from. Fix it there and press "Build and check my fix": the check
     builds your version with the team's recipe and powers the car on with
     it. Building takes a minute or two.
3. **The check is a pytest run** of the puzzle's grading tests
   (`training/tests/`). Green means solved, and the page shows what the
   fault was, the team's own fix, and the issues where it happened on the
   car.

v1 is on the honour system: a firmware puzzle's bug is a small patch in
`training/patches/`, and you could read it there. Don't. You learn nothing
that way.

## What the vHIL models, and what it doesn't

Modelled: logic, timing in virtual time, every CAN frame, the boards' real
firmware and bootloaders, the LTC6811 measurement chain (cells, NTCs,
isoSPI), the shutdown circuit's switches and latches, the AIRs, precharge
and the DC link, the SD card.

**Out of scope: analog and physical effects.** No EMI, no noise, no bad
solder joints, no ground loops, no contact bounce, no thermal drift. A
voltage in the vHIL is what a sensor would read, not what a scope probe
on a noisy harness would show. Those skills are learnt on the car.

The car is the ground truth. The vHIL is one data point.

## The car's E/E system in one page

- **Shutdown circuit (SDC).** A loop of switches in series: interlocks, HV
  interlock, the IMD latch K4, the AMS latch K5, BSPD, inertia switch,
  BOTS, E-stops, TSMS. Only if all are closed does AIR+_VCC, the supply of
  the AIR coils, have power. Any one opening drops the AIRs. K4 and K5
  latch open until RST_EXT is pressed.
- **AMS (MainLite, node 0x2).** Reads 95 cell voltages and 200 NTCs through
  10 LTC6811s on an isoSPI chain (5 modules, 2 chips each, 40 NTC slots per
  module). It drives AMS_OK (PB4, the K5 coil) and the AIR+, AIR- and
  precharge coils (PB5, PB6, PB7), and senses TSMS on PF9. Any fault latches
  Error and drops AMS_OK until an LV power cycle.
- **Precharge.** TSMS on and DASH_CHG pressed: the AMS closes AIR- and the
  precharge relay. The DC link charges through the resistor. At 95 % of the
  pack it closes AIR+ and opens precharge: Run.
- **ECU (MainLite, node 0x1).** Reads the pedals (APPS1/2 on PF8/PF9, brake
  on PF7), talks to the inverter on the inverter bus, and sends the AMS the
  0x100 heartbeat with the DC-link voltage every 10 ms on the ACU bus. If
  0x100 stops for 200 ms, the AMS latches Error (VcuStale).
- **CAN buses.** ACU (ECU FDCAN2 <-> AMS FDCAN1), inverter (ECU FDCAN1),
  dash (ECU FDCAN3).

## For instructors: running a session

**Where.** On the team's vHIL host (`deploy/compose.prod.yaml`) the page is
`<the host>/training/`. Anyone in the isc-fs GitHub organisation signs in with
GitHub; nobody else gets in. Progress is per GitHub login and kept in the
host's backups (`deploy/backup.py`, `training.json`). Locally,
`scripts/vhil-docker.sh server` is the same page with no login.

**Before a session.** A deploy builds every puzzle's firmware once
(`training-prebuild` in `deploy/compose.prod.yaml`; by hand:
`python -m vhil.training_fw prebuild`), so a trainee's first car run waits for
no build. A firmware check still builds the trainee's own edit (a minute or
two). The host runs at most `VHIL_WORKERS` (2) cars at once and queues the
rest, so with a big group, pair trainees up. A trainee's edited firmware is
removed a day after it was last used (`VHIL_TRAINING_KEEP_HOURS`).

**Order.** Level 1 first; each teaches one part of the car:

| Puzzle | Level | Fault | Teaches |
|---|---|---|---|
| `car-wont-arm` | 1 | hardware | The shutdown circuit, why nothing happens and nothing errors |
| `precharge-never-finishes` | 1 | hardware | Precharge and the DC link, a voltage divider |
| `ams-trips-at-power-on` | 1 | firmware | AMS fault reasons, cell limits, the config header |
| `open-ntc-opens-the-sdc` | 2 | hardware | Cell temperatures, the AMS latch in the SDC |
| `ecu-heartbeat-stops` | 2 | firmware | ECU <-> AMS heartbeat; the symptom on one board, the bug on the other |
| `ams-cant-hear-the-car` | 2 | hardware | CAN wiring; the same fault reason as the last, a different cause |

**While they work.** Let them read the fault reason and scrub the timeline
before asking for a hint. When someone is stuck, ask what changed first, and
on which board. After `ecu-heartbeat-stops`, give them
`ams-cant-hear-the-car` and ask how they would tell the two apart on the car.

## For instructors: writing a puzzle

A puzzle is `training/scenarios/<id>.yaml`:

| Key | What |
|---|---|
| `title`, `summary`, `level`, `topics` | The card on the list |
| `fault` | `hardware` or `firmware` |
| `system` | A system in `systems/` |
| `firmware` | Image key -> full commit SHA: what the trainee's car runs. A firmware puzzle pins the real commit before the team's fix, never a patch. |
| `brief` | What the trainee is told, in the team's words |
| `drive` | The drive cycle: a scenario's `stimuli`, `watch` and `expect` (`docs/scenarios.md`). `expect` is what a healthy car does. |
| `faults` | Hardware faults, as scenario stimulus rows (for example `{kind: plant, plant: ts, set: {open_ntc_module: 3, open_ntc_slot: 7}}`, or an open CAN stub: `{kind: can_wire, bus: can_acu, node: ams.FDCAN1, connected: false}`). Removed by the repair. |
| `seed` | A firmware fault: `{image: ams, patch: patches/<name>.patch}`, a patch on the pinned commit of that image. The trainee can edit only the files it touches. |
| `hints` | Staged, most general first |
| `answer` | The location: a part from `vhil/training.py` `PARTS` and its fields, and the explanation shown once solved |
| `fix`, `fix_note`, `sources` | The team's fix and the issues, shown once solved |
| `solved` | The grading tests: node ids under `training/tests/` |

Every run puzzle gets two tests from `training/tests/test_puzzles.py`:
`test_solved[<id>]` (the healthy-car expects pass without the fault) and
`test_fault_shows[<id>]` (they don't with it: the puzzle has a symptom).
Run both before you publish a puzzle:

```bash
python -m pytest training/tests --ecu-elf ECU08.elf --ams-elf AMS.elf --can-bootloader-elf CAN_BL.elf
```

A firmware puzzle's symptom shows only on its seeded build. Build it, then
pass it with `--seeded`:

```bash
python -m vhil.training_fw build <id> --fw-dir /vhil/training-fw   # prints ams=<elf>
python -m pytest training/tests -k "fault_shows and <id>" --seeded --ams-elf <elf> ...
```

Write a seed's patch against the pinned commit (`git diff` in a checkout of
it). Keep it to one cause: a wrong limit, a swapped pin, a wrong period.

Training tests live outside `pytest.ini`'s `testpaths`, so the vHIL's own
suite and CI never run them. Seeded firmware is built only for training
runs, by `vhil/training_fw.py`, into its own directory (`<fw-dir>/training/`):
the gate, CI and every other run build the team's commits only, so a seeded
bug never touches real CI or the "never patch firmware" rule.
