"""The training API (vhil/training.py, training/README.md): the puzzles, and
each trainee's way through one. Runs are the worker's own (POST /api/runs's
path, runs.submit); the Training page (/training/) replays them with
/api/runs/{id}/trace, /contract and /artifacts.

    GET  /api/training/puzzles                 every puzzle (no answers), with my progress
    GET  /api/training/puzzles/{id}            one, its hints shown so far, my progress
    POST /api/training/puzzles/{id}/start      run my car (the faults seeded) -> {run_id}
    POST /api/training/puzzles/{id}/hint       show the next hint
    POST /api/training/puzzles/{id}/diagnose   {location} -> {correct, attempts}
    POST /api/training/puzzles/{id}/check      {fix_ref?} -> {run_ids}: only once located
    GET  /api/training/parts                   what a location can name
    GET  /api/training/systems/{id}/signals    each board pin's car signal, pin and backplane
"""
from __future__ import annotations

import re
import time
from functools import lru_cache
from pathlib import Path
from typing import Optional

import yaml
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from vhil import training as tr
from vhil.server.runs import Limits, RunRequest, RunStore, _login, submit
from vhil.system import REPO, System

PASSED = "passed"
DONE = {"passed", "failed", "error", "cancelled"}


class Diagnosis(BaseModel):
    location: dict


class Check(BaseModel):
    fix_ref: Optional[str] = None


def router(settings, workspace, limits: Optional[Limits] = None) -> APIRouter:
    limits = limits or Limits.from_env()
    store = RunStore(settings.db)
    progress = tr.Progress(Path(settings.db).parent / "training.json")
    root = Path(workspace.root) / "training"
    r = APIRouter(prefix="/api/training", tags=["training"])

    def catalogue() -> dict[str, tr.Puzzle]:
        try:
            return tr.puzzles(root)
        except ValueError as e:
            raise HTTPException(500, str(e))

    def puzzle(pid: str) -> tr.Puzzle:
        p = catalogue().get(pid)
        if p is None:
            raise HTTPException(404, f"no puzzle '{pid}'")
        return p

    def refresh(who: str, p: tr.Puzzle) -> dict:
        """My progress, with the check runs' states read now: all passed = solved."""
        entry = progress.get(who, p.id)
        last = entry["check_runs"][-1] if entry["check_runs"] else None
        if last and not entry["solved"]:
            states = [(store.get(i) or {}).get("state") for i in last["run_ids"]]
            if states and all(s == PASSED for s in states):
                def solve(e):
                    e["solved"], e["solved_s"] = True, round(time.time())
                entry = progress.update(who, p.id, solve)
        return entry

    def shown(entry: dict) -> dict:
        runs = {}
        for i in entry["car_runs"][-1:] + [i for c in entry["check_runs"][-1:]
                                           for i in c["run_ids"]]:
            run = store.get(i)
            if run:
                runs[i] = {"state": run["state"], "summary": run.get("summary")}
        return {**entry, "runs": runs,
                "car_run": entry["car_runs"][-1] if entry["car_runs"] else None,
                "wrong_attempts": sum(1 for a in entry["attempts"] if not a["ok"])}

    @r.get("/puzzles")
    def puzzles(request: Request):
        who = _login(request)
        out = []
        for p in catalogue().values():
            e = progress.get(who, p.id)
            out.append({**p.public(), "brief": None, "hints": [],
                        "progress": {"started": bool(e["car_runs"]), "located": e["located"],
                                     "solved": e["solved"]}})
        return sorted(out, key=lambda x: (x["level"], x["title"]))

    @r.get("/puzzles/{pid}")
    def one(pid: str, request: Request):
        p = puzzle(pid)
        e = refresh(_login(request), p)
        return {"puzzle": p.public(e["hints_shown"], e["solved"]), "progress": shown(e)}

    @r.post("/puzzles/{pid}/start", status_code=201)
    def start(pid: str, request: Request):
        p = puzzle(pid)
        req = RunRequest.model_validate(p.car_run())
        run_id = submit(req, request, settings, workspace, store, limits)

        def add(e):
            e["car_runs"].append(run_id)
            e["started_s"] = e["started_s"] or round(time.time())
        progress.update(_login(request), p.id, add)
        return {"run_id": run_id}

    @r.post("/puzzles/{pid}/hint")
    def hint(pid: str, request: Request):
        p = puzzle(pid)

        def more(e):
            e["hints_shown"] = min(len(p.hints), e["hints_shown"] + 1)
        e = progress.update(_login(request), p.id, more)
        return {"hints": p.hints[:e["hints_shown"]], "hints_total": len(p.hints)}

    @r.post("/puzzles/{pid}/diagnose")
    def diagnose(pid: str, body: Diagnosis, request: Request):
        p = puzzle(pid)
        errors = tr.check_location(body.location)
        if errors:
            raise HTTPException(422, errors)
        ok = tr.matches(p.answer, body.location)
        e = progress.update(_login(request), p.id, lambda e: tr.attempt(e, body.location, ok))
        out = {"correct": ok, "attempts": len(e["attempts"]),
               "wrong_attempts": sum(1 for a in e["attempts"] if not a["ok"])}
        if ok:
            out["next"] = ("Repair it: the check runs the car with the fault removed."
                           if p.fault == "hardware" else
                           "Fix it in the firmware, push a branch, and check it on that ref.")
        return out

    @r.post("/puzzles/{pid}/check", status_code=201)
    def check(pid: str, body: Check, request: Request):
        p = puzzle(pid)
        who = _login(request)
        if not progress.get(who, p.id)["located"]:
            raise HTTPException(409, "name the fault's location first (diagnose): a repair is "
                                     "only accepted where the fault is")
        try:
            reqs = [RunRequest.model_validate(x) for x in p.check_run(body.fix_ref)]
        except ValueError as e:
            raise HTTPException(422, str(e))
        ids = [submit(q, request, settings, workspace, store, limits) for q in reqs]
        progress.update(who, p.id, lambda e: e["check_runs"].append(
            {"run_ids": ids, "fix_ref": body.fix_ref, "at_s": round(time.time())}))
        return {"run_ids": ids}

    @r.get("/parts")
    def parts():
        return {"parts": tr.PARTS, "firmware_modules": tr.FIRMWARE_MODULES}

    @r.get("/systems/{system_id}/signals")
    def system_signals(system_id: str):
        try:
            system = System(workspace.system_path(system_id))
        except Exception:
            raise HTTPException(404, f"no system '{system_id}'")
        return signals(system)

    return r


