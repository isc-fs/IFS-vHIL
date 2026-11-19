import * as assert from "node:assert/strict";
import { test } from "node:test";

import { judge, parseStack, stackId } from "../src/stack";

const info = (owner: string) => ({ project: "ifs-vhil-1234abcd", port: 8080, owner });

test("parses vhil-docker.sh stack", () => {
  assert.deepEqual(parseStack("project=ifs-vhil-1234abcd\nport=8080\nowner=\n"), info(""));
  assert.deepEqual(parseStack("project=ifs-vhil-1234abcd\r\nport=8080\r\nowner=ifs-vhil\r\n"), info("ifs-vhil"));
  // A checkout from before the verb prints its usage instead.
  assert.equal(parseStack("usage: vhil-docker.sh ...\n"), undefined);
});

test("nothing on the port: start ours", () => {
  assert.deepEqual(judge(info(""), undefined, "abc"), { kind: "free" });
});

test("another checkout's stack is never framed as ours", () => {
  // The desktop app's copy on 8080 while your clone is open.
  assert.deepEqual(judge(info("ifs-vhil-99999999"), "abc", "abc"), { kind: "foreign", owner: "ifs-vhil-99999999" });
  assert.deepEqual(judge(info("ifs-vhil"), undefined, "abc"), { kind: "foreign", owner: "ifs-vhil" });
});

test("ours on older code is restarted; on the same code, framed", () => {
  assert.deepEqual(judge(info("ifs-vhil-1234abcd"), "old", "new"), { kind: "stale", started: "old", head: "new" });
  assert.deepEqual(judge(info("ifs-vhil-1234abcd"), "same", "same"), { kind: "ours" });
  // A server from before started_ref, or no git: left as it is.
  assert.deepEqual(judge(info("ifs-vhil-1234abcd"), undefined, "new"), { kind: "ours" });
  assert.deepEqual(judge(info("ifs-vhil-1234abcd"), "old", ""), { kind: "ours" });
});

test("a stack id per firmware repository, as the script accepts it", () => {
  const a = stackId("/home/me/IFS08-CE-ECU");
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(stackId("/home/me/IFS08-CE-ECU"), a);
  assert.notEqual(stackId("/home/me/IFS08-CE-AMS"), a);
  assert.match(stackId(""), /^[0-9a-f]{8}$/);
});
