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
// STM32L4_ADC_Common holds the common registers of the three: CSR (0x00, the
// ADCs' ISR flags side by side: ADC1 [10:0], ADC2 [26:16]; ADC3's are only in
// its own ISR, RM0351 "ADC common status register"), CCR (0x08: clock mode,
// prescaler, VREFEN, TSEN, VBATEN, dual mode fields, stored) and CDR (0x0C,
// reads 0: dual mode is not modelled).
//
// Not modelled: conversion timing from the ADC clock (CCR.CKMODE/PRESC, the
// sampling times): a conversion's rate is the repl's externalEventFrequency.
// Dual mode (CCR.DUAL) and its CDR. The internal channels (VREFINT, the
// temperature sensor, VBAT/3) read as the analog inputs the test feeds.
//
using Antmicro.Renode.Core;
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

        public new uint ReadDoubleWord(long offset)
        {
            switch(offset)
            {
            case Cr:
                return (base.ReadDoubleWord(Cr) & ~(Deeppwd | Adcaldif | Adcal)) | own;
            case Calfact:
                return calfact;
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
                base.WriteDoubleWord(Cr, value & ~(Deeppwd | Adcaldif | Adcal));
                return;
            case Calfact:
                calfact = value & CalfactMask;
                return;
            }
            base.WriteDoubleWord(offset, value);
        }

        private void ResetL4()
        {
            own = Deeppwd;
            calfact = 0;
        }

        private const long Cr = 0x08, Calfact = 0xB4;
        private const uint Deeppwd = 1u << 29, Adcaldif = 1u << 30, Adcal = 1u << 31;
        private const uint CalfactMask = 0x007F007F;
        private readonly uint calibrationFactor;
        private uint own;
        private uint calfact;
        private int calibrations;
    }

    public class STM32L4_ADC_Common : IDoubleWordPeripheral, IKnownSize
    {
        public STM32L4_ADC_Common(IDoubleWordPeripheral adc1 = null, IDoubleWordPeripheral adc2 = null)
        {
            this.adc1 = adc1;
            this.adc2 = adc2;
        }

        public long Size => 0x100;

        public void Reset()
        {
            ccr = 0;
        }

        public uint ReadDoubleWord(long offset)
        {
            switch(offset)
            {
            case 0x00:   // CSR: ADC1 ISR [10:0], ADC2 ISR [26:16]
                return Isr(adc1) | (Isr(adc2) << 16);
            case 0x08:
                return ccr;
            case 0x0C:   // CDR: dual mode only
                return 0;
            }
            this.Log(LogLevel.Warning, "Unhandled read from offset 0x{0:X}.", offset);
            return 0;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            if(offset == 0x08)
            {
                ccr = value & CcrMask;
                return;
            }
            this.Log(LogLevel.Warning, "Unhandled write to offset 0x{0:X}, value 0x{1:X}.", offset, value);
        }

        private static uint Isr(IDoubleWordPeripheral adc)
        {
            return adc == null ? 0 : adc.ReadDoubleWord(0x00) & 0x7FF;
        }

        // DUAL [4:0], DELAY [11:8], DMACFG 13, MDMA [15:14], CKMODE [17:16],
        // PRESC [21:18], VREFEN 22, TSEN 23, VBATEN 24 (ADC_CCR_*_Msk,
        // stm32l496xx.h).
        private const uint CcrMask = 0x01FFEF1F;
        private readonly IDoubleWordPeripheral adc1;
        private readonly IDoubleWordPeripheral adc2;
        private uint ccr;
    }
}
