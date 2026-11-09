# vHIL desktop app

A window and a set-up wizard around [`bin/vhil`](../bin/vhil) (#373), so a
teammate runs the vHIL without a terminal. It sits next to the hosted web app
(`vhil/server`), it doesn't replace it: the window shows the same app,
started locally by `vhil ui`.

What it does, each step a `bin/vhil` command a teammate could run by hand:

1. **Tools:** checks Git, Docker and (macOS) Colima, and installs the last two
   with Homebrew on a click.
2. **vHIL files:** clones this repository into the app's data folder
   (`~/Library/Application Support/org.iscfs.vhil/IFS-vHIL`) at the app's
   release tag (`dev` for a dev build), and moves it on **Update**. Settings
   can point it at your own clone instead.
3. **Docker VM:** starts Colima (`vhil vm`), on its own on later launches.
4. **Images and firmware:** `vhil setup`, with `vhil doctor --json` as the
   checklist.
5. **Open the vHIL:** `vhil ui --no-browser`, shown in the window once it
   answers. Quitting stops the app's containers (`vhil stop`); the VM keeps
   running, and the vHIL menu stops it.

The menu's **Set-up and Status** (⌘,) returns to the wizard. **Install the
`vhil` command** (Settings) links the same CLI into `/opt/homebrew/bin`.

## Install (teammates)

Download `vHIL_<version>_universal.dmg` from the release, drag vHIL to
Applications. The app is not notarised (that needs an Apple developer
account, #373's "later" list), so macOS blocks the first launch: open it
once, then **System Settings → Privacy & Security → Open Anyway**.

## Build

Tauri 2 (Rust + the system web view), pinned in `src-tauri/Cargo.toml` and
`package-lock.json`. Needs Rust (rustup) and Node.

```sh
cd app
npm ci
npx tauri dev                                  # run it, rebuilt on change
npx tauri build --debug --bundles app          # a debug .app
npx tauri build --target universal-apple-darwin --bundles app,dmg   # what CI ships
```

[`app.yml`](../.github/workflows/app.yml) builds it on every PR that changes
`app/` and attaches the `.dmg` to a release tag's release. The page in
`ui/` is plain HTML and JS (no build step); `src-tauri/src/main.rs` is the
backend. The icon's source is `src-tauri/icons/icon.svg`: regenerate the set
with `npx tauri icon <1024px png> -o src-tauri/icons` (then delete the
mobile ones it adds).
