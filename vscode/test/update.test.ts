import * as assert from "node:assert/strict";
import { test } from "node:test";

import { latestUrl, newer, parseLatest } from "../src/update";

const SLUG = "isc-fs/IFS-vHIL";

test("latest.json is read from the vscode-latest release", () => {
  assert.equal(latestUrl(SLUG), "https://github.com/isc-fs/IFS-vHIL/releases/download/vscode-latest/latest.json");
  const ok = `{"version": "0.6.31", "vsix": "https://github.com/${SLUG}/releases/download/vscode-v0.6.31/vhil-tests-0.6.31.vsix"}`;
  assert.deepEqual(parseLatest(ok, SLUG), { version: "0.6.31",
    vsix: `https://github.com/${SLUG}/releases/download/vscode-v0.6.31/vhil-tests-0.6.31.vsix` });
});

test("a latest.json that isn't one, or points elsewhere, is ignored", () => {
  assert.equal(parseLatest("not json", SLUG), undefined);
  assert.equal(parseLatest("null", SLUG), undefined);
  assert.equal(parseLatest(`{"version": "x", "vsix": "https://github.com/${SLUG}/releases/download/a/b.vsix"}`, SLUG),
    undefined);
  assert.equal(parseLatest('{"version": "1.0.0", "vsix": "https://evil.example/x.vsix"}', SLUG), undefined);
  assert.equal(parseLatest(`{"version": "1.0.0", "vsix": "https://github.com/other/repo/releases/download/a/b.vsix"}`,
    SLUG), undefined);
});

test("versions compare by number", () => {
  assert.ok(newer("0.6.31", "0.6.9"));
  assert.ok(newer("0.7.0", "0.6.99"));
  assert.ok(newer("1.0.0", "0.9.9"));
  assert.ok(!newer("0.6.31", "0.6.31"));
  assert.ok(!newer("0.6.30", "0.6.31"));
  assert.ok(!newer("0.6", "0.5.0"));
});
