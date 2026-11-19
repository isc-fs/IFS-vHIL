import * as assert from "node:assert/strict";
import { test } from "node:test";

import { newSystemError, rows, statusRow } from "../src/systemsView";

const ams = { id: "ams", description: "One AMS", boards: [{ name: "ams", board: "mainlite", role: "ams" }],
              scenarios: false, smoke: true };
const ecuAms = { id: "ecu-ams", description: "ECU and AMS",
                 boards: [{ name: "ecu", board: "mainlite" }, { name: "ams", board: "mainlite" }],
                 scenarios: true, smoke: false };

test("the view: status, every system (scenarios get a run action), tools in the vHIL repo only", () => {
  const r = rows([ams, ecuAms], { dockerUp: true, editorUp: false, context: "x" }, true);
  assert.deepEqual(r.map((x) => x.kind), ["status", "system", "system", "tools"]);
  assert.equal(r[1].context, "vhilSystem");
  assert.equal(r[2].context, "vhilSystemWithScenarios");
  assert.equal(r[2].description, "ecu, ams · scenarios");
  assert.equal(r[2].command, "vhil.openSystemInEditor");
  assert.equal(rows([ams], { dockerUp: true, editorUp: true, context: "x" }, false).at(-1)?.kind, "system");
});

test("the status row says what's wrong and leads to Diagnose", () => {
  assert.equal(statusRow({ editorUp: false, context: "x" }).label, "Checking Docker…");
  const down = statusRow({ dockerUp: false, editorUp: false, context: "colima-vhil" });
  assert.equal(down.command, "vhil.diagnose");
  assert.match(down.tooltip ?? "", /colima-vhil/);
  assert.equal(statusRow({ dockerUp: true, editorUp: true, context: "x" }).description, "editor running");
});

test("a new system's id: a file name, not one that exists", () => {
  assert.equal(newSystemError("ecu-ams-dash", ["ams"]), undefined);
  assert.match(newSystemError("ams", ["ams"]) ?? "", /exists/);
  for (const bad of ["", "ECU", "ecu ams", "-x", "ecu/ams", "a_b"]) assert.ok(newSystemError(bad, []), bad);
});

test("the status row asks for the images when a run would pull or build them", () => {
  const r = statusRow({ dockerUp: true, editorUp: false, context: "x", baseState: "published", editorState: "local" });
  assert.equal(r.label, "Images needed");
  assert.equal(r.command, "vhil.pullImages");
  assert.equal(r.icon, "cloud-download");
  assert.match(statusRow({ dockerUp: true, editorUp: false, context: "x", baseState: "missing" }).tooltip ?? "", /~30 min/);
  assert.equal(statusRow({ dockerUp: true, editorUp: false, context: "x", baseState: "local", editorState: "local" }).label,
    "Stack ready");
});
