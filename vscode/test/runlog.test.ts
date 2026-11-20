import * as assert from "node:assert/strict";
import { test } from "node:test";

import { isRunLog, runLogLabel, runLogName, toPrune } from "../src/runlog";

test("a run log's name sorts by time and reads back as its label", () => {
  const n = runLogName(new Date(Date.UTC(2026, 10, 20, 10, 4, 5, 6)), 4242);
  assert.equal(n, "2026-11-20T10-04-05-006Z-4242.log");
  assert.ok(isRunLog(n) && !isRunLog("collect-4242.jsonl"));
  assert.equal(runLogLabel(n), "2026-11-20 10:04:05 UTC");
});

test("only the newest logs are kept, and nothing else is touched", () => {
  const names = ["2026-11-20T10-00-00-000Z-1.log", "2026-11-19T10-00-00-000Z-1.log",
                 "2026-11-21T10-00-00-000Z-1.log", "notes.txt"];
  assert.deepEqual(toPrune(names, 2), ["2026-11-19T10-00-00-000Z-1.log"]);
  assert.deepEqual(toPrune(names, 5), []);
});
