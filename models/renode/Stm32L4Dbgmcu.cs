//
// DBGMCU of the STM32L496 (MCU debug unit), compiled by Renode at load time
// and placed by platforms/cpus/stm32l496.repl at DBGMCU_BASE 0xE0042000
// (stm32l496xx.h:1365). Renode's Cortex-M4 has nothing there, so an access
// went to an unmapped address.
//
// Who touches it: HAL_GetDEVID/HAL_GetREVID read IDCODE, and
// HAL_DBGMCU_EnableDBGSleepMode and the __HAL_DBGMCU_FREEZE_* macros write
// CR and the freeze registers.
//
// Registers (DBGMCU_TypeDef, stm32l496xx.h:428-435; RM0351 "DBG registers"):
// - IDCODE (0x00), read-only: REV_ID [31:16], DEV_ID [11:0]. DEV_ID 0x461 is
//   the STM32L496xx/4A6xx (RM0351 "MCU device ID code"); REV_ID is the
//   repl's idCode, 0x1000 by default (revision A).
// - CR (0x04), APB1FZR1 (0x08), APB1FZR2 (0x0C), APB2FZR (0x10): stored as
//   written (bits from the header's DBGMCU_*_Msk fields), no effect. CR keeps
//   the debug clocks through Sleep/Stop/Standby for a probe, and the freeze
//   bits act only while a debugger halts the core, when a halted Renode
//   machine stops its virtual time anyway.
//
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class STM32L4_DBGMCU : IDoubleWordPeripheral, IKnownSize
    {
        public STM32L4_DBGMCU(uint idCode = 0x10006461)
        {
            this.idCode = idCode;
            Reset();
        }

        public long Size => 0x400;

        public void Reset()
        {
            regs = new uint[Masks.Length];
        }

        public uint ReadDoubleWord(long offset)
        {
            if(offset == 0)
            {
                return idCode;
            }
            var i = Index(offset);
            if(i >= 0)
            {
                return regs[i];
            }
            this.Log(LogLevel.Warning, "Unhandled read from offset 0x{0:X}.", offset);
            return 0;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            if(offset == 0)
            {
                return;   // read-only
            }
            var i = Index(offset);
            if(i >= 0)
            {
                regs[i] = value & Masks[i];
                return;
            }
            this.Log(LogLevel.Warning, "Unhandled write to offset 0x{0:X}, value 0x{1:X}.", offset, value);
        }

        private static int Index(long offset)
        {
            return offset >= 0x04 && offset <= 0x10 && offset % 4 == 0 ? (int)(offset / 4) - 1 : -1;
        }

        // CR, APB1FZR1, APB1FZR2, APB2FZR (DBGMCU_*_Msk, stm32l496xx.h). The
        // header has no APB2FZR bit names; RM0351 lists TIM1 11, TIM8 13,
        // TIM15 16, TIM16 17, TIM17 18.
        private static readonly uint[] Masks = { 0x000000E7, 0x86E01C3F, 0x00000022, 0x00072800 };

        private readonly uint idCode;
        private uint[] regs;
    }
}
