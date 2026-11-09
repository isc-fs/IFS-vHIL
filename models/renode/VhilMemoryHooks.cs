//
// One owner for a machine's CPU memory-access hook. Renode keeps a single
// hook per CPU (SetHookAtMemoryAccess replaces the previous one) and a hook
// slows every load and store, so models that need one (the L4's flash checks,
// SRAM2 write protection) register a named handler here and switch it on
// only while they need it; the CPU's hook is installed while any handler is
// on and removed when none is. Handlers run after the access has landed, in
// the order they were registered. Switching the hook on flushes the CPU's
// TLB and translation cache, so no access already translated skips it.
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
                if(on && cpu is TranslationCPU translation)
                {
                    Retranslate(translation);
                }
            }
        }

        // Switched on from a store the CPU is executing (FLASH_KEYR, SYSCFG_SWPR),
        // the hook would miss later accesses of the same translation block whose
        // page is already in the TLB (seen on x86 hosts: the stores after the
        // first one to a flash page went unchecked). So: flush the TLB, end
        // the block after this instruction and translate again.
        private static void Retranslate(TranslationCPU cpu)
        {
            cpu.FlushTlb();
            if(cpu.RequestTranslationBlockRestart(quiet: true))
            {
                cpu.RequestTranslationCacheClearing();
            }
            else
            {
                cpu.ClearTranslationCache();   // from the monitor: the CPU is not running
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
