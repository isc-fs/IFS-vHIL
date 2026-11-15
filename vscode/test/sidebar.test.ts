import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  ago, boardsOf, descriptionOf, duration, ifsHilArgs, isScenarioOf, keepRuns, RunRecord,
  runDescription, runOk, systemMarker, systemTests,
} from "../src/sidebar";

const SYSTEM = `kind: system
id: ecu-ams
description: >-
  The ECU and the AMS on the car's ACU bus,
  each a MainLite.
time:
  quantum_s: 0.0005
boards:
  # Each a MainLite in its role.
  ecu: {board: mainlite, role: ecu}
  ams: {board: mainlite, role: ams}  # a trailing comment
  hub: {board: sensorhub}
buses:
  can_acu: {kind: can, nodes: [ecu.FDCAN2, ams.FDCAN1]}
`;

test("a system's boards and description come from its file", () => {
  assert.deepEqual(boardsOf(SYSTEM), [
    { name: "ecu", board: "mainlite", role: "ecu" },
    { name: "ams", board: "mainlite", role: "ams" },
    { name: "hub", board: "sensorhub", role: undefined },
  ]);
  assert.equal(descriptionOf(SYSTEM), "The ECU and the AMS on the car's ACU bus, each a MainLite.");
  assert.equal(descriptionOf("id: x\ndescription: one line\nboards:\n"), "one line");
  assert.deepEqual(boardsOf("id: x\n"), []);
});

test("a system's tests: sim by its marker, scenarios by their id", () => {
  assert.equal(systemMarker("ecu-ams-udv"), "system_ecu_ams_udv");
  const tests = [
    { id: "tests/sim/test_a.py::t1", markers: ["ecu", "system_ecu"] },
    { id: "tests/sim/test_b.py::t2", markers: ["system_ecu_ams"] },
    { id: "tests/unit/test_c.py::t3", markers: ["system_ecu"] },
    { id: "tests/scenarios/test_scenarios.py::test_scenario[ecu/boots]", markers: [] },
    { id: "tests/scenarios/test_scenarios.py::test_scenario[ecu-ams/arms]", markers: [] },
  ];
  assert.deepEqual(systemTests(tests, "ecu"), {
    sim: ["tests/sim/test_a.py::t1"],
    scenarios: ["tests/scenarios/test_scenarios.py::test_scenario[ecu/boots]"],
  });
  assert.ok(isScenarioOf(tests[4].id, "ecu-ams"));
  assert.ok(!isScenarioOf(tests[4].id, "ecu"));
});

test("runs read short and keep the newest", () => {
  assert.equal(duration(850), "850 ms");
  assert.equal(duration(12_400), "12 s");
  assert.equal(duration(185_000), "3 min 5 s");
  assert.equal(duration(3_720_000), "1 h 2 min");
  assert.equal(ago(0, 30_000), "just now");
  assert.equal(ago(0, 5 * 60_000), "5 min ago");
  assert.equal(ago(0, 3 * 86_400_000), "3 d ago");

  const tests: RunRecord = { id: "a", label: "tests/sim", started: 0, ms: 80_000, kind: "tests",
                             passed: 12, failed: ["x", "y"], skipped: 1 };
  assert.equal(runDescription(tests, 120_000), "2 failed · 12 passed · 1 skipped · 1 min 20 s · 2 min ago");
  assert.equal(runOk(tests), false);
  const task: RunRecord = { id: "b", label: "Speed", started: 0, ms: 5000, kind: "task", args: ["speed"], exit: 0 };
  assert.equal(runDescription(task, 5000), "exit 0 · 5 s · just now");
  assert.equal(runOk(task), true);
  assert.equal(runOk({ ...tests, cancelled: true }), undefined);

  const many = Array.from({ length: 20 }, (_, i) => ({ ...task, id: `r${i}` }));
  const kept = keepRuns(many, { ...task, id: "new" });
  assert.equal(kept.length, 20);
  assert.equal(kept[0].id, "new");
  assert.equal(kept[19].id, "r18");
});

test("the IFS_HIL suite runs for the DUT picked", () => {
  assert.deepEqual(ifsHilArgs("ams", " smoke "), { args: ["ifs-hil", "smoke"], env: { VHIL_DUT: "ams" } });
  assert.deepEqual(ifsHilArgs("ecu", ""), { args: ["ifs-hil"], env: { VHIL_DUT: "ecu" } });
});
