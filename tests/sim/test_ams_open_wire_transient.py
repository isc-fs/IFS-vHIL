"""A load transient between the two ADOW scans reads as an open cell wire
(isc-fs/IFS08-CE-AMS#641): CellOpenWire (16) on a healthy pack, the car's
fault.

Firmware (IFS08-CE-AMS dev 94b59a9; v3.0.2 the same code at other lines):
  Every 200 ms voltage poll (BmsPollVoltMs, ams_config.hpp:258) runs, after
  ADCV, the open-wire scan attempt_open_wire_poll (bms_poll_task.cpp:481-498):
  adow_pass pull-up then adow_pass pull-down (:434-468), each ADOW (7 kHz,
  ltc6811.hpp:125-135, 0x368 up / 0x328 down) twice with osDelay(3) after
  each, then RDCFGA + RDCVA..D. Per IC, interior conductor i (1..n-1) is open
  when CELL_PU(i+1) - CELL_PD(i+1) < -400 mV (open_wire.hpp:87-112,
  CellOpenWireDeltaMv ams_config.hpp:43), with no confirmation, in any state:
  CellOpenWire (16), detail = module mask (bms_service.cpp:415-497,
  safety_predicates.hpp:202-203).
  The pull-up result is taken ~one pass before the pull-down one, and a cell
  under pack current I reads OCV - I R: PU - PD = R (I_pd - I_pu). A current
  that FALLS by dI between the two scans gives -R dI; on the car-fitted pack
  (catalog/plants/tractive-system.yaml car-log0077: 3.70 mOhm per element,
  c0_10 4.57) -400 mV is ~88 A, less where the healthy-pack ADOW offset
  (AMS #512: -127 mV on the top cell of an upper LTC) already sits.

The LTC6811 model converts at the datasheet's scan time and samples the cells
then (models/renode/IsoSpi.cs), and the pack plant ramps the inverter current
in 0.25 ms steps (vhil/plant_ts.py RAMP_STEP_US), so a transient lands between
the scans exactly where it would on the car. A test places it there with the
chain's CommandTrigger (ADOW pull-up, opcode 0x368).
"""
import json
import os
from pathlib import Path

import pytest

from vhil.cosim import Port
from vhil.plant_ts import make_plants
from vhil.sim import Sim
from vhil.system import REPO, System

# Impact selection (ci/impact.yaml, docs/ci.md): boards, systems, subsystems.
pytestmark = [pytest.mark.ecu, pytest.mark.ams, pytest.mark.system_ecu_ams, pytest.mark.plant,
              pytest.mark.isospi]

RUN, ERROR = 3, 5
CELL_OPEN_WIRE = 16
GPIOF, DASH_CHG = "sysbus.gpioPortF", 10
ADOW_UP = 0x368                  # ADOW, MD = 7 kHz, PUP = 1, DCP = 0, all cells (ltc6811.hpp:113)
SCAN_US = 2335                   # 7 kHz all-cell scan (LTC6811 datasheet Table 5)
CAR_PACK = {"parameter_set": "car-log0077", "soc_init": 0.584, "t_init": 295.05}
SYSTEM = REPO / "systems" / "ecu-ams.yaml"
ISSUE = "isc-fs/IFS08-CE-AMS#641"
# Healthy-pack ADOW offset (AMS #512, tests/unit/test_open_wire.cpp:78-87):
# the top cell of an upper LTC reads 127 mV low under pull-up. Taken on the
# top cell of both LTCs of every module here (an assumption: only an upper
# LTC was measured).
TOP_OFFSET_MV = -127
CELLS_PER_CHIP = (9, 10)
OUT = Path(os.environ.get("VHIL_AMS641_OUT", REPO / "results" / "ams-641"))


