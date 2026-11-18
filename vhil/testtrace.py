"""A per-test trace of the buses (#426) and the failure snapshot's C frames (#423).

When a test that used a `Sim` ends, one trace is written to the run's
results, two files with the same stem:

    <dir>/<test id>.trace.jsonl   one JSON object per line, each with a `kind`
    <dir>/<test id>.log           the CAN frames, candump-style:
                                  (12.345678) can_acu 100#DEADBEEF

Records (every one has `kind`; those from a Sim have `sim`, its system id,
`#2`... when a test starts two of the same):

    meta      version, test, outcome, end_us (virtual time the test ended at,
              the failure's when it failed), sims [{sim, system, boards, buses,
              end_us, decoded: [bus,...], context_us}]; context_us only on a
              Sim the test used without running it (a module fixture's,
              asserted on as it stood): its records are the CONTEXT_US of
              virtual time before the test instead of an empty trace
    can       t_us (frame start), end_us, sim, bus, node, id, ext, remote, dlc,
              data (hex), outcome (ok | ack | lost; a hub bus' frames are ok),
              and, when the firmware's contract knows the id: name, sender,
              board, signals {field: value}, labels {field: text}
    uart      sim, board, uart ("UART4"), line; t_us is null: Renode's file
              backend keeps bytes, not times
    gpio      t_us, sim, board, pin ("sysbus.gpioPortB:6"), level (0 | 1)
    radio     t_us, sim, device, board, data (hex)
    snapshot  (a failed test only) sim, board, time_us, summary, exception,
              task, fault {CFSR, HFSR}, frames [{symbol, file, line, address}],
              bus_tail [the last BUS_TAIL decoded can records before the failure]
    error     sim, what, message: a step of the collection that failed

Host-only and pure but for `collect`, which reads a live Sim; `install`
plugs the hooks into a pytest run (tests/conftest.py). Collecting never
fails or hides a test.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Optional

import pytest

from vhil import candef

VERSION = 1
BUS_TAIL = 30
CONTEXT_US = 1_000_000


# -- decoding -------------------------------------------------------------------


class Decoder:
    """Frames of a bus -> the firmware's own names and signals, from the
    `buses` of vhil.contract.bus_contract (or the server's /contract), which
    is JSON: {bus: {id: message}}. A frame no message of the bus names
    decodes to nothing."""

    def __init__(self, buses: Optional[dict] = None):
        self.buses = buses or {}

    def decoded(self) -> list[str]:
        return [b for b, m in self.buses.items() if m]

    def decode(self, bus: str, can_id: int, data: bytes) -> dict:
        msg = (self.buses.get(bus) or {}).get(str(can_id))
        if msg is None:
            return {}
        signals, labels = {}, {}
        for f in msg["fields"]:
            if f["start"] + f["length"] > 8 * len(data) and not f["be"]:
                continue
            try:
                get = candef.get_be if f["be"] else candef.get_le
                raw = get(data, f["start"], f["length"])
            except IndexError:
                continue
            if f["signed"] and raw >> (f["length"] - 1):
                raw -= 1 << f["length"]
            signals[f["name"]] = raw * f["factor"] + f["offset"]
            text = (f.get("values") or {}).get(str(raw))
            if text is not None:
                labels[f["name"]] = text
        out = {"name": msg["name"], "sender": msg["sender"], "board": msg.get("board"),
               "signals": signals}
        if labels:
            out["labels"] = labels
        return out


# -- records ----------------------------------------------------------------------


def can_record(sim: str, bus: str, decoder: Decoder, *, t_us: int, end_us: int, node: str,
               can_id: int, ext: bool, remote: bool, dlc: int, data: bytes,
               outcome: str = "ok") -> dict:
    return {"kind": "can", "t_us": t_us, "end_us": end_us, "sim": sim, "bus": bus, "node": node,
            "id": can_id, "ext": ext, "remote": remote, "dlc": dlc, "data": data.hex(),
            "outcome": outcome, **decoder.decode(bus, can_id, data)}


def stamp(t_us: int) -> str:
    return f"({t_us // 1_000_000}.{t_us % 1_000_000:06d})"


def candump_line(r: dict) -> str:
    """`(12.345678) can_acu 100#DEADBEEF` (8 hex digits of ID when extended,
    `#R` for a remote frame), as candump -L's `(t) iface ID#DATA`."""
    ident = f"{r['id']:08X}" if r["ext"] else f"{r['id']:03X}"
    return f"{stamp(r['t_us'])} {r['bus']} {ident}#{'R' if r['remote'] else r['data'].upper()}"


def candump(records: Iterable[dict]) -> str:
    """The .log text: the frames that went through (outcome ok), in time order."""
    frames = sorted((r for r in records if r["kind"] == "can" and r["outcome"] == "ok"),
                    key=lambda r: r["t_us"])
    return "".join(candump_line(r) + "\n" for r in frames)


def bus_tail(records: Iterable[dict], until_us: int, n: int = BUS_TAIL) -> list[dict]:
    """The last n frames that went through up to until_us, oldest first."""
    frames = sorted((r for r in records if r["kind"] == "can" and r["outcome"] == "ok"
                     and r["t_us"] <= until_us), key=lambda r: r["t_us"])
    keep = ("t_us", "bus", "id", "data", "name", "sender", "signals")
    return [{k: r[k] for k in keep if k in r} for r in frames[-n:]]


def write(directory: Path, test: str, records: list[dict]) -> Path:
    """Write the trace of `test` into `directory`; returns the .jsonl."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^\w.-]+", "_", test).strip("_")[:150] or "test"
    path = directory / f"{stem}.trace.jsonl"
    path.write_text("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in records),
                    encoding="utf-8")
    (directory / f"{stem}.log").write_text(candump(records), encoding="utf-8")
    return path


def read(path: Path) -> list[dict]:
    out = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


# -- C frames of a snapshot -----------------------------------------------------


def parse_lines(text: str) -> list[Optional[tuple[str, int]]]:
    from vhil.coverage import parse_addr2line
    return parse_addr2line(text)


def _addr2line(image: Path, addresses: list[int]) -> list[Optional[tuple[str, int]]]:
    from vhil.coverage import ADDR2LINE
    if not shutil.which(ADDR2LINE):
        return [None] * len(addresses)
    res = subprocess.run([ADDR2LINE, "-e", str(image)], capture_output=True, text=True,
                         input="\n".join(f"0x{a:x}" for a in addresses) + "\n", timeout=30)
    return parse_lines(res.stdout) if res.returncode == 0 else [None] * len(addresses)


def resolve_frames(images: Iterable[Path], registers: dict[str, int],
                   lines: Callable[[Path, list[int]], list] = _addr2line) -> list[dict]:
    """[{symbol, file, line, address}], innermost first: where the board was
    (PC) and where it was called from (LR), against its images (app, then
    bootloader). The registers hold no more of the stack; file and line are
    null for an image built without debug info or a host without the
    toolchain."""
    from vhil import elf
    images = list(images)
    frames, seen = [], set()
    for reg in ("PC", "LR"):
        if reg not in registers:
            continue
        address = registers[reg] & ~1
        # A return address points after the call: look the line up inside it.
        probe = address if reg == "PC" else max(address - 2, 0)
        for image in images:
            try:
                sym = elf.symbol_at(image, probe)
            except (OSError, ValueError, KeyError):
                continue
            if sym is None:
                continue
            if address in seen:
                break
            seen.add(address)
            try:
                where = lines(image, [probe])[0]
            except (OSError, subprocess.SubprocessError, ValueError):
                where = None
            frames.append({"symbol": sym[0], "file": where[0] if where else None,
                           "line": where[1] if where else None, "address": f"0x{address:08X}"})
            break
    return frames


def snapshot_record(sim: str, snap, records: list[dict], lines=_addr2line) -> dict:
    """The failure record of one board (vhil/snapshot.py BoardSnapshot)."""
    from vhil.snapshot import exception_name
    r = snap.registers
    until = snap.time_us if snap.time_us is not None else max(
        (x["t_us"] for x in records if x["kind"] == "can"), default=0)
    return {"kind": "snapshot", "sim": sim, "board": snap.board, "time_us": snap.time_us,
            "summary": snap.summary(),
            "exception": exception_name(r["CPSR"] & 0x1FF) if "CPSR" in r else None,
            "task": snap.current_task,
            "fault": {k: f"0x{snap.faults[k]:08X}" for k in ("CFSR", "HFSR") if k in snap.faults},
            "frames": resolve_frames(snap.images, r, lines),
            "bus_tail": bus_tail([x for x in records if x.get("sim") == sim], until)}


# -- collecting from a Sim --------------------------------------------------------


@dataclass
class Cursor:
    """What of a Sim an earlier test already took, for a Sim that outlives it
    (a session fixture)."""
    us: int = 0
    uart: dict = field(default_factory=dict)       # "<board>.<UART>" -> bytes read


_contracts: dict = {}


def decoder_of(sim) -> Decoder:
    """The decoder of a Sim's firmware (its ELFs' .def files); no names when
    a board has none (not built from source here)."""
    from vhil.contract import bus_contract
    key = (sim.system.id, tuple(sorted((b, str(p)) for b, p in sim.firmware.items()
                                       if "." not in b)))
    if key not in _contracts:
        elfs = {b: Path(p) for b, p in sim.firmware.items() if b in sim.system.boards}
        _contracts[key] = Decoder(bus_contract(sim.system, elfs)["buses"])
    return _contracts[key]


def collect(sim, label: str, cursor: Cursor) -> tuple[list[dict], int]:
    """(records, end_us) of everything a Sim recorded since `cursor`, which it
    advances. Each step that fails becomes an `error` record."""
    out: list[dict] = []

    def step(what, fn):
        try:
            return fn()
        except Exception as e:   # noqa: BLE001 - recorded, never raised
            out.append({"kind": "error", "sim": label, "what": what,
                        "message": f"{type(e).__name__}: {e}"})

    end = step("time", sim.now_us) or cursor.us
    decoder = step("contract", lambda: decoder_of(sim)) or Decoder()
    for bus in sim.system.buses:
        if sim.system.buses[bus].get("kind") != "can":
            continue
        bus_obj = sim.can(bus)

        def frames(bus=bus, bus_obj=bus_obj):
            if bus_obj.arbitrated:
                for f in bus_obj.timeline(cursor.us):
                    out.append(can_record(label, bus, decoder, t_us=int(f.start_ns // 1000),
                                          end_us=int(f.end_ns // 1000), node=f.node, can_id=f.id,
                                          ext=f.extended, remote=f.remote, dlc=f.dlc,
                                          data=f.data, outcome=f.outcome))
            else:
                for f in bus_obj.frames(since_us=cursor.us):
                    out.append(can_record(label, bus, decoder, t_us=f.t_us, end_us=f.t_us,
                                          node="", can_id=f.id, ext=f.extended, remote=False,
                                          dlc=len(f.data), data=f.data))
        step(f"can {bus}", frames)
    for key, path in sorted(sim.uart_logs.items()):
        board, _, uart = key.partition(".")

        def uart_lines(key=key, path=path, board=board, uart=uart):
            raw = Path(path).read_bytes()
            new = raw[cursor.uart.get(key, 0):]
            cursor.uart[key] = len(raw)
            for line in new.decode("utf-8", "replace").splitlines():
                out.append({"kind": "uart", "t_us": None, "sim": label, "board": board,
                            "uart": uart, "line": line})
        step(f"uart {key}", uart_lines)
    for board in sim.system.boards:
        def gpio(board=board):
            for e in sim.io(board).edges(since_us=cursor.us):
                out.append({"kind": "gpio", "t_us": e.t_us, "sim": label, "board": board,
                            "pin": e.pin, "level": int(e.level)})
        step(f"gpio {board}", gpio)
    for device, board in sim.system.radios():
        def radio(device=device, board=board):
            for p in sim.radio(device).payloads(cursor.us):
                out.append({"kind": "radio", "t_us": p.t_us, "sim": label, "device": device,
                            "board": board, "data": p.data.hex()})
        step(f"radio {device}", radio)
    cursor.us = max(cursor.us, end)
    return out, end


# -- the pytest side ----------------------------------------------------------------

# nodeid -> {"trace": Path, "snapshots": [snapshot records]} of a finished test:
# what vhil/pytest_vscode.py puts in its result.
RESULTS: dict[str, dict] = {}
_SNAPSHOTS: dict[str, list] = {}       # nodeid -> [(system id, [BoardSnapshot])]


def keep_snapshots(nodeid: str, taken: list) -> None:
    """The failure snapshots a conftest took ([(system id, [BoardSnapshot])])."""
    _SNAPSHOTS.setdefault(nodeid, []).extend(taken)


class Plugin:
    """Collects each Sim a test touched and writes its trace when it ends."""

    def __init__(self, directory: Path, root: Path):
        self.dir, self.root = Path(directory), Path(root)
        self.item = None
        self.mark = 0
        self.outcome = "passed"
        self.sims: list[tuple[str, str, list, int]] = []   # (label, system, records, end_us)
        self.taken: set[int] = set()                        # id(sim) of what this test ran
        self.context_labels: set[str] = set()               # labels of context-only Sims
        self.args: list = []                                # the test's arguments (fixtures)
        self.cursors: dict[int, Cursor] = {}               # id(sim) -> Cursor
        self.seen: list = []                                # keeps a Sim's id from being reused

    def _label(self, system: str) -> str:
        n = sum(1 for _, s, _, _ in self.sims if s == system)
        return system if n == 0 else f"{system}#{n + 1}"

    def take(self, sim) -> None:
        """A Sim this test touched: its records since the last time."""
        if self.item is None or getattr(sim, "last_activity", 0) <= self.mark:
            return
        cursor = self.cursors.setdefault(id(sim), Cursor())
        self.seen.append(sim)
        before = cursor.us
        label = self._label(sim.system.id)
        records, end = collect(sim, label, cursor)
        # Touched without running (a failure snapshot reads registers): no
        # time of its own, so `context` gives it the time before.
        if end <= before and before > 0:
            return
        self.taken.add(id(sim))
        self.sims.append((label, sim.system.id, records, end))

    def context(self, sim) -> None:
        """A Sim the test used but didn't run: what it recorded in the
        CONTEXT_US before now. Its cursor stays where it was, and UART lines
        (bytes without times) are left out."""
        if id(sim) in self.taken:
            return
        try:
            now = sim.now_us()
            uart = {k: Path(p).stat().st_size for k, p in sim.uart_logs.items() if Path(p).exists()}
        except Exception:   # noqa: BLE001 - a trace never fails a test
            return
        label = self._label(sim.system.id)
        records, end = collect(sim, label, Cursor(us=max(0, now - CONTEXT_US), uart=uart))
        self.sims.append((label, sim.system.id, records, end))
        self.context_labels.add(label)

    # hooks

    def pytest_runtest_setup(self, item):
        from vhil import sim as sim_module
        self.item, self.outcome, self.sims = item, "passed", []
        self.taken, self.context_labels, self.args = set(), set(), []
        self.mark = sim_module.activity()
        _SNAPSHOTS.pop(item.nodeid, None)

    def pytest_runtest_call(self, item):
        # pytest drops item.funcargs at teardown, before logfinish.
        self.args = list((getattr(item, "funcargs", None) or {}).values())

    def pytest_runtest_logreport(self, report):
        if report.failed:
            self.outcome = "failed"

    @pytest.hookimpl(tryfirst=True)       # before pytest_vscode's result line
    def pytest_runtest_logfinish(self, nodeid, location):
        item, self.item = self.item, None
        if item is None:
            return
        try:
            from vhil import sim as sim_module
            self.item = item
            live = list(sim_module.live_sims())
            for sim in live:
                self.take(sim)
            # A fixture's Sim the test only asserted on: the time before it.
            used = [v for v in self.args if any(v is s for s in live)]
            for sim in used:
                self.context(sim)
            self.item = None
            self.finish(nodeid)
        except Exception:   # noqa: BLE001 - a trace never fails a test
            pass
        finally:
            self.item = None
            _SNAPSHOTS.pop(nodeid, None)

    def finish(self, nodeid: str) -> None:
        if not self.sims:
            return
        records: list[dict] = []
        for _, _, recs, _ in self.sims:
            records += recs
        end = max(e for *_, e in self.sims)
        snapshots = []
        if self.outcome == "failed":
            for system_id, snaps in _SNAPSHOTS.get(nodeid, []):
                label = next((lab for lab, s, _, _ in self.sims if s == system_id), system_id)
                snapshots += [snapshot_record(label, s, records) for s in snaps]
        meta = {"kind": "meta", "version": VERSION, "test": nodeid, "outcome": self.outcome,
                "end_us": end,
                "sims": [{"sim": lab, "system": s, "end_us": e,
                          "decoded": sorted({r["bus"] for r in recs
                                             if r["kind"] == "can" and "name" in r}),
                          **({"context_us": CONTEXT_US} if lab in self.context_labels else {})}
                         for lab, s, recs, e in self.sims]}
        path = write(self.dir, nodeid, [meta, *records, *snapshots])
        RESULTS[nodeid] = {"trace": path, "snapshots": snapshots}


def install(config) -> Optional[Plugin]:
    """Trace every test of this run that uses a Sim, if the run keeps results:
    --vhil-trace-dir, else <--sim-log-dir>/traces, else <dir of --vscode-out>/traces."""
    from vhil import sim as sim_module
    opt = config.getoption
    explicit, logs, vscode = opt("--vhil-trace-dir", None), opt("--sim-log-dir", None), \
        opt("--vscode-out", None)
    directory = (Path(explicit) if explicit else Path(logs) / "traces" if logs
                 else Path(vscode).parent / "traces" if vscode else None)
    if directory is None:
        return None
    plugin = Plugin(directory.resolve(), Path(config.rootpath).resolve())
    sim_module.INSTRUMENT.on_stop = plugin.take
    config.pluginmanager.register(plugin, "vhil-testtrace")
    return plugin
