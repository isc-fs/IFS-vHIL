#!/usr/bin/env bash
# Run the vHIL in Docker: every CI job, locally, with nothing installed on
# the host but Docker. On macOS it runs in a Colima VM (profile `vhil`)
# because Docker Desktop's kernel has no vcan; on Linux, set
# VHIL_DOCKER_CONTEXT=default and load vcan on the host.
#
#   scripts/vhil-docker.sh vm                    create/start the VM, with vcan
#   scripts/vhil-docker.sh pull                  pull the published images of this checkout
#   scripts/vhil-docker.sh image                 (re)build the images (docker/) locally
#   scripts/vhil-docker.sh fw [ecu ams udv ...]  build firmware from systems/<s>.yaml
#   scripts/vhil-docker.sh unit                  tests/unit + validate every system
#   scripts/vhil-docker.sh smoke <ecu|ams>       tests/<s>_smoke.robot
#   scripts/vhil-docker.sh sim [pytest args]     tests/sim in virtual time (or just the
#                                                tests/... files the args name)
#   scripts/vhil-docker.sh scenarios [pytest args]
#                                                every committed scenario (tests/scenarios)
#   scripts/vhil-docker.sh coverage [glob] [pytest args]
#                                                firmware coverage of tests/sim/<glob>.py
#                                                (default test_*) into results/coverage
#   scripts/vhil-docker.sh speed [args]          scripts/speed.py: real-time factor of ams, ecu
#                                                and ecu-ams, bench and sim paths (results/speed)
#   scripts/vhil-docker.sh ifs-hil [suite] [pytest args]
#                                                IFS_HIL's ECU suite over vcan (VHIL_DUT=ams: AMS suite)
#                                                (VHIL_SYSTEM=systems/ecu-ams.yaml: with the AMS)
#   scripts/vhil-docker.sh editor                system editor on http://localhost:8080/editor/ (and the run worker)
#                                                (with the app's api and proxy)
#   scripts/vhil-docker.sh server                web app API + shell on http://localhost:8080
#                                                (M5; full stack: docker/compose.yaml)
#   scripts/vhil-docker.sh worker [--once ...]   run worker for the server's queue (vhil.worker)
#   scripts/vhil-docker.sh prune [--dry-run]     prune old commit builds in /vhil/fw (vhil/fwprune.py)
#   scripts/vhil-docker.sh editor-check [systems...]
#                                                Pipeline Manager loads every system's graph
#   scripts/vhil-docker.sh export-run <id> [-o file|dir]
#                                                a finished run of the app as a .vhilrun file
#   scripts/vhil-docker.sh import-run <file>     a .vhilrun file as a new run of the app
#                                                (vhil/server/bundle.py, docs/sharing-runs.md)
#   scripts/vhil-docker.sh shell                 a shell in the container
#   scripts/vhil-docker.sh run <cmd...>          any command in the container
#
# Firmware, the IFS_HIL checkout and their build trees live in the Docker
# volume `vhil-data` (/vhil in the container). IFS_HIL_REF picks IFS_HIL's
# ref (default dev); FW_REFS passes --ref pairs to the firmware build
# (e.g. FW_REFS="ecu=feat/x"). VHIL_DOCKER_CPUS=N limits the container to N
# cores (--cpus, --cpuset-cpus), as a CI-class host: GitHub's runners have 4.
# VHIL_FAST_FORWARD=0 passes through, to run Renode without the busy-wait
# fast-forward (docs/performance.md). The models' assembly (vhil/models.py)
# is cached in the volume (/vhil/renode-models): compiled on the first start
# after a model changes; VHIL_MODELS=prebuilt passes through.
#
# Images: every job uses the images of this checkout, named by content key
# (scripts/image-key.sh). When they aren't local, it pulls them from
# $VHIL_REGISTRY (default ghcr.io/isc-fs, published by
# .github/workflows/image.yml) and builds them only when none is published
# or docker/ has uncommitted changes.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
profile=${VHIL_COLIMA_PROFILE:-vhil}
context=${VHIL_DOCKER_CONTEXT:-colima-$profile}
base_image=${VHIL_IMAGE:-ifs-vhil}
editor_image=$base_image-editor
image=$base_image
# The tags every job runs: this checkout's keys once ensure_images has run
# (`latest` for a checkout with uncommitted docker/ changes). Jobs and the
# compose stack run by key, never by `latest`, so two checkouts on different
# images can't pick up each other's.
base_tag=latest editor_tag=latest
docker=(docker --context "$context")
registry=${VHIL_REGISTRY:-ghcr.io/isc-fs}
# The web app's services, behind one proxy on one origin (docker/compose.yaml).
compose=("${docker[@]}" compose -f "$repo/docker/compose.yaml")
# Unprivileged on Docker's default network unless a job needs vcan: only
# `ifs-hil` (and `shell`/`run` with VHIL_DOCKER_VCAN=1) gets --privileged
# --network host. Published ports bind 127.0.0.1 only.
run_args=()
vcan_args=(--privileged --network host)
[ "${VHIL_DOCKER_VCAN:-0}" = 1 ] && run_args=("${vcan_args[@]}")
cpu_args=()
if [ -n "${VHIL_DOCKER_CPUS:-}" ]; then
    cpu_args=(--cpus "$VHIL_DOCKER_CPUS" --cpuset-cpus "0-$((VHIL_DOCKER_CPUS - 1))")
