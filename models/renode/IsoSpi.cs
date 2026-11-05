//
// isoSPI: an LTC6820 bridge on the host's SPI bus, and LTC6811-1 battery
// monitors daisy-chained behind it. Compiled by Renode at load time
// (`include @models/renode/IsoSpi.cs`). A chain in a platform description:
//
//     isospi: SPI.Ltc6820 @ spi1
//     gpioPortB:
//         9 -> isospi@0                 // chip select, active low
//     cells0: SPI.Ltc6811 @ isospi 0    // nearest the bridge
//     cells1: SPI.Ltc6811 @ isospi 1
//     ...
//
// Each Ltc6811 sees only its isoSPI port A and talks to the next one through
// port B, as on a real chain: it forwards every byte downstream, decodes the
// broadcast command itself, and on a read answers its own 8-byte segment
// before relaying what came back from downstream. Breaking the link after a
// chip (BreakDownstream) silences everything beyond it, like a cut cable.
//
// Protocol facts (framing, PEC15, NTC table, mux decode) are ported from
// IFS_HIL's Pico emulator, minus its known quirks (IFS_HIL#135).
// Conversions take the datasheet's time (Table 5 for MD/ADCOPT): ADCV and
// ADOW sample cell pair k (C<k+1> and C<k+7>) at the middle of the k-th sixth
// of the scan, at the cells' values then, as the chip's one ADC per six
// channels does; a read returns what the scan has latched so far. Each cell
// input has the BMS's filter, R28 100 ohm in series and C23 10 nF to the
// module ground: with ADOW's pull current on, a connected tap's pin moves by
// I R (the same on every pin, so no connected cell reading changes) and an
// open tap's capacitor slews at I / C, 10 mV/us, until it meets a neighbour's
// pin; between ADOW scans it holds, and ADCV reads what it holds. An optional
// per-cell offset on the pull-up result (SetAdowOffset) stands for the
// healthy-pack ADOW offset measured on the car's modules (AMS #512: the top
// cell of an upper LTC reads ~127 mV low under pull-up), cause unmodelled.
//
// Cell source: what each chip converts (SetCell / SetAllCells, SetTemperature
// / SetAllTemperatures, SetAuxRaw) is the battery's state, not the chip's.
// Today tests set it through the monitor; the Simscape battery stacks (M9)
// will drive the same setters every co-simulation step, as a plant on the
// system's port (docs/cosim.md "Cell source"). Nothing else writes it, except
// Reset() restoring the defaults on the AMS's reset: a plant re-applies its
// values on its next step.
//
// The battery plant (M9 prep, #318; docs/cosim.md "Cell source"): a plant
// that drives the chain (SetPlantCells, SetPlantTemperatures on the bridge)
// owns the cells and NTCs from then on, so an AMS reset keeps them: they are
// the battery's state, not the chip's. The chips account each cell's balance
// switch (DCC) on-time in virtual time, which the plant takes (TakeBleed) and
// turns into bleed current; with BleedTrigger armed, a chip's DCC going from
// none to some ends `emulation RunForUntilTrigger` at the next sync point
// (VhilRunner.cs), so a plant hears that balancing started without polling.
// Nothing here runs unless a plant calls it: a run without one is unchanged.
//
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Antmicro.Renode.Core;
using Antmicro.Renode.Core.Structure;
using Antmicro.Renode.Logging;

namespace Antmicro.Renode.Peripherals.SPI
{
    // One device on an isoSPI link, seen from its upstream port.
    public interface IIsoSpiNode
    {
        void Wake();
        void BeginTransaction();
        // One byte in from upstream; the byte this node drives back upstream.
        byte Exchange(byte mosi);
        void EndTransaction();
        IIsoSpiNode Downstream { get; set; }
    }

    // LTC6820: SPI slave on the host side, isoSPI master on the chain side.
    public class Ltc6820 : SimpleContainer<Ltc6811>, ISPIPeripheral, IGPIOReceiver
    {
        public Ltc6820(IMachine machine) : base(machine)
        {
            clockMachine = machine;
        }

        public override void Register(Ltc6811 peripheral, NumberRegistrationPoint<int> registrationPoint)
        {
            base.Register(peripheral, registrationPoint);
            Relink();
        }

        public override void Unregister(Ltc6811 peripheral)
        {
            base.Unregister(peripheral);
            Relink();
        }

        public override void Reset()
        {
            frameOpen = false;
            bytesInFrame = 0;
            wakes = 0;
        }

        public byte Transmit(byte data)
        {
            if(!frameOpen)
            {
                // No chip select wired: treat the byte as its own frame.
                OpenFrame();
            }
            bytesInFrame++;
            return First?.Exchange(data) ?? (byte)0xFF;
        }

        public void FinishTransmission()
        {
            // Not a frame boundary: STM32H7_SPI calls this at the end of every
            // HAL transfer. The frame is the chip-select window (OnGPIO).
        }

        // Chip select, active low.
        public void OnGPIO(int number, bool value)
        {
            if(number != 0)
            {
                return;
            }
            if(!value)
            {
                OpenFrame();
            }
            else if(frameOpen)
            {
                frameOpen = false;
                if(bytesInFrame == 0)
                {
                    // CS pulse with no clocks: wake the isoSPI port and chain.
                    wakes++;
                    First?.Wake();
                }
                else
                {
                    First?.EndTransaction();
                }
            }
        }

