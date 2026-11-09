//
// The STM32L496's analog blocks other than the ADC, compiled by Renode at
// load time and placed by platforms/cpus/stm32l496.repl: DAC1 (DAC1_BASE
// 0x40007400), OPAMP1/2 (OPAMP1_BASE 0x40007800, OPAMP2_BASE 0x40007810),
// COMP1/2 (COMP1_BASE 0x40010200, COMP2_BASE 0x40010204) and VREFBUF
// (VREFBUF_BASE 0x40010030) (stm32l496xx.h). Renode has none of them.
// Registers and bits: the header's <PERIPH>_TypeDef and _Msk fields, RM0351
// "DAC", "OPAMP", "COMP", "VREFBUF".
//
// VhilTimerTrgo turns a timer's update event into its TRGO (CR2.MMS 010,
// "update"; TRGO2 with CR2.MMS2 0010) for the DAC's and the ADCs' hardware
// triggers. Other TRGO sources (reset, enable, compare) never fire: Renode's
// STM32_Timer reports only its update event.
//
// DAC1 (two channels, 12-bit):
//   DHRx      DHR12R/12L/8R per channel and the dual ones (12RD, 12LD, 8RD).
//   DOR       follows DHR at once with TENx 0; with TENx 1 on the trigger
//             TSELx picks: 0 TIM6, 1 TIM8, 2 TIM7, 3 TIM5, 4 TIM2, 5 TIM4
//             TRGO, 7 SWTRIGx (self-clearing). 6 (EXTI line 9) never fires.
//   WAVE      noise (an LFSR masked by MAMP) or triangle (amplitude MAMP),
//             added to DHR on each trigger.
//   DMA       DMAENx: each trigger asks for DMA (request lines 4, 5 of
//             Stm32L4DmaCselr.cs) to load the next DHR.
//   CEN/CAL   calibration: CAL_FLAGx reads 1 while the channel's OTRIM
//             (CCR) is 16 or more, so HAL_DACEx_SelfCalibrate settles on it.
//   output    Output1/Output2 (volts, test API) = DOR / 4095 * vref.
//   Stored: MCR (modes, sample and hold), SHSR/SHHR/SHRR; DMAUDR never sets.
//
// OPAMP1/2: CSR (OPAEN, OPALPM, OPAMODE, PGA_GAIN, VM_SEL, VP_SEL, CALON,
//   CALSEL, USERTRIM, CALOUT; OPA_RANGE in OPAMP1's), OTR, LPOTR. The
//   output (test API Output, volts) is the non-inverting input SetInput gave
//   times the PGA gain (OPAMODE 10, x2/4/8/16) or times 1 (follower, 11);
//   standalone (00, 01) uses its external network: Output is what SetOutput
//   gave. Calibration: CALOUT reads 1 while the trim CALSEL picks (OTR or
//   LPOTR, N or P) is above 16, so HAL_OPAMP_SelfCalibrate settles on 16.
//
// COMP1/2: CSR. The output is (plus > minus) xor POLARITY, while EN is set
//   (VALUE, bit 30). The plus input is SetPlus (volts, test API); the minus
//   input is INMSEL: 0-3 VREFINT/4, /2, 3/4, VREFINT (1.212 V), 4/5 DAC1
//   channel 1/2 output, 6/7 SetMinus. The output is worked out again when
//   CSR or an input changes, and when the DAC's output moves. The output drives EXTI line 21
//   (COMP1) / 22 (COMP2) (repl), so its interrupt is EXTI's: edges per
//   RTSR1/FTSR1, COMP_IRQn 64. LOCK makes CSR read-only until reset.
//   Hysteresis, blanking, the window mode and power modes are stored.
//
// VREFBUF: CSR ENVR, HIZ, VRS (2.048 V / 2.5 V); VRR (ready) follows ENVR.
//   CCR TRIM stored. Voltage (test API) is the output, 0 when off.
//
using System;
using System.Collections.Generic;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.DMA;
using Antmicro.Renode.Peripherals.Timers;

