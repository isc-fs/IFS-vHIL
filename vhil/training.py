"""Training puzzles: a car with a seeded fault for a new electrical member to
find and fix (training/README.md).

A puzzle is `training/scenarios/<id>.yaml`. It names a system and the
firmware its boards run (real commits, never patched: a firmware puzzle pins
the commit before the team's fix), the drive cycle that shows the symptom
(a scenario's rows, vhil/server/runs.py RunScenario), the hardware faults
seeded into that car, the brief the trainee reads, staged hints, where the
fault is, and the pytest node ids (under training/tests/) that count as
solved.

The flow, per trainee:

    start      the trainee's car runs: the drive cycle with the faults, on
               the pinned firmware (an ordinary run of the worker: a real
               power-on through each board's bootloader)
    diagnose   the trainee names a location (a part from PARTS and its
               fields); it is checked against the answer. Only a right one
               unlocks the repair, so toggling parts until the car works
               does not solve it; every attempt is counted.
    check      the grading tests run (a pytest run): a hardware fault with
               the fault removed (the repair), a firmware fault on the
               firmware ref the trainee gives (their fix). Green = solved.

v1 is on the honour system: the pinned commits can be diffed against their
fix upstream. Analog and physical effects (EMI, noise, soldering) are not
modelled, so no puzzle is about them.
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from pathlib import Path
from typing import Literal, Optional, Union

import yaml
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, field_validator

from vhil.system import REPO

TRAINING = REPO / "training"
PUZZLE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
TEST_ID = re.compile(r"^training/tests/(?!.*\.\.)[\w/.-]+\.py(::[\w\[\]\-.,=]+)*$")
GIT_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$")

# What a trainee can name as a fault's location: a part, and the fields that
# say which one. The Training page draws each part on its E/E diagram
# (vhil/server/static/training/diagram.js) and asks for its fields there.
PARTS: dict[str, dict] = {
    "ams.ntc": {"label": "Cell temperature sensor (NTC)", "board": "ams",
                "fields": {"module": [0, 4], "slot": [0, 39]},
                "where": "Accumulator module -> its two LTC6811s -> ADG731 mux -> GPIO1"},
    "ams.cell_tap": {"label": "Cell voltage sense wire", "board": "ams",
                     "fields": {"module": [0, 4], "cell": [0, 18]},
                     "where": "Accumulator module -> LTC6811 C0..C12"},
    "ams.ltc": {"label": "LTC6811 cell monitor", "board": "ams", "fields": {"chip": [0, 9]},
                "where": "isoSPI daisy chain, chip 0 nearest the AMS"},
    "ams.isospi": {"label": "isoSPI link", "board": "ams", "fields": {"after_chip": [0, 9]},
                   "where": "LTC6820 -> chip 0 -> ... -> chip 9"},
    "ams.current_sensor": {"label": "Pack current sensor", "board": "ams", "fields": {},
                           "where": "SSA-2-250A on PF7/PF8"},
    "ams.sd_card": {"label": "SD card", "board": "ams", "fields": {}, "where": "SDMMC1"},
    "sdc.tsms": {"label": "TSMS", "fields": {}, "where": "Shutdown circuit"},
    "sdc.imd": {"label": "IMD relay (K4)", "fields": {}, "where": "Shutdown circuit"},
    "sdc.bspd": {"label": "BSPD", "fields": {}, "where": "Shutdown circuit"},
    "sdc.interlocks": {"label": "HV interlock loop", "fields": {}, "where": "Shutdown circuit"},
    "ts.precharge": {"label": "Precharge relay / resistor", "fields": {},
                     "where": "Tractive system"},
    "ts.air_pos": {"label": "AIR+", "fields": {}, "where": "Tractive system"},
    "ts.air_neg": {"label": "AIR-", "fields": {}, "where": "Tractive system"},
    "can.acu": {"label": "ACU CAN bus (ECU <-> AMS)", "fields": {}, "where": "CAN"},
    "can.inv": {"label": "Inverter CAN bus", "fields": {}, "where": "CAN"},
    "ecu.pedals": {"label": "APPS / brake sensors", "board": "ecu", "fields": {},
                   "where": "ECU ADC inputs PF7..PF9"},
    "firmware": {"label": "Firmware bug", "fields": {"board": ["ecu", "ams", "udv"],
                                                     "module": "text"},
                 "where": "A board's application code"},
}

# The firmware modules a firmware fault is named by (the trainee picks one).
FIRMWARE_MODULES = {
    "ecu": ["can_tx_heartbeat", "precharge_sequence", "pedals", "inverter_control", "state_machine"],
    "ams": ["sd_logger", "bms_poll", "safety_task", "current_sensor", "can_tx"],
    "udv": ["can", "state_machine"],
}


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Answer(_Model):
    part: str
    module: Optional[Union[StrictInt, StrictStr]] = None
    slot: Optional[StrictInt] = None
    cell: Optional[StrictInt] = None
    chip: Optional[StrictInt] = None
    after_chip: Optional[StrictInt] = None
    board: Optional[StrictStr] = None
    explain: str = ""

    @field_validator("part")
    @classmethod
    def _part(cls, v: str) -> str:
        if v not in PARTS:
            raise ValueError(f"no part '{v}' (parts: {', '.join(PARTS)})")
        return v

    def fields(self) -> dict:
        return {k: v for k, v in self.model_dump().items()
                if k not in ("part", "explain") and v is not None}


class Drive(_Model):
    """The drive cycle: a run scenario's rows (stimuli, watch, expect)."""
    virtual_ms: int = Field(ge=1, le=600_000)
    stimuli: list[dict] = []
    watch: list[dict] = []
    expect: list[dict] = []