        // -- chain-wide test API (per-chip API lives on each Ltc6811) ----------

        public void SetAllCells(int millivolts)
        {
            foreach(var ic in Chain)
            {
                ic.SetAllCells(millivolts);
            }
        }

        // The sum of the cells the chain carries, mV: the first counts[i % n]
        // inputs of chip i, e.g. "9,10" for the AMS's module pairs (9 cells
        // on the first chip of each, 10 on the second). The pack voltage a
        // tractive-system plant charges the DC link towards (vhil/plant_ts.py).
        public long CellSum(string counts)
        {
            var n = counts.Split(',').Select(c => int.Parse(c.Trim())).ToArray();
            long sum = 0;
            var i = 0;
            foreach(var ic in Chain)
            {
                var k = n[i++ % n.Length];
                for(var c = 0; c < k; c++)
                {
                    sum += ic.CellMillivolts(c);
                }
            }
            return sum;
        }

        public void SetAllTemperatures(int deciCelsius)
        {
            foreach(var ic in Chain)
            {
                ic.SetAllTemperatures(deciCelsius);
            }
        }

        // Bit i set -> chip i answers 0xFF (relaying downstream data intact),
        // as IFS_HIL's Pico STOP_REPLY.
        public void StopReply(uint mask)
        {
            var i = 0;
            foreach(var ic in Chain)
            {
                ic.Respond = ((mask >> i++) & 1) == 0;
            }
        }

        public void ResumeAll()
        {
            foreach(var ic in Chain)
            {
                ic.Respond = true;
                ic.BreakDownstream = false;
            }
        }

        public string Stats()
        {
            var sb = new StringBuilder();
            sb.AppendLine($"chain={ChainLength} wakes={wakes}");
            var i = 0;
            foreach(var ic in Chain)
            {
                sb.AppendLine($"[{i++}] {ic.Summary()}");
            }
            var totals = new SortedDictionary<ushort, int>();
            foreach(var ic in Chain.Take(1))
            {
                foreach(var kv in ic.CommandCounts)
                {
                    totals[kv.Key] = kv.Value;
                }
            }
            foreach(var kv in totals)
            {
                sb.AppendLine($"0x{kv.Key:X3} {Ltc6811.CommandName(kv.Key)} x{kv.Value}");
            }
            return sb.ToString();
        }

        // -- the battery plant's port (M9 prep, #318) -------------------------

        // Every chip's 12 cell inputs, chip by chip from the bridge, in
        // 100 uV units (the LTC6811's cell register LSB): one call per
        // exchange, however many cells moved.
        public void SetPlantCells(string raw100uV)
        {
            var v = raw100uV.Split(',');
            var chain = Chain.ToList();
            if(v.Length != chain.Count * 12)
            {
                throw new ArgumentException($"{v.Length} values for {chain.Count} chips x 12 inputs");
            }
            for(var i = 0; i < chain.Count; i++)
            {
                chain[i].SetPlantCells(v, i * 12);
            }
        }

        // Every chip's 32 ADG731 channels, tenths of a degree C, chip by chip;
        // an empty entry leaves that channel as it is.
        public void SetPlantTemperatures(string deciCelsius)
        {
            var v = deciCelsius.Split(',');
            var chain = Chain.ToList();
            if(v.Length != chain.Count * 32)
            {
                throw new ArgumentException($"{v.Length} values for {chain.Count} chips x 32 channels");
            }
            for(var i = 0; i < chain.Count; i++)
            {
                chain[i].SetPlantTemperatures(v, i * 32);
            }
        }

        // The balance switches since the last call: "<now us>" then one line
        // per chip, "<DCC bits now>:<on-time of DCC1..12 in us>", and the
        // accounts start again from zero.
        public string TakeBleed()
        {
            var sb = new StringBuilder();
            sb.Append(Now());
            foreach(var ic in Chain)
            {
                sb.Append('\n').Append(ic.TakeBleed());
            }
            return sb.ToString();
        }

        // Armed: the next chip whose DCC goes from none to some raises the
        // run's trigger, once (the plant re-arms it).
        public bool BleedTrigger { get; set; }

        public int ChainLength => ChildCollection.Count;

        private ulong Now()
        {
            return (ulong)clockMachine.ElapsedVirtualTime.TimeElapsed.TotalMicroseconds;
        }

        // Virtual time in us to within the instruction: a conversion's
        // channels are sampled at their own instants (Ltc6811.Settle), and a
        // sync quantum (0.5 ms on ecu-ams) is a fifth of the 7 kHz cell scan.
        private double PreciseNow()
        {
            if(clockMachine.SystemBus.TryGetCurrentCPU(out var cpu))
            {
                cpu.SyncTime();
            }
            return clockMachine.ElapsedVirtualTime.TimeElapsed.TotalMicroseconds;
        }

        // Armed with an opcode (e.g. 0x328, ADOW pull-down at 7 kHz): the
        // next time the chip nearest the bridge decodes it, the run's trigger
        // goes off once (VhilRunner.cs), so a test can place a plant
        // transient between two conversions. -1: disarmed.
        public int CommandTrigger { get; set; } = -1;

        private void OnCommand(ushort opcode)
        {
            if(CommandTrigger == opcode)
            {
                CommandTrigger = -1;
                RunTrigger()?.SetValue(null, true);
            }
        }

