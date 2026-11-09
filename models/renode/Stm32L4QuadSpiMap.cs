//
// QUADSPI memory-mapped mode for the STM32L496, per board. Compiled by Renode
// at load time and created by catalog/platforms/stm32l496.yaml's setup:
//     emulation CreateVhilL4QuadSpiMap "hub"
//
// Renode's STM32H7_QuadSPI (the same IP, at QSPI_R_BASE 0xA0001000) runs the
// indirect and status-polling modes only. In memory-mapped mode (CCR.FMODE
// 3, RM0351 "QUADSPI memory-mapped mode") the external flash answers at
// QSPI_BASE 0x90000000. This watches CCR writes and, while FMODE is 3, maps
// the memory of the flash attached to the QUADSPI (a GenericSpiFlash's
// UnderlyingMemory) at 0x90000000, so the CPU reads it and runs code from it;
// leaving the mode (another FMODE, or the QUADSPI's reset: an RCC RSTR or a
// machine reset) unmaps it. Mapped is the test API's view.
//
// The memory is the flash's own: a write while mapped lands in the flash's
// contents (on silicon a memory-mapped write is an error), and CCR's
// instruction, address and dummy-cycle fields (the read command the flash
// would get) are not checked against the flash.
//
using System;
using System.Linq;
using Antmicro.Renode.Core;
using Antmicro.Renode.Core.Structure;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.Memory;
using Antmicro.Renode.Peripherals.SPI;

namespace Antmicro.Renode.Testing
{
    public static class VhilL4QuadSpiMapExtensions
    {
        public static void CreateVhilL4QuadSpiMap(this Emulation emulation, string machineName)
        {
            if(!emulation.TryGetMachineByName(machineName, out var machine))
            {
                throw new ArgumentException($"no machine '{machineName}'");
            }
            emulation.ExternalsManager.AddExternal(new VhilL4QuadSpiMap(machine), $"vhil_qspi_{machineName}");
        }
    }

    public class VhilL4QuadSpiMap : IExternal
    {
        public VhilL4QuadSpiMap(IMachine machine)
        {
            this.machine = machine;
            if(!machine.TryGetByName<STM32H7_QuadSPI>("sysbus.quadspi", out qspi))
            {
                throw new ArgumentException("no STM32H7_QuadSPI at sysbus.quadspi");
            }
            VhilBusHooks.For(machine, "sysbus.quadspi").OnWrite(Ccr, value =>
            {
                Map(((value >> 26) & 3) == 3);
                return value;
            });
            // RCC_AHB3RSTR.QSPIRST (bit 8) resets the QUADSPI.
            VhilBusHooks.For(machine, "sysbus.rcc").OnWrite(0x30, value =>
            {
                if((value & (1u << 8)) != 0)
                {
                    Map(false);
                }
                return value;
            });
            machine.MachineReset += _ => Map(false);
        }

        public bool Mapped => mapped != null && on;

        public void Reset()
        {
        }

        // The flash's memory is registered at 0x90000000 the first time the
        // mode is entered and stays registered (unregistering a memory drops
        // it from the machine); outside the mode its range is locked, so an
        // access there finds nothing, as on silicon.
        public void Map(bool enable)
        {
            if(enable == Mapped)
            {
                return;
            }
            if(enable && mapped == null)
            {
                var flash = ((IPeripheralContainer<GenericSpiFlash, NullRegistrationPoint>)qspi).Children.FirstOrDefault()?.Peripheral;
                var memory = flash?.UnderlyingMemory;
                if(memory == null)
                {
                    machine.Log(LogLevel.Warning, "QUADSPI memory-mapped mode with no flash attached: nothing at 0x{0:X}.", Base);
                    return;
                }
                machine.SystemBus.Register(memory, new BusRangeRegistration(Base, (ulong)memory.Size));
                mapped = memory;
            }
            if(mapped == null)
            {
                return;
            }
            machine.SystemBus.SetAddressRangeLocked(new Antmicro.Renode.Core.Range(Base, (ulong)mapped.Size), !enable);
            on = enable;
        }

        private readonly IMachine machine;
        private readonly STM32H7_QuadSPI qspi;
        private MappedMemory mapped;
        private bool on;

        private const long Ccr = 0x14;
        private const ulong Base = 0x90000000;
    }
}
