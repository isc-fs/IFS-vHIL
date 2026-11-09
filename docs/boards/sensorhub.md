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
| IMU | BMI088 on **SPI3** (PC10/PC11/PC12): CS_ACCEL PC4, CS_GYRO PC5, INT1–INT3 PC6–PC8 | schematic netlist |
| Analog in | ADC_IN1..4 (J1.19–22) on PC0..PC3, ADC123_IN1..4: 5k11 / 10k divider (ratio 0.6618), 10 nF, BAT54S clamp to 3V3. ADC_TEST (PA0) is a label on U4.14 alone | schematic netlist; WO 6.6 |
| External buses | **I2C2** PB10/PB11 (J1.13/14) and **SPI1** PA5/PA6/PA7 + CS_EXT PA4 (J1.15–18) out to the AMPSEAL connector | schematic netlist; WO 6.5 |
| Debug | USART2 on PA2/PA3, SWD, heartbeat LED PB13, USB-C (DFU) | schematic |
| Backup domain | VBAT (U4.1) tied to 3V3, no LSE (PC14/PC15 unconnected): a power cut wipes it | schematic netlist |
| Connector | TE AMPSEAL 23-pin: 24 V in, 12/5/3.3 V out, CAN1, CAN2, I2C, SPI, ADC1..4 | WO 6.5 |

The PCB layout hasn't started (`SensorHub.kicad_pcb` is empty), and **there
is no firmware yet**. Open hardware questions are in the repo's
`dudas-tocheck.md`.

## What exists and what has to be built