        private void OnDischargeStarted()
        {
            if(BleedTrigger)
            {
                BleedTrigger = false;
                RunTrigger()?.SetValue(null, true);
            }
        }

        // VhilRunner.Triggered (VhilRunner.cs), found at run time: the smoke
        // suites and the wall-clock bench compile this model without the
        // runner, and there nothing arms the trigger.
        private static System.Reflection.FieldInfo RunTrigger()
        {
            if(runTrigger == null)
            {
                runTrigger = AppDomain.CurrentDomain.GetAssemblies()
                    .Select(a => a.GetType("Antmicro.Renode.Testing.VhilRunner", false))
                    .FirstOrDefault(t => t != null)?.GetField("Triggered");
            }
            return runTrigger;
        }

        private static System.Reflection.FieldInfo runTrigger;

        private IEnumerable<Ltc6811> Chain => ChildCollection.OrderBy(kv => kv.Key).Select(kv => kv.Value);

        // The IC nearest the bridge, kept by Relink: looked up on every byte.
        private Ltc6811 First => first;

        private void Relink()
        {
            var chain = Chain.ToList();
            first = chain.Count > 0 ? chain[0] : null;
            for(var i = 0; i < chain.Count; i++)
            {
                chain[i].Position = i;
                chain[i].Downstream = i + 1 < chain.Count ? chain[i + 1] : null;
                chain[i].Clock = Now;
                chain[i].DischargeStarted = OnDischargeStarted;
                chain[i].PreciseClock = PreciseNow;
                chain[i].CommandSeen = i == 0 ? OnCommand : (Action<ushort>)null;
            }
        }

        private void OpenFrame()
        {
            frameOpen = true;
            bytesInFrame = 0;
            First?.BeginTransaction();
        }

        private readonly IMachine clockMachine;
        private Ltc6811 first;
        private bool frameOpen;
        private int bytesInFrame;
        private int wakes;
    }

    // LTC6811-1 on an isoSPI daisy chain.
    public class Ltc6811 : IPeripheral, IIsoSpiNode
    {
        public Ltc6811(bool writeFarthestFirst = false)
        {
            // The AMS firmware writes segment i to the IC i places from the
            // bridge. Real LTC6811-1 silicon shifts write data the other way,
            // so segment 0 lands on the farthest IC. Off = what the firmware
            // intends (AMS docs/BMS_LTC6811.md); on = silicon.
            this.writeFarthestFirst = writeFarthestFirst;
            Reset();
        }

        public void Reset()
        {
            if(DischargeBits != 0)
            {
                AccrueBleed();             // the switches open with the reset
            }
            Array.Copy(new byte[] { 0xF8, 0, 0, 0, 0, 0 }, config, 6);   // CFGR power-on
            Array.Clear(comm, 0, 6);
            for(var c = 0; c < CellsPerIc; c++)
            {
                if(!PlantHeld)
                {
                    cells[c] = ToLtc(DefaultCellMillivolts);
                }
                cellResults[c] = 0xFFFF;   // cleared result registers read 0xFFFF
            }
            for(var ch = 0; ch < MuxChannels && !PlantHeld; ch++)
            {
                aux[ch] = NtcAux(DefaultDeciCelsius);
            }
            gpio1Result = 0xFFFF;
            muxChannel = 0;
            Respond = true;
            BreakDownstream = false;
            CorruptPec = false;
            corruptNext = 0;
            corrupting = false;
            CorruptConfigWrites = false;
            corruptConfigNext = 0;
            commandCounts.Clear();
            convKind = ConvNone;
            convPair = Pairs;
            history.Clear();
            badCommandPec = badWritePec = wakes = adcvWhileDischarging = adowWhileDischarging = 0;
            rx.Clear();
            relayed.Clear();
            reply = null;
            command = null;
        }

        public IIsoSpiNode Downstream { get; set; }

        // Hops from the bridge (0 = nearest); set when the chain is linked.
        public int Position { get; set; }

        // -- isoSPI port A ----------------------------------------------------

        public void Wake()
        {
            wakes++;
            if(!BreakDownstream)
            {
                Downstream?.Wake();
            }
        }

        public void BeginTransaction()
        {
            rx.Clear();
            relayed.Clear();
            reply = null;
            command = null;
            corrupting = false;
            if(!BreakDownstream)
            {
                Downstream?.BeginTransaction();
            }
        }

        public byte Exchange(byte mosi)
        {
            var index = rx.Count;
            rx.Add(mosi);
            // Port B: everything goes on downstream; collect what comes back.
            var fromDownstream = (byte)0xFF;
            if(!BreakDownstream && Downstream != null)
            {
                fromDownstream = Downstream.Exchange(mosi);
            }
            if(index == 3)
            {
                DecodeCommand();
            }
            if(index < 4)
            {
                return 0xFF;
            }
            var p = index - 4;
            relayed.Add(fromDownstream);
            if(reply == null)
            {
                return 0xFF;
            }
            // Own segment first, then downstream's stream delayed by one segment.
            if(p < 8)
            {
                if(!Respond)
                {
                    return 0xFF;
                }
                if(p == 7 && (CorruptPec || corruptNext > 0))
                {
                    corrupting = true;
                    return (byte)(reply[p] ^ 0x01);   // one PEC bit flipped
                }
                return reply[p];
            }
            return relayed[p - 8];
        }

