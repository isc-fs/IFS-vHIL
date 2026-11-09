//
// The STM32L496's ADCs, compiled by Renode at load time and placed by
// platforms/cpus/stm32l496.repl: ADC1/2/3 at ADC1_BASE 0x50040000,
// ADC2_BASE 0x50040100, ADC3_BASE 0x50040200 and their common registers at
// ADC123_COMMON_BASE 0x50040300 (stm32l496xx.h:1366-1369).
//
// STM32L4_ADC is Renode's STM32L5_ADC (the same ADC IP: registers, channels,
// sequencer, DMA) with what the L4's HAL needs before its first conversion:
//
//   CR.DEEPPWD   bit 29, reset 1 (RM0351 "ADC deep-power-down mode"). The
//                HAL clears it before setting ADVREGEN; stored.
//   CR.ADCAL     bit 31. Renode's base tags it, so HAL_ADCEx_Calibration_Start
//                waited for a bit that never cleared. Here a calibration
//                completes at once: ADCAL reads 0 right after the write and
//                CALFACT takes the factor (RM0351 "Calibration"). ADCALDIF
//                (bit 30) picks the single-ended or differential factor.
//   CALFACT      0xB4: CALFACT_S [6:0], CALFACT_D [22:16]. A calibration
//                writes CalibrationFactor (repl, default 0x40) into the
//                half it ran for; the firmware can write it too.
//
//   timing       A regular sequence takes its conversion time: per channel
//                SMPx (2.5, 6.5, 12.5, 24.5, 47.5, 92.5, 247.5 or 640.5
//                cycles) plus the resolution's (12.5, 10.5, 8.5, 6.5 for
//                RES 12/10/8/6 bits), at the ADC clock (RM0351 "Timing").
//                A software-started single sequence (CFGR.CONT 0, EXTEN 0)
//                gives its first EOC that long after ADSTART (ADSTART reads 1
//                meanwhile); the rest of the sequence follows each DR read, as
//                in Renode's base. In continuous mode a sequence starts every
//                sequence time.
//   triggers     With EXTEN != 0, ADSTART arms the ADC and each TRGO of the
//                timer EXTSEL names starts a sequence (VhilTimerTrgo,
//                Stm32L4Analog.cs): 4 TIM3, 7 TIM8, 8 TIM8 TRGO2, 9 TIM1,
//                10 TIM1 TRGO2, 11 TIM2, 12 TIM4, 13 TIM6, 14 TIM15 (RM0351
//                "External triggers for regular channels"). ADSTP disarms.
//                The other sources (timer compare events 0-3, 5, 15 and EXTI
//                line 11, 6) do not reach the ADC: an ADC armed on one never
//                converts.
//
// STM32L4_ADC_Common holds the common registers of the three: CSR (0x00, the
// ADCs' ISR flags side by side: ADC1 [10:0], ADC2 [26:16]; ADC3's are only in
// its own ISR, RM0351 "ADC common status register"), CCR (0x08) and CDR
// (0x0C). The ADC clock: CCR.CKMODE 1/2/3 is HCLK / 1, 2, 4; CKMODE 0 is the
// kernel clock CCIPR.ADCSEL picks (the RCC sets it, Stm32L4Rcc.cs) divided
// by CCR.PRESC (1, 2, 4, 6, 8, 10, 12, 16, 32, 64, 128, 256).
// Dual mode (CCR.DUAL != 0): ADC1 is the master; its ADSTART starts ADC2 too
// (the simultaneous modes), and CDR reads ADC2's DR in [31:16] and ADC1's in
// [15:0] (MDMA 0 layout). Interleaved and alternate-trigger modes start both
// at once too.
//
// The internal channels (VREFINT, the temperature sensor, VBAT/3) read as the
// analog inputs the test feeds.
//
using System;
using System.Reflection;
using Antmicro.Renode.Core;
using Antmicro.Renode.Time;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.DMA;

namespace Antmicro.Renode.Peripherals.Analog
{
    public class STM32L4_ADC : STM32L5_ADC, IDoubleWordPeripheral
    {
        public STM32L4_ADC(IMachine machine, double referenceVoltage, uint externalEventFrequency, int dmaChannel = 0,
            IDMA dmaPeripheral = null, uint calibrationFactor = 0x40)
            : base(machine, referenceVoltage, externalEventFrequency, dmaChannel, dmaPeripheral)
        {
            this.machine = machine;
            this.calibrationFactor = calibrationFactor & 0x7F;
            ResetL4();
        }

