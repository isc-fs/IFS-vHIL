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
// out, as on a board without one. A PLL is ready when it is on and its source
// (PLLCFGR.PLLSRC: 1 MSI, 2 HSI16, 3 HSE; PLLSAI1/2 share it) is ready.
//
// System clock: CFGR.SWS follows CFGR.SW once the selected source (0 MSI,
// 1 HSI16, 2 HSE, 3 PLL) is ready, and keeps the old source otherwise (RM0351
// "System clock switch"). The oscillator or PLL in use as the system clock
// cannot be turned off: clearing its enable bit is ignored (RM0351, the
// MSION/HSION/HSEON/PLLON bit descriptions).
//
// Clock tree: after every write to the RCC (and at reset) the model works out
// SYSCLK, HCLK, PCLK1 and PCLK2 (RM0351 "Clock tree") and sets the rates of
// what Renode clocks at a fixed rate:
//   - the SysTick (`nvic`), at HCLK: Renode's SysTick runs on the processor
//     clock (CLKSOURCE reads 1, docs/cpu-timing.md);
//   - the timers, at their APB clock, doubled when the APB prescaler is not 1
//     (RM0351 "Timer clock"): TIM2-7 on APB1, TIM1/8/15/16/17 on APB2;
//   - the U(S)ARTs, at the kernel clock CCIPR selects (0 PCLK, 1 SYSCLK,
//     2 HSI16, 3 LSE); USART1 is on APB2, the rest on APB1;
//   - LPTIM1/2, at the kernel clock CCIPR selects (0 PCLK1, 1 LSI, 2 HSI16,
//     3 LSE);
//   - the WWDG, at PCLK1;
//   - the RTC, at RTCCLK (BDCR.RTCSEL: LSE, LSI 32 kHz or HSE / 32). With
//     RTCSEL 0 (no clock) or a missing LSE it keeps its last rate;
//   - the ADCs' conversions, through the ADC common block (Stm32L4Adc.cs):
//     CCIPR.ADCSEL 3 is SYSCLK, 1 and 2 the PLLSAI1/PLLSAI2 R outputs.
// The MSI's rate is CR.MSIRANGE when CR.MSIRGSEL is set, CSR.MSISRANGE (1, 2,
// 4 or 8 MHz) otherwise; MSIRANGE 0-11 is 100 kHz .. 48 MHz (RM0351 MSIRANGE
// table). PLL R output = source / (PLLM + 1) * PLLN / (2 * (PLLR + 1)).
// The core's instruction rate is not changed: it is each firmware's cpu.mips
// (docs/cpu-timing.md). The test API reads the result: SysclkHz, HclkHz,
// Pclk1Hz, Pclk2Hz.
//
// Clock interrupts: a ready flag that rises with its CIER enable set raises
// the matching CIFR flag; CICR clears it; RCC_IRQn (5, stm32l496xx.h:83) is
// up while any enabled flag is set. CSS (clock security) never fires: no
// clock fails in the emulation.
//
// Peripheral resets (AHBxRSTR, APBxRSTRx): writing 1 holds a peripheral in
// reset, writing 0 releases it with its registers at their reset values
// (RM0351 "1: Reset <X>"). Each edge of a bit resets the repl's peripherals
// for it, so what was written while it was held is lost, as on silicon. A
// GPIO port keeps the levels driven onto its input and analog pins from
// outside (VhilRccResets.cs does the same on the H733). A bit with no model
// placed (LCD, SAI, OTG, ...) only holds. ResetsOf(name) counts them.
//
// Backup domain (BDCR): writes are ignored unless PWR_CR1.DBP is set (RM0351
// "Backup domain access"), and BDCR keeps its value across a system reset;
// BDRST resets it. It is powered from VBAT: only a power-on clears it.
//
// Reset flags (CSR [31:24]): power-on gives 0x0C000600 (PINRSTF, BORRSTF).
// Every reset drives NRST low on this part, so each one adds PINRSTF, plus
// its cause from Stm32L4ResetFlags.cs (SFTRSTF, IWDGRSTF, WWDGRSTF, OBLRSTF)
// through RecordReset; RMVF clears them.
//
// Not modelled: MSI hardware auto-calibration from LSE (MSIPLLEN, stored),
// the HSI48 recovery system (CRRCR.HSI48RDY follows HSI48ON), and the kernel
// clocks of I2C (the I2C model's transfers take no time, so none applies)
// and the 48 MHz domain (CCIPR is stored). The IWDG runs on the LSI (32 kHz,
// fixed in the repl, as on silicon).
//
using System;
using System.Collections.Generic;
using System.Reflection;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Analog;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.GPIOPort;
using Antmicro.Renode.Peripherals.IRQControllers;
using Antmicro.Renode.Peripherals.Timers;
using Antmicro.Renode.Peripherals.UART;
using Antmicro.Renode.Time;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class STM32L4_RCC : IDoubleWordPeripheral, IKnownSize
    {
        public STM32L4_RCC(IMachine machine, STM32L4_PWR pwr = null, long hseFrequency = 0, long lseFrequency = 0)
        {
            this.machine = machine;
            this.pwr = pwr;
            this.hseFrequency = hseFrequency;
            this.lseFrequency = lseFrequency;
            IRQ = new GPIO();
            regs = new Dictionary<long, uint>();
            bdcr = 0;
            Reset();
            csr = CsrPowerOn;
        }

        public long Size => 0x400;
        public GPIO IRQ { get; }

        // -- test API (monitor) ------------------------------------------------

        public long SysclkHz => Sysclk();
        public long HclkHz => Hclk();
        public long Pclk1Hz => Pclk(8);
        public long Pclk2Hz => Pclk(11);

        // Times a reset bit has reset this peripheral (each edge counts once).
        public int ResetsOf(string name)
        {
            return resets.TryGetValue(name, out var n) ? n : 0;
        }

        // Called by Stm32L4ResetFlags.cs on each machine reset: the cause's
        // flags, or a power-on (which also clears the backup domain).
        public void RecordReset(uint flags, bool powerOn)
        {
            if(powerOn)
            {
                csr = CsrPowerOn;
                bdcr = 0;
                return;
            }
            csr |= (flags & ResetFlags) | PINRSTF;
        }

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
            ApplyClocks();
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
                var old = regs[offset];
                regs[offset] = value & r.mask;
                if(ResetTargets.ContainsKey(offset))
                {
                    ResetEdges(offset, old ^ regs[offset]);
                }
                break;
            }
            UpdateClockSwitch();
            // A flag raises its CIFR bit on the rising edge, if enabled.
            var rose = ReadyFlags() & ~before;
            cifr |= rose & regs[CIER];
            IRQ.Set((cifr & regs[CIER]) != 0);
            ApplyClocks();
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

        private bool HseReady => (regs[CR] & HSEON) != 0 && hseFrequency > 0;

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
            var bd = ReadBdcr();
            uint f = 0;
            if((csr & LSION) != 0) f |= 1u << 0;
            if((bd & LSERDY) != 0) f |= 1u << 1;
            if((cr & MSIRDY) != 0) f |= 1u << 2;
            if((cr & HSIRDY) != 0) f |= 1u << 3;
            if((cr & HSERDY) != 0) f |= 1u << 4;
            if((cr & PLLRDY) != 0) f |= 1u << 5;
            if((cr & PLLSAI1RDY) != 0) f |= 1u << 6;
            if((cr & PLLSAI2RDY) != 0) f |= 1u << 7;
            if((regs[CRRCR] & 1u) != 0) f |= 1u << 10;
            return f;
        }

        // --- clock tree

        private long Msi()
        {
            if((regs[CR] & MSIRGSEL) != 0)
            {
                var range = (int)((regs[CR] >> 4) & 0xF);
                return range < MsiRanges.Length ? MsiRanges[range] : 0;
            }
            var standby = (int)((csr >> 8) & 0xF);
            return standby >= 4 && standby <= 7 ? MsiRanges[standby] : 0;
        }

        private long PllInput()
        {
            switch(regs[PLLCFGR] & 3)
            {
            case 1: return Msi();
            case 2: return HsiHz;
            case 3: return hseFrequency;
            default: return 0;
            }
        }

        private long Sysclk()
        {
            switch(sws)
            {
            case 0: return Msi();
            case 1: return HsiHz;
            case 2: return hseFrequency;
            default:
                var p = regs[PLLCFGR];
                var m = ((p >> 4) & 7) + 1;
                var n = (p >> 8) & 0x7F;
                var r = 2 * (((p >> 25) & 3) + 1);
                return PllInput() / m * n / r;
            }
        }

        // CCIPR.ADCSEL [29:28]: 1 PLLSAI1 R, 2 PLLSAI2 R, 3 SYSCLK, 0 none.
        // PLLSAIx R = PLL input / (PLLM + 1) * PLLSAIxN / (2 * (PLLSAIxR + 1)),
        // when the PLL is on and its R output enabled (PLLSAIxREN, bit 24).
        private long AdcKernel()
        {
            switch((regs[CCIPR] >> 28) & 3)
            {
            case 1: return SaiR(PLLSAI1ON, regs[0x10]);
            case 2: return SaiR(PLLSAI2ON, regs[0x14]);
            case 3: return Sysclk();
            default: return 0;
            }
        }

        private long SaiR(uint enable, uint cfgr)
        {
            if(!PllReady(enable) || (cfgr & (1u << 24)) == 0)
            {
                return 0;
            }
            var m = ((regs[PLLCFGR] >> 4) & 7) + 1;
            var n = (cfgr >> 8) & 0x7F;
            var r = 2 * (((cfgr >> 25) & 3) + 1);
            return PllInput() / m * n / r;
        }

        private long Hclk()
        {
            var hpre = (int)((regs[CFGR] >> 4) & 0xF);
            return Sysclk() / (hpre < 8 ? 1 : AhbDividers[hpre - 8]);
        }

        // PPRE1 at bit 8, PPRE2 at bit 11.
        private long Pclk(int at)
        {
            var ppre = (int)((regs[CFGR] >> at) & 7);
            return Hclk() / (ppre < 4 ? 1 : 1 << (ppre - 3));
        }

        private long TimerClock(int at)
        {
            var ppre = (regs[CFGR] >> at) & 7;
            return Pclk(at) * (ppre < 4 ? 1 : 2);
        }

        private void ApplyClocks()
        {
            if(machine == null)
            {
                return;
            }
            var hclk = Hclk();
            if(hclk <= 0)
            {
                return;
            }
            SetRate("nvic", hclk);
            foreach(var t in Apb1Timers)
            {
                SetRate(t, TimerClock(8));
            }
            foreach(var t in Apb2Timers)
            {
                SetRate(t, TimerClock(11));
            }
            for(var i = 0; i < Uarts.Length; i++)
            {
                var sel = (regs[CCIPR] >> (2 * i)) & 3;
                long rate;
                switch(sel)
                {
                case 0: rate = Pclk(i == 0 ? 11 : 8); break;
                case 1: rate = Sysclk(); break;
                case 2: rate = HsiHz; break;
                default: rate = lseFrequency; break;
                }
                SetRate(Uarts[i], rate);
            }
            // LPTIM1SEL [19:18], LPTIM2SEL [21:20]: 0 PCLK1, 1 LSI, 2 HSI16,
            // 3 LSE. Both are on APB1.
            for(var i = 0; i < 2; i++)
            {
                var sel = (regs[CCIPR] >> (18 + 2 * i)) & 3;
                SetRate(i == 0 ? "lptim1" : "lptim2",
                    sel == 0 ? Pclk(8) : sel == 1 ? LsiHz : sel == 2 ? HsiHz : lseFrequency);
            }
            SetRate("wwdg", Pclk(8));
            if(machine.TryGetByName<STM32L4_ADC_Common>("sysbus.adcCommon", out var adcCommon))
            {
                var key = (AdcKernel(), hclk);
                if(key != adcClocks)
                {
                    adcClocks = key;
                    adcCommon.SetClocks(key.Item1, key.Item2);
                }
            }
            // RTCSEL [9:8]: 1 LSE, 2 LSI, 3 HSE / 32; 0 no clock.
            var rtcsel = (bdcr >> 8) & 3;
            SetRate("rtc", rtcsel == 1 ? lseFrequency : rtcsel == 2 ? LsiHz : rtcsel == 3 ? hseFrequency / 32 : 0);
        }

        private void SetRate(string name, long hz)
        {
            if(hz <= 0 || !machine.TryGetByName<IPeripheral>("sysbus." + name, out var p))
            {
                return;
            }
            if(rates.TryGetValue(name, out var was) && was == hz)
            {
                return;
            }
            rates[name] = hz;
            switch(p)
            {
            case NVIC nvic:
                nvic.Frequency = (ulong)hz;
                break;
            case STM32_Timer timer:
                timer.Frequency = (ulong)hz;
                // The capture/compare channels count on timers of their own
                // (STM32_Timer.channels[i].Timer), built at the repl's rate.
                if(TimerChannels?.GetValue(timer) is Array channels)
                {
                    foreach(var channel in channels)
                    {
                        if(channel?.GetType().GetField("Timer")?.GetValue(channel) is LimitTimer cc)
                        {
                            cc.Frequency = (ulong)hz;
                        }
                    }
                }
                break;
            case STM32L0_LpTimer lptim:
                lptim.Frequency = (ulong)hz;
                if(LpTimerCompare?.GetValue(lptim) is LimitTimer compare)
                {
                    compare.Frequency = (ulong)hz;
                }
                break;
            case STM32H7_SystemWindowWatchdog wwdg:
                if(WwdgTimer?.GetValue(wwdg) is LimitTimer counter)
                {
                    counter.Frequency = (ulong)hz;
                }
                break;
            case STM32F4_RTC rtc:
                foreach(var field in RtcTimers)
                {
                    if(field?.GetValue(rtc) is LimitTimer t)
                    {
                        t.Frequency = (ulong)hz;
                    }
                }
                break;
            case STM32F7_USART usart:
                // Its kernel clock only scales BaudRate (the receiver
                // timeout); the field is set at construction.
                UsartFrequency?.SetValue(usart, (uint)hz);
                break;
            }
        }

        // --- peripheral resets

        private void ResetEdges(long offset, uint changed)
        {
            foreach(var entry in ResetTargets[offset])
            {
                if((changed & (1u << entry.Key)) == 0)
                {
                    continue;
                }
                foreach(var name in entry.Value)
                {
                    if(machine.TryGetByName<IPeripheral>("sysbus." + name, out var p))
                    {
                        ResetPeripheral(name, p);
                    }
                }
            }
        }

        private void ResetPeripheral(string name, IPeripheral peripheral)
        {
            resets[name] = ResetsOf(name) + 1;
            this.Log(LogLevel.Debug, "{0} reset from its RSTR bit", name);
            if(!(peripheral is STM32_GPIOPort gpio))
            {
                peripheral.Reset();
                return;
            }
            var moder = gpio.ReadDoubleWord(0x00);
            var idr = gpio.ReadDoubleWord(0x10);
            gpio.Reset();
            for(var pin = 0; pin < 16; pin++)
            {
                var mode = (moder >> (2 * pin)) & 3;
                if((mode == 0 || mode == 3) && (idr & (1u << pin)) != 0)
                {
                    gpio.OnGPIO(pin, true);
                }
            }
        }

        // --- BDCR

        private uint ReadBdcr()
        {
            var v = bdcr & ~LSERDY;
            if((v & LSEON) != 0 && lseFrequency > 0)
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
            CICR = 0x20, CCIPR = 0x88, BDCR = 0x90, CSR = 0x94, CRRCR = 0x98;

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
        private const long HsiHz = 16000000, LsiHz = 32000;

        private static readonly long[] MsiRanges = { 100000, 200000, 400000, 800000, 1000000, 2000000,
                                                     4000000, 8000000, 16000000, 24000000, 32000000, 48000000 };
        private static readonly int[] AhbDividers = { 2, 4, 8, 16, 64, 128, 256, 512 };
        private static readonly string[] Apb1Timers = { "timer2", "timer3", "timer4", "timer5", "timer6", "timer7" };
        private static readonly string[] Apb2Timers = { "timer1", "timer8", "timer15", "timer16", "timer17" };
        // CCIPR USART1SEL [1:0] .. LPUART1SEL [11:10], in that order.
        private static readonly string[] Uarts = { "usart1", "usart2", "usart3", "uart4", "uart5", "lpuart1" };
        private static readonly FieldInfo TimerChannels =
            typeof(STM32_Timer).GetField("channels", BindingFlags.NonPublic | BindingFlags.Instance);
        private static readonly FieldInfo WwdgTimer =
            typeof(STM32H7_SystemWindowWatchdog).GetField("watchdogTimer", BindingFlags.NonPublic | BindingFlags.Instance);
        private static readonly FieldInfo[] RtcTimers =
        {
            typeof(STM32F4_RTC).GetField("ticker", BindingFlags.NonPublic | BindingFlags.Instance),
            typeof(STM32F4_RTC).GetField("fastTicker", BindingFlags.NonPublic | BindingFlags.Instance),
            typeof(STM32F4_RTC).GetField("wakeupTimer", BindingFlags.NonPublic | BindingFlags.Instance),
        };
        private static readonly FieldInfo LpTimerCompare =
            typeof(STM32L0_LpTimer).GetField("compareTimer", BindingFlags.NonPublic | BindingFlags.Instance);
        private static readonly FieldInfo UsartFrequency =
            typeof(STM32F7_USART).GetField("frequency", BindingFlags.NonPublic | BindingFlags.Instance);

        // RSTR offset -> bit -> the repl's peripherals it resets (RCC_<reg>_*RST_Pos,
        // stm32l496xx.h). Bits not listed are held with nothing to reset.
        private static readonly Dictionary<long, Dictionary<int, string[]>> ResetTargets =
            new Dictionary<long, Dictionary<int, string[]>>
        {
            [0x28] = new Dictionary<int, string[]>   // AHB1RSTR: DMA1 0, DMA2 1, CRC 12
            {
                [0] = new[] { "dma1", "dma1Cselr" }, [1] = new[] { "dma2", "dma2Cselr" }, [12] = new[] { "crc" },
            },
            [0x2C] = new Dictionary<int, string[]>   // AHB2RSTR: GPIOA-I 0-8, ADC 13, RNG 18
            {
                [0] = new[] { "gpioPortA" }, [1] = new[] { "gpioPortB" }, [2] = new[] { "gpioPortC" },
                [3] = new[] { "gpioPortD" }, [4] = new[] { "gpioPortE" }, [5] = new[] { "gpioPortF" },
                [6] = new[] { "gpioPortG" }, [7] = new[] { "gpioPortH" }, [8] = new[] { "gpioPortI" },
                [13] = new[] { "adc1", "adc2", "adc3", "adcCommon" }, [18] = new[] { "rng" },
            },
            [0x30] = new Dictionary<int, string[]>   // AHB3RSTR: QSPI 8
            {
                [8] = new[] { "quadspi" },
            },
            [0x38] = new Dictionary<int, string[]>   // APB1RSTR1
            {
                [0] = new[] { "timer2" }, [1] = new[] { "timer3" }, [2] = new[] { "timer4" }, [3] = new[] { "timer5" },
                [4] = new[] { "timer6" }, [5] = new[] { "timer7" }, [14] = new[] { "spi2" }, [15] = new[] { "spi3" },
                [17] = new[] { "usart2" }, [18] = new[] { "usart3" }, [19] = new[] { "uart4" }, [20] = new[] { "uart5" },
                [21] = new[] { "i2c1" }, [22] = new[] { "i2c2" }, [23] = new[] { "i2c3" }, [25] = new[] { "can1" },
                [26] = new[] { "can2" }, [28] = new[] { "pwr" }, [29] = new[] { "dac1" },
                [30] = new[] { "opamp1", "opamp2" }, [31] = new[] { "lptim1" },
            },
            [0x3C] = new Dictionary<int, string[]>   // APB1RSTR2: LPUART1 0, I2C4 1, LPTIM2 5
            {
                [0] = new[] { "lpuart1" }, [1] = new[] { "i2c4" }, [5] = new[] { "lptim2" },
            },
            [0x40] = new Dictionary<int, string[]>   // APB2RSTR
            {
                // SYSCFGRST resets SYSCFG, COMP and VREFBUF (RM0351 APB2RSTR).
                [0] = new[] { "syscfg", "comp1", "comp2", "vrefbuf" }, [10] = new[] { "sdmmc1" }, [11] = new[] { "timer1" }, [12] = new[] { "spi1" },
                [13] = new[] { "timer8" }, [14] = new[] { "usart1" }, [16] = new[] { "timer15" },
                [17] = new[] { "timer16" }, [18] = new[] { "timer17" },
            },
        };

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

        private readonly IMachine machine;
        private readonly Dictionary<long, uint> regs;
        private readonly Dictionary<string, long> rates = new Dictionary<string, long>();
        private readonly Dictionary<string, int> resets = new Dictionary<string, int>();
        private readonly STM32L4_PWR pwr;
        private readonly long hseFrequency;
        private readonly long lseFrequency;
        private (long, long) adcClocks;
        private uint sws;
        private uint cifr;
        private uint bdcr;
        private uint csr;
    }
}
