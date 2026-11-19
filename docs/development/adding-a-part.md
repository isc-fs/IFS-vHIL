# Adding a part

A **part** is a device on a board's bus: a sensor, a GNSS receiver, a
transceiver. The BMI088 and the ZED-F9P are parts. A part is a catalogue
model (`catalog/models/<id>.yaml`), its Renode model (`models/renode/*.cs`)
and its tests; a system then wires it to a board. Adding a board or an MCU
is [`adding-a-board.md`](adding-a-board.md) instead.

## 1. Generate it

```sh
python -m vhil.part new bme280 --name "Bosch BME280 pressure sensor" \
    --protocol i2c --address 0x76 --who-am-i 0xD0=0x60
```

(`scripts/vhil-docker.sh run python -m vhil.part ...` with nothing installed;
`--dry-run` lists what it would write.)

| Option | What |
|---|---|
| `--protocol i2c\|spi\|uart` | a bus it speaks; repeat it for a part on several (the wire picks one per device) |
| `--address 0x..` | its 7-bit I2C address |
| `--who-am-i REG=VAL` | its ID register and the value it reads |
| `--place <system> <board>.<BUS>` | also wire it in a system, e.g. `--place sensorhub sensorhub.I2C2` |
| `--cs <pin>` | with `--place` on SPI: its chip-select pin, e.g. `PA4` |

It writes:

| File | What |
|---|---|
| `catalog/models/<id>.yaml` | the catalogue entry: interface and renode section |
| `models/renode/<Class>.cs` | the model: a register map behind each protocol, with a test API |
| `tests/sim/test_<id>.py` | its tests on the STM32L496's buses, no firmware |
| `pytest.ini` | its subsystem marker |
| `ci/impact.yaml` | the rule that runs its tests when it changes |

What it generates runs as is: the model answers its ID and holds what is
written to its other registers, and the tests pass. Check it:

```sh
scripts/vhil-docker.sh run python -m pytest tests/sim/test_bme280.py
```

## 2. Model the datasheet

Every `TODO` is a place for the datasheet:

- **The description** in the YAML: the datasheet (title, document number)
  and what of the chip the model does and leaves out.
- **The register map** in the `.cs`: reset values, then each register's
  behaviour (a measurement, a status bit, a command). Cite the datasheet's
  section on each one. A register the model doesn't handle is logged as
  `Unhandled read from offset 0x..`, as Renode logs an unmodelled register,
  so the peripheral guard (invariant 7) fails a system run whose firmware
  touches it. Model it; don't list it in `configs/peripherals.yaml`.
- **The protocol**: the generated one is the common case (I2C: first byte
  the register, auto-increment; SPI: bit 7 set for a read). Change it where
  the chip differs.
- **Values a test sets**: add test API methods (`SetPressure(pa)`), as
  `Bmi088.cs` and `ZedF9p.cs` do. Monitor commands take integers, not
  decimals.

Add a test per behaviour in `tests/sim/test_<id>.py`. `Bmi088.cs` /
`test_bmi088_spi.py` and `ZedF9p.cs` / `test_zed_f9p.py` are the examples
to copy.

## 3. Wire it in a system

`--place` does it, or by hand under `devices:` in `systems/<s>.yaml`:

```yaml
devices:
  baro: {model: bme280, i2c: sensorhub.I2C2}                    # J1.13/J1.14
  rtd:  {model: max31865, spi: sensorhub.SPI1, cs: sensorhub.PA4}
  gnss: {model: zed-f9p, uart: sensorhub.USART2}
```

Say in a comment what it is on the car and which connector pins it uses
(`docs/backplanes/`). Then:

```sh
python -m vhil.system validate systems/sensorhub.yaml
```

Validate names the model file and what is missing when a model and its
wiring don't agree.

## 4. Open the PR

The model, its tests, the marker, the impact rule and the system change go
in one PR into `dev`. Label it `full-ci` to run the part's tests in CI.
