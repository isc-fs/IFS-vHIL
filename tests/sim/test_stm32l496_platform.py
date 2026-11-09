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
pytestmark = [pytest.mark.platform_stm32l496, pytest.mark.reset, pytest.mark.flash, pytest.mark.dma,
              pytest.mark.adc, pytest.mark.timers]

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
PG, PGSERR, PROGERR, WRPERR, PGAERR, SIZERR = 1 << 0, 1 << 7, 1 << 3, 1 << 4, 1 << 5, 1 << 6
SFTRSTF, IWDGRSTF, WWDGRSTF, OBLRSTF = 1 << 28, 1 << 29, 1 << 30, 1 << 25
ISPR0 = 0xE000E200
B_SELF, PROGRAM, ONCE_MARKER = 0xE7FE, 0x20000000, 0x20008000
UNLOCK = [(KEYR, 0x45670123, 4), (KEYR, 0xCDEF89AB, 4)]
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
            self.mon.execute(command.format(board="hub"))

    def rd(self, address: int) -> int:
        return int(self.mon.execute(f"sysbus ReadDoubleWord {address:#x}").strip(), 16)

    def wr(self, address: int, value: int) -> None:
        self.mon.execute(f"sysbus WriteDoubleWord {address:#x} {value:#x}")

    def get(self, peripheral: str, prop: str) -> int:
        return int(self.mon.execute(f"sysbus.{peripheral} {prop}").strip(), 16)

    def run_program(self, stores, once: bool = False) -> None:
        """Run `stores` [(address, value, bytes)] as CPU stores (so they pass
        the CPU's memory hooks, which the monitor's bus writes do not), from
        the reset vector, then idle. `once`: skip them after a reset (a
        marker word in SRAM1), for a program that resets the machine."""
        code, pool = [], []

        def ldr(reg, word):
            pool.append(word)
            code.append(("ldr", reg, len(pool) - 1))

        if once:
            ldr(0, ONCE_MARKER)
            code += [0x6801, 0x2900, ("bne",), 0x2101, 0x6001]   # ldr r1,[r0]; cmp; bne idle; movs; str
        for address, value, size in stores:
            ldr(0, address)
            ldr(1, value)
            code.append({4: 0x6001, 2: 0x8001, 1: 0x7001}[size])  # str/strh/strb r1,[r0]
        idle = len(code)
        code.append(B_SELF)
        if len(code) % 2:
            code.append(0xBF00)                                   # nop: the pool is word-aligned
        pool_at = 2 * len(code)
        words = []
        for i, op in enumerate(code):
            if isinstance(op, int):
                words.append(op)
            elif op[0] == "bne":
                words.append(0xD100 | ((idle * 2 - (i * 2 + 4)) // 2) & 0xFF)
            else:
                _, reg, n = op
                words.append(0x4800 | (reg << 8) | ((pool_at + 4 * n - ((i * 2 + 4) & ~3)) // 4))
        for i, h in enumerate(words):
            self.mon.execute(f"sysbus WriteWord {PROGRAM + 2 * i:#x} {h:#x}")
        for n, w in enumerate(pool):
            self.mon.execute(f"sysbus WriteDoubleWord {PROGRAM + pool_at + 4 * n:#x} {w:#x}")
        self.mon.execute("sysbus WriteDoubleWord 0x08000000 0x20010000")
        self.mon.execute(f"sysbus WriteDoubleWord 0x08000004 {PROGRAM | 1:#x}")
        self.mon.execute('emulation RunFor "0.001"')

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


# --- clock tree ------------------------------------------------------------

def test_the_reset_clock_times_everything_at_msi_4_mhz(l4):
    assert l4.get("rcc", "SysclkHz") == 4_000_000
    for p in ("nvic", "timer2", "timer1", "lptim1"):
        assert l4.get(p, "Frequency") == 4_000_000, p


def test_the_clock_tree_retimes_the_systick_timers_and_uarts(l4):
    _pll_from_hse(l4)
    l4.wr(CFGR, 3 | (4 << 8))                           # PPRE1 /2: PCLK1 40 MHz
    assert l4.get("rcc", "SysclkHz") == 80_000_000
    assert l4.get("rcc", "Pclk1Hz") == 40_000_000
    assert l4.get("rcc", "Pclk2Hz") == 80_000_000
    assert l4.get("nvic", "Frequency") == 80_000_000, "SysTick on HCLK"
    assert l4.get("timer2", "Frequency") == 80_000_000, "APB1 timers x2 with PPRE1 > 1"
    assert l4.get("timer1", "Frequency") == 80_000_000
    assert l4.get("lptim1", "Frequency") == 40_000_000, "LPTIM1SEL 0: PCLK1"
    l4.wr(CFGR, 3 | (8 << 4))                           # HPRE /2: HCLK 40 MHz
    assert l4.get("nvic", "Frequency") == 40_000_000


def test_msirange_sets_the_msi_rate(l4):
    l4.wr(CR, (l4.rd(CR) & ~0xF0) | (11 << 4) | (1 << 3))   # MSIRANGE 11, MSIRGSEL
    assert l4.get("rcc", "SysclkHz") == 48_000_000
    assert l4.get("timer6", "Frequency") == 48_000_000


# --- peripheral resets --------------------------------------------------------

def test_an_rstr_bit_resets_its_peripheral(l4):
    tim2_arr = 0x40000000 + 0x2C
    l4.wr(tim2_arr, 0x1234)
    l4.wr(RCC + 0x38, 1)                                # APB1RSTR1.TIM2RST
    l4.wr(RCC + 0x38, 0)
    assert l4.rd(tim2_arr) == 0xFFFFFFFF, "ARR back to its reset value"
    assert l4.get("rcc", 'ResetsOf "timer2"') == 2


def test_a_gpio_reset_keeps_the_levels_driven_from_outside(l4):
    gpioc_idr = 0x48000800 + 0x10
    l4.mon.execute("sysbus.gpioPortC OnGPIO 3 true")
    assert l4.rd(gpioc_idr) & (1 << 3)
    l4.wr(RCC + 0x2C, 1 << 2)                           # AHB2RSTR.GPIOCRST
    l4.wr(RCC + 0x2C, 0)
    assert l4.rd(gpioc_idr) & (1 << 3)


# --- reset causes ---------------------------------------------------------------

def test_a_software_reset_sets_sftrstf(l4):
    l4.wr(CSR, RMVF)
    l4.run_program([(0xE000ED0C, 0x05FA0004, 4)], once=True)   # AIRCR.SYSRESETREQ
    assert l4.rd(CSR) & 0xFF000000 == SFTRSTF | PINRSTF

def test_a_watchdog_reset_sets_its_flag(l4):
    l4.wr(CSR, RMVF)
    l4.wr(0x40003000, 0xCCCC)                           # IWDG_KR: start
    l4.reset()
    assert l4.rd(CSR) & 0xFF000000 == IWDGRSTF | PINRSTF
    l4.wr(CSR, RMVF)
    l4.wr(0x40002C00, 0xFF)                             # WWDG_CR.WDGA
    l4.reset()
    assert l4.rd(CSR) & 0xFF000000 == WWDGRSTF | PINRSTF


def test_a_power_on_clears_the_flags_and_the_backup_domain(l4):
    l4.wr(PWR_CR1, l4.rd(PWR_CR1) | DBP)
    l4.wr(BDCR, 1 << 15)                                # RTCEN
    l4.wr(CSR, RMVF)
    l4.mon.execute("vhil_reset_hub PinReset")
    l4.run_program([])                                  # the requested reset happens
    assert l4.rd(CSR) & 0xFF000000 == PINRSTF
    assert l4.rd(BDCR) == 1 << 15, "a pin reset keeps the backup domain"
    l4.mon.execute("vhil_reset_hub PowerOn")
    l4.reset()
    assert l4.rd(CSR) == 0x0C000600
    assert l4.rd(BDCR) == 0

def test_obl_launch_sets_oblrstf(l4):
    l4.wr(CSR, RMVF)
    l4.run_program(UNLOCK + [(OPTKEYR, 0x08192A3B, 4), (OPTKEYR, 0x4C5D6E7F, 4), (FCR, 1 << 27, 4)],
                   once=True)                           # OBL_LAUNCH
    assert l4.rd(CSR) & 0xFF000000 == OBLRSTF | PINRSTF


# --- EXTI through SYSCFG ----------------------------------------------------------

def test_exticr_selects_which_port_drives_a_line(l4):
    exti_imr1, exti_rtsr1, exti_pr1 = 0x40010400, 0x40010408, 0x40010414
    l4.wr(exti_imr1, 1)
    l4.wr(exti_rtsr1, 1)
    l4.wr(0x40010008, 1)                                # EXTICR1.EXTI0 = port B
    for port in (0x48000000, 0x48000400):
        l4.wr(port, l4.rd(port) & ~3)                   # pin 0 input
    l4.mon.execute("sysbus.gpioPortA OnGPIO 0 true")
    assert not l4.rd(exti_pr1) & 1, "port A is not selected for line 0"
    l4.mon.execute("sysbus.gpioPortB OnGPIO 0 true")
    assert l4.rd(exti_pr1) & 1


# --- DMA request selection ----------------------------------------------------------

def test_cselr_passes_only_the_selected_request(l4):
    l4.mon.execute("sysbus.dma1Cselr RequestTransfer 1")          # C1S 0: the ADC
    assert l4.get("dma1Cselr", "Dropped") == 0
    l4.wr(0x400200A8, 5)                                          # C1S 5: another request
    l4.mon.execute("sysbus.dma1Cselr RequestTransfer 1")
    assert l4.get("dma1Cselr", "Dropped") == 1


# --- ADC ---------------------------------------------------------------------------

def test_the_adc_leaves_deep_power_down_and_calibrates_at_once(l4):
    for base in (0x50040000, 0x50040100, 0x50040200):
        assert l4.rd(base + 0x08) == 1 << 29, "DEEPPWD at reset"
        l4.wr(base + 0x08, 1 << 28)                     # ADVREGEN, DEEPPWD cleared
        l4.wr(base + 0x08, (1 << 28) | (1 << 31))       # ADCAL
        assert not l4.rd(base + 0x08) & (1 << 31), "calibration done"
        assert l4.rd(base + 0xB4) == 0x40
        l4.wr(base + 0x08, (1 << 28) | (1 << 30) | (1 << 31))   # ADCALDIF
        assert l4.rd(base + 0xB4) == 0x00400040
    l4.wr(0x50040308, (1 << 22) | (1 << 16))            # CCR: VREFEN, CKMODE 1
    assert l4.rd(0x50040308) == (1 << 22) | (1 << 16)


# --- flash programming -------------------------------------------------------------

def test_the_flash_starts_erased_and_programs_a_double_word(l4):
    assert l4.rd(0x08010000) == 0xFFFFFFFF
    l4.run_program(UNLOCK + [(FCR, PG, 4), (0x08010000, 0x11223344, 4), (0x08010004, 0x55667788, 4)])
    assert (l4.rd(0x08010000), l4.rd(0x08010004)) == (0x11223344, 0x55667788)
    assert l4.rd(FSR) == 0

def test_programming_errors_undo_the_store(l4):
    l4.run_program(UNLOCK + [
        (FCR, PG, 4),
        (0x08010000, 0x11223344, 4), (0x08010004, 0x55667788, 4),   # good
        (0x08010000, 0, 4),                                         # PROGERR: not erased
        (0x08010104, 0, 4),                                         # PGAERR: first word not 8-aligned
        (0x08010200, 0, 1),                                         # SIZERR: a byte
        (0x08010300, 0, 4), (0x08010308, 0, 4),                     # PGAERR: second word not at +4
    ])
    assert l4.rd(FSR) & (PROGERR | PGAERR | SIZERR) == PROGERR | PGAERR | SIZERR
    assert l4.rd(0x08010000) == 0x11223344, "the store was undone"
    for address in (0x08010104, 0x08010200, 0x08010300, 0x08010308):
        assert l4.rd(address) == 0xFFFFFFFF, hex(address)
    l4.wr(FCR, PG | PER)
    assert l4.rd(FSR) & PGSERR

def test_write_protection_refuses_program_and_erase(l4):
    for key in (0x45670123, 0xCDEF89AB):
        l4.wr(KEYR, key)
    for key in (0x08192A3B, 0x4C5D6E7F):
        l4.wr(OPTKEYR, key)
    l4.wr(FLASH + 0x2C, (32 << 16) | 32)                # WRP1AR: page 32 (0x08010000)
    l4.wr(FCR, OPTSTRT)
    l4.reset()                                          # loads the option bytes
    l4.run_program(UNLOCK + [(FCR, PG, 4), (0x08010000, 0, 4), (0x08010004, 0, 4)])
    assert l4.rd(FSR) & WRPERR
    assert l4.rd(0x08010000) == 0xFFFFFFFF
    l4.wr(FSR, 0xFF)
    l4.wr(FCR, PER | (32 << 3))
    l4.wr(FCR, PER | (32 << 3) | STRT)
    assert l4.rd(FSR) & WRPERR


# --- peripherals placed from Renode ------------------------------------------------

def test_rtc_wwdg_lptim_sdmmc_and_quadspi_are_placed(l4):
    assert l4.rd(0x40002C00) == 0x7F, "WWDG_CR reset"
    for model, address in (("STM32F4_RTC", 0x40002800), ("STM32L0_LpTimer", 0x40007C00),
                           ("STM32L0_LpTimer", 0x40009400), ("STM32FSDMMC", 0x40012800),
                           ("STM32H7_QuadSPI", 0xA0001000)):
        assert model in l4.mon.execute(f"sysbus WhatPeripheralIsAt {address:#x}"), hex(address)
