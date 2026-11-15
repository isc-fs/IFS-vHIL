"""Training-only firmware: a puzzle's seeded bug built into its pinned commit
(training/README.md).

A firmware puzzle names a patch under training/patches/ (`seed:` in its
scenario file). The trainee's car runs the pinned commit with that patch
applied, and their repair is the seeded files as they edited them on the
Training page. Both are built here, with the catalogue's own recipe, from a
copy of the pinned source (System.build_firmware's local-tree build).

This is the one place the vHIL builds firmware that is not a commit of the
team's repos, and it is only ever reached from a training run: the gate,
CI and every other run build commits only (invariant 1). A seeded image
lives under <fw-dir>/training/, apart from the commit builds, and is named
by what went into it (commit, recipe, patch, edits), so a rebuild of the
same inputs is reused.

    python -m vhil.training_fw build <puzzle> [--fw-dir DIR]    # the seeded ELF
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Callable, Optional

from vhil.system import COMMIT, REPO, System, local_source_dir, recipe_id

# A trainee's edit replaces one of the files the patch touches, at most this big.
MAX_EDIT_BYTES = 256 * 1024
PATCH_FILE = re.compile(r"^\+\+\+ b/(\S+)$", re.M)


def patch_files(patch: str) -> list[str]:
    """The files a patch changes: what the trainee may edit."""
    return sorted(set(PATCH_FILE.findall(patch)))


def check_edits(patch: str, edits: Optional[dict]) -> list[str]:
    """What is wrong with a trainee's edits: only the patch's files, as text."""
    allowed, errors = set(patch_files(patch)), []
    for path, text in (edits or {}).items():
        if path not in allowed:
            errors.append(f"{path}: not a file of this puzzle (editable: {', '.join(sorted(allowed))})")
        elif not isinstance(text, str) or len(text.encode()) > MAX_EDIT_BYTES:
            errors.append(f"{path}: text, at most {MAX_EDIT_BYTES // 1024} KiB")
    return errors


def _key(fw: dict, commit: str, patch: str, edits: dict) -> str:
    ident = {"commit": commit, "recipe": recipe_id(fw), "patch": patch,
             "edits": {k: edits[k] for k in sorted(edits)}}
    return hashlib.sha256(json.dumps(ident, sort_keys=True).encode()).hexdigest()[:16]


def _git(*args, cwd: Optional[Path] = None) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, stdout=sys.stderr)


def seeded_image(fw_dir: Path, system: System, image: str, commit: str, patch: str,
                 edits: Optional[dict] = None, log: Callable[[str], None] = print,
                 source_out: Optional[Path] = None) -> Path:
    """The ELF of `image` at `commit` with `patch` applied and `edits` (path ->
    text, the patch's files only) written over it, built with the recipe.
    With `source_out`, the patch's files as built are copied there (what the
    Training page shows the trainee to edit)."""
    edits = dict(edits or {})
    errors = check_edits(patch, edits)
    if errors:
        raise ValueError("; ".join(errors))
    if not COMMIT.fullmatch(commit or ""):
        raise ValueError(f"{image}: a seeded build needs the pinned commit, got {commit!r}")
    board = system.boards[image.split(".")[0]]
    fw = board.bootloader if image.endswith(".bootloader") else board.firmware
    if fw is None:
        raise ValueError(f"{image}: no catalogue firmware")
    fw_dir = Path(fw_dir)
    work = fw_dir / "training" / f"{fw['id']}+{commit[:12]}.{_key(fw, commit, patch, edits)}"
    elf = local_source_dir(work, fw) / fw["build"]["elf"]
    tree = work / "tree"
    work.parent.mkdir(parents=True, exist_ok=True)
    with open(fw_dir / ".build.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if elf.is_file() and tree.is_dir():
            log(f"[{image}] seeded image {work.name}: built before, reused")
        else:
            log(f"[{image}] seeded image: {fw['repo']}@{commit[:12]} + training patch"
                + (f" + your edits to {', '.join(sorted(edits))}" if edits else ""))
            try:
                if tree.exists():
                    shutil.rmtree(work)
                _git("init", "-q", str(tree))
                _git("-C", str(tree), "fetch", "-q", "--depth", "1",
                     f"https://github.com/{fw['repo']}", commit)
                _git("-C", str(tree), "checkout", "-q", "FETCH_HEAD")
                if fw.get("submodules"):
                    _git("-C", str(tree), "submodule", "update", "-q", "--init", "--recursive",
                         "--depth", "1")
                subprocess.run(["git", "-C", str(tree), "apply", "-"], input=patch.encode(),
                               check=True)
                for path, text in edits.items():
                    (tree / path).write_text(text)
                built = system.build_firmware(work, sources={fw["id"]: tree}, only=[image],
                                              only_local=True, log=log)
            except BaseException:
                shutil.rmtree(work, ignore_errors=True)     # never a half-built image
                raise
            if Path(built[image]).resolve() != elf.resolve() or not elf.is_file():
                raise RuntimeError(f"{image}: the seeded build gave no image at {elf}")
    if source_out is not None:
        for path in patch_files(patch):
            out = Path(source_out) / path
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text((tree / path).read_text())
    return elf


def main(argv=None) -> int:
    from vhil import training
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="build a firmware puzzle's seeded image (prints its ELF)")
    b.add_argument("puzzle")
    b.add_argument("--fw-dir", default="/vhil/training-fw")
    a = p.parse_args(argv)
    puzzle = training.puzzles()[a.puzzle]
    if puzzle.seed is None:
        p.error(f"{a.puzzle} seeds no firmware")
    system = System(REPO / "systems" / f"{puzzle.system}.yaml")
    elf = seeded_image(Path(a.fw_dir), system, puzzle.seed.image,
                       puzzle.firmware[puzzle.seed.image], puzzle.seed.text(),
                       log=lambda m: print(m, file=sys.stderr))
    print(f"{puzzle.seed.image}={elf}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
