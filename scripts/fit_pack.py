#!/usr/bin/env python3
"""Fit the pack plant's cell parameters to an AMS SD log (LOG*.CSV, the AMS's
4 Hz LOG.CSV): per-element R0 and one RC branch, and each element's static
OCV offset from the pack mean. The car-calibrated parameter set in
catalog/plants/tractive-system.yaml (`parameter_sets`) comes from this.

    python scripts/fit_pack.py <log dir> [--log LOG0077] [--emit-set]

The logs stay out of the repository (car data, the repository is public);
only the fitted numbers are committed. Pure Python: runs anywhere.

The model, per 6P series element k, at log row n (dt = 250 ms):

    v_k[n] = E_k - s Q[n] - R0_k Ie[n] - R1 x_tau[n]

- Q: charge drawn since the log's start (Ah, from I_raw); s: the slope of
  the catalogue's OCV table at the log's starting SoC (cited, fixed: a free
  slope trades off against the RC branch on a 163 s drive).
- Ie: the current the cell reading saw. The AMS polls the cells every
  200 ms (AMS ams_config.hpp:258) and the logger writes every 250 ms with the
  current of that moment, so each row's cells are older than its current by
  a skew the log does not record. Ie is a lag model fitted explicitly: taps
  Ie[n] = w0 I[n] + w1 I[n-1] (a skew of 0-250 ms, linear between the two
  samples; a third tap fits ~0); R0 = w0 + w1 and the weights give the mean
  skew, 250 ms * w1 / (w0 + w1).
- x_tau: I through a first-order lag of time constant tau (the RC branch);
  tau from a grid by hold-out (fit on the first 60 % of the drive, score the
  last 40 %), since 4 Hz data cannot pin a short tau.
- Per element: R0_k on the pack fit's skew and RC (only R0 and E free). Kept
  per element only if their spread is well beyond its standard error.
- Offsets: each element's difference from the pack mean over rest rows
  (|I| < 5 A on the row and the one before it: the skew); reported over the
  whole log, and as medians over the rest rows of the log's last 30 s, the
  state a run from the log's end starts in (the plant's).

Temperature: R0 is fitted at the log's mean NTC temperature and referred to
25 C with the catalogue's cell_r0_alpha (the plant's own R0(T)).
"""
from __future__ import annotations

import argparse
import csv
import math
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DT = 0.25                   # the log's row period, s
REST_A = 5.0                # |I| under this is rest
LATE_S = 30.0               # the end-of-log state: rest rows in the log's last 30 s
NTAPS = 2                   # lag taps: the cells are 0-250 ms older than the logged current
RUN = 3                     # fsm Run
MODULES, CELLS = 5, 19
TAUS = (2.0, 5.0, 10.0, 20.0, 30.0, 60.0, 120.0)
UV_V = 2.800                # CellUnderVoltageMv, AMS ams_config.hpp:22
P_ECU_W = 76e3              # ECU TS power envelope, ECU ecu_config.hpp:353


# -- linear algebra (small dense least squares) -------------------------------

def solve(a: list[list[float]], b: list[float]) -> list[float]:
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        m[c], m[p] = m[p], m[c]
        for r in range(n):
            if r != c and m[r][c]:
                f = m[r][c] / m[c][c]
                m[r] = [x - f * y for x, y in zip(m[r], m[c])]
    return [m[i][n] / m[i][i] for i in range(n)]


def inverse(a: list[list[float]]) -> list[list[float]]:
    n = len(a)
    cols = [solve(a, [1.0 if i == j else 0.0 for i in range(n)]) for j in range(n)]
    return [[cols[j][i] for j in range(n)] for i in range(n)]


def lstsq(rows: list[list[float]], y: list[float]):
    """(coefficients, residuals, covariance) of y ~ rows."""
    k = len(rows[0])
    ata = [[sum(r[i] * r[j] for r in rows) for j in range(k)] for i in range(k)]
    aty = [sum(r[i] * v for r, v in zip(rows, y)) for i in range(k)]
    c = solve(ata, aty)
    res = [v - sum(ci * ri for ci, ri in zip(c, r)) for r, v in zip(rows, y)]
    var = sum(e * e for e in res) / max(1, len(y) - k)
    inv = inverse(ata)
    return c, res, [[x * var for x in row] for row in inv]


def mean(xs):
    xs = list(xs)
    return sum(xs) / len(xs)


def rms(xs):
    xs = list(xs)
    return math.sqrt(sum(x * x for x in xs) / len(xs))


