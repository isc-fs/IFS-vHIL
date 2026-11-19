"""The training puzzles' format and grading rules (vhil/training.py,
training/README.md), without Renode: every committed puzzle loads, a
location matches only the answer's part and position, and the runs a
puzzle asks for are runs the API accepts."""
import pytest

from vhil import training as tr


def test_every_committed_puzzle_loads_and_names_its_tests():
    puzzles = tr.puzzles()
    assert puzzles, "no puzzle in training/scenarios"
    for p in puzzles.values():
        assert not p.check(), p.id
        assert tr.PARTS[p.answer.part]
        assert not tr.check_location({"part": p.answer.part, **p.answer.fields()}), p.id


def _ntc():
    return tr.Answer(part="ams.ntc", module=3, slot=7)


@pytest.mark.parametrize("location, ok", [
    ({"part": "ams.ntc", "module": 3, "slot": 7}, True),
    ({"part": "ams.ntc", "module": "3", "slot": "7"}, True),
    ({"part": "ams.ntc", "module": 3, "slot": 8}, False),       # the right module, wrong slot
    ({"part": "ams.ntc", "module": 3}, False),                  # no slot: not a location
    ({"part": "ams.cell_tap", "module": 3, "cell": 7}, False),  # the wrong part
    ("module 3", False),
])
def test_a_location_must_name_the_part_and_its_position(location, ok):
    assert tr.matches(_ntc(), location) is ok


def test_a_firmware_answer_matches_board_and_module_loosely():
    a = tr.Answer(part="firmware", board="ams", module="sd_logger")
    assert tr.matches(a, {"part": "firmware", "board": "AMS", "module": "SD logger"})
    assert not tr.matches(a, {"part": "firmware", "board": "ecu", "module": "sd_logger"})


def test_a_location_s_shape_is_checked_before_it_is_judged():
    assert tr.check_location({"part": "ams.ntc", "module": 9, "slot": 7}) == ["module: 0..4"]
    assert tr.check_location({"part": "nope"})
    assert tr.check_location({"part": "firmware", "board": "ams", "module": "sd_logger"}) == []


def test_the_car_seeds_the_faults_and_the_check_runs_without_them():
    from vhil.server.runs import RunRequest
    p = tr.puzzles()["open-ntc-opens-the-sdc"]
    car = RunRequest.model_validate(p.car_run())
    assert car.firmware == p.firmware
    names = [s.name for s in car.scenario.stimuli]
    assert "ntc-breaks" in names and car.scenario.expect == []
    checks = [RunRequest.model_validate(x) for x in p.check_run()]
    assert [c.scenario.select for c in checks] == p.solved
    assert all(c.firmware == p.firmware for c in checks)


def test_a_firmware_fix_is_checked_on_the_trainee_s_ref():
    p = tr.Puzzle.model_validate({
        "kind": "training", "id": "x", "title": "t", "summary": "s", "fault": "firmware",
        "system": "ecu-ams", "firmware": {"ecu": "a" * 40}, "brief": "b", "mode": "run",
        "drive": {"virtual_ms": 1000}, "hints": ["h"],
        "answer": {"part": "firmware", "board": "ecu", "module": "can_tx_heartbeat"},
        "solved": ["training/tests/test_puzzles.py::test_solved[x]"]})
    assert not p.check()
    with pytest.raises(ValueError):
        p.check_run(None)
    (run,) = p.check_run("fix/heartbeat")
    assert run["firmware"] == {"ecu": "fix/heartbeat"}


def test_solved_only_shows_the_answer():
    p = tr.puzzles()["open-ntc-opens-the-sdc"]
    assert "answer" not in p.public(hints_shown=3)
    assert p.public(hints_shown=1)["hints"] == p.hints[:1]
    assert p.public(solved=True)["answer"]["slot"] == 7


def test_progress_counts_attempts(tmp_path):
    store = tr.Progress(tmp_path / "training.json")
    store.update("Ana", "p", lambda e: tr.attempt(e, {"part": "ams.ntc"}, False))
    e = store.update("ana", "p", lambda e: tr.attempt(e, {"part": "ams.ntc"}, True))
    assert e["located"] and len(e["attempts"]) == 2
    assert store.get("someone-else", "p")["attempts"] == []


# -- the API (vhil/server/training.py) ------------------------------------------------

@pytest.fixture
def client(tmp_path, monkeypatch):
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from vhil.server import create_app, runs
    from vhil.server.config import Settings
    from vhil.system import REPO
    # No network: a run's firmware refs are full commits already.
    monkeypatch.setattr(runs, "firmware_commits", lambda request, system, refs: {})
    settings = Settings(workspace=REPO, db=tmp_path / "vhil.db", results=tmp_path / "runs",
                        auth="dev")
    return TestClient(create_app(settings))