fi

vm() {
    if ! colima status "$profile" >/dev/null 2>&1; then
        colima start "$profile" --cpu "${VHIL_CPUS:-8}" --memory "${VHIL_MEMORY:-8}" \
            --disk 40 --vm-type vz --arch aarch64
    fi
    # Colima's Ubuntu image ships without linux-modules-extra (vcan), and the
    # archive only carries it for the current kernel: move to that kernel
    # once, then restart into it.
    if ! colima ssh -p "$profile" -- sudo modprobe vcan 2>/dev/null; then
        echo "installing a kernel with vcan in the $profile VM (once)" >&2
        colima ssh -p "$profile" -- bash -c '
            set -e
            sudo apt-get update -qq
            sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq linux-generic
            v=$(ls /lib/modules | sort -V | tail -1)
            sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "linux-modules-extra-$v"
            echo vcan | sudo tee /etc/modules-load.d/vcan.conf >/dev/null'
        colima restart "$profile"
        colima ssh -p "$profile" -- sudo modprobe vcan
    fi
}

# base, editor and clean of this checkout (scripts/image-key.sh).
base='' editor='' clean=''
image_keys() {
    local out
    out=$("$repo/scripts/image-key.sh")
    base=$(sed -n 's/^base=//p' <<<"$out")
    editor=$(sed -n 's/^editor=//p' <<<"$out")
    clean=$(sed -n 's/^clean=//p' <<<"$out")
}
have() { "${docker[@]}" image inspect "$1" >/dev/null 2>&1; }

build_images() {
    image_keys
    "${docker[@]}" build -t "$base_image" "$repo/docker"
    "${docker[@]}" build -t "$editor_image" --build-arg BASE="$base_image" \
        -f "$repo/docker/editor.Dockerfile" "$repo"
    if [ "$clean" = true ]; then
        "${docker[@]}" tag "$base_image" "$base_image:$base"
        "${docker[@]}" tag "$editor_image" "$editor_image:$editor"
    fi
}

# The published images of this checkout, tagged locally as the images and as
# their keys. Fails when docker/ has uncommitted changes or none is published.
pull_images() {
    image_keys
    if [ "$clean" != true ]; then
        echo "docker/ or the editor's sources have uncommitted changes: build them (\`image\`)" >&2
        return 1
    fi
    local name key
    for name in ifs-vhil ifs-vhil-editor; do
        key=$base; [ "$name" = ifs-vhil-editor ] && key=$editor
        "${docker[@]}" pull "$registry/$name:$key" || return 1
    done
    "${docker[@]}" tag "$registry/ifs-vhil:$base" "$base_image:$base"
    "${docker[@]}" tag "$registry/ifs-vhil-editor:$editor" "$editor_image:$editor"
    "${docker[@]}" tag "$base_image:$base" "$base_image"
    "${docker[@]}" tag "$editor_image:$editor" "$editor_image"
}