def r2(res, y):
    my = mean(y)
    return 1 - sum(e * e for e in res) / sum((v - my) ** 2 for v in y)


def median(xs):
    s = sorted(xs)
    return s[len(s) // 2] if len(s) % 2 else (s[len(s) // 2 - 1] + s[len(s) // 2]) / 2


def pct(xs, q):
    s = sorted(xs)
    return s[min(len(s) - 1, int(round(q * (len(s) - 1))))]


# -- the catalogue's cell ----------------------------------------------------

def catalogue() -> dict:
    import yaml
    doc = yaml.safe_load((REPO / "catalog/plants/tractive-system.yaml").read_text())
    return {k: v["value"] for k, v in doc["parameters"].items()}


def ocv(p, soc):
    xs, ys = p["cell_ocv_soc"], p["cell_ocv"]
    soc = min(xs[-1], max(xs[0], soc))
    for i in range(len(xs) - 1):
        if soc <= xs[i + 1]:
            return ys[i] + (ys[i + 1] - ys[i]) * (soc - xs[i]) / (xs[i + 1] - xs[i])
    return ys[-1]


def soc_of(p, v):
    xs, ys = p["cell_ocv_soc"], p["cell_ocv"]
    v = min(ys[-1], max(ys[0], v))
    for i in range(len(xs) - 1):
        if v <= ys[i + 1]:
            return xs[i] + (xs[i + 1] - xs[i]) * (v - ys[i]) / (ys[i + 1] - ys[i])
    return xs[-1]


def ocv_slope(p, soc):
    xs, ys = p["cell_ocv_soc"], p["cell_ocv"]
    for i in range(len(xs) - 1):
        if soc <= xs[i + 1]:
            return (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i])
    return (ys[-1] - ys[-2]) / (xs[-1] - xs[-2])


# -- the log ---------------------------------------------------------------------

def load(path: Path) -> dict:
    with open(path, newline="") as f:
        rows = list(csv.DictReader(f))
    col = lambda n: [float(r[n]) for r in rows]
    out = {"t": [x / 1e3 for x in col("tick_ms")], "fsm": [int(x) for x in col("fsm")],
           "v_pack": [x / 1e3 for x in col("pack_mV")], "i": [x / 1e3 for x in col("I_raw_mA")],
           "vmin": [x / 1e3 for x in col("vmin_mV")], "tavg": col("tavg_C")}
    out["cells"] = [[float(r[f"c{m}_{c}"]) / 1e3 for m in range(MODULES) for c in range(CELLS)]
                    for r in rows]
    return out


def lowpass(x, tau):
    """x through a first-order lag (row n sees rows < n), zero initial state."""
    e = math.exp(-DT / tau)
    y = [0.0]
    for k in range(1, len(x)):
        y.append(e * y[-1] + (1 - e) * x[k - 1])
    return y


def lagged(x, j):
    return [x[max(0, n - j)] for n in range(len(x))]


# -- the fit ---------------------------------------------------------------------------

