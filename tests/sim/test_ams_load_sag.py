"""Controls for the load-sag scenarios (systems/ecu-ams.scenarios/
load-peak-sag-is-not-a-lost-cell.yaml, normal-load-peak-rides-through.yaml):
whatever stops a healthy cell under load from reading as lost must not slow a
genuine loss down. Under the ride-through control's 173 A load in Run, on
the pack plant (vhil/plant_pack.py) fitted to the car (parameter set
car-log0077, at LOG0077's end state), a real measurement loss still opens
the shutdown circuit in under 500 ms (FS rule: the AMS opens the SDC when any cell
voltage measurement is lost; AMS #501/#502/#505/#506/#508/#512).

Firmware (IFS08-CE-AMS dev):
  CellOpenWire (16): ADOW pull-up/pull-down two-pass scan in every 200 ms
    voltage poll, not debounced, any state (open_wire.hpp, bms_poll_task.cpp
    :481-500, safety_predicates.hpp:200-204; ams_config.hpp:42-50).
  A module that stops answering: BmsModuleOffline (2), immediate, once its
    freshness passes BmsStaleMs 350 ms (ams_config.hpp:155-167,
    safety_predicates.hpp:175-184); BmsStale (3) confirms 250 ms later.
"""
import pytest

from vhil.cosim import Port
from vhil.plant_ts import make_plants
from vhil.sim import Sim
from vhil.system import REPO, System

# Impact selection (ci/impact.yaml, docs/ci.md): boards, systems, subsystems.
pytestmark = [pytest.mark.ecu, pytest.mark.ams, pytest.mark.system_ecu_ams, pytest.mark.plant,
              pytest.mark.isospi]

RUN, ERROR = 3, 5
CELL_OPEN_WIRE, MODULE_OFFLINE, BMS_STALE = 16, 2, 3
GPIOF, DASH_CHG = "sysbus.gpioPortF", 10
FS_LOSS_MS = 500                 # FS: a lost measurement opens the SDC within 500 ms
LOAD_A = 173                     # normal-load-peak-rides-through's peak (LOG0077's highest)
# The car-fitted pack at the state LOG0077 ends in (catalog/plants/
# tractive-system.yaml parameter_sets, scripts/fit_pack.py), as the scenarios.
CAR_PACK = {"parameter_set": "car-log0077", "soc_init": 0.584, "t_init": 295.05}
SYSTEM = REPO / "systems" / "ecu-ams.yaml"


def _loss_under_load(images, inject):
    """Arm ecu-ams to Run on the car-fitted pack, carry LOAD_A for 1 s, then
    `inject(sim)` a genuine measurement loss. Returns (ms from the loss to
    Error or None, the fault reason, whether the SDC opened)."""
    with Sim(SYSTEM, images("ecu-ams")) as sim:
        sim.wait_for_app()
        plants = make_plants(System(SYSTEM), sim)
        port, ts, sdc = Port(sim), plants["ts"], plants["sdc"]
        steps = list(plants.values())

        def at_now(plant, values):
            plant.apply(values, sim.now_us())

        at_now(ts, CAR_PACK)
        # As the scenarios: the RST_EXT press once AMS_OK is up (past the
        # AMS's 2 s boot grace, ams_config.hpp:216), at 5.4 s from power-on.
        port.run(steps, max(0, 5400 - sim.now_us() / 1000))
        at_now(sdc, {"reset": True})
        port.run(steps, 50)
        at_now(sdc, {"reset": False})
        port.run(steps, 50)
        at_now(sdc, {"tsms": True})
        port.run(steps, 100)
        sim.io("ams").set_input(GPIOF, DASH_CHG, True)
        port.run(steps, 50)
        sim.io("ams").set_input(GPIOF, DASH_CHG, False)
        for _ in range(50):
            port.run(steps, 100)
            if sim.read_symbol("ams", "g_state_telemetry") == RUN:
                break
        assert sim.read_symbol("ams", "g_state_telemetry") == RUN, "the car never reached Run"
        port.run(steps, 500)

        at_now(ts, {"i_inverter_dc": LOAD_A})
        port.run(steps, 1000)
        assert ts.pack.i_pack == LOAD_A, "the pack is not carrying the load"
        assert sim.read_symbol("ams", "g_state_telemetry") == RUN, (
            f"Error under a normal load (reason {sim.read_symbol('ams', 'g_fault_reason_telemetry')})")

        inject(sim)
        for step in range(1, 101):
            port.run(steps, 10)
            if sim.read_symbol("ams", "g_state_telemetry") == ERROR:
                port.run(steps, 100)            # the AMS latch drops, the SDC opens
                return (step * 10, sim.read_symbol("ams", "g_fault_reason_telemetry"),
                        not sdc.sdc.outputs()["sdc_closed"])
        return None, sim.read_symbol("ams", "g_fault_reason_telemetry"), False


def test_an_open_cell_wire_under_load_still_opens_the_sdc_in_time(images):
    """An interior cell-sense conductor (C4 of chip 3, module 1) opens while
    the pack carries LOAD_A: ADOW sees it within one voltage poll."""
    ms, reason, opened = _loss_under_load(
        images, lambda sim: sim.monitor("sysbus.spi1.isospi.cells3 OpenWire 4 true", board="ams"))
    print(f"open wire under load: Error after {ms} ms, reason {reason}")
    assert ms is not None, f"no Error within 1 s of the open wire (reason {reason})"
    assert reason == CELL_OPEN_WIRE, f"fault reason {reason}, not CellOpenWire"
    assert ms < FS_LOSS_MS, f"Error {ms} ms after the open wire (FS: < {FS_LOSS_MS} ms)"
    assert opened, "the shutdown circuit stayed closed"


def test_a_silent_module_under_load_still_opens_the_sdc_in_time(images):
    """Module 2's two LTC6811s (chain 4 and 5) stop answering while the pack
    carries LOAD_A: every cell of the module is lost."""
    ms, reason, opened = _loss_under_load(
        images, lambda sim: sim.monitor("sysbus.spi1.isospi StopReply 0x30", board="ams"))
    print(f"silent module under load: Error after {ms} ms, reason {reason}")
    assert ms is not None, f"no Error within 1 s of the module going silent (reason {reason})"
    assert reason in (MODULE_OFFLINE, BMS_STALE), f"fault reason {reason}"
    assert ms < FS_LOSS_MS, f"Error {ms} ms after the module went silent (FS: < {FS_LOSS_MS} ms)"
    assert opened, "the shutdown circuit stayed closed"
