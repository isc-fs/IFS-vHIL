import * as assert from "node:assert/strict";
import { test } from "node:test";

import { barOf, findings, groupId, Health, scenarioSystem } from "../src/status";

test("the status bar: Docker down asks to diagnose, idle and results run the tests", () => {
  const down = barOf({ kind: "down", context: "desktop-linux" });
  assert.equal(down.action, "diagnose");
  assert.ok(down.warn);
  assert.match(down.text, /Docker not running/);

  const idle = barOf({ kind: "idle", firmware: "ecu", dirty: true, missing: ["ams"] });
  assert.equal(idle.text, "$(beaker) vHIL ecu@local*");
  assert.equal(idle.action, "run");
  assert.match(idle.tooltip, /also builds ams/);

  assert.equal(barOf({ kind: "result", passed: 42, failed: 0, skipped: 1 }).text, "$(pass) vHIL 42");
  const red = barOf({ kind: "result", passed: 40, failed: 3, skipped: 0 });
  assert.equal(red.text, "$(error) vHIL 3 failed");
  assert.ok(red.warn);
  assert.equal(barOf({ kind: "running", done: 3, total: 9 }).action, "none");
  assert.equal(barOf({ kind: "building", firmware: "ecu" }).text, "$(sync~spin) vHIL: building ecu");
  assert.equal(barOf({ kind: "result", passed: 1, failed: 0, skipped: 0, cancelled: true }).action, "run");
});

test("Diagnose: Docker first, then firmware, each failure with its fix", () => {
  const h: Health = { context: "colima-vhil", startsVm: true, dockerUp: false, built: new Map(),
                      needed: ["ecu", "ams", "ecu.bootloader"], editorUp: false };
  assert.deepEqual(findings(h).map((f) => [f.ok, f.fix]), [[false, "startVm"]]);
  assert.deepEqual(findings({ ...h, startsVm: false }).map((f) => f.fix), ["openSettings"]);

  const up = findings({ ...h, dockerUp: true, built: new Map([["ecu", "/vhil/fw/ecu@local/ECU08.elf"]]) });
  const fw = up.find((f) => f.label === "Firmware missing")!;
  assert.equal(fw.detail, "ams, ecu.bootloader");
  assert.equal(fw.fix, "buildFirmware");

  const all = new Map(h.needed.map((b) => [b, `/vhil/fw/${b}@dev/x.elf`]));
  assert.ok(findings({ ...h, dockerUp: true, built: all }).find((f) => f.label === "Firmware built")?.ok);
});

test("a scenario's system comes from its test id", () => {
  assert.equal(scenarioSystem("tests/scenarios/test_scenarios.py::test_scenario[ecu-ams/arms]"), "ecu-ams");
  assert.equal(scenarioSystem("tests/sim/test_a.py::t[ecu/x]"), undefined);
  assert.equal(groupId("ecu-ams"), "group:scenarios/ecu-ams");
});
