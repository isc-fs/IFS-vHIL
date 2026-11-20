"""#415: the uDV in AS Driving on a mission that requests R2D sends 0x510,
on every boot.

IFSSIM saw ~1 in 3-4 boots of ecu-ams-udv reach AS Driving and stream 0x507
with no 0x510 ever (isc-fs/IFS09-DV-uDV#22). The lead is the uDV's FDCAN2 Tx
FIFO, written without a lock by appTask (0x507, 0x510), imuTask (0x512, on
TIM2's 400 Hz interrupt) and pit-diag: a preempted
HAL_FDCAN_AddMessageToTxFifoQ lets two writers take one element, and the
second TXBAR lands on a pending buffer (RM0468 FDCAN_TXBAR). The FDCAN model
counts exactly that (models/renode/Stm32H7Fdcan.cs TxRequestsDropped /
TxRequestsOffPut, #416).

A run is deterministic, so each boot moves the operator's GO by a fraction
of a millisecond to land the uDV's tasks on a different phase.

uDV facts (IFS09-DV-uDV dev): app_task.cpp re-sends 0x510 every 100 ms
(R2D_REQ_PERIOD_MS) while DRIVING a requests_r2d mission without g_can_r2d;
READY_DWELL_MS = 5000 before GO is taken (app_task.cpp:131); Ready->Driving
needs DV_STATUS_READY (2), fresh within DV_STATUS_STALE_MS = 400
(dv_interface.h:57,91). RES on the DV bus: 0x191 byte 0 bit 0 = not
e-stop, bit 2 = GO. Mission 3 = autocross (pipeline, requests_r2d). The
operator's sequence is IFSSIM's tools/vhil_boards/server.py Panel.
"""
import os

import pytest

from vhil import elf
from vhil.cosim import Port
from vhil.plant_ts import make_plants
from vhil.plants import COUNTS_TO_V
from vhil.sim import Sim
from vhil.system import REPO

# Impact selection (ci/impact.yaml, docs/ci.md): boards, systems, subsystems.
pytestmark = [pytest.mark.ecu, pytest.mark.ams, pytest.mark.udv, pytest.mark.system_ecu_ams_udv,
              pytest.mark.can, pytest.mark.plant]

AS_READY, AS_DRIVING = 1, 2
DV_READY, DV_RUNNING = 2, 3
MISSION_AUTOCROSS = 3
R2D_REQUEST = 0x510
TANK_BAR = 8.0                 # both EBS tanks, above the firmware's storage threshold
BRAKE_HELD_COUNTS = 3100       # above the ECU's BrakeDvHardRaw (2500)
GPIOF, DASH_CHG = "sysbus.gpioPortF", 10
FDCAN2 = "sysbus.fdcan2_h7"
BOOTS = int(os.environ.get("VHIL_R2D_BOOTS", "12"))
GO_STEP_US = 337               # GO moves this much later on each boot


