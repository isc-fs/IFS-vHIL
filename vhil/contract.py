"""A system's CAN contract, pure Python (no web framework): the merge
vhil/server/decode.py serves at GET /api/runs/{id}/contract, and the test
trace (vhil/testtrace.py) decodes frames with. See vhil/server/decode.py's
module doc for how the per-bus merge works."""
from __future__ import annotations

from collections import Counter
from pathlib import Path

from vhil import candef, stateview
from vhil.system import System


def _sender(messages: dict[int, candef.Message]) -> str:
    counts = Counter(m.sender for m in messages.values())
    return counts.most_common(1)[0][0] if counts else ""


def bus_contract(system: System, elfs: dict[str, Path]) -> dict:
    """{buses: {bus: {id: message}}, boards, conflicts}: the contract each
    board's application ELF (`elfs`, board -> ELF) speaks, merged per bus as
    the module doc says. A board whose ELF's source has no .def files (not
    built here) is listed with its error and decodes nothing."""
    out: dict = {"buses": {}, "boards": {}, "conflicts": []}
    contracts: dict[str, dict[int, candef.Message]] = {}
    for board, elf in elfs.items():
        try:
            contracts[board] = candef.load(elf.parent)
        except (OSError, ValueError) as e:
            out["boards"][board] = {"elf": str(elf), "error": str(e)}
            continue
        out["boards"][board] = {"elf": str(elf), "source": str(candef.messages_dir(elf.parent)),
                                "sender": _sender(contracts[board]),
                                "messages": len(contracts[board]),
                                "buses": system.contract_buses(board)}
    def owns(entry: tuple[str, candef.Message]) -> bool:
        board, msg = entry
        return msg.sender == out["boards"][board]["sender"]

    for bus in system.buses:
        merged: dict[int, tuple[str, candef.Message]] = {}
        for board in system.boards:
            if board not in contracts or bus not in out["boards"][board]["buses"]:
                continue
            for can_id, msg in contracts[board].items():
                win, lose = merged.get(can_id), (board, msg)
                if win is None:
                    merged[can_id] = lose
                    continue
                if not owns(win) and owns(lose):
                    win, lose = lose, win
                merged[can_id] = win
                if (win[1].dlc, win[1].fields) != (lose[1].dlc, lose[1].fields):
                    out["conflicts"].append({"bus": bus, "id": can_id, "name": win[1].name,
                                             "kept": win[0], "dropped": lose[0]})
        out["buses"][bus] = {str(i): {**m.to_json(), "board": b}
                             for i, (b, m) in sorted(merged.items())}
    return out


def system_contract(system: System, elfs: dict[str, Path]) -> dict:
    """bus_contract plus what the browser's panels read: state views, labels,
    inputs, plants and the sync quantum."""
    out = bus_contract(system, elfs)
    # Each board's state view (vhil/stateview.py) and the value labels of the
    # system's symbols and view frames: what the state panel shows, and the
    # labels expects and the scenario editor accept.
    out["state"] = stateview.view(system, elfs, out)
    out["labels"] = stateview.labels(system, elfs, out)
    # What a live session's pin switches and analog inputs drive.
    out["inputs"] = stateview.inputs(system)
    # What a live session's plant controls and a scenario's plant rows set.
    out["plants"] = plants(system)
    # Where a stimulus takes effect: the next sync point (docs/scenarios.md,
    # "Times"); the scenario editor shows a time between two moved there.
    out["sync_quantum_us"] = system.sync_quantum_us()
    return out


def plants(system: System) -> dict:
    """{plant: {plant: <kind>, settable: {faults, inputs, params}}} for the
    system's `plants:`: what a `plant` row or op may set (vhil.plant_ts
    settable), its fault inputs and other inputs as [{name, type (bool |
    number), default}], and its parameters as {name: {value, unit, status}}
    (the catalogue's, with the system's own overrides)."""
    from vhil import plant_sdc, plant_ts
    # Defaults by name, which also type the controls: the tractive system's
    # fault inputs, the shutdown circuit's switches and RST_EXT button.
    defaults = {**plant_ts.FAULT_DEFAULTS, **plant_sdc.DEFAULTS}
    from vhil.plant_pack import Pack
    faults = set(plant_ts.FAULTS) | set(Pack.FAULTS)      # the pack's by index
    out = {}
    for name, spec in (getattr(system, "plants", None) or {}).items():
        kind = spec["plant"]
        try:
            params = plant_ts.load_parameters(kind, spec.get("params"))
            can = plant_ts.settable(kind)
        except (OSError, KeyError, ValueError) as e:
            out[name] = {"plant": kind, "error": str(e)}
            continue

        def entry(n: str) -> dict:
            default = defaults.get(n)
            return {"name": n, "type": "bool" if isinstance(default, bool) else "number",
                    "default": default}
        rest = sorted(can - set(params))
        out[name] = {"plant": kind, "settable": {
            "faults": [entry(n) for n in rest if n in faults],
            "inputs": [entry(n) for n in rest if n not in faults],
            "params": {n: {"value": p.value, "unit": p.unit, "status": p.status}
                       for n, p in params.items() if n in can}}}
    return out
