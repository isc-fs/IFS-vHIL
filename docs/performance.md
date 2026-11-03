# Emulation speed (#154)

How many virtual seconds the host emulates per wall second: the real-time
factor. It is not the virtual-time fidelity of [`cpu-timing.md`](cpu-timing.md):
nothing a test asserts depends on it. IFS_HIL's suites run on the bench's own
time since #253 ([`vhil/benchclock.py`](../vhil/benchclock.py)), and native
tests (`vhil.sim`) run entirely in virtual time, so a slow host makes a run
take longer, not fail. The wall-clock bench paces itself to 1x at most
(`models/renode/VhilPacer.cs`); above 1x it waits, below it runs flat out.

## Current figures

The latest end-to-end measurement, from the
[rounds](performance/rounds.md#lock-step-runs-the-udvs-mmio-hook-path-260):
one GitHub runner (x86, 4 vCPU), median of 3, 2026-10-30, patch set
1.17.0-vhil.10 with the fast-forward detector at the iteration boundary
(#345, #346). Real-time factor, higher is faster:

| System | Path | Boot 0-3 s | Steady +5 s |
|---|---|---|---|
| ecu | sim | 3.67x | 6.96x |
| ams | sim | 3.71x | 7.01x |
| ecu-ams | sim | 2.38x | 3.05x |
| ecu-ams | bench | 2.30x | 2.38x |
| udv | sim | 2.97x | 2.81x |
| udv | bench | 3.85x | 3.35x |
| ecu-ams-udv | sim | 1.58x | 1.39x |
| ecu-ams-udv | bench | 1.60x | 1.28x |

- **Host-dependent.** These hold for that runner; CI's runners vary by CPU
  model, and an M-series host under Colima by about ±20 % run to run. The
  same round on the M-series host (4 vCPU, sim, steady): ecu-ams-udv 1.11x,
  ecu-ams 2.19x, ams 5.17x, ecu 4.03x.
- **Not re-measured since.** Patch 0012 (vhil.11, #294) is a fidelity fix
  that adds no work per period; nothing has timed vhil.11 itself.
- **The gate's 500 us quantum.** A run that opts in to 1 ms (#348) is
  12-36 % faster on the M-series host, at the cost of up to 1 ms of
  cross-board lag ([`can-bus.md`](can-bus.md#virtual-time-and-the-sync-quantum)).
- **The slowest board sets the pace.** In ecu-ams-udv that is the uDV, and
  its ADC3 register traffic is what remains ([What is left](#what-is-left)).

## Measuring it

```sh
VHIL_DOCKER_CPUS=4 scripts/vhil-docker.sh speed --baseline   # results/speed/speed.json
python scripts/speed.py ecu=ECU08.elf ams=AMS.elf bootloader=CAN_BL.elf \
    [--systems ams ecu ecu-ams ecu-ams-ecu] [--paths bench sim] [--boot 3] [--steady 5] \
    [--baseline] [--repeat N] [--threads] [--profile DIR] [--setup "vhil_ff_{board} Enabled false"]
```

A speed change must not change what a run computes. The reference is
`ci/fingerprints.json`, which CI's guard checks every system against
(`python scripts/fingerprint.py check ci/fingerprints.json`, [`ci.md`](ci.md)):
what a lock-step run observes in its first 5 s from power-on (every bus's
timeline, GPIO edges with instruction counts, radio payloads, each CPU's
executed instructions, PC, state and RAM digests, the HAL tick), and a
SHA-256 of it per system. A pure speed change leaves it byte-identical; a
fidelity fix replaces it on purpose (last: #294, patch set 1.17.0-vhil.11).
The rounds used the study's 10 s variant
([`fingerprint.py`](proposals/renode-patches/tooling/fingerprint.py)); what
each change moved is in the
[fingerprint log](performance/rounds.md#identity-fingerprint-log).

`ecu-ams-ecu` is a benchmark, not a car system
([`scripts/speed-systems/`](../scripts/speed-systems/ecu-ams-ecu.yaml), named
in `speed.py`'s `BENCH_ONLY`, so the catalogue, the editor and the scenarios
never see it): ecu-ams plus a third MainLite running the ECU's application on
buses of its own, to measure how the cost grows from one board to two to
three before the uDV has a firmware. `--threads` splits each phase's host CPU
by thread: each board's CPU thread, the master time source's loop (on the
monitor's thread), the slave time sources of a lock-step multi-board run, and
the JIT.

[`scripts/speed.py`](../scripts/speed.py) boots each system from power-on
and measures two phases: **boot**, the first 3 s of virtual time (the
bootloaders' 2 s auto-jump window, invariant 5, then the apps' start), and
**steady**, the 5 s after it. Each runs on two paths:

- **bench**: the wall-clock bench's emulation (`vhil/bench.py`): Renode's
  shared time source (`mach create`), every core at `WALL_CLOCK_MIPS` (100),
  the bench clock and GPIO probes, without the pacer, so the factor is the
  host's headroom. Each bus the bench bridges to SocketCAN (`host_netdev`)
  gets a passive node that acknowledges in place of the bridge (#260): before,
  a board alone on such a bus retried every frame with an ACK error, a load
  the bench never has (half the ECU's bench cost was its bus model deciding
  those retries);
- **sim**: lock-step `vhil.sim` as native tests run it: the catalogue's
  `cpu.mips` (ECU and uDV 231, AMS 528), a time source per board (invariant 11), a CAN
  probe on every bus.

Each phase also records the host CPU seconds Renode's process used per
virtual second (all its threads, from `/proc`): what a run costs a host that
runs several at once (throughput), and steadier than the factor on a host
that is busy with something else.

`--baseline` runs each configuration a second time as the bench ran before
#154's speed-ups, on the same host (`VHIL_FAST_FORWARD=0`, .NET's default
tiering delay and call-count threshold). `VHIL_DOCKER_CPUS=N` limits the
container to N cores, as a CI runner (GitHub's have 4). The `emulation speed` job of
[`sim.yml`](../.github/workflows/sim.yml) runs it with `--baseline` when a run
selects it (`full-ci-all`, every night, or a `full-ci` change to the speed
paths, [`ci.md`](ci.md)), into the job summary and an artifact.

On an M-series host under Colima, run to run variation is ±20 %: the VM's
vCPUs land on performance or efficiency cores as macOS schedules them. Take
the median of a few (`--repeat`), or CI's numbers.

## Where the host's time goes

Profiled with host `perf` on Renode's CPU threads (JIT symbols from .NET's
perf map) and by sampling each board's PC on host time
(`speed.py --profile`, `models/renode/VhilPcSampler.cs`):

- **Managed code, not translated code.** On a board's CPU thread, the code
  tlib generated from the firmware is 3-6 % of the samples and tlib's helpers
  5-12 %. The rest is .NET: the CLR's transitions between tlib and C# (every
  MMIO access is a call from native code into C#, every CPU register read a
  call the other way), the peripheral models, and Renode's time framework
  (`BaseClockSource.Update` and the clock-entry list on every chunk). So code
  costs the host by its peripheral accesses and timer events, not by its
  instruction count.
- **The bootloader's polling loop, every boot.** For its 2 s window the CAN
  bootloader's main loop (`stm32-can-bootloader` `main.c`
  `Bootloader_MainLoop`) polls each of the three FDCANs' RXF0S and PSR,
  clears a `FDCAN_ProtocolStatusTypeDef` byte by byte three times, and
  reloads the IWDG: 849 instructions and 7 MMIO accesses an iteration, about
  half a billion instructions per boot at the ECU's 231 MIPS, a billion at the
  AMS's 528. That is why a boot ran at 0.1-0.5x.
- **The ECU's bit-banged nRF24.** Each half bit waits in
  `NRF24_BitBangDelay`, a 400-iteration loop on a volatile counter (2800
  instructions): a third of the ECU's instructions in steady state, plus a GPIO
  write into the C# GPIO and radio models per edge. (Host-time PC sampling
  credited the loop with half the host time, #243; skipping it showed its
  real share is far less: the GPIO writes and the time framework around it
  cost more.)
- **Two boards.** The boards meet at every 500 us sync point (on both paths),
  so each quantum takes as long as the slower board's share of it. Their
  busy stretches (the AMS's LTC6811 chain reads and SD writes, the ECU's radio
  bit-bang) rarely fall in the same quantum, so ecu-ams runs at about the sum
  of the two boards' costs, not the larger: each CPU thread is busy about half
  the time, and while it waits for the other it spins in `SemaphoreSlim.Wait`
  (`TimeHandle.RequestTimeInterval`), a quarter of its samples. The master
  time source's loop takes about an eighth of a core.
- **A fresh Renode.** Every native test starts one. .NET first JITs Renode's
  hot paths unoptimised and, by default, holds their promotion back while new
  methods keep being called: the first boot ran on tier-0 code.
- **Starting a Renode** (#260): every native test starts one, and the
  generated script compiled each C# model with its own `include`. Renode's
  `AdHocCompiler` references every loaded assembly in each compilation, so
  each file took 0.15-0.2 s and ~120 MB the process kept: 3 s and a 1.66 GB
  peak per start. The script now compiles every model, and `vhil.sim`'s
  probes, in one `include` (Renode compiles several `.cs` files into one
  assembly), and the monitor connection polls every 50 ms instead of 500:
  a start (process to ready to run) went from 5.4 to 3.4 s, and the peak RSS
  from 1.66 to 0.6 GB, which is what bounds how many runs a host holds.
  That one compilation was still 1.4 s and kept Roslyn loaded: every model
  is now one assembly compiled once per model change (`vhil/models.py`,
  below), and Renode's own assemblies are ReadyToRun.
- **On an aarch64 host** (Apple silicon) tlib's TCG backend calls its softmmu
  helpers for every guest load and store (`tcg/aarch64/tcg-target.c`
  `tcg_out_qemu_st`/`_ld`: no inline TLB look-up), where x86 has a fast path.
  Memory-heavy code costs more there than on CI.

Tried, with no measurable effect beyond the host's ±20 %: `cpu
SyncPCEveryInstructionDisabled` (tlib's per-instruction PC store), dropping
the default map's XN window (`VhilExecuteNever.cs`, #242), `DOTNET_gcServer`,
`DOTNET_gcConcurrent=0` and a 64 MB `DOTNET_GCgen0size`; worse:
`DOTNET_TieredPGO=0` (steady state) and `DOTNET_TieredCompilation=0`. The
other instrumentation (the bench clock `VhilClock.cs` once a sync point, the
probes' hooks only on the GPIO ports a test watches or drives, `VhilBusHooks`
on the RCC and NVIC, the peripheral guard, which reads Renode's log) is under
half a percent of any profile. Block chaining and the block cache are on, and
`MaximumBlockSize` is tlib's 10000 already. Serial execution of the two
boards' quanta on one thread was 10x slower on the bench path. The sync
quantum (500 us) is left alone for the gate: it decides when boards and the
bus meet (what a firmware sees of another can lag by up to one quantum,
`can-bus.md`), so it is part of what the emulation computes, not a host
setting. A non-gate run may opt in to 1 ms (#348,
[rounds](performance/rounds.md#lock-step-runs-the-udvs-mmio-hook-path-260)),
with a lag of up to 1 ms.

Idle is already cheap: both firmwares sleep in their idle task (AMS#626,
ECU#261), and a CPU in WFI makes Renode report the time to the next event at
once (`BaseCPU`, `ExecutionResult.WaitingForInterrupt`, with
`AdvanceImmediately` on both paths), at no cost per instruction.

## Busy-wait fast-forward

[`models/renode/VhilFastForward.cs`](../models/renode/VhilFastForward.cs),
one per board (`vhil_ff_<board>`, created by the platform's setup in
`catalog/platforms/stm32h733.yaml`), recognises these kinds of busy-wait and
charges their instructions instead of executing them:

- **Counter loops**: the `-O0` volatile counter delay of
  `NRF24_BitBangDelay` (`nop; ldr; adds #1; str; ldr; cmp.w #N; bcc`). A
  pre-opcode hook on CMP.W (immediate) decodes the code around it once per
  PC, exactly that shape or nothing, and checks its bytes again on every use.
  m iterations later the counter (register and memory) is i + m and the flags
  are those of the last ADDS; nothing else changed. A CMP.W that is not a
  delay loop's stays so until a reset, so tlib stops calling the hook there
  (docker/renode's patch 0005 and tlib/0001: `ExcludePreOpcodeExecutionHookAt`,
  the blocks holding it invalidated at the next sync point; every exclusion
  dropped at a reset): the hook reaches C# from the delay loops only. Over a
  3 s boot and 5 s of steady state, the AMS (no delay loops) called it
  259,000 times before and 472 after; the ECU 278,000 and 186,000 (its
  157,000 skips and the delay loops' last iterations).
- **Fixed-point polling loops**: the bootloader's main loop. Armed once a
  quantum, Renode's memory-access hook records the MMIO accesses (Thread mode)
  between two passes through the same access. Two consecutive iterations with
  the same accesses and values, every one of them to a whitelisted register
  (FDCAN CCCR, ECR, PSR, IR, RXF0S, RXF1S, TXFQS, TXBRP: they change only when
  a frame, a transmission's end or the firmware changes them; IWDG KR = 0xAAAA
  with the window off), the same instruction count and no exception or WFI,
  that leave tlib's whole architectural CPU state and every RAM byte as they
  found them, and a third pass through the first access that reads what the
  other two did, are a fixed point: the next iterations repeat them until an
  event. Comparing every RAM byte means copying and comparing all the RAM the
  board has touched (330 KB on the uDV) for each proof; an iteration whose
  every possible path writes no memory (`StoreFreeLoop`, #304: each path of
  exactly its instruction count from the boundary access back to it, decoded
  from the code, following BL into the callee; no store, no instruction
  whose successor the code does not give) leaves RAM as it was by
  construction, so only the CPU's registers are compared. Its verdict is
  kept per (PC, k) with the code it read, checked again from memory on every
  use.
- **Self-yielding polls** (#297): an iteration may pend a PendSV itself, a
  FreeRTOS `taskYIELD` in the loop, as the uDV's micro-ROS transport read
  does on every pass while no agent answers (`usb_cdc_transport.c`
  `cubemx_transport_read`, IFS09-DV-uDV#17). SCB ICSR is whitelisted for it
  (reads, and a write of PENDSVSET alone); every exception entry in the
  iteration must be the PendSV the NVIC acknowledges, as many as the
  iteration pends, ICSR must read the same at both ends (read at a boundary
  only once an attempt has seen a yielding iteration, #307), and the PendSV
  handler's MMIO accesses join the iteration's trace. CPU state and RAM, the
  handler's stack frames included, are compared as for any iteration.
- **Time-bounded polls** (#260): a poll on a register computed from the time
  when read, whose model knows until when it stands (`VhilStableUntil`): ADC3,
  up to its next result, so `HAL_ADC_PollForConversion` (the AMS's
  `read_leg_q4`, 80 us a call). The read joins the whitelist above and a skip
  ends before that time, every skipped read before it with a margin for
  Renode's instruction-to-time rounding (time advances in steps of
  `mips / gcd(mips, ticks per us)` instructions: 231 on the ECU, 66 on the
  AMS). The model's `VhilOnRead` cue arms the detector when the poll starts;
  it asks the model first whether anything is under way, before any call
  into tlib (#306), since most ADC3 reads come while it is idle (the uDV
  configures, starts and stops it around each of its six single conversions
  a millisecond), and ADC3 syncs the CPU's time only while a conversion runs
  (#299).
- **Cycle-counter waits**: a wait on DWT CYCCNT
  (`while ((DWT->CYCCNT - start) < cycles) {}`, the AMS's isoSPI wake,
  `ltc6820.cpp` `delay_us`: `ldr; subs; cmp; bcc`). CYCCNT is Renode's DWT
  timer on the machine's clock, so each read returns a non-decreasing
  function of the time, and every read before the count reaches
  `start + cycles` sees the loop go on. A pre-opcode hook on BCC (excluded at
  every BCC that is not such a loop's, as the CMP.W one) charges, at the BCC,
  the iterations whose reads all come before that time, from the count at the
  time synced there (at least what the last read saw) and with the
  time-bounded polls' margin. The registers the skipped iterations would
  have written last (the read value, the difference, the flags) are
  overwritten by the next iteration before anything reads them.
- **Tick waits** (#301): `HAL_Delay`'s `while ((HAL_GetTick() - tickstart) <
  wait) {}` as GCC emits it at -Og/-O2 (BL to a `HAL_GetTick` that loads the
  tick from RAM, SUBS, CMP, BCC; the uDV's BMI088 and I2C bring-up, 140 ms of
  its boot), decoded at its BCC through the CYCCNT waits' hook. The loop makes
  no peripheral access (the polling detector needs one) and writes no
  memory, only registers it recomputes from registers it never writes and
  the tick, which only an interrupt changes. Two arrivals at the BCC one
  iteration apart (seven instructions, no exception, the same chunk) with
  those registers equal and the branch taken are a fixed point; the
  iterations up to the chunk's end less two are charged. Never on a page a
  lazily delivering peripheral owns (`VhilLazy.IoPages`).

Exact by construction:

- Renode runs a CPU in chunks that end at the nearest clock entry or the end
  of the quantum; events fire, interrupts are raised and sync-point actions
  (frames from the bus model) run between chunks, and tlib stops exactly at a
  chunk's instruction count. A skip never crosses the end of its chunk, so
  every event fires at the instruction it would have.
- The skipped instructions go into tlib's own executed-instruction counters,
  so virtual time, `cpu ExecutedInstructions` (GPIO edge counts, the radio's
  clock), CYCCNT and the chunk's end are what they would have been. tlib keeps
  those counters in its CPUState; their offsets are found at run time by
  value and confirmed before the first skip, and a Renode whose layout
  differs turns the fast-forward off and logs why.
- A polling skip leaves at least one real iteration before the chunk ends, so
  a repeated time-dependent write (the IWDG reload) happens last at the same
  instruction.
- Not accelerated: anything else, including a poll on a register whose value
  is computed from the time when read and whose model cannot say until when
  it stands (SysTick, a timer's CNT, CYCCNT outside the wait above) or on a
  GPIO a device model drives.

## ADC3's DMA results, handed over lazily

The AMS samples its pack current through ADC3 and DMA1 at 12.5 kHz
(`current_task.cpp`), and `Stm32H7Adc3.cs` landed each result with a clock
event of its own: Renode ends a chunk of execution there (in WFI as well), runs
the time framework, the action and the DMA's transfer, and schedules the next.
That was a fifth of the AMS's host time in steady state. Between two of the
stream's flags (half and full transfer) a result changes only what someone
must look at to see: ADC3's registers, the stream's (NDTR, the flags) and the
RAM it writes. So, when ADC3's own interrupts can't be raised by a result and
the stream takes every request (`TryPlanAhead`), results are handed over when
something looks: ADC3's registers catch up as before, the DMA's
(`Stm32H7Dma.cs`) and the DMAMUX's catch up first (`VhilLazy.cs`), and the
pages the stream will write go through the bus (`SetPageAccessViaIo`) with
hooks that catch up before a read or write lands. The result that sets the
stream's next flag keeps its clock event, so its interrupt is taken at the
same instruction. Results that come due together are handed over in one
go (`DeliverInBulk`, `TakeMany`): ADC3's registers and the stream's counters
as the last of them leaves them, and the items written to RAM at once,
instead of a DMA request through the DMAMUX, a bus read of DR and a bus
write per result. Lock-step runs only (`vhil.sim` and `speed.py`'s sim path
launch Renode with `VHIL_LOCKSTEP=1`): there a monitor command lands only
while every machine is paused; on the wall-clock bench the broker's commands
land while the CPU runs, and the bench keeps an event per result.

[`tests/sim/test_lazy_dma.py`](../tests/sim/test_lazy_dma.py) runs ams and
ecu-ams to steady state both ways (`VHIL_LAZY_DMA=0`: an event per result)
and compares the bus timelines, GPIO edges by instruction count, ADC3's and
DMA1's counts, executed instructions and every register and RAM byte:
identical. Not an edge's `t_us`: the GPIO probe stamps the time the CPU last
reported, which moves with where Renode ends a chunk (`VhilProbe.cs`).

[`tests/sim/test_fast_forward.py`](../tests/sim/test_fast_forward.py) runs
ecu, ams, ecu-ams, udv and ecu-ams-udv from power-on into steady state with
and without it and compares every bus's timeline (offer, start, end,
outcome, in ns), GPIO edges
with the executed-instruction count at each write, the radio's payloads, and
at the end each CPU's executed instructions, its registers and every RAM byte
(a SHA-256): identical, and the run with it must have skipped every kind (the
AMS's ADC3 polls included; the uDV's yielding poll, tick waits and
store-free ADC3 polls).

`VHIL_FAST_FORWARD=0` in Renode's environment turns it off for a run, hooks
and all; `vhil_ff_<board> Enabled false` (or `Counters`, `Polls`) at the
monitor, and `vhil_ff_<board> Stats` says what it skipped and what that cost.
On the wall-clock bench, a monitor command that lands inside a skip (a
broker's DAC or TCA write, timed by the host) takes effect at the skip's end,
at most one chunk later in virtual time: still host-timed, as before.

## What is left

The last whole-Renode profile is from patch set 1.17.0-vhil.3; later rounds
profiled one path at a time (the uDV's at vhil.9,
[rounds](performance/rounds.md#lock-step-runs-the-udvs-mmio-hook-path-260)),
so the shares below are dated, and the list under them is kept current.
Host `perf` of Renode in lock-step steady state (patch set 1.17.0-vhil.3,
ReadyToRun, the models' assembly), 20 s at
1999 Hz on the M-series host through Colima (aarch64), share of all of
Renode's samples (its CPU threads, the master time source's loop, which runs
on the monitor's thread, and the slave time sources):

| Where | ecu | ams | ecu-ams |
|---|---|---|---|
| The lock-step hand-off: CoreCLR's spin (one address in `libcoreclr`) and the kernel's scheduling and `sched_yield` | 25 % | 31 % | 16 % |
| The rest of CoreCLR (stubs, P/Invoke and reverse P/Invoke transitions, GC; no symbols) | 27 % | 17 % | 24 % |
| Managed code (Renode's bus, peripherals and time framework, the vHIL's models, the BCL) | 19 % | 29 % | 31 % |
| tlib's helpers and softmmu | 15 % | 10 % | 17 % |
| Translated guest code | 5 % | 6 % | 6 % |
| libc, the loader | 7 % | 7 % | 6 % |

The vHIL's own models are under 1 % on the AMS and ecu-ams; on the ECU the
fast-forward's counter-loop skips are ~4 % (their useful work, half of it
writing the counter back and invalidating the blocks there as a bus write
would). Renode's time framework and timers are 1.5-2 % in their own code (patch 0004).
What could still buy something, most first:

1. **The lock-step hand-off**, 16-31 %: each 500 us quantum a board's CPU
   thread and the master wait for each other spinning (`SemaphoreSlim.Wait` →
   `SpinWait`, `sched_yield`), and on a host running several runs the spin
   takes cores from the others. P1 (a blocking barrier) was slower on 4
   cores, granting several quanta at once is exact almost never, and a
   cheaper wait (a per-thread waiter, a longer spin while a core is spare)
   pays on Apple's hypervisor but not on x86 ([rounds](performance/rounds.md#the-hand-offs-wait-studied-not-shipped-260)). Upstream Renode work. With several boards, most of it is the slave time sources'
   hop ([rounds](performance/rounds.md#several-boards-the-slaves-on-the-masters-thread-the-cyccnt-waits-260)): 24-29 % of the host's samples on x86, 2N + 1 spinning threads
   for N boards, so three boards on 4 vCPUs oversubscribed. Since #288 each
   slave runs on the master's thread (patch 0006): N + 1 threads and one
   hand-off a quantum per board.
2. **CoreCLR outside the spin**, 17-27 %: mostly the transitions between tlib
   and C# (every MMIO access is a reverse P/Invoke into the bus, every CPU
   register read a P/Invoke the other way) and their stubs. Profiling it
   needs CoreCLR's symbols (the study had them); batching or avoiding
   transitions is a Renode/tlib change (P3/P5 took the allocations out, not
   the transitions).
3. **tlib's aarch64 softmmu** (Apple silicon): every load and store through a
   helper (`__ldl_mmu`, `__stl_mmu`: 2-3 % alone on the ECU); x86 has an
   inline TLB fast path. (While the detector is armed it no longer brings
   every RAM access to C#: tlib/0002, #302.)
4. **The fast-forward's skips on the ECU** (~4 %, vHIL side): a skip writes
   the counter back and orders the block invalidation a bus write would for
   that RAM; a page known to hold no translated code could skip it.
5. **Per `RunFor` and per monitor command** (several boards): a `RunFor`
   costs 0.54 ms on ecu and 0.68 ms on ecu-ams on top of its quanta (#284,
   #288), which a native test's 10 ms `run_until` steps pay every step; and a
   scenario slice sends three monitor commands per bus and two per board, one
   round trip each (they could go in one).
6. **The JIT at boot**: 0.4-0.8 CPU s per virtual s over a boot's first
   seconds, a quarter of a three-board boot's CPU; every run starts a fresh
   Renode (no warm starts). #308 promotes a method after 300 calls instead
   of 30 (0.24 CPU s per virtual s left over a three-board boot).
7. **The uDV's ADC3 traffic** (IFS09-DV-uDV#18): ~50 register accesses per
   single conversion, six conversions a millisecond, each through Renode's
   bus (`SystemBus` look-ups, reverse P/Invokes): what keeps the uDV at
   twice an ECU's cost per quantum, and so the board ecu-ams-udv waits for.
   Its hook path is cheaper since this round (the detector at the boundary,
   patches 0010-0011); the bus round trip itself is what remains.
8. Done: the uDV hook path (the detector at the boundary, patches 0010-0011); the uDV round (#297-#308); the slave time sources on the master's thread (#288), the AMS's CYCCNT waits fast-forwarded (#289); start-up (the models' assembly, ReadyToRun), the timer
   update events (patch 0004; its clock-source integer arithmetic, exact but
   with no measurable gain, was dropped in patch set vhil.4), the CMP.W hook
   only at delay loops (patch 0005 and tlib/0001).
