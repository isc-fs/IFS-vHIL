import * as assert from "node:assert/strict";
import { test } from "node:test";

import { cloneAdvice, parseClone } from "../src/clone";
import { unpushed } from "../src/branches";
import { doctorFindings } from "../src/status";
import { accountRow, cloneRow, rows } from "../src/systemsView";

const st = (extra: string) => parseClone(`branch=dev\nfetched=1\nupstream=origin/dev\nahead=0\nbehind=0\n${extra}`)!;

test("vhil-clone status parses; detached or not a clone is nothing", () => {
  assert.deepEqual(st(""), { branch: "dev", fetched: true, upstream: "origin/dev", ahead: 0, behind: 0, dirty: false, merged: 0 });
  assert.equal(parseClone("detached=1\n"), undefined);
  assert.equal(parseClone(""), undefined);
});

test("behind: Update; merged into dev: Switch (not when dirty); diverged: git's; up to date: nothing", () => {
  assert.equal(cloneAdvice(st("")), undefined);
  const behind = parseClone("branch=dev\nfetched=1\nupstream=origin/dev\nahead=0\nbehind=3\n")!;
  assert.equal(cloneAdvice(behind)?.action, "update");
  assert.match(cloneAdvice(behind)!.text, /3 commits behind origin\/dev/);
  const merged = parseClone("branch=feat/zed-f9p\nfetched=1\nmerged=40\n")!;
  assert.equal(cloneAdvice(merged)?.action, "switch");
  assert.equal(cloneAdvice({ ...merged, dirty: true })?.action, undefined);
  const diverged = parseClone("branch=feat/x\nupstream=origin/feat/x\nahead=2\nbehind=1\n")!;
  assert.equal(cloneAdvice(diverged)?.action, undefined);
  assert.match(cloneAdvice(diverged)!.detail, /GitHub didn't answer/);
});

test("the view: a clone row only when it needs a look, the account row when known", () => {
  const behind = parseClone("branch=dev\nfetched=1\nupstream=origin/dev\nbehind=1\n")!;
  assert.equal(cloneRow(behind)?.command, "vhil.updateClone");
  assert.equal(cloneRow(st("")), undefined);
  assert.equal(accountRow("ines").command, "vhil.signOut");
  assert.equal(accountRow(null).command, "vhil.signIn");
  const state = { dockerUp: true, editorUp: false, context: "x" };
  assert.deepEqual(rows([], { ...state, account: "ines", clone: behind }, false).map((r) => r.kind), ["status", "clone", "account"]);
  assert.deepEqual(rows([], state, false).map((r) => r.kind), ["status"]);
});

test("team store branches are not pull request branches", () => {
  const refs = "refs/heads/feat/x aaa\nrefs/heads/shared/ines/ams bbb\nrefs/heads/dev ccc\nrefs/remotes/origin/dev ccc\n";
  assert.deepEqual(unpushed(refs, "dev"), ["feat/x"]);
});

test("doctor's compose and disk checks join Diagnose", () => {
  const json = JSON.stringify({ ok: true, checks: [
    { level: "ok", id: "docker", message: "docker CLI" },
    { level: "warn", id: "compose", message: "docker compose plugin missing: brew install docker-compose" },
    { level: "ok", id: "disk", message: "954 GB free for Docker" },
  ] });
  assert.deepEqual(doctorFindings(json), [
    { ok: false, label: "Docker compose", detail: "docker compose plugin missing: brew install docker-compose" },
    { ok: true, label: "Disk", detail: "954 GB free for Docker" },
  ]);
  assert.deepEqual(doctorFindings("not json"), []);
});
