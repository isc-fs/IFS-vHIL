import * as assert from "node:assert/strict";
import { test } from "node:test";

import { boardsOf, descriptionOf, ifsHilArgs } from "../src/systems";

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

test("the IFS_HIL suite runs for the DUT picked", () => {
  assert.deepEqual(ifsHilArgs("ams", " smoke "), { args: ["ifs-hil", "smoke"], env: { VHIL_DUT: "ams" } });
  assert.deepEqual(ifsHilArgs("ecu", ""), { args: ["ifs-hil"], env: { VHIL_DUT: "ecu" } });
});
