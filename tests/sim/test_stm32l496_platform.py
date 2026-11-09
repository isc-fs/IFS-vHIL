"""The STM32L496 platform (platforms/cpus/stm32l496.repl) at register level,
loaded on its own: no system and no firmware, since the SensorHub has none
yet (docs/boards/sensorhub.md). Each test pokes the registers a CubeMX
image's start-up touches and checks what it reads back.

Facts (stm32l496xx.h, RM0351; the models' headers cite each):
  RCC 0x40021000: CR 0x00 (MSION 0, MSIRDY 1, HSION 8, HSIRDY 10, HSEON 16,
    HSERDY 17, PLLON 24, PLLRDY 25), CFGR 0x08 (SW [1:0], SWS [3:2]: 0 MSI,
    1 HSI16, 2 HSE, 3 PLL), PLLCFGR 0x0C (PLLSRC [1:0]: 2 HSI16, 3 HSE),
    CIER 0x18, CIFR 0x1C, CICR 0x20, BDCR 0x90 (LSEON 0, LSERDY 1, BDRST
    16), CSR 0x94 (LSION 0, LSIRDY 1, RMVF 23, PINRSTF 26, BORRSTF 27).
    CR resets to 0x63 (MSI on, 4 MHz), CSR to 0x0C000600 at power-on.
  PWR 0x40007000: CR1 0x00 (DBP 8, VOS [10:9], LPR 14), SR2 0x14 (REGLPS 8,
    REGLPF 9, VOSF 10).
  FLASH 0x40022000: ACR 0x00 (LATENCY [2:0], reset 0x600), KEYR 0x08,
    OPTKEYR 0x0C, SR 0x10 (EOP 0), CR 0x14 (PER 1, MER1 2, PNB [10:3], BKER
    11, STRT 16, OPTSTRT 17, EOPIE 24, OPTLOCK 30, LOCK 31), OPTR 0x20
    (factory 0xFFEFF8AA). Keys 0x45670123/0xCDEF89AB, option keys
    0x08192A3B/0x4C5D6E7F. Two 512 KB banks of 2 KB pages.
  DMA1_CSELR 0x400200A8; DBGMCU_IDCODE 0xE0042000 (DEV_ID 0x461).
  SRAM2 at 0x10000000 is the same memory as 0x20040000; flash answers at 0.
  RCC_IRQn 5: NVIC_ISPR0 0xE000E200 bit 5.
"""
import pytest
import yaml

from vhil import models, renode as rn
from vhil.bench import DEFAULT_RENODE, _free_port
from vhil.system import REPO

# Impact selection (ci/impact.yaml, docs/ci.md): the platform alone, no system.
pytestmark = [pytest.mark.platform_stm32l496, pytest.mark.reset, pytest.mark.flash, pytest.mark.dma]

RCC, PWR, FLASH = 0x40021000, 0x40007000, 0x40022000
CR, CFGR, PLLCFGR, CIER, CIFR, CICR, BDCR, CSR = (RCC + o for o in (0x00, 0x08, 0x0C, 0x18, 0x1C, 0x20,
                                                                     0x90, 0x94))
MSION, MSIRDY, HSION, HSIRDY = 1 << 0, 1 << 1, 1 << 8, 1 << 10
HSEON, HSERDY, PLLON, PLLRDY = 1 << 16, 1 << 17, 1 << 24, 1 << 25
PINRSTF, BORRSTF, RMVF = 1 << 26, 1 << 27, 1 << 23
PWR_CR1, PWR_SR2 = PWR + 0x00, PWR + 0x14
DBP, LPR, REGLPF, VOSF = 1 << 8, 1 << 14, 1 << 9, 1 << 10
ACR, KEYR, OPTKEYR, FSR, FCR, OPTR = (FLASH + o for o in (0x00, 0x08, 0x0C, 0x10, 0x14, 0x20))
LOCK, OPTLOCK, STRT, OPTSTRT, PER, MER1, BKER, EOPIE = (1 << 31, 1 << 30, 1 << 16, 1 << 17, 1 << 1,
                                                       1 << 2, 1 << 11, 1 << 24)
ISPR0 = 0xE000E200
PLATFORM = yaml.safe_load((REPO / "catalog" / "platforms" / "stm32l496.yaml").read_text())


