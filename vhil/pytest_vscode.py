"""A pytest plugin for the VS Code extension (vscode/): it writes what the
extension's Testing panel needs as JSON lines, paths relative to the repo.

    python -m pytest -p vhil.pytest_vscode --vscode-out results/vscode/x.jsonl ...

With --collect-only, one `item` line per test: its node id, file, line and
markers. Otherwise a `start` line when a test starts and a `result` line when
it ends (passed, failed, skipped), with its duration, its failure text and
where it failed. The file is appended and flushed line by line, so the
extension shows results while the run goes on. A line is one JSON object;
the extension skips a line it can't parse (the last one, mid-write)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest


def pytest_addoption(parser):
    parser.addoption("--vscode-out", default=None,
                     help="write the VS Code extension's JSON lines to this file")


class _Writer:
    def __init__(self, path: Path, root: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.file = path.open("a", encoding="utf-8")
        self.root = root
        # A test's outcome over its phases: a failing setup or teardown fails it.
        self.outcome: dict[str, dict] = {}

    def emit(self, **record):
        self.file.write(json.dumps(record) + "\n")
        self.file.flush()

    def rel(self, path) -> str | None:
        try:
            return Path(path).resolve().relative_to(self.root).as_posix()
        except (ValueError, OSError):
            return None

    # -- collection ----------------------------------------------------------

    def pytest_collection_finish(self, session):
        if not session.config.option.collectonly:
            return
        for item in session.items:
            path, line, _ = item.location
            self.emit(kind="item", id=item.nodeid, file=path, line=(line or 0) + 1,
                      name=item.name, markers=sorted({m.name for m in item.iter_markers()}))

    def pytest_collectreport(self, report):
        if report.failed:
            self.emit(kind="error", id=report.nodeid, message=str(report.longrepr))

    # -- running -------------------------------------------------------------

    def pytest_runtest_logstart(self, nodeid, location):
        self.outcome[nodeid] = {"outcome": "passed", "duration": 0.0}
        self.emit(kind="start", id=nodeid)

    def pytest_runtest_logreport(self, report):
        state = self.outcome.setdefault(report.nodeid, {"outcome": "passed", "duration": 0.0})
        state["duration"] += report.duration
        if report.failed:
            state["outcome"] = "failed"
            state["message"] = report.longreprtext
            crash = getattr(report.longrepr, "reprcrash", None)
            if crash is not None:
                state["file"], state["line"] = self.rel(crash.path), crash.lineno
                state["short"] = crash.message
        elif report.skipped and state["outcome"] == "passed":
            state["outcome"] = "skipped"
            longrepr = report.longrepr
            state["message"] = longrepr[2] if isinstance(longrepr, tuple) else str(longrepr)

    def pytest_runtest_logfinish(self, nodeid, location):
        state = self.outcome.pop(nodeid, {"outcome": "passed", "duration": 0.0})
        self.emit(kind="result", id=nodeid, **state)

    def pytest_sessionfinish(self, session, exitstatus):
        self.emit(kind="done", exitstatus=int(exitstatus))
        self.file.close()


@pytest.hookimpl(trylast=True)
def pytest_configure(config):
    out = config.getoption("--vscode-out")
    if out:
        config.pluginmanager.register(_Writer(Path(out), Path(config.rootpath).resolve()),
                                      "vscode-writer")
