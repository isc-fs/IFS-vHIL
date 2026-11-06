"""SPI1 transfers take their clocked time (#368).

Renode's STM32H7 SPI shifted a frame the moment it was written, so every
isoSPI transfer of the AMS took no virtual time and its ADOW pull-up to
pull-down gap was 6 ms instead of the car's ~11-13 ms (isc-fs/IFS08-CE-AMS
#641). models/renode/Stm32H7Spi.cs now clocks each frame at
f_SCK = kernel clock / 2^(MBR + 1).

AMS facts (IFS08-CE-AMS):
  SPI1: master, 8-bit frames, prescaler 256, MIDI 0 cycles, software NSS
    (main.c:621-640); kernel clock PLL1Q (stm32h7xx_hal_msp.c:397) = HSE
    24 MHz / M 2 x N 44 / Q 4 = 132 MHz (main.c:377-380): 515.625 kHz,
    15.52 us a byte.
  The LTC6820's chip select is PB9 (systems/ams.yaml), driven by GPIO around
    each transaction (ltc6820.cpp Bus::transfer). A command is 4 bytes
    (2 command + 2 PEC); a register-group read on the 10-IC chain is 4 + 10 x
    8 = 84 bytes (ltc6820.cpp read_register_group, ams_config.hpp
    LtcChainLength).
"""
import pytest

from vhil.sim import Sim
from vhil.system import REPO

# Impact selection (ci/impact.yaml, docs/ci.md): boards, systems, subsystems.
pytestmark = [pytest.mark.ams, pytest.mark.system_ams, pytest.mark.isospi]

BOARD = "ams"
CS = ("sysbus.gpioPortB", 9)
SCK_HZ = 132_000_000 / 256
BYTE_US = 8 / SCK_HZ * 1e6
COMMAND_US = 4 * BYTE_US          # 62.1 us
READ_US = 84 * BYTE_US            # 1303.3 us
WAKE_MAX_US = 40                  # a wake pulse holds CS low 20 us with no clocks
# What a window spends besides its bytes: the HAL's set-up and close, the
# GPIO writes, a poll's last pass. A higher-priority task may also take the
# CPU inside one; the lower bound is the hard one.
SLACK_US = 150


@pytest.fixture(scope="module")
def windows(images):
    with Sim(REPO / "systems" / "ams.yaml", images("ams")) as sim:
        pin = sim.io(BOARD).watch(*CS)
        sim.wait_for_app()
        sim.run_for(ms=4000)                                # past boot grace
        since = sim.now_us()
        sim.run_for(ms=1000)                                # five voltage polls
        edges = [e for e in sim.io(BOARD).edges(pin) if e.t_us >= since]
        lows = [b.t_us - a.t_us for a, b in zip(edges, edges[1:]) if not a.level and b.level]
        sck = float(sim.monitor("sysbus.spi1 SckHz", board=BOARD).strip())
        timed = int(sim.monitor("sysbus.spi1 TimedFrames", board=BOARD).strip(), 0)
        yield {"lows": [w for w in lows if w > WAKE_MAX_US], "sck": sck, "timed": timed}


def test_spi1_clocks_at_the_firmware_rate(windows):
    assert windows["sck"] == pytest.approx(SCK_HZ)
    assert windows["timed"] > 0


def test_no_transaction_is_shorter_than_its_command(windows):
    lows = windows["lows"]
    assert lows, "no isoSPI transaction on PB9"
    assert min(lows) >= COMMAND_US - 1, f"CS low windows (us): {sorted(lows)[:10]}"


def test_a_register_group_read_takes_its_84_bytes(windows):
    reads = [w for w in windows["lows"] if w >= READ_US / 2]
    assert reads, f"no register-group read: {sorted(windows['lows'])[-10:]}"
    assert min(reads) >= READ_US - 1, f"reads (us): {sorted(reads)[:10]}"
    assert sorted(reads)[len(reads) // 2] <= READ_US + SLACK_US, f"reads (us): {sorted(reads)}"
