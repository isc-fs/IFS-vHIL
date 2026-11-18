"""vhil/testtrace.py: the decoder, the trace files and the failure record,
against a fake Sim (no Renode)."""
import json
import types

from vhil import sim as vsim, testtrace

from tests.unit.test_elf import _elf

CONTRACT = {"can_acu": {"256": {
    "name": "VCU_State", "id": 256, "sender": "VCU", "board": "ecu", "dlc": 4,
    "fields": [
        {"name": "state", "be": False, "signed": False, "start": 0, "length": 8,
         "factor": 1, "offset": 0, "values": {"3": "Drive"}},
        {"name": "temp", "be": False, "signed": True, "start": 8, "length": 8,
         "factor": 0.5, "offset": 10},
    ]}}}


def test_decoder_gives_names_signals_and_labels():
    d = testtrace.Decoder(CONTRACT)
    out = d.decode("can_acu", 0x100, bytes([3, 0xFE]))
    assert out["name"] == "VCU_State" and out["sender"] == "VCU" and out["board"] == "ecu"
    assert out["signals"] == {"state": 3, "temp": 9.0}
    assert out["labels"] == {"state": "Drive"}
    assert d.decode("can_acu", 0x101, b"") == {}
    assert d.decode("other", 0x100, b"") == {}
    assert d.decoded() == ["can_acu"]


def test_decoder_skips_a_field_a_short_frame_lacks():
    assert testtrace.Decoder(CONTRACT).decode("can_acu", 0x100, bytes([3]))["signals"] == {"state": 3}


def _rec(t, id=0x100, ext=False, data=b"\x03\x00", outcome="ok", bus="can_acu", sim="s"):
    return testtrace.can_record(sim, bus, testtrace.Decoder(CONTRACT), t_us=t, end_us=t + 100,
                                node="ecu.FDCAN2", can_id=id, ext=ext, remote=False,
                                dlc=len(data), data=data, outcome=outcome)


def test_can_record_shape():
    r = _rec(12_345_678)
    assert set(r) >= {"kind", "t_us", "end_us", "sim", "bus", "node", "id", "ext", "remote",
                      "dlc", "data", "outcome", "name", "sender", "board", "signals"}
    assert r["kind"] == "can" and r["data"] == "0300"


def test_candump_lines_and_only_good_frames():
    recs = [_rec(2_000_000, id=0x1ABCDE, ext=True, data=b"\xde\xad"), _rec(12_345_678),
            _rec(5, outcome="ack")]
    assert testtrace.candump_line(recs[1]) == "(12.345678) can_acu 100#0300"
    assert testtrace.candump(recs) == "(2.000000) can_acu 001ABCDE#DEAD\n(12.345678) can_acu 100#0300\n"


def test_bus_tail_is_the_last_frames_before_the_failure():
    recs = [_rec(t) for t in range(0, 100, 10)]
    tail = testtrace.bus_tail(recs, until_us=65, n=3)
    assert [r["t_us"] for r in tail] == [40, 50, 60]
    assert set(tail[0]) == {"t_us", "bus", "id", "data", "name", "sender", "signals"}


def test_write_gives_a_jsonl_and_a_log(tmp_path):
    recs = [{"kind": "meta", "version": 1}, _rec(1_000_000)]
    path = testtrace.write(tmp_path / "t", "tests/sim/test_a.py::test_x[1]", recs)
    assert path.name == "tests_sim_test_a.py_test_x_1.trace.jsonl"
    assert testtrace.read(path) == recs
    assert path.with_name(path.name.replace(".trace.jsonl", ".log")).read_text() \
        == "(1.000000) can_acu 100#0300\n"


def test_resolve_frames_names_pc_and_lr_with_lines(tmp_path):
    img = _elf(tmp_path / "a.elf", [("main", 0x08020101, 0x40, 2), ("Fault", 0x08020201, 0x40, 2)])
    seen = []

    def lines(image, addrs):
        seen.append(addrs[0])
        return [("/vhil/fw/x/main.c", 10 + len(seen))]
    frames = testtrace.resolve_frames([img], {"PC": 0x08020210, "LR": 0x08020121}, lines)
    assert [f["symbol"] for f in frames] == ["Fault", "main"]
    assert frames[0] == {"symbol": "Fault", "file": "/vhil/fw/x/main.c", "line": 11,
                         "address": "0x08020210"}
    assert seen == [0x08020210, 0x0802011E]       # LR looked up inside the call
    assert testtrace.resolve_frames([img], {"PC": 0x10}, lines) == []
    none = testtrace.resolve_frames([img], {"PC": 0x08020110}, lambda i, a: [None])
    assert none[0]["file"] is None and none[0]["line"] is None


class _Bus:
    arbitrated = True

    def timeline(self, since):
        return [vsim.BusFrame(1_000_000, 1_100_000, 1_120_000, 1_000_000, "ecu.FDCAN2", 0x100,
                              False, False, 2, "ok", b"\x03\x00")]


class _Io:
    def edges(self, since_us=0):
        return [vsim.Edge(500, "sysbus.gpioPortB:6", True)]


def _fake(tmp_path):
    uart = tmp_path / "ecu.USART3.txt"
    uart.write_text("boot\nready\n")
    system = types.SimpleNamespace(id="ecu", boards={"ecu": 1}, buses={"can_acu": {"kind": "can"}},
                                   radios=lambda: [])
    return types.SimpleNamespace(system=system, uart_logs={"ecu.USART3": uart}, can=lambda b: _Bus(),
                                 io=lambda b: _Io(), now_us=lambda: 2_000, last_activity=5,
                                 firmware={})


