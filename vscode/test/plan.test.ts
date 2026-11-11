import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  builtFirmware, collectArgs, contains, dockerContext, fileOf, jobOf, labelOf, parseLines, plan,
  runArgs,
} from "../src/plan";

test("each id runs under its folder's job", () => {
  assert.equal(jobOf("tests/unit"), "unit");
  assert.equal(jobOf("tests/sim/test_x.py::test_y[1]"), "sim");
  assert.equal(jobOf("tests/scenarios/test_scenarios.py"), "scenarios");
  assert.equal(jobOf("tests/simulator/x.py"), undefined);
  assert.equal(jobOf("tests/ecu_smoke.robot"), undefined);
});

test("a run groups by job and drops what an included file or folder holds", () => {
  const groups = plan(["tests/sim/test_a.py", "tests/sim/test_a.py::test_b", "tests/unit",
                       "tests/unit/test_c.py::test_d", "tests/scenarios/test_scenarios.py::t[x]"]);
  assert.deepEqual([...groups], [
    ["sim", ["tests/sim/test_a.py"]],
    ["unit", ["tests/unit"]],
    ["scenarios", ["tests/scenarios/test_scenarios.py::t[x]"]],
  ]);
  assert.ok(contains("tests/sim", "tests/sim/test_a.py"));
  assert.ok(!contains("tests/sim", "tests/simulator/x.py"));
});

test("unit tests run under pytest itself, sim and scenarios under their jobs", () => {
  assert.deepEqual(runArgs("unit", ["tests/unit/test_a.py"], [], "results/vscode/r.jsonl"),
    ["run", "python", "-m", "pytest", "-v", "-p", "no:cacheprovider", "tests/unit/test_a.py",
     "-p", "vhil.pytest_vscode", "--vscode-out", "results/vscode/r.jsonl"]);
  assert.deepEqual(runArgs("sim", ["tests/sim"], ["tests/sim/test_a.py::slow"], "o.jsonl", ["--vhil-trace"]),
    ["sim", "tests/sim", "--deselect", "tests/sim/test_a.py::slow",
     "-p", "vhil.pytest_vscode", "--vscode-out", "o.jsonl", "--vhil-trace"]);
  assert.deepEqual(collectArgs("c.jsonl").slice(-3), ["tests/unit", "tests/sim", "tests/scenarios"]);
});

test("JSON lines parse up to the last newline and skip what isn't JSON", () => {
  const { records, rest } = parseLines(
    '{"kind":"start","id":"a"}\nnot json\n\n{"kind":"result","id":"a","outcome":"passed","duration":1}\n{"kind":"res');
  assert.deepEqual(records.map((r) => r.kind), ["start", "result"]);
  assert.equal(rest, '{"kind":"res');
});

test("ids, contexts and built firmware", () => {
  assert.equal(fileOf("tests/sim/test_x.py::Cls::test_y[1]"), "tests/sim/test_x.py");
  assert.equal(labelOf("tests/sim/test_x.py::Cls::test_y[1]"), "Cls::test_y[1]");
  assert.equal(dockerContext("", "darwin"), "colima-vhil");
  assert.equal(dockerContext("", "linux"), "default");
  assert.equal(dockerContext(" mine ", "darwin"), "mine");
  const built = builtFirmware("ecu=/vhil/fw/a/ECU08.elf\necu.bootloader=/vhil/fw/b/bl.elf\n\n");
  assert.equal(built.get("ecu.bootloader"), "/vhil/fw/b/bl.elf");
  assert.equal(built.size, 2);
});
