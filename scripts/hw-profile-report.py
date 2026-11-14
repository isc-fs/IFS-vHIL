#!/usr/bin/env python3
"""Tables of results/profile/*.jsonl (scripts/hw-profile.sh) as Markdown.

Usage: hw-profile-report.py [files...]   (default results/profile/*.jsonl)

One table per host: each job's last record, by job then core count.
"""
import glob
import json
import sys


def main() -> int:
    files = sys.argv[1:] or sorted(glob.glob("results/profile/*.jsonl"))
    for path in files:
        last = {}
        for line in open(path):
            r = json.loads(line)
            last[r["label"]] = r
        if not last:
            continue
        host = next(iter(last.values()))
        print(f"### {host['host'] or path} ({host['arch']})\n")
        print("| Job | Cores | Wall | CPU time | Cores busy (mean / p95 / max) | Working set peak | memory.peak | Result |")
        print("|---|---:|---:|---:|---|---:|---:|---|")

        def key(r):
            job, _, n = r["label"].rpartition("@")
            return job, int(n) if n.isdigit() else 0

        for r in sorted(last.values(), key=key):
            job, n = key(r)
            mins = lambda s: f"{s / 60:.1f} min" if s >= 90 else f"{s:.0f} s"
            peak = "" if r["mem_peak_gb"] is None else f"{r['mem_peak_gb']:.2f} GB"
            print(f"| {job} | {n} | {mins(r['wall_s'])} | {mins(r['cpu_s'])} | "
                  f"{r['cores_mean']:.1f} / {r['cores_p95']:.1f} / {r['cores_max']:.1f} | "
                  f"{r['ws_peak_gb']:.2f} GB | {peak} | {'ok' if r['rc'] == 0 else 'rc ' + str(r['rc'])} |")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
