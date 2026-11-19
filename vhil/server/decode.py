"""A run's CAN contract for the browser's frame decoder (M5.3, #115).

    GET /api/runs/{id}/contract -> {buses: {bus: {id: message}}, boards, conflicts,
                                    state, labels, inputs, plants}

The contract is the firmware's own: the .def files of the source each board's
image was built from (vhil/candef.py), found next to the ELF the worker ran
(the run summary's `firmware`, or, before the run has finished, the path the
worker's FirmwareResolver gives the run's refs and the commits they resolved
to). A .def does not say which bus a frame rides; the catalogue firmware
does (`can.contract`: the board connectors the contract rides,
System.contract_buses), so a board's
messages apply on those buses only: the ECU's on its ACU bus, not on the
dash bus, whose own 0x510/0x511 would otherwise decode as the uDV's. A
firmware that names none applies on every bus the board sits on. Where two
boards on one bus declare the same id, the
sender's declaration wins: each repo carries the frames it consumes "so the
generated DBC documents the whole contract", but the sender owns the layout
(IFS08-CE-ECU all_messages.inc). A board's sender name is the one most of its
own messages carry (ECU "VCU", AMS "AMS"). Declarations that disagree are
listed under `conflicts`: that is drift between two firmwares' contracts.

Parsing is cached per firmware source (candef.load), so the browser can fetch
this for every replayed run.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException

from vhil.contract import _sender, plants, system_contract  # noqa: F401  (moved: no web framework)
from vhil.server.runs import RunStore
from vhil.system import System, SystemError


def board_elfs(run: dict, system: System, fw_dir: Path) -> dict[str, Path]:
    """Board -> the application ELF the run used (or will use)."""
    ran = (run.get("summary") or {}).get("firmware") or {}
    out = {k: Path(v) for k, v in ran.items() if "." not in k and k in system.boards}
    missing = [b for b in system.boards if b not in out]
    if missing:
        from vhil.worker import FirmwareResolver
        expected = FirmwareResolver(fw_dir, build=False).expected(
            system, run.get("firmware") or {}, run.get("firmware_commits") or {})
        out.update({b: expected[b][1] for b in missing if b in expected})
    return out


def run_contract(run: dict, workspace: Path, fw_dir: Path) -> dict:
    path = Path(workspace) / "systems" / f"{run['system']}.yaml"
    try:
        system = System(path)
    except (OSError, SystemError) as e:
        return {"buses": {}, "boards": {}, "conflicts": [], "state": {}, "labels": {},
                "inputs": {}, "plants": {}, "error": f"system '{run['system']}': {e}"}
    return system_contract(system, board_elfs(run, system, fw_dir))


def router(settings, workspace, fw_dir: Optional[Path] = None) -> APIRouter:
    from vhil.worker import DEFAULT_FW_DIR

    store = RunStore(settings.db)
    fw = Path(fw_dir or DEFAULT_FW_DIR)
    r = APIRouter(prefix="/api/runs", tags=["runs"])

    @r.get("/{run_id}/contract")
    def contract(run_id: int):
        run = store.get(run_id)
        if run is None:
            raise HTTPException(404, f"no run {run_id}")
        # An imported run's is its bundle's (vhil/server/bundle.py).
        from vhil.server.bundle import contract_of
        return contract_of(run, settings.results, workspace.root, fw)

    return r