        public void EndTransaction()
        {
            if(!BreakDownstream)
            {
                Downstream?.EndTransaction();
            }
            if(corrupting && corruptNext > 0)
            {
                corruptNext--;
            }
            if(command == null)
            {
                return;
            }
            switch(command.Value)
            {
                case WRCFGA:
                    if(CorruptConfigWrites || corruptConfigNext > 0)
                    {
                        // The write's data PEC arrives wrong: the chip
                        // discards the data, CFGR (DCC included) unchanged.
                        corruptConfigNext = Math.Max(0, corruptConfigNext - 1);
                        badWritePec++;
                        break;
                    }
                    var before = DischargeBits;
                    if(before != 0)
                    {
                        AccrueBleed();
                    }
                    TakeSegment(config);
                    if(before == 0 && DischargeBits != 0)
                    {
                        bleedSince = Clock?.Invoke() ?? 0;
                        DischargeStarted?.Invoke();
                    }
                    break;
                case WRCOMM:
                    TakeSegment(comm);
                    break;
                case STCOMM:
                    LatchMuxFromComm();
                    break;
            }
        }

        // -- per-chip test API (monitor: `sysbus.spi1.isospi.cells3 SetCell 2 3600`)

        public bool Respond { get; set; }

        // Cut the isoSPI link to the next chip: nothing beyond it hears
        // commands or answers.
        public bool BreakDownstream { get; set; }

        // Flip a bit of this chip's reply PEC, so the host rejects its segment
        // while every other chip's data stays clean: every read while set, or
        // just the next n reads (EMI that clears on a re-read).
        public bool CorruptPec { get; set; }

        public void CorruptNextReplies(int n)
        {
            corruptNext = Math.Max(0, n);
        }

        // A WRCFGA that does not take on this chip: its write data arrives
        // with a bad PEC (noise on this chip's isoSPI port A), so the chip
        // discards it and keeps its configuration, DCC bits included, as the
        // LTC6811 does with any write whose data PEC does not match (its
        // datasheet's PEC rule for write commands; TakeSegment below). The
        // host sees nothing: a write has no reply. Every WRCFGA while set,
        // or just the next n.
        public bool CorruptConfigWrites { get; set; }

        public void CorruptNextConfigWrites(int n)
        {
            corruptConfigNext = Math.Max(0, n);
        }

        // Writes this chip discarded for a bad data PEC, injected or not.
        public int RejectedWrites => badWritePec;

        public void SetCell(int cell, int millivolts)
        {
            CheckRange(cell, CellsPerIc, "cell");
            Settle(PreciseTime());
            cells[cell] = ToLtc(millivolts);
        }

        public void SetAllCells(int millivolts)
        {
            Settle(PreciseTime());
            for(var c = 0; c < CellsPerIc; c++)
            {
                cells[c] = ToLtc(millivolts);
            }
        }

        // Open (or reconnect) cell-sense conductor C<conductor>, 0..12: C0 is
        // the bottom of cell 1, C<n> the top of cell n. A broken wire is on
        // the battery module, so it survives the AMS's resets.
        public void OpenWire(int conductor, bool open)
        {
            CheckRange(conductor, CellsPerIc + 1, "conductor");
            var now = PreciseTime();
            Settle(now);
            if(open && !openWires[conductor])
            {
                // The capacitor starts where the wire left it.
                tapV[conductor] = Nodes()[conductor];
                tapAt = Math.Max(tapAt, now);
            }
            openWires[conductor] = open;
        }

        // Added to cell<cell>'s ADOW pull-up result, mV (0 = none): the
        // healthy-pack offset (AMS #512: -127 mV on the top cell of an upper
        // LTC, +48 mV on cell 1), a measurement whose cause is not modelled.
        public void SetAdowOffset(int cell, int millivolts)
        {
            CheckRange(cell, CellsPerIc, "cell");
            adowOffset[cell] = millivolts * 10;
        }

        // The last conversions this chip completed (or that a new command cut
        // short), oldest first, one per line:
        // "<ADCV|ADOWUP|ADOWDOWN>,<start us>,<cell1>,...,<cell12>" (100 uV).
        public string ConversionHistory()
        {
            Settle(PreciseTime());
            return string.Join("\n", history);
        }

        public int CellMillivolts(int cell)
        {
            CheckRange(cell, CellsPerIc, "cell");
            return cells[cell] / 10;
        }

        // Temperature behind one ADG731 mux channel, tenths of a degree C.
        public void SetTemperature(int muxChannel, int deciCelsius)
        {
            CheckRange(muxChannel, MuxChannels, "muxChannel");
            aux[muxChannel] = NtcAux(deciCelsius);
        }

        public void SetAllTemperatures(int deciCelsius)
        {
            var v = NtcAux(deciCelsius);
            for(var ch = 0; ch < MuxChannels; ch++)
            {
                aux[ch] = v;
            }
        }

        // Raw GPIO1 voltage behind one mux channel, 100 uV units (0 = shorted
        // sensor; >= 28000 reads as open to the AMS).
        public void SetAuxRaw(int muxChannel, int raw100uV)
        {
            CheckRange(muxChannel, MuxChannels, "muxChannel");
            aux[muxChannel] = (ushort)Math.Max(0, Math.Min(0xFFFF, raw100uV));
        }

