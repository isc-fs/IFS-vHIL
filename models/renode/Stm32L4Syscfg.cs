//
// SYSCFG of the STM32L496, compiled by Renode at load time and placed by
// platforms/cpus/stm32l496.repl at SYSCFG_BASE 0x40010000 (stm32l496xx.h).
// Renode's STM32_SYSCFG has only EXTICR1-4; this is the L4's whole block
// (SYSCFG_TypeDef: MEMRMP 0x00, CFGR1 0x04, EXTICR1-4 0x08-0x14, SCSR 0x18,
// CFGR2 0x1C, SWPR 0x20, SKR 0x24, SWPR2 0x28; RM0351 "SYSCFG registers").
//
//   EXTICRx   line n of the port EXTIn selects (A 0 .. I 8) is passed on to
//             EXTI line n. The repl connects port p's pins to input p of
//             this block (`[0-15] -> syscfg#p@[0-15]`), as with Renode's.
//   MEMRMP    MEM_MODE, FB_MODE: stored. What answers at 0 is the repl's
//             boot alias (main flash); a remap to SRAM1 or the system flash
//             is not carried out (RemapRequests counts the attempts).
//   CFGR1     FWDIS (reset 1), BOOSTEN, the I2C fast-mode-plus bits, FPU_IE:
//             stored.
//   SCSR      SRAM2ER erases SRAM2 to 0 at once (SRAM2BSY reads 0), after the
//             SKR key 0xCA, 0x53 (RM0351 "SRAM2 erase"); without it ignored.
//   CFGR2     CLL, SPL, PVDL, ECCL set-only (cleared by reset); SPF (SRAM2
//             parity error) never rises, write 1 to clear.
//   SWPR(2)   SRAM2 page write protection (1 KB pages: SWPR pages 0-31,
//             SWPR2 32-63), set-only until reset. A CPU store into a
//             protected page, at either SRAM2 address, is undone from a copy
//             of the page taken when it was protected (VhilMemoryHooks.cs, on
//             only while a page is protected); ProtectedWrites counts them.
//             Whatever fault silicon reports for it is not raised.
//
using System.Collections.Generic;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Logging.Profiling;
using Antmicro.Renode.Peripherals.Memory;
using Antmicro.Renode.Testing;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class STM32L4_SYSCFG : IDoubleWordPeripheral, IKnownSize, INumberedGPIOOutput, ILocalGPIOReceiver
    {
        public STM32L4_SYSCFG(IMachine machine, MappedMemory sram2 = null)
        {
            this.machine = machine;
            this.sram2 = sram2;
            var gpios = new Dictionary<int, IGPIO>();
            for(var i = 0; i < Lines; i++)
            {
                gpios[i] = new GPIO();
            }
            Connections = gpios;
            Reset();
        }

        public IReadOnlyDictionary<int, IGPIO> Connections { get; }

        public long Size => 0x30;   // to SWPR2; VREFBUF at 0x30, COMP at 0x200

        public int RemapRequests => remapRequests;

        public ulong Sram2ProtectedPages => ((ulong)swpr2 << 32) | swpr;

        public int ProtectedWrites => protectedWrites;

        public IGPIOReceiver GetLocalReceiver(int port)
        {
            if(!receivers.TryGetValue(port, out var receiver))
            {
                receiver = new PortInput(this, port);
                receivers[port] = receiver;
            }
            return receiver;
        }

        public void Reset()
        {
            memrmp = 0;
            cfgr1 = Cfgr1Reset;
            cfgr2 = 0;
            swpr = 0;
            swpr2 = 0;
            Protect();
            keyStep = 0;
            unlocked = false;
            for(var i = 0; i < exticr.Length; i++)
            {
                exticr[i] = 0;
            }
            for(var line = 0; line < Lines; line++)
            {
                Update(line);
            }
        }

        public uint ReadDoubleWord(long offset)
        {
            switch(offset)
            {
            case 0x00: return memrmp;
            case 0x04: return cfgr1;
            case 0x08: case 0x0C: case 0x10: case 0x14:
                return exticr[(offset - 0x08) / 4];
            case 0x18: return 0;          // SRAM2ER done, SRAM2BSY 0
            case 0x1C: return cfgr2;
            case 0x20: return swpr;
            case 0x24: return 0;
            case 0x28: return swpr2;
            }
            this.Log(LogLevel.Warning, "Unhandled read from offset 0x{0:X}.", offset);
            return 0;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            switch(offset)
            {
            case 0x00:
                memrmp = value & 0x107;
                if((memrmp & 7) != 0)
                {
                    remapRequests++;
                    this.Log(LogLevel.Warning, "MEM_MODE {0} not carried out: main flash stays at 0.", memrmp & 7);
                }
                return;
            case 0x04:
                // FWDIS can only be cleared (RM0351: "set by hardware ... cleared by software").
                cfgr1 = (value & Cfgr1Mask & ~1u) | (value & cfgr1 & 1u);
                return;
            case 0x08: case 0x0C: case 0x10: case 0x14:
                var index = (int)((offset - 0x08) / 4);
                exticr[index] = value & 0xFFFF;
                for(var i = 0; i < 4; i++)
                {
                    Update(4 * index + i);
                }
                return;
            case 0x18:
                if((value & 1) != 0)
                {
                    if(unlocked && sram2 != null)
                    {
                        var zeros = new byte[sram2.Size];
                        sram2.WriteBytes(0, zeros, 0, zeros.Length);
                    }
                    else
                    {
                        this.Log(LogLevel.Warning, "SRAM2 erase ignored: SKR key not written.");
                    }
                }
                unlocked = false;
                return;
            case 0x1C:
                cfgr2 = (cfgr2 | (value & 0xF)) & ~(value & 0x100);
                return;
            case 0x20:
                swpr |= value;
                Protect();
                return;
            case 0x24:
                var key = value & 0xFF;
                if(keyStep == 0 && key == 0xCA)
                {
                    keyStep = 1;
                }
                else if(keyStep == 1 && key == 0x53)
                {
                    unlocked = true;
                    keyStep = 0;
                }
                else
                {
                    keyStep = 0;
                    unlocked = false;
                }
                return;
            case 0x28:
                swpr2 |= value;
                Protect();
                return;
            }
            this.Log(LogLevel.Warning, "Unhandled write to offset 0x{0:X}, value 0x{1:X}.", offset, value);
        }

        // Copies the newly protected pages and switches the store check on
        // while any page is protected.
        private void Protect()
        {
            var pages = Sram2ProtectedPages;
            if(sram2 == null || machine == null)
            {
                return;
            }
            for(var page = 0; page < 64; page++)
            {
                if((pages & (1ul << page)) != 0 && !copies.ContainsKey(page))
                {
                    copies[page] = sram2.ReadBytes(page * PageSize, PageSize);
                }
            }
            if(pages == 0)
            {
                copies.Clear();
            }
            VhilMemoryHooks.For(machine).Set("sram2-wp", pages == 0 ? null : (VhilMemoryAccess)OnStore);
        }

        private void OnStore(MemoryOperation operation, ulong address, uint width, ulong value)
        {
            if(operation != MemoryOperation.MemoryWrite)
            {
                return;
            }
            long offset;
            if(address >= 0x10000000 && address < 0x10010000)
            {
                offset = (long)(address - 0x10000000);
            }
            else if(address >= 0x20040000 && address < 0x20050000)
            {
                offset = (long)(address - 0x20040000);
            }
            else
            {
                return;
            }
            var page = (int)(offset / PageSize);
            if(!copies.TryGetValue(page, out var copy))
            {
                return;
            }
            var at = (int)(offset % PageSize);
            sram2.WriteBytes(offset, copy, at, (int)System.Math.Min(width, (uint)(PageSize - at)));
            protectedWrites++;
            this.Log(LogLevel.Warning, "Store to write-protected SRAM2 page {0} at 0x{1:X8} undone.", page, address);
        }

        private int SelectedPort(int line)
        {
            return (int)((exticr[line / 4] >> (4 * (line % 4))) & 0xF);
        }

        private void Update(int line)
        {
            var port = SelectedPort(line);
            Connections[line].Set(receivers.TryGetValue(port, out var input) && input.State[line]);
        }

        private class PortInput : IGPIOReceiver
        {
            public PortInput(STM32L4_SYSCFG parent, int port)
            {
                this.parent = parent;
                this.port = port;
            }

            public bool[] State { get; } = new bool[Lines];

            public void OnGPIO(int pin, bool value)
            {
                if(pin < 0 || pin >= Lines)
                {
                    return;
                }
                State[pin] = value;
                if(parent.SelectedPort(pin) == port)
                {
                    parent.Connections[pin].Set(value);
                }
            }

            public void Reset()
            {
            }

            private readonly STM32L4_SYSCFG parent;
            private readonly int port;
        }

        private const int Lines = 16;
        private const uint Cfgr1Reset = 0x7C000001;
        // FWDIS 0, BOOSTEN 8, I2C_PBx_FMP 16-19, I2Cx_FMP 20-23, FPU_IE 26-31.
        private const uint Cfgr1Mask = 0xFCFF0101;

        private const int PageSize = 1024;
        private readonly IMachine machine;
        private readonly MappedMemory sram2;
        private readonly Dictionary<int, byte[]> copies = new Dictionary<int, byte[]>();
        private int protectedWrites;
        private readonly Dictionary<int, PortInput> receivers = new Dictionary<int, PortInput>();
        private readonly uint[] exticr = new uint[4];
        private uint memrmp;
        private uint cfgr1;
        private uint cfgr2;
        private uint swpr;
        private uint swpr2;
        private int keyStep;
        private bool unlocked;
        private int remapRequests;
    }
}
