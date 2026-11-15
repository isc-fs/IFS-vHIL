"""The BMI088 on SPI (models/renode/Bmi088.cs, Bmi088Spi), as the SensorHub
wires it: SPI3, CSB1 (accelerometer) on PC4, CSB2 (gyroscope) on PC5
(catalog/boards/sensorhub.yaml). Bytes go through the L496's SPI3 data
register and the chip selects through GPIOC's ODR, as the firmware's would;
no firmware runs. Protocol after the Bosch datasheet BST-BMI088-DS001 ch. 6.1
(cited in the model's header)."""
import pytest

from tests.sim.test_stm32l496_platform import Platform
from vhil import renode as rn

pytestmark = [pytest.mark.platform_stm32l496, pytest.mark.i2c]

SPI3, GPIOC = 0x40003C00, 0x48000800           # stm32l496xx.h SPI3_BASE, GPIOC_BASE
CR1, CR2, DR = 0x00, 0x04, 0x0C
ODR = 0x14
ACC, GYR = 4, 5                                 # PC4 CSB1, PC5 CSB2


REPL = """imu: Sensors.Bmi088Spi @ spi3

gpioPortC:
    4 -> imu@0
    5 -> imu@1
"""


@pytest.fixture
def imu(tmp_path):
    p = Platform()
    repl = tmp_path / "imu.repl"
    repl.write_text(REPL)
    p.mon.execute(f"machine LoadPlatformDescription {rn.file_arg(repl)}")
    p.wr(GPIOC + 0x00, (1 << 2 * ACC) | (1 << 2 * GYR))     # MODER: PC4, PC5 outputs
    p.wr(GPIOC + ODR, (1 << ACC) | (1 << GYR))              # both deselected
    p.wr(SPI3 + CR2, (7 << 8) | (1 << 12))                  # DS 8 bits, FRXTH
    p.wr(SPI3 + CR1, (1 << 2) | (1 << 6))                   # MSTR, SPE
    yield p
    p.close()


def _xfer(p, cs: int, data: list[int]) -> list[int]:
    """One transaction: the die's chip select low, the bytes, high again."""
    p.wr(GPIOC + ODR, ((1 << ACC) | (1 << GYR)) & ~(1 << cs))
    out = []
    for b in data:
        p.mon.execute(f"sysbus WriteByte {SPI3 + DR:#x} {b:#x}")
        out.append(int(p.mon.execute(f"sysbus ReadByte {SPI3 + DR:#x}").strip(), 16))
    p.wr(GPIOC + ODR, (1 << ACC) | (1 << GYR))
    return out


def _read(p, cs: int, register: int, n: int) -> list[int]:
    dummy = 1 if cs == ACC else 0
    return _xfer(p, cs, [0x80 | register] + [0] * (dummy + n))[1 + dummy:]


def _write(p, cs: int, register: int, value: int) -> None:
    _xfer(p, cs, [register & 0x7F, value])


def test_the_accelerometer_answers_spi_only_after_a_rising_edge_of_csb1(imu):
    assert imu.value("sysbus.spi3.imu AccelerometerSpiMode") == "True", \
        "the fixture's deselect was CSB1's first rising edge"
    imu.mon.execute("machine Reset")
    imu.wr(GPIOC + 0x00, (1 << 2 * ACC) | (1 << 2 * GYR))
    imu.wr(SPI3 + CR2, (7 << 8) | (1 << 12))
    imu.wr(SPI3 + CR1, (1 << 2) | (1 << 6))
    assert imu.value("sysbus.spi3.imu AccelerometerSpiMode") == "False", "a power-on: I2C mode"
    # A reset port drives PC4/PC5 low: both dies selected until the first ODR write.
    imu.wr(GPIOC + ODR, (1 << ACC) | (1 << GYR))
    assert imu.value("sysbus.spi3.imu AccelerometerSpiMode") == "True"
    assert _read(imu, ACC, 0x00, 1) == [0x1E]


def test_an_accelerometer_read_has_a_dummy_byte_and_the_gyroscope_none(imu):
    raw_acc = _xfer(imu, ACC, [0x80, 0, 0])
    assert raw_acc[2] == 0x1E and raw_acc[1] == 0x00, "address, dummy, ACC_CHIP_ID"
    raw_gyr = _xfer(imu, GYR, [0x80, 0])
    assert raw_gyr[1] == 0x0F, "address, GYRO_CHIP_ID"


def test_acceleration_converts_at_the_range_after_power_up(imu):
    imu.mon.execute("sysbus.spi3.imu SetAcceleration 1000 -500 250")
    assert _read(imu, ACC, 0x12, 6) == [0] * 6, "suspended and off at power-on"
    _write(imu, ACC, 0x7C, 0x00)                            # ACC_PWR_CONF active
    _write(imu, ACC, 0x7D, 0x04)                            # ACC_PWR_CTRL on
    _write(imu, ACC, 0x41, 0x00)                            # ACC_RANGE +/-3 g
    raw = _read(imu, ACC, 0x12, 6)
    x, y, z = (int.from_bytes(bytes(raw[i:i + 2]), "little", signed=True) for i in (0, 2, 4))
    assert (x, y, z) == (round(1000 / 3000 * 32768), round(-500 / 3000 * 32768),
                         round(250 / 3000 * 32768))
    assert int(imu.value("sysbus.spi3.imu AccelerometerReadCount 0x12"), 0) == 2


def test_the_gyroscope_converts_and_a_burst_auto_increments(imu):
    imu.mon.execute("sysbus.spi3.imu SetAngularRate 100 -200 50")
    _write(imu, GYR, 0x0F, 0x02)                            # GYRO_RANGE +/-500 dps
    assert int(imu.value("sysbus.spi3.imu GyroscopeRegister 0x0F"), 0) == 2
    raw = _read(imu, GYR, 0x02, 6)
    rates = [int.from_bytes(bytes(raw[i:i + 2]), "little", signed=True) for i in (0, 2, 4)]
    assert rates == [round(d * 65.536) for d in (100, -200, 50)]


def test_a_soft_reset_returns_the_accelerometer_to_i2c_mode(imu):
    """bmi08a.c bmi08a_soft_reset repeats the dummy read afterwards."""
    _write(imu, ACC, 0x41, 0x03)
    imu.wr(GPIOC + ODR, (1 << GYR))                         # CSB1 low
    for b in (0x7E, 0xB6):                                  # ACC_SOFTRESET
        imu.mon.execute(f"sysbus WriteByte {SPI3 + DR:#x} {b:#x}")
        imu.mon.execute(f"sysbus ReadByte {SPI3 + DR:#x}")
    assert imu.value("sysbus.spi3.imu AccelerometerSpiMode") == "False"
    imu.wr(GPIOC + ODR, (1 << ACC) | (1 << GYR))            # the rising edge: SPI again
    assert imu.value("sysbus.spi3.imu AccelerometerSpiMode") == "True"
    assert int(imu.value("sysbus.spi3.imu AccelerometerRegister 0x41"), 0) == 1, "reset value"


def test_an_unpowered_die_reads_nothing_and_the_other_still_answers(imu):
    imu.mon.execute("sysbus.spi3.imu GyroscopeResponds false")
    assert _read(imu, GYR, 0x00, 1) == [0x00]
    assert _read(imu, ACC, 0x00, 1) == [0x1E]
