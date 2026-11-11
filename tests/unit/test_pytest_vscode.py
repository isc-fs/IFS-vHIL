"""vhil/pytest_vscode.py: the JSON lines the VS Code extension reads, from a
pytest run of a small test file in its own directory."""
import json
import subprocess
import sys
import textwrap

from vhil.system import REPO

TESTS = textwrap.dedent('''
    import pytest

    @pytest.mark.can
    def test_passes():
        pass

    def test_fails():
        x = 1
        assert x == 2

    @pytest.mark.skip(reason="not today")
    def test_skipped():
        pass

    @pytest.fixture
    def broken():
        raise RuntimeError("setup broke")

    def test_setup_error(broken):
        pass

    @pytest.mark.parametrize("n", [1, 2])
    def test_param(n):
        pass
''')


def _run(tmp_path, *args):
    (tmp_path / "test_x.py").write_text(TESTS)
    (tmp_path / "pytest.ini").write_text("[pytest]\nmarkers =\n    can: a marker\n")
    out = tmp_path / "out" / "x.jsonl"
    subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider",
                    "-p", "vhil.pytest_vscode", "--vscode-out", str(out), *args],
                   cwd=tmp_path, env={"PYTHONPATH": str(REPO)}, capture_output=True, text=True)
    return [json.loads(line) for line in out.read_text().splitlines()]


def test_collection_lists_each_test_with_its_file_line_and_markers(tmp_path):
    items = {r["id"]: r for r in _run(tmp_path, "--collect-only") if r["kind"] == "item"}
    assert list(items) == ["test_x.py::test_passes", "test_x.py::test_fails",
                           "test_x.py::test_skipped", "test_x.py::test_setup_error",
                           "test_x.py::test_param[1]", "test_x.py::test_param[2]"]
    first = items["test_x.py::test_passes"]
    assert (first["file"], first["line"], first["name"]) == ("test_x.py", 4, "test_passes")  # its decorator
    assert "can" in first["markers"]
    assert "skip" in items["test_x.py::test_skipped"]["markers"]


def test_a_run_reports_each_test_as_it_starts_and_ends(tmp_path):
    records = _run(tmp_path)
    results = {r["id"]: r for r in records if r["kind"] == "result"}
    assert [r["kind"] for r in records[:2]] == ["start", "result"]
    assert records[-1] == {"kind": "done", "exitstatus": 1}
    assert results["test_x.py::test_passes"]["outcome"] == "passed"
    assert results["test_x.py::test_param[2]"]["outcome"] == "passed"
    failed = results["test_x.py::test_fails"]
    assert failed["outcome"] == "failed"
    assert (failed["file"], failed["line"]) == ("test_x.py", 10)
    assert "assert 1 == 2" in failed["message"]
    skipped = results["test_x.py::test_skipped"]
    assert skipped["outcome"] == "skipped" and "not today" in skipped["message"]
    # A failing fixture fails its test, with where it raised.
    broken = results["test_x.py::test_setup_error"]
    assert broken["outcome"] == "failed" and "setup broke" in broken["message"]
