//
// RCC of the STM32L496 (reset and clock control), compiled by Renode at load
// time and placed by platforms/cpus/stm32l496.repl at RCC_BASE 0x40021000
// (AHB1PERIPH_BASE + 0x1000, stm32l496xx.h:1309). Renode's closest model,
// STM32L5_RCC, defines 13 of the L4's 32 registers and no ready flags past
// HSI16 and the main PLL, so a CubeMX SystemClock_Config (HSE on, PLL on,
// switch to the PLL, LSE for the RTC) stopped on the first flag it polls.
//
// Registers: RCC_TypeDef (stm32l496xx.h:756-797), offsets and reset values
// from RM0351 "RCC registers" (as ST's STM32L4x6 SVD v1.5 lists them).
// Writable bits are the header's RCC_<reg>_*_Msk fields; reserved bits read
// 0 and ignore writes.
//
// Oscillators: each ready flag follows its enable bit at once (no start-up
// time: the HAL only waits for the flag). HSE and LSE are crystals of the
// board (`hseFrequency`, `lseFrequency` in the repl, 0 when not fitted): a
// missing crystal never becomes ready and the HAL's start-up timeout runs
// out, as on a board without one. HSEBYP makes HSE ready without a crystal
// only if the board feeds an external clock, which hseFrequency also says.
// A PLL is ready when it is on and its source (PLLCFGR.PLLSRC: 1 MSI, 2 HSI16,
// 3 HSE; PLLSAI1/2 share it) is ready.
//
// System clock: CFGR.SWS follows CFGR.SW once the selected source (0 MSI,
// 1 HSI16, 2 HSE, 3 PLL) is ready, and keeps the old source otherwise (RM0351
// "System clock switch"). The oscillator or PLL in use as the system clock
// cannot be turned off: clearing its enable bit is ignored (RM0351, the
// MSION/HSION/HSEON/PLLON bit descriptions).
//
// Clock interrupts: a ready flag that rises with its CIER enable set raises
// the matching CIFR flag; CICR clears it; RCC_IRQn (5, stm32l496xx.h:83) is
// up while any enabled flag is set. CSS (clock security) never fires: no
// clock fails in the emulation.
//
// Backup domain (BDCR): writes are ignored unless PWR_CR1.DBP is set (RM0351
// "Backup domain access"), and BDCR keeps its value across a system reset;
// BDRST resets it. It is powered from VBAT, so only a power-on clears it,
// which the emulation does by building the machine anew.
//
// Reset flags (CSR [31:24]): power-on sets PINRSTF and BORRSTF (CSR reset
// value 0x0C000600). Every reset drives NRST low on this part, so a system
// reset adds PINRSTF; RMVF clears them all. Which internal source caused a
// reset (SFTRSTF, IWDGRSTF, ...) is not recorded yet: Renode's reset does
// not carry its cause to the RCC (the H733 needs VhilResetFlags.cs for it).
//
// Not modelled: the xxxRSTR peripheral resets (stored, no effect), the clock
// tree's frequencies (the repl clocks every timer and UART at the 80 MHz the
// HAL's maximum configuration gives; see stm32l496.repl), MSI hardware
// auto-calibration from LSE (MSIPLLEN, stored), and the HSI48 recovery
// system (CRRCR.HSI48RDY follows HSI48ON).
//
using System.Collections.Generic;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class STM32L4_RCC : IDoubleWordPeripheral, IKnownSize
    {
        public STM32L4_RCC(IMachine machine, STM32L4_PWR pwr = null, long hseFrequency = 0, long lseFrequency = 0)
        {
            this.pwr = pwr;
            hsePresent = hseFrequency > 0;
            lsePresent = lseFrequency > 0;
            IRQ = new GPIO();
            regs = new Dictionary<long, uint>();
            bdcr = 0;
            Reset();
            csr = CsrPowerOn;
        }

        public long Size => 0x400;
        public GPIO IRQ { get; }

        public void Reset()
        {
            regs.Clear();
            foreach(var r in Layout)
            {
                regs[r.Key] = r.Value.reset;
            }
            // Reset flags survive a system reset; every reset pulses NRST.
            csr = (csr & ResetFlags) | (CsrPowerOn & ~ResetFlags) | PINRSTF;
            cifr = 0;
            sws = 0;   // MSI after every reset
            IRQ.Unset();
        }

        public uint ReadDoubleWord(long offset)
        {
            switch(offset)
            {
            case CR: return ReadCr();
            case CFGR: return (regs[CFGR] & ~SwsMask) | (sws << 2);
            case CIFR: return cifr;
            case CICR: return 0;
            case BDCR: return ReadBdcr();
            case CSR: return (csr & ~LSIRDY) | ((csr & LSION) != 0 ? LSIRDY : 0);
            case CRRCR: return (regs[CRRCR] & ~2u) | ((regs[CRRCR] & 1u) << 1);
            }
            if(regs.TryGetValue(offset, out var value))
            {
                return value;
            }
            this.Log(LogLevel.Warning, "Unhandled read from offset 0x{0:X}.", offset);
            return 0;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            var before = ReadyFlags();
            switch(offset)
            {
            case CR:
                WriteCr(value);
                break;
            case CFGR:
                regs[CFGR] = value & Layout[CFGR].mask & ~SwsMask;
                break;
            case CIFR:
                return;   // read-only
            case CICR:
                cifr &= ~(value & Layout[CICR].mask);
                break;
            case BDCR:
                WriteBdcr(value);
                break;
            case CSR:
                if((value & RMVF) != 0)
                {
                    csr &= ~ResetFlags;
                }
                csr = (csr & ~CsrWritable) | (value & CsrWritable);
                break;
            default:
                if(!Layout.TryGetValue(offset, out var r))
                {
                    this.Log(LogLevel.Warning, "Unhandled write to offset 0x{0:X}, value 0x{1:X}.", offset, value);
                    return;
                }
                regs[offset] = value & r.mask;
                break;
            }
            UpdateClockSwitch();
            // A flag raises its CIFR bit on the rising edge, if enabled.
            var rose = ReadyFlags() & ~before;
            cifr |= rose & regs[CIER];
            IRQ.Set((cifr & regs[CIER]) != 0);
        }

        // --- CR

        private uint ReadCr()
        {
            var cr = regs[CR] & ~CrReadyBits;
            if((cr & MSION) != 0) cr |= MSIRDY;
            if((cr & HSION) != 0) cr |= HSIRDY;
            if(HseReady) cr |= HSERDY;
            if(PllReady(PLLON)) cr |= PLLRDY;
            if(PllReady(PLLSAI1ON)) cr |= PLLSAI1RDY;
            if(PllReady(PLLSAI2ON)) cr |= PLLSAI2RDY;
            return cr;
        }

        private void WriteCr(uint value)
        {
            var old = regs[CR];
            var cr = value & Layout[CR].mask & ~CrReadyBits;
            // MSIRGSEL and CSSON are set-only (cleared by reset).
            cr |= old & (MSIRGSEL | CSSON);
            // The system clock's own source cannot be switched off.
            foreach(var on in InUse())
            {
                cr |= old & on;
            }
            regs[CR] = cr;
        }

        private IEnumerable<uint> InUse()
        {
            switch(sws)
            {
            case 0: yield return MSION; break;
            case 1: yield return HSION; break;
            case 2: yield return HSEON; break;
            case 3:
                yield return PLLON;
                yield return PllSourceEnable();
                break;
            }
        }

        private bool HseReady => (regs[CR] & HSEON) != 0 && hsePresent;

        private uint PllSourceEnable()
        {
            switch(regs[PLLCFGR] & 3)
            {
            case 1: return MSION;
            case 2: return HSION;
            case 3: return HSEON;
            default: return 0;
            }
        }

        private bool PllReady(uint enable)
        {
            if((regs[CR] & enable) == 0)
            {
                return false;
            }
            switch(regs[PLLCFGR] & 3)
            {
            case 1: return (regs[CR] & MSION) != 0;
            case 2: return (regs[CR] & HSION) != 0;
            case 3: return HseReady;
            default: return false;   // no clock sent to the PLLs
            }
        }

        private bool SourceReady(uint source)
        {
            var cr = ReadCr();
            switch(source)
            {
            case 0: return (cr & MSIRDY) != 0;
            case 1: return (cr & HSIRDY) != 0;
            case 2: return (cr & HSERDY) != 0;
            default: return (cr & PLLRDY) != 0;
            }
        }

        private void UpdateClockSwitch()
        {
            var sw = regs[CFGR] & 3;
            if(sw != sws && SourceReady(sw))
            {
                sws = sw;
            }
        }

        // The CIFR bit of each ready flag (RM0351 CIER/CIFR layout).
        private uint ReadyFlags()
        {
            var cr = ReadCr();
            var bdcr = ReadBdcr();
            uint f = 0;
            if((csr & LSION) != 0) f |= 1u << 0;
            if((bdcr & LSERDY) != 0) f |= 1u << 1;
            if((cr & MSIRDY) != 0) f |= 1u << 2;
            if((cr & HSIRDY) != 0) f |= 1u << 3;
            if((cr & HSERDY) != 0) f |= 1u << 4;
            if((cr & PLLRDY) != 0) f |= 1u << 5;
            if((cr & PLLSAI1RDY) != 0) f |= 1u << 6;
            if((cr & PLLSAI2RDY) != 0) f |= 1u << 7;
            if((regs[CRRCR] & 1u) != 0) f |= 1u << 10;
            return f;
        }

        // --- BDCR

        private uint ReadBdcr()
        {
            var v = bdcr & ~LSERDY;
            if((v & LSEON) != 0 && lsePresent)
            {
                v |= LSERDY;
            }
            return v;
        }

        private void WriteBdcr(uint value)
        {
            if(pwr != null && !pwr.BackupDomainWritable)
            {
                this.Log(LogLevel.Debug, "BDCR write 0x{0:X} ignored: PWR_CR1.DBP is clear.", value);
                return;
            }
            if((value & BDRST) != 0)
            {
                bdcr = BDRST;
                return;
            }
            var next = value & Layout[BDCR].mask & ~LSERDY;
            // RTCSEL can be changed only by a backup domain reset once set.
            if((bdcr & RtcSelMask) != 0)
            {
                next = (next & ~RtcSelMask) | (bdcr & RtcSelMask);
            }
            bdcr = next;
        }

        private const long CR = 0x00, CFGR = 0x08, PLLCFGR = 0x0C, CIER = 0x18, CIFR = 0x1C,
            CICR = 0x20, BDCR = 0x90, CSR = 0x94, CRRCR = 0x98;

        private const uint MSION = 1u << 0, MSIRDY = 1u << 1, MSIRGSEL = 1u << 3,
            HSION = 1u << 8, HSIRDY = 1u << 10, HSEON = 1u << 16, HSERDY = 1u << 17,
            CSSON = 1u << 19, PLLON = 1u << 24, PLLRDY = 1u << 25,
            PLLSAI1ON = 1u << 26, PLLSAI1RDY = 1u << 27, PLLSAI2ON = 1u << 28, PLLSAI2RDY = 1u << 29;
        private const uint CrReadyBits = MSIRDY | HSIRDY | HSERDY | PLLRDY | PLLSAI1RDY | PLLSAI2RDY;
        private const uint SwsMask = 3u << 2;
        private const uint LSEON = 1u << 0, LSERDY = 1u << 1, RtcSelMask = 3u << 8, BDRST = 1u << 16;
        private const uint LSION = 1u << 0, LSIRDY = 1u << 1, RMVF = 1u << 23, PINRSTF = 1u << 26;
        private const uint ResetFlags = 0xFF000000;
        // LSION, MSISRANGE [11:8] (RCC_CSR_*_Msk, stm32l496xx.h).
        private const uint CsrWritable = 0x00000F01;
        private const uint CsrPowerOn = 0x0C000600;

        // offset -> (reset value, writable bits): RM0351 reset values, masks
        // from the header's RCC_<reg>_*_Msk fields.
        private static readonly Dictionary<long, (uint reset, uint mask)> Layout = new Dictionary<long, (uint, uint)>
        {
            { 0x00, (0x00000063, 0x3F0F0FFF) },   // CR: MSION, MSIRDY, MSIRANGE 6 (4 MHz)
            { 0x04, (0x10000000, 0x7F00FF00) },   // ICSCR: HSITRIM 16; the CAL fields read 0
            { 0x08, (0x00000000, 0x7F00BFFF) },   // CFGR
            { 0x0C, (0x00001000, 0xFF737F73) },   // PLLCFGR
            { 0x10, (0x00001000, 0xFF737F00) },   // PLLSAI1CFGR
            { 0x14, (0x00001000, 0xFF037F00) },   // PLLSAI2CFGR
            { 0x18, (0x00000000, 0x000006FF) },   // CIER
            { 0x1C, (0x00000000, 0x000007FF) },   // CIFR
            { 0x20, (0x00000000, 0x000007FF) },   // CICR
            { 0x28, (0x00000000, 0x00031103) },   // AHB1RSTR
            { 0x2C, (0x00000000, 0x000471FF) },   // AHB2RSTR
            { 0x30, (0x00000000, 0x00000101) },   // AHB3RSTR
            { 0x38, (0x00000000, 0xF7FEC23F) },   // APB1RSTR1
            { 0x3C, (0x00000000, 0x00000027) },   // APB1RSTR2
            { 0x40, (0x00000000, 0x01677C01) },   // APB2RSTR
            { 0x48, (0x00000100, 0x00031103) },   // AHB1ENR: FLASHEN
            { 0x4C, (0x00000000, 0x000471FF) },   // AHB2ENR
            { 0x50, (0x00000000, 0x00000101) },   // AHB3ENR
            { 0x58, (0x00000000, 0xF7FECE3F) },   // APB1ENR1
            { 0x5C, (0x00000000, 0x00000027) },   // APB1ENR2
            { 0x60, (0x00000000, 0x01677C81) },   // APB2ENR
            { 0x68, (0x00011303, 0x00031303) },   // AHB1SMENR
            { 0x6C, (0x000532FF, 0x000473FF) },   // AHB2SMENR
            { 0x70, (0x00000101, 0x00000101) },   // AHB3SMENR
            { 0x78, (0xF2FECA3F, 0xF7FECE3F) },   // APB1SMENR1
            { 0x7C, (0x00000025, 0x00000027) },   // APB1SMENR2
            { 0x80, (0x01677C01, 0x01677C01) },   // APB2SMENR
            { 0x88, (0x00000000, 0xFFFFFFFF) },   // CCIPR
            { 0x90, (0x00000000, 0x0301837F) },   // BDCR (held in bdcr)
            { 0x94, (0x0C000600, 0xFF800F03) },   // CSR (held in csr)
            { 0x98, (0x00000000, 0x00000001) },   // CRRCR: HSI48ON; HSI48CAL reads 0
            { 0x9C, (0x00000000, 0x00000003) },   // CCIPR2
        };

        private readonly Dictionary<long, uint> regs;
        private readonly STM32L4_PWR pwr;
        private readonly bool hsePresent;
        private readonly bool lsePresent;
        private uint sws;
        private uint cifr;
        private uint bdcr;
        private uint csr;
    }
}
