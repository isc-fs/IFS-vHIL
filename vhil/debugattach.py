"""Hold one board of a test's Sim for a debugger outside the container: the
VS Code extension's Debug profile (#425).

    VHIL_DEBUG=<board>:<port>   e.g. ecu:3333

The first Sim of the process with that board starts the board's GDB stub
(Renode's, models/renode/VhilGdb.cs, docs/debugger.md) and waits for a GDB
on <port> before `Sim.start` returns, so breakpoints go in before the board
runs its first instruction. The stub listens on 127.0.0.1 only; a forwarder
here listens on every interface of the container, whose <port>
vhil-docker.sh publishes on the host's 127.0.0.1 (VHIL_DEBUG_PORT).

What the debugger needs is written to VHIL_DEBUG_DIR (default
results/vscode/debug, in /work): the board's images (`<board>.elf`, its
bootloader `<board>.bootloader.elf`) and `ready.json` {board, port, system,
images, sources}, `sources` the container paths they were built in. The
extension waits for ready.json, then attaches.

While GDB holds the board, a RunFor waits for it as it waits for the
worker's debugger (lockstep: no firmware timeout fires on any board), so
the monitor's socket timeout is lifted for this Sim. A test's own
wall-clock limits don't apply in virtual time; nothing else times out.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import threading
from pathlib import Path
from typing import Optional

from vhil import renode as rn

ENV = "VHIL_DEBUG"
WAIT_S = float(os.environ.get("VHIL_DEBUG_WAIT_S", "300"))

_done = False


def parse(value: str) -> Optional[tuple[str, int]]:
    """'ecu:3333' -> ('ecu', 3333); anything else None."""
    board, _, port = value.strip().partition(":")
    if not board or not port.isdigit() or not 0 < int(port) < 65536:
        return None
    return board, int(port)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _pipe(a: socket.socket, b: socket.socket) -> None:
    try:
        while True:
            data = a.recv(65536)
            if not data:
                break
            b.sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def _serve(listener: socket.socket, target: int, first: threading.Event) -> None:
    """Every GDB that connects, to the stub; the first one sets `first`."""
    while True:
        try:
            client, _ = listener.accept()
        except OSError:
            return
        try:
            stub = socket.create_connection(("127.0.0.1", target), timeout=10)
            stub.settimeout(None)
        except OSError:
            client.close()
            continue
        client.settimeout(None)
        for a, b in ((client, stub), (stub, client)):
            threading.Thread(target=_pipe, args=(a, b), daemon=True).start()
        first.set()


def ready_info(board: str, port: int, system: str, images: list[Path], out: Path) -> dict:
    """ready.json's content, the images copied into `out` (pure but for the copy)."""
    names = [f"{board}.elf", f"{board}.bootloader.elf"]
    copied, sources = [], []
    for image, name in zip(images, names):
        dest = out / name
        shutil.copyfile(image, dest)
        copied.append(name)
        # The build tree: /vhil/fw/<id>@<ref>/build/X.elf -> /vhil/fw/<id>@<ref>.
        parts = Path(image).parts
        root = Path(*parts[:4]) if len(parts) > 4 and parts[1:3] == ("vhil", "fw") else Path(image).parent
        sources.append(str(root))
    return {"board": board, "port": port, "system": system, "images": copied, "sources": sources}


def maybe_attach(sim) -> None:
    """Called by Sim.start: hold the board VHIL_DEBUG names, once a process."""
    global _done
    spec = parse(os.environ.get(ENV, ""))
    if _done or spec is None:
        return
    board, port = spec
    if board not in sim.system.boards:
        return
    _done = True
    out = Path(os.environ.get("VHIL_DEBUG_DIR", "results/vscode/debug")).resolve()
    out.mkdir(parents=True, exist_ok=True)
    (out / "ready.json").unlink(missing_ok=True)
    stub = _free_port()
    sim.monitor(f"machine StartVhilGdbServer {stub} {rn.quote(str(out / (board + '.halts')))}", board=board)
    # A RunFor waits for as long as GDB holds the board.
    sim._monitor._sock.settimeout(None)
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("0.0.0.0", port))
    listener.listen(4)
    first = threading.Event()
    threading.Thread(target=_serve, args=(listener, stub, first), daemon=True,
                     name=f"vhil-debug-{board}").start()
    info = ready_info(board, port, sim.system.id, sim.images_of(board), out)
    (out / "ready.json").write_text(json.dumps(info, indent=2))
    print(f"vhil: {board} of {sim.system.id} waits for a debugger on port {port}", flush=True)
    if not first.wait(WAIT_S):
        raise TimeoutError(f"no debugger attached to {board} on port {port} within {WAIT_S:.0f} s")