class Puzzle(_Model):
    kind: Literal["training"]
    id: str = ""
    title: str
    summary: str
    level: int = Field(1, ge=1, le=3)
    fault: Literal["hardware", "firmware"]
    topics: list[str] = []
    system: str
    # image key -> firmware ref (a full commit), the trainee's car.
    firmware: dict[str, str] = {}
    brief: str
    # "run": the car is a scenario run (instruments over its trace);
    # "pytest": the car is a test run (car_test), e.g. one that reads the SD card.
    mode: Literal["run", "pytest"] = "run"
    drive: Optional[Drive] = None
    car_test: Optional[str] = None
    # Hardware faults, as scenario stimulus rows; removed by the repair.
    faults: list[dict] = []
    hints: list[str] = Field(min_length=1)
    answer: Answer
    # The team's fix: image -> ref (the honour system; shown once solved).
    fix: dict[str, str] = {}
    fix_note: str = ""
    sources: list[str] = []
    solved: list[str] = Field(min_length=1)

    @field_validator("solved")
    @classmethod
    def _tests(cls, v: list[str]) -> list[str]:
        for t in v:
            if not TEST_ID.match(t):
                raise ValueError(f"'{t}' is not a node id under training/tests/")
        return v

    def check(self) -> list[str]:
        errors = []
        if not PUZZLE_ID.match(self.id):
            errors.append(f"id '{self.id}': lowercase letters, digits and '-'")
        if self.mode == "run" and self.drive is None:
            errors.append("a run puzzle needs a drive cycle (drive:)")
        if self.mode == "pytest" and not (self.car_test and TEST_ID.match(self.car_test)):
            errors.append("a pytest puzzle needs car_test: a node id under training/tests/")
        if self.fault == "hardware" and self.mode == "run" and not self.faults:
            errors.append("a hardware puzzle seeds at least one fault (faults:)")
        if self.fault == "firmware" and self.answer.part != "firmware":
            errors.append("a firmware puzzle's answer is part: firmware")
        if self.answer.part == "firmware" and self.answer.board not in FIRMWARE_MODULES:
            errors.append("a firmware answer names its board")
        for k, ref in {**self.firmware, **self.fix}.items():
            if not GIT_REF.match(ref):
                errors.append(f"firmware ref for '{k}' is not a plain git ref: {ref!r}")
        return errors

    # -- what the trainee's runs are ------------------------------------------------

    def car_run(self) -> dict:
        """The RunRequest (as data) of the trainee's car: the faults seeded."""
        if self.mode == "pytest":
            scenario = {"kind": "pytest", "select": self.car_test, "timeout_s": 1800}
        else:
            d = self.drive
            scenario = {"kind": "run", "virtual_ms": d.virtual_ms,
                        "stimuli": [*d.stimuli, *self.faults], "watch": d.watch, "expect": []}
        return {"system": self.system, "firmware": dict(self.firmware), "scenario": scenario}

    def check_run(self, fix_ref: Optional[str] = None) -> list[dict]:
        """The grading runs: each solved test as a pytest run, on the pinned
        firmware with the trainee's fix over the answer's board (a firmware
        fault). A hardware fault's tests run without it: the repair."""
        firmware = dict(self.firmware)
        if self.fault == "firmware":
            if not fix_ref or not GIT_REF.match(fix_ref):
                raise ValueError("a firmware fix is checked on a firmware ref: the branch or "
                                 "commit with your fix")
            firmware[self.answer.board] = fix_ref
        return [{"system": self.system, "firmware": firmware,
                 "scenario": {"kind": "pytest", "select": t, "timeout_s": 1800}}
                for t in self.solved]

    # -- what the trainee sees --------------------------------------------------------

    def public(self, hints_shown: int = 0, solved: bool = False) -> dict:
        out = {"id": self.id, "title": self.title, "summary": self.summary, "level": self.level,
               "fault": self.fault, "topics": self.topics, "system": self.system,
               "brief": self.brief, "mode": self.mode, "hints_total": len(self.hints),
               "hints": self.hints[:hints_shown], "firmware": self.firmware,
               "virtual_ms": self.drive.virtual_ms if self.drive else None}
        if solved:
            out["answer"] = {"part": self.answer.part, **self.answer.fields(),
                             "explain": self.answer.explain}
            out["fix"] = self.fix
            out["fix_note"] = self.fix_note
            out["sources"] = self.sources
        return out


