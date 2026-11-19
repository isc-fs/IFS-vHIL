"""scripts/image-key.sh: the content keys image.yml publishes and vhil-docker.sh pulls."""
import re
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def _git_reachable():
    """A git worktree's .git is a file naming its git dir by host path; in a
    container that mounts only the checkout, git can't follow it. (The
    vhil-docker.sh jobs mount that dir too; other harnesses may not.)"""
    ok = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"],
                        capture_output=True).returncode == 0
    if not ok and (REPO / ".git").is_file():
        pytest.skip("git worktree: its .git points to a host path")


def keys():
    out = subprocess.run([str(REPO / "scripts/image-key.sh")], check=True,
                         capture_output=True, text=True).stdout
    return dict(line.split("=", 1) for line in out.splitlines())


def test_prints_both_keys_and_whether_the_inputs_are_clean():
    k = keys()
    assert set(k) == {"base", "editor", "clean"}
    assert re.fullmatch(r"[0-9a-f]{12}", k["base"])
    assert re.fullmatch(r"[0-9a-f]{12}", k["editor"])
    assert k["base"] != k["editor"]
    assert k["clean"] in ("true", "false")


def test_is_deterministic():
    assert keys() == keys()
