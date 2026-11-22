import * as assert from "node:assert/strict";
import { test } from "node:test";

import { isSmoke, robotCases, robotResults, smokeResults, smokeSystem } from "../src/robot";

test("a smoke suite's system, from the file or a case", () => {
  assert.equal(smokeSystem("tests/ecu_smoke.robot"), "ecu");
  assert.equal(smokeSystem("tests/ams_smoke.robot::Boots Through The Bootloader"), "ams");
  assert.equal(smokeSystem("tests/sim/test_x.py"), undefined);
  assert.ok(isSmoke("smoke") && isSmoke("tests/ecu_smoke.robot") && !isSmoke("tests/unit"));
  assert.equal(smokeResults("ecu"), "results/smoke-ecu/output.xml");
});

test("the cases under *** Test Cases ***, at their lines", () => {
  const text = [
    "*** Settings ***",
    "Suite Setup    Setup",
    "",
    "*** Test Cases ***",
    "# a comment",
    "Should Send The Heartbeat",
    "    [Tags]    can",
    "    Wait For Frame    0x100",
    "",
    "Should Boot    [Documentation]    inline",
    "",
    "*** Keywords ***",
    "Setup",
    "    Log    x",
  ].join("\n");
  assert.deepEqual(robotCases(text), [
    { name: "Should Send The Heartbeat", line: 6 },
    { name: "Should Boot", line: 10 },
  ]);
});

test("Robot 7 output.xml: each case's own status, not its keywords'", () => {
  const xml = `<robot><suite name="Ecu Smoke">
<test id="s1-t1" name="Should Boot" line="6">
<kw name="Wait"><status status="PASS" start="x" elapsed="0.5"/></kw>
<status status="PASS" start="2026-11-20T10:00:00" elapsed="1.250"/>
</test>
<test id="s1-t2" name="Should &amp; Send" line="9">
<kw name="Wait"><status status="FAIL" elapsed="2.0">inner</status></kw>
<status status="FAIL" elapsed="2.0">Frame 0x100 &lt;never&gt; seen</status>
</test>
</suite></robot>`;
  const r = robotResults(xml);
  assert.deepEqual(r.get("Should Boot"), { status: "PASS", message: "", duration: 1250 });
  assert.deepEqual(r.get("Should & Send"), { status: "FAIL", message: "Frame 0x100 <never> seen", duration: 2000 });
});

test("Robot 6 output.xml: duration from starttime and endtime", () => {
  const xml = `<test id="s1-t1" name="A"><status status="SKIP" starttime="20261120 10:00:00.000" endtime="20261120 10:00:01.500">why</status></test>`;
  assert.deepEqual(robotResults(xml).get("A"), { status: "SKIP", message: "why", duration: 1500 });
});
