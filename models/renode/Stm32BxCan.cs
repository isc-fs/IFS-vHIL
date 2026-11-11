//
// bxCAN of the STM32 (the SensorHub's STM32L496: CAN1, CAN2) on the vHIL's
// arbitrated bus. Compiled by Renode at load time and placed by
// platforms/cpus/stm32l496.repl in place of Renode's STMCAN.
//
// Renode's STMCAN (filters, RX FIFOs, CAN2's filters shared with CAN1) stays
// underneath. Its transmit side sends a mailbox the instant TXRQ is written
// and marks it done, which only Renode's hub accepts. On a bus with
// `arbitration: true` (models/renode/VhilCanBus.cs, #174) this model joins the
// bus's arbiter through IVhilCanController (Stm32H7Fdcan.cs) instead:
//
//   - A TXRQ write (CAN_TIxR bit 0) leaves the mailbox pending, stamped with
//     the virtual time it was written, and offers it to the bus. TSR.TMEx
//     reads 0 until the bus says the frame is over (its last EOF bit); then
//     RQCPx and TXOKx are set and the mailbox is empty again (RM0351 "bxCAN
//     transmit handling").
//   - Transmit priority (MCR.TXFP): 0, the mailbox with the lowest identifier
//     (then the lowest mailbox number); 1, the oldest request (RM0351
//     "Transmit priority").
//   - MCR.NART (no automatic retransmission): a frame that loses arbitration
//     or gets no ACK is not retried: RQCPx set, TXOKx clear, ALSTx (lost) or
//     TERRx (error). Otherwise it is retried.
//   - ABRQx aborts a mailbox the bus has not yet decided (RQCPx set, TXOKx
//     clear); one already on the bus completes as decided.
//   - Nothing goes out in initialisation (MSR.INAK) or sleep (MSR.SLAK) mode,
//     and the controller then neither receives nor acknowledges. Silent mode
//     (BTR.SILM) receives but neither sends nor acknowledges. Loopback
//     (BTR.LBKM) gets its own frames back through its filters and ignores the
//     bus's; silent loopback completes a request at once, off the bus.
//   - TSR.CODE is the number of the next empty mailbox, TSR.LOWx the pending
//     mailbox with the lowest priority (RM0351, CAN_TSR).
//   - The transmit interrupt (output 0, CANx_TX_IRQn) is IER.TMEIE and any
//     RQCPx, cleared by writing RQCPx 1.
//   - Error counting is the bus's (ACK errors only): ESR.TEC, LEC (3 = ACK
//     error, 0 = none), EWGF (TEC >= 96) and EPVF (TEC >= 128) read what it
//     counted. REC stays 0; bus-off (BOFF) is not reached. The status change
//     interrupt (output 3, CANx_SCE_IRQn) for errors is not raised (logged
//     once when IER enables it); polling ESR sees the state.
//   - The bit rate is PCLK1 / ((BRP + 1) x (3 + TS1 + TS2)) (RM0351 "Bit
//     timing"), from the RCC's PCLK1 (PclkHz; the RCC sets it, Stm32L4Rcc.cs).
//
// BTR is kept here, writable in initialisation mode and readable in any
// mode, reset 0x01230000 (RM0351, CAN_BTR): Renode's STMCAN reads it as 0
// outside initialisation mode. Otherwise, with no arbitrated bus, this is
// Renode's STMCAN unchanged.
//
// Offsets and bits from ST's stm32l496xx.h (CAN_TypeDef; CAN_MCR_*, CAN_MSR_*,
// CAN_TSR_*, CAN_IER_*, CAN_ESR_*, CAN_BTR_*, CAN_TI0R_*, CAN_TDT0R_*): MCR
// 0x00 (INRQ 0, SLEEP 1, TXFP 2, NART 4, RESET 15), MSR 0x04 (INAK 0, SLAK
// 1), TSR 0x08 (per mailbox n at 8n: RQCP 0, TXOK 1, ALST 2, TERR 3, ABRQ 7;
// CODE [25:24], TME0-2 26-28, LOW0-2 29-31), IER 0x14 (TMEIE 0, EWGIE 8,
// EPVIE 9, BOFIE 10, LECIE 11, ERRIE 15), ESR 0x18 (EWGF 0, EPVF 1, BOFF 2,
// LEC [6:4], TEC [23:16], REC [31:24]), BTR 0x1C (BRP [9:0], TS1 [19:16],
// TS2 [22:20], LBKM 30, SILM 31), mailbox n at 0x180 + 0x10n: TIR (TXRQ 0,
// RTR 1, IDE 2, EXID [20:3], STID [31:21]), TDTR (DLC [3:0]), TDLR, TDHR.
//
using System;
using System.Collections.Generic;
using System.Linq;
using Antmicro.Renode.Core;
using Antmicro.Renode.Core.CAN;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;

