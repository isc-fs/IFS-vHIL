#!/usr/bin/env python3
"""Run a command and record what it cost its container: one JSON line.

Run inside a job's container (scripts/vhil-docker.sh with VHIL_PROFILE set),
where /sys/fs/cgroup is the container's own cgroup v2. It records:

- wall_s: the command's wall time.
- cpu_s: CPU time of the whole container (cpu.stat usage_usec).
- cores_mean: cpu_s / wall_s, the cores the job keeps busy on average.
- cores_p95, cores_max: the cores busy over each sampling interval.
- mem_peak_gb: memory.peak, exact, but it counts page cache the kernel can
  drop (a firmware build reads a lot of files).
- ws_peak_gb: the largest working set sampled (memory.current minus
  inactive_file, as `docker stats` shows): what the job needs to keep.
- cpu_limit: the container's limit (cpu.max), nproc: the cores it sees.

Usage: cgroup-profile.py --label NAME --out FILE [--interval S] -- CMD...
Exits with the command's exit code. docs/development/hardware.md uses it.
"""
import argparse
import json
import os
import platform
import subprocess
import sys
import time

CG = "/sys/fs/cgroup"


def read(name: str) -> str:
    with open(os.path.join(CG, name)) as f:
        return f.read()


def stat(name: str) -> dict:
    return {k: int(v) for k, v in (line.split() for line in read(name).splitlines())}


def cpu_usec() -> int:
    return stat("cpu.stat")["usage_usec"]


def working_set() -> int:
    return int(read("memory.current")) - stat("memory.stat").get("inactive_file", 0)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--label", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--interval", type=float, default=0.5)
    p.add_argument("cmd", nargs=argparse.REMAINDER)
    a = p.parse_args()
    cmd = a.cmd[1:] if a.cmd[:1] == ["--"] else a.cmd
    if not cmd:
        p.error("no command")

    t0, u0 = time.monotonic(), cpu_usec()
    proc = subprocess.Popen(cmd)
    rates, ws_peak = [], working_set()
    t, u = t0, u0
    while proc.poll() is None:
        time.sleep(a.interval)
        t1, u1 = time.monotonic(), cpu_usec()
        if t1 > t:
            rates.append((u1 - u) / 1e6 / (t1 - t))
        t, u = t1, u1
        ws_peak = max(ws_peak, working_set())
    wall, cpu = time.monotonic() - t0, (cpu_usec() - u0) / 1e6

    rates.sort()
    gb = 1 << 30
    rec = {
        "label": a.label,
        "rc": proc.returncode,
        "wall_s": round(wall, 1),
        "cpu_s": round(cpu, 1),
        "cores_mean": round(cpu / wall, 2) if wall else 0,
        "cores_p95": round(rates[int(0.95 * (len(rates) - 1))], 2) if rates else 0,
        "cores_max": round(rates[-1], 2) if rates else 0,
        "mem_peak_gb": round(int(read("memory.peak")) / gb, 2)
        if os.path.exists(os.path.join(CG, "memory.peak")) else None,  # Linux >= 5.19
        "ws_peak_gb": round(ws_peak / gb, 2),
        "cpu_limit": read("cpu.max").strip(),
        "nproc": os.cpu_count(),
        "sched_cores": len(os.sched_getaffinity(0)),
        "arch": platform.machine(),
        "host": os.environ.get("VHIL_PROFILE_HOST", ""),
        "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "a") as f:
        f.write(json.dumps(rec) + "\n")
    print("profile: " + json.dumps(rec), file=sys.stderr)
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