class Operator:
    """What the driver, the AMI box, the RES and the EBS plumbing do, and the
    pipeline's side of the (unmodelled) micro-ROS link: its setters write
    the firmware's own globals."""

    def __init__(self, sim):
        self.sim = sim
        self.port = Port(sim)
        plants = make_plants(sim.system, sim)
        self.plants, self.sdc = list(plants.values()), plants["sdc"]
        self.udv_elf = sim.firmware["udv"]
        self.res = None

    def _addr(self, sym):
        return int(elf.symbol(self.udv_elf, sym)[0])

    def w8(self, sym, v):
        self.sim.monitor(f"sysbus WriteByte {self._addr(sym):#x} {v & 0xFF}", board="udv")

    def w32(self, sym, v):
        self.sim.monitor(f"sysbus WriteDoubleWord {self._addr(sym):#x} {v & 0xFFFFFFFF}", board="udv")

    def r(self, sym, n=1):
        return self.sim.read_symbol("udv", sym, n)

    def run(self, ms, dv_status=None):
        """ms of virtual time; the pipeline's status refreshed every 100 ms."""
        left = ms
        while left > 0:
            step = min(100, left)
            if dv_status is not None:
                self.w8("g_dv_status", dv_status)
                self.w32("g_dv_status_stamp_ms", self.r("xTickCount", 4))
                self.w32("g_ctrl_cmd_stamp_ms", self.r("xTickCount", 4))
            self.port.run(self.plants, step)
            left -= step

    def run_us(self, us):
        self.port.run(self.plants, us / 1000)

    def res_frame(self, byte0):
        data = bytes([byte0, 0, 0, 0, 0, 0, 100, 0])
        if self.res is None:
            self.sim.can("can_dv").send_periodic("res", 0x191, data, 20)
        else:
            self.sim.can("can_dv").update_periodic("res", data)
        self.res = byte0

    def counter(self, name):
        return int(self.sim.monitor(f"{FDCAN2} {name}", board="udv").strip().split()[-1], 0)

    def arm(self):
        """The car made ready, as IFSSIM's Panel does: ASMS on, tanks, brake
        held, the shutdown circuit reset, TSMS, a DASH_CHG press, the
        tractive system up."""
        udv, ecu, ams = self.sim.io("udv"), self.sim.io("ecu"), self.sim.io("ams")
        udv.set_voltage("PF9", 3.0)
        udv.set_voltage("PC0", TANK_BAR / 11)
        udv.set_voltage("PF10", TANK_BAR / 11)
        ecu.set_voltage("PF7", BRAKE_HELD_COUNTS * COUNTS_TO_V)
        for _ in range(50):
            if self.port.level("ams_ok"):
                break
            self.run(100)
        t = self.sim.now_us()
        self.sdc.apply({"reset": True}, t)
        self.run(300)
        t = self.sim.now_us()
        self.sdc.apply({"reset": False}, t)
        self.sdc.apply({"tsms": True}, t)
        self.run(700)
        ams.set_input(GPIOF, DASH_CHG, True)
        self.run(300)
        ams.set_input(GPIOF, DASH_CHG, False)
        for _ in range(50):
            self.run(100)
            if self.r("g_telemetry_ts_active"):
                return
        raise AssertionError("the tractive system never came up (g_telemetry_ts_active)")


def _boot(images, k):
    # One Renode process per boot, stopped with it (make_sim keeps every
    # Sim to the end of the module).
    with Sim(REPO / "systems" / "ecu-ams-udv.yaml", images("ecu-ams-udv")) as sim:
        sim.wait_for_app()
        return _drive(sim, k)


def _drive(sim, k):
    op = Operator(sim)
    op.arm()
    op.w32("g_can_mission_id", MISSION_AUTOCROSS)
    op.w8("g_set_mission_ready", 1)
    op.res_frame(0x01)                                   # READY asked, no GO
    for _ in range(60):
        op.run(100, dv_status=DV_READY)
        if op.r("g_telemetry_as_state") == AS_READY:
            break
    else:
        raise AssertionError(f"boot {k}: the uDV never reached AS Ready")
    op.run(5200, dv_status=DV_READY)                     # READY_DWELL_MS
    op.run_us(k * GO_STEP_US)                            # this boot's phase
    op.res_frame(0x05)                                   # GO
    for _ in range(30):
        op.run(100, dv_status=DV_READY)
        if op.r("g_telemetry_as_state") == AS_DRIVING:
            break
    else:
        raise AssertionError(f"boot {k}: the uDV never reached AS Driving")
    t = sim.now_us()
    op.run(1500, dv_status=DV_RUNNING)
    return {
        "r2d_requests": sim.can("can_acu").count([R2D_REQUEST], t),
        "torque": sim.can("can_acu").count([0x507], t),
        "dropped": op.counter("TxRequestsDropped"),
        "off_put": op.counter("TxRequestsOffPut"),
        "mission": op.r("g_can_mission_id", 4),
        "r2d": op.r("g_can_r2d"),
    }


@pytest.mark.parametrize("k", range(BOOTS))
def test_driving_requests_r2d_on_every_boot(images, k):
    got = _boot(images, k)
    print(f"#415 boot {k}: {got}")
    assert got["torque"] > 0, f"the uDV streams no 0x507 in Driving: {got}"
    assert got["dropped"] == 0 and got["off_put"] == 0, f"the FDCAN2 Tx FIFO race (#415): {got}"
    assert got["r2d_requests"] > 0 or got["r2d"], f"Driving with no 0x510 (#415): {got}"
