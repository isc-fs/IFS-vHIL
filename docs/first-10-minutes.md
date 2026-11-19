# Your first 10 minutes

From nothing to CAN frames from the ECU's real firmware on your screen. Once
it is set up, it takes about 10 minutes. The first set-up takes ~15 minutes,
or ~30 minutes more when no published image fits and the images are built on
your machine.

## 1. Install (once)

Use **either** of these. Both end with the same app in your browser.

- **Desktop app (no terminal).** Download the newest `vhil-v…` release from
  [isc-fs/iskapps](https://github.com/isc-fs/iskapps/releases), install it
  ([per-OS notes](../app/README.md#install-teammates)) and open **ISC vHIL**.
  The wizard installs what is missing, fetches the images and builds the
  ECU, AMS and uDV firmware. It opens the vHIL when everything is ready.
- **Terminal.**

  ```sh
  git clone https://github.com/isc-fs/IFS-vHIL && cd IFS-vHIL && git switch dev
  brew install colima docker   # macOS; on Linux install Docker Engine
  bin/vhil setup               # VM (macOS), images, ECU/AMS/uDV firmware
  bin/vhil doctor              # says what to fix if anything is missing
  bin/vhil ui                  # opens http://localhost:8080/editor/
  ```

## 2. Open a system

A **system** is a set of boards wired together, described by one file in
`systems/`. In the sidebar, **Systems** lists them. Click **ecu**: one
MainLite in the ECU role and its three CAN buses. Click a node to see its
properties in the **Inspector** on the right.

## 3. Run it

Set **Run for** to `5000` ms and press **Run** (F5). The run is queued, then
the emulator boots the board. Every MainLite spends its first **2 s** in the
CAN bootloader before it jumps to the app, as on the car, so a run shorter
than ~3 s shows almost nothing.

## 4. Watch it

When the run finishes, it opens for replay. Drag the scrubber in the top bar
to move through time.

- **Bus:** every CAN frame, decoded. Frames from the app appear after 2 s.
- **State:** each board's state: "in bootloader" first, then the app's state
  and faults.
- **Signals:** plots of decoded signals over time.
- **Log** and **Artifacts:** what the run printed and the files it kept.

## 5. Next

- **Check** (in the Inspector) validates a system you
  edit. From a terminal: `bin/vhil run python -m vhil.system validate systems/ecu.yaml`.
- **Scenarios** script stimuli and expectations on a run:
  [scenarios.md](scenarios.md). **● Live** runs a system you can poke while
  it runs: [live-session.md](live-session.md).
- Tests from a terminal: `bin/vhil test unit`, then
  `bin/vhil test tests/sim/test_ams_boot.py`.
- Changing the vHIL itself: [CONTRIBUTING.md](../CONTRIBUTING.md).
