"""The training puzzles' grading tests (training/README.md): run by the
Training page's check (a pytest run of the worker, vhil/server/training.py)
or by hand:

    python -m pytest training/tests --ams-elf AMS.elf --can-bootloader-elf CAN_BL.elf

Outside pytest.ini's testpaths, so the vHIL's own suite and CI never collect
them: a seeded fault is training-only. Images come from $VHIL_<X>_ELF (the
worker sets them from the run's firmware refs) or --<x>-elf; a test whose
image is missing is skipped.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from vhil.system import REPO, System

IMAGES = ("ecu", "ams", "udv", "can-bootloader")


def pytest_addoption(parser):
    g = parser.getgroup("vhil-training")
    for image in IMAGES:
        env = f"VHIL_{image.upper().replace('-', '_')}_ELF"
        try:
            g.addoption(f"--{image}-elf", default=os.environ.get(env))
        except ValueError:
            pass                        # tests/conftest.py's, when run together
    try:
        g.addoption("--sim-log-dir", default=None,
                    help="where a run's logs and records go (the worker's run directory)")
    except ValueError:
        pass


@pytest.fixture(scope="session")
def images(request):
    """images("ecu-ams") -> {board: elf, "<board>.bootloader": elf}."""
    def elf(image: str) -> Path:
        path = request.config.getoption(f"--{image}-elf")
        if not path or not Path(path).is_file():
            pytest.skip(f"no {image} image (--{image}-elf or "
                        f"VHIL_{image.upper().replace('-', '_')}_ELF)")
        return Path(path)

    def get(system: str) -> dict[str, Path]:
        fw = {}
        for b in System(REPO / "systems" / f"{system}.yaml").boards.values():
            fw[b.name] = elf(b.firmware["id"])
            if b.bootloader is not None:
                fw[f"{b.name}.bootloader"] = elf(b.bootloader["id"])
        return fw
    return get


@pytest.fixture
def out_dir(request, tmp_path) -> Path:
    """Where a test leaves what the Training page shows (the run's artifacts)."""
    d = request.config.getoption("--sim-log-dir")
    path = Path(d) if d else tmp_path
    path.mkdir(parents=True, exist_ok=True)
    return path