namespace Antmicro.Renode.Peripherals.Analog
{
    // Timer TRGO for the ADC and DAC triggers. Renode's STM32_Timer tags
    // CR2.MMS (and MMS2), so a write to it is lost: Track (the platform's
    // setup, `emulation CreateVhilL4TimerTrgo`) keeps each timer's CR2 from
    // its writes and returns it on reads. TRGO is the update event (MMS 2,
    // MMS2 2 for TRGO2), the timer's LimitReached; the other MMS sources
    // (reset, enable, compare) are not modelled.
    public static class VhilTimerTrgo
    {
        public static void Track(IMachine machine)
        {
            var cr2s = Cr2s.GetOrCreateValue(machine);
            foreach(var name in Timers)
            {
                if(!machine.TryGetByName<STM32_Timer>("sysbus." + name, out var _) || cr2s.ContainsKey(name))
                {
                    continue;
                }
                cr2s[name] = 0;
                var hooks = Antmicro.Renode.Testing.VhilBusHooks.For(machine, "sysbus." + name);
                hooks.OnWrite(0x04, value =>
                {
                    cr2s[name] = value & Mms;
                    return value;
                });
                hooks.OnRead(0x04, value => (value & ~Mms) | cr2s[name]);
                machine.MachineReset += _ => cr2s[name] = 0;
            }
        }

        // Calls `action` on each TRGO (or TRGO2) of the board's timer.
        public static bool OnTrgo(IMachine machine, string timer, bool trgo2, Action action)
        {
            if(machine == null || !machine.TryGetByName<STM32_Timer>("sysbus." + timer, out var t))
            {
                return false;
            }
            var cr2s = Cr2s.GetOrCreateValue(machine);
            t.LimitReached += () =>
            {
                var cr2 = cr2s.TryGetValue(timer, out var kept) ? kept : t.ReadDoubleWord(0x04);
                var update = trgo2 ? ((cr2 >> 20) & 0xF) == 2 : ((cr2 >> 4) & 7) == 2;
                if(update)
                {
                    action();
                }
            };
            return true;
        }

        // MMS [6:4], MMS2 [23:20] (TIM_CR2_MMS_Msk, TIM_CR2_MMS2_Msk).
        private const uint Mms = 0x00F00070;
        private static readonly string[] Timers =
            { "timer1", "timer2", "timer3", "timer4", "timer5", "timer6", "timer7", "timer8", "timer15", "timer16", "timer17" };
        private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<IMachine, System.Collections.Generic.Dictionary<string, uint>> Cr2s =
            new System.Runtime.CompilerServices.ConditionalWeakTable<IMachine, System.Collections.Generic.Dictionary<string, uint>>();
    }

    public class STM32L4_DAC : IDoubleWordPeripheral, IKnownSize
    {
        public STM32L4_DAC(IMachine machine, double referenceVoltage = 3.3, IDMA dmaRequests = null)
        {
            this.machine = machine;
            vref = referenceVoltage;
            dma = dmaRequests;
            Reset();
        }

        public long Size => 0x400;

        public double Output1 => dor[0] / 4095.0 * vref;
        public double Output2 => dor[1] / 4095.0 * vref;

        public uint Output(int channel) => dor[channel - 1];

        // The comparators that read the DAC's outputs listen here.
        public event Action OutputChanged;

        public void Reset()
        {
            cr = 0;
            mcr = 0;
            ccr = 0;
            sr = 0;
            for(var i = 0; i < 2; i++)
            {
                dhr[i] = 0;
                dor[i] = 0;
                lfsr[i] = 0xAAA;
                triangle[i] = 0;
                triangleUp[i] = true;
            }
            Array.Clear(sampleHold, 0, sampleHold.Length);
        }

