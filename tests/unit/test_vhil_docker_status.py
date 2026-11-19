"""scripts/vhil-docker.sh status: the read-only key=value report the VS Code
extension reads. Against a stub `docker` that logs every call, so nothing is
started, pulled or built."""
import os
import re
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


def test_a_working_tree_build_counts_only_for_the_run_that_builds_that_tree(tmp_path):
    """A firmware repository's window built ecu@local last: a run of yours
    (no FW_LOCAL) keeps the catalogue's ecu, the window's own gets its tree,
    and another window's tree (ams@local) is never anyone else's."""
    _keys_or_skip()
    built = (r"ecu=/vhil/fw/ecu+1234.x/build/ECU08.elf\nams=/vhil/fw/ams+5678.x/build/AMS.elf\n"
             r"ams=/vhil/fw/ams@local/build/AMS.elf\necu=/vhil/fw/ecu@local/build/ECU08.elf\n")
    stub = dict(STUB_UP="1", STUB_LOCAL="1", STUB_BUILT=built)
    _, out, _ = status(tmp_path, **stub)
    assert [l for l in out if l.startswith("built=")] == [
        "built=ecu=/vhil/fw/ecu+1234.x/build/ECU08.elf", "built=ams=/vhil/fw/ams+5678.x/build/AMS.elf"]
    tree = tmp_path / "IFS08-CE-ECU"
    tree.mkdir()
    _, out, _ = status(tmp_path, FW_LOCAL=f"ecu={tree}", **stub)
    assert [l for l in out if l.startswith("built=")] == [
        "built=ecu=/vhil/fw/ecu@local/build/ECU08.elf", "built=ams=/vhil/fw/ams+5678.x/build/AMS.elf"]


def test_the_containers_elf_uses_the_same_rule(tmp_path):
    """The prelude's elf() (sim, scenarios, smoke): built.txt as above."""
    fw = tmp_path / "fw"
    fw.mkdir()
    (fw / "built.txt").write_text("ecu=/vhil/fw/ecu+1/ECU08.elf\necu=/vhil/fw/ecu@local/ECU08.elf\n"
                                  "ecu.bootloader=/vhil/fw/bootloader+2/bl.elf\n")
    text = SCRIPT.read_text()
    usable = text.split("usable_built='", 1)[1].split("'\n", 1)[0]
    prelude = text.split("prelude='", 1)[1].split("\n'\n", 1)[0]
    prelude = prelude.replace("'\"'$usable_built'\"'", "'" + usable + "'").replace("/vhil/fw/built.txt",
                                                                                     str(fw / "built.txt"))

    def elf(board, sources=""):
        r = subprocess.run(["bash", "-c", prelude + f"\nelf {board}"], env={**os.environ, "FW_SOURCES": sources},
                           capture_output=True, text=True, check=True)
        return r.stdout.strip()

    assert elf("ecu") == "/vhil/fw/ecu+1/ECU08.elf"
    assert elf("ecu", "ecu=/src/ecu") == "/vhil/fw/ecu@local/ECU08.elf"
    assert elf("ecu", "ams=/src/ams") == "/vhil/fw/ecu+1/ECU08.elf"
    assert elf("ecu.bootloader", "ecu=/src/ecu") == "/vhil/fw/bootloader+2/bl.elf"
    assert elf("udv") == ""


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


@pytest.mark.parametrize("verb", ["editor", "server"])
def test_the_stack_starts_with_no_local_firmware(tmp_path, verb):
    """FW_LOCAL unset (everyone but a firmware developer): the stack's verbs
    must get past stack_local. v0.2.1 ended every `vhil ui` with "FW_LOCAL:
    unbound variable" under set -u."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    # Every docker call succeeds: the verb runs to its compose up.
    (bindir / "docker").write_text("#!/bin/sh\nexit 0\n")
    (bindir / "docker").chmod(0o755)
    env = {k: v for k, v in os.environ.items() if k != "FW_LOCAL"}
    env.update({"PATH": f"{bindir}:{os.environ['PATH']}", "STUB_LOG": str(tmp_path / "docker.log"),
                "VHIL_DOCKER_CONTEXT": "stub", "XDG_CACHE_HOME": str(tmp_path / "cache"),
                "VHIL_WEB_PORT": "18999", "STUB_UP": "1", "STUB_LOCAL": "1", "STUB_VOLUME": "1",
                "STUB_PUBLISHED": "", "STUB_BUILT": ""})
    r = subprocess.run(["bash", str(SCRIPT), verb], env=env, capture_output=True, text=True, timeout=60)
    assert "unbound variable" not in r.stderr, r.stderr
    assert r.returncode == 0, r.stderr


def test_stop_downs_this_checkouts_stack_and_a_pre_446_one(tmp_path):
    """vhil stop (the desktop app's Stop) took compose.yaml's own name,
    ifs-vhil, so it never stopped the per-checkout stack `vhil ui` starts."""
    r, _, calls = status(tmp_path)
    project = next(l for l in r.stdout.splitlines() if l.startswith("project=")).split()[0][len("project="):]
    bindir = tmp_path / "bin"
    log = tmp_path / "down.log"
    (bindir / "docker").write_text(f'#!/bin/sh\necho "$*" >> {log}\n')
    env = {**os.environ, "PATH": f"{bindir}:{os.environ['PATH']}", "VHIL_DOCKER_CONTEXT": "stub"}
    r = subprocess.run(["bash", str(REPO / "bin/vhil"), "stop"], env=env, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    downs = [l for l in log.read_text().splitlines() if l.endswith(" down")]
    assert any(f"-p {project} " in l for l in downs), downs
    assert any("-p ifs-vhil " in l for l in downs), downs


def _stack(tmp_path, owner, **extra):
    """vhil-docker.sh stack with a docker that says `owner` publishes the port."""
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    (bindir / "docker").write_text(f'#!/bin/sh\ncase "$*" in *" ps "*) [ -n "{owner}" ] && echo "{owner}" ;; esac\nexit 0\n')
    (bindir / "docker").chmod(0o755)
    env = {k: v for k, v in os.environ.items() if k not in ("VHIL_WEB_PORT", "VHIL_STACK_ID")}
    env.update({"PATH": f"{bindir}:{os.environ['PATH']}", "VHIL_DOCKER_CONTEXT": "stub", **extra})
    r = subprocess.run(["bash", str(REPO / "scripts/vhil-docker.sh"), "stack"], env=env,
                       capture_output=True, text=True, timeout=60)
    return r, dict(l.split("=", 1) for l in r.stdout.splitlines() if "=" in l)


def test_stack_names_this_checkout_and_who_holds_the_port(tmp_path):
    """The VS Code extension frames only this checkout's stack (vscode/src/stack.ts)."""
    r, out = _stack(tmp_path, "")
    assert r.returncode == 0, r.stderr
    assert re.fullmatch(r"ifs-vhil-[0-9a-f]{8}", out["project"]) and out["port"] == "8080"
    assert out["owner"] == ""
    _, out = _stack(tmp_path, "ifs-vhil-99999999", VHIL_WEB_PORT="8123")
    assert out["owner"] == "ifs-vhil-99999999" and out["port"] == "8123"


def test_a_stack_id_replaces_the_paths(tmp_path):
    """One stack per firmware repository over the extension's one checkout."""
    _, out = _stack(tmp_path, "", VHIL_STACK_ID="0badf00d")
    assert out["project"] == "ifs-vhil-0badf00d"
    r, _ = _stack(tmp_path, "", VHIL_STACK_ID="../evil")
    assert r.returncode == 2 and "VHIL_STACK_ID" in r.stderr