        public int MuxChannel => muxChannel;

        // The ADG731 address in COMM, what the next STCOMM latches (-1: no
        // START in COMM, so STCOMM leaves the mux alone).
        public int CommMuxAddress =>
            (comm[0] >> 4) == 0x8 ? (((comm[0] & 0x0F) << 4) | (comm[1] >> 4)) & 0x1F : -1;

        // DCC (discharge) bits last written, cells 1..12.
        public int DischargeBits => config[4] | ((config[5] & 0x0F) << 8);

        // -- the battery plant's port (through the bridge, M9 prep #318) ---------

        // Virtual time in us (the bridge's machine), and what to call when
        // DCC goes from none to some; set by the bridge when it links the chain.
        public Func<ulong> Clock { get; set; }
        public Action DischargeStarted { get; set; }

        // Virtual time in us, to the instruction (conversion timing), and
        // what to tell of each command decoded (the bridge's CommandTrigger;
        // set on the chip nearest the bridge only).
        public Func<double> PreciseClock { get; set; }
        public Action<ushort> CommandSeen { get; set; }

        // A plant drives this chip's cells and NTCs: an AMS reset keeps them.
        public bool PlantHeld { get; private set; }

        public void SetPlantCells(string[] raw100uV, int offset)
        {
            Settle(PreciseTime());
            for(var c = 0; c < CellsPerIc; c++)
            {
                cells[c] = (ushort)Math.Max(0, Math.Min(0xFFFF, int.Parse(raw100uV[offset + c])));
            }
            PlantHeld = true;
        }

        public void SetPlantTemperatures(string[] deciCelsius, int offset)
        {
            for(var ch = 0; ch < MuxChannels; ch++)
            {
                var s = deciCelsius[offset + ch];
                if(s.Length > 0)
                {
                    aux[ch] = NtcAux(int.Parse(s));
                }
            }
            PlantHeld = true;
        }

        // "<DCC bits now>:<us on of DCC1>,...,<DCC12>" since the last call.
        public string TakeBleed()
        {
            if(DischargeBits != 0)
            {
                AccrueBleed();
            }
            var line = $"{DischargeBits}:{string.Join(",", bleedUs)}";
            Array.Clear(bleedUs, 0, CellsPerIc);
            return line;
        }

        private void AccrueBleed()
        {
            if(Clock == null)
            {
                return;
            }
            var now = Clock();
            var bits = DischargeBits;
            if(bits != 0 && now > bleedSince)
            {
                for(var c = 0; c < CellsPerIc; c++)
                {
                    if((bits & (1 << c)) != 0)
                    {
                        bleedUs[c] += now - bleedSince;
                    }
                }
            }
            bleedSince = now;
        }

        // Cell conversions started with a discharge switch on: the host is
        // meant to quiesce balancing first, or the reading includes the
        // balance current's IR drop.
        public int AdcvWhileDischarging => adcvWhileDischarging;

        // Open-wire conversions (ADOW) started with a discharge switch on:
        // the balance current shifts the pull-up/down delta the same way.
        public int AdowWhileDischarging => adowWhileDischarging;

        public int CommandCount(int opcode)
        {
            return commandCounts.TryGetValue((ushort)opcode, out var n) ? n : 0;
        }

        public IReadOnlyDictionary<ushort, int> CommandCounts => commandCounts;

        public string Summary()
        {
            return $"respond={Respond} breakDownstream={BreakDownstream} wakes={wakes} " +
                   $"badCommandPec={badCommandPec} badWritePec={badWritePec} " +
                   $"mux={muxChannel} dcc=0x{DischargeBits:X3}";
        }

        public static string CommandName(ushort op)
        {
            switch(op)
            {
                case WRCFGA: return "WRCFGA";
                case RDCFGA: return "RDCFGA";
                case RDCVA: return "RDCVA";
                case RDCVB: return "RDCVB";
                case RDCVC: return "RDCVC";
                case RDCVD: return "RDCVD";
                case RDAUXA: return "RDAUXA";
                case RDAUXB: return "RDAUXB";
                case WRCOMM: return "WRCOMM";
                case RDCOMM: return "RDCOMM";
                case STCOMM: return "STCOMM";
            }
            if(IsAdcv(op)) return "ADCV";
            if(IsAdow(op)) return "ADOW";
            if(IsAdax(op)) return "ADAX";
            return "?";
        }

        // -- command handling -------------------------------------------------