namespace Antmicro.Renode.Peripherals.CAN
{
    public class STM32_bxCAN : STMCAN, IDoubleWordPeripheral, IVhilCanController
    {
        public STM32_bxCAN(IMachine machine, STMCAN master = null, long pclkHz = 4000000) : base(master)
        {
            owner = machine;
            PclkHz = pclkHz;
        }

        // The APB clock the bit timing divides (the RCC sets it).
        public long PclkHz { get; set; }

        // Mailboxes the bus completed / cancelled (test API).
        public int Transmitted => transmitted;

        public new void Reset()
        {
            base.Reset();
            lock(sync)
            {
                generation++;
                pending.Clear();
                tsr = 0;
            }
            btr = BtrReset;
            tec = 0;
            lec = 0;
            Connections[TxIrq].Unset();
            bus?.CountersReset(this);
        }

        public new uint ReadDoubleWord(long offset)
        {
            if(offset == Btr)
            {
                return btr;
            }
            if(bus == null)
            {
                return base.ReadDoubleWord(offset);
            }
            switch(offset)
            {
            case Tsr:
                return TransmitStatus();
            case Esr:
                return ErrorStatus();
            }
            if(Mailbox(offset, out var n, out var reg) && reg == 0)
            {
                lock(sync)
                {
                    return (base.ReadDoubleWord(offset) & ~Txrq) | (pending.Any(r => r.Buffer == n) ? Txrq : 0);
                }
            }
            return base.ReadDoubleWord(offset);
        }

        public new void WriteDoubleWord(long offset, uint value)
        {
            if(offset == Btr && (base.ReadDoubleWord(Msr) & MsrInak) != 0)
            {
                btr = value & BtrMask;   // writable in initialisation mode only
            }
            if(bus == null)
            {
                base.WriteDoubleWord(offset, value);
                return;
            }
            switch(offset)
            {
            case Mcr:
                base.WriteDoubleWord(offset, value);
                if((value & McrReset) != 0)
                {
                    Reset();
                    return;
                }
                Changed();   // INRQ, SLEEP: the controller may start or stop sending
                return;
            case Tsr:
                WriteTsr(value);
                return;
            case Ier:
                base.WriteDoubleWord(offset, value);
                if((value & ErrorInterrupts) != 0 && !warnedSce)
                {
                    warnedSce = true;
                    this.Log(LogLevel.Warning, "The error interrupts (IER 0x{0:X}) are not raised on an arbitrated "
                             + "bus (#174): poll ESR", value & ErrorInterrupts);
                }
                UpdateTxIrq();
                return;
            case Esr:
                base.WriteDoubleWord(offset, value);
                if(((value >> 4) & 7) == 7)
                {
                    lec = 7;   // LEC 7 "set by software" to watch for updates
                }
                return;
            }
            if(Mailbox(offset, out var n, out var reg) && reg == 0)
            {
                base.WriteDoubleWord(offset, value & ~Txrq);   // keep the identifier, never send from the base
                if((value & Txrq) != 0)
                {
                    Request(n);
                }
                return;
            }
            base.WriteDoubleWord(offset, value);
        }

        // -- IVhilCanController ------------------------------------------------

        public IMachine OwnerMachine => owner;

        public void Join(IVhilCanBus arbiter)
        {
            bus = arbiter;
        }

        public ulong BitRate
        {
            get
            {
                var prescaler = (btr & 0x3FF) + 1;
                var tqPerBit = 3 + ((btr >> 16) & 0xF) + ((btr >> 20) & 0x7);
                return (ulong)(PclkHz / (prescaler * tqPerBit));
            }
        }

        public bool AutoRetransmissionDisabled => (base.ReadDoubleWord(Mcr) & McrNart) != 0;

        public bool Receives => (base.ReadDoubleWord(Msr) & (MsrInak | MsrSlak)) == 0
                                && (btr & BtrLbkm) == 0;

        public bool Acknowledges => Receives && (btr & BtrSilm) == 0;

        public int Tec => tec;

        public ulong? EarliestRequestNs()
        {
            if(!Sends)
            {
                return null;
            }
            lock(sync)
            {
                ulong? earliest = null;
                foreach(var r in Offerable())
                {
                    earliest = earliest == null ? r.TimeNs : Math.Min(earliest.Value, r.TimeNs);
                }
                return earliest;
            }
        }

