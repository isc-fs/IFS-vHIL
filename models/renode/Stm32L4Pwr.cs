//
// PWR of the STM32L496 (power control), compiled by Renode at load time and
// placed by platforms/cpus/stm32l496.repl at PWR_BASE 0x40007000
// (APB1PERIPH_BASE + 0x7000, stm32l496xx.h:1259). Renode's STM32_PWR is the
// F4's two registers (CR, CSR), at offsets the L4 uses for CR1 and CR2.
//
// Registers: PWR_TypeDef (stm32l496xx.h:698-726), reset values from RM0351
// "PWR registers" (as ST's STM32L4x6 SVD v1.5 lists them); writable bits are
// the header's PWR_<reg>_*_Msk fields.
//
// - CR1: LPMS, DBP, VOS, LPR. DBP opens the backup domain (RCC_BDCR, the
//   RTC), read by STM32L4_RCC. A VOS change takes no time: SR2.VOSF reads 0,
//   so HAL_PWREx_ControlVoltageScaling returns at once. LPR switches to
//   low-power run: SR2.REGLPF follows it, and REGLPS (the low-power
//   regulator is ready) reads 1.
// - CR2, CR3, CR4, PUCRx/PDCRx (A-I): stored, no effect. The pull-ups and
//   pull-downs apply only in Standby/Shutdown with CR3.APC set, which the
//   emulation never enters.
// - SR1 (wake-up flags) reads 0 and SCR clears nothing: there is no Standby
//   or wake-up pin to set them. SR2's PVD and PVM outputs read 0 (supplies
//   above every threshold).
//
using System.Collections.Generic;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class STM32L4_PWR : IDoubleWordPeripheral, IKnownSize
    {
        public STM32L4_PWR()
        {
            regs = new Dictionary<long, uint>();
            Reset();
        }

        public long Size => 0x400;

        public bool BackupDomainWritable => (regs[CR1] & DBP) != 0;

        public void Reset()
        {
            regs.Clear();
            foreach(var r in Layout)
            {
                regs[r.Key] = r.Value.reset;
            }
        }

        public uint ReadDoubleWord(long offset)
        {
            switch(offset)
            {
            case SR1:
            case SCR:
                return 0;
            case SR2:
                return REGLPS | ((regs[CR1] & LPR) != 0 ? REGLPF : 0);
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
            if(offset == SR1 || offset == SR2 || offset == SCR)
            {
                return;   // read-only, and SCR has nothing to clear
            }
            if(!Layout.TryGetValue(offset, out var r))
            {
                this.Log(LogLevel.Warning, "Unhandled write to offset 0x{0:X}, value 0x{1:X}.", offset, value);
                return;
            }
            regs[offset] = value & r.mask;
        }

        private const long CR1 = 0x00, SR1 = 0x10, SR2 = 0x14, SCR = 0x18;
        private const uint DBP = 1u << 8, LPR = 1u << 14, REGLPS = 1u << 8, REGLPF = 1u << 9;

        private static readonly Dictionary<long, (uint reset, uint mask)> Layout = new Dictionary<long, (uint, uint)>
        {
            { 0x00, (0x00000200, 0x00004707) },   // CR1: VOS range 1
            { 0x04, (0x00000000, 0x000006FF) },   // CR2
            { 0x08, (0x00008000, 0x0000851F) },   // CR3: EIWUL
            { 0x0C, (0x00000000, 0x0000031F) },   // CR4
            { 0x20, (0x00000000, 0x0000BFFF) },   // PUCRA
            { 0x24, (0x00000000, 0x00005FFF) },   // PDCRA
            { 0x28, (0x00000000, 0x0000FFFF) },   // PUCRB
            { 0x2C, (0x00000000, 0x0000FFEF) },   // PDCRB
            { 0x30, (0x00000000, 0x0000FFFF) },   // PUCRC
            { 0x34, (0x00000000, 0x0000FFFF) },   // PDCRC
            { 0x38, (0x00000000, 0x0000FFFF) },   // PUCRD
            { 0x3C, (0x00000000, 0x0000FFFF) },   // PDCRD
            { 0x40, (0x00000000, 0x0000FFFF) },   // PUCRE
            { 0x44, (0x00000000, 0x0000FFFF) },   // PDCRE
            { 0x48, (0x00000000, 0x0000FFFF) },   // PUCRF
            { 0x4C, (0x00000000, 0x0000FFFF) },   // PDCRF
            { 0x50, (0x00000000, 0x0000FFFF) },   // PUCRG
            { 0x54, (0x00000000, 0x0000FFFF) },   // PDCRG
            { 0x58, (0x00000000, 0x0000FFFF) },   // PUCRH
            { 0x5C, (0x00000000, 0x0000FFFF) },   // PDCRH
            { 0x60, (0x00000000, 0x00000FFF) },   // PUCRI
            { 0x64, (0x00000000, 0x00000FFF) },   // PDCRI
        };

        private readonly Dictionary<long, uint> regs;
    }
}
