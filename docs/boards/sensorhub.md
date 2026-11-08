# SensorHub (IFS09) in the vHIL

Status: **not started**. This page is the brief for bringing it up. The
general method is [`docs/development/adding-a-board.md`](../development/adding-a-board.md)
("Case B: a new board with its own MCU").

Source repo: [isc-fs/IFS09-CE-SENSORHUB](https://github.com/isc-fs/IFS09-CE-SENSORHUB)
(schematic v2, 2026-11-05; work order WO-IFS09-SEN-001). Facts below cite the
schematic (`SensorHub.kicad_sch`) or the work order (WO). Re-check them when
the schematic changes.

## What the board is

A universal sensor hub: it reads sensors around the car and puts them on CAN.

| | | Source |
|---|---|---|
| MCU | **STM32L496RGT6** (Cortex-M4F, LQFP64), U4 | schematic; WO 6.2 |
| Clock | 16 MHz HSE crystal | WO |
| CAN | **2 × bxCAN** (not FDCAN): CAN1 PB9/PB8 (TX/RX), CAN2 PB6/PB5, 1 Mbit/s | schematic nets; WO |
| IMU | BMI088 on **SPI**: CS_ACCEL PC4, CS_GYRO PC5, INT1 PC6 | schematic |
| Analog in | ADC_IN1..4 on PC0..PC3 (RC + BAT54S clamp, 5 V → 3.3 V divider), ADC_TEST on PA0 | schematic; WO 6.6 |
| External buses | I2C1 PB10/PB11 and SPI (+ CS_EXT) out to the AMPSEAL connector | schematic; WO 6.5 |
| Debug | USART on PA2/PA3, SWD, heartbeat LED PB13, USB-C (DFU) | schematic |
| Connector | TE AMPSEAL 23-pin: 24 V in, 12/5/3.3 V out, CAN1, CAN2, I2C, SPI, ADC1..4 | WO 6.5 |

The PCB layout hasn't started (`SensorHub.kicad_pcb` is empty), and **there
is no firmware yet**. Open hardware questions are in the repo's
`dudas-tocheck.md`.

## What exists and what has to be built

| Piece | State | Notes |
|---|---|---|
| Firmware | **Missing.** Prerequisite. | The vHIL runs the car's image (invariant 1). Bring-up can start once the firmware repo has CubeMX init + a heartbeat on CAN. |
| Platform `stm32l496` | To build | Renode 1.17 ships no STM32L4 platform. The closest is `stm32l552.repl` (same peripheral generation): GPIO `STM32_GPIOPort`, USART `STM32F7_USART`, SPI `STM32SPI`, timers `STM32_Timer`, IWDG, ADC `STM32L5_ADC`. Every address and IRQ from ST's `stm32l496xx.h` and RM0351 (invariant 10). The L4's I2C is the same IP as the F7's (check Renode's `STM32F7_I2C`), its DMA has CSELR and no DMAMUX, and its RCC is different. |
| bxCAN on the bus model | To build | Renode has a bxCAN model (`STMCAN`), but the vHIL's bus model takes controllers that implement `IVhilCanController`. Today only the H7 FDCAN does (`models/renode/Stm32H7Fdcan.cs`). Until then, `arbitration: false` (Renode's hub) gets frames moving. |
| BMI088 | Reuse + extend | `models/renode/Bmi088.cs` is I2C-only (the MainLite's). The SensorHub wires it on SPI: add the SPI interface (one CS per die, the accelerometer's dummy byte on reads, datasheet ch. 6). |
| ADC inputs | To check | Analog sources (`catalog/models/*` with backend `analog`) drive pins already; the L4 ADC model must deliver them. |
| Pin model | Later | Optional at first. `vhil/pin_model.py` reads only the MainLite schema. |
| Board, firmware, system entries | To write | `catalog/boards/sensorhub.yaml`, `catalog/firmware/sensorhub.yaml`, `systems/sensorhub.yaml`. |

## Plan

Each milestone ends in something you can run and a PR into `dev`.

1. **M1: platform boots the firmware.** `platforms/cpus/stm32l496.repl` and
   `catalog/platforms/stm32l496.yaml`; HSE 16 MHz; the HAL tick runs; the
   peripheral guard lists nothing unexplained.
   *Done when:* the firmware reaches its main loop and toggles the heartbeat
   (PB13) at its real period.
2. **M2: on the CAN bus.** First on the hub (`arbitration: false`), then
   bxCAN implementing `IVhilCanController`.
   *Done when:* a test sees the board's frames at 1 Mbit/s bit time, ACKed by
   another node.
3. **M3: sensors.** BMI088 over SPI, ADC_IN1..4 from analog sources.
   *Done when:* a test sets acceleration and voltages through the models and
   reads them back in the board's CAN frames.
4. **M4: catalogue, tests, CI.** Board, firmware and system entries; a
   `pytest.ini` marker; `tests/conftest.py` `BOARDS`; an `ci/impact.yaml`
   rule; fingerprints.
   *Done when:* the PR's `full-ci` run is green.
5. **M5: on the car's buses.** Put the SensorHub in the multi-board system
   it belongs to (which bus each CAN goes to is still open).

## Open questions

Owners: Inés with Raúl.

- **Firmware:** which repo does it live in (this repo's firmware folder, or a
  separate one), and is there a CI build to take the recipe from (invariant 1)?
- **Boot:** does the SensorHub carry the team's CAN bootloader (that would
  mean porting it to the L4), or does it run from reset? The vHIL boots it
  the same way the car does.
- **Buses:** which car bus does CAN1 go to, and which does CAN2? Which IDs
  does it send, and is there a DBC?
- **External sensors:** what hangs off I2C, SPI and ADC_IN1..4 in each
  mounting position? Those become devices in the system.
