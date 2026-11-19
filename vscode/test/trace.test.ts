import * as assert from "node:assert/strict";
import { test } from "node:test";

import { compilerDiagnostics, hostPath, Snapshot, snapshotMarkdown } from "../src/trace";

const MAP = { repo: "/home/me/vhil", firmware: "ecu", dir: "/home/me/IFS08-CE-ECU" };

test("container paths map to the vHIL checkout and the open working tree only", () => {
  assert.equal(hostPath("/work/vhil/sim.py", MAP), "/home/me/vhil/vhil/sim.py");
  assert.equal(hostPath("/vhil/fw/ecu@local/Core/Src/main.c", MAP), "/home/me/IFS08-CE-ECU/Core/Src/main.c");
  assert.equal(hostPath("/vhil/fw/ams@dev/Core/Src/freertos.c", MAP), undefined);
  assert.equal(hostPath("/vhil/fw/ecu@local/x.c", { repo: "/r" }), undefined);
});

// As a failing AMS test wrote it (vhil/testtrace.py on Renode).
const SNAP: Snapshot = {
  kind: "snapshot", id: "tests/sim/test_x.py::test_y", sim: "ams", board: "ams", time_us: 3510000,
  summary: "ams @ 3.510000 s: PC 0x080210E6 vApplicationIdleHook+0x6", exception: "thread mode", task: "IDLE",
  fault: { CFSR: "0x00000000", HFSR: "0x40000000" },
  frames: [
    { symbol: "vApplicationIdleHook", file: "/vhil/fw/ams@dev/Core/Src/freertos.c", line: 74, address: "0x080210E6" },
    { symbol: "prvIdleTask", file: null, line: null, address: "0x08031A80" },
  ],
  bus_tail: [{ t_us: 3508997, bus: "can_acu", id: 1186, data: "1919190000800002", name: "AMS_temps",
               sender: "AMS", signals: { min_tempC: 25, max_tempC: 25, avg_tempC: 25.5, dc_bus_V: 0, extra: 1 } }],
};

test("a snapshot reads as where the firmware was and the last frames", () => {
  const md = snapshotMarkdown([SNAP]);
  assert.match(md, /\*\*ams\*\* \(ams\) at 3\.510000 s: thread mode, task `IDLE`/);
  assert.match(md, /fault: HFSR 0x40000000/);
  assert.doesNotMatch(md, /CFSR/);
  assert.match(md, /- `vApplicationIdleHook` freertos\.c:74/);
  assert.match(md, /- `prvIdleTask` 0x08031A80/);
  assert.match(md, /\| 3\.508997 \| can_acu \| 0x4A2 \| AMS_temps \| min_tempC=25 max_tempC=25 avg_tempC=25\.500 dc_bus_V=0 … \|/);
});

test("compiler errors land at the working tree's lines, once each", () => {
  const out = [
    "[12/40] Building C object CMakeFiles/ECU08.dir/Core/Src/can.c.obj",
    "/vhil/fw/ecu@local/Core/Src/can.c:212:5: error: 'foo' undeclared (first use in this function)",
    "/vhil/fw/ecu@local/Core/Src/can.c:212:5: error: 'foo' undeclared (first use in this function)",
    "/vhil/fw/ecu@local/Core/Inc/can.h:9:1: warning: unused variable 'x' [-Wunused-variable]",
    "/opt/arm/include/stdio.h:3:1: error: not ours",
    "ld: undefined reference to `bar'",
  ].join("\n");
  assert.deepEqual(compilerDiagnostics(out, MAP), [
    { file: "/home/me/IFS08-CE-ECU/Core/Src/can.c", line: 212, column: 5, severity: "error",
      message: "'foo' undeclared (first use in this function)" },
    { file: "/home/me/IFS08-CE-ECU/Core/Inc/can.h", line: 9, column: 1, severity: "warning",
      message: "unused variable 'x' [-Wunused-variable]" },
  ]);
});