        public VhilCanRequest Candidate(ulong atNs)
        {
            if(!Sends)
            {
                return null;
            }
            lock(sync)
            {
                VhilCanRequest best = null;
                foreach(var r in Offerable())
                {
                    if(r.TimeNs > atNs)
                    {
                        continue;
                    }
                    var order = best == null ? -1 : VhilCanFrameBits.Compare(r.Frame, best.Frame);
                    if(order < 0 || (order == 0 && r.Buffer < best.Buffer))
                    {
                        best = r;
                    }
                }
                return best;
            }
        }

        public void Commit(VhilCanRequest request)
        {
            lock(sync)
            {
                request.Committed = true;
            }
        }

        public void Complete(VhilCanRequest request, bool transmitted)
        {
            lock(sync)
            {
                if(request.Generation != generation || !pending.Remove(request))
                {
                    return;
                }
                Done(request, transmitted, lastError ? Terr : Alst);
            }
            if(transmitted && (btr & BtrLbkm) != 0)
            {
                Loopback(request.Frame);
            }
            UpdateTxIrq();
        }

        public void SetErrorState(int newTec, bool error)
        {
            tec = newTec;
            lec = error ? LecAckError : 0u;
            lastError = error;
        }

        public void Receive(CANMessageFrame frame)
        {
            OnFrameReceived(frame);
        }

        // -- transmit ------------------------------------------------------------

        // Neither INIT nor SLEEP, and not silent.
        private bool Sends => (base.ReadDoubleWord(Msr) & (MsrInak | MsrSlak)) == 0
                              && (btr & BtrSilm) == 0;

        private void Request(int n)
        {
            var now = NowNs();
            var frame = ReadMailbox(n);
            lock(sync)
            {
                if(pending.Any(r => r.Buffer == n))
                {
                    return;   // the mailbox is not empty: the request stands
                }
                tsr &= ~(MailboxFlags << (8 * n));
                var request = new VhilCanRequest
                {
                    Buffer = n, TimeNs = now, Frame = frame, Generation = generation,
                    Fifo = (base.ReadDoubleWord(Mcr) & McrTxfp) != 0,
                };
                if((btr & BtrSilm) != 0)
                {
                    // Silent: nothing reaches the bus; with LBKM the frame
                    // comes back at once (silent loopback, a self-test).
                    Done(request, true, 0);
                }
                else
                {
                    pending.Add(request);
                }
            }
            if((btr & (BtrSilm | BtrLbkm)) == (BtrSilm | BtrLbkm))
            {
                Loopback(frame);
            }
            UpdateTxIrq();
            Changed();
        }

        // RQCP, and TXOK or the reason it failed; the mailbox is empty again.
        // Under `sync`.
        private void Done(VhilCanRequest request, bool transmitted, uint failure)
        {
            var shift = 8 * request.Buffer;
            tsr |= (Rqcp | (transmitted ? Txok : failure)) << shift;
            if(transmitted)
            {
                this.transmitted++;
            }
        }

        // TXFP 1: only the oldest undecided request is offered (chronological
        // order); TXFP 0: every undecided mailbox. Under `sync`.
        private IEnumerable<VhilCanRequest> Offerable()
        {
            var oldest = pending.Where(r => !r.Committed).OrderBy(r => r.TimeNs).ThenBy(r => order(r)).ToList();
            if(oldest.Count == 0)
            {
                yield break;
            }
            if(oldest[0].Fifo)
            {
                yield return oldest[0];
                yield break;
            }
            foreach(var r in oldest)
            {
                yield return r;
            }
        }

        private int order(VhilCanRequest r) => pending.IndexOf(r);

        private void WriteTsr(uint value)
        {
            lock(sync)
            {
                for(var n = 0; n < 3; n++)
                {
                    var shift = 8 * n;
                    if((value & (Rqcp << shift)) != 0)
                    {
                        tsr &= ~(MailboxFlags << shift);   // RQCP clears TXOK, ALST, TERR too
                    }
                    if((value & (Abrq << shift)) == 0)
                    {
                        continue;
                    }
                    var request = pending.FirstOrDefault(r => r.Buffer == n);
                    if(request == null || request.Committed)
                    {
                        continue;   // empty, or already on the bus
                    }
                    pending.Remove(request);
                    tsr |= Rqcp << shift;
                }
            }
            UpdateTxIrq();
            Changed();
        }