class Car:
    """ecu-ams armed to Run on the car-fitted pack, with its plants."""

    def __init__(self, sim, offset=False):
        self.sim = sim
        sim.wait_for_app()
        self.plants = make_plants(System(SYSTEM), sim)
        self.port, self.ts, self.sdc = Port(sim), self.plants["ts"], self.plants["sdc"]
        self.steps = list(self.plants.values())
        self.chain = self.ts.chain
        self.trace = []
        if offset:
            for chip in range(self.chain.chips):
                top = CELLS_PER_CHIP[chip % 2] - 1
                self.chip(chip, "SetAdowOffset", top, TOP_OFFSET_MV)
        self.apply(self.ts, CAR_PACK)
        self.run_ms(max(0, 5400 - sim.now_us() / 1000))
        self.apply(self.sdc, {"reset": True})
        self.run_ms(50)
        self.apply(self.sdc, {"reset": False})
        self.run_ms(50)
        self.apply(self.sdc, {"tsms": True})
        self.run_ms(100)
        sim.io("ams").set_input(GPIOF, DASH_CHG, True)
        self.run_ms(50)
        sim.io("ams").set_input(GPIOF, DASH_CHG, False)
        for _ in range(50):
            self.run_ms(100)
            if self.state() == RUN:
                break
        assert self.state() == RUN, "the car never reached Run"
        self.run_ms(500)

    def chip(self, chip, method, *args):
        return self.sim.call(f"{self.chain.path}.cells{chip}", method, *args, board=self.chain.board)

    def apply(self, plant, values):
        plant.apply(values, self.sim.now_us())
        if "i_inverter_dc" in values:
            self.trace.append({"t_us": self.sim.now_us(), "set": dict(values)})

    def run_ms(self, ms):
        self.port.run(self.steps, ms)

    def state(self):
        return self.sim.read_symbol("ams", "g_state_telemetry")

    def reason(self):
        return self.sim.read_symbol("ams", "g_fault_reason_telemetry")

    def after_pull_up_scan(self, timeout_ms=1000):
        """Run to the end of a poll's second ADOW pull-up scan (the one the
        pull-up result comes from): returns its start (us). The pull-down
        scans follow ~9 and ~12 ms after it (bms_poll_task.cpp:441-447:
        osDelay(3) after each ADOW, then the pass's five 84-byte reads at
        515.625 kHz, #368)."""
        for _ in range(2):              # the settling scan, then the measured one
            self.sim.call(self.chain.path, "CommandTrigger", ADOW_UP, board=self.chain.board)
            deadline = self.sim.now_us() + timeout_ms * 1000
            while True:
                for p in self.steps:
                    p.step(self.port, self.sim.now_us())
                self.sim.run_until_trigger(int(self.port.step_ms * 1000))
                if self.sim.triggered:
                    break
                assert self.sim.now_us() < deadline, "no ADOW pull-up scan"
        # The run stopped at the first sync point after the command, so the
        # scan started at most one quantum ago: wait out a whole scan.
        started = self.sim.now_us()
        self.port.run(self.steps, (SCAN_US + 100) / 1000)
        start = self.adow_scans(1)[-1]
        assert start["kind"] == "ADOWUP" and start["start_us"] <= started, start
        return start["start_us"]

    def adow_scans(self, chip):
        """Chip `chip`'s completed conversions: [{kind, start_us, cells mV}]."""
        out = []
        for line in self.chip(chip, "ConversionHistory").strip().splitlines():
            kind, start, *cells = line.strip().split(",")
            out.append({"kind": kind, "start_us": float(start),
                        "cells_mV": [int(c) / 10 for c in cells]})
        return out


def _release(car, i_from, i_to, ramp_ms, settle_ms=300, watch=False):
    """Carry i_from, then cut it to i_to right after a poll's pull-up scan,
    over ramp_ms. Returns (Error?, reason, that poll's pull-up scan and two
    pull-down scans on chip 1). `watch`: record the AMS state, fault reason,
    AIR+ and the pack current every ms of the settle into car.timeline."""
    car.apply(car.ts, {"i_inverter_dc": i_from})
    car.run_ms(400)
    assert car.state() == RUN, f"Error before the release (reason {car.reason()})"
    pu_start = car.after_pull_up_scan()
    car.apply(car.ts, {"i_inverter_dc": i_to, "i_ramp_ms": ramp_ms})
    if watch:
        car.timeline = []
        for _ in range(settle_ms):
            car.run_ms(1)
            t = car.sim.now_us()
            st = car.ts.state(t)
            car.timeline.append({"t_us": t, "state": car.state(), "reason": car.reason(),
                                 "air_pos": st["air_pos_closed"], "i_pack": st["i_pack"]})
    else:
        car.run_ms(settle_ms)
    scans = [s for s in car.adow_scans(1) if s["start_us"] >= pu_start][:3]
    assert [s["kind"] for s in scans] == ["ADOWUP", "ADOWDOWN", "ADOWDOWN"], scans
    return car.state() == ERROR, car.reason(), scans


def _dump(name, car, scans, extra):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{name}.json").write_text(json.dumps(
        {"trace": car.trace, "scans": scans, "pack": car.ts.pack_records, **extra}, indent=1))


@pytest.mark.xfail(reason=ISSUE, strict=True)
def test_a_torque_cut_between_the_adow_scans_is_not_an_open_wire(images):
    """180 A to 0 in 2 ms (a torque cut: the ECU commands torque every 10 ms
    and sets no ramp, IFS08-CE-ECU ecu_config.hpp:22) between the pull-up and
    the pull-down scan. Intent: a healthy pack is not an open wire; the AMS
    latches CellOpenWire and opens the SDC."""
    with Sim(SYSTEM, images("ecu-ams")) as sim:
        car = Car(sim)
        error, reason, scans = _release(car, 180, 0, 2, watch=True)
        _dump("open-wire-cut-180a", car, scans, {"error": error, "reason": reason,
                                                 "timeline": car.timeline})
        print(f"180 A -> 0 in 2 ms: Error={error} reason={reason}")
        assert not error, f"Error, reason {reason}"


