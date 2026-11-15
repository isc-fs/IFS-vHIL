import { strict as assert } from "assert";
import { test } from "node:test";

import {
  buildSystem, firmwareForRepo, firmwareOf, markerOf, repoSlug, systemsOf, testRuns,
} from "../src/firmware";

test("repoSlug reads https, ssh and scp-like GitHub remotes", () => {
  assert.equal(repoSlug("https://github.com/isc-fs/IFS08-CE-ECU"), "isc-fs/IFS08-CE-ECU");
  assert.equal(repoSlug("https://github.com/isc-fs/IFS08-CE-ECU.git\n"), "isc-fs/IFS08-CE-ECU");
  assert.equal(repoSlug("git@github.com:isc-fs/IFS08-CE-AMS.git"), "isc-fs/IFS08-CE-AMS");
  assert.equal(repoSlug("ssh://git@github.com/isc-fs/stm32-can-bootloader"), "isc-fs/stm32-can-bootloader");
  assert.equal(repoSlug("https://gitlab.com/x/y"), undefined);
});

test("firmwareOf reads a catalogue file; firmwareForRepo matches case-insensitively", () => {
  const ecu = firmwareOf("kind: firmware\nid: ecu\ndescription: x\nrepo: isc-fs/IFS08-CE-ECU\nref: dev\n");
  assert.deepEqual(ecu, { id: "ecu", repo: "isc-fs/IFS08-CE-ECU" });
  assert.equal(firmwareOf("kind: board\nid: mainlite\n"), undefined);
  assert.equal(firmwareForRepo([ecu!], "ISC-FS/ifs08-ce-ecu"), ecu);
  assert.equal(firmwareForRepo([ecu!], "isc-fs/IFS_HIL"), undefined);
});

const SYSTEMS = [
  { id: "ams", boards: [{ name: "ams", board: "mainlite", role: "ams" }] },
  { id: "ecu", boards: [{ name: "ecu", board: "mainlite", role: "ecu" }] },
  { id: "ecu-ams", boards: [{ name: "ecu", board: "mainlite", role: "ecu" },
                            { name: "ams", board: "mainlite", role: "ams" }] },
  { id: "ecu-ams-udv", boards: [{ name: "ecu", board: "mainlite", role: "ecu" },
                                { name: "ams", board: "mainlite", role: "ams" },
                                { name: "udv", board: "mainlite", role: "udv" }] },
  { id: "sensorhub", boards: [{ name: "sensorhub", board: "sensorhub" }] },
];

test("the systems a firmware runs in, and the one to build it from", () => {
  assert.deepEqual(systemsOf(SYSTEMS, "ecu").map((s) => s.id), ["ecu", "ecu-ams", "ecu-ams-udv"]);
  assert.deepEqual(systemsOf(SYSTEMS, "sensorhub").map((s) => s.id), ["sensorhub"]);
  assert.equal(buildSystem(SYSTEMS, "ecu"), "ecu");
  // Every MainLite carries the bootloader: the system with the most of them.
  assert.equal(buildSystem(SYSTEMS, "can-bootloader"), "ecu-ams-udv");
  assert.equal(buildSystem(SYSTEMS, "nothing"), undefined);
});

test("a firmware's tests: sim by its marker, scenarios by system, never unit", () => {
  const systems = ["ecu", "ecu-ams"];
  assert.ok(testRuns({ id: "tests/sim/test_ecu_boot.py::test_x", markers: ["ecu", "system_ecu"] }, "ecu", systems));
  assert.ok(!testRuns({ id: "tests/sim/test_ams_boot.py::test_x", markers: ["ams"] }, "ecu", systems));
  assert.ok(testRuns({ id: "tests/scenarios/test_scenarios.py::test_scenario[ecu-ams/precharge]", markers: [] },
                     "ecu", systems));
  assert.ok(!testRuns({ id: "tests/scenarios/test_scenarios.py::test_scenario[ams/x]", markers: [] }, "ecu", systems));
  assert.ok(!testRuns({ id: "tests/unit/test_system.py::test_x", markers: [] }, "ecu", systems));
  assert.equal(markerOf("can-bootloader"), "bootloader");
});