        public uint ReadDoubleWord(long offset)
        {
            switch(offset)
            {
            case 0x00: return cr;
            case 0x04: return 0;                                  // SWTRGR self-clears
            case 0x08: return dhr[0];
            case 0x0C: return dhr[0] << 4;
            case 0x10: return dhr[0] >> 4;
            case 0x14: return dhr[1];
            case 0x18: return dhr[1] << 4;
            case 0x1C: return dhr[1] >> 4;
            case 0x20: return dhr[0] | (dhr[1] << 16);
            case 0x24: return (dhr[0] << 4) | (dhr[1] << 20);
            case 0x28: return (dhr[0] >> 4) | ((dhr[1] >> 4) << 8);
            case 0x2C: return dor[0];
            case 0x30: return dor[1];
            case 0x34: return sr | CalFlag(0) | CalFlag(1);
            case 0x38: return ccr;
            case 0x3C: return mcr;
            case 0x40: case 0x44: case 0x48: case 0x4C:
                return sampleHold[(offset - 0x40) / 4];
            }
            this.Log(LogLevel.Warning, "Unhandled read from offset 0x{0:X}.", offset);
            return 0;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            switch(offset)
            {
            case 0x00:
                cr = value & 0x7FFF7FFF;
                Subscribe(0);
                Subscribe(1);
                return;
            case 0x04:
                for(var ch = 0; ch < 2; ch++)
                {
                    if((value & (1u << ch)) != 0 && Triggered(ch) && Tsel(ch) == 7)
                    {
                        Trigger(ch);
                    }
                }
                return;
            case 0x08: Load(0, value & 0xFFF); return;
            case 0x0C: Load(0, (value >> 4) & 0xFFF); return;
            case 0x10: Load(0, (value & 0xFF) << 4); return;
            case 0x14: Load(1, value & 0xFFF); return;
            case 0x18: Load(1, (value >> 4) & 0xFFF); return;
            case 0x1C: Load(1, (value & 0xFF) << 4); return;
            case 0x20: Load(0, value & 0xFFF); Load(1, (value >> 16) & 0xFFF); return;
            case 0x24: Load(0, (value >> 4) & 0xFFF); Load(1, (value >> 20) & 0xFFF); return;
            case 0x28: Load(0, (value & 0xFF) << 4); Load(1, ((value >> 8) & 0xFF) << 4); return;
            case 0x34:
                sr &= ~(value & ((1u << 13) | (1u << 29)));       // DMAUDRx: write 1 to clear
                return;
            case 0x38:
                ccr = value & 0x001F001F;
                return;
            case 0x3C:
                mcr = value & 0xC307C307;
                return;
            case 0x40: case 0x44: case 0x48: case 0x4C:
                sampleHold[(offset - 0x40) / 4] = value;
                return;
            }
            this.Log(LogLevel.Warning, "Unhandled write to offset 0x{0:X}, value 0x{1:X}.", offset, value);
        }

        private bool Enabled(int ch) => (cr & (1u << (16 * ch))) != 0;
        private bool Triggered(int ch) => (cr & (1u << (16 * ch + 2))) != 0;   // TENx, DAC_CR_TEN1_Pos 2
        private int Tsel(int ch) => (int)((cr >> (16 * ch + 3)) & 7);

        // CAL_FLAGx (SR bit 14 / 30): 1 while OTRIMx >= 16, in calibration (CENx).
        private uint CalFlag(int ch)
        {
            var calibrating = (cr & (1u << (16 * ch + 14))) != 0;
            var trim = (ccr >> (16 * ch)) & 0x1F;
            return calibrating && trim >= 16 ? 1u << (16 * ch + 14) : 0;
        }

        private void Load(int ch, uint value)
        {
            dhr[ch] = value;
            if(!Triggered(ch))
            {
                dor[ch] = value;   // one APB clock later on silicon
                OutputChanged?.Invoke();
            }
        }

        private void Trigger(int ch)
        {
            if(!Enabled(ch) || !Triggered(ch))
            {
                return;
            }
            var wave = (cr >> (16 * ch + 6)) & 3;
            var mamp = (int)((cr >> (16 * ch + 8)) & 0xF);
            var mask = (uint)((1 << Math.Min(mamp + 1, 12)) - 1);
            uint add = 0;
            if(wave == 1)
            {
                // RM0351 "Noise generation": 12-bit LFSR, taps X12, X6, X4, X1.
                var l = lfsr[ch];
                var bit = ((l >> 11) ^ (l >> 5) ^ (l >> 3) ^ l) & 1;
                lfsr[ch] = ((l << 1) | bit) & 0xFFF;
                add = lfsr[ch] & mask;
            }
            else if(wave >= 2)
            {
                if(triangleUp[ch])
                {
                    triangle[ch]++;
                    if(triangle[ch] >= mask)
                    {
                        triangleUp[ch] = false;
                    }
                }
                else
                {
                    triangle[ch]--;
                    if(triangle[ch] == 0)
                    {
                        triangleUp[ch] = true;
                    }
                }
                add = triangle[ch];
            }
            dor[ch] = Math.Min(dhr[ch] + add, 0xFFFu);
            OutputChanged?.Invoke();
            if((cr & (1u << (16 * ch + 12))) != 0)
            {
                dma?.RequestTransfer(4 + ch);   // the DMA loads the next DHR
            }
        }

