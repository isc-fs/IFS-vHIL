import * as assert from "node:assert/strict";
import { test } from "node:test";

import { boardsOf, debugConfig, gdbQuote } from "../src/debug";

test("the board to debug: the open firmware's, else the test's markers or scenario system", () => {
  assert.deepEqual(boardsOf({ id: "tests/sim/t.py::x", markers: ["ams", "can"] }, "ecu"), ["ecu"]);
  assert.deepEqual(boardsOf({ id: "tests/sim/t.py::x", markers: ["ams", "can"] }), ["ams"]);
  assert.deepEqual(boardsOf({ id: "tests/sim/t.py::x", markers: ["system_ecu_ams_udv"] }), ["ecu", "ams", "udv"]);
  assert.deepEqual(boardsOf({ id: "tests/scenarios/test_scenarios.py::test_scenario[ecu-ams/arms]", markers: [] },
                            "can-bootloader"), ["ecu", "ams"]);
  assert.deepEqual(boardsOf({ id: "tests/sim/t.py::x", markers: ["platform_stm32l496"] }), []);
});

test("the debug configuration attaches to the held board with the working tree's sources", () => {
  const ready = { board: "ecu", port: 3333, system: "ecu-ams", images: ["ecu.elf", "ecu.bootloader.elf"],
                  sources: ["/vhil/fw/ecu@local", "/vhil/fw/can-bootloader@v1.7.0"] };
  const c = debugConfig(ready, "/r/results/vscode/debug", "arm-none-eabi-gdb",
                        { firmware: "ecu", dir: "/home/me/IFS08-CE-ECU" });
  assert.equal(c.type, "cppdbg");
  assert.equal(c.program, "/r/results/vscode/debug/ecu.elf");
  assert.equal(c.miDebuggerServerAddress, "127.0.0.1:3333");
  assert.deepEqual(c.sourceFileMap, { "/vhil/fw/ecu@local": "/home/me/IFS08-CE-ECU" });
  assert.deepEqual((c.setupCommands as { text: string }[]).map((s) => s.text), [
    "set confirm off",
    'add-symbol-file "/r/results/vscode/debug/ecu.bootloader.elf"',
    'set substitute-path "/vhil/fw/ecu@local" "/home/me/IFS08-CE-ECU"',
  ]);
});

test("a tree only the container has maps to its copy; no breakpoints stops at entry", () => {
  const ready = { board: "ams", port: 1, system: "ams", images: ["ams.elf", "ams.bootloader.elf"],
                  sources: ["/vhil/fw/ams@dev", "/vhil/fw/can-bootloader@v1.7.0"],
                  host_sources: ["src/ams@dev", null] };
  const c = debugConfig(ready, "/r/d", "gdb", undefined, true);
  assert.deepEqual(c.sourceFileMap, { "/vhil/fw/ams@dev": "/r/d/src/ams@dev" });
  assert.equal(c.targetArchitecture, "arm");
  assert.equal(c.stopAtEntry, true);
  assert.equal(debugConfig(ready, "/r/d", "gdb").stopAtEntry, false);
});

test("GDB commands quote paths with spaces; Windows folders get forward slashes", () => {
  const ready = { board: "ecu", port: 1, system: "ecu", images: ["ecu.elf", "ecu.bootloader.elf"],
                  sources: ["/vhil/fw/ecu@dev"], host_sources: ["src/ecu@dev"] };
  const dir = "/Users/me/Library/Application Support/Code/User/globalStorage/isc-fs.vhil/IFS-vHIL/results/vscode/debug";
  const c = debugConfig(ready, dir, "gdb");
  assert.deepEqual(c.setupCommands, [
    { text: "set confirm off" },
    { text: `add-symbol-file "${dir}/ecu.bootloader.elf"`, ignoreFailures: true },
    { text: `set substitute-path "/vhil/fw/ecu@dev" "${dir}/src/ecu@dev"`, ignoreFailures: true },
  ]);
  assert.equal(c.program, `${dir}/ecu.elf`); // cppdbg takes it as is
  assert.deepEqual(c.sourceFileMap, { "/vhil/fw/ecu@dev": `${dir}/src/ecu@dev` });

  const w = debugConfig(ready, "C:\\Users\\me\\x", "gdb");
  assert.equal(w.program, "C:/Users/me/x/ecu.elf");
  assert.equal((w.setupCommands as { text: string }[])[1].text, 'add-symbol-file "C:/Users/me/x/ecu.bootloader.elf"');
});

test("gdbQuote escapes quotes and backslashes", () => {
  assert.equal(gdbQuote('a "b"\\c'), '"a \\"b\\"\\\\c"');
});
