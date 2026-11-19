import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  builtFirmware, builtLines, clip, collectArgs, contains, debugStops, dockerContext, fileOf, ignoredSave, jobOf,
  labelOf, parseLines, plan, remapItems, runArgs, startsVm,
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
  assert.ok(startsVm("colima-vhil"));
  assert.ok(!startsVm("desktop-linux"));
  assert.ok(!startsVm("default"));
  const built = builtFirmware("ecu=/vhil/fw/a/ECU08.elf\necu.bootloader=/vhil/fw/b/bl.elf\n\n");
  assert.equal(built.get("ecu.bootloader"), "/vhil/fw/b/bl.elf");
  assert.equal(built.size, 2);
});

test("the listing passes vhil.pytestArgs too", () => {
  assert.deepEqual(collectArgs("c.jsonl", ["tests/sim"], ["-m", "not slow"]).slice(-3), ["-m", "not slow", "tests/sim"]);
  assert.deepEqual(collectArgs("c.jsonl", ["tests/sim"]).slice(-2), ["c.jsonl", "tests/sim"]);
});

test("fw's board=elf lines, not an echoed command or a log line", () => {
  const built = builtLines([
    "$ FW_LOCAL=ecu=/Users/me/IFS08-CE-ECU FW_LOCAL_ONLY=1 scripts/vhil-docker.sh fw ecu",
    "building ecu=from source", "ecu=/vhil/fw/ecu@local/ECU08.elf", "ams=/vhil/fw/ams@dev/AMS.elf\r",
    "ecu=/vhil/fw/ecu@local2/ECU08.elf"].join("\n"));
  assert.deepEqual([...built], [["ecu", "/vhil/fw/ecu@local2/ECU08.elf"], ["ams", "/vhil/fw/ams@dev/AMS.elf"]]);
});

test("a request's items remap to the current listing, gone ones dropped", () => {
  const byId = new Map([["tests/sim/a.py::t", "A2"], ["group:scenarios/ecu-ams", "G2"]]);
  assert.deepEqual(remapItems(["group:scenarios/ecu-ams", "tests/sim/gone.py::t", "tests/sim/a.py::t"], byId),
    ["G2", "A2"]);
  assert.deepEqual(remapItems(["x"], byId), []);
});

test("debug stops at entry unless a breakpoint firmware can hit is enabled", () => {
  assert.ok(debugStops([]));
  assert.ok(debugStops([{ enabled: true, kind: "source", path: "/w/tests/sim/test_a.py" }]));
  assert.ok(debugStops([{ enabled: false, kind: "source", path: "/w/Core/Src/main.c" }]));
  assert.ok(debugStops([{ enabled: true, kind: "other" }]));
  assert.ok(!debugStops([{ enabled: true, kind: "source", path: "/w/Core/Src/main.c" }]));
  assert.ok(!debugStops([{ enabled: true, kind: "source", path: "/w/startup.S" }]));
  assert.ok(!debugStops([{ enabled: true, kind: "function" }]));
});

test("run on save ignores build output inside the watched folder only", () => {
  assert.ok(ignoredSave("/src/fw", "/src/fw/build/main.o"));
  assert.ok(ignoredSave("/src/fw", "/src/fw/a/.git/x"));
  assert.ok(!ignoredSave("/src/fw", "/src/fw/Core/Src/main.c"));
  // The checkout itself under a build/ folder still runs.
  assert.ok(!ignoredSave("/home/me/build/fw", "/home/me/build/fw/Core/Src/main.c"));
});

test("a long failure message is clipped", () => {
  assert.equal(clip("abc", 10), "abc");
  const c = clip("x".repeat(5000));
  assert.ok(c.startsWith("x".repeat(4096)));
  assert.match(c, /904 more characters/);
});
