"""A finished run as one file, to share it (#373, Sprint 3; docs/sharing-runs.md).

    GET  /api/runs/{id}/bundle   the run as a .vhilrun file (an attachment)
    POST /api/runs/import        a .vhilrun as the request body -> {run_id}

    vhil export <id> [-o file|dir]    the same, headless (main(); bin/vhil,
    vhil import <file>                scripts/vhil-docker.sh export-run / import-run)

A bundle is a zip:

    run.json        {format, exported: {at, by, version, run}, run: the record}
    contract.json   the run's CAN contract (vhil/server/decode.py), made
                    where the firmware was built, so it decodes anywhere
    results/...     the run's directory: trace.jsonl, junit, logs, system/

An imported run is a new, finished row (RunStore.add_imported) with a new id
and token: read-only, never queued, marked `imported` with where it came
from, and left out of the Tests view's last results. Its trace's header is
written anew with that token (the exported one's is dropped: a token is
never served), so the API serves its trace and artifacts as any run's. Its
contract is the bundle's; the Debug tab's firmware sources are not carried.

A bundle comes from another machine: the reader takes only regular files
under results/ (no absolute paths, no `..`, no links), checks the format
version and the record's fields, and caps the file count and the unpacked
size, counted as it writes rather than as the zip claims.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from typing import IO, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from vhil.server.runs import (HEADER_KIND, TERMINAL, TRACE, RunStore, now_iso, owns_results,
                              trace_header)

FORMAT = 1
SUFFIX = ".vhilrun"
RUN_JSON, CONTRACT_JSON, RESULTS = "run.json", "contract.json", "results/"
# What an import accepts: the body as sent, the files and bytes unpacked.
MAX_BUNDLE_BYTES = int(os.environ.get("VHIL_IMPORT_MAX_MB", "1024")) * 2**20
MAX_UNPACKED_BYTES = 2 * MAX_BUNDLE_BYTES
MAX_FILES = 20_000
# The record's fields a bundle carries (never its token, worker or heartbeat).
FIELDS = ("id", "state", "system", "ref", "ref_name", "firmware", "firmware_commits", "scenario",
          "created", "started", "finished", "virtual_us", "summary", "owner", "attempts")
_SYSTEM = re.compile(r"^[A-Za-z0-9_.-]{1,64}\Z")
_TRACES = re.compile(r"^trace(\.attempt\d+)?\.jsonl\Z")
CHUNK = 1 << 20


class BundleError(ValueError):
    """Not a bundle this vHIL can import, and why."""


def _version() -> str:
    from vhil.server.app import _version as v
    return v()


# -- export ----------------------------------------------------------------------

def _copy_trace(src: Path, dst: IO[bytes]) -> None:
    """A trace without its header line (it carries the run's token)."""
    with open(src, "rb") as f:
        first = f.readline()
        try:
            header = json.loads(first).get("kind") == HEADER_KIND
        except (ValueError, AttributeError):
            header = False
        if not header:
            dst.write(first)
        shutil.copyfileobj(f, dst, CHUNK)


def export_bundle(run: dict, results: Path, contract: dict, out: Path | IO[bytes],
                  by: str = "") -> None:
    """Writes finished run `run` (its record), its results directory and
    `contract` as a bundle to `out`."""
    if run["state"] not in TERMINAL:
        raise BundleError(f"run {run['id']} is {run['state']}: export it once it has finished")
    root = Path(results) / str(run["id"])
    if not root.is_dir() or not owns_results(Path(results), run):
        raise BundleError(f"run {run['id']} has no results here")
    record = {k: run.get(k) for k in FIELDS}
    exported = {"at": now_iso(), "by": by, "version": _version(), "run": run["id"]}
    meta = {"format": FORMAT, "exported": exported, "run": record}
    if run.get("imported"):
        meta["imported"] = run["imported"]   # where it came from before
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as z:
        z.writestr(RUN_JSON, json.dumps(meta, indent=1))
        z.writestr(CONTRACT_JSON, json.dumps(contract))
        for path in sorted(root.rglob("*")):
            if path.is_symlink() or not path.is_file():
                continue
            rel = path.relative_to(root).as_posix()
            if rel == CONTRACT_JSON and run.get("imported"):
                continue                       # its contract is the top-level one
            info = zipfile.ZipInfo.from_file(path, RESULTS + rel)
            info.compress_type = zipfile.ZIP_DEFLATED
            with z.open(info, "w", force_zip64=True) as dst:
                if _TRACES.match(rel):
                    _copy_trace(path, dst)
                else:
                    with open(path, "rb") as src:
                        shutil.copyfileobj(src, dst, CHUNK)


# -- import ----------------------------------------------------------------------

def _member(info: zipfile.ZipInfo) -> Optional[str]:
    """The path under results/ a member is written to; None for run.json,
    contract.json and directories. Raises BundleError for anything else."""
    name = info.filename
    if name in (RUN_JSON, CONTRACT_JSON) or (info.is_dir() and name.startswith(RESULTS)):
        return None
    mode = info.external_attr >> 16
    if stat.S_ISLNK(mode):
        raise BundleError(f"{name}: a link")
    if not name.startswith(RESULTS) or "\\" in name:
        raise BundleError(f"{name}: not a file of the run")
    parts = PurePosixPath(name[len(RESULTS):]).parts
    if not parts or any(p in ("", ".", "..") for p in parts) or name.startswith("/"):
        raise BundleError(f"{name}: not a path inside the run")
    return "/".join(parts)


def _record(meta: object) -> dict:
    """run.json's record, checked."""
    if not isinstance(meta, dict):
        raise BundleError("run.json is not an object")
    fmt = meta.get("format")
    if not isinstance(fmt, int) or isinstance(fmt, bool):
        raise BundleError("run.json has no format version")
    if fmt > FORMAT:
        raise BundleError(f"bundle format {fmt} is newer than this vHIL reads ({FORMAT}): "
                          "update the vHIL")
    if fmt < 1:
        raise BundleError(f"bad bundle format {fmt}")
    run = meta.get("run")
    if not isinstance(run, dict):
        raise BundleError("run.json has no run")
    if run.get("state") not in TERMINAL:
        raise BundleError(f"the run is {run.get('state')!r}, not finished")
    if not isinstance(run.get("system"), str) or not _SYSTEM.match(run["system"]):
        raise BundleError(f"bad system {run.get('system')!r}")
    for key in ("firmware", "firmware_commits", "scenario", "summary"):
        if run.get(key) is not None and not isinstance(run[key], dict):
            raise BundleError(f"run.{key} is not an object")
    for key in ("ref", "ref_name", "owner", "created", "started", "finished"):
        if run.get(key) is not None and not isinstance(run[key], str):
            raise BundleError(f"run.{key} is not a string")
    for key in ("id", "virtual_us", "attempts"):
        v = run.get(key)
        if v is not None and (not isinstance(v, int) or isinstance(v, bool) or v < 0):
            raise BundleError(f"run.{key} is not a count")
    return run


def _origin(meta: dict, run: dict) -> dict:
    """Where an imported run came from: the run it was exported as (and,
    for a bundle of an imported run, where that one came from)."""
    exported = meta.get("exported") if isinstance(meta.get("exported"), dict) else {}
    keep = lambda d, keys: {k: d[k] for k in keys if isinstance(d.get(k), (str, int))}  # noqa: E731
    out = {"run": run.get("id"), "owner": run.get("owner") or "",
           "ref": run.get("ref") or "", "ref_name": run.get("ref_name") or "",
           "exported": keep(exported, ("at", "by", "version"))}
    if isinstance(meta.get("imported"), dict):
        out["via"] = meta["imported"].get("from")
    return out


def _unpack(z: zipfile.ZipFile, dest: Path) -> None:
    infos = z.infolist()
    if len(infos) > MAX_FILES:
        raise BundleError(f"{len(infos)} files: over the limit of {MAX_FILES}")
    total = 0
    for info in infos:
        rel = _member(info)
        if rel is None:
            continue
        path = dest / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        with z.open(info) as src, open(path, "xb") as dst:
            while chunk := src.read(CHUNK):
                total += len(chunk)
                if total > MAX_UNPACKED_BYTES:
                    raise BundleError(f"over {MAX_UNPACKED_BYTES >> 20} MiB unpacked")
                dst.write(chunk)


def import_bundle(store: RunStore, results: Path, src: Path | IO[bytes], by: str = "") -> dict:
    """Adds the bundle `src` as a new finished run; returns its record."""
    results = Path(results)
    results.mkdir(parents=True, exist_ok=True)
    try:
        z = zipfile.ZipFile(src)
    except (zipfile.BadZipFile, OSError) as e:
        raise BundleError(f"not a {SUFFIX} file: {e}") from None
    tmp = Path(tempfile.mkdtemp(prefix=".import-", dir=results))
    row = None
    try:
        with z:
            names = set(z.namelist())
            if RUN_JSON not in names:
                raise BundleError(f"not a {SUFFIX} file: no {RUN_JSON}")
            try:
                meta = json.loads(z.read(RUN_JSON))
                contract = json.loads(z.read(CONTRACT_JSON)) if CONTRACT_JSON in names else {}
            except (ValueError, zipfile.BadZipFile) as e:
                raise BundleError(f"unreadable {RUN_JSON} or {CONTRACT_JSON}: {e}") from None
            run = _record(meta)
            if not isinstance(contract, dict):
                raise BundleError(f"{CONTRACT_JSON} is not an object")
            try:
                _unpack(z, tmp)
            except (zipfile.BadZipFile, OSError) as e:
                raise BundleError(f"unreadable bundle: {e}") from None
        (tmp / CONTRACT_JSON).write_text(json.dumps(contract))
        imported = {"at": now_iso(), "by": by, "from": _origin(meta, run)}
        row = store.add_imported(run, imported)
        # The trace's header, with this run's new token.
        trace = tmp / TRACE
        body = trace.read_bytes() if trace.is_file() else b""
        with open(trace, "wb") as f:
            f.write(json.dumps(trace_header(row)).encode() + b"\n")
            f.write(body)
        dest = results / str(row["id"])
        if dest.exists():
            from vhil.worker import set_aside
            set_aside(dest)    # a database restored to a snapshot reuses ids
        tmp.rename(dest)
        return row
    except BaseException:
        if row is not None:
            store.delete(row["id"])
        shutil.rmtree(tmp, ignore_errors=True)
        raise


def contract_of(run: dict, results: Path, workspace: Path, fw_dir: Path) -> dict:
    """A run's CAN contract: an imported run's is its bundle's."""
    if run.get("imported"):
        path = Path(results) / str(run["id"]) / CONTRACT_JSON
        if owns_results(Path(results), run) and path.is_file():
            return json.loads(path.read_text())
        return {"buses": {}, "boards": {}, "conflicts": [], "state": {}, "labels": {},
                "inputs": {}, "plants": {}, "error": "the imported run carries no contract"}
    from vhil.server.decode import run_contract
    try:
        return run_contract(run, workspace, fw_dir)
    except Exception as e:  # the bundle still carries the trace; the viewer replays it raw
        return {"buses": {}, "boards": {}, "conflicts": [], "state": {}, "labels": {},
                "inputs": {}, "plants": {}, "error": f"no contract: {e}"}


def bundle_name(run: dict) -> str:
    return f"run-{run['id']}-{run['system']}{SUFFIX}"


# -- the API ---------------------------------------------------------------------

def router(settings, workspace, fw_dir: Optional[Path] = None):
    from vhil.worker import DEFAULT_FW_DIR

    store = RunStore(settings.db)
    results = Path(settings.results)
    fw = Path(fw_dir or DEFAULT_FW_DIR)
    r = APIRouter(prefix="/api/runs", tags=["runs"])

    def login(request: Request) -> str:
        return (getattr(request.state, "user", None) or {}).get("login") or ""

    @r.get("/{run_id}/bundle")
    def bundle(run_id: int, request: Request):
        run = store.get(run_id)
        if run is None:
            raise HTTPException(404, f"no run {run_id}")
        if run["state"] not in TERMINAL:
            raise HTTPException(409, f"run {run_id} is {run['state']}: export it once it has finished")
        here = Path(getattr(request.app.state, "fw_dir", None) or fw)
        fd, tmp = tempfile.mkstemp(prefix=".export-", suffix=SUFFIX, dir=results)
        os.close(fd)
        try:
            export_bundle(run, results, contract_of(run, results, workspace.root, here),
                          Path(tmp), by=login(request))
        except BundleError as e:
            os.unlink(tmp)
            raise HTTPException(409, str(e))
        except BaseException:
            os.unlink(tmp)
            raise
        return FileResponse(tmp, media_type="application/zip", filename=bundle_name(run),
                            content_disposition_type="attachment",
                            background=BackgroundTask(os.unlink, tmp))

    @r.post("/import", status_code=201)
    async def import_(request: Request):
        size = int(request.headers.get("content-length") or 0)
        if size > MAX_BUNDLE_BYTES:
            raise HTTPException(413, f"over the import limit of {MAX_BUNDLE_BYTES >> 20} MiB")
        results.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryFile(dir=results) as f:
            got = 0
            async for chunk in request.stream():
                got += len(chunk)
                if got > MAX_BUNDLE_BYTES:
                    raise HTTPException(413, f"over the import limit of {MAX_BUNDLE_BYTES >> 20} MiB")
                f.write(chunk)
            f.seek(0)
            try:
                row = await asyncio.to_thread(import_bundle, store, results, f, login(request))
            except BundleError as e:
                raise HTTPException(422, str(e))
        return {"run_id": row["id"]}

    return r


# -- headless ----------------------------------------------------------------------

def main(argv: Optional[list[str]] = None) -> int:
    from vhil.server.config import Settings
    from vhil.worker import DEFAULT_FW_DIR

    p = argparse.ArgumentParser(prog="python -m vhil.server.bundle",
                                description="Export or import a finished run as a .vhilrun file.")
    sub = p.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export", help="a run as a .vhilrun file")
    e.add_argument("run_id", type=int)
    e.add_argument("-o", "--output", type=Path,
                   help="a file, or a directory for run-<id>-<system>.vhilrun (default: here)")
    i = sub.add_parser("import", help="a .vhilrun file as a new run")
    i.add_argument("file", type=Path)
    args = p.parse_args(argv)
    settings = Settings.from_env()
    store = RunStore(settings.db)
    who = os.environ.get("USER", "")
    try:
        if args.cmd == "export":
            run = store.get(args.run_id)
            if run is None:
                raise BundleError(f"no run {args.run_id}")
            out = args.output or Path()
            if out.is_dir():
                out = out / bundle_name(run)
            contract = contract_of(run, settings.results, settings.workspace, DEFAULT_FW_DIR)
            tmp = out.with_name(f".{out.name}.{uuid.uuid4().hex[:8]}")
            try:
                export_bundle(run, settings.results, contract, tmp, by=who)
                tmp.replace(out)
            finally:
                tmp.unlink(missing_ok=True)
            print(out)
        else:
            with open(args.file, "rb") as f:
                row = import_bundle(store, settings.results, f, by=who)
            print(f"run {row['id']} ({row['system']}, {row['state']}): imported")
    except (BundleError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
