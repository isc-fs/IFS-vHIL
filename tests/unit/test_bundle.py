"""vhil.server.bundle (#373, Sprint 3): a finished run exported as a .vhilrun
file and imported elsewhere as a new, read-only run."""
import io
import json
import stat
import zipfile

import pytest

fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from vhil.server import bundle, create_app  # noqa: E402
from vhil.server.bundle import BundleError, export_bundle, import_bundle  # noqa: E402
from vhil.server.config import Settings  # noqa: E402
from vhil.server.runs import RunStore, read_trace, trace_header  # noqa: E402
from vhil.system import REPO  # noqa: E402

RUN = {"kind": "run", "virtual_ms": 100, "name": "boot"}
RECORDS = [{"kind": "log", "t_us": 0, "text": "start"},
           {"kind": "frame", "t_us": 10_000, "bus": "can_acu", "id": 256, "ext": False, "data": "00"}]
CONTRACT = {"buses": {"can_acu": {"256": {"name": "X"}}}, "boards": {}, "conflicts": []}


def settings_at(path):
    return Settings(workspace=REPO, db=path / "vhil.db", results=path / "runs", auth="dev")


@pytest.fixture
def here(tmp_path):
    return settings_at(tmp_path / "here")


@pytest.fixture
def there(tmp_path):
    return settings_at(tmp_path / "there")


def finished_run(settings, state="failed", records=RECORDS) -> dict:
    """A run as the worker leaves it: its trace (with its header), junit and
    a system snapshot."""
    store = RunStore(settings.db)
    run_id = store.create("ecu", "abc123", {"ecu": "dev"}, RUN, ref_name="feat/x", owner="ana",
                          firmware_commits={"ecu": {"ref": "dev", "commit": "f" * 40}})
    store.claim("w1")
    store.finish(run_id, state, 100_000, {"expects": {"passed": 0, "failed": 1}})
    run = store.get(run_id)
    d = settings.results / str(run_id)
    (d / "system").mkdir(parents=True)
    (d / "system" / "ecu.yaml").write_text("id: ecu\n")
    (d / "junit.xml").write_text("<testsuite/>")
    with open(d / "trace.jsonl", "w") as f:
        f.write(json.dumps(trace_header(run)) + "\n")
        for rec in records:
            f.write(json.dumps(rec) + "\n")
    return run


def roundtrip(here, there) -> tuple[dict, dict, bytes]:
    run = finished_run(here)
    buf = io.BytesIO()
    export_bundle(run, here.results, CONTRACT, buf, by="ana")
    row = import_bundle(RunStore(there.db), there.results, io.BytesIO(buf.getvalue()), by="ben")
    return run, row, buf.getvalue()


def test_a_run_comes_back_whole_on_another_machine(here, there):
    run, row, _ = roundtrip(here, there)
    assert row["state"] == "failed" and row["system"] == "ecu" and row["scenario"] == RUN
    assert row["summary"] == run["summary"] and row["virtual_us"] == 100_000
    assert row["firmware_commits"] == run["firmware_commits"]
    assert row["token"] and row["token"] != run["token"]
    assert row["owner"] == "ben"
    # Where it came from; its refs are the exporter's, not this checkout's.
    assert row["ref"] == "" and row["ref_name"] == ""
    origin = row["imported"]["from"]
    assert origin["run"] == run["id"] and origin["owner"] == "ana" and origin["ref_name"] == "feat/x"
    assert origin["exported"]["by"] == "ana" and row["imported"]["by"] == "ben"
    d = there.results / str(row["id"])
    assert read_trace(d / "trace.jsonl", token=row["token"]) == RECORDS
    assert (d / "junit.xml").read_text() == "<testsuite/>"
    assert (d / "system" / "ecu.yaml").read_text() == "id: ecu\n"
    assert json.loads((d / "contract.json").read_text()) == CONTRACT


def test_the_token_never_leaves(here, there):
    run, _, data = roundtrip(here, there)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        everything = b"".join(z.read(n) for n in z.namelist())
    assert run["token"].encode() not in everything


def test_an_imported_run_is_served_and_read_only(here, there):
    _, row, _ = roundtrip(here, there)
    client = TestClient(create_app(there))
    run_id = row["id"]
    got = client.get(f"/api/runs/{run_id}").json()
    assert got["imported"]["from"]["owner"] == "ana" and got["can_cancel"] is False
    assert client.get(f"/api/runs/{run_id}/trace").json() == RECORDS
    assert client.get(f"/api/runs/{run_id}/contract").json() == CONTRACT
    assert "junit.xml" in client.get(f"/api/runs/{run_id}/artifacts").json()
    assert client.get(f"/api/runs/{run_id}/debug/source?board=ecu&path=main.c").status_code == 404
    # Not one of this machine's results in the Tests view.
    assert RunStore(there.db).last_by_scenario("ecu") == {}
    # Nothing to claim.
    assert RunStore(there.db).claim("w1") is None


