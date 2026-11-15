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
   - Firmware fault: fix the code in the board's firmware repository, push
     a branch, and give its name. The check builds that ref and runs it.
3. **The check is a pytest run** of the puzzle's grading tests
   (`training/tests/`). Green means solved, and the page shows what the
   fault was, the team's own fix, and the issues where it happened on the
   car.

v1 is on the honour system: a firmware puzzle pins the real commit from
before the team's fix, so you could diff it against upstream. Don't. You
learn nothing that way.

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
| `faults` | Hardware faults, as scenario stimulus rows (for example `{kind: plant, plant: ts, set: {open_ntc_module: 3, open_ntc_slot: 7}}`). Removed by the repair. |
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

Training tests live outside `pytest.ini`'s `testpaths`, so the vHIL's own
suite and CI never run them. A seeded fault never touches real CI or the
"never patch firmware" rule.
