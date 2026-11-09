//
// SPI of the STM32H7 with a fault hook, compiled by Renode at load time and
// placed by platforms/cpus/stm32h733.repl in place of Renode's STM32H7_SPI.
// Renode's model unchanged until the hook is set.
//
// Renode's STM32H7_SPI never fails a transfer: TXP always reads 1, every
// byte reaches the slave the moment it is written, and UDR/OVR/MODF are
// tags. The HAL's error paths (stm32h7xx_hal_spi.c, SPI_CloseTransfer and the
// timeout branches of HAL_SPI_Transmit / HAL_SPI_TransmitReceive) and the
// firmware's reaction to a failed isoSPI transfer were unreachable. This adds
// the failure a master on the car can actually see:
//
//   Stall / StallNextTransfers n
//                      The transfer never runs: SCK never toggles, so nothing
//                      reaches the slave and SR.EOT never sets (RM0468, "SPI
//                      master transfer": EOT is set once TSIZE data frames
//                      have been shifted). Data written to TXDR stays in the
//                      TxFIFO; once it holds FifoBytes, SR.TXP reads 0. RXP and
//                      DXP read 0 (nothing was received), TXC 0. The HAL waits
//                      out its timeout and returns HAL_TIMEOUT (TXP or RXP
//                      never comes) or HAL_ERROR (EOT never comes,
//                      HAL_SPI_ERROR_FLAG). Clearing SPE (SPI_CloseTransfer)
//                      ends the transfer and flushes the FIFO, as on the chip.
//                      A slave framed by a GPIO chip select sees the select
//                      toggle with no clocks in between: for the LTC6820 that
//                      is a wake pulse (models/renode/IsoSpi.cs). `Stall`
//                      stalls every transfer while set; `StallNextTransfers n`
//                      the next n to start (CR1.CSTART with SPE set), so a
//                      test can aim one at a given command (tests/sim, a CPU
//                      hook on HAL_SPI_Transmit arming it).
//
// Transfer time (#368). Renode's model shifts a frame the moment it is
// written: every transfer took no virtual time, so the AMS's isoSPI reads
// (84 B on the 10-IC chain, ~1.3 ms each on the car) cost nothing and its
// ADOW pull-up to pull-down gap was 6 ms instead of ~11-13 ms (#641). With
// `kernelClockHz` set (the platform does), every frame written to TXDR adds
// its bits to the wire, and a timer on the machine's clock source counting
// kernel clocks fires when the last of them is clocked:
//
//     frame = (DSIZE + 1) x 2^(MBR + 1) kernel clocks   (RM0468 SPI_CFG1:
//             f_SCK = f_kernel / 2^(MBR + 1)), then
//             MIDI x 2^(MBR + 1) idle before the next     (SPI_CFG2.MIDI)
//
// Until then EOT and TXC read 0 and CSTART 1, so a HAL transfer
// (HAL_SPI_Transmit / TransmitReceive / Receive end on EOT) returns when its
// bits would have been clocked, and clearing SPE stops the clock. The data
// itself still moves when written, as in Renode's model: RXP comes at once
// and the slave sees a frame up to the transfer's length early (a 4-byte
// LTC6811 command: 62 us; an ADCV / ADOW starts converting that much early,
// pull-up and pull-down alike). Timing each frame instead, with RXP and the
// slave on its last bit, cost the AMS ~0.7 ms of host time a byte (a timer
// event and a fast-forward proof each): 7x slower. TXP stays 1 (the HAL's
// full-duplex loop keeps itself within a FIFO of what it has read). The
// registers change only at the timer's event or a firmware access, so a read
// needs no time sync, and for the busy-wait fast-forward (VhilFastForward.cs)
// a read but RXDR's is stable until the bits are clocked (VhilStableUntil):
// the HAL's wait for EOT is skipped, not executed. SPI1's IRQ is not wired
// (the AMS polls), so an EOT interrupt's timing is not modelled.
// kernelClockHz = 0 keeps Renode's instant transfers.
//
// MBR and MIDI are tags in Renode's model (not stored, read as 0): this keeps
// them from CFG1 / CFG2 writes taken while SPE is clear, and CFG1 / CFG2 read
// back every tagged bit as written, as on the chip. Without that, the HAL's
// read-modify-write of CFG1 before every transfer (HAL_SPI_Transmit /
// TransmitReceive set DSIZE) cleared MBR. MSSI (the AMS's 7 cycles) is not
// charged: it delays the first frame after SS goes active, and the AMS drives
// its chip select by GPIO (SPI_NSS_SOFT).
//
// Not modelled, because the AMS (the only SPI1 user) cannot meet them:
//   MODF  needs the NSS input driven low while master; AMS MX_SPI1_Init uses
//         SPI_NSS_SOFT (IFS08-CE-AMS main.c:622), SSI held high.
//   OVR   the HAL's polled full-duplex loop never lets the TxFIFO run more
//         than one FIFO ahead of what it has read (HAL_SPI_TransmitReceive,
//         `initial_RxXferCount < initial_TxXferCount + fifo_length`), and
//         a master only clocks what is in its TxFIFO, so the RxFIFO cannot
//         overflow. The HAL also ignores OVR on a TX-only transfer.
//   UDR   a slave-mode error.
//
// Writes to bits Renode's model tags: the HAL writes CFG2.COMM on every
// transmit and IFCR.TXTFC on every transfer's close (SPI_CloseTransfer), and
// Renode's register framework logs a warning for each, formatted on the CPU's
// thread (half the AMS's log lines, #260). A tagged bit is neither stored nor
// acted on (PeripheralRegister.WriteInner: only defined fields take a write;
// the warning is the whole effect), so after the first write of a given
// pattern at an offset, which Renode logs and the peripheral guard
// (vhil/peripheral_guard.py) checks against configs/peripherals.yaml, the
// same pattern goes in with the tagged bits as the register already holds
// them: no warning, the same register state.
//
using System;
using System.Collections.Generic;
using System.Linq.Expressions;
using System.Reflection;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Core.Structure.Registers;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.Timers;
using Antmicro.Renode.Time;

