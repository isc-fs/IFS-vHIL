//
// DMA request routing of the STM32L496: the CSELR register of DMA1 and DMA2
// and the request lines behind it. Compiled by Renode at load time and placed
// by platforms/cpus/stm32l496.repl.
//
// STM32L4_DMA_CSELR sits at DMA1_CSELR_BASE 0x400200A8 and DMA2_CSELR_BASE
// 0x400204A8 (stm32l496xx.h). The L4's DMA is the L0/L1 IP that Renode's
// STM32LDMA models, plus this register; STM32LDMA logs CSELR as unhandled, so
// the repl registers it over 0x00-0xA7 only. CSELR (DMA_Request_TypeDef):
// CxS [4c+3:4c] for channels 1-7, read/write, reset 0; HAL_DMA_Init writes
// the channel's request number there.
//
// STM32L4_DmaRequests (no address) takes every peripheral's DMA request and
// passes it to the channel whose CxS selects it, as on silicon, where a
// request reaches a channel only through its selection (RM0351 "DMA request
// mapping"). Each request may be served by a DMA1 channel and a DMA2
// channel; the one whose CSELR selects it gets it (if both do, the one that
// is enabled, DMA_CCRx.EN). A request no channel selects is dropped (Dropped
// counts them). Its test API is on either CSELR (RequestsServed, ...).
// Inputs, by number (repl: `DMAReceive -> dmaRequests@15`):
//
//    1 ADC1       DMA1 ch1 / DMA2 ch3, request 0   (the ADCs ask by IDMA:
//    2 ADC2       DMA1 ch2 / DMA2 ch4, request 0    dmaPeripheral:
//    3 ADC3       DMA1 ch3 / DMA2 ch5, request 0    dmaRequests, dmaChannel n)
//    4 DAC1_CH1   DMA1 ch3 req 6 / DMA2 ch4 req 3
//    5 DAC1_CH2   DMA1 ch4 req 5 / DMA2 ch5 req 3
//    6 I2C1_RX    DMA1 ch7 req 3 / DMA2 ch6 req 5   7 I2C1_TX  DMA1 ch6 req 3 / DMA2 ch7 req 5
//    8 I2C2_RX    DMA1 ch5 req 3                    9 I2C2_TX  DMA1 ch4 req 3
//   10 I2C3_RX    DMA1 ch3 req 3                   11 I2C3_TX  DMA1 ch2 req 3
//   12 I2C4_RX    DMA2 ch1 req 0                   13 I2C4_TX  DMA2 ch2 req 0
//   14 SDMMC1     DMA2 ch4 / ch5, request 7
//   15 SPI1_RX    DMA1 ch2 req 1 / DMA2 ch3 req 4  16 SPI1_TX  DMA1 ch3 req 1 / DMA2 ch4 req 4
//   17 SPI2_RX    DMA1 ch4 req 1                   18 SPI2_TX  DMA1 ch5 req 1
//   19 SPI3_RX    DMA2 ch1 req 3                   20 SPI3_TX  DMA2 ch2 req 3
//   21 USART1_RX  DMA1 ch5 / DMA2 ch7, req 2       22 USART1_TX DMA1 ch4 / DMA2 ch6, req 2
//   23 USART2_RX  DMA1 ch6 req 2                   24 USART2_TX DMA1 ch7 req 2
//   25 USART3_RX  DMA1 ch3 req 2                   26 USART3_TX DMA1 ch2 req 2
//   27 UART4_RX   DMA2 ch5 req 2                   28 UART4_TX DMA2 ch3 req 2
//   29 UART5_RX   DMA2 ch2 req 2                   30 UART5_TX DMA2 ch1 req 2
//
// Line 0 is none (Renode's ADC takes no DMA channel 0). LPUART1 and QUADSPI
// requests are not wired.
//
// The table is RM0351's "DMA1 requests for each channel" and "DMA2 requests
// for each channel" (STM32L49x/L4Ax column).
// Which lines a model drives: Renode's SPI (RX and TX), U(S)ART (RX only:
// its TX by DMA does not run), SDMMC, the vHIL's I2C (RX) and the ADCs and
// DAC (Stm32L4Adc.cs, Stm32L4Analog.cs).
//
using System.Collections.Generic;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;

namespace Antmicro.Renode.Peripherals.DMA
{
    public class STM32L4_DMA_CSELR : IDoubleWordPeripheral, IKnownSize
    {
        public long Size => 0x4;

        // The request router's test API, reachable here because the router
        // has no address (and so no monitor name): see STM32L4_DmaRequests.
        public int RequestsDropped => Router?.Dropped ?? 0;
        public int RequestsServed(int line) => Router?.Served(line) ?? 0;
        public int RequestLines => Router?.NumberOfChannels ?? 0;
        public void RaiseRequest(int line, bool level) => Router?.OnGPIO(line, level);
        public void RequestOnce(int line) => Router?.RequestTransfer(line);

        internal STM32L4_DmaRequests Router { get; set; }

        // The request number channel n (1-7) selects.
        public int Selected(int channel)
        {
            return (int)((cselr >> (4 * (channel - 1))) & 0xF);
        }

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

