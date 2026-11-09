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
// The selection: a peripheral that asks for DMA (Renode's IDMA: the ADCs)
// asks this register, not the controller, naming its channel. Its request
// reaches the controller only when CxS of that channel selects it; otherwise
// it is dropped, as on silicon, where an unselected request never reaches
// the channel (RM0351 "DMA request mapping"). Each requester is wired to one
// channel and one request number in the repl: `RequestOf` (channel ->
// request) says which, e.g. the ADCs are request 0 on DMA1 channels 1-3.
// Dropped() counts the requests that found another selection.
//
// Not modelled: the alternative channel of a request (ADC1 is also DMA2
// channel 3, request 0): each requester is wired to one channel. Renode's
// SPI, U(S)ART and I2C models never ask for DMA; their DMA modes do not run.
//
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;

namespace Antmicro.Renode.Peripherals.DMA
{
    public class STM32L4_DMA_CSELR : IDoubleWordPeripheral, IKnownSize, IDMA
    {
        // dma: the controller this register selects for. request1..7: the
        // request number wired to channel n (-1: none).
        public STM32L4_DMA_CSELR(IDMA dma = null, int request1 = -1, int request2 = -1, int request3 = -1,
            int request4 = -1, int request5 = -1, int request6 = -1, int request7 = -1)
        {
            this.dma = dma;
            wired = new[] { request1, request2, request3, request4, request5, request6, request7 };
        }

        public long Size => 0x4;

        public int Dropped => dropped;

        public int NumberOfChannels => 7;

        public void Reset()
        {
            cselr = 0;
        }

        // The requester's channel (1-7).
        public void RequestTransfer(int channel)
        {
            if(dma == null || channel < 1 || channel > 7)
            {
                return;
            }
            var selected = (int)((cselr >> (4 * (channel - 1))) & 0xF);
            if(selected != wired[channel - 1])
            {
                dropped++;
                this.Log(LogLevel.Debug, "Channel {0} request {1} dropped: C{0}S selects {2}.",
                    channel, wired[channel - 1], selected);
                return;
            }
            dma.RequestTransfer(channel);
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
        private readonly IDMA dma;
        private readonly int[] wired;
        private uint cselr;
        private int dropped;
    }
}
