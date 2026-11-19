import * as assert from "node:assert/strict";
import { test } from "node:test";

import { compareUrl, systemsIn, unpushed } from "../src/branches";

test("a saved branch is unpushed until origin has it at the same commit", () => {
  const refs = [
    "refs/heads/dev aaa",
    "refs/heads/vhil/ines/dash aaa1",
    "refs/heads/vhil/ines/imu bbb",
    "refs/heads/pushed ccc",
    "refs/heads/moved ddd",
    "refs/remotes/origin/dev aaa",
    "refs/remotes/origin/pushed ccc",
    "refs/remotes/origin/moved dd0",
    "",
  ].join("\n");
  assert.deepEqual(unpushed(refs, "dev"), ["moved", "vhil/ines/dash", "vhil/ines/imu"]);
  assert.deepEqual(unpushed("", "dev"), []);
});

test("the systems a commit changed", () => {
  assert.deepEqual(systemsIn("systems/dash.yaml\nsystems/dash.scenarios/a.yaml\nREADME.md\nsystems/ams.yaml\n"),
    ["ams", "dash"]);
});

test("the PR page is GitHub's compare, for https and ssh remotes", () => {
  assert.equal(compareUrl("https://github.com/isc-fs/IFS-vHIL", "dev", "vhil/ines/dash"),
    "https://github.com/isc-fs/IFS-vHIL/compare/dev...vhil/ines/dash?expand=1");
  assert.equal(compareUrl("git@github.com:isc-fs/IFS-vHIL.git", "dev", "a b"),
    "https://github.com/isc-fs/IFS-vHIL/compare/dev...a%20b?expand=1");
  assert.equal(compareUrl("https://gitlab.example/x/y", "dev", "b"), undefined);
});