class Platform:
    """One STM32L496 machine in Renode, nothing loaded into it."""

    def __init__(self):
        port = _free_port()
        self.proc = rn.launch(DEFAULT_RENODE, port)
        self.mon = rn.RenodeMonitor(port, timeout_s=300)
        self.mon.execute(models.include_command())
        self.mon.execute('mach create "hub"')
        self.mon.execute(f"machine LoadPlatformDescription {rn.file_arg(REPO / PLATFORM['renode']['repl'])}")
        for command in PLATFORM["renode"]["setup"]:
            self.mon.execute(command)

    def rd(self, address: int) -> int:
        return int(self.mon.execute(f"sysbus ReadDoubleWord {address:#x}").strip(), 16)

    def wr(self, address: int, value: int) -> None:
        self.mon.execute(f"sysbus WriteDoubleWord {address:#x} {value:#x}")

    def reset(self) -> None:
        self.mon.execute("machine Reset")

    def close(self) -> None:
        self.proc.kill()
        self.proc.wait()


@pytest.fixture
def l4():
    p = Platform()
    yield p
    p.close()


def _pll_from_hse(l4):
    """SystemClock_Config's sequence for 80 MHz from the 16 MHz HSE."""
    l4.wr(CR, l4.rd(CR) | HSEON)
    l4.wr(PLLCFGR, (1 << 24) | (10 << 8) | 3)          # PLLREN, N 10, M 1, PLLSRC HSE
    l4.wr(CR, l4.rd(CR) | PLLON)
    l4.wr(ACR, (l4.rd(ACR) & ~7) | 4)                   # 4 wait states
    l4.wr(CFGR, 3)                                      # SW = PLL


def test_reset_state_is_msi_at_4_mhz(l4):
    assert l4.rd(CR) == 0x63
    assert l4.rd(CFGR) == 0, "SWS = MSI"
    assert l4.rd(CSR) == 0x0C000600, "power-on: PINRSTF | BORRSTF, MSISRANGE 6"
    assert l4.rd(ACR) == 0x600
    assert l4.rd(0xE0042000) & 0xFFF == 0x461


def test_the_hse_crystal_and_the_pll_become_ready(l4):
    l4.wr(CR, l4.rd(CR) | HSEON)
    assert l4.rd(CR) & HSERDY
    l4.wr(PLLCFGR, (1 << 24) | (10 << 8) | 3)
    l4.wr(CR, l4.rd(CR) | PLLON)
    assert l4.rd(CR) & PLLRDY


def test_the_system_clock_switches_to_the_pll_and_wait_states_read_back(l4):
    _pll_from_hse(l4)
    assert l4.rd(ACR) & 7 == 4, "HAL_RCC_ClockConfig reads LATENCY back"
    assert (l4.rd(CFGR) >> 2) & 3 == 3, "SWS = PLL"


def test_a_switch_to_a_source_that_is_not_ready_keeps_the_old_one(l4):
    l4.wr(CFGR, 2)                                      # HSE, still off
    assert (l4.rd(CFGR) >> 2) & 3 == 0
    l4.wr(CR, l4.rd(CR) | HSEON)                        # ready now: the switch completes
    assert (l4.rd(CFGR) >> 2) & 3 == 2


def test_the_clock_in_use_cannot_be_switched_off(l4):
    _pll_from_hse(l4)
    l4.wr(CR, MSION)                                    # try to drop HSE and the PLL
    assert l4.rd(CR) & (HSEON | PLLON) == HSEON | PLLON
    l4.wr(CFGR, 0)                                      # back to MSI ...
    l4.wr(CR, MSION)                                    # ... then they may go
    assert l4.rd(CR) & (HSEON | PLLON | PLLRDY) == 0


def test_a_ready_flag_raises_the_rcc_interrupt_when_enabled(l4):
    l4.wr(CIER, 1 << 4)                                 # HSERDYIE
    l4.wr(CR, l4.rd(CR) | HSEON)
    assert l4.rd(CIFR) & (1 << 4)
    assert l4.rd(ISPR0) & (1 << 5), "RCC_IRQn 5 pending"
    l4.wr(CICR, 1 << 4)
    assert l4.rd(CIFR) == 0


def test_without_a_crystal_lse_never_becomes_ready(l4):
    l4.wr(PWR_CR1, l4.rd(PWR_CR1) | DBP)
    l4.wr(BDCR, 1)                                      # LSEON: the SensorHub fits no LSE
    assert l4.rd(BDCR) & 3 == 1


def test_the_backup_domain_is_written_only_with_dbp_and_survives_a_reset(l4):
    l4.wr(BDCR, 1 << 15)                                # RTCEN, DBP clear: ignored
    assert l4.rd(BDCR) == 0
    l4.wr(PWR_CR1, l4.rd(PWR_CR1) | DBP)
    l4.wr(BDCR, (1 << 15) | (2 << 8))                   # RTCEN, RTCSEL LSI
    l4.reset()
    assert l4.rd(BDCR) == (1 << 15) | (2 << 8), "VBAT domain: kept across a system reset"
    l4.wr(PWR_CR1, l4.rd(PWR_CR1) | DBP)
    l4.wr(BDCR, 1 << 16)                                # BDRST
    l4.wr(BDCR, 0)
    assert l4.rd(BDCR) == 0


