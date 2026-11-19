#!/usr/bin/env bash
# What a host needs to run the vHIL's tests: each job's wall time, CPU and
# peak memory, at several core counts (docs/development/hardware.md).
#
#   scripts/hw-profile.sh [sweep|full|all] [cores...]
#
# sweep: representative jobs (a one-, two- and three-board system, both
#        smoke suites) at each core count (default 1 2 4 8, capped at the
#        host's), through VHIL_DOCKER_CPUS.
# full:  every suite once with every core: firmware build, unit, sim,
#        scenarios, the IFS_HIL smoke suite against the ECU.
# files: tests/sim one file per container: each file's own peak and time
#        (a run of the whole suite peaks at its heaviest file).
# all:   full and sweep (the default).
#
# Each job appends a line to results/profile/$VHIL_PROFILE_HOST.jsonl
# (scripts/cgroup-profile.py); scripts/hw-profile-report.py turns the
# files into the doc's tables. The firmware must be built (`fw ecu ams udv`)
# unless `full` runs first, which builds it.
set -uo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
mode=${1:-all}; shift || true
host=${VHIL_PROFILE_HOST:-$(uname -s)-$(uname -m)}
export VHIL_PROFILE_HOST=$host VHIL_PROFILE_OUT=$host.jsonl
# The last line: a first run prints the image pull on stdout before it.
max=$("$repo/scripts/vhil-docker.sh" run nproc | tr -d '\r' | tail -n1)
case $max in ''|*[!0-9]*) echo "hw-profile: no core count from the container ($max)" >&2; exit 1;; esac
cores=("$@"); [ ${#cores[@]} -gt 0 ] || cores=(1 2 4 8)

job() {  # job <label> <vhil-docker.sh args...>
    local label=$1; shift
    echo "== $label" >&2
    VHIL_PROFILE=$label "$repo/scripts/vhil-docker.sh" "$@" >"$repo/results/profile/$host.$label.log" 2>&1 \
        || { echo "   failed (rc $?), see results/profile/$host.$label.log" >&2; failed+=("$label"); }
}
failed=()
mkdir -p "$repo/results/profile"

if [ "$mode" = full ] || [ "$mode" = all ]; then
    unset VHIL_DOCKER_CPUS
    job "fw@$max" fw ecu ams udv
    job "unit@$max" unit
    job "scenarios@$max" scenarios
    job "sim@$max" sim
    VHIL_DUT=ecu job "ifs-hil-ecu-smoke@$max" ifs-hil smoke
fi

if [ "$mode" = files ]; then
    unset VHIL_DOCKER_CPUS
    for f in "$repo"/tests/sim/test_*.py; do
        f=${f#"$repo/"}
        job "sim-file:$(basename "$f" .py)@$max" sim "$f"
    done
fi

if [ "$mode" = sweep ] || [ "$mode" = all ]; then
    for n in "${cores[@]}"; do
        [ "$n" -le "$max" ] || continue
        export VHIL_DOCKER_CPUS=$n
        job "smoke-ecu@$n" smoke ecu
        job "smoke-ams@$n" smoke ams
        job "sim-ecu@$n" sim tests/sim/test_ecu_boot.py
        job "sim-ams@$n" sim tests/sim/test_ams_boot.py
        job "sim-ecu-ams@$n" sim tests/sim/test_sys_ecu_ams.py
        job "sim-ecu-ams-udv@$n" sim tests/sim/test_sys_ecu_ams_udv.py
    done
fi

if [ ${#failed[@]} -gt 0 ]; then
    echo "hw-profile: ${#failed[@]} job(s) failed: ${failed[*]}" >&2
    exit 1
fi
