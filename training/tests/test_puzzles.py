"""A run puzzle (training/scenarios/*.yaml, mode: run) is solved when its
drive cycle passes every expect of a healthy car (`drive.expect`):

  test_solved[<id>]          the drive on the images given (the trainee's fix
                             for a firmware fault), without the seeded
                             hardware faults (the repair). A puzzle's `solved`.
  test_fault_shows[<id>]     the drive with the faults, on the puzzle's own
                             images: some expect fails, so the puzzle has a
                             symptom (an author's check, never a trainee's).

Each runs as tests/scenarios does (vhil/worker.py execute_run on vhil.sim.Sim,
a real power-on through each board's bootloader), its expects checked
against the trace in virtual time (vhil/expect.py).
"""
from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from vhil import expect as vexpect  # noqa: E402
from vhil import training as tr  # noqa: E402
from vhil.server.decode import system_contract  # noqa: E402
from vhil.server.runs import Limits, RunScenario  # noqa: E402
from vhil.server.scenarios import check_rows  # noqa: E402
from vhil.system import REPO, System  # noqa: E402
from vhil.worker import TraceWriter, execute_run  # noqa: E402

RUN_PUZZLES = sorted(p.id for p in tr.puzzles().values() if p.mode == "run")


def _drive(puzzle: tr.Puzzle, images, out_dir, faults: bool) -> list[dict]:
    from vhil.sim import Sim
    d = puzzle.drive
    run = RunScenario.model_validate({
        "kind": "run", "name": puzzle.id, "virtual_ms": d.virtual_ms,
        "stimuli": [*d.stimuli, *(puzzle.faults if faults else [])],
        "watch": d.watch, "expect": d.expect})
    system_path = REPO / "systems" / f"{puzzle.system}.yaml"
    system = System(system_path)
    firmware = images(puzzle.system)
    elfs = {b: p for b, p in firmware.items() if "." not in b}
    contract = system_contract(system, elfs)
    errors, _ = check_rows(run, system, contract, elfs, Limits())
    assert not errors, errors
    scenario = run.model_dump()
    trace_path = out_dir / f"{puzzle.id}-{'fault' if faults else 'repaired'}.jsonl"
    trace = TraceWriter(trace_path)
    with Sim(system_path, firmware, log_path=out_dir / f"{puzzle.id}.log") as sim:
        execute_run(sim, scenario, trace, state_view=True)
        end_us = sim.now_us()
    trace.close()
    return vexpect.evaluate_trace(trace_path, scenario["expect"], contract, end_us)


def _lines(results) -> str:
    return "\n".join(f"  {'pass' if r['passed'] else 'FAIL'}  {r['name'] or r['check']} "
                     f"{r['signal']}: {r['detail']}" for r in results)


@pytest.mark.parametrize("pid", RUN_PUZZLES)
def test_solved(pid, images, out_dir):
    puzzle = tr.puzzles()[pid]
    results = _drive(puzzle, images, out_dir, faults=puzzle.fault == "firmware")
    failed = [r for r in results if not vexpect.ok(r)]
    assert not failed, (f"the car still misbehaves: {len(failed)} of {len(results)} checks "
                        f"failed:\n" + _lines(results))


@pytest.mark.parametrize("pid", RUN_PUZZLES)
def test_fault_shows(pid, images, out_dir):
    puzzle = tr.puzzles()[pid]
    results = _drive(puzzle, images, out_dir, faults=True)
    assert any(not vexpect.ok(r) for r in results), \
        "the seeded fault shows no symptom: every healthy-car check passed\n" + _lines(results)