def test_export_and_import_over_the_api(here, there):
    run = finished_run(here)
    a, b = TestClient(create_app(here)), TestClient(create_app(there))
    r = a.get(f"/api/runs/{run['id']}/bundle")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    assert f'run-{run["id"]}-ecu.vhilrun' in r.headers["content-disposition"]
    assert not list(here.results.glob(".export-*")), "the temp file is left behind"
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        first = json.loads(z.read("contract.json"))
    assert "buses" in first
    got = b.post("/api/runs/import", content=r.content)
    assert got.status_code == 201, got.text
    new = got.json()["run_id"]
    assert b.get(f"/api/runs/{new}/trace").json() == RECORDS
    # An imported run exports again, carrying where it came from.
    again = b.get(f"/api/runs/{new}/bundle")
    with zipfile.ZipFile(io.BytesIO(again.content)) as z:
        meta = json.loads(z.read("run.json"))
        assert json.loads(z.read("contract.json")) == first
        assert "results/contract.json" not in z.namelist()
    assert meta["imported"]["from"]["owner"] == "ana"


def test_an_unfinished_or_unknown_run_does_not_export(here):
    store = RunStore(here.db)
    queued = store.create("ecu", "", {}, RUN)
    client = TestClient(create_app(here))
    assert client.get(f"/api/runs/{queued}/bundle").status_code == 409
    assert client.get("/api/runs/999/bundle").status_code == 404


def bundle_of(files: dict, meta=None) -> bytes:
    """A bundle written by hand: {name: bytes or (bytes, unix mode)}."""
    meta = meta or {"format": 1, "run": {"state": "passed", "system": "ecu", "scenario": RUN}}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("run.json", json.dumps(meta))
        for name, data in files.items():
            mode = None
            if isinstance(data, tuple):
                data, mode = data
            info = zipfile.ZipInfo(name)
            if mode is not None:
                info.external_attr = mode << 16
            z.writestr(info, data)
    return buf.getvalue()


@pytest.mark.parametrize("files, why", [
    ({"results/../escape": b"x"}, "inside the run"),
    ({"/abs": b"x"}, "not a file of the run"),
    ({"results//etc/../../x": b"x"}, "inside the run"),
    ({"other/x": b"x"}, "not a file of the run"),
    ({"results/link": (b"/etc/passwd", stat.S_IFLNK | 0o777)}, "a link"),
    ({"results\\..\\x": b"x"}, "not a file of the run"),
])
def test_a_bundle_cannot_write_outside_its_run(there, tmp_path, files, why):
    with pytest.raises(BundleError, match=why):
        import_bundle(RunStore(there.db), there.results, io.BytesIO(bundle_of(files)))
    assert RunStore(there.db).list() == [], "a refused bundle left a run"
    assert not (tmp_path / "there" / "escape").exists()
    assert [p.name for p in there.results.iterdir()] == []


@pytest.mark.parametrize("meta, why", [
    ({"format": 2, "run": {}}, "newer than this vHIL"),
    ({"run": {}}, "no format"),
    ({"format": 1, "run": {"state": "running", "system": "ecu"}}, "not finished"),
    ({"format": 1, "run": {"state": "passed", "system": "../x"}}, "bad system"),
    ({"format": 1, "run": {"state": "passed", "system": "ecu", "summary": []}}, "summary"),
    ({"format": 1, "run": {"state": "passed", "system": "ecu", "virtual_us": -1}}, "virtual_us"),
])
def test_a_bad_record_is_refused(there, meta, why):
    with pytest.raises(BundleError, match=why):
        import_bundle(RunStore(there.db), there.results, io.BytesIO(bundle_of({}, meta)))


def test_not_a_bundle_is_refused(there):
    with pytest.raises(BundleError, match="not a .vhilrun"):
        import_bundle(RunStore(there.db), there.results, io.BytesIO(b"hello"))
    client = TestClient(create_app(there))
    r = client.post("/api/runs/import", content=b"hello")
    assert r.status_code == 422 and "not a .vhilrun" in r.json()["detail"]


def test_the_unpacked_size_is_capped_as_written(there, monkeypatch):
    monkeypatch.setattr(bundle, "MAX_UNPACKED_BYTES", 1000)
    with pytest.raises(BundleError, match="unpacked"):
        import_bundle(RunStore(there.db), there.results,
                      io.BytesIO(bundle_of({"results/big": b"0" * 5000})))
    assert RunStore(there.db).list() == []


def test_the_upload_is_capped(there, monkeypatch):
    monkeypatch.setattr(bundle, "MAX_BUNDLE_BYTES", 100)
    client = TestClient(create_app(there))
    assert client.post("/api/runs/import", content=b"0" * 500).status_code == 413


def test_the_cli_exports_and_imports(here, there, tmp_path, monkeypatch, capsys):
    run = finished_run(here)
    out = tmp_path / "shared.vhilrun"
    monkeypatch.setenv("VHIL_DB", str(here.db))
    monkeypatch.setenv("VHIL_RESULTS", str(here.results))
    assert bundle.main(["export", str(run["id"]), "-o", str(out)]) == 0
    assert out.is_file()
    monkeypatch.setenv("VHIL_DB", str(there.db))
    monkeypatch.setenv("VHIL_RESULTS", str(there.results))
    assert bundle.main(["import", str(out)]) == 0
    assert "imported" in capsys.readouterr().out
    assert len(RunStore(there.db).list()) == 1
    assert bundle.main(["export", "999"]) == 1