        // Calibrations run (test API).
        public int Calibrations => calibrations;

        public new void Reset()
        {
            base.Reset();
            ResetL4();
        }

        // The ADC clock (Hz), from the common block.
        public long ClockHz { get; private set; }

        // The regular sequence's conversion time at the current clock (test API).
        public double LastSequenceSeconds { get; private set; }

        internal STM32L4_ADC_Common Common { get; set; }
        internal bool IsMaster { get; set; }

        internal void SetClock(long hz)
        {
            ClockHz = hz;
            Retime();
        }

        public new uint ReadDoubleWord(long offset)
        {
            switch(offset)
            {
            case Cr:
                return (base.ReadDoubleWord(Cr) & ~(Deeppwd | Adcaldif | Adcal)) | own | (startPending || armed ? Adstart : 0);
            case Calfact:
                return calfact;
            case Smpr1:
            case Smpr2:
                return smpr[(offset - Smpr1) / 4];
            case Cfgr:
                return Config;
            }
            return base.ReadDoubleWord(offset);
        }

        public new void WriteDoubleWord(long offset, uint value)
        {
            switch(offset)
            {
            case Cr:
                own = value & (Deeppwd | Adcaldif);
                if((value & Adcal) != 0)
                {
                    // Differential factor in [22:16], single-ended in [6:0].
                    var at = (own & Adcaldif) != 0 ? 16 : 0;
                    calfact = (calfact & ~(0x7Fu << at)) | (calibrationFactor << at);
                    calibrations++;
                }
                var start = (value & Adstart) != 0;
                if((value & Adstp) != 0)
                {
                    armed = false;
                }
                var cfgr = Config;
                if(start && ((cfgr >> 10) & 3) != 0)
                {
                    // External trigger: armed; the timer's TRGO starts it.
                    armed = true;
                    Retime();
                    Subscribe((int)((cfgr >> 6) & 0xF));
                    base.WriteDoubleWord(Cr, value & ~(Deeppwd | Adcaldif | Adcal | Adstart));
                    return;
                }
                if(start && IsMaster && Common != null && Common.Dual)
                {
                    Common.StartSlave();
                }
                if(start && SoftwareSingle() && ClockHz > 0)
                {
                    // The first EOC comes after the sequence's conversion time.
                    Retime();
                    startPending = true;
                    var pendingValue = value & ~(Deeppwd | Adcaldif | Adcal);
                    base.WriteDoubleWord(Cr, pendingValue & ~Adstart);
                    machine.ScheduleAction(TimeInterval.FromTicks((ulong)Math.Max(1, Math.Ceiling(LastSequenceSeconds * TicksPerSecond))),
                        _ =>
                        {
                            startPending = false;
                            if((base.ReadDoubleWord(Cr) & 1) != 0)   // still enabled
                            {
                                base.WriteDoubleWord(Cr, base.ReadDoubleWord(Cr) | Adstart);
                            }
                        }, "stm32l4-adc");
                    return;
                }
                if(start)
                {
                    Retime();
                }
                base.WriteDoubleWord(Cr, value & ~(Deeppwd | Adcaldif | Adcal));
                return;
            case Calfact:
                calfact = value & CalfactMask;
                return;
            case Cfgr:
                // EXTSEL is [9:6] on the L4 ([9:5] on the L5, which the base
                // tags): kept here, the rest goes to the base.
                extsel = (value >> 6) & 0xF;
                base.WriteDoubleWord(offset, value & ~ExtselMask);
                Retime();
                return;
            case Smpr1:
            case Smpr2:
                // Renode's base tags SMPRx; the sampling times are kept here.
                smpr[(offset - Smpr1) / 4] = value & (offset == Smpr1 ? 0xBFFFFFFFu : 0x07FFFFFFu);
                Retime();
                return;
            }
            base.WriteDoubleWord(offset, value);
        }

        private void ResetL4()
        {
            own = Deeppwd;
            calfact = 0;
            smpr[0] = smpr[1] = 0;
            extsel = 0;
            startPending = false;
            armed = false;
        }

