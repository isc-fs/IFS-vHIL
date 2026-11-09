# vHIL desktop app

A window and a set-up wizard around [`bin/vhil`](../bin/vhil) (#373), so a
teammate runs the vHIL without a terminal. It sits next to the hosted web app
(`vhil/server`), it doesn't replace it: the window shows the same app,
started locally by `vhil ui`.

What it does, each step a `bin/vhil` command a teammate could run by hand:

1. **Tools:** checks Git, Docker and (macOS) Colima, and installs the last two
   with Homebrew on a click. On Linux and Windows it says what to install.
2. **vHIL files:** clones this repository into the app's data folder
   (`~/Library/Application Support/org.iscfs.vhil/IFS-vHIL`) at the app's
   release tag (`dev` for a dev build), and moves it on **Update**. Settings
   can point it at your own clone instead.
3. **Docker:** on macOS starts the Colima VM (`vhil vm`), on its own on later
   launches; elsewhere checks that Docker answers.
4. **Images and firmware:** `vhil setup`, with `vhil doctor --json` as the
   checklist.
5. **Open the vHIL:** `vhil ui --no-browser`, shown in the window once it
   answers. Quitting stops the app's containers (`vhil stop`); the VM keeps
   running, and the vHIL menu stops it.

The menu's **Set-up and Status** (⌘,) returns to the wizard. **Install the
`vhil` command** (Settings) links the same CLI into `/opt/homebrew/bin`.

## Install (teammates)

Download yours from the release. None is signed with a certificate (that
needs paid developer accounts, #373's "later" list), so each OS warns once.

| OS | File | Needs first | First launch |
|---|---|---|---|
| macOS | `vHIL_<v>_universal.dmg`: drag vHIL to Applications | Homebrew (the app installs Colima and Docker with it) | open it once, then **System Settings → Privacy & Security → Open Anyway** |
| Linux | `vHIL_<v>_amd64.deb` (`sudo apt install ./vHIL_*.deb`) or `vHIL_<v>_amd64.AppImage` (`chmod +x`) | Git and Docker Engine, with you in the `docker` group | none |
| Windows | `vHIL_<v>_x64-setup.exe` (installs for your user, no admin) | WSL2 with Ubuntu (`wsl --install -d Ubuntu`), Docker Desktop with **WSL integration** on for it, Git in WSL | SmartScreen: **More info → Run anyway** |

On Windows the app runs `bin/vhil` inside WSL (it is bash): its own copy of
the repository lives in WSL at `~/IFS-vHIL`, and a clone of your own must be
a WSL path too (`/home/<you>/...`; `/mnt/c/...` works but is slow). WSL
forwards the vHIL's `localhost:8080` to Windows.

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
backend. The icon's sources are `src-tauri/icons/source/`: `vhil-macos.png` (Apple's
template, 824 px body with its shadow) makes `icon.icns`, and `vhil.png`
(full-bleed) makes `icon.ico` and the PNGs Linux uses. Regenerate with
`npx tauri icon <source> -o <tmp>` for each, and copy those files over.