@lru_cache(maxsize=1)
def _pin_model() -> tuple[dict, dict]:
    board = yaml.safe_load((REPO / "catalog/boards/mainlite.yaml").read_text())
    model = yaml.safe_load((REPO / "catalog/pin-models/mainlite.pins.yaml").read_text())
    return board, {p.get("port") or p["name"]: p for p in model["pins"]}


def _plain(cell: str) -> str:
    cell = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", cell)     # [text](link) -> text
    return re.sub(r"[`*]|[¹²³]", "", cell).strip()


@lru_cache(maxsize=4)
def _backplane(role: str) -> dict[str, dict]:
    """A role's backplane table (docs/backplanes/<role>.md), by MainLite pin:
    the car signal, where it leaves the backplane, and its conditioning."""
    path = REPO / "docs" / "backplanes" / f"{role}.md"
    out: dict[str, dict] = {}
    if not path.is_file():
        return out
    for line in path.read_text().splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 4 or not re.match(r"^P[A-K]\d+|^FDCAN\d|^SPI\d", cells[0]):
            continue
        for pin in re.findall(r"\b(P[A-K]\d+(?:_C)?|FDCAN\d|SPI\d)\b", cells[0].split("(")[0]):
            out.setdefault(pin, {"car": _plain(cells[1]), "connector": _plain(cells[2]),
                                 "conditioning": _plain(cells[3])})
    return out


def signals(system: System) -> list[dict]:
    """Each MainLite pin a system's boards use: its car signal (the role's
    label), the MCU pin and net (the pin model), where it leaves the module
    and the backplane (connector pins), and the backplane doc that traces it."""
    board_doc, pins = _pin_model()
    out = []
    for name, b in system.boards.items():
        role = getattr(b, "role", None)
        labels = (board_doc.get("roles", {}).get(role) or {}).get("pins") or {}
        traced = _backplane(role) if role else {}
        for pin, label in labels.items():
            pm = pins.get(pin, {})
            bp = traced.get(pin, {})
            out.append({"board": name, "role": role, "pin": pin, "signal": label,
                        "mcu_pin": pm.get("number"), "net": pm.get("net"),
                        "module_pins": [f"{c.get('connector')}.{c.get('pin')}"
                                        for c in pm.get("backplane") or []],
                        "car": bp.get("car"), "connector": bp.get("connector"),
                        "conditioning": bp.get("conditioning"),
                        "doc": f"docs/backplanes/{role}.md" if role else None})
    return out
