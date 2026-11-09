//
// One owner for a machine's CPU memory-access hook. Renode keeps a single
// hook per CPU (SetHookAtMemoryAccess replaces the previous one) and a hook
// slows every load and store, so models that need one (the L4's flash checks,
// SRAM2 write protection) register a named handler here and switch it on
// only while they need it; the CPU's hook is installed while any handler is
// on and removed when none is. Handlers run after the access has landed, in
// the order they were registered.
//
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging.Profiling;
using Antmicro.Renode.Peripherals.CPU;

namespace Antmicro.Renode.Testing
{
    public delegate void VhilMemoryAccess(MemoryOperation operation, ulong address, uint width, ulong value);

    public class VhilMemoryHooks
    {
        public static VhilMemoryHooks For(IMachine machine)
        {
            lock(perMachine)
            {
                return perMachine.GetValue(machine, m => new VhilMemoryHooks(m));
            }
        }

        public void Set(string owner, VhilMemoryAccess handler)
        {
            if(handler == null)
            {
                active.Remove(owner);
            }
            else
            {
                active[owner] = handler;
                if(!order.Contains(owner))
                {
                    order.Add(owner);
                }
            }
            var on = active.Count > 0;
            if(on == installed)
            {
                return;
            }
            installed = on;
            foreach(var cpu in machine.SystemBus.GetCPUs().OfType<ICPUWithMemoryAccessHooks>())
            {
                cpu.SetHookAtMemoryAccess(on ? (MemoryAccessHook)OnAccess : null);
            }
        }

        private VhilMemoryHooks(IMachine machine)
        {
            this.machine = machine;
        }

        private void OnAccess(ulong pc, MemoryOperation operation, ulong virtualAddress, ulong physicalAddress,
                              uint width, ulong value)
        {
            foreach(var owner in order.ToArray())
            {
                if(active.TryGetValue(owner, out var handler))
                {
                    handler(operation, physicalAddress, width, value);
                }
            }
        }

        private readonly IMachine machine;
        private readonly Dictionary<string, VhilMemoryAccess> active = new Dictionary<string, VhilMemoryAccess>();
        private readonly List<string> order = new List<string>();
        private bool installed;

        private static readonly ConditionalWeakTable<IMachine, VhilMemoryHooks> perMachine =
            new ConditionalWeakTable<IMachine, VhilMemoryHooks>();
    }
}
