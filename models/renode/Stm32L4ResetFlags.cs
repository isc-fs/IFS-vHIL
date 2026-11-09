//
// The STM32L496's reset causes (RCC_CSR [31:24]), per board. Compiled by
// Renode at load time and created by catalog/platforms/stm32l496.yaml's setup
// for every stm32l496 board:
//     emulation CreateVhilL4ResetFlags "vhil_reset_hub" "hub"
// It has the same test API as the H733's (VhilResetFlags.cs), so the broker's
// power path (vhil.broker.power_on_commands: `vhil_reset_<board> PowerOn`,
// then `machine Reset`) works on either.
//
// Each machine reset is attributed and handed to the RCC (STM32L4_RCC
// RecordReset), which keeps the flags across resets and clears them on RMVF:
//
//   power-on      announced: PowerOn                   BORRSTF PINRSTF (0x0C)
//   pin (NRST)    the test API PinReset                PINRSTF
//   software      AIRCR.SYSRESETREQ written to the NVIC SFTRSTF PINRSTF
//   option bytes  FLASH_CR.OBL_LAUNCH, options unlocked OBLRSTF PINRSTF
//   watchdog      any other reset while a watchdog runs:
//                 the IWDG started (KR 0xCCCC)         IWDGRSTF PINRSTF
//                 the WWDG started (CR.WDGA)           WWDGRSTF PINRSTF
//   other         a reset with no cause (the monitor's `machine Reset`) PINRSTF
//
// Every internal reset drives NRST low on the L4, so PINRSTF comes with each
// (RM0351 "System reset": "the reset source can be identified by checking the
// reset flags", PINRSTF "set by hardware when a reset from the NRST pin
// occurs", which the internal sources pulse). Bits per stm32l496xx.h
// (RCC_CSR_*): FWRSTF 24, OBLRSTF 25, PINRSTF 26, BORRSTF 27, SFTRSTF 28,
// IWDGRSTF 29, WWDGRSTF 30, LPWRRSTF 31.
//
// Not modelled: both watchdogs started and one fires (IWDGRSTF is set: the
// models' resets do not say which fired), the firewall (FWRSTF) and the
// low-power reset (LPWRRSTF).
//
using System;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.Miscellaneous;

namespace Antmicro.Renode.Testing
{
    public static class VhilL4ResetFlagsExtensions
    {
        public static void CreateVhilL4ResetFlags(this Emulation emulation, string name, string machineName)
        {
            if(!emulation.TryGetMachineByName(machineName, out var machine))
            {
                throw new ArgumentException($"no machine '{machineName}'");
            }
            emulation.ExternalsManager.AddExternal(new VhilL4ResetFlags(machine), name);
        }
    }

    public class VhilL4ResetFlags : IExternal
    {
        public VhilL4ResetFlags(IMachine machine)
        {
            this.machine = machine;
            if(!machine.TryGetByName<STM32L4_RCC>("sysbus.rcc", out rcc))
            {
                throw new ArgumentException("no STM32L4_RCC at sysbus.rcc");
            }
            VhilBusHooks.For(machine, "sysbus.nvic").OnWrite(Aircr, value =>
            {
                if((value >> 16) == AircrKey && (value & SysResetReq) != 0)
                {
                    pending = SftRst;
                }
                return value;
            });
            if(machine.TryGetByName<IDoubleWordPeripheral>("sysbus.flashController", out var flash))
            {
                VhilBusHooks.For(machine, "sysbus.flashController").OnWrite(FlashCr, value =>
                {
                    if((value & OblLaunch) != 0 && (flash.ReadDoubleWord(FlashCr) & OptLock) == 0)
                    {
                        pending = OblRst;
                    }
                    return value;
                });
            }
            if(machine.TryGetByName<IPeripheral>("sysbus.iwdg", out var _))
            {
                VhilBusHooks.For(machine, "sysbus.iwdg").OnWrite(0x00, value =>
                {
                    if((value & 0xFFFF) == 0xCCCC)
                    {
                        iwdgRunning = true;
                    }
                    return value;
                });
            }
            if(machine.TryGetByName<IPeripheral>("sysbus.wwdg", out var _))
            {
                VhilBusHooks.For(machine, "sysbus.wwdg").OnWrite(0x00, value =>
                {
                    if((value & Wdga) != 0)
                    {
                        wwdgRunning = true;
                    }
                    return value;
                });
            }
            machine.MachineReset += _ => OnReset();
        }

        public void Reset()
        {
        }

        // -- test API (monitor) ------------------------------------------------

        // The board's next reset is a power-on (call before machine Reset).
        public void PowerOn()
        {
            powerOn = true;
        }

        // Pull NRST: a pin reset, now.
        public void PinReset()
        {
            pending = 0;
            machine.RequestReset();
        }

        public uint Csr => rcc.ReadDoubleWord(0x94);

        private void OnReset()
        {
            if(powerOn)
            {
                rcc.RecordReset(0, true);
            }
            else
            {
                var cause = pending ?? (iwdgRunning ? IwdgRst : wwdgRunning ? WwdgRst : 0);
                rcc.RecordReset(cause, false);
            }
            machine.Log(LogLevel.Debug, "RCC_CSR 0x{0:X8} after reset", Csr);
            pending = null;
            powerOn = false;
            // A reset stops both watchdogs (RM0351 "IWDG", "WWDG": started by
            // software, stopped only by a reset).
            iwdgRunning = false;
            wwdgRunning = false;
        }

        private readonly IMachine machine;
        private readonly STM32L4_RCC rcc;
        private uint? pending;
        private bool powerOn;
        private bool iwdgRunning;
        private bool wwdgRunning;

        private const long Aircr = 0xD0C;     // SCB AIRCR 0xE000ED0C, NVIC at 0xE000E000
        private const uint AircrKey = 0x05FA;
        private const uint SysResetReq = 1u << 2;
        private const long FlashCr = 0x14;
        private const uint OblLaunch = 1u << 27, OptLock = 1u << 30;
        private const uint Wdga = 1u << 7;

        private const uint OblRst = 1u << 25, SftRst = 1u << 28, IwdgRst = 1u << 29, WwdgRst = 1u << 30;
    }
}
