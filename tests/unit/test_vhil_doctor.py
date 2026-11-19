"""bin/vhil doctor --json on Linux, against a stub `docker`. Docker Desktop on
WSL reports a DockerRootDir that isn't in the distro: doctor must still finish
(it ended silently after "firmware built", exit 1, under pipefail)."""
import json
import os
import platform
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]

STUB = r"""#!/bin/sh
[ "$1" = --context ] && shift 2
case "$1 $2" in
"info -f") echo /mnt/wsl/docker-desktop-data/no-such-root ;;
"info "*|"image inspect"|"volume inspect"|"manifest inspect"|"compose version") exit 0 ;;
"run "*) printf 'ecu\n' ;;
*) exit 0 ;;
esac
"""

pytestmark = pytest.mark.skipif(platform.system() != "Linux", reason="GNU df (doctor's Linux branch)")


def test_doctor_finishes_when_dockers_root_is_not_in_this_distro(tmp_path):
    (tmp_path / "docker").write_text(STUB)
    (tmp_path / "docker").chmod(0o755)
    env = {**os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}", "VHIL_DOCKER_CONTEXT": "stub",
           "XDG_CACHE_HOME": str(tmp_path / "cache")}
    r = subprocess.run(["bash", str(REPO / "bin/vhil"), "doctor", "--json"], env=env,
                       capture_output=True, text=True, timeout=60)
    assert r.stdout.strip(), f"doctor ended with no report (exit {r.returncode}): {r.stderr}"
    disk = [c for c in json.loads(r.stdout)["checks"] if c["id"] == "disk"]
    assert len(disk) == 1 and "GB free" in disk[0]["message"], disk
