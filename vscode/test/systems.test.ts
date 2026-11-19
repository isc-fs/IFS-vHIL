import * as assert from "node:assert/strict";
import { test } from "node:test";

import { boardsOf, descriptionOf, ifsHilArgs, validationProblems, webPort } from "../src/systems";

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

test("validate's errors land on the line naming what they quote", () => {
  const text = "id: ecu\n# board: nope here is a comment\nboards:\n  ecu: {board: nope}\nbuses:\n  can_acu: {nodes: [ecu.FDCAN9]}\n";
  const out = [
    "error: no board 'nope' in the catalogue (/work/catalog/boards/nope.yaml) (known: mainlite, sensorhub)",
    "error: board 'ecu' (mainlite) has no connector or pin 'FDCAN9' (nor has its pin model v1.0) (did you mean 'FDCAN3'?)",
    "Error: something general",
    "fine line",
  ].join("\n");
  assert.deepEqual(validationProblems(out, text).map((p) => p.line), [3, 5, 0]);
});

test("each vHIL checkout's web app has its port: 8080 for yours, its own for the extension's", () => {
  assert.equal(webPort("/home/me/IFS-vHIL", false), 8080);
  const a = webPort("/storage/a/vhil", true), b = webPort("/storage/b/vhil", true);
  assert.ok(a >= 8100 && a < 8900 && b >= 8100 && b < 8900);
  assert.notEqual(a, b);
  assert.equal(webPort("/storage/a/vhil", true), a); // the same every window
  assert.equal(webPort("/storage/a/vhil", true, "9000"), 9000); // VHIL_WEB_PORT wins
  assert.equal(webPort("/home/me/IFS-vHIL", false, "nope"), 8080);
});

test("the vhil command's directory, as the desktop app picks it; Windows needs WSL", async () => {
  const { cliDirs, needsWsl } = await import("../src/systems");
  assert.deepEqual(cliDirs("darwin", "/Users/me"), ["/opt/homebrew/bin", "/usr/local/bin"]);
  assert.deepEqual(cliDirs("linux", "/home/me"), ["/home/me/.local/bin"]);
  assert.equal(needsWsl("win32"), true);
  assert.equal(needsWsl("linux"), false); // a Remote-WSL window
});
