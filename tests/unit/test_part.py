"""vhil/part.py: what `python -m vhil.part new` writes, on a copy of the
repository's files that list parts (the generated sim tests themselves run
in tests/sim once a part is committed)."""
import shutil

import pytest
import yaml

from vhil import part
from vhil.system import REPO


@pytest.fixture
def root(tmp_path):
    for rel in ("pytest.ini", "ci/impact.yaml", "systems/sensorhub.yaml"):
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(REPO / rel, tmp_path / rel)
    return tmp_path


def _part(**kw):
    args = dict(id="bme280", name="Bosch BME280 pressure sensor", protocols=["i2c"],
                address=0x76, who_am_i=(0x50, 0x60))
    args.update(kw)
    return part.Part(**args)


def test_an_i2c_part_writes_its_files_and_lists_itself(root):
    files = part.plan(_part(), root)
    rel = {p.relative_to(root).as_posix() for p in files}
    assert rel == {"catalog/models/bme280.yaml", "models/renode/Bme280.cs",
                   "tests/sim/test_bme280.py", "pytest.ini", "ci/impact.yaml"}
    model = yaml.safe_load(files[root / "catalog/models/bme280.yaml"])
    assert model["interface"] == {"i2c": True}
    assert model["renode"]["targets"]["dev"] == {"type": "Sensors.Bme280I2c", "address": 0x76}
    assert "    bme280: subsystem: the Bosch BME280 pressure sensor" in files[root / "pytest.ini"]
    rules = yaml.safe_load(files[root / "ci/impact.yaml"])
    rule = next(r for r in rules["rules"] if r["name"] == "the Bosch BME280 pressure sensor")
    assert rule["select"] == {"markers": ["bme280"], "devices": ["bme280"]}
    cs = files[root / "models/renode/Bme280.cs"]
    assert "class Bme280I2c : II2CPeripheral, II2CStartCondition" in cs
    assert "registers[WhoAmI] = 0x60;" in cs and "WhoAmI = 0x50;" in cs
    test = files[root / "tests/sim/test_bme280.py"]
    compile(test, "test_bme280.py", "exec")
    assert "pytest.mark.bme280" in test and "Sensors.Bme280I2c @ i2c2 0x" in test


def test_several_protocols_give_one_class_each_and_a_protocols_interface(root):
    p = _part(id="ms5611-01ba", name="MS5611", protocols=["i2c", "spi", "uart"])
    assert (p.cls, p.marker) == ("Ms561101ba", "ms5611_01ba")
    files = part.plan(p, root)
    model = yaml.safe_load(files[root / "catalog/models/ms5611-01ba.yaml"])
    assert model["interface"] == {"protocols": {"i2c": {}, "spi": {"cs": True}, "uart": {}}}
    assert model["renode"]["type"] == "Sensors.Ms561101baSpi"
    assert model["renode"]["uart"] == {"type": "Sensors.Ms561101baUart", "argument": "uart"}
    cs = files[root / "models/renode/Ms561101ba.cs"]
    for cls in ("Ms561101baI2c", "Ms561101baSpi", "Ms561101baUart"):
        assert f"public class {cls}" in cs
    test = files[root / "tests/sim/test_ms5611_01ba.py"]
    compile(test, "t.py", "exec")
    assert all(f"def {f}" in test for f in ("on_i2c", "on_spi", "on_uart"))


def test_place_adds_the_device_to_a_system(root):
    files = part.plan(_part(), root, "sensorhub", "sensorhub.I2C2")
    text = files[root / "systems/sensorhub.yaml"]
    devices = yaml.safe_load(text)["devices"]
    assert devices["bme280"] == {"model": "bme280", "i2c": "sensorhub.I2C2"}
    # Every device it had is still there.
    before = yaml.safe_load((root / "systems/sensorhub.yaml").read_text()).get("devices") or {}
    assert set(before) <= set(devices)


@pytest.mark.parametrize("kw, error", [
    (dict(id="BME280"), "lowercase"),
    (dict(protocols=["can"]), "--protocol"),
    (dict(protocols=["i2c", "i2c"]), "each once"),
    (dict(address=0x80), "7-bit"),
    (dict(who_am_i=(0x100, 0)), "--who-am-i"),
    (dict(protocols=["spi"], who_am_i=(0x80, 0)), "0x7F"),
])
def test_bad_input_says_what_is_wrong(kw, error):
    with pytest.raises(part.PartError, match=error):
        _part(**kw)


def test_it_refuses_a_part_that_exists_or_a_wrong_bus(root):
    (root / "catalog/models").mkdir(parents=True)
    (root / "catalog/models/bme280.yaml").write_text("kind: model\n")
    with pytest.raises(part.PartError, match="exists"):
        part.plan(_part(), root)
    with pytest.raises(part.PartError, match="not spi"):
        part.plan(_part(id="other"), root, "sensorhub", "sensorhub.SPI1")
    with pytest.raises(part.PartError, match="no system"):
        part.plan(_part(id="other"), root, "nope", "x.I2C2")


def test_dry_run_writes_nothing(capsys):
    assert part.main(["new", "zz-probe", "--name", "probe", "--protocol", "i2c", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "write  catalog/models/zz-probe.yaml" in out and "change pytest.ini" in out
    assert not (REPO / "catalog/models/zz-probe.yaml").exists()


def test_an_spi_part_is_placed_with_its_chip_select(root):
    p = _part(id="max31865", name="MAX31865", protocols=["spi"])
    with pytest.raises(part.PartError, match="--cs"):
        part.plan(p, root, "sensorhub", "sensorhub.SPI1")
    files = part.plan(p, root, "sensorhub", "sensorhub.SPI1", cs="PA4")
    devices = yaml.safe_load(files[root / "systems/sensorhub.yaml"])["devices"]
    assert devices["max31865"] == {"model": "max31865", "spi": "sensorhub.SPI1", "cs": "sensorhub.PA4"}