        private void Subscribe(int ch)
        {
            if(!Triggered(ch) || subscribed.Contains(Tsel(ch) * 2 + ch))
            {
                return;
            }
            var timer = TselTimers[Tsel(ch)];
            if(timer != null && VhilTimerTrgo.OnTrgo(machine, timer, false, () =>
            {
                if(Tsel(ch) < TselTimers.Length && TselTimers[Tsel(ch)] == timer)
                {
                    Trigger(ch);
                }
            }))
            {
                subscribed.Add(Tsel(ch) * 2 + ch);
            }
        }

        private static readonly string[] TselTimers = { "timer6", "timer8", "timer7", "timer5", "timer2", "timer4", null, null };

        private readonly IMachine machine;
        private readonly double vref;
        private readonly IDMA dma;
        private readonly HashSet<int> subscribed = new HashSet<int>();
        private readonly uint[] dhr = new uint[2];
        private readonly uint[] dor = new uint[2];
        private readonly uint[] lfsr = new uint[2];
        private readonly uint[] triangle = new uint[2];
        private readonly bool[] triangleUp = new bool[2];
        private readonly uint[] sampleHold = new uint[4];
        private uint cr;
        private uint mcr;
        private uint ccr;
        private uint sr;
    }

    public class STM32L4_OPAMP : IDoubleWordPeripheral, IKnownSize
    {
        // first: OPAMP1, whose CSR has OPA_RANGE (bit 31).
        public STM32L4_OPAMP(bool first = true)
        {
            this.first = first;
            Reset();
        }

        public long Size => 0x10;

        public double Output
        {
            get
            {
                if((csr & 1) == 0)
                {
                    return 0;
                }
                switch((csr >> 2) & 3)
                {
                case 2: return input * (2 << (int)((csr >> 4) & 3));   // PGA x2/4/8/16
                case 3: return input;                                   // follower
                default: return external;
                }
            }
        }

        public void SetInput(double volts) => input = volts;

        public void SetOutput(double volts) => external = volts;

        public void Reset()
        {
            csr = 0;
            otr = 0;
            lpotr = 0;
        }

        public uint ReadDoubleWord(long offset)
        {
            switch(offset)
            {
            case 0x00: return csr | (CalOut() ? 1u << 15 : 0);
            case 0x04: return otr;
            case 0x08: return lpotr;
            }
            this.Log(LogLevel.Warning, "Unhandled read from offset 0x{0:X}.", offset);
            return 0;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            switch(offset)
            {
            case 0x00:
                csr = value & (first ? 0x80007FFFu : 0x00007FFFu);
                return;
            case 0x04:
                otr = value & 0x1F1F;
                return;
            case 0x08:
                lpotr = value & 0x1F1F;
                return;
            }
            this.Log(LogLevel.Warning, "Unhandled write to offset 0x{0:X}, value 0x{1:X}.", offset, value);
        }

        // CALON 12, CALSEL 13 (0 NMOS: TRIMOFFSETN [4:0], 1 PMOS: TRIMOFFSETP
        // [12:8]), OPALPM 1 picks LPOTR.
        private bool CalOut()
        {
            if((csr & (1u << 12)) == 0)
            {
                return false;
            }
            var trims = (csr & 2) != 0 ? lpotr : otr;
            var trim = (csr & (1u << 13)) != 0 ? (trims >> 8) & 0x1F : trims & 0x1F;
            return trim > 16;
        }