# The images of this checkout: local by key, else pulled, else built.
ensure_images() {
    image_keys
    if [ "$clean" != true ]; then
        echo "docker/ or the editor's sources have uncommitted changes: using the local \`latest\` images" >&2
        if ! have "$base_image" || ! have "$editor_image"; then build_images; fi
        base_tag=latest editor_tag=latest
        return
    fi
    if ! have "$base_image:$base" || ! have "$editor_image:$editor"; then
        echo "pulling the images of this checkout ($registry, ifs-vhil:$base)" >&2
        pull_images || {
            echo "no published image for this checkout: building it (Renode from source, ~30 min)" >&2
            build_images
        }
    fi
    if ! have "$base_image:$base" || ! have "$editor_image:$editor"; then
        echo "error: no ifs-vhil:$base / ifs-vhil-editor:$editor after pulling or building" >&2
        exit 1
    fi
    # `latest` follows the last checkout used, for docker compose run by hand.
    "${docker[@]}" tag "$base_image:$base" "$base_image"
    "${docker[@]}" tag "$editor_image:$editor" "$editor_image"
    base_tag=$base editor_tag=$editor
}

# Run a script in the container. For vcan jobs, host networking puts
# can0..can2 in the VM's namespace, where they outlive the container, and
# --privileged lets the container create them.
in_container() {
    ensure_images
    local ref=$base_image:$base_tag
    [ "$image" = "$editor_image" ] && ref=$editor_image:$editor_tag
    local tty=()
    [ -t 0 ] && [ -t 1 ] && tty=(-it)
    "${docker[@]}" run --rm ${tty[@]+"${tty[@]}"} ${run_args[@]+"${run_args[@]}"} \
        ${cpu_args[@]+"${cpu_args[@]}"} \
        -v "$repo:/work" -v vhil-data:/vhil \
        -e IFS_HIL_REF="${IFS_HIL_REF:-dev}" -e FW_REFS="${FW_REFS:-}" \
        -e VHIL_SYSTEM="${VHIL_SYSTEM:-}" -e VHIL_DUT="${VHIL_DUT:-ecu}" \
        ${VHIL_FAST_FORWARD:+-e VHIL_FAST_FORWARD="$VHIL_FAST_FORWARD"} \
        -e VHIL_MODELS_CACHE=/vhil/renode-models ${VHIL_MODELS:+-e VHIL_MODELS="$VHIL_MODELS"} \
        "$ref" bash -c "$1" vhil "${@:2}"
}

# ELF paths of the last firmware build, as board=elf lines.
prelude='set -euo pipefail
elf() { sed -n "s/^$1=//p" /vhil/fw/built.txt 2>/dev/null | tail -1; }
need_elf() { [ -n "$(elf "$1")" ] || { echo "no $1 firmware: run \`scripts/vhil-docker.sh fw $1\` first" >&2; exit 1; }; }
'

