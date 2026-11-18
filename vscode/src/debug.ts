// Debugging a test (#425), without VS Code: which board to hold, and the
// debug configuration that attaches the host's GDB to it
// (vhil/debugattach.py writes ready.json). Tested by test/debug.test.ts.

import { scenarioSystem } from "./status";

/** The board roles a debugger can hold: MainLites in a role. */
export const BOARDS = ["ecu", "ams", "udv"];

/**
 * The boards a test runs, best first: the open firmware's own; else the
 * board markers of a sim test (ecu, ams, udv), its system markers
 * (system_ecu_ams) or a scenario's system (ecu-ams).
 */
export function boardsOf(test: { id: string; markers: string[] }, firmware?: string): string[] {
  if (firmware && BOARDS.includes(firmware)) return [firmware];
  const found = new Set<string>();
  for (const m of test.markers) {
    if (BOARDS.includes(m)) found.add(m);
    if (m.startsWith("system_")) m.slice("system_".length).split("_").forEach((b) => BOARDS.includes(b) && found.add(b));
  }
  const system = scenarioSystem(test.id);
  if (system) system.split("-").forEach((b) => BOARDS.includes(b) && found.add(b));
  return BOARDS.filter((b) => found.has(b));
}

/** results/vscode/debug/ready.json (vhil/debugattach.py). */
export interface Ready {
  board: string;
  port: number;
  system: string;
  images: string[]; // file names in the same folder: app, then bootloader
  sources: string[]; // their build trees in the container
  host_sources?: (string | null)[]; // copies of those trees, relative to the folder
}

/**
 * The cppdbg configuration: the host's arm-none-eabi-gdb on the copied
 * app image, the bootloader's symbols added, each container build tree
 * mapped to sources the host has (the open firmware's working tree, else
 * the copy debugattach took). Launching with a server address connects and
 * continues: the stub has the board stopped before its first instruction,
 * so the breakpoints go in first. With none set (`stop`), it stops at main
 * (the bootloader's, the first to run) instead of running the test through.
 */
export function debugConfig(ready: Ready, dir: string, gdb: string,
                            local?: { firmware: string; dir: string },
                            stop = false): { [key: string]: unknown } {
  const image = (name: string) => `${dir}/${name}`;
  const map: { [from: string]: string } = {};
  ready.sources.forEach((from, i) => {
    const copy = ready.host_sources?.[i];
    if (copy) map[from] = `${dir}/${copy}`;
  });
  if (local) map[`/vhil/fw/${local.firmware}@local`] = local.dir;
  const setup = [
    { text: "set confirm off" },
    ...ready.images.slice(1).map((n) => ({ text: `add-symbol-file ${image(n)}`, ignoreFailures: true })),
    ...Object.entries(map).map(([from, to]) => ({ text: `set substitute-path ${from} ${to}` })),
  ];
  return {
    type: "cppdbg",
    request: "launch",
    name: `vHIL: ${ready.board} (${ready.system})`,
    program: image(ready.images[0]),
    cwd: local?.dir ?? dir,
    MIMode: "gdb",
    targetArchitecture: "arm",
    miDebuggerPath: gdb,
    miDebuggerServerAddress: `127.0.0.1:${ready.port}`,
    stopAtEntry: stop,
    externalConsole: false,
    setupCommands: setup,
    sourceFileMap: map,
  };
}