        private void DecodeCommand()
        {
            var opcode = (ushort)(((rx[0] & 0x07) << 8) | rx[1]);
            var pec = (ushort)((rx[2] << 8) | rx[3]);
            if(Pec15(rx, 0, 2) != pec)
            {
                badCommandPec++;
                return;   // a real LTC6811 ignores a command with a bad PEC
            }
            command = opcode;
            commandCounts[opcode] = CommandCount(opcode) + 1;
            CommandSeen?.Invoke(opcode);

            if(IsAdcv(opcode))
            {
                if(DischargeBits != 0)
                {
                    adcvWhileDischarging++;   // the conversion sees the balance load
                }
                StartConversion(ConvAdcv, opcode);
                return;
            }
            if(IsAdow(opcode))
            {
                if(DischargeBits != 0)
                {
                    adowWhileDischarging++;
                }
                StartConversion((opcode & AdowPup) != 0 ? ConvAdowUp : ConvAdowDown, opcode);
                return;
            }
            if(IsAdax(opcode))
            {
                gpio1Result = aux[muxChannel];
                return;
            }
            if(opcode == RDCVA || opcode == RDCVB || opcode == RDCVC || opcode == RDCVD)
            {
                Settle(PreciseTime());
            }
            switch(opcode)
            {
                case RDCFGA: reply = Segment(config); break;
                case RDCVA: reply = Segment(Words(cellResults, 0)); break;
                case RDCVB: reply = Segment(Words(cellResults, 3)); break;
                case RDCVC: reply = Segment(Words(cellResults, 6)); break;
                case RDCVD: reply = Segment(Words(cellResults, 9)); break;
                case RDAUXA: reply = Segment(Words(new[] { gpio1Result, (ushort)0, (ushort)0 }, 0)); break;
                case RDAUXB: reply = Segment(Words(new[] { (ushort)0, (ushort)0, Ref2 }, 0)); break;
                case RDCOMM: reply = Segment(comm); break;
            }
        }

        // This chip's write segment. Every chip sees the whole stream; it keeps
        // segment Position (nearest-first, as the AMS firmware intends) or
        // segment <chips downstream> (farthest-first, as silicon shifts it).
        private void TakeSegment(byte[] register)
        {
            var segment = writeFarthestFirst ? DownstreamDepth() : Position;
            var start = 4 + segment * 8;
            if(rx.Count < start + 8)
            {
                return;
            }
            var data = rx.GetRange(start, 6);
            var pec = (ushort)((rx[start + 6] << 8) | rx[start + 7]);
            if(Pec15(data, 0, 6) != pec)
            {
                badWritePec++;
                return;
            }
            data.CopyTo(register);
        }

        private int DownstreamDepth()
        {
            var depth = 0;
            for(var node = Downstream; node != null; node = node.Downstream)
            {
                depth++;
            }
            return depth;
        }

        // The ADG731 address shifted out through COMM: a START (ICOM 0b1000)
        // then data, D7..D4 in COMM0 and D3..D0 in COMM1. The ADG731 takes the
        // low 5 bits (EN = CS = 0). A no-op COMM (ICOM 0xF) leaves it alone.
        private void LatchMuxFromComm()
        {
            var address = CommMuxAddress;
            if(address >= 0)
            {
                muxChannel = address;
            }
        }

        private static byte[] Segment(byte[] data6)
        {
            var pec = Pec15(data6, 0, 6);
            return data6.Concat(new[] { (byte)(pec >> 8), (byte)pec }).ToArray();
        }

        // -- conversions (ADCV, ADOW) --------------------------------------------

        private double PreciseTime()
        {
            return PreciseClock?.Invoke() ?? 0;
        }

        // A conversion command: whatever scan is running stops where it is
        // (its channels not yet sampled keep their old results), and a new
        // one starts now.
        private void StartConversion(int kind, ushort opcode)
        {
            var now = PreciseTime();
            Settle(now);
            if(convKind != ConvNone)
            {
                AdvanceTaps(now);
                Record();
            }
            convKind = kind;
            convStart = now;
            convLength = PreciseClock == null ? 0 : ScanMicroseconds((opcode >> 7) & 3, (config[0] & 1) != 0);
            convPair = 0;
        }

        // Latch every channel pair whose sample instant is not after `now`,
        // at the cells as they are (callers settle before the cells change).
        private void Settle(double now)
        {
            if(convKind == ConvNone)
            {
                return;
            }
            for(; convPair < Pairs; convPair++)
            {
                var t = convStart + (convPair + 0.5) * convLength / Pairs;
                if(t > now)
                {
                    break;
                }
                var level = Levels(t);
                foreach(var c in new[] { convPair, convPair + Pairs })
                {
                    var v = level[c + 1] - level[c] + (convKind == ConvAdowUp ? adowOffset[c] : 0);
                    cellResults[c] = (ushort)Math.Max(0, Math.Min(0xFFFF, v));
                }
            }
            if(convPair == Pairs && now >= convStart + convLength)
            {
                AdvanceTaps(convStart + convLength);
                Record();
                convKind = ConvNone;
            }
        }

        private void Record()
        {
            var name = convKind == ConvAdcv ? "ADCV" : convKind == ConvAdowUp ? "ADOWUP" : "ADOWDOWN";
            history.Add($"{name},{convStart:F1},{string.Join(",", cellResults)}");
            if(history.Count > HistoryLength)
            {
                history.RemoveAt(0);
            }
        }

        // C0..C12 battery-side node potentials, 100 uV, C0 = 0.
        private int[] Nodes()
        {
            var node = new int[CellsPerIc + 1];
            for(var n = 1; n <= CellsPerIc; n++)
            {
                node[n] = node[n - 1] + cells[n - 1];
            }
            return node;
        }

        // ADOW's pull current on the pins now: +1 up, -1 down, 0 none.
        private int PullAt(double t)
        {
            if(convKind != ConvAdowUp && convKind != ConvAdowDown)
            {
                return 0;
            }
            if(t < convStart || t > convStart + convLength)
            {
                return 0;
            }
            return convKind == ConvAdowUp ? 1 : -1;
        }