namespace Antmicro.Renode.Peripherals.SPI
{
    public class STM32H7_SPIWithFaults : STM32H7_SPI, IDoubleWordPeripheral, IWordPeripheral, IBytePeripheral
    {
        public STM32H7_SPIWithFaults(IMachine machine, long kernelClockHz = 0) : base(machine)
        {
            this.machine = machine;
            KernelClockHz = kernelClockHz;
            if(kernelClockHz > 0)
            {
                // Counts kernel clocks: a frame is a whole number of them.
                wireTimer = new LimitTimer(machine.ClockSource, (ulong)kernelClockHz, this, "wire", limit: 1,
                                           direction: Direction.Ascending, enabled: false,
                                           workMode: WorkMode.OneShot, eventEnabled: true);
                wireTimer.LimitReached += OnClocked;
            }
        }

        public override void Reset()
        {
            base.Reset();
            stalled = false;
            queuedBytes = 0;
            clocking = false;
            transferEnding = false;
            wireTimer?.Reset();
            mbr = 0;
            dsize = 7;
            midi = 0;
            cfg1 = Cfg1Reset;
            cfg2 = 0;
            // Stall and StallNextTransfers are the fault, not the chip's
            // state: they survive the MCU's reset.
        }

        // -- test API (monitor: `sysbus.spi1 StallNextTransfers 1`) ------------

        public bool Stall { get; set; }

        public void StallNextTransfers(int n)
        {
            pendingStalls = Math.Max(0, n);
        }

        public int PendingStalls => pendingStalls;

        // Transfers that never ran, since the platform loaded.
        public int StalledTransfers => stalledTransfers;

        // -- transfer time (#368) ---------------------------------------------

        // The SPI kernel clock (Hz); 0: transfers take no time (Renode's
        // model as it is).
        public long KernelClockHz { get; }

        // f_SCK now, from MBR as last configured; 0 with no kernel clock.
        public double SckHz => KernelClockHz <= 0 ? 0 : KernelClockHz / Math.Pow(2, mbr + 1);

        // A transfer's bits still being clocked (EOT and TXC held at 0).
        public bool Clocking => clocking;

        // Frames timed on the wire, since the platform loaded.
        public ulong TimedFrames => timedFrames;

        // -- registers ---------------------------------------------------------

        public new uint ReadDoubleWord(long offset)
        {
            var value = base.ReadDoubleWord(offset);
            if(offset == Cfg1)
            {
                value = (value & ~Cfg1Tags) | (cfg1 & Cfg1Tags);
            }
            else if(offset == Cfg2)
            {
                value = (value & ~Cfg2Tags) | (cfg2 & Cfg2Tags);
            }
            if(offset == Sr && stalled)
            {
                value &= ~(SrRxp | SrDxp | SrEot | SrTxc);
                if(queuedBytes >= FifoBytes)
                {
                    value &= ~SrTxp;
                }
            }
            else if(offset == Sr && clocking)
            {
                // Bits still on the wire: the transfer has not ended (EOT)
                // and TXC (which also covers TSIZE = 0, where Renode's model
                // only looks at its own, empty, TxFIFO) is not set yet.
                value &= ~(SrEot | SrTxc);
            }
            else if(offset == Cr1 && clocking && transferEnding)
            {
                value |= Cr1Cstart;   // cleared by the hardware at EOT
            }
            if(offset != Rxdr)
            {
                VhilOnRead?.Invoke(offset);
            }
            return value;
        }

