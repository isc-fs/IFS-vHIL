"""systems/sensorhub.yaml boots on its platform and puts its CAN controllers
on the arbitrated buses.

The SensorHub's firmware is not in the catalogue yet, so the image here is a
test program, a few register stores from the reset vector: no firmware runs.
It checks what the system adds over tests/sim/test_stm32l496_platform.py:
the rendered script loads, the board boots from the vector table its image
links at 0x08000000 (no bootloader), CAN1 is a node of `can1`, and an input's
board front end gives the pin voltage (catalog/boards/sensorhub.yaml)."""
import struct

import pytest

from vhil.sim import Sim
from vhil.system import REPO

pytestmark = [pytest.mark.system_sensorhub, pytest.mark.can, pytest.mark.adc, pytest.mark.i2c,
              pytest.mark.gnss]

SYSTEM = REPO / "systems" / "sensorhub.yaml"
FLASH, SP = 0x08000000, 0x20010000

# stm32l496xx.h: RCC_BASE 0x40021000, APB1ENR1 at 0x58 (CAN1EN bit 25);
# CAN1_BASE 0x40006400: MCR 0x00, BTR 0x1C, TI0R 0x180, TDT0R 0x184, TDL0R 0x188.
RCC_APB1ENR1, CAN1 = 0x40021058, 0x40006400
STORES = [
    (RCC_APB1ENR1, 1 << 25),
    (CAN1 + 0x00, 1),                       # MCR: INRQ, out of sleep
    (CAN1 + 0x1C, 1 << 16),                 # BTR: BRP 0, TS1 1, TS2 0 -> 4 MHz / 4 = 1 Mbit/s
    (CAN1 + 0x00, 0),                       # leave initialization
    (CAN1 + 0x184, 2),                      # DLC 2
    (CAN1 + 0x188, 0xBEEF),
    (CAN1 + 0x180, 0x123 << 21 | 1),        # standard ID 0x123, TXRQ
]