def fit(log: dict, p: dict) -> dict:
    n = len(log["t"])
    i, t = log["i"], log["t"]
    q = [0.0]
    for k in range(1, n):
        q.append(q[-1] + i[k] * DT / 3600)
    drive = [k for k in range(n) if log["fsm"][k] == RUN and k >= 2]
    par, ns = int(p["cells_parallel"]), len(log["cells"][0])
    v_mean = [v / ns for v in log["v_pack"]]
    rest_start = [k for k in range(1, n) if abs(i[k]) < REST_A and k < drive[0]]
    v0 = mean(v_mean[k] for k in rest_start) if rest_start else v_mean[0]
    soc0 = soc_of(p, v0)
    s = ocv_slope(p, soc0) / (float(p["cell_capacity"]) * par)        # V per Ah, per element
    vq = [v + s * qq for v, qq in zip(v_mean, q)]
    taps = [lagged(i, j) for j in range(NTAPS)]

    def design(tau, ks):
        x = lowpass(i, tau) if tau else None
        return [[1.0] + [-taps[j][k] for j in range(NTAPS)] + ([-x[k]] if tau else []) for k in ks]

    split = drive[0] + int(0.6 * len(drive))
    train = [k for k in drive if k < split]
    test = [k for k in drive if k >= split]
    scan = []
    for tau in (None,) + TAUS:
        c, _, _ = lstsq(design(tau, train), [vq[k] for k in train])
        pred = [sum(a * b for a, b in zip(c, row)) for row in design(tau, test)]
        hold = rms(vq[k] - pr for k, pr in zip(test, pred))
        c_all, res, cov = lstsq(design(tau, drive), [vq[k] for k in drive])
        scan.append(dict(tau=tau, holdout_mv=hold * 1e3, rms_mv=rms(res) * 1e3,
                         r2=r2(res, [vq[k] for k in drive]), c=c_all, res=res, cov=cov))
    best = min(scan, key=lambda d: d["holdout_mv"])
    c, cov = best["c"], best["cov"]
    w = c[1:1 + NTAPS]
    r0 = sum(w)
    r0_se = math.sqrt(sum(cov[a][b] for a in range(1, 1 + NTAPS) for b in range(1, 1 + NTAPS)))
    r1 = c[1 + NTAPS] if best["tau"] else 0.0
    skew_ms = 250 * sum(j * wj for j, wj in enumerate(w)) / r0

    # Per element on the pack's skew and RC: E_k, R0_k free.
    ie = [sum(w[j] / r0 * taps[j][k] for j in range(NTAPS)) for k in range(n)]
    xr = lowpass(i, best["tau"]) if best["tau"] else [0.0] * n
    per_r, per_se, per_rms = [], [], []
    rows = [[1.0, -ie[k]] for k in drive]
    for e in range(ns):
        y = [log["cells"][k][e] + s * q[k] + r1 * xr[k] for k in drive]
        ce, res, cv = lstsq(rows, y)
        per_r.append(ce[1])
        per_se.append(math.sqrt(cv[1][1]))
        per_rms.append(rms(res))
    r_mean = mean(per_r)
    spread = math.sqrt(mean((r - r_mean) ** 2 for r in per_r))
    per_element = spread > 3 * mean(per_se)

    # Offsets over rest rows, and their stability (first half against last).
    rest = [k for k in range(1, n) if abs(i[k]) < REST_A and abs(i[k - 1]) < REST_A]
    dev = {k: [c_ - mean(log["cells"][k]) for c_ in log["cells"][k]] for k in rest}
    off = [mean(dev[k][e] for k in rest) for e in range(ns)]
    half = len(rest) // 2
    off_a = [mean(dev[k][e] for k in rest[:half]) for e in range(ns)]
    off_b = [mean(dev[k][e] for k in rest[half:]) for e in range(ns)]
    drift = max(abs(a - b) for a, b in zip(off_a, off_b))
    sd_t = mean(math.sqrt(mean((dev[k][e] - off[e]) ** 2 for k in rest)) for e in range(ns))

    # The pack's state at the log's end: the rest rows of its last LATE_S,
    # medians (the cell readings alternate by a few tens of mV row to row at
    # rest). The offsets drift over the drive, so the plant takes these late
    # ones: the state a run from the log's end starts in.
    end = [k for k in rest if t[k] >= t[-1] - LATE_S]
    v_end = median(v_mean[k] for k in end)
    cells_end = [median(log["cells"][k][e] for k in end) for e in range(ns)]
    off_late = [median(dev[k][e] for k in end) for e in range(ns)]
    t_c = mean(log["tavg"][k] for k in drive)
    alpha = float(p["cell_r0_alpha"])
    t_fac = max(1 + alpha * (t_c - 25), 0.4)

    # Checks of the quick estimates: pack on I one row back, no OCV drift; the
    # lowest cell's sag the same way.
    c1, res1, _ = lstsq([[1.0, -i[k - 1]] for k in drive], [v_mean[k] for k in drive])
    cm, resm, _ = lstsq([[1.0, -i[k - 1]] for k in drive], [log["vmin"][k] for k in drive])
    spread_rest = [max(log["cells"][k]) - min(log["cells"][k]) for k in rest]

    return dict(
        n=n, drive=len(drive), rest=len(rest), end_rows=(t[end[0]], t[end[-1]], len(end)),
        soc0=soc0, v0=v0, slope_v_per_ah=s, ah=q[-1], t_c=t_c, t_fac=t_fac,
        scan=scan, best=best, w=w, r0=r0, r0_se=r0_se, r1=r1, tau=best["tau"], skew_ms=skew_ms,
        per_r=per_r, per_se=per_se, per_rms=per_rms, r_mean=r_mean, spread=spread,
        per_element=per_element, off=off, off_late=off_late, off_drift=drift, off_sd_t=sd_t,
        v_end=v_end, soc_end=soc_of(p, v_end), cells_end=cells_end,
        quick_r=c1[1], quick_r2=r2(res1, [v_mean[k] for k in drive]), vmin_sag=cm[1],
        spread_rest=(min(spread_rest), pct(spread_rest, 0.5), max(spread_rest)),
        resid=best["res"], i_drive=[i[k] for k in drive], i_max=max(i),
    )