def test_collect_reads_every_source_and_advances_the_cursor(tmp_path, monkeypatch):
    monkeypatch.setattr(testtrace, "decoder_of", lambda sim: testtrace.Decoder(CONTRACT))
    sim, cursor = _fake(tmp_path), testtrace.Cursor()
    recs, end = testtrace.collect(sim, "ecu", cursor)
    kinds = [r["kind"] for r in recs]
    assert end == 2_000 and kinds.count("can") == 1 and kinds.count("uart") == 2 \
        and kinds.count("gpio") == 1 and "error" not in kinds
    assert [r["line"] for r in recs if r["kind"] == "uart"] == ["boot", "ready"]
    assert next(r for r in recs if r["kind"] == "can")["name"] == "VCU_State"
    again, _ = testtrace.collect(sim, "ecu", cursor)
    assert [r for r in again if r["kind"] == "uart"] == []


def test_a_failing_step_becomes_an_error_record(tmp_path, monkeypatch):
    monkeypatch.setattr(testtrace, "decoder_of", lambda sim: testtrace.Decoder())
    sim = _fake(tmp_path)
    sim.io = lambda b: (_ for _ in ()).throw(RuntimeError("renode gone"))
    recs, _ = testtrace.collect(sim, "ecu", testtrace.Cursor())
    err = [r for r in recs if r["kind"] == "error"]
    assert err and err[0]["what"] == "gpio ecu" and "renode gone" in err[0]["message"]


def test_snapshot_record_carries_frames_and_bus_tail(tmp_path):
    from vhil.snapshot import BoardSnapshot
    img = _elf(tmp_path / "a.elf", [("Fault", 0x08020201, 0x40, 2)])
    snap = BoardSnapshot("ecu", [img], time_us=100, registers={"PC": 0x08020210, "CPSR": 3},
                         faults={"CFSR": 0x8200, "HFSR": 0x40000000}, current_task="CanTask")
    rec = testtrace.snapshot_record("s", snap, [_rec(50), _rec(500)], lambda i, a: [("f.c", 7)])
    assert rec["kind"] == "snapshot" and rec["board"] == "ecu" and rec["task"] == "CanTask"
    assert rec["fault"] == {"CFSR": "0x00008200", "HFSR": "0x40000000"}
    assert rec["frames"][0]["line"] == 7
    assert [r["t_us"] for r in rec["bus_tail"]] == [50]
    json.dumps(rec)


def test_pytest_vscode_result_carries_trace_and_snapshots(tmp_path):
    from vhil import pytest_vscode
    w = pytest_vscode._Writer(tmp_path / "o.jsonl", tmp_path)
    w.outcome["t::a"] = {"outcome": "failed", "duration": 1.0}
    testtrace.RESULTS["t::a"] = {"trace": tmp_path / "traces" / "a.trace.jsonl",
                                 "snapshots": [{"kind": "snapshot", "sim": "s", "board": "ecu",
                                                "frames": [], "bus_tail": []}]}
    w.pytest_runtest_logfinish("t::a", None)
    w.file.close()
    lines = [json.loads(x) for x in (tmp_path / "o.jsonl").read_text().splitlines()]
    assert [x["kind"] for x in lines] == ["snapshot", "result"]
    assert lines[0]["id"] == "t::a"
    assert lines[1]["trace"] == "traces/a.trace.jsonl"


def test_a_fixture_sim_the_test_did_not_run_gets_the_time_before_it(tmp_path, monkeypatch):
    """A module fixture's Sim, asserted on as it stood: not an empty trace."""
    monkeypatch.setattr(testtrace, "decoder_of", lambda sim: testtrace.Decoder(CONTRACT))
    sim = _fake(tmp_path)
    sim.last_activity = 0                       # nothing ran during the test
    monkeypatch.setattr(vsim, "live_sims", lambda: [sim])
    monkeypatch.setattr(vsim, "activity", lambda: 10)
    plugin = testtrace.Plugin(tmp_path / "traces", tmp_path)
    item = types.SimpleNamespace(nodeid="t.py::b", funcargs={"ams": sim})
    plugin.pytest_runtest_setup(item)
    plugin.pytest_runtest_logfinish("t.py::b", None)
    recs = testtrace.read(testtrace.RESULTS.pop("t.py::b")["trace"])
    meta = recs[0]
    assert meta["sims"][0]["context_us"] == testtrace.CONTEXT_US
    assert [r["kind"] for r in recs[1:]] == ["can", "gpio"]   # no UART: bytes without times


def test_a_sim_the_test_neither_used_nor_ran_stays_out(tmp_path, monkeypatch):
    sim = _fake(tmp_path)
    sim.last_activity = 0
    monkeypatch.setattr(vsim, "live_sims", lambda: [sim])
    monkeypatch.setattr(vsim, "activity", lambda: 10)
    plugin = testtrace.Plugin(tmp_path / "traces", tmp_path)
    plugin.pytest_runtest_setup(types.SimpleNamespace(nodeid="t.py::c", funcargs={}))
    plugin.pytest_runtest_logfinish("t.py::c", None)
    assert "t.py::c" not in testtrace.RESULTS