cmd=${1:-help}; shift || true
case "$cmd" in
vm) vm ;;
pull) pull_images ;;
image) build_images ;;
fw)
    [ $# -gt 0 ] || set -- ecu ams
    in_container "$prelude"'
        refs=(); for r in $FW_REFS; do refs+=(--ref "$r"); done
        mkdir -p /vhil/fw
        for s in "$@"; do
            python -m vhil.system build "systems/$s.yaml" --workdir /vhil/fw "${refs[@]}" \
                | tee -a /vhil/fw/built.txt
        done' "$@" ;;
unit)
    in_container "$prelude"'
        python -m pytest tests/unit -q
        for s in systems/*.yaml; do python -m vhil.system validate "$s"; done' ;;
smoke)
    sys=${1:?usage: smoke <ecu|ams>}
    in_container "$prelude"'
        need_elf "$1"; need_elf "$1.bootloader"
        python -m vhil.system render "systems/$1.yaml" --firmware "$1=$(elf "$1")" \
            --firmware "$1.bootloader=$(elf "$1.bootloader")" --can-hub -o /tmp/system.resc
        # renode-test drives Renode through its Robot server, which listens on
        # every interface (HttpListener http://*:port/, no bind option in
        # Renode 1.17). This job runs on the default Docker network, in its own
        # namespace with no published port, so the server is not on the host.
        renode-test "tests/$1_smoke.robot" --variable ELF:"$(elf "$1")" \
            --variable RESC:/tmp/system.resc -r "results/smoke-$1"' "$sys" ;;
sim)
    in_container "$prelude"'
        need_elf ecu; need_elf ams
        export VHIL_ECU_ELF=$(elf ecu) VHIL_AMS_ELF=$(elf ams) VHIL_CAN_BOOTLOADER_ELF=$(elf ecu.bootloader)
        # The uDV only if built (`fw udv`): its tests skip without it.
        export VHIL_UDV_ELF=$(elf udv)
            # tests/sim unless the arguments name tests themselves
            # (sim tests/sim/test_x.py[::name] runs just those).
            paths=tests/sim
            for a in "$@"; do case "$a" in tests/*) paths=; break ;; esac; done
            python -m pytest $paths -v --sim-log-dir results/sim-logs "$@"' "$@" ;;
scenarios)
    in_container "$prelude"'
        need_elf ecu; need_elf ams
        VHIL_ECU_ELF=$(elf ecu) VHIL_AMS_ELF=$(elf ams) VHIL_CAN_BOOTLOADER_ELF=$(elf ecu.bootloader) \
            python -m pytest tests/scenarios -v --sim-log-dir results/sim-logs \
                -o junit_family=xunit1 --junitxml=results/scenarios.xml "$@"' "$@" ;;
coverage)
    in_container "$prelude"'
        need_elf ecu; need_elf ams
        glob=${1:-test_*}; glob=${glob%.py}; shift || true
        files=$(ls tests/sim/$glob.py)
        VHIL_ECU_ELF=$(elf ecu) VHIL_AMS_ELF=$(elf ams) VHIL_CAN_BOOTLOADER_ELF=$(elf ecu.bootloader) \
            python -m pytest $files -v --sim-log-dir results/sim-logs \
                --vhil-coverage results/coverage "$@"' "$@" ;;
speed)
    in_container "$prelude"'
        need_elf ecu; need_elf ams; need_elf ecu.bootloader; nproc
        mkdir -p results/speed
        udv=(); [ -n "$(elf udv)" ] && udv=("udv=$(elf udv)")
        python scripts/speed.py "ecu=$(elf ecu)" "ams=$(elf ams)" ${udv[@]+"${udv[@]}"} \
            "bootloader=$(elf ecu.bootloader)" --json results/speed/speed.json "$@"' "$@" ;;
ifs-hil)
    run_args=("${vcan_args[@]}")
    in_container "$prelude"'
        need_elf "$VHIL_DUT"
        # The other boards of $VHIL_SYSTEM run their last-built images.
        export VHIL_SYSTEM=${VHIL_SYSTEM:-systems/$VHIL_DUT.yaml}
        VHIL_FIRMWARE=
        for b in $(python -c "import sys; from vhil.system import System; print(*System(sys.argv[1]).images())" "$VHIL_SYSTEM"); do
            [ "$b" = "$VHIL_DUT" ] && continue
            need_elf "$b"; VHIL_FIRMWARE+="$b=$(elf "$b") "
        done
        export VHIL_FIRMWARE
        for i in 0 1 2; do
            ip link show "can$i" >/dev/null 2>&1 || ip link add "can$i" type vcan
            ip link set "can$i" txqueuelen 1000 up
        done
        if [ -d /vhil/IFS_HIL/.git ]; then
            git -C /vhil/IFS_HIL fetch -q origin "$IFS_HIL_REF"
            git -C /vhil/IFS_HIL checkout -q --detach FETCH_HEAD
        else
            git clone -q -b "$IFS_HIL_REF" https://github.com/isc-fs/IFS_HIL /vhil/IFS_HIL
        fi
        mkdir -p results/ifs-hil
        candump -L -t a can0 can1 can2 > results/ifs-hil/candump.log 2>&1 &
        set +e
        scripts/run-ifs-hil.sh /vhil/IFS_HIL "$(elf "$VHIL_DUT")" "${1:-smoke}" \
            --vhil-log=/work/results/ifs-hil/vhil-renode.log \
            --junitxml=/work/results/ifs-hil/junit.xml "${@:2}" | tee results/ifs-hil/pytest.txt
        rc=${PIPESTATUS[0]}
        if grep -q "SocketCAN interface .* not present" results/ifs-hil/pytest.txt; then
            echo "error: tests skipped for a missing SocketCAN interface" >&2; exit 1
        fi
        exit $rc' "$@" ;;
editor)
    # Pipeline Manager on the web app's origin, under /editor/, behind the
    # proxy (docker/compose.yaml; the api comes up with it, for the login
    # check). It publishes no port of its own. Run is the web app's, which
    # the worker executes: it comes up too, or a run here stays queued (#393).
    ensure_images
    VHIL_IMAGE=$base_image VHIL_TAG=$base_tag VHIL_EDITOR_TAG=$editor_tag exec "${compose[@]}" up editor proxy worker ;;
export-run|import-run)
    # The app's runs (the vhil-data volume, as the api sees it) to and from
    # a file on the host: its directory is mounted at /xfer.
    if [ "$cmd" = export-run ]; then
        [ -n "${1:-}" ] || { echo "usage: $0 export-run <run id> [-o file|dir]" >&2; exit 2; }
        id=$1 out=.
        [ "${2:-}" = -o ] && out=${3:?-o needs a file or directory}
        if [ -d "$out" ]; then dir=$(cd "$out" && pwd) name=
        else dir=$(cd "$(dirname "$out")" && pwd) name=$(basename "$out"); fi
        args=(export "$id" -o "/xfer/$name")
    else
        f=${1:?usage: $0 import-run <file.vhilrun>}
        [ -f "$f" ] || { echo "no file $f" >&2; exit 1; }
        dir=$(cd "$(dirname "$f")" && pwd)
        args=(import "/xfer/$(basename "$f")")
    fi
    run_args+=(-v "$dir:/xfer" -e VHIL_DATA=/vhil/server -e "USER=${USER:-}")
    in_container 'exec python -c "import sys; from vhil.server.bundle import main; sys.exit(main())" "$@"' "${args[@]}" ;;
editor-check)
    # Pipeline Manager's ./validate (its frontend's load) on each system's
    # dataflow, in the editor image where the patched checkout lives.
    image=$editor_image
    in_container 'exec python -m vhil.editor check "$@"' "$@" ;;
server)
    # A local checkout: dev mode (no login) unless VHIL_AUTH says otherwise;
    # the auth settings pass through when set (docs/development/web-app.md).
    # The api listens on 0.0.0.0 in its container, reached only through the
    # proxy, whose port is on the host's 127.0.0.1 only (docker/compose.yaml).
    ensure_images
    VHIL_IMAGE=$base_image VHIL_TAG=$base_tag VHIL_EDITOR_TAG=$editor_tag exec "${compose[@]}" up api proxy ;;
worker)
    in_container 'export VHIL_DATA=/vhil/server VHIL_FW_DIR=/vhil/fw; exec python -m vhil.worker "$@"' "$@" ;;
prune)
    in_container 'export VHIL_DATA=/vhil/server VHIL_FW_DIR=/vhil/fw; exec python -m vhil.worker prune "$@"' "$@" ;;
shell) in_container 'exec bash' ;;
run) in_container 'exec "$@"' "$@" ;;
*) sed -n '2,/^set -euo/{/^#/p;}' "$0" | sed 's/^# \{0,1\}//'; [ "$cmd" = help ] ;;
esac