def name(e):
    return f"c{e // CELLS}_{e % CELLS}"


def report(f: dict, p: dict) -> None:
    par = int(p["cells_parallel"])
    print(f"rows {f['n']} (drive in Run {f['drive']}, rest |I|<{REST_A:g} A {f['rest']}), "
          f"{f['ah']:.3f} Ah drawn, peak {f['i_max']:.1f} A, mean NTC {f['t_c']:.1f} C")
    print(f"start: {f['v0'] * 1e3:.1f} mV/element at rest -> SoC {f['soc0']:.3f} (OCV table); "
          f"OCV drift s = {f['slope_v_per_ah'] * 1e3:.2f} mV/Ah per element (fixed)")
    print("\nRC scan (hold-out = last 40 % of the drive, fitted on the first 60 %):")
    for d in f["scan"]:
        c = d["c"]
        r1 = f"R1 {c[1 + NTAPS] * 1e3:5.2f}" if d["tau"] else "R1     -"
        print(f"  tau {str(d['tau']):>5} s: R0 {sum(c[1:1 + NTAPS]) * 1e3:.3f} mOhm  {r1} mOhm  "
              f"rms {d['rms_mv']:.1f} mV  R2 {d['r2']:.4f}  hold-out {d['holdout_mv']:.1f} mV")
    print(f"\npack, per element at {f['t_c']:.1f} C:")
    print(f"  lag taps w0, w1 = {', '.join(f'{x * 1e3:.3f}' for x in f['w'])} mOhm -> skew "
          f"{f['skew_ms']:.0f} ms (cells older than the logged current)")
    print(f"  R0 = {f['r0'] * 1e3:.3f} +- {f['r0_se'] * 1e3:.3f} mOhm  ({f['r0'] * par * 1e3:.2f} mOhm "
          f"per cell); at 25 C: {f['r0'] / f['t_fac'] * 1e3:.3f} mOhm/element, "
          f"{f['r0'] / f['t_fac'] * par * 1e3:.2f} mOhm/cell")
    print(f"  R1 = {f['r1'] * 1e3:.3f} mOhm ({f['r1'] * par * 1e3:.2f} per cell), tau1 = {f['tau']} s")
    res = f["resid"]
    print(f"  residual rms {rms(res) * 1e3:.1f} mV, |res| p50/p95/max "
          f"{pct([abs(x) for x in res], .5) * 1e3:.1f}/{pct([abs(x) for x in res], .95) * 1e3:.1f}/"
          f"{max(abs(x) for x in res) * 1e3:.1f} mV, R2 {f['best']['r2']:.4f}")
    bins = [(0, 20), (20, 60), (60, 120), (120, 1e9)]
    line = []
    for lo, hi in bins:
        sel = [r for r, ii in zip(res, f["i_drive"]) if lo <= abs(ii) < hi]
        if sel:
            line.append(f"{lo}-{hi if hi < 1e9 else ''} A: n {len(sel)} mean {mean(sel) * 1e3:+.1f} "
                        f"rms {rms(sel) * 1e3:.1f}")
    print("  residual by current: " + "; ".join(line))
    print(f"\nper element (on the pack's skew and RC): R0 mean {f['r_mean'] * 1e3:.3f}, "
          f"spread (sd) {f['spread'] * 1e3:.3f}, mean SE {mean(f['per_se']) * 1e3:.3f} mOhm -> "
          f"{'per element' if f['per_element'] else 'uniform'} "
          f"(spread {f['spread'] / mean(f['per_se']):.1f} x SE); residual rms mean "
          f"{mean(f['per_rms']) * 1e3:.1f} mV")
    lo = sorted(range(len(f["per_r"])), key=lambda e: f["per_r"][e])
    print(f"  lowest {', '.join(f'{name(e)} {f['per_r'][e] * 1e3:.2f}' for e in lo[:3])}; highest "
          f"{', '.join(f'{name(e)} {f['per_r'][e] * 1e3:.2f}' for e in lo[-3:])} mOhm")
    even = mean(f["per_r"][e] for e in range(len(f["per_r"])) if (e % CELLS) % 2 == 0)
    odd = mean(f["per_r"][e] for e in range(len(f["per_r"])) if (e % CELLS) % 2 == 1)
    print(f"  by position in the module: even cells {even * 1e3:.3f}, odd {odd * 1e3:.3f} mOhm")
    off = f["off"]
    lo = sorted(range(len(off)), key=lambda e: off[e])
    print(f"\noffsets from the pack mean at rest: {', '.join(f'{name(e)} {off[e] * 1e3:+.1f}' for e in lo[:3])}"
          f" ... {', '.join(f'{name(e)} {off[e] * 1e3:+.1f}' for e in lo[-2:])} mV; first half vs last "
          f"half of the rest rows: max drift {f['off_drift'] * 1e3:.1f} mV; scatter about its offset "
          f"{f['off_sd_t'] * 1e3:.1f} mV rms")
    ol = f["off_late"]
    lo = sorted(range(len(ol)), key=lambda e: ol[e])
    print(f"  late (the plant's, medians): {', '.join(f'{name(e)} {ol[e] * 1e3:+.1f}' for e in lo[:3])}"
          f" ... {', '.join(f'{name(e)} {ol[e] * 1e3:+.1f}' for e in lo[-2:])} mV")
    print(f"  cell spread at rest (max - min): min/median/max {f['spread_rest'][0] * 1e3:.0f}/"
          f"{f['spread_rest'][1] * 1e3:.0f}/{f['spread_rest'][2] * 1e3:.0f} mV")
    a, b, k = f["end_rows"]
    print(f"\nend of the log, rest rows {a:.2f}-{b:.2f} s ({k}, medians): pack {f['v_end'] * 95:.1f} V, "
          f"{f['v_end'] * 1e3:.1f} mV/element -> SoC {f['soc_end']:.3f} (OCV table); weakest "
          f"{name(lo[0])} {f['cells_end'][lo[0]] * 1e3:.0f} mV")
    print(f"\nquick checks: pack on I one row back, no drift: {f['quick_r'] * 1e3:.2f} mOhm/element, "
          f"R2 {f['quick_r2']:.2f}; lowest cell (vmin) the same: {f['vmin_sag'] * 1e3:.2f} mV/A")

    # The plant's trip current at the log's end (derived from these numbers):
    # each element at its end-of-log rest voltage, R0_k(T) + the RC's 0.45 s
    # (a reading under 2800 mV plus the AMS's ~250-450 ms confirm).
    r_k = f["per_r"] if f["per_element"] else [f["r0"]] * len(off)
    rc = f["r1"] * (1 - math.exp(-0.45 / f["tau"])) if f["tau"] else 0.0
    off = f["off_late"]
    trip = min(((f["v_end"] + off[e] - UV_V) / (r_k[e] + rc), e) for e in range(len(off)))
    v_pack, r_pack = f["v_end"] * len(off), sum(r_k) + rc * len(off)
    disc = v_pack ** 2 - 4 * r_pack * P_ECU_W
    i_p = (v_pack - math.sqrt(disc)) / (2 * r_pack) if disc >= 0 else float("nan")
    print(f"derived: a healthy pack at the log's end reads < {UV_V * 1e3:.0f} mV at "
          f"{trip[0]:.0f} A ({name(trip[1])}); the ECU's 76 kW on it is {i_p:.0f} A")