        // The C pins' potentials at t (100 uV): a connected pin is its node,
        // moved by the pull current through R28; an open one is its
        // capacitor, advanced to t.
        private int[] Levels(double t)
        {
            AdvanceTaps(t);
            var node = Nodes();
            var shift = PullAt(t) * PullIrDrop;
            var level = new int[CellsPerIc + 1];
            for(var n = 0; n <= CellsPerIc; n++)
            {
                level[n] = openWires[n] ? (int)Math.Round(tapV[n]) : node[n] + shift;
            }
            return level;
        }

        // Each open tap's capacitor from tapAt to t: charged at I / C while
        // the current scan pulls, held otherwise, never past a neighbour's pin
        // (its own end of the chip for C0 and C12): an open conductor
        // saturates against the next one, the existing simplification, exact
        // at the endpoints where silicon may read a few mV.
        private void AdvanceTaps(double t)
        {
            if(t <= tapAt)
            {
                return;
            }
            var node = Nodes();
            var end = convStart + convLength;
            var on = convKind == ConvAdowUp || convKind == ConvAdowDown;
            var overlap = on ? Math.Max(0, Math.Min(t, end) - Math.Max(tapAt, convStart)) : 0;
            var dir = convKind == ConvAdowUp ? 1 : -1;
            var shift = on && t <= end ? dir * PullIrDrop : 0;
            Func<int, int> pin = m => openWires[m] ? node[m] : node[m] + shift;
            for(var n = 0; n <= CellsPerIc; n++)
            {
                if(!openWires[n])
                {
                    continue;
                }
                var lo = n > 0 ? pin(n - 1) : 0;
                var hi = n < CellsPerIc ? pin(n + 1) : node[CellsPerIc];
                var v = tapV[n] + dir * SlewPer100uVPerUs * overlap;
                tapV[n] = Math.Max(Math.Min(lo, hi), Math.Min(Math.Max(lo, hi), v));
            }
            tapAt = t;
        }

        // All-cell scan time, us (LTC6811 datasheet Table 5, ADCV / ADOW, all
        // 12 cells): MD 01/10/11/00 = 27 kHz / 7 kHz / 26 Hz / 422 Hz with
        // ADCOPT 0, 14 kHz / 3 kHz / 2 kHz / 1 kHz with ADCOPT 1 (the 14 kHz
        // and 1 kHz times unverified: no firmware here sets ADCOPT). The AMS
        // converts at 7 kHz (IFS08-CE-AMS ams_config.hpp:997, AdcMode = 2).
        private static double ScanMicroseconds(int md, bool adcopt)
        {
            switch(md)
            {
                case 1: return adcopt ? 1288 : 1113;
                case 2: return adcopt ? 3033 : 2335;
                case 3: return adcopt ? 4407 : 201317;
                default: return adcopt ? 7140 : 12807;
            }
        }

        private const int ConvNone = 0, ConvAdcv = 1, ConvAdowUp = 2, ConvAdowDown = 3;
        private const int Pairs = 6;                   // one ADC, C1/C7 ... C6/C12
        private const int HistoryLength = 16;
        // ADOW pull current 100 uA (datasheet "Open Wire Check"), BMS filter
        // R28 100 ohm and C23 10 nF per cell input (BMS_LITE schematic).
        private const int PullIrDrop = 100;            // 100 uA x 100 ohm = 10 mV, 100 uV units
        private const double SlewPer100uVPerUs = 100;  // 100 uA / 10 nF = 10 mV/us

        // Fixed bits per the LTC6811 command table; MD, DCP/PUP and CH/CHG
        // vary (AMS: ADCV 0x360, ADOW 0x368/0x328, ADAX 0x561).
        private static bool IsAdcv(ushort op) => (op & 0x668) == 0x260;
        private static bool IsAdow(ushort op) => (op & 0x628) == 0x228;
        private const ushort AdowPup = 0x40;          // ADOW bit 6 (AMS 0x368 up, 0x328 down)
        private static bool IsAdax(ushort op) => (op & 0x678) == 0x460;

        private static byte[] Words(ushort[] values, int first)
        {
            var b = new byte[6];
            for(var k = 0; k < 3; k++)
            {
                var v = first + k < values.Length ? values[first + k] : (ushort)0;
                b[2 * k] = (byte)v;              // little-endian, 100 uV LSB
                b[2 * k + 1] = (byte)(v >> 8);
            }
            return b;
        }

        private static ushort ToLtc(int millivolts)
        {
            return (ushort)Math.Max(0, Math.Min(0xFFFF, millivolts * 10));
        }

        // GPIO1 voltage of a 10k B3950 NTC behind a 6.8k pull-up to VREF2,
        // linearly interpolated, 100 uV units: the table the AMS decodes with.
        private static ushort NtcAux(int deciCelsius)
        {
            var t = Math.Max(NtcMinC * 10, Math.Min(NtcMaxC * 10, deciCelsius)) - NtcMinC * 10;
            var index = t / 10;
            if(index >= NtcAux100uV.Length - 1)
            {
                return NtcAux100uV[NtcAux100uV.Length - 1];
            }
            var a = NtcAux100uV[index];
            var b = NtcAux100uV[index + 1];
            return (ushort)(a + (b - a) * (t % 10) / 10);
        }