    public class STM32L4_DmaRequests : IGPIOReceiver, IDMA
    {
        public STM32L4_DmaRequests(IDoubleWordPeripheral dma1, STM32L4_DMA_CSELR dma1Cselr,
            IDoubleWordPeripheral dma2, STM32L4_DMA_CSELR dma2Cselr)
        {
            controllers = new[] { (dma1, dma1Cselr), (dma2, dma2Cselr) };
            foreach(var cselr in new[] { dma1Cselr, dma2Cselr })
            {
                if(cselr != null)
                {
                    cselr.Router = this;
                }
            }
        }

        public int Dropped => dropped;

        public int NumberOfChannels => Routes.Length - 1;

        // Times request line n reached a channel (test API).
        public int Served(int line)
        {
            return served.TryGetValue(line, out var n) ? n : 0;
        }

        public void Reset()
        {
        }

        // A request line's level (SPI, U(S)ART, SDMMC, I2C, DAC).
        public void OnGPIO(int line, bool value)
        {
            var target = Route(line, value);
            if(target.dma is IGPIOReceiver receiver)
            {
                receiver.OnGPIO(target.channel - 1, value);
            }
        }

        // A one-shot request (the ADCs, Renode's IDMA): the line number.
        public void RequestTransfer(int line)
        {
            var target = Route(line, true);
            if(target.dma is IDMA dma)
            {
                dma.RequestTransfer(target.channel);
            }
        }

        private (IDoubleWordPeripheral dma, int channel) Route(int line, bool count)
        {
            if(line < 0 || line >= Routes.Length)
            {
                this.Log(LogLevel.Warning, "No DMA request line {0}.", line);
                return (null, 0);
            }
            (IDoubleWordPeripheral, int)? chosen = null;
            foreach(var (index, channel, request) in Routes[line])
            {
                var (dma, cselr) = controllers[index];
                if(dma == null || cselr == null || cselr.Selected(channel) != request)
                {
                    continue;
                }
                var enabled = (dma.ReadDoubleWord(0x08 + 0x14 * (channel - 1)) & 1) != 0;
                if(chosen == null || enabled)
                {
                    chosen = (dma, channel);
                }
                if(enabled)
                {
                    break;
                }
            }
            if(chosen == null)
            {
                if(count)
                {
                    dropped++;
                    this.Log(LogLevel.Debug, "DMA request line {0} dropped: no channel selects it.", line);
                }
                return (null, 0);
            }
            if(count)
            {
                served[line] = Served(line) + 1;
            }
            return chosen.Value;
        }

        // line -> (controller 0 DMA1 / 1 DMA2, channel 1-7, CxS request).
        private static readonly (int, int, int)[][] Routes =
        {
            new (int, int, int)[0],           //  0 NONE
            new[] { (0, 1, 0), (1, 3, 0) },   //  0 ADC1
            new[] { (0, 2, 0), (1, 4, 0) },   //  1 ADC2
            new[] { (0, 3, 0), (1, 5, 0) },   //  2 ADC3
            new[] { (0, 3, 6), (1, 4, 3) },   //  3 DAC1_CH1
            new[] { (0, 4, 5), (1, 5, 3) },   //  4 DAC1_CH2
            new[] { (0, 7, 3), (1, 6, 5) },   //  5 I2C1_RX
            new[] { (0, 6, 3), (1, 7, 5) },   //  6 I2C1_TX
            new[] { (0, 5, 3) },              //  7 I2C2_RX
            new[] { (0, 4, 3) },              //  8 I2C2_TX
            new[] { (0, 3, 3) },              //  9 I2C3_RX
            new[] { (0, 2, 3) },              // 11 I2C3_TX
            new[] { (1, 1, 0) },              // 12 I2C4_RX
            new[] { (1, 2, 0) },              // 13 I2C4_TX
            new[] { (1, 4, 7), (1, 5, 7) },   // 14 SDMMC1
            new[] { (0, 2, 1), (1, 3, 4) },   // 15 SPI1_RX
            new[] { (0, 3, 1), (1, 4, 4) },   // 16 SPI1_TX
            new[] { (0, 4, 1) },              // 17 SPI2_RX
            new[] { (0, 5, 1) },              // 18 SPI2_TX
            new[] { (1, 1, 3) },              // 19 SPI3_RX
            new[] { (1, 2, 3) },              // 20 SPI3_TX
            new[] { (0, 5, 2), (1, 7, 2) },   // 21 USART1_RX
            new[] { (0, 4, 2), (1, 6, 2) },   // 22 USART1_TX
            new[] { (0, 6, 2) },              // 23 USART2_RX
            new[] { (0, 7, 2) },              // 24 USART2_TX
            new[] { (0, 3, 2) },              // 25 USART3_RX
            new[] { (0, 2, 2) },              // 26 USART3_TX
            new[] { (1, 5, 2) },              // 27 UART4_RX
            new[] { (1, 3, 2) },              // 28 UART4_TX
            new[] { (1, 2, 2) },              // 29 UART5_RX
            new[] { (1, 1, 2) },              // 30 UART5_TX
        };

        private readonly (IDoubleWordPeripheral dma, STM32L4_DMA_CSELR cselr)[] controllers;
        private readonly Dictionary<int, int> served = new Dictionary<int, int>();
        private int dropped;
    }
}
