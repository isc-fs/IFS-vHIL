# Changelog

The extension's version is `package.json`'s major.minor plus the number of
commits under `vscode/` (`.github/workflows/vscode.yml`); every merge into
`dev` publishes one on the `vscode-latest` release, which the extension
checks once a day (**vHIL: Check for updates**).

## 0.7

- **Your GitHub account** in the Systems view: sign in (GitHub's device
  flow, the code copied) and out, the same account as the desktop app and
  `vhil login`; the running vHIL picks it up without a restart (#468).
- **Your clone:** behind its upstream offers **Update** (a fast-forward);
  on a branch already merged into `dev`, **Switch to dev** (#468).
- **The stack:** the editor tab frames only this checkout's vHIL, on this
  checkout's code: another vHIL on the port is stopped only if you say so,
  one started at an older commit is restarted. **Stop the vHIL** stops its
  containers whoever started them; each firmware repository gets a vHIL and
  port of its own; `vhil.webPort` (#467).
- **vHIL: Set up the vHIL** (`vhil setup`), Diagnose with `vhil doctor`'s
  compose and disk checks, **Install the vhil command**, and a "open in
  WSL" prompt on native Windows.
- Team store branches (`shared/<login>/*`) are shared from the editor's
  Team view, not listed as pull requests to push.

The extension keeps its id, `isc-fs.vhil-tests`: a new id would install as
a second extension beside it instead of updating it.

## 0.6

- The system editor in a tab (with the VS Code handshake: open, saved,
  external links), the Systems view, new parts, Debug Test, the Trace
  panel, run-on-save, firmware repositories (your working tree in runs and
  the editor's Run), and updates from `vscode-latest`.