def test_reset_flags_add_pinrstf_and_clear_with_rmvf(l4):
    l4.wr(CSR, RMVF)
    assert l4.rd(CSR) & 0xFF000000 == 0
    l4.reset()
    assert l4.rd(CSR) & 0xFF000000 == PINRSTF, "every reset drives NRST"
    assert l4.rd(CR) == 0x63 and l4.rd(CFGR) == 0


def test_voltage_scaling_and_low_power_run_settle_at_once(l4):
    l4.wr(PWR_CR1, (l4.rd(PWR_CR1) & ~(3 << 9)) | (2 << 9))   # range 2
    assert l4.rd(PWR_SR2) & VOSF == 0
    l4.wr(PWR_CR1, l4.rd(PWR_CR1) | LPR)
    assert l4.rd(PWR_SR2) & REGLPF


def _unlock(l4):
    l4.wr(KEYR, 0x45670123)
    l4.wr(KEYR, 0xCDEF89AB)


def test_flash_unlocks_with_its_keys_only(l4):
    l4.wr(FCR, PER)
    assert l4.rd(FCR) == LOCK | OPTLOCK, "locked: CR ignores writes"
    l4.wr(KEYR, 0x12345678)
    l4.wr(KEYR, 0x45670123)
    l4.wr(KEYR, 0xCDEF89AB)
    assert l4.rd(FCR) & LOCK, "a wrong key locks it until reset"
    l4.reset()
    _unlock(l4)
    assert l4.rd(FCR) & LOCK == 0


def test_a_page_erase_fills_the_page_of_its_bank(l4):
    bank2_page3 = 0x08080000 + 3 * 0x800
    l4.wr(bank2_page3, 0x12345678)
    l4.wr(bank2_page3 + 0x7FC, 0x12345678)
    l4.wr(bank2_page3 + 0x800, 0x12345678)              # the next page stays
    _unlock(l4)
    l4.wr(FCR, PER | BKER | (3 << 3) | EOPIE)
    l4.wr(FCR, PER | BKER | (3 << 3) | EOPIE | STRT)
    assert l4.rd(bank2_page3) == 0xFFFFFFFF and l4.rd(bank2_page3 + 0x7FC) == 0xFFFFFFFF
    assert l4.rd(bank2_page3 + 0x800) == 0x12345678
    assert l4.rd(FSR) & 1, "EOP, with EOPIE set"
    assert l4.rd(FCR) & STRT == 0
    l4.wr(FSR, 1)
    assert l4.rd(FSR) == 0


def test_a_bank_erase_leaves_the_other_bank(l4):
    l4.wr(0x08000000, 0)
    l4.wr(0x08080000, 0)
    _unlock(l4)
    l4.wr(FCR, MER1 | STRT)
    assert l4.rd(0x08000000) == 0xFFFFFFFF and l4.rd(0x08080000) == 0


def test_option_bytes_take_effect_only_when_programmed(l4):
    assert l4.rd(OPTR) == 0xFFEFF8AA
    _unlock(l4)
    l4.wr(OPTKEYR, 0x08192A3B)
    l4.wr(OPTKEYR, 0x4C5D6E7F)
    assert l4.rd(FCR) & OPTLOCK == 0
    staged = (0xFFEFF8AA & ~(7 << 8)) | (2 << 8)         # BOR level 2
    l4.wr(OPTR, staged)
    assert l4.rd(OPTR) == staged
    l4.reset()
    assert l4.rd(OPTR) == 0xFFEFF8AA, "never programmed: reloaded from the option bytes"
    _unlock(l4)
    l4.wr(OPTKEYR, 0x08192A3B)
    l4.wr(OPTKEYR, 0x4C5D6E7F)
    l4.wr(OPTR, staged)
    l4.wr(FCR, OPTSTRT)
    l4.reset()
    assert l4.rd(OPTR) == staged, "programmed: survives reset"


def test_dma_cselr_and_the_memory_aliases(l4):
    l4.wr(0x400200A8, 0x5)
    assert l4.rd(0x400200A8) == 0x5
    l4.wr(0x10000000, 0xCAFE)
    assert l4.rd(0x20040000) == 0xCAFE, "SRAM2 at both addresses"
    l4.wr(0x08000000, 0x20050000)
    assert l4.rd(0x0) == 0x20050000, "flash at 0 for the vector table"
    assert int(l4.mon.execute("sysbus ReadWord 0x1FFF75E0").strip(), 16) == 0x400
