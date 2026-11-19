# Per-test trace

A test that uses a `Sim` leaves a trace of its buses in the run's results
(#426), and a failed one a snapshot of each board with C frames (#423).
Code: [`vhil/testtrace.py`](../vhil/testtrace.py); the pytest plugin
[`vhil/pytest_vscode.py`](../vhil/pytest_vscode.py) points at it.

## Where

`--vhil-trace-dir DIR`, else `<--sim-log-dir>/traces`, else `traces/` beside
`--vscode-out`. With none of these set nothing is recorded. Two files per
test, named from its node id:

- `<test>.trace.jsonl`: one JSON object per line, each with a `kind`.
- `<test>.log`: the CAN frames that went through, candump-style:
  `(12.345678) can_acu 100#DEADBEEF` (virtual seconds, bus, hex ID, data).

A Sim kept across tests (a session fixture) contributes what happened since
the previous test.

## Records

| kind | fields |
|---|---|
| `meta` (first) | `version`, `test`, `outcome`, `end_us`, `sims` [{`sim`, `system`, `end_us`, `decoded` (buses with named frames)}] |
| `can` | `t_us` (frame start), `end_us`, `sim`, `bus`, `node`, `id`, `ext`, `remote`, `dlc`, `data` (hex), `outcome` (`ok`, `ack`, `lost`); with the firmware's contract: `name`, `sender`, `board`, `signals`, `labels` |
| `uart` | `sim`, `board`, `uart`, `line`; `t_us` is null (Renode's file backend keeps no times) |
| `gpio` | `t_us`, `sim`, `board`, `pin`, `level` (watched pins) |
| `radio` | `t_us`, `sim`, `device`, `board`, `data` |
| `snapshot` (failed test) | `sim`, `board`, `time_us`, `summary`, `exception`, `task`, `fault`, `frames` [{`symbol`, `file`, `line`, `address`}], `bus_tail` |
| `error` | `sim`, `what`, `message`: a collection step that failed |

`t_us` is virtual time in microseconds. A bus with `arbitration: false` has
no timeline: its frames are the ones the probe saw, all `ok`.

Frames are decoded with the firmware's own `.def` files
(`vhil.contract.bus_contract`, the same merge the web app serves). A board
whose ELF has no sources here decodes nothing; the frames stay in raw form.

## Snapshot frames

`frames` is the board's PC, then its LR, innermost first, resolved against
its ELFs (symbol from the symbol table, file and line from
`arm-none-eabi-addr2line`, null without it or without debug info). Paths are
those of the build (`/vhil/fw/<id>@local/...`). `bus_tail` is the last 30
decoded frames of the same Sim up to the snapshot's time.

## VS Code lines

`vhil.pytest_vscode` adds `trace` (path of the `.trace.jsonl`, relative to the
repo when inside it) to a test's `result` line, and, before it, one
`snapshot` line per board (same fields as above, plus `id`).
