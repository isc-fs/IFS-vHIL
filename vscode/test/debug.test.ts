import * as assert from "node:assert/strict";
import { test } from "node:test";

import { boardsOf, debugConfig } from "../src/debug";

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
    "add-symbol-file /r/results/vscode/debug/ecu.bootloader.elf",
    "set substitute-path /vhil/fw/ecu@local /home/me/IFS08-CE-ECU",
  ]);
});
