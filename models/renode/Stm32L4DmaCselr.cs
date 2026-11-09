//
// DMA_CSELR of the STM32L496's DMA1 and DMA2 (channel request selection),
// compiled by Renode at load time and placed by platforms/cpus/stm32l496.repl
// at DMA1_CSELR_BASE 0x400200A8 and DMA2_CSELR_BASE 0x400204A8
// (stm32l496xx.h:1323, :1333). The L4's DMA is the L0/L1 IP that Renode's
// STM32LDMA models, plus this register; STM32LDMA logs CSELR as unhandled, so
// the repl registers it over 0x00-0xA7 only and this sits at 0xA8.
//
// CSELR (DMA_Request_TypeDef, stm32l496xx.h:456-459): CxS [4c+3:4c] for
// channels 1-7, read/write, reset 0. HAL_DMA_Init writes the channel's
// request number here.
//
// Not modelled: the selection itself. Which peripheral drives a channel's
// request is fixed by the repl's wiring (each peripheral's DMA connection),
// so a channel whose CxS names another request still serves the wired one.
//
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;

namespace Antmicro.Renode.Peripherals.DMA
{
    public class STM32L4_DMA_CSELR : IDoubleWordPeripheral, IKnownSize
    {
        public long Size => 0x4;

        public void Reset()
        {
            cselr = 0;
        }

        public uint ReadDoubleWord(long offset)
        {
            if(offset == 0)
            {
                return cselr;
            }
            this.Log(LogLevel.Warning, "Unhandled read from offset 0x{0:X}.", offset);
            return 0;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            if(offset == 0)
            {
                cselr = value & Mask;
                return;
            }
            this.Log(LogLevel.Warning, "Unhandled write to offset 0x{0:X}, value 0x{1:X}.", offset, value);
        }

        // C1S..C7S (DMA_CSELR_C*S_Msk, stm32l496xx.h).
        private const uint Mask = 0x0FFFFFFF;
        private uint cselr;
    }
}