def test_a_small_release_between_the_scans_rides_through(images):
    """60 A to 0 in 2 ms between the scans: -R dI ~ -0.22 V (-0.35 V with the
    healthy offset on the top cells), inside the 400 mV threshold."""
    with Sim(SYSTEM, images("ecu-ams")) as sim:
        car = Car(sim, offset=True)
        error, reason, scans = _release(car, 60, 0, 2)
        print(f"60 A -> 0: Error={error} reason={reason}")
        assert not error, f"Error, reason {reason}"
        pu, pd = scans[0], scans[2]         # the scans the firmware compares
        # Chip 1 (module 0, lower LTC) input 1 is c0_10 (4.57 mOhm): the
        # release shows on it as about -R dI.
        delta = pu["cells_mV"][1] - pd["cells_mV"][1]
        assert -320 < delta < -220, f"c0_10 PU - PD {delta} mV"


def test_a_load_step_up_between_the_scans_rides_through(images):
    """0 to 180 A in 2 ms between the scans: the current rises, PU - PD is
    +R dI, never under the threshold. Direction matters."""
    with Sim(SYSTEM, images("ecu-ams")) as sim:
        car = Car(sim, offset=True)
        error, reason, scans = _release(car, 0, 180, 2, settle_ms=200)
        car.apply(car.ts, {"i_inverter_dc": 0})
        print(f"0 -> 180 A: Error={error} reason={reason}")
        assert not error, f"Error, reason {reason}"


def test_the_pull_up_and_pull_down_samples_are_as_far_apart_as_on_the_car(images):
    """The firmware compares the second pull-up scan with the second
    pull-down scan, one adow_pass apart: the pass's second osDelay(3), its
    RDCFGA + RDCVA..D (5 x 84 bytes, 1.30 ms each at 515.625 kHz), then the
    pull-down pass's first ADOW and osDelay(3) (bms_poll_task.cpp:434-468).
    osDelay(3) waits 2-3 ticks: ~10.7-12.6 ms on the car. Before SPI1 took
    its transfer time (#368) this was 6.0 ms. The width of the window a
    current fall must land in (#641)."""
    with Sim(SYSTEM, images("ecu-ams")) as sim:
        car = Car(sim)
        pu_start = car.after_pull_up_scan()
        car.run_ms(30)
        scans = [s for s in car.adow_scans(1) if s["start_us"] >= pu_start][:3]
        assert [s["kind"] for s in scans] == ["ADOWUP", "ADOWDOWN", "ADOWDOWN"], scans
        gap_ms = (scans[2]["start_us"] - scans[0]["start_us"]) / 1000
        print(f"ADOW pull-up to pull-down: {gap_ms:.2f} ms")
        assert 10.0 <= gap_ms <= 13.5, f"{gap_ms:.2f} ms"


@pytest.mark.parametrize("offset", [False, True], ids=["no-offset", "healthy-offset"])
def test_the_smallest_release_that_trips(images, offset):
    """Step releases dI -> 0 between the scans, dI up by 2 A from 60 A until
    the AMS latches CellOpenWire: the model and plant give the threshold the
    pack's R predicts (step: no ramp). Without the offset the weakest checked
    element trips it, c0_10 at 4.57 mOhm: 400 / 4.57 = 87.5 A. With it, a
    top cell: 273 mV over its R."""
    with Sim(SYSTEM, images("ecu-ams")) as sim:
        car = Car(sim, offset=offset)
        tried = []
        for di in range(60, 132, 2):
            error, reason, scans = _release(car, di, 0, 0, settle_ms=250)
            pu, pd = scans[0], scans[2]
            tried.append({"di_a": di, "error": error, "reason": reason,
                          "chip1_pu_minus_pd_mV": [round(a - b, 1) for a, b in
                                                   zip(pu["cells_mV"], pd["cells_mV"])]})
            if error:
                break
        name = "open-wire-sweep-" + ("offset" if offset else "no-offset")
        _dump(name, car, scans, {"tried": tried})
        trip = tried[-1]
        print(f"{name}: trips at {trip['di_a']} A (reason {trip['reason']})")
        assert trip["error"] and trip["reason"] == CELL_OPEN_WIRE, tried
        # Predicted at 21.9 C (cell_r0_alpha): c0_10 3.487 x 1.233 x 1.062 =
        # 4.56 mOhm -> 87.7 A; the top cells' highest R, c0_18 3.64 mOhm ->
        # 273 / 3.64 = 75.1 A. The cells warm a little over the sweep (R0
        # falls with T), so the 2 A grid lands on 88-90 and 76-78.
        lo, hi = (74, 80) if offset else (86, 92)
        assert lo <= trip["di_a"] <= hi, tried
