#!/usr/bin/env python3
"""Figures of isc-fs/IFS08-CE-AMS#641 (a load transient between the two ADOW
scans latches CellOpenWire on a healthy pack, figures 6-7) and of the
load-sag path to CellUnderVoltage (figures 1-5, isc-fs/IFS08-CE-AMS#644), from
vHIL runs, into docs/analysis/ams-641/.

Figures 6-7 (reason 16), from the runs tests/sim/test_ams_open_wire_transient.py
writes (results/ams-641/open-wire-*.json, trimmed into docs/analysis/ams-641/
data/open-wire-*.json):

    scripts/vhil-docker.sh sim tests/sim/test_ams_open_wire_transient.py
    python scripts/plots/ams_641.py openwire --data docs/analysis/ams-641/data

Figures 1-5, in stages:

    # 1. In the container (Renode + the built ECU/AMS images): run the two
    #    scenarios from power-on as the suite does and keep each trace and the
    #    decoded series (results/ams-641/<scenario>.series.json).
    scripts/vhil-docker.sh run bash -c '
        export VHIL_ECU_ELF=$(sed -n "s/^ecu=//p" /vhil/fw/built.txt | tail -1)
        export VHIL_AMS_ELF=$(sed -n "s/^ams=//p" /vhil/fw/built.txt | tail -1)
        export VHIL_CAN_BOOTLOADER_ELF=$(sed -n "s/^ecu.bootloader=//p" /vhil/fw/built.txt | tail -1)
        python scripts/plots/ams_641.py run'

    # 2. Anywhere with matplotlib: the PNGs (light and dark), from the series
    #    (docs/analysis/ams-641/data/ holds the ones the committed figures use).
    python scripts/plots/ams_641.py plot --data docs/analysis/ams-641/data

    # 3. Figure 5, from the car's own AMS SD log (LOG0077.CSV, kept out of this
    #    public repo); writes the PNGs and the derived numbers it uses
    #    (docs/analysis/ams-641/data/car-log0077.json).
    python scripts/plots/ams_641.py car --logs <dir with LOG0077.CSV>

The runs and figure 3 use the pack fitted to the car (catalog/plants/
tractive-system.yaml parameter set car-log0077, from car SD log LOG0077 by
scripts/fit_pack.py: per-element R0 and OCV offsets, one RC), at the state the
log ends in. Figure 3 is derived, not run: that cell model, the same the plant
runs, evaluated for a 1 s constant-current peak on its first element to
cross.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "docs" / "analysis" / "ams-641"
SCENARIOS = {
    "sag": "systems/ecu-ams.scenarios/load-peak-sag-is-not-a-lost-cell.yaml",
    "ride": "systems/ecu-ams.scenarios/normal-load-peak-rides-through.yaml",
}
# What each run keeps: plant outputs, the AMS's own reports on can_acu, and
# its state and fault reason as the scenario samples them (every 10 ms).
PLANT = [("ts", "i_pack"), ("ts", "v_cell_min"), ("ts", "air_pos_closed"), ("ts", "soc_min"),
         ("sdc", "sdc_closed"), ("sdc", "ams_latch")]
FRAMES = [("can_acu", "ACU_currents", "current_accu_dA"),
          ("can_acu", "ACU_v_cell_min", "min_cell_mV")]
SYMBOLS = [("ams", "g_state_telemetry"), ("ams", "g_fault_reason_telemetry")]

UV_MV = 2800          # CellUnderVoltageMv, AMS ams_config.hpp:22
CUTOFF_V = 2.5        # VTC6 datasheet discharge cut-off
OC_A = 185            # CurrentMaxMa (filtered), AMS ams_config.hpp:127-153
P_ECU_W = 76e3        # ECU TS power envelope, ecu_config.hpp:353


# -- stage 1: run ---------------------------------------------------------------------

def run(out: Path) -> None:
    sys.path.insert(0, str(REPO))
    from vhil import expect as vx
    from vhil.server.decode import system_contract
    from vhil.server.scenarios import load_text
    from vhil.sim import Sim
    from vhil.system import System
    from vhil.worker import TraceWriter, execute_run

    out.mkdir(parents=True, exist_ok=True)
    for key, rel in SCENARIOS.items():
        path = REPO / rel
        system_id = path.parent.name.removesuffix(".scenarios")
        system_path = REPO / "systems" / f"{system_id}.yaml"
        system = System(system_path)
        fw = {}
        for b in system.boards.values():
            parts = [(b.name, b.firmware["id"])]
            if b.bootloader is not None:
                parts.append((f"{b.name}.bootloader", b.bootloader["id"]))
            for name, ident in parts:
                fw[name] = Path(os.environ[f"VHIL_{ident.upper().replace('-', '_')}_ELF"])
        elfs = {b: p for b, p in fw.items() if "." not in b}
        contract = system_contract(system, elfs)
        scen, _, errors = load_text(path.read_text(), system_id, path.stem)
        assert not errors, errors
        scenario = scen.model_dump()
        trace_path = out / f"{path.stem}.trace.jsonl"
        trace_path.unlink(missing_ok=True)
        trace = TraceWriter(trace_path)
        with Sim(system_path, fw, log_path=out / f"{path.stem}.log") as sim:
            execute_run(sim, scenario, trace)
            end_us = sim.now_us()
        trace.close()

        fields = {}
        for bus, msg_name, field in FRAMES:
            msg = vx.find_message(contract, bus, msg_name)
            fields[(bus, msg["id"])] = (f"{msg_name}.{field}", vx.find_field(msg, field))
        series: dict[str, list] = {}
        labels = {}
        for board, name in SYMBOLS:
            labels[name] = {str(k): v for k, v in
                            vx.signal_labels(contract, vx.parse_signal(f"symbol:{board}.{name}")).items()}
        with open(trace_path) as f:
            for line in f:
                rec = json.loads(line)
                kind, t = rec.get("kind"), rec.get("t_us")
                if kind == "plant" and (rec["plant"], rec["name"]) in PLANT:
                    series.setdefault(f"plant.{rec['plant']}.{rec['name']}", []).append(
                        [t / 1e3, rec["value"]])
                elif kind == "sample" and (rec.get("board"), rec.get("name")) in SYMBOLS:
                    s = series.setdefault(f"symbol.{rec['name']}", [])
                    if not s or s[-1][1] != rec["value"] or t / 1e3 - s[-1][0] > 50:
                        s.append([t / 1e3, rec["value"]])
                elif kind == "frame" and not rec.get("src") and (rec.get("bus"), rec.get("id")) in fields:
                    label, fd = fields[(rec["bus"], rec["id"])]
                    raw = vx.field_raw(bytes.fromhex(rec.get("data") or ""), fd)
                    if raw is not None:
                        series.setdefault(f"frame.{label}", []).append(
                            [t / 1e3, raw * fd["factor"] + fd["offset"]])
        doc = {"scenario": rel, "end_ms": end_us / 1e3, "labels": labels,
               "firmware": {b: str(p) for b, p in fw.items()}, "series": series}
        (out / f"{key}.series.json").write_text(json.dumps(doc, separators=(",", ":")))
        print(f"{key}: {path.stem}: {sum(len(v) for v in series.values())} points -> {out}")


# -- the cell model (figure 3) ---------------------------------------------------------

CAR_SET = "car-log0077"   # the pack fitted to the car (catalog/plants/tractive-system.yaml)
CAR_SOC, CAR_T_C = 0.584, 21.9   # LOG0077's end state, as the scenarios set it


def cell_params(parameter_set=CAR_SET) -> dict:
    """The catalogue's pack parameters with the named set put over them
    (vhil/plant_ts.py load_parameters), with per-element lists filled in."""
    sys.path.insert(0, str(REPO))
    from vhil.plant_ts import load_parameters
    p = {k: v.value for k, v in load_parameters(
        overrides={"parameter_set": parameter_set} if parameter_set else None).items()}
    n = int(p["cells_series"])
    p["cell_ocv_offset"] = p["cell_ocv_offset"] or [0.0] * n
    p["cell_r0_scale"] = p["cell_r0_scale"] or [1.0] * n
    return p


def ocv(p: dict, soc: float) -> float:
    xs, ys = p["cell_ocv_soc"], p["cell_ocv"]
    soc = min(xs[-1], max(xs[0], soc))
    for i in range(len(xs) - 1):
        if soc <= xs[i + 1]:
            return ys[i] + (ys[i + 1] - ys[i]) * (soc - xs[i]) / (xs[i + 1] - xs[i])
    return ys[-1]


def r_elem(p: dict, t_c: float, t_s: float = 1.0, k=None) -> float:
    """Element resistance seen by a constant-current step after t_s:
    R0(T) x its scale + R1 (1 - exp(-t/tau)), per 6P element (plant_pack.py's
    model); k None = the pack mean."""
    par = p["cells_parallel"]
    sc = sum(p["cell_r0_scale"]) / len(p["cell_r0_scale"]) if k is None else p["cell_r0_scale"][k]
    r0 = p["cell_r0"] / par * sc * max(1 + p["cell_r0_alpha"] * (t_c - 25), 0.4)
    return r0 + p["cell_r1"] / par * (1 - math.exp(-t_s / p["cell_tau1"]))


def i_to(p: dict, soc: float, t_c: float, v: float, t_s: float = 1.0) -> float:
    """Current at which the pack's first element (each at OCV(soc) + its
    offset, with its own R) reads v after t_s."""
    return max(0.0, min((ocv(p, soc) + p["cell_ocv_offset"][k] - v) / r_elem(p, t_c, t_s, k)
                        for k in range(int(p["cells_series"]))))


def i_power(p: dict, soc: float, t_c: float, watts: float) -> float:
    """Current of a constant-power draw on the sagged pack: I (E - I R) = P,
    E and R the sums over the elements."""
    n = int(p["cells_series"])
    e = sum(ocv(p, soc) + p["cell_ocv_offset"][k] for k in range(n))
    r = sum(r_elem(p, t_c, 1.0, k) for k in range(n))
    disc = e * e - 4 * r * watts
    return (e - math.sqrt(disc)) / (2 * r) if disc >= 0 else float("nan")


# -- stage 2: plot ----------------------------------------------------------------------

THEMES = {
    # dataviz reference palette (light / dark steps), status critical for the trip.
    "light": dict(surface="#fcfcfb", ink="#0b0b0b", ink2="#52514e", muted="#898781",
                  grid="#e1e0d9", axis="#c3c2b7", s1="#2a78d6", s2="#eb6834", s3="#1baf7a",
                  crit="#d03b3b", good="#0ca30c", band="#f0efec"),
    "dark": dict(surface="#1a1a19", ink="#f0efec", ink2="#c3c2b7", muted="#898781",
                 grid="#2c2c2a", axis="#383835", s1="#3987e5", s2="#d95926", s3="#199e70",
                 crit="#d03b3b", good="#0ca30c", band="#383835"),
}


def load(data: Path, key: str) -> dict:
    return json.loads((data / f"{key}.series.json").read_text())


def xy(doc: dict, name: str, t0=None, t1=None):
    pts = doc["series"].get(name, [])
    pts = [q for q in pts if (t0 is None or q[0] >= t0) and (t1 is None or q[0] <= t1)]
    return [q[0] for q in pts], [q[1] for q in pts]


def first(doc: dict, name: str, pred, after=0.0):
    for t, v in doc["series"].get(name, []):
        if t >= after and pred(v):
            return t
    return None


def style(plt, th):
    plt.rcParams.update({
        "figure.facecolor": th["surface"], "axes.facecolor": th["surface"],
        "savefig.facecolor": th["surface"], "text.color": th["ink"],
        "axes.labelcolor": th["ink2"], "axes.edgecolor": th["axis"],
        "xtick.color": th["muted"], "ytick.color": th["muted"],
        "xtick.labelcolor": th["ink2"], "ytick.labelcolor": th["ink2"],
        "axes.grid": True, "grid.color": th["grid"], "grid.linewidth": 0.6,
        "axes.spines.top": False, "axes.spines.right": False,
        "font.family": "sans-serif", "font.size": 10, "axes.titlesize": 11,
        "axes.titleweight": "bold", "axes.titlelocation": "left", "legend.frameon": False,
        "legend.labelcolor": th["ink2"], "lines.linewidth": 2,
    })


def step_xy(xs, ys, t_end):
    """A held signal as steps (samples hold until the next one)."""
    return list(xs) + [t_end], list(ys) + [ys[-1] if ys else 0]


def fig1(plt, th, sag, path):
    t0, t1 = 10.6, 12.4
    T = lambda xs: [x / 1e3 for x in xs]
    step = first(sag, "plant.ts.i_pack", lambda v: v > 1, 10500)
    seen = first(sag, "frame.ACU_v_cell_min.min_cell_mV", lambda v: v < UV_MV, 10500)
    err = first(sag, "symbol.g_state_telemetry", lambda v: v == 5, 10500)
    reason = first(sag, "symbol.g_fault_reason_telemetry", lambda v: v == 4, 10500)
    sdc = first(sag, "plant.sdc.sdc_closed", lambda v: v == 0, 10500)
    air = first(sag, "plant.ts.air_pos_closed", lambda v: v == 0, 10500)
    vmin = min(v for t, v in sag["series"]["plant.ts.v_cell_min"] if 10500 < t < 12500)
    # The confirmation the trip ends: CellFaultConfirmTicks 25 x 10 ms
    # (ams_config.hpp:231, safety_task.cpp:246), back from AMS_OK dropping.
    latch = sdc or err
    confirm_from = latch - 250

    fig, (a, b, c) = plt.subplots(3, 1, figsize=(9, 8.4), sharex=True,
                                  gridspec_kw={"height_ratios": [1, 1.6, 0.8], "hspace": 0.3})
    fig.subplots_adjust(left=0.12, right=0.97, top=0.865, bottom=0.07)
    fig.suptitle(f"AMS latches Error on a healthy pack's load sag (vHIL, 240 A peak at {CAR_SOC:.0%} SoC)",
                 x=0.12, ha="left", y=0.98, fontsize=12.5, fontweight="bold", color=th["ink"])
    fig.text(0.12, 0.905, "Real ECU + AMS images (AMS dev 94b59a9) on the vHIL, per-cell 95S6P VTC6 plant.\n"
             "Pack fitted to car SD log LOG0077 (per-element R0 and OCV offsets, one RC), at the log's end state.",
             fontsize=8.5, color=th["ink2"], linespacing=1.4)

    # (a) current
    x, y = xy(sag, "plant.ts.i_pack", t0 * 1e3, t1 * 1e3)
    a.step(T(x), y, where="post", color=th["s1"], label="Plant (truth)", zorder=3)
    x, y = xy(sag, "frame.ACU_currents.current_accu_dA", t0 * 1e3, t1 * 1e3)
    a.step(T(x), y, where="post", color=th["s2"], label="AMS-reported (0x135, ~0.8 s IIR-filtered)")
    a.axhline(OC_A, color=th["muted"], lw=1, ls=(0, (4, 3)))
    a.text(t1 - 0.01, OC_A + 6, "AMS overcurrent trip 185 A (on the filtered current)", fontsize=8,
           color=th["ink2"], va="bottom", ha="right")
    a.text(step / 1e3 - 0.01, 250, f"240 A step\n{step / 1e3:.3f} s", fontsize=8, color=th["ink2"],
           va="center", ha="right")
    a.set_ylabel("Pack current (A)")
    a.set_ylim(-10, 300)
    a.set_title("(a) Pack current", color=th["ink"])
    a.legend(loc="center right", fontsize=8.5)

    # (b) min cell
    b.axhspan(2.3, CUTOFF_V, color=th["band"], lw=0)
    b.axvspan(confirm_from / 1e3, latch / 1e3, color=th["crit"], alpha=0.10, lw=0)
    b.text((confirm_from + latch) / 2e3, 3.66, "25 × 10 ms confirmation", ha="center", va="center",
           fontsize=8, color=th["ink2"])
    x, y = xy(sag, "frame.ACU_v_cell_min.min_cell_mV", t0 * 1e3, t1 * 1e3)
    b.step(T(x), [v / 1e3 for v in y], where="post", color=th["s2"], label="AMS-reported min cell (0x12C)")
    x, y = xy(sag, "plant.ts.v_cell_min", t0 * 1e3, t1 * 1e3)
    b.step(T(x), y, where="post", color=th["s1"], lw=1.5, label="Plant min cell (truth)", zorder=3)
    b.axhline(UV_MV / 1e3, color=th["crit"], lw=1.2, ls=(0, (5, 3)))
    b.text(t0 + 0.01, UV_MV / 1e3 + 0.015, "CellUnderVoltageMv 2800 mV (AMS trip)", fontsize=8.5,
           color=th["ink"])
    b.axhline(CUTOFF_V, color=th["ink2"], lw=1.2)
    b.text(t0 + 0.01, CUTOFF_V - 0.02, "2.5 V VTC6 discharge cut-off (the cell's real limit)",
           fontsize=8.5, color=th["ink"], va="top")
    b.annotate("", xy=(11.2, vmin), xytext=(11.2, CUTOFF_V),
               arrowprops=dict(arrowstyle="<->", color=th["ink"], lw=1), zorder=4)
    b.text(11.53, 2.63, f"lowest cell {vmin:.3f} V:\n{(vmin - CUTOFF_V) * 1e3:.0f} mV above\nthe cell's limit",
           fontsize=8.5, color=th["ink"], va="center")
    if seen:
        b.text(seen / 1e3 - 0.02, 2.98, f"0x12C reports\n< 2800 mV at {seen / 1e3:.3f} s",
               ha="right", va="center", fontsize=8.5, color=th["ink"])
    f = filter_numbers()
    b.text(11.58, 3.17, f"BMS cell-input filter, 100 Ω + 10 nF\nto GND1 per tap (τ = {f['tau_us']:.0f} µs): "
           f"settles the\n{f['step_mv']:.0f} mV step in ~{f['settle_us']:.0f} µs; ±1 µA × 100 Ω\n"
           f"= ±{f['static_mv']:.1f} mV. Neither causes nor masks\nthe trip (derived).",
           fontsize=7.5, color=th["ink2"], va="center", linespacing=1.35,
           bbox=dict(boxstyle="round,pad=0.4", fc=th["surface"], ec=th["grid"]))
    b.set_ylabel("Min cell voltage (V)")
    b.set_ylim(2.3, 3.75)
    b.set_title("(b) Minimum cell voltage", color=th["ink"])
    b.legend(loc="center left", fontsize=8.5, bbox_to_anchor=(0.0, 0.62))

    # (c) state
    x, y = xy(sag, "symbol.g_state_telemetry", 0, t1 * 1e3)
    xs, ys = step_xy([max(t0, v) for v in T(x)], [1 if v == 3 else 0 for v in y], t1)
    c.fill_between(xs, [1.1] * len(xs), [1.1 + 0.7 * v for v in ys], step="post", color=th["good"], lw=0)
    xs2, ys2 = step_xy([max(t0, v) for v in T(x)], [1 if v == 5 else 0 for v in y], t1)
    c.fill_between(xs2, [1.1] * len(xs2), [1.1 + 0.7 * v for v in ys2], step="post", color=th["crit"], lw=0)
    x, y = xy(sag, "plant.ts.air_pos_closed", 0, t1 * 1e3)
    xs3, ys3 = step_xy([max(t0, v) for v in T(x)], y, t1)
    c.fill_between(xs3, [0.1] * len(xs3), [0.1 + 0.7 * v for v in ys3], step="post", color=th["s1"], lw=0)
    c.set_yticks([0.45, 1.45], ["AIR+", "AMS state"])
    c.tick_params(axis="y", length=0)
    c.grid(False, axis="y")
    c.set_ylim(0, 1.95)
    c.text(t0 + 0.02, 1.45, "Run", color="#ffffff", va="center", fontsize=8.5, fontweight="bold")
    c.text(t0 + 0.02, 0.45, "closed", color="#ffffff", va="center", fontsize=8.5, fontweight="bold")
    if err:
        c.text(err / 1e3 + 0.02, 1.45, f"Error, reason {4 if reason else '?'} CellUnderVoltage (latched)",
               color="#ffffff", va="center", fontsize=8.5, fontweight="bold")
        c.annotate(f"AMS_OK drops, SDC opens {sdc / 1e3:.3f} s; AIR+ opens {air / 1e3:.3f} s",
                   xy=(air / 1e3, 0.45), xytext=(11.45, 0.45), va="center", fontsize=8.5, color=th["ink"],
                   arrowprops=dict(arrowstyle="-", color=th["ink2"], lw=0.8))
    c.set_title("(c) AMS state and AIR+", color=th["ink"])
    c.set_xlabel("Virtual time since power-on (s)")
    for ax in (a, b, c):
        for t in (step, air):
            ax.axvline(t / 1e3, color=th["muted"], lw=0.8, ls=":")
    a.set_xlim(t0, t1)
    fig.savefig(path, dpi=160)
    plt.close(fig)
    return dict(step=step, seen=seen, err=err, reason=reason, sdc=sdc, air=air, vmin=vmin)


def fig2(plt, th, sag, ride, path):
    t0, t1 = 10.6, 12.6
    fig, ax = plt.subplots(figsize=(9, 4.6))
    fig.subplots_adjust(left=0.1, right=0.97, top=0.83, bottom=0.12)
    fig.suptitle("Same pack, two peaks: 173 A rides through, 240 A trips", x=0.1, ha="left",
                 fontsize=12.5, fontweight="bold", color=th["ink"])
    fig.text(0.1, 0.875, f"AMS-reported min cell (0x12C) and plant truth, car-fitted pack (LOG0077) at {CAR_SOC:.0%} SoC, "
             f"{CAR_T_C:.0f} °C, 1 s peak from 11.0 s.\n173 A is the highest peak in LOG0077, which the car carried "
             "with no fault.", fontsize=8.5, color=th["ink2"], linespacing=1.4)
    ax.axhspan(2.3, CUTOFF_V, color=th["band"], lw=0)
    for doc, col, name in ((ride, th["s3"], "173 A"), (sag, th["s1"], "240 A")):
        x, y = xy(doc, "plant.ts.v_cell_min", t0 * 1e3, t1 * 1e3)
        ax.step([v / 1e3 for v in x], y, where="post", color=col, lw=1.2, alpha=0.55)
        x, y = xy(doc, "frame.ACU_v_cell_min.min_cell_mV", t0 * 1e3, t1 * 1e3)
        ax.step([v / 1e3 for v in x], [v / 1e3 for v in y], where="post", color=col, lw=2,
                label=f"{name} peak (AMS-reported; thin = plant)")
    err = first(sag, "symbol.g_state_telemetry", lambda v: v == 5, 10500)
    ride_err = first(ride, "symbol.g_state_telemetry", lambda v: v == 5, 10500)
    ax.axhline(UV_MV / 1e3, color=th["crit"], lw=1.2, ls=(0, (5, 3)))
    ax.text(t1 - 0.01, UV_MV / 1e3 + 0.015, "2800 mV AMS trip threshold", ha="right", fontsize=8.5,
            color=th["ink"])
    ax.axhline(CUTOFF_V, color=th["ink2"], lw=1.2)
    ax.text(t1 - 0.01, CUTOFF_V + 0.015, "2.5 V cell cut-off", ha="right", fontsize=8.5, color=th["ink"])
    r_v = min(v for t, v in ride["series"]["plant.ts.v_cell_min"] if 10500 < t < 12500)
    ax.text(11.5, r_v + 0.09, f"173 A: min {r_v:.2f} V, stays in Run" + ("" if not ride_err else " (ERROR?)"),
            fontsize=9, color=th["ink"], ha="center")
    if err:
        ax.axvline(err / 1e3, color=th["muted"], lw=0.8, ls=":")
        ax.text(err / 1e3 + 0.02, 2.62, f"240 A: Error (reason 4) at {err / 1e3:.3f} s,\nAIR+ opens",
                fontsize=9, color=th["ink"])
    ax.set_xlim(t0, t1)
    ax.set_ylim(2.3, 3.75)
    ax.set_xlabel("Virtual time since power-on (s)")
    ax.set_ylabel("Min cell voltage (V)")
    ax.legend(loc="upper right", fontsize=8.5)
    fig.savefig(path, dpi=160)
    plt.close(fig)
    return dict(ride_vmin=r_v, ride_err=ride_err)


def fig3(plt, th, path):
    p, ds = cell_params(), cell_params(None)
    tc, soc0, x0 = CAR_T_C, CAR_SOC, CAR_SOC * 100
    socs = [s / 100 for s in range(10, 101)]
    fig, ax = plt.subplots(figsize=(9, 5.6))
    fig.subplots_adjust(left=0.1, right=0.97, top=0.83, bottom=0.11)
    fig.suptitle("Trip map: which 1 s peaks falsely latch CellUnderVoltage on a healthy pack", x=0.1,
                 ha="left", fontsize=12.5, fontweight="bold", color=th["ink"])
    fig.text(0.1, 0.865, "Derived from the pack fitted to car SD log LOG0077: V = OCV(SoC) + offset − I·R0(T) − RC term "
             "at 1 s,\nper 6P element, each with its own R0 and offset; the first element to cross sets the line "
             "(catalog/plants/tractive-system.yaml).", fontsize=8.5, color=th["ink2"], linespacing=1.4)
    pct = [s * 100 for s in socs]
    i28 = [i_to(p, s, tc, UV_MV / 1e3) for s in socs]
    i28_10 = [i_to(p, s, 10, UV_MV / 1e3) for s in socs]
    i25 = [i_to(p, s, tc, CUTOFF_V) for s in socs]
    i25_10 = [i_to(p, s, 10, CUTOFF_V) for s in socs]
    i28_ds = [i_to(ds, s, 25, UV_MV / 1e3) for s in socs]
    ip = [i_power(p, s, tc, P_ECU_W) for s in socs]
    top = 600
    # false-trip region at the car's temperature: above the 2800 mV line, below the 2.5 V line
    ax.fill_between(pct, i28, [min(top, v) for v in i25], color=th["crit"], alpha=0.14, lw=0)
    ax.fill_between(pct, [min(top, v) for v in i25], [top] * len(pct), color=th["band"], lw=0)
    ax.plot(pct, i28, color=th["crit"], label=f"AMS trips (2800 mV), {tc:.0f} °C")
    ax.plot(pct, i28_10, color=th["crit"], ls=(0, (5, 3)), label="AMS trips (2800 mV), 10 °C")
    ax.plot(pct, i25, color=th["ink2"], label=f"Cell really at 2.5 V, {tc:.0f} °C")
    ax.plot(pct, i25_10, color=th["ink2"], ls=(0, (5, 3)), label="Cell really at 2.5 V, 10 °C")
    ax.plot(pct, i28_ds, color=th["muted"], lw=1, ls=(0, (1, 2)),
            label="AMS trips, datasheet pack (uniform, balanced), 25 °C")
    ax.plot(pct, ip, color=th["s1"], lw=1.6, label="ECU 76 kW limit at full power (current on the sagged pack)")
    ax.axhline(OC_A, color=th["s2"], lw=1.4, ls=(0, (2, 2)))
    ax.text(99, OC_A + 6, "AMS overcurrent 185 A (filtered, ~0.8 s; a 1 s 240 A peak reads ~172 A)",
            ha="right", fontsize=8, color=th["ink2"])
    ax.annotate("shaded: false trip, cell healthy,\nAMS opens AIR+", xy=(78, 275), xytext=(66, 120),
                fontsize=8.5, color=th["ink"], arrowprops=dict(arrowstyle="-", color=th["ink2"], lw=0.8))
    ax.text(14, 560, "cell below 2.5 V", fontsize=8.5, color=th["ink2"])
    ax.axvline(x0, color=th["muted"], lw=0.8, ls=":")
    ax.plot([x0], [240], "o", ms=9, color=th["crit"], mec=th["surface"], mew=2, zorder=5)
    ax.annotate(f"vHIL repro: {x0:.0f} % (LOG0077's end), 240 A → Error", xy=(x0, 240), xytext=(14, 440),
                fontsize=9, color=th["ink"], arrowprops=dict(arrowstyle="-", color=th["ink2"], lw=0.8))
    ax.plot([x0], [173], "o", ms=9, color=th["s3"], mec=th["surface"], mew=2, zorder=5)
    ax.annotate("control: 173 A (the car's highest peak in\nLOG0077, no fault) → no fault", xy=(x0, 173),
                xytext=(x0 + 4, 30), fontsize=9, color=th["ink"],
                arrowprops=dict(arrowstyle="-", color=th["ink2"], lw=0.8))
    ax.set_xlim(10, 100)
    ax.set_ylim(0, top)
    ax.set_xlabel("State of charge (%)")
    ax.set_ylabel("Peak pack current, 1 s (A)")
    ax.legend(loc="upper right", fontsize=7.5, ncol=1)
    fig.savefig(path, dpi=160)
    plt.close(fig)
    n = int(p["cells_series"])
    first_k = min(range(n), key=lambda k: (ocv(p, soc0) + p["cell_ocv_offset"][k] - UV_MV / 1e3)
                  / r_elem(p, tc, 1.0, k))
    return dict(i_trip_car=i_to(p, soc0, tc, UV_MV / 1e3), i_trip_car_instant=i_to(p, soc0, tc, UV_MV / 1e3, 0.0),
                i_trip_car_10=i_to(p, soc0, 10, UV_MV / 1e3), i_25v_car=i_to(p, soc0, tc, CUTOFF_V),
                first_element=f"c{first_k // 19}_{first_k % 19}",
                i_trip_datasheet_25=i_to(ds, soc0, 25, UV_MV / 1e3), i_76kw_car=i_power(p, soc0, tc, P_ECU_W),
                r_elem_mean=r_elem(p, tc), r_elem_first=r_elem(p, tc, 1.0, first_k))


def fig4(plt, th, sag, path):
    """Illustration of fix direction 1: V + I R_element, each reading paired
    with the current at the same instant (what the AMS's conversion-synchronised
    current window gives), R_element = the pack's mean R0 at the run's
    temperature (one number for every cell, as a firmware would use); the RC
    branch is left in."""
    p = cell_params()
    r = r_elem(p, CAR_T_C, 0.0)
    t0, t1 = 10.6, 12.4

    def held(name, t):
        v = None
        for ti, vi in sag["series"][name]:
            if ti > t:
                break
            v = vi
        return v

    grid = [t0 * 1e3 + k for k in range(0, int((t1 - t0) * 1e3) + 1)]
    v = [held("plant.ts.v_cell_min", t) for t in grid]
    i = [held("plant.ts.i_pack", t) or 0.0 for t in grid]
    comp = [vv + ii * r for vv, ii in zip(v, i)]
    err = first(sag, "symbol.g_state_telemetry", lambda x: x == 5, 10500)
    air = first(sag, "plant.ts.air_pos_closed", lambda x: x == 0, 10500)
    fig, ax = plt.subplots(figsize=(9, 4.6))
    fig.subplots_adjust(left=0.1, right=0.97, top=0.76, bottom=0.12)
    fig.suptitle("Illustration: the same 240 A run, load-compensated (V + I·R_element)", x=0.1, ha="left",
                 y=0.98, fontsize=12.5, fontweight="bold", color=th["ink"])
    fig.text(0.1, 0.81, f"Lowest cell and pack current at the same instant (the vHIL plant; on the car, the current "
             f"window synchronised\nto the conversion, not 0x135's filtered value), R_element = the car-fitted pack's "
             f"mean R0 = {r * 1e3:.2f} mΩ at {CAR_T_C:.0f} °C.\nOne fix direction; the choice is the AMS team's.",
             fontsize=8.5, color=th["ink2"], linespacing=1.4)
    T = [t / 1e3 for t in grid]
    ax.plot(T, v, color=th["s2"], label="Raw lowest cell (what the AMS compares today)", drawstyle="steps-post")
    ax.plot(T, comp, color=th["s1"], label="Load-compensated V + I·R_element", drawstyle="steps-post")
    ax.axhline(UV_MV / 1e3, color=th["crit"], lw=1.2, ls=(0, (5, 3)))
    ax.text(t1 - 0.01, UV_MV / 1e3 + 0.015, "2800 mV threshold", ha="right", fontsize=8.5, color=th["ink"])
    under = [c for t, c in zip(grid, comp) if 11000 <= t < air]
    rest = [c for t, c in zip(grid, comp) if t < 11000]
    ax.text(11.33, 3.48, f"compensated: min {min(under):.3f} V under 240 A,\n"
            f"{(min(under) - UV_MV / 1e3) * 1e3:.0f} mV above the threshold. Nearly flat: under load the\n"
            f"lowest element is another one (higher R0): {(min(rest) - min(under)) * 1e3:.0f} mV under rest.\n"
            "One R_element for every cell leaves that, plus the estimate's\nerror (temperature, ageing).",
            fontsize=8.5, color=th["ink"], va="top")
    ax.axvline(air / 1e3, color=th["muted"], lw=0.8, ls=":")
    ax.text(air / 1e3 + 0.02, 2.66, f"raw reading latched Error ({err / 1e3:.3f} s);\n"
            f"AIR+ opens {air / 1e3:.3f} s, the current stops", fontsize=8.5, color=th["ink2"])
    ax.set_xlim(t0, t1)
    ax.set_ylim(2.5, 3.75)
    ax.set_xlabel("Virtual time since power-on (s)")
    ax.set_ylabel("Cell voltage (V)")
    ax.legend(loc="upper right", fontsize=8.5)
    fig.savefig(path, dpi=160)
    plt.close(fig)
    return dict(comp_min_under_load=min(under), comp_rest=min(rest), r_element=r)


def filter_numbers() -> dict:
    """The BMS_LITE cell-input filter (per tap: 100 ohm series, 10 nF to
    GND1, BMS_LITE cell sheet R28/C23) against the LTC6811 datasheet (Rev. C:
    C-pin current +-1 uA measuring, ADOW 70/100/130 uA, Table 5 7 kHz ADCV
    2335 us and 144 us per channel pair, Table 13 ADOW count). Derived."""
    r, c = 100.0, 10e-9
    tau = r * c
    p = cell_params()
    step = 240 * r_elem(p, CAR_T_C, 0.0)                # the element's i R0 step (pack mean), V
    lsb = 100e-6
    cm_top = 10 * step                                  # 10 cells on an LTC: the top tap's CM step
    return dict(
        tau_us=tau * 1e6, step_mv=step * 1e3,
        settle_us=tau * math.log(step / lsb) * 1e6,     # to 1 LSB
        settle_cm_us=tau * math.log(cm_top / lsb) * 1e6,
        conv_us=2335, static_mv=1e-6 * r * 1e3,
        adow_node_mv=[i * r * 1e3 for i in (70e-6, 100e-6, 130e-6)],
        adow_slew_mv_per_us=100e-6 / c / 1e6 * 1e3,
        adow_open_v_per_conv=100e-6 / c * 144e-6,       # pulled while its channel pair converts
        adow_cmds_needed=1 + math.ceil(round(c / 10e-9, 6)),
        adow_cmds_needed_c11n=1 + math.ceil(11e-9 / 10e-9),
        drop_a_trip_no_offset=0.4 / r_elem(p, CAR_T_C, 0.0),
        drop_a_trip_130=(0.4 - 0.13) / r_elem(p, CAR_T_C, 0.0),
    )


# -- the car's SD log (figure 5) --------------------------------------------------------
#
# LOG0077.CSV, the AMS's own 4 Hz SD log of the 2026-09-29 drive (AMS around
# v3.0.2). The raw logs are not in this repo; `car --logs <dir>` reads them and
# writes the figure plus the derived numbers (data/car-log0077.json).

CAR_LOG = "LOG0077.CSV"
CAR_RUN = 3           # fsm::State::Run (state_machine.hpp)
CAR_REST_A = 3.0      # |I_raw| below this, on a row and the row before it, is "at rest"
CAR_ZOOM_S = 30.0


def car_rows(logs: Path) -> list[dict]:
    import csv
    with open(logs / CAR_LOG, newline="") as f:
        return [{k: float(v) for k, v in row.items() if v not in ("", None)} for row in csv.DictReader(f)]


def lsq(x, y):
    """y = a + b x by least squares; returns (a, b, r2)."""
    n = len(x)
    mx, my = sum(x) / n, sum(y) / n
    sxx = sum((u - mx) ** 2 for u in x)
    sxy = sum((u - mx) * (v - my) for u, v in zip(x, y))
    syy = sum((v - my) ** 2 for v in y)
    b = sxy / sxx
    return my - b * mx, b, sxy * sxy / (sxx * syy)


def car_numbers(rows: list[dict]) -> dict:
    cells = [k for k in rows[0] if k[0] == "c" and k[1].isdigit()]
    run = [r for r in rows if r["fsm"] == CAR_RUN]
    t = [r["tick_ms"] / 1e3 for r in run]
    i = [r["I_raw_mA"] / 1e3 for r in run]
    # The cell row lags the current row by about one 250 ms sample (the
    # voltage poll and the current read are not simultaneous): fit each
    # voltage against the current one row earlier.
    pack = lsq(i[:-1], [r["pack_mV"] / 1e3 for r in run[1:]])
    vmin = lsq(i[:-1], [r["vmin_mV"] for r in run[1:]])
    weak = min(cells, key=lambda c: sorted(r[c] for r in run)[len(run) // 2])
    weak_fit = lsq(i[:-1], [r[weak] for r in run[1:]])
    rest = [run[k] for k in range(1, len(run)) if abs(i[k]) < CAR_REST_A and abs(i[k - 1]) < CAR_REST_A]
    late = [r for r in rest if r["tick_ms"] / 1e3 >= t[-1] - CAR_ZOOM_S]
    med = lambda xs: sorted(xs)[len(xs) // 2]
    avg = lambda r: sum(r[c] for c in cells) / len(cells)
    spread = [max(r[c] for c in cells) - min(r[c] for c in cells) for r in rest]
    late_spread = [max(r[c] for c in cells) - min(r[c] for c in cells) for r in late]
    offsets = {c: round(med([r[c] - avg(r) for r in late]), 1) for c in cells}
    weak_rest = med([r[weak] for r in late])
    k_mv_a = -vmin[1]
    is_min = sum(1 for r in run if r[weak] == r["vmin_mV"])
    deep = min(run, key=lambda r: r[weak])
    peak = max(run, key=lambda r: r["I_raw_mA"])
    return dict(
        log=CAR_LOG, rows=len(rows), run_rows=len(run), run_from_s=t[0], log_end_s=rows[-1]["tick_ms"] / 1e3,
        run_s=t[-1] - t[0], temp_C=[min(r["tmin_C"] for r in run), max(r["tmax_C"] for r in run)],
        i_raw_peak_A=peak["I_raw_mA"] / 1e3, i_raw_peak_s=peak["tick_ms"] / 1e3,
        i_filt_peak_A=max(r["I_filt_mA"] for r in run) / 1e3,
        pack_fit=dict(v0_V=pack[0], mv_per_A=-pack[1] * 1e3, r_element_mohm=-pack[1] / len(cells) * 1e3,
                      r2=pack[2], lag_rows=1),
        vmin_fit=dict(v0_mV=vmin[0], mv_per_A=k_mv_a, r2=vmin[2], lag_rows=1),
        weak_cell=weak, weak_is_min_rows=is_min, weak_fit=dict(v0_mV=weak_fit[0], mv_per_A=-weak_fit[1],
                                                               r2=weak_fit[2]),
        weak_deepest_mV=deep[weak], weak_deepest_s=deep["tick_ms"] / 1e3,
        weak_rest_late_mV=weak_rest, avg_rest_late_mV=med([avg(r) for r in late]),
        rest_spread_mV=[min(spread), max(spread)], rest_spread_late_mV=[min(late_spread), max(late_spread)],
        crossing_A=(weak_rest - UV_MV) / k_mv_a,
        rest_offsets_late_mV=dict(sorted(offsets.items(), key=lambda kv: kv[1])),
        last_rows=[dict(t_s=r["tick_ms"] / 1e3, i_raw_A=r["I_raw_mA"] / 1e3, weak_mV=r[weak]) for r in rows[-4:]],
        cells=cells,
    )


def fig5(plt, th, rows, n, path):
    run = [r for r in rows if r["fsm"] == CAR_RUN]
    weak, cells, k = n["weak_cell"], n["cells"], n["vmin_fit"]["mv_per_A"]
    T = [r["tick_ms"] / 1e3 for r in rows]
    end = n["log_end_s"]
    z0 = end - CAR_ZOOM_S

    fig = plt.figure(figsize=(9, 10.6))
    gs = fig.add_gridspec(3, 2, height_ratios=[1, 1.25, 1.3], width_ratios=[1.55, 1], hspace=0.42, wspace=0.26)
    a = fig.add_subplot(gs[0, :])
    b = fig.add_subplot(gs[1, :], sharex=a)
    c = fig.add_subplot(gs[2, 0])
    d = fig.add_subplot(gs[2, 1])
    fig.subplots_adjust(left=0.09, right=0.97, top=0.865, bottom=0.055)
    fig.suptitle("Car SD log: the weakest cell sags toward 2800 mV under ordinary peaks", x=0.09, ha="left",
                 y=0.98, fontsize=12.5, fontweight="bold", color=th["ink"])
    fig.text(0.09, 0.9, f"AMS LOG0077.CSV (2026-09-29 drive, AMS around v3.0.2), 4 Hz rows, {n['run_s']:.0f} s in Run, "
             f"{n['temp_C'][0]:.0f}–{n['temp_C'][1]:.0f} °C.\nThe file ends at {end:.2f} s with no fault row; "
             "the next file boots straight into a latched Error with reason 0\n(a warm reset: the latch lives in the "
             "backup domain, which an LV power-cycle clears on this board).",
             fontsize=8.5, color=th["ink2"], linespacing=1.4)

    # (a) current
    a.plot(T, [r["I_raw_mA"] / 1e3 for r in rows], color=th["s1"], lw=1.3, label="I_raw (per 250 ms row)")
    a.plot(T, [r["I_filt_mA"] / 1e3 for r in rows], color=th["s2"], lw=1.6, label="I_filt (the overcurrent check's input)")
    a.axhline(OC_A, color=th["muted"], lw=1, ls=(0, (4, 3)))
    a.text(4, OC_A + 6, "AMS overcurrent trip 185 A (on I_filt)", fontsize=8, color=th["ink2"], va="bottom")
    a.annotate(f"{n['i_raw_peak_A']:.0f} A", xy=(n["i_raw_peak_s"], n["i_raw_peak_A"]),
               xytext=(n["i_raw_peak_s"] - 14, n["i_raw_peak_A"] + 8), fontsize=8, color=th["ink"],
               arrowprops=dict(arrowstyle="-", color=th["ink2"], lw=0.8))
    a.set_ylim(-20, 230)
    a.set_ylabel("Pack current (A)")
    a.set_title("(a) Pack current", color=th["ink"])
    a.legend(loc="upper left", fontsize=8.5, ncol=2, bbox_to_anchor=(0.0, 0.84))

    # (b) cells
    avg = [sum(r[c_] for c_ in cells) / len(cells) / 1e3 for r in rows]
    b.plot(T, avg, color=th["s3"], lw=1.4, label="Pack-average cell")
    b.plot(T, [r["vmin_mV"] / 1e3 for r in rows], color=th["s2"], lw=3.4, alpha=0.45,
           label=f"Min cell (vmin; is {weak} in {n['weak_is_min_rows']} of {n['run_rows']} Run rows)")
    b.plot(T, [r[weak] / 1e3 for r in rows], color=th["s1"], lw=1.2, label=f"{weak} (weakest cell)")
    b.axhline(UV_MV / 1e3, color=th["crit"], lw=1.2, ls=(0, (5, 3)))
    b.text(4, UV_MV / 1e3 + 0.02, "CellUnderVoltageMv 2800 mV (AMS trip)", fontsize=8.5, color=th["ink"])
    b.annotate(f"deepest logged: {n['weak_deepest_mV']:.0f} mV", xy=(n["weak_deepest_s"], n["weak_deepest_mV"] / 1e3),
               xytext=(n["weak_deepest_s"] - 40, 2.93), fontsize=8.5, color=th["ink"],
               arrowprops=dict(arrowstyle="-", color=th["ink2"], lw=0.8))
    b.set_ylim(2.7, 4.0)
    b.set_ylabel("Cell voltage (V)")
    b.set_title("(b) Cells: pack average, min cell and the weakest cell", color=th["ink"])
    b.legend(loc="lower left", fontsize=8.5, ncol=1, bbox_to_anchor=(0.0, 0.12))
    for ax in (a, b):
        ax.axvspan(z0, end, color=th["band"], lw=0, zorder=0)
        ax.axvline(end, color=th["muted"], lw=0.8, ls=":")
    b.set_xlabel("Time since AMS boot (s)")
    a.set_xlim(0, end + 4)
    plt.setp(a.get_xticklabels(), visible=False)

    # (c) last 30 s: measured weak cell vs the I·R projection from rest
    zr = [r for r in rows if r["tick_ms"] / 1e3 >= z0 - 0.25]
    zt = [r["tick_ms"] / 1e3 for r in zr]
    vrest = n["weak_rest_late_mV"]
    proj = [vrest - k * max(0.0, zr[j - 1]["I_raw_mA"] / 1e3) for j in range(1, len(zr))]
    c.axhline(UV_MV / 1e3, color=th["crit"], lw=1.2, ls=(0, (5, 3)))
    c.plot(zt[1:], [v / 1e3 for v in proj], color=th["s2"], lw=1.4, ls=(0, (3, 2)),
           label=f"Projected: {vrest / 1e3:.2f} V − {k:.2f} mV/A × I_raw")
    c.plot(zt, [r[weak] / 1e3 for r in zr], color=th["s1"], lw=1.6, label=f"{weak} measured")
    c.axvline(end, color=th["muted"], lw=0.8, ls=":")
    c.text(end - 0.3, 3.88, f"log ends\n{end:.2f} s", ha="right", va="top", fontsize=8, color=th["ink2"])
    c.text(end - 0.3, UV_MV / 1e3 + 0.02, f"2800 mV needs ≈{n['crossing_A']:.0f} A", ha="right", fontsize=8.5,
           color=th["ink"])
    c.set_xlim(z0, end + 1.5)
    c.set_ylim(2.7, 4.0)
    c.set_xlabel("Time since AMS boot (s)")
    c.set_ylabel("Cell voltage (V)")
    c.set_title(f"(c) Last {CAR_ZOOM_S:.0f} s, {weak}", color=th["ink"])
    c.legend(loc="upper left", fontsize=7.5)

    # (d) min-cell sag against current
    xi = [r["I_raw_mA"] / 1e3 for r in run[:-1]]
    yv = [r["vmin_mV"] / 1e3 for r in run[1:]]
    d.scatter(xi, yv, s=9, color=th["s1"], alpha=0.45, lw=0, label="Run rows (vmin vs I_raw a row earlier)")
    v0 = n["vmin_fit"]["v0_mV"]
    xs = [0, 260]
    d.plot(xs, [(v0 - k * x) / 1e3 for x in xs], color=th["ink2"], lw=1.2,
           label=f"fit: −{k:.2f} mV/A, R² {n['vmin_fit']['r2']:.2f}")
    d.plot(xs, [(vrest - k * x) / 1e3 for x in xs], color=th["s2"], lw=1.4, ls=(0, (3, 2)),
           label=f"from {weak}'s late rest {vrest / 1e3:.2f} V")
    d.axhline(UV_MV / 1e3, color=th["crit"], lw=1.2, ls=(0, (5, 3)))
    d.plot([n["crossing_A"]], [UV_MV / 1e3], "o", ms=8, mfc=th["surface"], mec=th["crit"], mew=2)
    d.annotate(f"≈{n['crossing_A']:.0f} A", xy=(n["crossing_A"], UV_MV / 1e3), xytext=(n["crossing_A"] - 50, 2.74),
               fontsize=8.5, color=th["ink"], arrowprops=dict(arrowstyle="-", color=th["ink2"], lw=0.8))
    d.set_xlim(-10, 260)
    d.set_ylim(2.7, 4.0)
    d.set_xlabel("I_raw (A)")
    d.set_title("(d) Min cell vs current", color=th["ink"])
    d.legend(loc="upper right", fontsize=7.2)
    fig.savefig(path, dpi=160)
    plt.close(fig)


def car(logs: Path, out: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    rows = car_rows(logs)
    n = car_numbers(rows)
    out.mkdir(parents=True, exist_ok=True)
    for mode, th in THEMES.items():
        plt.rcdefaults()
        style(plt, th)
        fig5(plt, th, rows, n, out / f"fig5-car-log0077-{mode}.png")
    keep = {k: v for k, v in n.items() if k != "cells"}
    (out / "data").mkdir(exist_ok=True)
    (out / "data" / "car-log0077.json").write_text(json.dumps(keep, indent=1) + "\n")
    print(json.dumps({k: v for k, v in keep.items() if k != "rest_offsets_late_mV"}, indent=1))


def plot(data: Path, out: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    sag, ride = load(data, "sag"), load(data, "ride")
    out.mkdir(parents=True, exist_ok=True)
    facts = {}
    for mode, th in THEMES.items():
        plt.rcdefaults()
        style(plt, th)
        facts["fig1"] = fig1(plt, th, sag, out / f"fig1-timeline-240a-{mode}.png")
        facts["fig2"] = fig2(plt, th, sag, ride, out / f"fig2-240a-vs-100a-{mode}.png")
        facts["fig3"] = fig3(plt, th, out / f"fig3-trip-map-{mode}.png")
        facts["fig4"] = fig4(plt, th, sag, out / f"fig4-load-compensated-{mode}.png")
    facts["filter"] = filter_numbers()
    print(json.dumps(facts, indent=1))


# -- figures 6-7: CellOpenWire (16) on a load release (AMS#641) ------------------------

OW_MV = 400            # CellOpenWireDeltaMv, AMS ams_config.hpp:43
OW_OFFSET_MV = -127    # healthy ADOW offset, top cell of an upper LTC (AMS #512)
SCAN_US = 2335         # LTC6811 7 kHz all-cell scan (datasheet Table 5)
CAR_PASS_MS = (10.7, 12.6)   # PU->PD on the car: 2 x osDelay(3) (2-3 ms) + 5 x 84 B at 515.625 kHz


def fig6(plt, th, cut, path):
    """Timeline of the vHIL repro: 180 A cut to 0 in 2 ms between the pull-up
    and pull-down scans; c0_10 (chip 1 input 1) sampled by each."""
    rel = cut["trace"][-1]["t_us"]
    i0 = cut["trace"][-2]["set"]["i_inverter_dc"]
    ramp_us = cut["trace"][-1]["set"]["i_ramp_ms"] * 1000
    pu, pd1, pd2 = cut["scans"]
    pair = 1                                         # cell index 1 -> pair 1 (C2/C8)
    at = lambda scan: (scan["start_us"] + (pair + 0.5) * SCAN_US / 6 - rel) / 1e3
    v_pu, v_pd1, v_pd2 = (sc["cells_mV"][pair] for sc in (pu, pd1, pd2))
    r = (v_pd2 - v_pu) / i0                          # mOhm, as the scans see it
    # The plant's staircase (vhil/plant_ts.py RAMP_STEP_US = 250 us)
    ts = [-8.0, 0.0]
    cur = [i0, i0]
    for k in range(1, int(ramp_us // 250) + 1):
        ts += [k * 0.25, k * 0.25]
        cur += [cur[-1], i0 * (1 - k * 250 / ramp_us)]
    ts.append(30.0)
    cur.append(0.0)
    vt = [v_pd2 - c * r for c in cur]
    tl = [(q["t_us"] - rel) / 1e3 for q in cut["timeline"]]
    err = next(t for t, q in zip(tl, cut["timeline"]) if q["state"] == 5)
    air = next(t for t, q in zip(tl, cut["timeline"]) if not q["air_pos"])

    fig, axs = plt.subplots(3, 1, figsize=(9, 7.2), sharex=True,
                            gridspec_kw=dict(height_ratios=[1, 1.7, 0.75]))
    fig.subplots_adjust(left=0.1, right=0.97, top=0.86, bottom=0.08, hspace=0.18)
    fig.suptitle("A torque cut between the ADOW scans latches CellOpenWire (16)",
                 x=0.1, ha="left", fontsize=12.5, fontweight="bold", color=th["ink"])
    fig.text(0.1, 0.895, f"vHIL, ecu-ams on the car-fitted pack (car-log0077, SoC 0.584, 21.9 °C), AMS dev: "
             f"{i0:.0f} A → 0 in {ramp_us / 1e3:.0f} ms right after the pull-up scan.\n"
             "The AMS compares cell c0_10's pull-up reading with its pull-down one; the cut moved the cell by "
             "I·R in between.", fontsize=8.5, color=th["ink2"], linespacing=1.4)
    win = (at(pu), at(pd2))
    for ax in axs:
        ax.axvspan(*win, color=th["band"], lw=0, zorder=0)
    a = axs[0]
    a.plot(ts, cur, color=th["s1"], drawstyle="default")
    a.set_ylabel("Pack current (A)")
    a.set_ylim(-10, i0 * 1.25)
    a.text(win[0] + 0.15, i0 * 1.08, f"PU → PD: {win[1] - win[0]:.1f} ms in the vHIL, "
           f"~{CAR_PASS_MS[0]:.0f}–{CAR_PASS_MS[1]:.0f} ms on the car", fontsize=8, color=th["ink2"])
    a = axs[1]
    a.plot(ts, vt, color=th["s1"], lw=1.6, label="c0_10 terminal voltage (plant)")
    a.plot([at(pu)], [v_pu], "o", ms=9, color=th["s2"], mec=th["surface"], mew=2, zorder=5,
           label="pull-up scan sample (CELL_PU)")
    a.plot([at(pd1)], [v_pd1], "o", ms=8, mfc=th["surface"], mec=th["muted"], mew=1.5, zorder=5,
           label="first pull-down scan (settling, discarded)")
    a.plot([at(pd2)], [v_pd2], "s", ms=8, color=th["s3"], mec=th["surface"], mew=2, zorder=5,
           label="pull-down scan sample (CELL_PD)")
    a.annotate(f"PU − PD = {v_pu:.0f} − {v_pd2:.0f} = {v_pu - v_pd2:.0f} mV\n< −{OW_MV} mV: "
               "conductor 1 of chip 1 'open'", xy=(at(pd2), v_pd2), xytext=(at(pd2) + 4, v_pd2 - 260),
               fontsize=9, color=th["ink"], arrowprops=dict(arrowstyle="-", color=th["ink2"], lw=0.8))
    a.set_ylabel("Cell c0_10 (mV)")
    a.legend(loc="lower right", fontsize=7.5)
    a = axs[2]
    tt = [-8.0] + tl
    run_ = [1] + [1 if q["state"] == 3 else 0 for q in cut["timeline"]]
    airc = [1] + [q["air_pos"] for q in cut["timeline"]]
    a.step(tt, [v + 0.04 for v in run_], where="post", color=th["crit"], lw=1.8, label="AMS in Run")
    a.step(tt, airc, where="post", color=th["ink2"], lw=1.8, ls=(0, (4, 2)), label="AIR+ closed")
    a.set_yticks([0, 1])
    a.set_yticklabels(["no", "yes"])
    a.set_ylim(-0.25, 1.35)
    a.text(err + 0.4, 0.45, f"Error, reason 16: +{err:.0f} ms", fontsize=8.5, color=th["ink"])
    a.text(air - 0.4, 0.12, f"AIR+ opens: +{air:.0f} ms", ha="right", fontsize=8.5, color=th["ink"])
    a.legend(loc="upper right", fontsize=7.5, ncol=2)
    a.set_xlabel("Time from the start of the cut (ms)")
    a.set_xlim(-8, 30)
    fig.savefig(path, dpi=160)
    plt.close(fig)
    return dict(pu_mV=v_pu, pd_mV=v_pd2, delta_mV=v_pu - v_pd2, r_mohm=r, window_ms=win[1] - win[0],
                error_ms=err, air_open_ms=air)


def fig7(plt, th, sweep, path):
    """Trip map: current fall between the scans against element resistance."""
    p = cell_params()
    n = int(p["cells_series"])
    rs = [r_elem(p, CAR_T_C, 0.0, k) * 1e3 for k in range(n)]
    # Which elements the interior rule checks: chip-local cell index >= 1.
    upper = 9
    top = {k for k in range(n) if k % 19 in (upper - 1, 18)}
    checked = [k for k in range(n) if k % 19 not in (0, upper)]
    fig, ax = plt.subplots(figsize=(9, 5.6))
    fig.subplots_adjust(left=0.1, right=0.97, top=0.83, bottom=0.11)
    fig.suptitle("Trip map: how much current may fall between the ADOW scans", x=0.1, ha="left",
                 fontsize=12.5, fontweight="bold", color=th["ink"])
    fig.text(0.1, 0.865, "PU − PD = −R·ΔI for a healthy element whose current falls by ΔI between the "
             "pull-up and the pull-down scan;\nthe AMS faults below −400 mV. R per 6P element from the car "
             "fit (car-log0077, 21.9 °C). Dots: vHIL sweeps.", fontsize=8.5, color=th["ink2"], linespacing=1.4)
    di = [x for x in range(0, 301, 2)]
    rmin, rmax = 3.0, 5.0
    i400 = [OW_MV / x for x in [rmin + (rmax - rmin) * j / 200 for j in range(201)]]
    i273 = [(OW_MV + OW_OFFSET_MV) / x for x in [rmin + (rmax - rmin) * j / 200 for j in range(201)]]
    rr = [rmin + (rmax - rmin) * j / 200 for j in range(201)]
    ax.fill_betweenx(rr, i400, [300] * len(rr), color=th["crit"], alpha=0.14, lw=0)
    ax.plot(i400, rr, color=th["crit"], label="trips: ΔI·R = 400 mV")
    ax.plot(i273, rr, color=th["crit"], ls=(0, (5, 3)),
            label="trips on a top cell with the healthy −127 mV offset: ΔI·R = 273 mV")
    # the pack's elements, as ticks at the left
    for k in checked:
        ax.plot([2, 8], [rs[k]] * 2, color=th["s2"] if k in top else th["s1"], lw=1, alpha=0.8)
    ax.text(10, max(rs) + 0.03, "c0_10, 4.56 mΩ", fontsize=8, color=th["ink2"])
    ax.text(10, 3.05, f"ticks: the {len(checked)} elements\nthe interior rule checks\n"
            "(orange: an LTC's top cell)", fontsize=8, color=th["ink2"], linespacing=1.3)
    no = next(t for t in sweep["no-offset"] if t["error"])
    of = next(t for t in sweep["offset"] if t["error"])
    rk = rs[10]
    rt = max(rs[k] for k in top)
    ax.plot([no["di_a"]], [rk], "o", ms=9, color=th["crit"], mec=th["surface"], mew=2, zorder=5)
    ax.annotate(f"vHIL: first trip at ΔI = {no['di_a']} A (c0_10)", xy=(no["di_a"], rk),
                xytext=(no["di_a"] + 30, rk - 0.25), fontsize=9, color=th["ink"],
                arrowprops=dict(arrowstyle="-", color=th["ink2"], lw=0.8))
    ax.plot([of["di_a"]], [rt], "o", ms=9, mfc=th["surface"], mec=th["crit"], mew=2, zorder=5)
    ax.annotate(f"with the offset: {of['di_a']} A (a top cell)", xy=(of["di_a"], rt),
                xytext=(of["di_a"] + 30, rt - 0.35), fontsize=9, color=th["ink"],
                arrowprops=dict(arrowstyle="-", color=th["ink2"], lw=0.8))
    # car transients, as the current fall the scans can capture
    bands = [((0, 30), "slow pedal\nlift (~2 A/ms\n× ~12 ms)"),
             ((150, 180), "torque cut from a\nLOG0077-size peak (173 A)"),
             ((200, 300), "cut from a launch,\nor into regen")]
    for (a0, a1), label in bands:
        ax.axvspan(a0, a1, ymin=0.9, ymax=1.0, color=th["band"], lw=0)
        ax.text(max(a0 + 2, (a0 + a1) / 2) if a0 else a0 + 2, 4.93, label,
                ha="center" if a0 else "left", va="top", fontsize=7.5, color=th["ink2"])
    ax.set_xlim(0, 300)
    ax.set_ylim(rmin, rmax)
    ax.set_xlabel("Current fall between the pull-up and the pull-down scan, ΔI (A)")
    ax.set_ylabel("Element resistance R (mΩ)")
    ax.legend(loc="lower right", fontsize=7.5)
    fig.savefig(path, dpi=160)
    plt.close(fig)
    return dict(trip_no_offset_a=no["di_a"], trip_offset_a=of["di_a"], r_c0_10=rk, r_top_max=rt,
                predicted_no_offset_a=OW_MV / rk, predicted_offset_a=(OW_MV + OW_OFFSET_MV) / rt)


def openwire(data: Path, out: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    cut = json.loads((data / "open-wire-cut-180a.json").read_text())
    sweep = json.loads((data / "open-wire-sweep.json").read_text())
    out.mkdir(parents=True, exist_ok=True)
    facts = {}
    for mode, th in THEMES.items():
        plt.rcdefaults()
        style(plt, th)
        facts["fig6"] = fig6(plt, th, cut, out / f"fig6-open-wire-timeline-{mode}.png")
        facts["fig7"] = fig7(plt, th, sweep, out / f"fig7-open-wire-trip-map-{mode}.png")
    print(json.dumps(facts, indent=1))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="run both scenarios (in the container) and decode their series")
    r.add_argument("--out", type=Path, default=REPO / "results" / "ams-641")
    pl = sub.add_parser("plot", help="the PNGs from the decoded series")
    pl.add_argument("--data", type=Path, default=OUT / "data")
    pl.add_argument("--out", type=Path, default=OUT)
    c = sub.add_parser("car", help="figure 5 from the car's AMS SD logs (not in this repo)")
    c.add_argument("--logs", type=Path, required=True, help="directory holding LOG0077.CSV")
    c.add_argument("--out", type=Path, default=OUT)
    ow = sub.add_parser("openwire", help="figures 6-7 (CellOpenWire) from the open-wire runs")
    ow.add_argument("--data", type=Path, default=OUT / "data")
    ow.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args()
    if a.cmd == "openwire":
        openwire(a.data, a.out)
    elif a.cmd == "run":
        run(a.out)
    elif a.cmd == "car":
        car(a.logs, a.out)
    else:
        plot(a.data, a.out)


if __name__ == "__main__":
    main()