        // PEC15: polynomial 0x4599, seed 16, result shifted left by one.
        private static ushort Pec15(IList<byte> data, int offset, int count)
        {
            var rem = 16;
            for(var i = 0; i < count; i++)
            {
                var address = ((rem >> 7) ^ data[offset + i]) & 0xFF;
                rem = ((rem << 8) ^ PecTable[address]) & 0xFFFF;
            }
            return (ushort)((rem << 1) & 0xFFFF);
        }

        private static int[] BuildPecTable()
        {
            var table = new int[256];
            for(var i = 0; i < 256; i++)
            {
                var rem = i << 7;
                for(var bit = 8; bit > 0; bit--)
                {
                    rem = (rem & 0x4000) != 0 ? ((rem << 1) ^ 0x4599) : (rem << 1);
                }
                table[i] = rem & 0xFFFF;
            }
            return table;
        }

        private static void CheckRange(int value, int limit, string what)
        {
            if(value < 0 || value >= limit)
            {
                throw new ArgumentException($"{what} must be 0..{limit - 1}");
            }
        }

        private const int CellsPerIc = 12;
        private const int MuxChannels = 32;
        private const int DefaultCellMillivolts = 3700;
        private const int DefaultDeciCelsius = 250;
        private const ushort Ref2 = 30000;            // 3.000 V
        private const int NtcMinC = -55;
        private const int NtcMaxC = 125;

        private const ushort WRCFGA = 0x001;
        private const ushort RDCFGA = 0x002;
        private const ushort RDCVA = 0x004;
        private const ushort RDCVB = 0x006;
        private const ushort RDCVC = 0x008;
        private const ushort RDCVD = 0x00A;
        private const ushort RDAUXA = 0x00C;
        private const ushort RDAUXB = 0x00E;
        private const ushort WRCOMM = 0x721;
        private const ushort RDCOMM = 0x722;
        private const ushort STCOMM = 0x723;

        private static readonly int[] PecTable = BuildPecTable();

        // index = temp_C + 55; value = V_aux in 100 uV units (VREF2 = 3000 mV,
        // 6.8k pull-up, Fenghua CMFB103F3950 R-T table).
        private static readonly ushort[] NtcAux100uV = {
            29654, 29637, 29618, 29598, 29577, 29554, 29531, 29506, 29479, 29451,
            29422, 29391, 29358, 29323, 29286, 29247, 29207, 29164, 29118, 29071,
            29021, 28968, 28912, 28854, 28793, 28728, 28661, 28590, 28515, 28438,
            28356, 28270, 28181, 28088, 27990, 27888, 27781, 27670, 27554, 27433,
            27307, 27177, 27040, 26899, 26752, 26600, 26442, 26278, 26109, 25934,
            25753, 25566, 25373, 25174, 24969, 24758, 24541, 24318, 24090, 23855,
            23615, 23369, 23118, 22861, 22599, 22326, 22060, 21783, 21501, 21216,
            20926, 20632, 20335, 20034, 19730, 19423, 19114, 18802, 18488, 18173,
            17857, 17539, 17221, 16902, 16583, 16264, 15947, 15630, 15313, 14998,
            14685, 14374, 14065, 13758, 13454, 13153, 12854, 12560, 12267, 11980,
            11696, 11416, 11139, 10868, 10601, 10362, 10078,  9824,  9575,  9329,
             9090,  8856,  8625,  8399,  8177,  7963,  7751,  7543,  7343,  7145,
             6952,  6765,  6581,  6403,  6229,  6059,  5895,  5732,  5575,  5422,
             5273,  5128,  4988,  4852,  4718,  4589,  4462,  4340,  4220,  4105,
             3993,  3883,  3776,  3671,  3572,  3475,  3379,  3288,  3197,  3112,
             3027,  2944,  2865,  2789,  2713,  2643,  2570,  2503,  2436,  2373,
             2309,  2249,  2188,  2131,  2074,  2020,  1966,  1916,  1866,  1819,
             1773,  1726,  1682,  1639,  1600,  1560,  1520,  1480,  1445,  1409,
             1372,
        };

        private readonly bool writeFarthestFirst;
        private readonly byte[] config = new byte[6];
        private readonly byte[] comm = new byte[6];
        private readonly ushort[] cells = new ushort[CellsPerIc];
        private readonly bool[] openWires = new bool[CellsPerIc + 1];
        private readonly double[] tapV = new double[CellsPerIc + 1];   // open taps' C23, 100 uV
        private double tapAt;
        private readonly int[] adowOffset = new int[CellsPerIc];
        private readonly List<string> history = new List<string>();
        private int convKind;
        private double convStart;
        private double convLength;
        private int convPair;
        private readonly ushort[] cellResults = new ushort[CellsPerIc];
        private readonly ushort[] aux = new ushort[MuxChannels];
        private readonly ulong[] bleedUs = new ulong[CellsPerIc];
        private ulong bleedSince;
        private readonly List<byte> rx = new List<byte>();
        private readonly List<byte> relayed = new List<byte>();
        private readonly SortedDictionary<ushort, int> commandCounts = new SortedDictionary<ushort, int>();
        private int corruptNext;
        private bool corrupting;
        private ushort gpio1Result;
        private int muxChannel;
        private byte[] reply;
        private ushort? command;
        private int badCommandPec;
        private int adcvWhileDischarging;
        private int adowWhileDischarging;
        private int corruptConfigNext;
        private int badWritePec;
        private int wakes;
    }
}