        // For the busy-wait fast-forward (VhilFastForward.cs): the virtual
        // time (ticks, exclusive) up to which a read at `offset` returns what
        // it returns now and changes nothing. Only the wire timer's event
        // (EOT, TXC, CSTART) and a read of RXDR change what a read sees.
        public bool VhilStableUntil(long offset, out ulong ticks)
        {
            ticks = 0;
            if(offset == Rxdr || offset < 0 || offset >= Size)
            {
                return false;
            }
            if(!clocking || stalled)
            {
                ticks = ulong.MaxValue;
                return true;
            }
            ticks = (ulong)Math.Ceiling(clockedAt);
            return true;
        }

        // Called on every read but RXDR's, after the frames due by then have
        // landed: the fast-forward's cue that a poll may be under way.
        public Action<long> VhilOnRead { get; set; }

        public new void WriteDoubleWord(long offset, uint value)
        {
            Write(offset, value, 4);
        }

        public new ushort ReadWord(long offset)
        {
            return (ushort)ReadDoubleWord(offset);
        }

        public new void WriteWord(long offset, ushort value)
        {
            Write(offset, value, 2);
        }

        public new byte ReadByte(long offset)
        {
            return (byte)ReadDoubleWord(offset);
        }

        public new void WriteByte(long offset, byte value)
        {
            Write(offset, value, 1);
        }

        private void Write(long offset, uint value, int width)
        {
            if(offset == Txdr && stalled)
            {
                // SCK never runs: the frame stays in the TxFIFO.
                queuedBytes = Math.Min(FifoBytes, queuedBytes + width);
                return;
            }
            if(offset == Txdr && wireTimer != null)
            {
                Clock();
                base.WriteDoubleWord(offset, value);
                transferEnding = (base.ReadDoubleWord(Sr) & SrEot) != 0;
                return;
            }
            if(offset == Cfg1 || offset == Cfg2)
            {
                // Renode's model refuses these while SPE is set; so does the
                // chip (RM0468: write-protected while SPE = 1).
                if((base.ReadDoubleWord(Cr1) & Cr1Spe) == 0)
                {
                    if(offset == Cfg1)
                    {
                        cfg1 = value;
                        mbr = (int)((value >> 28) & 7);
                        dsize = (int)(value & 0x1F);
                    }
                    else
                    {
                        cfg2 = value;
                        midi = (int)((value >> 4) & 0xF);
                    }
                }
            }
            if(offset == Cr1)
            {
                if((value & Cr1Spe) == 0)
                {
                    // SPE cleared: the transfer is over, the FIFOs flushed.
                    stalled = false;
                    queuedBytes = 0;
                    clocking = false;
                    transferEnding = false;
                    if(wireTimer != null)
                    {
                        wireTimer.Enabled = false;
                    }
                }
                else if((value & Cr1Cstart) != 0 && !stalled && (Stall || pendingStalls > 0))
                {
                    if(!Stall)
                    {
                        pendingStalls--;
                    }
                    stalled = true;
                    queuedBytes = 0;
                    stalledTransfers++;
                    this.Log(LogLevel.Info, "Transfer stalled (fault hook)");
                    return;   // CSTART never takes: no transfer starts
                }
            }
            if(offset == Cfg2 || offset == Ifcr)
            {
                value = QuietTags(offset, value);
            }
            base.WriteDoubleWord(offset, value);
        }

        // A frame written to TXDR: its bits follow the ones still on the
        // wire, after MIDI idle SCK periods between frames (RM0468
        // SPI_CFG2.MIDI), or start now. The timer fires when the last bit of
        // everything written so far is clocked.
        private void Clock()
        {
            var clocks = (ulong)(dsize + 1) << (mbr + 1);
            if(clocking)
            {
                var idle = (ulong)midi << (mbr + 1);
                wireTimer.Limit += idle + clocks;
                clockedAt += (idle + clocks) * TicksPerSecond / KernelClockHz;
            }
            else
            {
                var now = Now();
                wireTimer.Value = 0;
                wireTimer.Limit = clocks;
                wireTimer.Enabled = true;
                clocking = true;
                clockedAt = now + clocks * TicksPerSecond / KernelClockHz;
            }
            timedFrames++;
        }

        // The last bit is clocked: EOT, TXC and CSTART read as Renode's model
        // has them (it ended the transfer when the last frame was written).
        private void OnClocked()
        {
            clocking = false;
            transferEnding = false;
        }