        private uint TransmitStatus()
        {
            lock(sync)
            {
                var value = tsr;
                var empty = new List<int>();
                for(var n = 0; n < 3; n++)
                {
                    if(pending.Any(r => r.Buffer == n))
                    {
                        continue;
                    }
                    value |= 1u << (26 + n);
                    empty.Add(n);
                }
                if(empty.Count > 0)
                {
                    value |= (uint)empty[0] << 24;
                }
                // LOWx: the pending mailbox with the lowest priority.
                var lowest = pending.Count < 2 ? null : pending
                    .OrderByDescending(r => r.Frame, Comparer<CANMessageFrame>.Create(VhilCanFrameBits.Compare))
                    .ThenByDescending(r => r.Buffer).First();
                if(lowest != null)
                {
                    value |= 1u << (29 + lowest.Buffer);
                }
                return value;
            }
        }

        private uint ErrorStatus()
        {
            var value = base.ReadDoubleWord(Esr) & ~0x00FF0077u;
            value |= (uint)Math.Min(tec, 255) << 16;
            value |= lec << 4;
            if(tec >= 96)
            {
                value |= EsrEwgf;
            }
            if(tec >= 128)
            {
                value |= EsrEpvf;
            }
            return value;
        }

        private void UpdateTxIrq()
        {
            bool raise;
            lock(sync)
            {
                raise = (tsr & (Rqcp | Rqcp << 8 | Rqcp << 16)) != 0;
            }
            Connections[TxIrq].Set(raise && (base.ReadDoubleWord(Ier) & IerTmeie) != 0);
        }

        // The frame through this controller's own filters (loopback).
        private void Loopback(CANMessageFrame frame)
        {
            var message = new CANMessage(frame);
            for(var fifo = 0; fifo < 2; fifo++)
            {
                if(FilterCANMessage(fifo, message))
                {
                    ReceiveCANMessage(message);
                }
            }
        }

        private CANMessageFrame ReadMailbox(int n)
        {
            var at = MailboxBase + 0x10 * n;
            var tir = base.ReadDoubleWord(at);
            var dlc = (int)Math.Min(base.ReadDoubleWord(at + 4) & 0xF, 8u);
            var extended = (tir & (1u << 2)) != 0;
            var remote = (tir & (1u << 1)) != 0;
            var id = extended ? tir >> 3 : tir >> 21;
            var data = BitConverter.GetBytes(base.ReadDoubleWord(at + 8))
                .Concat(BitConverter.GetBytes(base.ReadDoubleWord(at + 12))).Take(remote ? 0 : dlc).ToArray();
            return new CANMessageFrame(id, data, extended, remote);
        }

        private static bool Mailbox(long offset, out int n, out int reg)
        {
            n = (int)((offset - MailboxBase) / 0x10);
            reg = (int)((offset - MailboxBase) % 0x10) / 4;
            return offset >= MailboxBase && offset < MailboxBase + 0x30;
        }

        private void Changed()
        {
            bus?.RequestsChanged(this);
        }

        private ulong NowNs()
        {
            if(owner.SystemBus.TryGetCurrentCPU(out var cpu))
            {
                cpu.SyncTime();
            }
            return owner.ElapsedVirtualTime.TimeElapsed.Ticks;
        }

        private readonly IMachine owner;
        private readonly object sync = new object();
        private readonly List<VhilCanRequest> pending = new List<VhilCanRequest>();
        private IVhilCanBus bus;
        private int generation;
        private int tec;
        private uint lec;
        private bool lastError;
        private uint tsr;
        private uint btr = BtrReset;
        private int transmitted;
        private bool warnedSce;

        private const long Mcr = 0x00, Msr = 0x04, Tsr = 0x08, Ier = 0x14, Esr = 0x18, Btr = 0x1C, MailboxBase = 0x180;
        private const uint McrTxfp = 1u << 2, McrNart = 1u << 4, McrReset = 1u << 15;
        private const uint MsrInak = 1u << 0, MsrSlak = 1u << 1;
        private const uint Rqcp = 1u << 0, Txok = 1u << 1, Alst = 1u << 2, Terr = 1u << 3, Abrq = 1u << 7;
        private const uint MailboxFlags = Rqcp | Txok | Alst | Terr;
        private const uint IerTmeie = 1u << 0, ErrorInterrupts = 0x8F00;   // EWGIE, EPVIE, BOFIE, LECIE, ERRIE
        private const uint EsrEwgf = 1u << 0, EsrEpvf = 1u << 1, LecAckError = 3;
        private const uint BtrLbkm = 1u << 30, BtrSilm = 1u << 31;
        // RM0351 CAN_BTR reset value; SJW [25:24], TS2, TS1, BRP, LBKM, SILM.
        private const uint BtrReset = 0x01230000, BtrMask = 0xC37F03FF;
        private const uint Txrq = 1u << 0;
        private const int TxIrq = 0;
    }
}