def _program(stores) -> bytes:
    """Thumb code: ldr r0/r1 from a literal pool, str r1,[r0] per store, then
    `b .`; its vector table first."""
    code, pool = [], []
    for address, value in stores:
        for reg, word in ((0, address), (1, value)):
            pool.append(word)
            code.append(("ldr", reg, len(pool) - 1))
        code.append(0x6001)
    code.append(0xE7FE)                      # b .
    if len(code) % 2:
        code.append(0xBF00)
    start = 8                                # after SP and the reset vector
    pool_at = start + 2 * len(code)
    halves = []
    for i, op in enumerate(code):
        if isinstance(op, int):
            halves.append(op)
        else:
            pc = (start + 2 * i + 4) & ~3
            halves.append(0x4800 | (op[1] << 8) | ((pool_at + 4 * op[2] - pc) // 4))
    return (struct.pack("<II", SP, FLASH + start + 1) + struct.pack(f"<{len(halves)}H", *halves)
            + struct.pack(f"<{len(pool)}I", *pool))


def _elf(path, image: bytes) -> None:
    """A one-segment ARM ELF32 (executable) loading `image` at FLASH."""
    ehsize, phsize = 52, 32
    header = struct.pack("<4sBBBB8xHHIIIIIHHHHHH", b"\x7fELF", 1, 1, 1, 0,
                         2, 40, 1, FLASH + 9, ehsize, 0, 0x05000200, ehsize, phsize, 1, 40, 0, 0)
    segment = struct.pack("<IIIIIIII", 1, ehsize + phsize, FLASH, FLASH, len(image), len(image), 5, 4)
    path.write_bytes(header + segment + image)


@pytest.fixture
def sim(tmp_path):
    elf = tmp_path / "hub.elf"
    _elf(elf, _program(STORES))
    with Sim(SYSTEM, {"sensorhub": elf}) as s:
        yield s


def test_the_board_boots_its_image_and_can1_sends_on_its_bus(sim):
    sim.run_for(ms=2)
    frames = sim.can("can1").timeline()
    assert [(f.node, f.id, f.data, f.outcome) for f in frames] == [
        ("sensorhub:sysbus.can1", 0x123, b"\xef\xbe", "ok")]
    assert sim.can("can2").timeline() == []


def test_a_sensor_side_voltage_reaches_the_adc_through_the_divider(sim):
    pin = sim.system.sensor_to_pin("sensorhub.PC0", 5.0)
    sim.monitor(f"sysbus.adc1 SetVoltage {round(pin * 1e6)} 1", board="sensorhub")
    assert float(sim.monitor("sysbus.adc1 Voltage 1", board="sensorhub")) == pytest.approx(3.309, abs=1e-3)


@pytest.mark.reset
def test_a_power_cycle_wipes_the_rtc_backup_registers(sim):
    """VBAT is tied to 3V3 (vbat: false): a power cut loses the backup domain,
    which the platform's power_cut wipes (catalog/platforms/stm32l496.yaml);
    a reset keeps it."""
    bkp0r = 0x40002850
    sim.run_for(ms=1)
    sim.monitor(f"sysbus WriteDoubleWord {bkp0r:#x} 0xA5A5", board="sensorhub")
    sim.monitor("machine Reset", board="sensorhub")
    assert int(sim.monitor(f"sysbus ReadDoubleWord {bkp0r:#x}", board="sensorhub"), 16) == 0xA5A5
    sim.power_cycle("sensorhub")
    assert int(sim.monitor(f"sysbus ReadDoubleWord {bkp0r:#x}", board="sensorhub"), 16) == 0


def test_the_imu_answers_on_spi3_with_its_chip_selects(sim):
    """systems/sensorhub.yaml wires the BMI088 on SPI3, CSB1 PC4 / CSB2 PC5:
    chip IDs through SPI3's data register (stm32l496xx.h SPI3_BASE
    0x40003C00, GPIOC_BASE 0x48000800), the accelerometer's after its dummy
    byte."""
    spi3, gpioc = 0x40003C00, 0x48000800

    def wr(address, value):
        sim.monitor(f"sysbus WriteDoubleWord {address:#x} {value:#x}", board="sensorhub")

    def xfer(cs, data):
        wr(gpioc + 0x14, 0x30 & ~(1 << cs))
        out = []
        for b in data:
            sim.monitor(f"sysbus WriteByte {spi3 + 0x0C:#x} {b:#x}", board="sensorhub")
            out.append(int(sim.monitor(f"sysbus ReadByte {spi3 + 0x0C:#x}", board="sensorhub"), 16))
        wr(gpioc + 0x14, 0x30)
        return out

    sim.run_for(ms=1)
    wr(gpioc + 0x00, (1 << 8) | (1 << 10))              # MODER: PC4, PC5 outputs
    wr(gpioc + 0x14, 0x30)                              # deselect: CSB1's rising edge
    wr(spi3 + 0x04, (7 << 8) | (1 << 12))               # DS 8 bits, FRXTH
    wr(spi3 + 0x00, (1 << 2) | (1 << 6))                # MSTR, SPE
    assert xfer(4, [0x80, 0, 0])[2] == 0x1E
    assert xfer(5, [0x80, 0])[1] == 0x0F


def test_the_gnss_receiver_answers_on_i2c2_with_a_fix(sim):
    """systems/sensorhub.yaml wires a ZED-F9P on I2C2 at 0x42: after its
    first epoch (1 s) the bytes waiting (0xFD/0xFE) are NMEA, its GGA with
    the position set. I2C2_BASE 0x40005800 (stm32l496xx.h); CR2 SADD, RD_WRN
    bit 10, START 13, NBYTES 16, AUTOEND 25; RXDR 0x24, TXDR 0x28."""
    i2c2, rx = 0x40005800, "sysbus.i2c2.gnss_rx"

    def wr(address, value):
        sim.monitor(f"sysbus WriteDoubleWord {address:#x} {value:#x}", board="sensorhub")

    def read(n):
        wr(i2c2 + 0x04, (0x42 << 1) | (1 << 10) | (n << 16) | (1 << 25) | (1 << 13))
        return bytes(int(sim.monitor(f"sysbus ReadDoubleWord {i2c2 + 0x24:#x}", board="sensorhub"), 16)
                     for _ in range(n))

    sim.monitor(f"{rx} SetPosition 404168000 -37038000 650000", board="sensorhub")
    sim.run_for(ms=1010)
    wr(i2c2, 1)                                          # CR1: PE
    wr(i2c2 + 0x04, (0x42 << 1) | (1 << 16) | (1 << 13))  # write 0xFD, no AUTOEND
    wr(i2c2 + 0x28, 0xFD)
    hi, lo = read(2)
    stream = b""
    n = hi << 8 | lo
    while len(stream) < n:
        stream += read(min(255, n - len(stream)))
    gga = [line for line in stream.decode().split("\r\n") if line.startswith("$GNGGA")]
    assert gga and gga[0].split(",")[2:7] == ["4025.00800", "N", "00342.22800", "W", "1"]
