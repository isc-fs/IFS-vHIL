import * as assert from "node:assert/strict";
import { test } from "node:test";

import { barOf, findings, groupId, Health, holdBack, HOLD_BACK_S, imagesCost, imagesNeeded, parseStatus, scenarioSystem } from "../src/status";

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
  const h: Health = { context: "colima-vhil", startsVm: true, dockerCli: true, dockerUp: false, built: new Map(),
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

test("vhil-docker.sh status: docker, image states, built firmware (later lines win)", () => {
  const s = parseStatus([
    // The script's real format: key and state on one line.
    "docker=up", "base=abc base_state=local", "editor=def editor_state=published", "clean=true",
    "built=ecu=/vhil/fw/ecu@dev/ECU08.elf", "built=ams=/vhil/fw/ams@dev/AMS.elf",
    "built=ecu=/vhil/fw/ecu@local/ECU08.elf", "",
  ].join("\n"))!;
  assert.equal(s.docker, "up");
  assert.equal(s.baseState, "local");
  assert.equal(s.editorState, "published");
  assert.equal(s.built.size, 2);
  assert.equal(s.built.get("ecu"), "/vhil/fw/ecu@local/ECU08.elf");
  assert.equal(parseStatus("docker=down\nbase_state=unknown\n")?.docker, "down");
  assert.equal(parseStatus("docker=nocli\n")?.docker, "nocli");
  assert.equal(parseStatus("docker=up\nbase_state=weird\n")?.baseState, undefined);
  // An older script prints its usage: not a status, keep what was known.
  assert.equal(parseStatus("Run the vHIL in Docker: every CI job, locally\n  scripts/vhil-docker.sh vm\n"), undefined);
});

test("the bar: images needed when one isn't here, nothing tested is a warning", () => {
  assert.ok(imagesNeeded("local", "published"));
  assert.ok(imagesNeeded("missing", "local"));
  assert.ok(!imagesNeeded("local", "local"));
  assert.ok(!imagesNeeded("unknown", "local"));
  assert.ok(!imagesNeeded(undefined, undefined));
  const pull = barOf({ kind: "images", base: "published", editor: "published" });
  assert.equal(pull.text, "$(cloud-download) vHIL: images needed");
  assert.equal(pull.action, "pullImages");
  assert.match(pull.tooltip, /GB/);
  assert.match(barOf({ kind: "images", base: "missing", editor: "missing" }).tooltip, /from source, ~30 min/);

  const skipped = barOf({ kind: "result", passed: 0, failed: 0, skipped: 5 });
  assert.equal(skipped.text, "$(warning) vHIL: 5 skipped");
  assert.ok(skipped.warn);
  assert.doesNotMatch(skipped.text, /pass/);
});

test("Diagnose: no docker CLI, image states, the debugger", () => {
  const h: Health = { context: "colima-vhil", startsVm: true, dockerCli: true, dockerUp: true,
                      built: new Map(), needed: [], editorUp: true };
  const nocli = findings({ ...h, dockerCli: false, dockerUp: false });
  assert.equal(nocli.length, 1);
  assert.equal(nocli[0].label, "Docker CLI not found");
  assert.match(nocli[0].detail, /brew install colima docker docker-compose/);

  const images = (b?: Health["baseState"], e?: Health["editorState"]) =>
    findings({ ...h, baseState: b, editorState: e }).find((f) => f.label === "Images")!;
  assert.ok(images("local", "local").ok);
  assert.equal(images("published", "local").fix, "pullImages");
  assert.ok(!images("published", "published").ok);
  const missing = images("missing", "missing");
  assert.ok(!missing.ok);
  assert.match(missing.detail, /no published image: the first run builds Renode \(~30 min\)/);
  assert.match(images("local", "missing").detail, /editor image builds on the base/);
  assert.match(images("unknown", "local").detail, /registry unreachable/);

  const dbg = (d: NonNullable<Health["debugger"]>) => findings({ ...h, debugger: d }).at(-1)!;
  assert.deepEqual(dbg({ cpptools: true, gdb: "arm-none-eabi-gdb", version: "GNU gdb 14.2" }),
    { ok: true, label: "Debugger", detail: "GNU gdb 14.2" });
  const noGdb = dbg({ cpptools: true, gdb: "arm-none-eabi-gdb" });
  assert.equal(noGdb.fix, "openSettings");
  assert.equal(noGdb.setting, "vhil.gdbPath");
  assert.match(dbg({ cpptools: false, gdb: "x" }).detail, /ms-vscode.cpptools/);
  // Docker down still says whether Debug Test would work.
  assert.equal(findings({ ...h, dockerUp: false, debugger: { cpptools: true, gdb: "g" } }).at(-1)?.label, "Debugger");
});

test("images cost: an unpublished editor builds, even on a published base", () => {
  assert.match(imagesCost("published", "missing"), /pull several GB.*editor image .*builds/);
  assert.match(imagesCost("local", "missing"), /editor image .*builds/);
  assert.match(imagesCost("missing", "missing"), /~30 min/);
});

test("the checkout waits for a new commit's images, but not for ever", () => {
  assert.equal(holdBack({ base: "published", editor: "missing", ageS: 600 }), true);
  assert.equal(holdBack({ base: "missing", editor: "missing", ageS: 600 }), true);
  assert.equal(holdBack({ base: "published", editor: "published", ageS: 600 }), false);
  assert.equal(holdBack({ base: "local", editor: "local", ageS: 600 }), false);
  assert.equal(holdBack({ base: "unknown", editor: "unknown", ageS: 600 }), false); // can't tell: move
  assert.equal(holdBack({ base: "missing", editor: "missing", ageS: HOLD_BACK_S + 1 }), false);
});