        // Started by a TRGO the ADC is armed for.
        public int ExternalStarts => externalStarts;

        private void Subscribe(int extsel)
        {
            var source = extsel < ExtselTimers.Length ? ExtselTimers[extsel] : (null, false);
            if(source.Item1 == null)
            {
                this.Log(LogLevel.Warning, "EXTSEL {0} (a compare event or EXTI 11) is not routed: no conversion will start.", extsel);
                return;
            }
            if(subscribed.Contains(extsel))
            {
                return;
            }
            if(VhilTimerTrgo.OnTrgo(machine, source.Item1, source.Item2, () => OnTrigger(extsel)))
            {
                subscribed.Add(extsel);
            }
        }

        private void OnTrigger(int extsel)
        {
            var cfgr = Config;
            if(!armed || ((cfgr >> 10) & 3) == 0 || ((cfgr >> 6) & 0xF) != extsel || (base.ReadDoubleWord(Cr) & 1) == 0)
            {
                return;
            }
            externalStarts++;
            machine.LocalTimeSource.ExecuteInNearestSyncedState(_ => StartSampling?.Invoke(this, null));
        }

        // CFGR: CONT 13, EXTEN [11:10].
        private bool SoftwareSingle()
        {
            var cfgr = Config;
            return (cfgr & (1u << 13)) == 0 && (cfgr & (3u << 10)) == 0;
        }

        // Works out the regular sequence's time and runs the continuous-mode
        // sampling thread at one sequence per sequence time.
        private void Retime()
        {
            if(ClockHz <= 0)
            {
                return;
            }
            var cfgr = Config;
            var res = ResolutionCycles[(cfgr >> 3) & 3];
            var sqr = new[] { base.ReadDoubleWord(0x30), base.ReadDoubleWord(0x34), base.ReadDoubleWord(0x38), base.ReadDoubleWord(0x3C) };
            var length = (int)(sqr[0] & 0xF) + 1;
            double cycles = 0;
            for(var i = 0; i < length; i++)
            {
                // SQ1 at SQR1 [10:6], then 6-bit fields; 5 per SQR2-4, 4 in SQR1.
                var position = i + 1;
                var reg = position < 5 ? 0 : 1 + (position - 5) / 5;
                var slot = position < 5 ? position : (position - 5) % 5;
                var channel = (int)((sqr[reg] >> (6 * slot)) & 0x1F);
                var smp = (int)((smpr[channel < 10 ? 0 : 1] >> (3 * (channel % 10))) & 7);
                cycles += SampleCycles[smp] + res;
            }
            LastSequenceSeconds = cycles / ClockHz;
            if(SamplingThread?.GetValue(this) is IManagedThread thread)
            {
                thread.Frequency = (uint)Math.Max(1, Math.Round(1 / LastSequenceSeconds));
            }
        }

        // SMPR1 0x14: SMP0-9 [29:0], SMPPLUS 31; SMPR2 0x18: SMP10-18 [26:0].
        private const long Cr = 0x08, Smpr1 = 0x14, Smpr2 = 0x18, Calfact = 0xB4;
        private readonly uint[] smpr = new uint[2];
        private const long Cfgr = 0x0C;
        private const uint ExtselMask = 0xFu << 6;
        private uint extsel;
        private uint Config => (base.ReadDoubleWord(Cfgr) & ~ExtselMask) | (extsel << 6);
        private static readonly (string, bool)[] ExtselTimers =
        {
            (null, false), (null, false), (null, false), (null, false), ("timer3", false), (null, false), (null, false),
            ("timer8", false), ("timer8", true), ("timer1", false), ("timer1", true), ("timer2", false),
            ("timer4", false), ("timer6", false), ("timer15", false), (null, false),
        };
        private static readonly MethodInfo StartSampling =
            typeof(STM32_ADC_Common).GetMethod("StartSampling", BindingFlags.NonPublic | BindingFlags.Instance);
        private readonly System.Collections.Generic.HashSet<int> subscribed = new System.Collections.Generic.HashSet<int>();
        private bool armed;
        private int externalStarts;
        private const uint Adstp = 1u << 4;
        private const uint Adstart = 1u << 2, Deeppwd = 1u << 29, Adcaldif = 1u << 30, Adcal = 1u << 31;
        private static readonly double[] SampleCycles = { 2.5, 6.5, 12.5, 24.5, 47.5, 92.5, 247.5, 640.5 };
        private static readonly double[] ResolutionCycles = { 12.5, 10.5, 8.5, 6.5 };
        private static readonly double TicksPerSecond = TimeInterval.FromSeconds(1).Ticks;
        private static readonly FieldInfo SamplingThread =
            typeof(STM32_ADC_Common).GetField("samplingThread", BindingFlags.NonPublic | BindingFlags.Instance);
        private readonly IMachine machine;
        private bool startPending;
        private const uint CalfactMask = 0x007F007F;
        private readonly uint calibrationFactor;
        private uint own;
        private uint calfact;
        private int calibrations;
    }

