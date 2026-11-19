#!/usr/bin/env bash
# Run the vHIL in Docker: every CI job, locally, with nothing installed on
# the host but Docker. On macOS it runs in a Colima VM (profile `vhil`)
# because Docker Desktop's kernel has no vcan; on Linux, set
# VHIL_DOCKER_CONTEXT=default and load vcan on the host.
#
#   scripts/vhil-docker.sh vm                    create/start the VM, with vcan
#   scripts/vhil-docker.sh pull                  pull the published images of this checkout
#   scripts/vhil-docker.sh image                 (re)build the images (docker/) locally
#   scripts/vhil-docker.sh images                get what a run needs: pull the published images,
#                                                build the ones that aren't (as a run would)
#   scripts/vhil-docker.sh status                what's there, read-only (never pulls, builds
#                                                or changes anything): key=value lines, below
#   scripts/vhil-docker.sh fw [ecu ams udv ...]  build firmware from systems/<s>.yaml
#   scripts/vhil-docker.sh unit                  tests/unit + validate every system
#   scripts/vhil-docker.sh smoke <ecu|ams>       tests/<s>_smoke.robot
#   scripts/vhil-docker.sh sim [pytest args]     tests/sim in virtual time (or just the
#                                                tests/... files the args name)
#   scripts/vhil-docker.sh scenarios [pytest args]
#                                                every committed scenario (tests/scenarios, or
#                                                just the tests/... the args name)
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
#   scripts/vhil-docker.sh down                  stop this checkout's editor/server stack (vhil stop)
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
# (e.g. FW_REFS="ecu=feat/x"). FW_LOCAL builds a catalogue firmware from a
# local working tree instead, uncommitted edits included, with the same
# recipe: FW_LOCAL="ecu=$HOME/src/IFS08-CE-ECU" (firmware id = absolute
# path, no spaces; mounted read-only, copied to /vhil/fw/<id>@local and
# built there, incrementally). FW_LOCAL_ONLY=1 builds just those images.
# On an arm64 host, `fw` builds in the x86 (linux/amd64) image, through
# Rosetta or qemu: the Arm toolchain's two host builds ship different
# prebuilt C libraries, so only an x86-hosted build gives the image CI does
# (#351). VHIL_FW_NATIVE=1 builds natively instead.
# VHIL_DOCKER_CPUS=N limits the container to N
# cores (--cpus, --cpuset-cpus), as a CI-class host: GitHub's runners have 4.
# VHIL_FAST_FORWARD=0 passes through, to run Renode without the busy-wait
# fast-forward (docs/performance.md). The models' assembly (vhil/models.py)
# is cached in the volume (/vhil/renode-models): compiled on the first start
# after a model changes; VHIL_MODELS=prebuilt passes through.
# VHIL_PROFILE=<label> records the job's wall time, CPU and peak memory as
# a line of results/profile/profile.jsonl (VHIL_PROFILE_OUT names another
# file; scripts/cgroup-profile.py, docs/development/hardware.md).
#
# Images: every job uses the images of this checkout, named by content key
# (scripts/image-key.sh). When they aren't local, it pulls them from
# $VHIL_REGISTRY (default ghcr.io/isc-fs, published by
# .github/workflows/image.yml) and builds them only when none is published
# or docker/ has uncommitted changes. Each image on its own: a published base
# with an unpublished editor builds just the editor (a few minutes), on the
# base. A registry that doesn't answer is an error, not a reason to build;
# VHIL_BUILD_ON_PULL_FAIL=1 builds then instead.
#
# `status` prints, for callers such as the VS Code extension (a contract:
# keep it stable):
#   docker=up|down|nocli
#   base=<key> base_state=local|published|missing|unknown
#   editor=<key> editor_state=local|published|missing|unknown
#   clean=true|false
#   built=<board>=<elf>      one per board, only when docker=up and the base is local
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
# One compose project and one directory of runs per checkout, named after its
# path: a second checkout (another clone, the VS Code extension's) gets a stack
# of its own instead of replacing this one's containers, and its worker never
# claims this one's runs. The firmware builds (/vhil/fw) stay shared. Its port
# is VHIL_WEB_PORT (8080 by default): give a second checkout another one.
checkout=$(printf '%s' "$repo" | cksum | awk '{printf "%08x", $1}' | cut -c1-8)
project=ifs-vhil-$checkout
server_data=/vhil/server/$checkout
web_port=${VHIL_WEB_PORT:-8080}
export VHIL_WEB_PORT=$web_port VHIL_SERVER_DATA=$server_data
compose=("${docker[@]}" compose -p "$project" -f "$repo/docker/compose.yaml")
# Unprivileged on Docker's default network unless a job needs vcan: only
# `ifs-hil` (and `shell`/`run` with VHIL_DOCKER_VCAN=1) gets --privileged
# --network host. Published ports bind 127.0.0.1 only.
run_args=()
vcan_args=(--privileged --network host)
[ "${VHIL_DOCKER_VCAN:-0}" = 1 ] && run_args=("${vcan_args[@]}")
# A local firmware tree per FW_LOCAL entry, read-only at /src/<id>.
src_args=() fw_sources= local_ids=
for pair in ${FW_LOCAL:-}; do
    id=${pair%%=*} dir=${pair#*=}
    case $dir in /*) ;; *) echo "error: FW_LOCAL $pair: the path must be absolute" >&2; exit 2;; esac
    [ -d "$dir" ] || { echo "error: FW_LOCAL $pair: no such directory" >&2; exit 2; }
    src_args+=(-v "$dir:/src/$id:ro")
    fw_sources+="${fw_sources:+ }$id=/src/$id"
    local_ids+="${local_ids:+ }$id"
done
cpu_args=()
if [ -n "${VHIL_DOCKER_CPUS:-}" ]; then
    cpu_args=(--cpus "$VHIL_DOCKER_CPUS" --cpuset-cpus "0-$((VHIL_DOCKER_CPUS - 1))")
fi

vm() {
    # Only a Colima context is a VM this script owns. Any other (Docker
    # Desktop's desktop-linux, a native engine) is started by its owner.
    if [ "$context" != "colima-$profile" ]; then
        if "${docker[@]}" info >/dev/null 2>&1; then
            echo "Docker context $context is up; it isn't a Colima VM, so there is nothing to start." >&2
            echo "(The ifs-hil job needs vcan, which only the Colima VM is set up with.)" >&2
            return 0
        fi
        echo "error: Docker context $context doesn't answer, and it isn't a Colima VM this script starts: start it yourself." >&2
        return 1
    fi
    if ! colima status "$profile" >/dev/null 2>&1; then
        colima start "$profile" --cpu "${VHIL_CPUS:-8}" --memory "${VHIL_MEMORY:-8}" \
            --disk 40 --vm-type vz --vz-rosetta --arch aarch64
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
    out=$("$repo/scripts/image-key.sh") || return 1
    base=$(sed -n 's/^base=//p' <<<"$out")
    editor=$(sed -n 's/^editor=//p' <<<"$out")
    clean=$(sed -n 's/^clean=//p' <<<"$out")
}
have() { "${docker[@]}" image inspect "$1" >/dev/null 2>&1; }

# Whether $registry/<name>:<key> is published, from its manifest alone (no
# pull, no daemon: the docker CLI asks the registry): 0 yes, 1 not found,
# 2 couldn't tell (network, auth, rate limit), with the error in published_err.
published_err=''
published() {
    local out
    if out=$(docker manifest inspect "$registry/$1:$2" 2>&1 >/dev/null); then return 0; fi
    published_err=$out
    case $out in
    *"manifest unknown"*|*"not found"*|*"no such manifest"*) return 1 ;;
    esac
    return 2
}

# The board=elf lines of built.txt a run may use: a working tree's build
# (/vhil/fw/<id>@local/...) only for a run that builds that tree (FW_LOCAL,
# its ids in `ids`), never another window's, or one left by an earlier run.
# It holds no single quote: the prelude embeds it in the container's script.
usable_built='BEGIN { n = split(ids, a, " "); for (i = 1; i <= n; i++) mine[a[i]] = 1 }
    { p = substr($0, index($0, "=") + 1)
      if (match(p, /^\/vhil\/fw\/[^\/]+@local\//)) { id = substr(p, 10, RLENGTH - 16); if (!(id in mine)) next }
      print }'
# The board=elf lines of built.txt, the last per board, in first-seen order.
last_per_board='{ if (!($1 in last)) order[n++] = $1; last[$1] = $0 }
    END { for (i = 0; i < n; i++) print last[order[i]] }'

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

# One image of this checkout (ifs-vhil or ifs-vhil-editor) by its key: kept
# when local, else pulled when published. Returns 1 when none is published
# (the caller builds it, or not); exits on a failed pull or a registry that
# doesn't answer, rather than starting a ~30 min build over a network blip.
fetch_image() {
    local name=$1 key=$2 local_image=$base_image rc=0
    [ "$name" = ifs-vhil-editor ] && local_image=$editor_image
    have "$local_image:$key" && return 0
    published "$name" "$key" || rc=$?
    case $rc in
    0)
        echo "pulling $registry/$name:$key" >&2
        if ! "${docker[@]}" pull "$registry/$name:$key"; then
            echo "error: pulling $registry/$name:$key failed: retry, or check free disk with \`bin/vhil doctor\`" >&2
            exit 1
        fi
        "${docker[@]}" tag "$registry/$name:$key" "$local_image:$key" ;;
    1) return 1 ;;
    *)
        echo "$published_err" >&2
        if [ "${VHIL_BUILD_ON_PULL_FAIL:-0}" = 1 ]; then
            echo "can't reach $registry for $name:$key: building it (VHIL_BUILD_ON_PULL_FAIL=1)" >&2
            return 1
        fi
        echo "error: can't tell whether $registry/$name:$key is published (above): retry, or set VHIL_BUILD_ON_PULL_FAIL=1 to build it" >&2
        exit 1 ;;
    esac
}

# The published images of this checkout, tagged locally as the images and as
# their keys. Fails when docker/ has uncommitted changes or one isn't
# published (any job then builds just that one).
pull_images() {
    image_keys
    if [ "$clean" != true ]; then
        echo "docker/ or the editor's sources have uncommitted changes: build them (\`image\`)" >&2
        return 1
    fi
    local rc=0
    if fetch_image ifs-vhil "$base"; then
        "${docker[@]}" tag "$base_image:$base" "$base_image"
    else
        echo "ifs-vhil:$base isn't published" >&2; rc=1
    fi
    if fetch_image ifs-vhil-editor "$editor"; then
        "${docker[@]}" tag "$editor_image:$editor" "$editor_image"
    else
        echo "ifs-vhil-editor:$editor isn't published" >&2; rc=1
    fi
    return $rc
}

# The images of this checkout, each on its own: local by key, else pulled,
# else built. Once per invocation (`fw` asks, then in_container again).
images_ready=false
ensure_images() {
    [ "$images_ready" = true ] && return
    image_keys
    if [ "$clean" != true ]; then
        echo "docker/ or the editor's sources have uncommitted changes: using the local \`latest\` images" >&2
        if ! have "$base_image" || ! have "$editor_image"; then build_images; fi
        base_tag=latest editor_tag=latest images_ready=true
        return
    fi
    local built_base=false
    if ! fetch_image ifs-vhil "$base"; then
        echo "building ifs-vhil:$base (Renode from source, ~30 min)" >&2
        "${docker[@]}" build -t "$base_image:$base" "$repo/docker"
        built_base=true
    fi
    # An editor built on a base built here: a published one sits on a
    # published base, which this one isn't.
    if [ "$built_base" = true ] || ! fetch_image ifs-vhil-editor "$editor"; then
        echo "building ifs-vhil-editor:$editor on the $([ "$built_base" = true ] && echo local || echo published) base (a few minutes)" >&2
        "${docker[@]}" build -t "$editor_image:$editor" --build-arg BASE="$base_image:$base" \
            -f "$repo/docker/editor.Dockerfile" "$repo"
    fi
    if ! have "$base_image:$base" || ! have "$editor_image:$editor"; then
        echo "error: no ifs-vhil:$base / ifs-vhil-editor:$editor after pulling or building" >&2
        exit 1
    fi
    # `latest` follows the last checkout used, for docker compose run by hand.
    "${docker[@]}" tag "$base_image:$base" "$base_image"
    "${docker[@]}" tag "$editor_image:$editor" "$editor_image"
    base_tag=$base editor_tag=$editor images_ready=true
}

# The x86 image of this checkout for `fw` on an arm64 host (#351): sets
# fw_ref and fw_platform, or leaves them empty (and says why) to build natively.
fw_ref='' fw_platform=()
x86_fw() {
    [ "${VHIL_FW_NATIVE:-0}" = 1 ] && return
    case $("${docker[@]}" info --format '{{.Architecture}}') in x86_64|amd64) return ;; esac
    local why=
    if [ "$base_tag" = latest ]; then
        why="the images are a local build (docker/ has uncommitted changes)"
    else
        local ref=$base_image:$base-amd64
        # Whether this Docker runs amd64, asked once per base key (a
        # container start through Rosetta or qemu on every `fw` otherwise).
        local stamp=${XDG_CACHE_HOME:-$HOME/.cache}/vhil/x86-ok-$context-$base
        if have "$ref" && [ -f "$stamp" ]; then
            fw_ref=$ref fw_platform=(--platform linux/amd64)
            return
        fi
        if ! have "$ref"; then
            echo "pulling the x86 image ($registry/ifs-vhil:$base) to build firmware as CI does (#351)" >&2
            if "${docker[@]}" pull -q --platform linux/amd64 "$registry/ifs-vhil:$base" >/dev/null; then
                "${docker[@]}" tag "$registry/ifs-vhil:$base" "$ref"
            fi
        fi
        if ! have "$ref"; then
            why="no x86 image of this checkout could be pulled"
        elif ! "${docker[@]}" run --rm --platform linux/amd64 "$ref" true >/dev/null 2>&1; then
            why="this Docker can't run x86 images (Colima: colima start $profile --vz-rosetta)"
        else
            mkdir -p "$(dirname "$stamp")" && touch "$stamp" || true
            fw_ref=$ref fw_platform=(--platform linux/amd64)
            return
        fi
    fi
    echo "warning: building firmware natively: $why. The uDV image then differs from CI's" >&2
    echo "  (the Arm toolchain's prebuilt C library differs by host, #351); VHIL_FW_NATIVE=1 silences this." >&2
}

# A git worktree's .git is a file pointing at the main checkout's git dir on
# the host: mounted alone at /work, git there finds no repository. Sets
# git_common to that dir when it lies outside the checkout, else empty.
git_common=''
worktree_git() {
    [ -f "$repo/.git" ] || return 0
    local common
    common=$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 0
    case $common in "$repo"|"$repo"/*) ;; *) git_common=$common ;; esac
}
worktree_git

# The compose stack mounts the checkout alone (docker/compose.yaml), so its
# git dir isn't there: refuse up front rather than fail inside, where the
# api's git says "the workspace has no commits".
# The stack's working tree, for the editor's Run (vhil/server/runs.py
# RunRequest.local): FW_LOCAL's first entry, mounted at /src/local in the
# worker. Compose reads both; empty, a run builds no working tree.
stack_local() {
    local pair=${FW_LOCAL:-}; pair=${pair%% *}
    [ -n "$pair" ] || return 0
    [ "$pair" = "${FW_LOCAL:-}" ] || echo "note: the editor's runs build ${pair%%=*}'s working tree only (FW_LOCAL's first entry)" >&2
    export VHIL_LOCAL_SOURCES="${pair%%=*}=/src/local" VHIL_LOCAL_DIR=${pair#*=}
}

# The web port, unless this checkout's own stack holds it: another stack on it
# (another checkout's, or one from before per-checkout projects) is named.
web_port_free() {
    local other
    other=$("${docker[@]}" ps --filter "publish=$web_port" \
        --format '{{.Label "com.docker.compose.project"}} {{.Names}}' 2>/dev/null \
        | awk -v p="$project" '$1 != p {print $2 " (" ($1 ? "project " $1 : "not compose") ")"; exit}')
    [ -z "$other" ] && return
    case $other in
    *"(project ifs-vhil)")
        # Started before per-checkout projects: its containers hold no data.
        echo "error: port $web_port is taken by $other, a stack from before each checkout got its own: stop it with" >&2
        echo "  $0 down    (or: vhil stop)" >&2 ;;
    *) echo "error: port $web_port is taken by $other. Stop it, or run this checkout's on another port: VHIL_WEB_PORT=8090 $0 $cmd" >&2 ;;
    esac
    exit 1
}

no_worktree() {
    [ -z "$git_common" ] && return
    echo "error: the $1 can't run from a git worktree yet (its git dir $git_common isn't visible in the containers): start it from the main checkout" >&2
    exit 1
}

# Run a script in the container. For vcan jobs, host networking puts
# can0..can2 in the VM's namespace, where they outlive the container, and
# --privileged lets the container create them.
in_container() {
    ensure_images
    local ref=$base_image:$base_tag
    [ "$image" = "$editor_image" ] && ref=$editor_image:$editor_tag
    [ -n "$fw_ref" ] && ref=$fw_ref
    local tty=() git_args=()
    [ -t 0 ] && [ -t 1 ] && tty=(-it)
    # A worktree: its git dir at the same path, read-only (jobs only read
    # git), trusted though another uid owns it there.
    [ -n "$git_common" ] && git_args=(-v "$git_common:$git_common:ro"
        -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*')
    # VHIL_DEBUG=<board>:<port>: that board waits for a GDB on the host's
    # 127.0.0.1:<port> (vhil/debugattach.py, the VS Code Debug profile).
    local debug_args=()
    if [ -n "${VHIL_DEBUG:-}" ]; then
        local debug_port=${VHIL_DEBUG##*:}
        debug_args=(-e VHIL_DEBUG="$VHIL_DEBUG" -p "127.0.0.1:$debug_port:$debug_port")
    fi
    # VHIL_DOCKER_NAME names the container, so a caller (the VS Code
    # extension's Cancel) can stop it with `docker kill`.
    "${docker[@]}" run --rm ${tty[@]+"${tty[@]}"} ${run_args[@]+"${run_args[@]}"} \
        ${fw_platform[@]+"${fw_platform[@]}"} \
        ${VHIL_DOCKER_NAME:+--name "$VHIL_DOCKER_NAME"} \
        ${debug_args[@]+"${debug_args[@]}"} \
        ${cpu_args[@]+"${cpu_args[@]}"} ${src_args[@]+"${src_args[@]}"} \
        -v "$repo:/work" ${git_args[@]+"${git_args[@]}"} -v vhil-data:/vhil \
        -e FW_SOURCES="$fw_sources" -e FW_LOCAL_ONLY="${FW_LOCAL_ONLY:-0}" \
        -e IFS_HIL_REF="${IFS_HIL_REF:-dev}" -e FW_REFS="${FW_REFS:-}" \
        -e VHIL_SYSTEM="${VHIL_SYSTEM:-}" -e VHIL_DUT="${VHIL_DUT:-ecu}" \
        ${VHIL_FAST_FORWARD:+-e VHIL_FAST_FORWARD="$VHIL_FAST_FORWARD"} \
        ${VHIL_PROFILE_HOST:+-e VHIL_PROFILE_HOST="$VHIL_PROFILE_HOST"} \
        -e VHIL_MODELS_CACHE=/vhil/renode-models ${VHIL_MODELS:+-e VHIL_MODELS="$VHIL_MODELS"} \
        "$ref" ${VHIL_PROFILE:+python /work/scripts/cgroup-profile.py --label "$VHIL_PROFILE" \
            --out "/work/results/profile/${VHIL_PROFILE_OUT:-profile.jsonl}" --} \
        bash -c "$1" vhil "${@:2}"
}

# The ELF a run uses for a board: the last usable build of it (usable_built).
prelude='set -euo pipefail
local_ids=; for r in $FW_SOURCES; do local_ids+=" ${r%%=*}"; done
elf() { awk -v ids="$local_ids" '"'$usable_built'"' /vhil/fw/built.txt 2>/dev/null | sed -n "s/^$1=//p" | tail -1; }
need_elf() { [ -n "$(elf "$1")" ] || { echo "no $1 firmware: run \`scripts/vhil-docker.sh fw $1\` first" >&2; exit 1; }; }
'

# Read-only: no ensure_images, no pull, no build (the format: header).
status() {
    local state=up
    if ! command -v docker >/dev/null; then state=nocli
    elif ! "${docker[@]}" info >/dev/null 2>&1; then state=down
    fi
    echo "docker=$state"
    if ! image_keys 2>/dev/null; then
        echo "error: scripts/image-key.sh failed (is this a git checkout?)" >&2
        return 1
    fi
    local name key local_image st rc base_st=
    for name in ifs-vhil ifs-vhil-editor; do
        key=$base local_image=$base_image
        [ "$name" = ifs-vhil-editor ] && key=$editor local_image=$editor_image
        rc=0
        if [ "$state" = up ] && have "$local_image:$key"; then st=local
        elif [ "$state" = nocli ]; then st=unknown
        else
            published "$name" "$key" || rc=$?
            case $rc in 0) st=published ;; 1) st=missing ;; *) st=unknown ;; esac
        fi
        if [ "$name" = ifs-vhil ]; then echo "base=$key base_state=$st"; base_st=$st
        else echo "editor=$key editor_state=$st"
        fi
    done
    echo "clean=$clean"
    echo "project=$project web_port=$web_port"
    # Only an existing volume: `docker run -v` would create it.
    if [ "$state" = up ] && [ "$base_st" = local ] \
        && "${docker[@]}" volume inspect vhil-data >/dev/null 2>&1; then
        { "${docker[@]}" run --rm -v vhil-data:/vhil "$base_image:$base" \
            cat /vhil/fw/built.txt 2>/dev/null || true; } \
            | awk -v ids="$local_ids" "$usable_built" | awk -F= "$last_per_board" | sed 's/^/built=/'
    fi
}

cmd=${1:-help}; shift || true
case "$cmd" in
vm) vm ;;
pull) pull_images ;;
image) build_images ;;
images) ensure_images ;;
status) status ;;
fw)
    [ $# -gt 0 ] || set -- ecu ams
    ensure_images
    x86_fw
    in_container "$prelude"'
        refs=(); for r in $FW_REFS; do refs+=(--ref "$r"); done
        for r in $FW_SOURCES; do refs+=(--source "$r"); done
        [ "$FW_LOCAL_ONLY" = 1 ] && refs+=(--only-local)
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
        # tests/scenarios unless the arguments name tests themselves, as sim.
        paths=tests/scenarios
        for a in "$@"; do case "$a" in tests/*) paths=; break ;; esac; done
        VHIL_ECU_ELF=$(elf ecu) VHIL_AMS_ELF=$(elf ams) VHIL_CAN_BOOTLOADER_ELF=$(elf ecu.bootloader) \
            python -m pytest $paths -v --sim-log-dir results/sim-logs \
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
    no_worktree "system editor"
    web_port_free
    stack_local
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
    run_args+=(-v "$dir:/xfer" -e VHIL_DATA="$server_data" -e "USER=${USER:-}")
    in_container 'exec python -c "import sys; from vhil.server.bundle import main; sys.exit(main())" "$@"' "${args[@]}" ;;
editor-check)
    # Pipeline Manager's ./validate (its frontend's load) on each system's
    # dataflow, in the editor image where the patched checkout lives.
    image=$editor_image
    in_container 'exec python -m vhil.editor check "$@"' "$@" ;;
down)
    # Stop this checkout's stack (vhil stop, the desktop app's Stop), and one
    # from before each checkout got its own (project ifs-vhil), which holds
    # no data but would keep the port and serve an old editor.
    "${compose[@]}" down
    "${docker[@]}" compose -p ifs-vhil -f "$repo/docker/compose.yaml" down ;;
server)
    # A local checkout: dev mode (no login) unless VHIL_AUTH says otherwise;
    # the auth settings pass through when set (docs/development/web-app.md).
    # The api listens on 0.0.0.0 in its container, reached only through the
    # proxy, whose port is on the host's 127.0.0.1 only (docker/compose.yaml).
    no_worktree "web app"
    web_port_free
    stack_local
    ensure_images
    VHIL_IMAGE=$base_image VHIL_TAG=$base_tag VHIL_EDITOR_TAG=$editor_tag exec "${compose[@]}" up api proxy ;;
worker)
    in_container 'export VHIL_DATA="$1" VHIL_FW_DIR=/vhil/fw; shift; exec python -m vhil.worker "$@"' "$server_data" "$@" ;;
prune)
    in_container 'export VHIL_DATA="$1" VHIL_FW_DIR=/vhil/fw; shift; exec python -m vhil.worker prune "$@"' "$server_data" "$@" ;;
shell) in_container 'exec bash' ;;
run) in_container 'exec "$@"' "$@" ;;
*) sed -n '2,/^set -euo/{/^#/p;}' "$0" | sed 's/^# \{0,1\}//'; [ "$cmd" = help ] ;;
esac
