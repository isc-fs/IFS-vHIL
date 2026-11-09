# SensorHub (IFS09) in the vHIL

Status: **platform started** (M1 in progress, see [Platform](#platform-stm32l496)):
the STM32L496 loads and its start-up registers are modelled and tested at
register level. No firmware exists yet. This page is the brief for bringing
it up. The general method is [`docs/development/adding-a-board.md`](../development/adding-a-board.md)
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
| Platform `stm32l496` | **Started** ([below](#platform-stm32l496)) | Renode 1.17 ships no STM32L4 platform. The closest is `stm32l552.repl` (same peripheral generation): GPIO `STM32_GPIOPort`, USART `STM32F7_USART`, SPI `STM32SPI`, timers `STM32_Timer`, IWDG, ADC `STM32L5_ADC`. Every address and IRQ from ST's `stm32l496xx.h` and RM0351 (invariant 10). The L4's I2C is the same IP as the F7's (check Renode's `STM32F7_I2C`), its DMA has CSELR and no DMAMUX, and its RCC is different. |
| bxCAN on the bus model | To build | Renode has a bxCAN model (`STMCAN`), but the vHIL's bus model takes controllers that implement `IVhilCanController`. Today only the H7 FDCAN does (`models/renode/Stm32H7Fdcan.cs`). Until then, `arbitration: false` (Renode's hub) gets frames moving. |
| BMI088 | Reuse + extend | `models/renode/Bmi088.cs` is I2C-only (the MainLite's). The SensorHub wires it on SPI: add the SPI interface (one CS per die, the accelerometer's dummy byte on reads, datasheet ch. 6). |
| ADC inputs | To check | Analog sources (`catalog/models/*` with backend `analog`) drive pins already; the L4 ADC model must deliver them. |
| Pin model | Later | Optional at first. `vhil/pin_model.py` reads only the MainLite schema. |
| Board, firmware, system entries | To write | `catalog/boards/sensorhub.yaml`, `catalog/firmware/sensorhub.yaml`, `systems/sensorhub.yaml`. |

## How it is structured in the vHIL

Decided 2026-11-09 (Raúl):

- **One board, no roles.** The car has a single SensorHub, so the catalogue
  has one `sensorhub` board and one system, with plain port names. Unlike
  the MainLite, there are no roles.
- **The board is what the schematic fixes.** That covers the MCU, the
  on-board BMI088 (SPI), CAN1/CAN2, and the AMPSEAL ports: ADC_IN1..4, I2C1,
  SPI_EXT + CS_EXT. The ADC inputs' 5 V → 3.3 V divider and clamp belong to
  the board, so a sensor model gives the voltage the sensor itself puts out
  (0–5 V).
- **External sensors are devices**, wired to those ports in the system file.
  The sensors aren't chosen yet, so the library carries generic ones now and
  real part models when a part is picked:
  - a generic analog sensor (offset, gain, range; e.g. ratiometric
    0.5–4.5 V);
  - a generic I2C register device and a generic SPI register device. Each
    answers at an address with register values set in the system file, so
    the firmware's bus code can be tested before a chip is chosen.

## Platform (stm32l496)

[`platforms/cpus/stm32l496.repl`](../../platforms/cpus/stm32l496.repl),
[`catalog/platforms/stm32l496.yaml`](../../catalog/platforms/stm32l496.yaml).
Every address and IRQ comes from ST's `stm32l496xx.h`
(cmsis_device_l4 ca0bfa2), named in each block.

| Part | Model | State |
|---|---|---|
| Core | Cortex-M4F, 4 priority bits, 80 MIPS | Placed |
| Memory | 1 MB flash (also at 0), SRAM1 256 KB, SRAM2 64 KB at 0x10000000 and 0x20040000, engineering data (flash size 0x400) | Placed |
| RCC | `Stm32L4Rcc.cs` (new): ready flags, clock switch, the in-use clock can't be switched off, clock IRQ, backup domain behind DBP, reset flags. Crystals from the board: HSE 16 MHz, no LSE | Tested |
| PWR | `Stm32L4Pwr.cs` (new): DBP, VOS (VOSF 0), LPR/REGLPF | Tested |
| FLASH | `Stm32L4Flash.cs` (new): ACR read-back, keys, page and bank erase on two 512 KB banks, option bytes that survive reset | Tested |
| DMA1/2 | Renode `STM32LDMA` + `Stm32L4DmaCselr.cs` (new) | Placed; CSELR tested |
| DBGMCU | `Stm32L4Dbgmcu.cs` (new): DEV_ID 0x461 | Tested |
| GPIO A–I, EXTI 0–15, SYSCFG | Renode, RM0351 reset values | Placed |
| CAN1/CAN2 | Renode `STMCAN` (bxCAN, shared filters) | Placed; not on the vHIL bus model yet (M2) |
| SPI1–3, I2C1–4, USART1–3, UART4/5, LPUART1 | Renode L5 SPI, the vHIL's I2C master, F7 USART | Placed |
| TIM1–8, 15–17, IWDG | Renode, 80 MHz; IWDG on the 32 kHz LSI | Placed |
| ADC1 | Renode `STM32L5_ADC` on DMA1 ch1 | Placed; ADC2/3 not placed |
| CRC, RNG | Renode | Placed |

Tests: [`tests/sim/test_stm32l496_platform.py`](../../tests/sim/test_stm32l496_platform.py)
loads the platform with no firmware (marker `platform_stm32l496`, see
[`docs/ci.md`](../ci.md)) and checks a CubeMX start-up's registers: the HSE →
PLL → 80 MHz sequence, wait-state read-back, the backup domain, reset flags,
flash keys, erase and option bytes.

Known gaps, to close as the firmware needs them:

- **Clock rates are fixed at 80 MHz.** Timers, UARTs and the SysTick don't
  follow the RCC. If the firmware's `SystemClock_Config` runs the core
  slower, the repl's rates must change with it.
- **ADC calibration:** Renode's model tags `ADCAL`, so the peripheral guard
  will flag `HAL_ADCEx_Calibration_Start` until an L4 ADC model replaces it
  (M3).
- **Reset cause:** a software or IWDG reset sets only PINRSTF, not
  SFTRSTF/IWDGRSTF.
- **Not modelled yet:** peripheral resets (xxxRSTR), SYSCFG's EXTI port
  selection (every port drives every line), and DMA request routing by
  CSELR (fixed by the repl's wiring).
- **Flash programming checks:** no PG/PGSERR/WRPERR. Writes always land.
- **Not placed:** RTC, LPTIM, WWDG, DAC, OPAMP, QUADSPI, SAI, USB, SDMMC,
  ADC2/3. A firmware that uses one is stopped by the peripheral guard.

## Plan

Each milestone ends in something you can run and a PR into `dev`.

1. **M1: platform boots the firmware.** *(Platform done at register level;
   the boot check waits for the firmware.)* `platforms/cpus/stm32l496.repl` and
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
