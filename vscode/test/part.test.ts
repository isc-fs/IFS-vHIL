import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  addressError, busError, busProtocol, className, partArgs, partFiles, partIdError, pinError, whoAmIError,
} from "../src/part";

test("a part id is vhil/part.py's: lowercase with dashes, not one that exists", () => {
  assert.equal(partIdError("bme280", []), undefined);
  assert.equal(partIdError("ms5611-01ba", []), undefined);
  assert.match(partIdError("BME280", []) ?? "", /lowercase/);
  assert.match(partIdError("1abc", []) ?? "", /lowercase/);
  assert.match(partIdError("bmi088", ["bmi088"]) ?? "", /exists/);
});

test("an I2C address is 7-bit, a who-am-I a register and its value", () => {
  assert.equal(addressError("0x76"), undefined);
  assert.equal(addressError("118"), undefined);
  assert.ok(addressError("0x80"));
  assert.ok(addressError("x"));
  assert.equal(whoAmIError("", ["i2c"]), undefined);
  assert.equal(whoAmIError("0xD0=0x60", ["i2c"]), undefined);
  assert.match(whoAmIError("0xD0=0x60", ["i2c", "spi"]) ?? "", /0x7F/);
  assert.ok(whoAmIError("0x0F", ["spi"]));
  assert.ok(whoAmIError("0x0F=0x100", ["spi"]));
});

test("a bus's protocol comes from its name and must be one the part speaks", () => {
  assert.equal(busProtocol("I2C2"), "i2c");
  assert.equal(busProtocol("SPI3"), "spi");
  assert.equal(busProtocol("USART2"), "uart");
  assert.equal(busProtocol("LPUART1"), "uart");
  assert.equal(busProtocol("FDCAN1"), undefined);
  assert.equal(busError("I2C2", ["i2c"]), undefined);
  assert.match(busError("SPI1", ["i2c"]) ?? "", /not spi/);
  assert.ok(busError("CAN1", ["i2c"]));
  assert.equal(pinError("PA4"), undefined);
  assert.ok(pinError("4"));
});

test("the answers become vhil.part's arguments", () => {
  assert.deepEqual(partArgs({ id: "bme280", name: "Bosch BME280", protocols: ["i2c"], address: "0x76",
    whoAmI: "0xD0=0x60", place: { system: "sensorhub", board: "sensorhub", bus: "I2C2" } }),
  ["new", "bme280", "--name", "Bosch BME280", "--protocol", "i2c", "--address", "0x76",
    "--who-am-i", "0xD0=0x60", "--place", "sensorhub", "sensorhub.I2C2"]);
  // No address off I2C, no who-am-I left empty; SPI placed with its CS.
  assert.deepEqual(partArgs({ id: "max31865", name: "MAX31865", protocols: ["spi"], address: "0x40", whoAmI: " ",
    place: { system: "sensorhub", board: "sensorhub", bus: "SPI1", cs: "PA4" } }),
  ["new", "max31865", "--name", "MAX31865", "--protocol", "spi",
    "--place", "sensorhub", "sensorhub.SPI1", "--cs", "PA4"]);
});

test("the files it opens are the ones vhil/part.py writes", () => {
  assert.equal(className("ms5611-01ba"), "Ms561101ba");
  assert.deepEqual(partFiles("ms5611-01ba"), ["models/renode/Ms561101ba.cs", "tests/sim/test_ms5611_01ba.py",
    "catalog/models/ms5611-01ba.yaml"]);
});