    public class STM32L4_ADC_Common : IDoubleWordPeripheral, IKnownSize
    {
        public STM32L4_ADC_Common(STM32L4_ADC adc1 = null, STM32L4_ADC adc2 = null, STM32L4_ADC adc3 = null)
        {
            adcs = new[] { adc1, adc2, adc3 };
            if(adc1 != null)
            {
                adc1.Common = this;
                adc1.IsMaster = true;
            }
            hclk = 4000000;   // MSI at reset; the RCC sets it
        }

        public long Size => 0x100;

        public bool Dual => (ccr & 0x1F) != 0;

        public long AdcClockHz
        {
            get
            {
                var ckmode = (ccr >> 16) & 3;
                if(ckmode != 0)
                {
                    return hclk / (1 << (int)(ckmode - 1));
                }
                var presc = (int)((ccr >> 18) & 0xF);
                return kernel / (presc < Prescalers.Length ? Prescalers[presc] : 256);
            }
        }

        // Called by the RCC when HCLK or the ADC kernel clock changes.
        public void SetClocks(long kernelHz, long hclkHz)
        {
            kernel = kernelHz;
            hclk = hclkHz;
            Push();
        }

        public void Reset()
        {
            ccr = 0;
            Push();
        }

        public uint ReadDoubleWord(long offset)
        {
            switch(offset)
            {
            case 0x00:   // CSR: ADC1 ISR [10:0], ADC2 ISR [26:16]
                return Isr(adcs[0]) | (Isr(adcs[1]) << 16);
            case 0x08:
                return ccr;
            case 0x0C:   // CDR: ADC2 DR [31:16], ADC1 DR [15:0] in dual mode
                if(!Dual || adcs[0] == null || adcs[1] == null)
                {
                    return 0;
                }
                return (adcs[1].ReadDoubleWord(0x40) << 16) | (adcs[0].ReadDoubleWord(0x40) & 0xFFFF);
            }
            this.Log(LogLevel.Warning, "Unhandled read from offset 0x{0:X}.", offset);
            return 0;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            if(offset == 0x08)
            {
                ccr = value & CcrMask;
                Push();
                return;
            }
            this.Log(LogLevel.Warning, "Unhandled write to offset 0x{0:X}, value 0x{1:X}.", offset, value);
        }

        internal void StartSlave()
        {
            var slave = adcs[1];
            if(slave != null)
            {
                slave.WriteDoubleWord(0x08, slave.ReadDoubleWord(0x08) | (1u << 2));
            }
        }

        private void Push()
        {
            foreach(var adc in adcs)
            {
                adc?.SetClock(AdcClockHz);
            }
        }

        private static uint Isr(STM32L4_ADC adc)
        {
            return adc == null ? 0 : adc.ReadDoubleWord(0x00) & 0x7FF;
        }

        // DUAL [4:0], DELAY [11:8], DMACFG 13, MDMA [15:14], CKMODE [17:16],
        // PRESC [21:18], VREFEN 22, TSEN 23, VBATEN 24 (ADC_CCR_*_Msk,
        // stm32l496xx.h).
        private const uint CcrMask = 0x01FFEF1F;
        private static readonly int[] Prescalers = { 1, 2, 4, 6, 8, 10, 12, 16, 32, 64, 128, 256 };
        private readonly STM32L4_ADC[] adcs;
        private long kernel;
        private long hclk;
        private uint ccr;
    }
}