| Piece | State | Notes |
|---|---|---|
| Firmware | **Missing.** Prerequisite. | The vHIL runs the car's image (invariant 1). Bring-up can start once the firmware repo has CubeMX init + a heartbeat on CAN. |
| Platform `stm32l496` | **Started** ([below](#platform-stm32l496)) | Renode 1.17 ships no STM32L4 platform. The closest is `stm32l552.repl` (same peripheral generation): GPIO `STM32_GPIOPort`, USART `STM32F7_USART`, SPI `STM32SPI`, timers `STM32_Timer`, IWDG, ADC `STM32L5_ADC`. Every address and IRQ from ST's `stm32l496xx.h` and RM0351 (invariant 10). The L4's I2C is the same IP as the F7's (check Renode's `STM32F7_I2C`), its DMA has CSELR and no DMAMUX, and its RCC is different. |
| bxCAN on the bus model | **Done** at platform level | `models/renode/Stm32BxCan.cs`: Renode's `STMCAN` (filters, RX FIFOs) with the transmit side on the vHIL's arbitrated bus (`IVhilCanController`, as the H7 FDCAN). `systems/sensorhub.yaml` puts CAN1/CAN2 on buses `can1`/`can2` (`tests/sim/test_sensorhub_system.py`). |
| BMI088 | **Done** | One catalogue model, `bmi088`, for both boards: the bus a device wires picks the protocol (`interface.protocols`), as the chip's PS pin does. `i2c:` gives the two dies at their addresses (the MainLite); `spi:` gives `Bmi088Spi`, one slave with CSB1/CSB2 as `pins` (the SensorHub: SPI3, PC4/PC5, in `systems/sensorhub.yaml`). The accelerometer's dummy byte, and its I2C mode until CSB1's first rising edge and after a soft reset (`tests/sim/test_bmi088_spi.py`). |
| ADC inputs | **Done** | The L4 ADC takes pin voltages (`SetVoltage`, what analog devices render) and keeps them through a reset. The board's divider is `analog_in` `front_end_ratio` (`System.sensor_to_pin`). |
| Pin model | Later | Optional at first. `vhil/pin_model.py` reads only the MainLite schema. |
| Board, system entries | **Done** | `catalog/boards/sensorhub.yaml`, `systems/sensorhub.yaml`. No firmware entry: a board without roles may name none, and its image is given at render (`render --firmware sensorhub=<elf>`; `build` refuses). The entry comes with the firmware. |

## How it is structured in the vHIL

Decided 2026-11-09 (Raúl):

- **One board, no roles.** The car has a single SensorHub, so the catalogue
  has one `sensorhub` board and one system, with plain port names. Unlike
  the MainLite, there are no roles.
- **The board is what the schematic fixes.** That covers the MCU, the
  on-board BMI088 (SPI3), CAN1/CAN2, and the AMPSEAL ports: ADC_IN1..4, I2C2,
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
| Memory | 1 MB flash (also at 0, starts erased), SRAM1 256 KB, SRAM2 64 KB at 0x10000000 and 0x20040000, engineering data (flash size 0x400) | Placed |
| RCC | `Stm32L4Rcc.cs` (new): ready flags, clock switch, in-use clock protected, clock IRQ, backup domain behind DBP. Clock tree (MSI/HSI16/HSE/PLL/PLLSAI1/2, AHB/APB prescalers) retimes the SysTick, timers (x2 when APB prescaler > 1), U(S)ARTs and LPTIMs by CCIPR, the ADC kernel clock (CCIPR.ADCSEL), the WWDG (PCLK1) and the RTC (BDCR.RTCSEL). xxxRSTR bits reset their peripherals (GPIO keeps outside levels). Crystals from the board: HSE 16 MHz, no LSE | Tested |
| Reset causes | `Stm32L4ResetFlags.cs` (new, `vhil_reset_<board>`): power-on, pin, software (AIRCR), IWDG (run out, or refreshed above its window), WWDG (run out, refreshed outside its window or with T6 clear), OBL_LAUNCH into RCC_CSR; each told apart by the event that resets | Tested |
| PWR | `Stm32L4Pwr.cs` (new): DBP, VOS (VOSF 0), LPR/REGLPF | Tested |
| FLASH | `Stm32L4Flash.cs` (new): ACR read-back, keys, page and bank erase on two 512 KB banks, option bytes that survive reset. While unlocked every CPU store is checked: PROGERR, PGAERR, SIZERR, WRPERR, PGSERR (a store with neither PG nor FSTPG), each undoing the store. Fast programming (FSTPG, 256-byte rows, FASTERR). EOP/OPERR/RDERR interrupts (EOPIE, ERRIE, RDERRIE). WRP and PCROP refuse program and erase; a data read in a PCROP area sets RDERR | Tested |
| SYSCFG | `Stm32L4Syscfg.cs` (new): EXTICR routing, CFGR1 (FWDIS clear-only), SRAM2 erase behind the SKR key, SRAM2 page write protection (stores undone), CFGR2, MEMRMP stored | Tested |
| DMA1/2 | Renode `STM32LDMA` + `Stm32L4DmaCselr.cs` (new): every request (ADC1–3, DAC, SPI1–3, I2C1–4 RX, U(S)ART1–5 RX, SDMMC1) reaches the DMA1 or DMA2 channel whose CSELR selects it, or is dropped | Tested |
| DBGMCU | `Stm32L4Dbgmcu.cs` (new): DEV_ID 0x461 | Tested |
| GPIO A–I, EXTI 0–22 | Renode; ports reach EXTI through SYSCFG; lines 18/20 RTC alarm/wake-up, 21/22 COMP1/2 | Tested |
| CAN1/CAN2 | `Stm32BxCan.cs` (new, on Renode's `STMCAN`: filters shared with CAN2, RX FIFOs): on the arbitrated bus, mailboxes offered by ID or request order (TXFP), bus-timed completion (TSR), NART, ABRQ, TX interrupt, ESR TEC/LEC/EWGF/EPVF from the bus; bit rate from BTR on PCLK1; BTR readable in any mode | Tested |
| SPI1–3, I2C1–4, USART1–3, UART4/5, LPUART1 | Renode L5 SPI, the vHIL's I2C master, F7 USART; DMA requests wired | Placed |
| TIM1–8, 15–17, LPTIM1/2, IWDG, WWDG | Renode; IWDG on the 32 kHz LSI, WWDG on PCLK1. TRGO (update event, CR2.MMS kept by `VhilTimerTrgo`) triggers the ADC and DAC | Tested |
| ADC1/2/3 + common | `Stm32L4Adc.cs` (new, on Renode's L5 ADC): DEEPPWD, ADCAL completes at once, CALFACT; clock from CCR.CKMODE/PRESC; conversion time from SMPx and RES; timer TRGO triggers (EXTSEL); dual mode (ADC1 starts ADC2, CDR) | Tested |
| DAC1, OPAMP1/2, COMP1/2, VREFBUF | `Stm32L4Analog.cs` (new): DAC holding/output registers, software and timer triggers, noise/triangle waves, DMA; OPAMP PGA and follower; COMP against VREFINT fractions or the DAC, output on EXTI; VREFBUF 2.048/2.5 V | Tested |
| RTC, SDMMC1, QUADSPI | Renode F4 RTC (at RTCCLK), F4/F7 SDMMC, H7 QUADSPI; memory-mapped mode maps the attached flash at 0x90000000 (`Stm32L4QuadSpiMap.cs`) | Tested |
| CRC, RNG | Renode | Placed |

Tests: [`tests/sim/test_stm32l496_platform.py`](../../tests/sim/test_stm32l496_platform.py)
loads the platform with no firmware (marker `platform_stm32l496`, see
[`docs/ci.md`](../ci.md)) and checks a CubeMX start-up's registers: the HSE →
PLL → 80 MHz sequence and the rates it sets, wait-state read-back, peripheral
resets, every reset cause (the watchdogs by running out), the backup domain,
bxCAN on an arbitrated bus with a probe (send, priority, NART, error
counting, receive through filters, abort, Tx interrupt),
EXTI port selection, DMA request routing, SYSCFG, the ADC (calibration,
clock, timing, triggers, dual mode), the analog blocks, QUADSPI
memory-mapped mode, and the flash (keys, erase, programming errors, fast
programming, interrupts, PCROP, option bytes; CPU stores from a small
program in SRAM).

Known gaps, none needed by the SensorHub so far:

- **Not placed:** SAI1/2, USB OTG FS, DFSDM1, LCD, TSC, SWPMI1, DCMI, DMA2D,
  FMC. Renode has no model of them and the SensorHub doesn't use them; a
  firmware that touches one is stopped by the peripheral guard.
- **Timing:** I2C transfers take no bus time (so no I2C kernel clock). The
  core's instruction rate is `cpu.mips`, as on every platform.
- **Partly modelled:**
  - SYSCFG MEMRMP: stored, but flash stays at 0.
  - DAC trigger EXTI9; ADC triggers from timer compare events and EXTI11;
    TRGO sources other than the update event.
  - ADC interleaved and alternate-trigger dual modes run as simultaneous.
  - The DAC output does not loop back to the ADC pins.
  - U(S)ART TX DMA (Renode's USART asks only for RX); LPUART1 and QUADSPI
    DMA requests are not wired.
  - A PCROP data read sets RDERR but returns the data.
  - A store to flash while FLASH_CR is locked lands; `checkAllStores: true`
    on `flashController` checks it, at a speed cost.
  - FWRSTF and LPWRRSTF (no firewall or low-power modes).

## Plan

Each milestone ends in something you can run and a PR into `dev`.

1. **M1: platform boots the firmware.** *(Platform done at register level;
   the boot check waits for the firmware.)* `platforms/cpus/stm32l496.repl` and
   `catalog/platforms/stm32l496.yaml`; HSE 16 MHz; the HAL tick runs; the
   peripheral guard lists nothing unexplained.
   *Done when:* the firmware reaches its main loop and toggles the heartbeat
   (PB13) at its real period.
2. **M2: on the CAN bus.** *(Done with a test image: bxCAN on the
   arbitrated bus, the board and system entries; the firmware's own frames
   wait for the firmware.)* bxCAN implementing
   `IVhilCanController`.
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
- **Schematic, ADC nets:** the dividers' nets are labelled `ADC1_IN` /
  `ADC1_MCU` (… `ADC4`), while J1's are `ADC_IN1` and the MCU's
  `ADC_IN1_MCU`. As drawn, R15/R16 (and the other three) join neither, so
  J1's inputs reach no pin. The vHIL models the intent (connector → divider →
  PC0..PC3); fix the labels before layout.
- **External sensors:** what hangs off I2C, SPI and ADC_IN1..4 in each
  mounting position? Those become devices in the system.