def test_a_repair_is_refused_until_the_fault_is_located(client):
    pid = "open-ntc-opens-the-sdc"
    listed = client.get("/api/training/puzzles").json()
    assert pid in [p["id"] for p in listed] and all("answer" not in p for p in listed)
    assert client.post(f"/api/training/puzzles/{pid}/start").status_code == 201
    assert client.post(f"/api/training/puzzles/{pid}/check", json={}).status_code == 409
    bad = client.post(f"/api/training/puzzles/{pid}/diagnose",
                      json={"location": {"part": "ams.ntc", "module": 3, "slot": 8}}).json()
    assert bad["correct"] is False
    assert client.post(f"/api/training/puzzles/{pid}/diagnose",
                       json={"location": {"part": "ams.ntc", "module": 9}}).status_code == 422
    good = client.post(f"/api/training/puzzles/{pid}/diagnose",
                       json={"location": {"part": "ams.ntc", "module": 3, "slot": 7}}).json()
    assert good == {**good, "correct": True, "attempts": 2, "wrong_attempts": 1}
    ids = client.post(f"/api/training/puzzles/{pid}/check", json={}).json()["run_ids"]
    run = client.get(f"/api/runs/{ids[0]}").json()
    assert run["scenario"]["select"].startswith("training/tests/test_puzzles.py::test_solved")
    one = client.get(f"/api/training/puzzles/{pid}").json()
    assert one["progress"]["located"] and not one["progress"]["solved"]
    assert "answer" not in one["puzzle"]


def test_signals_trace_a_pin_to_the_backplane(client):
    sig = {(s["board"], s["pin"]): s for s in client.get("/api/training/systems/ecu-ams/signals").json()}
    ok = sig[("ams", "PB4")]
    assert (ok["signal"], ok["net"], ok["module_pins"], ok["connector"]) == \
        ("AMS_OK", "GPIO1", ["J3.6"], "J1.4")


# -- a seeded firmware puzzle (vhil/training_fw.py) ---------------------------------

SEEDED = "ams-trips-at-power-on"


def test_a_seeded_puzzle_names_its_patch_and_its_editable_files():
    from vhil import training_fw
    p = tr.puzzles()[SEEDED]
    seed = p.seed_run()
    assert seed["image"] == "ams" and seed["edits"] == {} and seed["puzzle"] == SEEDED
    assert training_fw.patch_files(seed["patch"]) == ["Core/Inc/app/ams_config.hpp"]
    assert p.public()["seeded"] == "ams" and "seed" not in p.public()
    # Its check runs the pinned commits: the fix is in the edits, not a ref.
    assert [r["firmware"] for r in p.check_run()] == [p.firmware]


def test_a_trainee_edits_only_the_seeded_files():
    from vhil import training_fw
    patch = tr.puzzles()[SEEDED].seed.text()
    assert training_fw.check_edits(patch, {"Core/Inc/app/ams_config.hpp": "x"}) == []
    assert training_fw.check_edits(patch, {"Core/Src/main.cpp": "x"})
    assert training_fw.check_edits(patch, {"../../etc/passwd": "x"})
    big = "x" * (training_fw.MAX_EDIT_BYTES + 1)
    assert training_fw.check_edits(patch, {"Core/Inc/app/ams_config.hpp": big})


def test_a_seed_must_be_a_firmware_fault_on_a_pinned_image():
    doc = tr.puzzles()[SEEDED].model_dump()
    doc["seed"]["image"] = "ecu"
    assert any("answer's board" in e or "pinned" in e for e in tr.Puzzle.model_validate(doc).check())
    with pytest.raises(ValueError):
        tr.Seed(image="ams", patch="../secret.patch")


def test_a_seeded_car_and_its_check_carry_the_seed(client):
    assert client.post(f"/api/training/puzzles/{SEEDED}/start").status_code == 201
    car = client.get(f"/api/training/puzzles/{SEEDED}").json()["progress"]["car_run"]
    from vhil.server.runs import RunStore
    store = RunStore(client.app.state.settings.db)
    assert store.get(car)["seed"]["image"] == "ams" and store.get(car)["seed"]["edits"] == {}
    assert client.post(f"/api/training/puzzles/{SEEDED}/diagnose", json={"location": {
        "part": "firmware", "board": "ams", "module": "config"}}).json()["correct"]
    path = "Core/Inc/app/ams_config.hpp"
    assert client.post(f"/api/training/puzzles/{SEEDED}/check", json={}).status_code == 422
    assert client.post(f"/api/training/puzzles/{SEEDED}/check",
                       json={"edits": {"Core/Src/main.cpp": "x"}}).status_code == 422
    ids = client.post(f"/api/training/puzzles/{SEEDED}/check",
                      json={"edits": {path: "fixed"}}).json()["run_ids"]
    assert ids and all(store.get(i)["seed"]["edits"] == {path: "fixed"} for i in ids)
    # An ordinary run never has one.
    assert client.post("/api/runs", json={"system": "ecu-ams", "scenario": {
        "kind": "run", "virtual_ms": 100}}).status_code in (201, 200)
    assert all(not r["seed"] for r in store.list() if r["id"] not in [car, *ids])
