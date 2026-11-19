"""scripts/vhil-docker.sh status: the read-only key=value report the VS Code
extension reads. Against a stub `docker` that logs every call, so nothing is
started, pulled or built."""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts/vhil-docker.sh"

# The stub: `info` and `image inspect` answer per $STUB_UP / $STUB_LOCAL,
# `volume inspect` per $STUB_VOLUME, `manifest inspect` finds only what $STUB_PUBLISHED names, `run` prints
# $STUB_BUILT; anything else fails loudly.
STUB = r"""#!/bin/sh
echo "$*" >> "$STUB_LOG"
[ "$1" = --context ] && shift 2
case "$1 $2" in
"info "*) [ "$STUB_UP" = 1 ] ;;
"image inspect") [ "$STUB_LOCAL" = 1 ] ;;
"volume inspect") [ "$STUB_VOLUME" = 1 ] ;;
"manifest inspect")
    case " $STUB_PUBLISHED " in *" ${3##*/} "*) exit 0 ;; esac
    echo "manifest unknown" >&2; exit 1 ;;
"run "*) printf '%b' "$STUB_BUILT" ;;
*) echo "stub docker: unexpected $*" >&2; exit 99 ;;
esac
"""


def _keys_or_skip():
    r = subprocess.run([str(REPO / "scripts/image-key.sh")], capture_output=True, text=True)
    if r.returncode != 0 and (REPO / ".git").is_file():
        pytest.skip("git worktree: its .git points to a host path")
    r.check_returncode()
    return dict(line.split("=", 1) for line in r.stdout.splitlines())


def status(tmp_path, path=None, **stub):
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    (bindir / "docker").write_text(STUB)
    (bindir / "docker").chmod(0o755)
    log = tmp_path / "docker.log"
    env = {**os.environ, "PATH": path or f"{bindir}:{os.environ['PATH']}",
           "STUB_LOG": str(log), "VHIL_DOCKER_CONTEXT": "stub",
           "XDG_CACHE_HOME": str(tmp_path / "cache"),
           "STUB_UP": "0", "STUB_LOCAL": "0", "STUB_VOLUME": "1", "STUB_PUBLISHED": "", "STUB_BUILT": "",
           **stub}
    r = subprocess.run(["bash", str(SCRIPT), "status"], env=env,
                       capture_output=True, text=True, timeout=60)
    calls = log.read_text().splitlines() if log.exists() else []
    # The stack's project line: test_each_checkout_has_its_own_stack.
    return r, [l for l in r.stdout.splitlines() if not l.startswith("project=")], calls


def test_the_script_parses():
    subprocess.run(["bash", "-n", str(SCRIPT)], check=True)


def test_docker_down_and_nothing_published(tmp_path):
    k = _keys_or_skip()
    r, out, calls = status(tmp_path)
    assert r.returncode == 0, r.stderr
    assert out == ["docker=down",
                   f"base={k['base']} base_state=missing",
                   f"editor={k['editor']} editor_state=missing",
                   f"clean={k['clean']}"]
    # It asked, and only asked: no pull, build, run or compose.
    assert all(c.split()[2] == "info" if c.startswith("--context") else
               c.startswith("manifest inspect") for c in calls), calls


def test_a_published_base_with_a_missing_editor(tmp_path):
    k = _keys_or_skip()
    r, out, calls = status(tmp_path, STUB_UP="1", STUB_PUBLISHED=f"ifs-vhil:{k['base']}")
    assert r.returncode == 0, r.stderr
    assert out[:3] == ["docker=up", f"base={k['base']} base_state=published",
                       f"editor={k['editor']} editor_state=missing"]
    assert not any(" run " in f" {c} " or " pull " in f" {c} " or " build " in f" {c} "
                   for c in calls), calls


def test_a_local_base_lists_the_last_build_per_board(tmp_path):
    k = _keys_or_skip()
    built = r"ecu=/vhil/fw/a/ecu.elf\nams=/vhil/fw/a/ams.elf\necu=/vhil/fw/b/ecu.elf\n"
    r, out, _ = status(tmp_path, STUB_UP="1", STUB_LOCAL="1", STUB_BUILT=built)
    assert r.returncode == 0, r.stderr
    assert out == ["docker=up", f"base={k['base']} base_state=local",
                   f"editor={k['editor']} editor_state=local", f"clean={k['clean']}",
                   "built=ecu=/vhil/fw/b/ecu.elf", "built=ams=/vhil/fw/a/ams.elf"]


def test_no_data_volume_starts_no_container(tmp_path):
    # `docker run -v vhil-data:...` would create the volume: status must not.
    k = _keys_or_skip()
    r, out, calls = status(tmp_path, STUB_UP="1", STUB_LOCAL="1", STUB_VOLUME="0",
                           STUB_BUILT=r"ecu=/vhil/fw/a/ecu.elf\n")
    assert r.returncode == 0, r.stderr
    assert out[-1] == f"clean={k['clean']}"
    assert not any(" run " in f" {c} " for c in calls), calls


def test_no_docker_cli(tmp_path):
    k = _keys_or_skip()
    # A PATH with what the scripts use but no docker.
    tools = tmp_path / "tools"
    tools.mkdir()
    for t in ("bash", "git", "sed", "awk", "cut", "dirname", "cat", "cksum"):
        w = shutil.which(t)
        if w is None:
            pytest.skip(f"no {t}")
        (tools / t).symlink_to(w)
    r, out, calls = status(tmp_path, path=str(tools))
    assert r.returncode == 0, r.stderr
    assert out == ["docker=nocli", f"base={k['base']} base_state=unknown",
                   f"editor={k['editor']} editor_state=unknown", f"clean={k['clean']}"]
    assert calls == []


def test_each_checkout_has_its_own_stack(tmp_path):
    """Its compose project from the checkout's path, its port VHIL_WEB_PORT
    (8080 unset); nothing started to say so."""
    r, _, _ = status(tmp_path)
    line = next(l for l in r.stdout.splitlines() if l.startswith("project="))
    project, port = line.split()
    assert project.startswith("project=ifs-vhil-") and len(project) == len("project=ifs-vhil-") + 8
    assert port == "web_port=8080"
    r, _, _ = status(tmp_path, VHIL_WEB_PORT="8123")
    assert f"{project} web_port=8123" in r.stdout.splitlines()