def load(path: Path) -> Puzzle:
    doc = yaml.safe_load(Path(path).read_text()) or {}
    doc.setdefault("id", Path(path).stem)
    p = Puzzle.model_validate(doc)
    errors = p.check()
    if errors:
        raise ValueError(f"{path}: " + "; ".join(errors))
    return p


def puzzles(root: Path = TRAINING) -> dict[str, Puzzle]:
    return {p.id: p for p in (load(f) for f in sorted((root / "scenarios").glob("*.yaml")))}


# -- the location -----------------------------------------------------------------

def _norm(v):
    if isinstance(v, str):
        s = v.strip().lower().replace("-", "_").replace(" ", "_")
        return int(s) if s.isdigit() else s
    return v


def matches(answer: Answer, location: dict) -> bool:
    """The trainee's location names the answer's part and every field the
    answer gives (extra fields are ignored, missing ones are wrong)."""
    if not isinstance(location, dict) or location.get("part") != answer.part:
        return False
    return all(_norm(location.get(k)) == _norm(v) for k, v in answer.fields().items())


def check_location(location: dict) -> list[str]:
    """What is wrong with a location's shape (not whether it is right)."""
    part = PARTS.get(location.get("part")) if isinstance(location, dict) else None
    if part is None:
        return [f"part: one of {', '.join(PARTS)}"]
    errors = []
    for name, spec in part["fields"].items():
        v = location.get(name)
        if v is None:
            errors.append(f"{name}: needed for {part['label']}")
        elif isinstance(spec, list) and all(isinstance(x, int) for x in spec):
            if not isinstance(v, int) or not spec[0] <= v <= spec[1]:
                errors.append(f"{name}: {spec[0]}..{spec[1]}")
        elif isinstance(spec, list) and v not in spec:
            errors.append(f"{name}: one of {', '.join(spec)}")
        elif spec == "text" and (not isinstance(v, str) or not 0 < len(v) <= 64):
            errors.append(f"{name}: a name, at most 64 characters")
    return errors


# -- progress ---------------------------------------------------------------------

class Progress:
    """Each trainee's progress per puzzle, in one JSON file next to the run
    store: started car runs, hints shown, diagnosis attempts, check runs."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.lock = threading.Lock()

    def _all(self) -> dict:
        try:
            return json.loads(self.path.read_text())
        except (OSError, ValueError):
            return {}

    def get(self, who: str, puzzle: str) -> dict:
        with self.lock:
            return self._all().get(_key(who), {}).get(puzzle) or _fresh()

    def update(self, who: str, puzzle: str, fn) -> dict:
        with self.lock:
            data = self._all()
            mine = data.setdefault(_key(who), {})
            entry = mine.get(puzzle) or _fresh()
            fn(entry)
            mine[puzzle] = entry
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=1, sort_keys=True))
            tmp.replace(self.path)
            return entry

    def everyone(self) -> dict:
        with self.lock:
            return self._all()


def _key(who: str) -> str:
    return (who or "local").lower()


def _fresh() -> dict:
    return {"car_runs": [], "hints_shown": 0, "attempts": [], "located": False,
            "check_runs": [], "solved": False, "started_s": None, "solved_s": None}


def attempt(entry: dict, location: dict, ok: bool) -> None:
    entry["attempts"].append({"location": location, "ok": ok, "at_s": round(time.time())})
    if ok:
        entry["located"] = True


def digest(p: Puzzle) -> str:
    """A puzzle's content id, so progress made on an older version can be told."""
    return hashlib.sha256(json.dumps(p.model_dump(), sort_keys=True).encode()).hexdigest()[:12]