        private readonly bool first;
        private double input;
        private double external;
        private uint csr;
        private uint otr;
        private uint lpotr;
    }

    public class STM32L4_COMP : IDoubleWordPeripheral, IKnownSize
    {
        public STM32L4_COMP(STM32L4_DAC dac = null)
        {
            this.dac = dac;
            Output = new GPIO();
            if(dac != null)
            {
                dac.OutputChanged += Update;
            }
            Reset();
        }

        public long Size => 0x4;

        public GPIO Output { get; }

        public bool Value => Compare();

        public void SetPlus(double volts)
        {
            plus = volts;
            Update();
        }

        public void SetMinus(double volts)
        {
            minus = volts;
            Update();
        }

        public void Reset()
        {
            csr = 0;
            Update();
        }

        public uint ReadDoubleWord(long offset)
        {
            if(offset == 0)
            {
                return csr | (Compare() ? 1u << 30 : 0);
            }
            this.Log(LogLevel.Warning, "Unhandled read from offset 0x{0:X}.", offset);
            return 0;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            if(offset != 0)
            {
                this.Log(LogLevel.Warning, "Unhandled write to offset 0x{0:X}, value 0x{1:X}.", offset, value);
                return;
            }
            if((csr & Lock) != 0)
            {
                this.Log(LogLevel.Warning, "COMP CSR write 0x{0:X} ignored: LOCK is set.", value);
                return;
            }
            csr = value & 0x80DF83FD;
            Update();
        }

        private bool Compare()
        {
            if((csr & 1) == 0)
            {
                return false;
            }
            double reference;
            switch((csr >> 4) & 7)
            {
            case 0: reference = Vrefint / 4; break;
            case 1: reference = Vrefint / 2; break;
            case 2: reference = Vrefint * 3 / 4; break;
            case 3: reference = Vrefint; break;
            case 4: reference = dac?.Output1 ?? 0; break;
            case 5: reference = dac?.Output2 ?? 0; break;
            default: reference = minus; break;
            }
            var above = plus > reference;
            return (csr & (1u << 15)) != 0 ? !above : above;   // POLARITY
        }

        private void Update()
        {
            Output.Set(Compare());
        }

        // EN 0, PWRMODE [3:2], INMSEL [6:4], INPSEL [8:7], WINMODE 9,
        // POLARITY 15, HYST [17:16], BLANKING [20:18], BRGEN 22, SCALEN 23,
        // VALUE 30 (read-only), LOCK 31.
        private const uint Lock = 1u << 31;
        private const double Vrefint = 1.212;
        private readonly STM32L4_DAC dac;
        private double plus;
        private double minus;
        private uint csr;
    }

    public class STM32L4_VREFBUF : IDoubleWordPeripheral, IKnownSize
    {
        public long Size => 0x8;

        public double Voltage => (csr & 1) == 0 || (csr & 2) != 0 ? 0 : (csr & 4) != 0 ? 2.5 : 2.048;

        public void Reset()
        {
            csr = 2;   // HIZ
            ccr = 0;
        }

        public uint ReadDoubleWord(long offset)
        {
            switch(offset)
            {
            case 0x00: return csr | ((csr & 1) != 0 ? 8u : 0);   // VRR follows ENVR
            case 0x04: return ccr;
            }
            this.Log(LogLevel.Warning, "Unhandled read from offset 0x{0:X}.", offset);
            return 0;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            switch(offset)
            {
            case 0x00: csr = value & 7; return;
            case 0x04: ccr = value & 0x3F; return;
            }
            this.Log(LogLevel.Warning, "Unhandled write to offset 0x{0:X}, value 0x{1:X}.", offset, value);
        }

        private uint csr = 2;
        private uint ccr;
    }
}

namespace Antmicro.Renode.Testing
{
    public static class VhilL4TimerTrgoExtensions
    {
        public static void CreateVhilL4TimerTrgo(this Emulation emulation, string machineName)
        {
            if(!emulation.TryGetMachineByName(machineName, out var machine))
            {
                throw new System.ArgumentException($"no machine '{machineName}'");
            }
            Antmicro.Renode.Peripherals.Analog.VhilTimerTrgo.Track(machine);
        }
    }
}
