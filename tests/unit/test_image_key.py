"""scripts/image-key.sh: the content keys image.yml publishes and vhil-docker.sh pulls."""
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


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