def emit(f: dict, p: dict, log_name: str) -> None:
    par = int(p["cells_parallel"])
    r0_25 = f["r0"] / f["t_fac"]
    scale = [r / f["r_mean"] for r in f["per_r"]] if f["per_element"] else None
    print(f"# {log_name}: paste into catalog/plants/tractive-system.yaml parameter_sets")
    print(f"cell_r0: {r0_25 * par:.5f}")
    print(f"cell_r1: {f['r1'] * par:.5f}")
    print(f"cell_tau1: {f['tau']}")
    if scale:
        print("cell_r0_scale: [" + ", ".join(f"{x:.3f}" for x in scale) + "]")
    print("cell_ocv_offset: [" + ", ".join(f"{x:.4f}" for x in f["off_late"]) + "]")
    print(f"soc_init: {f['soc_end']:.3f}")
    print(f"t_init: {f['t_c'] + 273.15:.2f}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("logs", type=Path, help="directory of the AMS SD logs (LOG*.CSV)")
    ap.add_argument("--log", default="LOG0077", help="which log (default LOG0077)")
    ap.add_argument("--emit-set", action="store_true", help="print the fitted values as catalogue YAML")
    a = ap.parse_args()
    p = catalogue()
    f = fit(load(a.logs / f"{a.log}.CSV"), p)
    report(f, p)
    if a.emit_set:
        print()
        emit(f, p, a.log)


if __name__ == "__main__":
    main()
