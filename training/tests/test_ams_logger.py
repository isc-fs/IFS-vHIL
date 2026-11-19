"""The AMS's SD logger after one drive: the grading test of the planned
logger puzzle (AMS#495). No puzzle uses it yet: on the pre-fix commit
(f36e9d5) the vHIL writes one file, as the fixed one does, because the
emulated card answers in zero virtual time and the bug needs the open to
take some. It waits for an SD-latency model.

What it does:
the AMS boots on a fresh FAT32 card, logs for DRIVE_S of virtual time, and
the card is read as a laptop would see it.

  test_card_after_a_drive        the trainee's car: the card's listing goes to
                                 card.json (the Training page's SD card view);
                                 it never fails.
  test_one_file_per_stream       solved: one power-on opens one file per log
                                 stream (LOG, IMU, CEL, ELE), and nothing rotates
                                 in DRIVE_S (log_rotation.hpp rotates on size,
                                 rows or age, none reached this soon).

The fault on the car (AMS#495, fixed by #496): the file's open time was taken
after the slow SD open, so `now - g_file_open_ms` could go below zero; as a
uint32 that's about 4.29e9 ms, "too old", and the logger rotated on every
row: ~990 tiny files a run.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from vhil.sim import Sim
from vhil.system import REPO

pytestmark = [pytest.mark.filterwarnings("ignore")]

DRIVE_S = 20
CARD_BYTES = 0x8000000          # catalog/models/sd-card.yaml capacity: 128 MiB
STREAMS = ("LOG", "IMU", "CEL", "ELE")
NAME = re.compile(r"^(?P<stream>[A-Z]{3})(?P<index>\d{4})\.(?P<ext>[A-Z]{3})$")


def _tool(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        pytest.fail(f"{name} not installed (dosfstools / mtools)")
    return path


def _env():
    return dict(os.environ, MTOOLS_SKIP_CHECK="1")


def _listing(img: Path) -> list[dict]:
    """Every file on the card with its size, as a laptop lists it."""
    names = subprocess.run([_tool("mdir"), "-i", str(img), "-b", "::/"], check=True,
                           capture_output=True, text=True, env=_env()).stdout
    files = []
    for line in names.splitlines():
        name = line.strip().split("/")[-1]
        if not name:
            continue
        info = subprocess.run([_tool("mdir"), "-i", str(img), f"::/{name}"], check=True,
                              capture_output=True, text=True, env=_env()).stdout
        size = next((int(t) for row in info.splitlines() for t in row.split()[2:3]
                     if t.isdigit() and row.split()[0].upper() == name.split(".")[0].upper()), 0)
        files.append({"name": name.upper(), "bytes": size})
    return sorted(files, key=lambda f: f["name"])


@pytest.fixture(scope="module")
def card(tmp_path_factory, images):
    """The card after one power-on and DRIVE_S of logging, then a power cut."""
    d = tmp_path_factory.mktemp("training-card")
    img = d / "card.img"
    with open(img, "wb") as f:
        f.truncate(CARD_BYTES)
    subprocess.run([_tool("mkfs.fat"), "-F", "32", "-s", "1", "-n", "AMS", str(img)],
                   check=True, capture_output=True)
    with Sim(REPO / "systems" / "ams.yaml", images("ams"), params={"sd": {"image": str(img)}},
             card_dirs=[d]) as sim:
        sim.wait_for_app()
        sim.run_for(ms=DRIVE_S * 1000)
        sim.monitor("sysbus.sdmmc1.sd Flush", board="ams")
    return _listing(img)


def _per_stream(files: list[dict]) -> dict[str, set[int]]:
    out: dict[str, set[int]] = {s: set() for s in STREAMS}
    for f in files:
        m = NAME.match(f["name"])
        if m and m["stream"] in out:
            out[m["stream"]].add(int(m["index"]))
    return out


def test_card_after_a_drive(card, out_dir):
    streams = _per_stream(card)
    (out_dir / "card.json").write_text(json.dumps({
        "drive_s": DRIVE_S, "files": card,
        "per_stream": {s: len(v) for s, v in streams.items()},
        "bytes": sum(f["bytes"] for f in card)}, indent=1))
    print(f"card after {DRIVE_S} s: {len(card)} files, "
          + ", ".join(f"{s}: {len(v)}" for s, v in streams.items()))


def test_one_file_per_stream(card, out_dir):
    test_card_after_a_drive(card, out_dir)
    streams = _per_stream(card)
    assert streams["LOG"], f"no LOG file at all: the logger never started ({card})"
    many = {s: sorted(v) for s, v in streams.items() if len(v) > 1}
    assert not many, (f"one power-on should open one file per stream, but the card holds "
                      f"{len(card)} files: " + ", ".join(f"{s}: {len(v)} files"
                                                      for s, v in many.items()))