        // Virtual time to within the instruction, in ticks.
        private double Now()
        {
            if(machine.SystemBus.TryGetCurrentCPU(out var cpu))
            {
                cpu.SyncTime();
            }
            return machine.ElapsedVirtualTime.TimeElapsed.Ticks;
        }

        // The value to write so that Renode logs a tagged-bit write only the
        // first time (see the header). (underlying ^ value) & ~defined is what
        // Renode reports as unhandled.
        private uint QuietTags(long offset, uint value)
        {
            if(!tagged.TryGetValue(offset, out var register))
            {
                register = TaggedRegister.Of(this, offset);
                tagged[offset] = register;
            }
            if(register == null)
            {
                return value;
            }
            var underlying = register.Underlying();
            var unhandled = (underlying ^ value) & ~register.Defined;
            if(unhandled == 0 || logged.Add(((ulong)offset << 32) | (unhandled & 0xFFFFFFFF)))
            {
                return value;
            }
            return (uint)((value & register.Defined) | (underlying & ~register.Defined));
        }

        // One register of Renode's model: its defined-fields mask and current
        // value (PeripheralRegister.definedFieldsMask, UnderlyingValue), read
        // by reflection; null if this Renode keeps them otherwise.
        private sealed class TaggedRegister
        {
            public static TaggedRegister Of(STM32H7_SPI spi, long offset)
            {
                try
                {
                    var flags = BindingFlags.Instance | BindingFlags.NonPublic;
                    var collection = typeof(STM32H7_SPI).GetField("registers", flags)?.GetValue(spi);
                    var map = collection?.GetType().BaseType?.GetField("registers", flags)?.GetValue(collection)
                        as System.Collections.IDictionary;
                    var selector = map?[offset];
                    var register = selector?.GetType().GetMethod("GetRegister", flags)?.Invoke(selector, null);
                    var definedField = typeof(PeripheralRegister).GetField("definedFieldsMask", flags);
                    var underlyingField = typeof(PeripheralRegister).GetField("UnderlyingValue", flags);
                    if(!(register is PeripheralRegister) || definedField == null || underlyingField == null)
                    {
                        return null;
                    }
                    var target = Expression.Constant(register);
                    var read = Expression.Lambda<Func<ulong>>(
                        Expression.Field(Expression.Convert(target, typeof(PeripheralRegister)), underlyingField)).Compile();
                    return new TaggedRegister { Defined = (ulong)definedField.GetValue(register), Underlying = read };
                }
                catch(Exception)
                {
                    return null;
                }
            }

            public ulong Defined;
            public Func<ulong> Underlying;
        }

        private readonly Dictionary<long, TaggedRegister> tagged = new Dictionary<long, TaggedRegister>();
        private readonly HashSet<ulong> logged = new HashSet<ulong>();

        private readonly IMachine machine;
        private readonly LimitTimer wireTimer;
        private bool clocking;
        private bool transferEnding;
        private double clockedAt;
        private ulong timedFrames;
        private int mbr;
        private int dsize = 7;   // CFG1 reset value 0x00070007: 8-bit frames
        private int midi;
        private uint cfg1 = Cfg1Reset;
        private uint cfg2;

        private bool stalled;
        private int queuedBytes;
        private int pendingStalls;
        private int stalledTransfers;

        private static readonly double TicksPerSecond = TimeInterval.FromSeconds(1).Ticks;

        // SPI1..3 have a 16 x 8-bit FIFO (RM0468, "SPI implementation").
        private const int FifoBytes = 16;

        private const long Cr1 = 0x00;
        private const long Cfg1 = 0x08;
        private const long Cfg2 = 0x0C;
        private const long Rxdr = 0x30;
        // CFG1 / CFG2 bits Renode's model tags (not stored, read as 0): FTHLV,
        // UDRCFG, UDRDET, CRCSIZE, CRCEN, MBR; MSSI, MIDI, IOSWP, COMM, SP,
        // CPHA, CPOL, SSM, SSIOP, SSOE, SSOM, AFCNTR (RM0468 SPI_CFG1/CFG2).
        private const uint Cfg1Tags = 0x705F1FE0;
        private const uint Cfg2Tags = 0xF73E80FF;
        private const uint Cfg1Reset = 0x00070007;   // RM0468 SPI_CFG1 reset value
        private const long Ifcr = 0x18;
        private const long Sr = 0x14;
        private const long Txdr = 0x20;
        private const uint Cr1Spe = 1u << 0;
        private const uint Cr1Cstart = 1u << 9;
        private const uint SrRxp = 1u << 0;
        private const uint SrTxp = 1u << 1;
        private const uint SrDxp = 1u << 2;
        private const uint SrEot = 1u << 3;
        private const uint SrTxc = 1u << 12;
    }
}
