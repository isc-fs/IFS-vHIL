"""Start a new part (a device model: a sensor, a transceiver) from one
command, instead of six hand-made files (docs/development/adding-a-part.md).

    python -m vhil.part new <id> --name "<what it is>" --protocol i2c [--address 0x76]
                                 [--protocol spi ...] [--who-am-i 0xD0=0x60]
                                 [--place <system> <board>.<BUS> [--cs <pin>]] [--dry-run]

writes what a part needs, each with a TODO where the datasheet goes:

    catalog/models/<id>.yaml        the catalogue entry (interface, renode section)
    models/renode/<Class>.cs        the Renode model: a register map behind each
                                    protocol, with a test API (SetRegister,
                                    RegisterValue; on I2C Respond; on UART Send)
    tests/sim/test_<id>.py          its tests on the STM32L496's buses, no
                                    firmware: they pass as generated
    pytest.ini                      a subsystem marker for them
    ci/impact.yaml                  the rule that runs them when the part changes

and, with --place, the device in a system (systems/<system>.yaml). The
generated model answers the who-am-I register and holds what is written
elsewhere; the datasheet's behaviour replaces that. Every register it does not
know is logged as Renode logs an unmodelled one, so the peripheral guard
(invariant 7) fails a run that touches one until it is modelled.
"""
from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

from vhil.system import REPO

PROTOCOLS = ("i2c", "spi", "uart")
ID = re.compile(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$")
# Where a generated test puts the part on the STM32L496 (tests/sim/
# test_stm32l496_platform.py Platform): stm32l496xx.h I2C2_BASE, SPI1_BASE,
# GPIOA_BASE, USART2_BASE.
L496 = {"i2c": "i2c2", "spi": "spi1", "uart": "usart2"}


class PartError(Exception):
    pass


@dataclass
class Part:
    id: str
    name: str
    protocols: list[str]
    address: int = 0x40
    who_am_i: tuple[int, int] = (0x00, 0x00)
    cls: str = ""
    marker: str = ""
    files: dict[str, str] = field(default_factory=dict)

    def __post_init__(self):
        if not ID.match(self.id):
            raise PartError(f"'{self.id}': a lowercase id with dashes, e.g. bme280 or ms5611-01ba")
        if not self.protocols or any(p not in PROTOCOLS for p in self.protocols):
            raise PartError(f"--protocol: one or more of {', '.join(PROTOCOLS)}")
        if len(set(self.protocols)) != len(self.protocols):
            raise PartError("--protocol: each once")
        if not 0x08 <= self.address <= 0x77:
            raise PartError(f"--address 0x{self.address:02X}: a 7-bit I2C address, 0x08..0x77")
        reg, val = self.who_am_i
        top = 0x7F if "spi" in self.protocols else 0xFF   # on SPI bit 7 is the read bit
        if not (0 <= reg <= top and 0 <= val <= 0xFF):
            raise PartError(f"--who-am-i: <register 0x00..0x{top:02X}>=<value 0x00..0xFF>")
        self.cls = "".join(w[:1].upper() + w[1:] for w in self.id.split("-"))
        if not self.cls[:1].isalpha():
            raise PartError(f"'{self.id}': must start with a letter")
        self.marker = self.id.replace("-", "_")


# -- the catalogue entry --------------------------------------------------------

def model_yaml(p: Part) -> str:
    api = ["SetRegister(register, value)", "RegisterValue(register)"]
    if "i2c" in p.protocols:
        api.append("on I2C Respond and NackCount")
    if "uart" in p.protocols:
        api.append("on UART Send(hex) and Received")
    where = []
    if "i2c" in p.protocols:
        where.append(f"`i2c:` puts it at 0x{p.address:02X}")
    if "spi" in p.protocols:
        where.append("`spi:` makes it an SPI slave with its chip select as `cs` "
                     "(first byte: register, bit 7 set for a read)")
    if "uart" in p.protocols:
        where.append("`uart:` makes it the far end of a board UART")
    lines = [
        "kind: model",
        f"id: {p.id}",
        "description: >-",
        f"  {p.name} (models/renode/{p.cls}.cs). TODO: the datasheet it follows",
        "  (title, document number) and what of the chip the model does and leaves",
        f"  out. {'; '.join(where)}. Answers 0x{p.who_am_i[1]:02X} at register",
        f"  0x{p.who_am_i[0]:02X} (its ID) and holds what is written elsewhere. Test",
        f"  API (monitor): {', '.join(api)}.",
    ]
    if len(p.protocols) == 1:
        proto = p.protocols[0]
        iface = {"i2c": "{i2c: true}", "spi": "{spi: true, cs: true}", "uart": "{uart: true}"}[proto]
        lines.append(f"interface: {iface}")
    else:
        lines += ["interface:", "  # The bus a device wires picks the protocol.", "  protocols:"]
        for proto in p.protocols:
            lines.append({"i2c": "    i2c: {}",
                          "spi": "    # The SPI chip select, active low; the MCU drives it.\n"
                                 "    spi: {cs: true}",
                          "uart": "    uart: {}"}[proto])
    lines += ["backend: renode", "renode:", f"  source: models/renode/{p.cls}.cs"]
    if "i2c" in p.protocols:
        lines += ["  # I2C: TODO the datasheet's address (and what pin picks it).",
                  "  targets:",
                  f"    dev: {{type: Sensors.{p.cls}I2c, address: 0x{p.address:02X}}}"]
    if "uart" in p.protocols:
        lines += ["  # UART: on sysbus at no address, the MCU's UART its constructor argument.",
                  f"  uart: {{type: Sensors.{p.cls}Uart, argument: uart}}"]
    if "spi" in p.protocols:
        lines += ["  # SPI: one slave; GPIO input 0 is CS.", f"  type: Sensors.{p.cls}Spi"]
    return "\n".join(lines) + "\n"


# -- the Renode model -----------------------------------------------------------

def model_cs(p: Part) -> str:
    reg, val = p.who_am_i
    out = [f"""//
// {p.name}: compiled by Renode at load time (every models/renode/*.cs is).
// Generated by `python -m vhil.part new {p.id}`: a register map that answers
// its ID and holds what is written; the datasheet's behaviour replaces the
// TODOs. In a platform description:
//"""]
    if "i2c" in p.protocols:
        out.append(f"//     {p.marker}: Sensors.{p.cls}I2c @ i2c2 0x{p.address:02X}")
    if "spi" in p.protocols:
        out.append(f"//     {p.marker}: Sensors.{p.cls}Spi @ spi1\n//     gpioPortA:\n//         4 -> {p.marker}@0   // CS")
    if "uart" in p.protocols:
        out.append(f"//     {p.marker}: Sensors.{p.cls}Uart @ sysbus\n//         uart: usart2")
    out.append(f"""//
// Source: TODO the datasheet (title, document number, revision); cite its
// sections for each register and behaviour below.
//
// Registers (TODO from the datasheet's register map): 0x{reg:02X} reads 0x{val:02X}
// (the ID). Any other register holds what was written to it (or set with
// SetRegister) and is logged as unmodelled the first time it is touched, as
// Renode logs an unmodelled register: the peripheral guard fails a run that
// reads or writes one until the model says what it does.
//
// Test API (monitor): SetRegister(register, value), RegisterValue(register)""" +
               ("; on I2C Respond (false: NACK its address) and NackCount" if "i2c" in p.protocols else "") +
               ("; on UART Send(hex) (bytes into the MCU's RX) and Received (what the\n// MCU sent, hex)"
                if "uart" in p.protocols else "") + ".\n//")
    usings = ["System", "System.Collections.Generic", "Antmicro.Renode.Core", "Antmicro.Renode.Logging",
              "Antmicro.Renode.Peripherals"]
    if "i2c" in p.protocols:
        usings.append("Antmicro.Renode.Peripherals.I2C")
    if "spi" in p.protocols:
        usings.append("Antmicro.Renode.Peripherals.SPI")
    if "uart" in p.protocols:
        usings += ["System.Linq", "Antmicro.Renode.Peripherals.UART"]
    out += [f"using {u};" for u in usings]
    out.append(f"""
namespace Antmicro.Renode.Peripherals.Sensors
{{
    // The register map every protocol below reads and writes.
    public sealed class {p.cls}Registers
    {{
        public {p.cls}Registers(IPeripheral owner)
        {{
            this.owner = owner;
            Reset();
        }}

        public void Reset()
        {{
            Array.Clear(registers, 0, registers.Length);
            // TODO: the reset values of the datasheet's register map.
            registers[WhoAmI] = 0x{val:02X};
            pointer = 0;
        }}

        // The register a transfer starts at; reads and writes auto-increment.
        // TODO: the datasheet's rule (some chips don't increment, or wrap).
        public void Point(byte register)
        {{
            pointer = register;
        }}

        public byte ReadNext()
        {{
            var value = Read(pointer);
            pointer = (pointer + 1) & 0xFF;
            return value;
        }}

        public void WriteNext(byte value)
        {{
            Write(pointer, value);
            pointer = (pointer + 1) & 0xFF;
        }}

        public void SetRegister(int register, int value)
        {{
            registers[register & 0xFF] = (byte)value;
        }}

        public int RegisterValue(int register) => registers[register & 0xFF];

        private byte Read(int register)
        {{
            if(register != WhoAmI)
            {{
                Unmodelled("read from", register, null);
            }}
            return registers[register];
        }}

        private void Write(int register, byte value)
        {{
            if(register == WhoAmI)
            {{
                return;   // read-only
            }}
            Unmodelled("write to", register, value);
            registers[register] = value;
        }}

        // TODO: as each register is modelled, handle it above instead.
        private void Unmodelled(string what, int register, byte? value)
        {{
            if(logged.Add(register))
            {{
                owner.Log(LogLevel.Warning, "Unhandled {{0}} offset 0x{{1:X2}}{{2}}", what, register,
                          value.HasValue ? $", value 0x{{value.Value:X2}}" : "");
            }}
        }}

        private const int WhoAmI = 0x{reg:02X};
        private readonly IPeripheral owner;
        private readonly byte[] registers = new byte[0x100];
        private readonly HashSet<int> logged = new HashSet<int>();
        private int pointer;
    }}""")
    if "i2c" in p.protocols:
        out.append(f"""
    // On I2C: a write's first byte is the register; further bytes, and a
    // read's after a repeated START, go to/come from consecutive registers.
    // TODO: check against the datasheet's I2C chapter.
    public class {p.cls}I2c : II2CPeripheral, II2CStartCondition
    {{
        public {p.cls}I2c()
        {{
            map = new {p.cls}Registers(this);
            Respond = true;
        }}

        public void Reset()
        {{
            map.Reset();
            expectRegister = true;
        }}

        public bool OnStart(bool read)
        {{
            if(!Respond)
            {{
                NackCount++;
                return false;
            }}
            if(!read)
            {{
                expectRegister = true;
            }}
            return true;
        }}

        public void Write(byte[] data)
        {{
            foreach(var b in data)
            {{
                if(expectRegister)
                {{
                    map.Point(b);
                    expectRegister = false;
                }}
                else
                {{
                    map.WriteNext(b);
                }}
            }}
        }}

        public byte[] Read(int count = 1)
        {{
            var result = new byte[count];
            for(var i = 0; i < count; i++)
            {{
                result[i] = map.ReadNext();
            }}
            return result;
        }}

        public void FinishTransmission()
        {{
            expectRegister = true;
        }}

        public bool Respond {{ get; set; }}

        public int NackCount {{ get; private set; }}

        public void SetRegister(int register, int value) => map.SetRegister(register, value);

        public int RegisterValue(int register) => map.RegisterValue(register);

        private readonly {p.cls}Registers map;
        private bool expectRegister = true;
    }}""")
    if "spi" in p.protocols:
        out.append(f"""
    // On SPI: a transaction is the chip select's low window (GPIO input 0,
    // active low). Its first byte is the register with bit 7 set for a read;
    // the next bytes go to/come from consecutive registers. TODO: check the
    // datasheet's SPI chapter (mode, read bit, dummy bytes).
    public class {p.cls}Spi : ISPIPeripheral, IGPIOReceiver
    {{
        public {p.cls}Spi()
        {{
            map = new {p.cls}Registers(this);
        }}

        public void Reset()
        {{
            // The chip select is the MCU's pin: it keeps its level.
            map.Reset();
            phase = Phase.Address;
        }}

        public void OnGPIO(int number, bool value)
        {{
            if(number != 0)
            {{
                this.Log(LogLevel.Warning, "No GPIO input {{0}}: 0 is CS", number);
                return;
            }}
            if(csHigh != value)
            {{
                csHigh = value;
                phase = Phase.Address;
            }}
        }}

        public byte Transmit(byte data)
        {{
            if(csHigh)
            {{
                return 0;
            }}
            switch(phase)
            {{
            case Phase.Address:
                map.Point((byte)(data & 0x7F));
                phase = (data & 0x80) != 0 ? Phase.Read : Phase.Write;
                return 0;
            case Phase.Read:
                return map.ReadNext();
            default:
                map.WriteNext(data);
                return 0;
            }}
        }}

        // The frame is the chip select's window (OnGPIO), not the transfer.
        public void FinishTransmission()
        {{
        }}

        public void SetRegister(int register, int value) => map.SetRegister(register, value);

        public int RegisterValue(int register) => map.RegisterValue(register);

        private enum Phase {{ Address, Read, Write }}

        private readonly {p.cls}Registers map;
        private Phase phase = Phase.Address;
        private bool csHigh = true;
    }}""")
    if "uart" in p.protocols:
        out.append(f"""
    // On UART: the far end of an MCU UART. What the MCU sends is recorded
    // (Received); a test sends with Send. TODO: the datasheet's protocol
    // (framing, commands, replies) and its baud rate pacing.
    public class {p.cls}Uart : IPeripheral
    {{
        public {p.cls}Uart(IMachine machine, IUART uart)
        {{
            this.uart = uart;
            map = new {p.cls}Registers(this);
            uart.CharReceived += b => received.Add(b);
        }}

        public void Reset()
        {{
            map.Reset();
            received.Clear();
        }}

        public void Send(string hex)
        {{
            for(var i = 0; i + 1 < hex.Length; i += 2)
            {{
                uart.WriteChar(Convert.ToByte(hex.Substring(i, 2), 16));
            }}
        }}

        public string Received => string.Concat(received.Select(b => b.ToString("x2")));

        public void SetRegister(int register, int value) => map.SetRegister(register, value);

        public int RegisterValue(int register) => map.RegisterValue(register);

        private readonly IUART uart;
        private readonly {p.cls}Registers map;
        private readonly List<byte> received = new List<byte>();
    }}""")
    out.append("}")
    return "\n".join(out) + "\n"


# -- its tests ------------------------------------------------------------------

def test_py(p: Part) -> str:
    reg, val = p.who_am_i
    head = f'''"""The {p.name} (models/renode/{p.cls}.cs) on the STM32L496's buses, as a
SensorHub would wire it; bytes go through the controllers' registers, as a
firmware's would, and no firmware runs. Generated by `python -m vhil.part new
{p.id}`: it checks the generated register map. TODO: a test per behaviour the
model takes from the datasheet (cite its sections)."""
import pytest

from tests.sim.test_stm32l496_platform import Platform
from vhil import renode as rn

pytestmark = [pytest.mark.platform_stm32l496, pytest.mark.{p.marker}]

# stm32l496xx.h: I2C2_BASE, SPI1_BASE, GPIOA_BASE, USART2_BASE; I2C_TypeDef CR1
# 0x00, CR2 0x04, RXDR 0x24, TXDR 0x28; SPI CR1 0x00, CR2 0x04, DR 0x0C; USART
# CR1 0x00, BRR 0x0C, ISR 0x1C (RXNE 5), RDR 0x24, TDR 0x28.
I2C2, SPI1, GPIOA, USART2 = 0x40005800, 0x40013000, 0x48000000, 0x40004400
WHO_AM_I, ID = 0x{reg:02X}, 0x{val:02X}
'''
    parts = [head]
    if "i2c" in p.protocols:
        parts.append(f'''
ADDR = 0x{p.address:02X}
I2C_DEV = "sysbus.i2c2.{p.marker}"


@pytest.fixture
def on_i2c(tmp_path):
    p = Platform()
    repl = tmp_path / "{p.id}.repl"
    repl.write_text(f"{p.marker}: Sensors.{p.cls}I2c @ i2c2 0x{{ADDR:02X}}\\n")
    p.mon.execute(f"machine LoadPlatformDescription {{rn.file_arg(repl)}}")
    p.run_program([], seconds="0.001")
    p.wr(I2C2, 1)                                  # CR1: PE
    yield p
    p.close()


def _i2c_read(p, register: int, n: int) -> bytes:
    p.wr(I2C2 + 0x04, (ADDR << 1) | (1 << 16) | (1 << 13))          # one byte, START
    p.wr(I2C2 + 0x28, register)
    p.wr(I2C2 + 0x04, (ADDR << 1) | (1 << 10) | (n << 16) | (1 << 25) | (1 << 13))  # read, AUTOEND
    return bytes(p.rd(I2C2 + 0x24) & 0xFF for _ in range(n))


def _i2c_write(p, register: int, data: bytes) -> None:
    p.wr(I2C2 + 0x04, (ADDR << 1) | ((1 + len(data)) << 16) | (1 << 25) | (1 << 13))
    for b in bytes([register]) + data:
        p.wr(I2C2 + 0x28, b)


def test_on_i2c_it_answers_its_id(on_i2c):
    assert _i2c_read(on_i2c, WHO_AM_I, 1) == bytes([ID])


def test_on_i2c_a_write_reads_back_and_the_test_api_sees_it(on_i2c):
    reg = (WHO_AM_I + 1) & 0x7F
    _i2c_write(on_i2c, reg, b"\\x5a\\xa5")
    assert _i2c_read(on_i2c, reg, 2) == b"\\x5a\\xa5"
    assert int(on_i2c.value(f"{{I2C_DEV}} RegisterValue {{reg}}"), 0) == 0x5A


def test_on_i2c_an_unpowered_part_nacks_its_address(on_i2c):
    on_i2c.mon.execute(f"{{I2C_DEV}} Respond false")
    _i2c_read(on_i2c, WHO_AM_I, 1)
    assert int(on_i2c.value(f"{{I2C_DEV}} NackCount"), 0) >= 1
''')
    if "spi" in p.protocols:
        parts.append(f'''
CS = 4                                          # PA4
SPI_DEV = "sysbus.spi1.{p.marker}"


@pytest.fixture
def on_spi(tmp_path):
    p = Platform()
    repl = tmp_path / "{p.id}.repl"
    repl.write_text(f"{p.marker}: Sensors.{p.cls}Spi @ spi1\\n\\ngpioPortA:\\n    {{CS}} -> {p.marker}@0\\n")
    p.mon.execute(f"machine LoadPlatformDescription {{rn.file_arg(repl)}}")
    p.run_program([], seconds="0.001")
    p.wr(GPIOA + 0x00, 0xABFFFFFF & ~(3 << 2 * CS) | (1 << 2 * CS))  # MODER: PA4 output
    p.wr(GPIOA + 0x14, 1 << CS)                                      # CS high
    p.wr(SPI1 + 0x04, (7 << 8) | (1 << 12))                          # DS 8 bits, FRXTH
    p.wr(SPI1 + 0x00, (1 << 2) | (1 << 6))                           # MSTR, SPE
    yield p
    p.close()


def _xfer(p, data: bytes) -> bytes:
    p.wr(GPIOA + 0x14, 0)
    out = []
    for b in data:
        p.mon.execute(f"sysbus WriteByte {{SPI1 + 0x0C:#x}} {{b:#x}}")
        out.append(int(p.mon.execute(f"sysbus ReadByte {{SPI1 + 0x0C:#x}}").strip(), 16))
    p.wr(GPIOA + 0x14, 1 << CS)
    return bytes(out)


def test_on_spi_it_answers_its_id(on_spi):
    assert _xfer(on_spi, bytes([0x80 | WHO_AM_I, 0]))[1] == ID


def test_on_spi_a_write_reads_back(on_spi):
    reg = (WHO_AM_I + 1) & 0x7F
    _xfer(on_spi, bytes([reg, 0x5A]))
    assert _xfer(on_spi, bytes([0x80 | reg, 0]))[1] == 0x5A
    assert int(on_spi.value(f"{{SPI_DEV}} RegisterValue {{reg}}"), 0) == 0x5A
''')
    if "uart" in p.protocols:
        parts.append(f'''
UART_DEV = "sysbus.{p.marker}"                    # on sysbus at no address


@pytest.fixture
def on_uart(tmp_path):
    p = Platform()
    repl = tmp_path / "{p.id}.repl"
    repl.write_text("{p.marker}: Sensors.{p.cls}Uart @ sysbus\\n    uart: usart2\\n")
    p.mon.execute(f"machine LoadPlatformDescription {{rn.file_arg(repl)}}")
    p.run_program([], seconds="0.001")
    p.wr(USART2 + 0x0C, 104)                       # BRR
    p.wr(USART2 + 0x00, 0b1101)                    # CR1: UE, RE, TE
    yield p
    p.close()


def test_on_uart_what_it_sends_reaches_the_mcu_and_back(on_uart):
    on_uart.mon.execute(f'{{UART_DEV}} Send "a55a"')
    got = b""
    while on_uart.rd(USART2 + 0x1C) & (1 << 5):
        got += bytes([on_uart.rd(USART2 + 0x24) & 0xFF])
    assert got == b"\\xa5\\x5a"
    on_uart.wr(USART2 + 0x28, 0x42)
    on_uart.mon.execute('emulation RunFor "0.01"')
    assert on_uart.value(f"{{UART_DEV}} Received").strip('"') == "42"
''')
    return "".join(parts)


# -- the places that list parts -------------------------------------------------

def add_marker(text: str, p: Part) -> str:
    """pytest.ini: a subsystem marker after the last `subsystem:` one."""
    line = f"    {p.marker}: subsystem: the {p.name}"
    if re.search(rf"^\s+{re.escape(p.marker)}:", text, re.M):
        raise PartError(f"pytest.ini already has a marker '{p.marker}'")
    lines = text.splitlines()
    last = max((i for i, l in enumerate(lines) if ": subsystem:" in l), default=None)
    if last is None:
        raise PartError("pytest.ini: no subsystem markers to add one after")
    lines.insert(last + 1, line)
    return "\n".join(lines) + "\n"


def add_impact_rule(text: str, p: Part) -> str:
    """ci/impact.yaml: a rule after the last device rule (one naming a
    catalog/models file), so the part's tests run when it changes."""
    rule = (f"  - name: the {p.name}\n"
            f"    paths: [models/renode/{p.cls}.cs, catalog/models/{p.id}.yaml]\n"
            f"    select: {{markers: [{p.marker}], devices: [{p.id}]}}\n")
    if f"catalog/models/{p.id}.yaml" in text:
        raise PartError(f"ci/impact.yaml already names catalog/models/{p.id}.yaml")
    lines = text.splitlines(keepends=True)
    last = max((i for i, l in enumerate(lines) if "catalog/models/" in l and "paths:" in l), default=None)
    if last is None:
        raise PartError("ci/impact.yaml: no device rule to add one after")
    end = last + 1
    while end < len(lines) and lines[end].startswith("    "):
        end += 1
    return "".join(lines[:end] + [rule] + lines[end:])


def place(text: str, p: Part, board: str, bus: str, cs: str | None = None) -> str:
    """systems/<x>.yaml: the device under `devices:` (one added if absent)."""
    kind = re.sub(r"^(lp)?us?art$", "uart", bus.rstrip("0123456789").lower())
    if kind not in PROTOCOLS:
        raise PartError(f"--place {board}.{bus}: a bus such as I2C2, SPI1 or USART2")
    if kind not in p.protocols:
        raise PartError(f"--place {board}.{bus}: {p.id} speaks {', '.join(p.protocols)}, not {kind}")
    wiring = f"{kind}: {board}.{bus}"
    if kind == "spi":
        if not cs:
            raise PartError(f"--place {board}.{bus}: an SPI part needs its chip select, --cs <pin> (e.g. PA4)")
        wiring += f", cs: {board}.{cs}"
    entry = f"  # TODO: what it is on the car, and the pins (docs/backplanes/).\n  {p.marker}: {{model: {p.id}, {wiring}}}\n"
    if re.search(r"^devices:\s*$", text, re.M):
        lines = text.splitlines(keepends=True)
        i = next(i for i, l in enumerate(lines) if re.match(r"^devices:\s*$", l))
        end = i + 1
        while end < len(lines) and (lines[end].startswith(" ") or not lines[end].strip()):
            end += 1
        while end > i + 1 and not lines[end - 1].strip():
            end -= 1
        return "".join(lines[:end] + [entry] + lines[end:])
    return text.rstrip("\n") + "\ndevices:\n" + entry


# -- the command ----------------------------------------------------------------

def plan(p: Part, root: Path = REPO, system: str | None = None, at: str | None = None,
         cs: str | None = None) -> dict[Path, str]:
    """Every file the part writes or changes, with its new content."""
    new = {root / "catalog/models" / f"{p.id}.yaml": model_yaml(p),
           root / "models/renode" / f"{p.cls}.cs": model_cs(p),
           root / "tests/sim" / f"test_{p.marker}.py": test_py(p)}
    for path in new:
        if path.exists():
            raise PartError(f"{path.relative_to(root)} exists: pick another id")
    changed = {root / "pytest.ini": add_marker((root / "pytest.ini").read_text(), p),
               root / "ci/impact.yaml": add_impact_rule((root / "ci/impact.yaml").read_text(), p)}
    if system:
        path = root / "systems" / f"{system}.yaml"
        if not path.exists():
            raise PartError(f"no system {system} (systems/{system}.yaml)")
        board, _, bus = (at or "").partition(".")
        if not board or not bus:
            raise PartError("--place <system> <board>.<BUS>, e.g. --place sensorhub sensorhub.I2C2")
        changed[path] = place(path.read_text(), p, board, bus, cs)
    return {**new, **changed}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m vhil.part", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    n = sub.add_parser("new", help="start a new part")
    n.add_argument("id", help="lowercase with dashes, e.g. bme280")
    n.add_argument("--name", required=True, help='what it is, e.g. "Bosch BME280 pressure sensor"')
    n.add_argument("--protocol", action="append", choices=PROTOCOLS, required=True,
                   help="a bus it speaks (repeat for more: the wired one is picked per device)")
    n.add_argument("--address", type=lambda s: int(s, 0), default=0x40, help="its 7-bit I2C address")
    n.add_argument("--who-am-i", default="0x00=0x00", help="<register>=<value> of its ID register")
    n.add_argument("--place", nargs=2, metavar=("SYSTEM", "BOARD.BUS"), help="also add it to a system")
    n.add_argument("--cs", help="with --place on SPI: the board pin its chip select is on, e.g. PA4")
    n.add_argument("--dry-run", action="store_true", help="list what it would write")
    args = ap.parse_args(argv)
    try:
        reg, _, val = args.who_am_i.partition("=")
        p = Part(args.id, args.name, args.protocol, args.address, (int(reg, 0), int(val, 0)))
        files = plan(p, REPO, *(args.place or (None, None)), cs=args.cs)
    except (PartError, ValueError) as e:
        print(f"vhil.part: {e}", file=sys.stderr)
        return 2
    for path, text in files.items():
        rel = path.relative_to(REPO)
        verb = "change" if path.exists() else "write"
        print(f"{verb:6} {rel}")
        if not args.dry_run:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
    if not args.dry_run:
        print(f"\nnext: fill the TODOs from the datasheet, then\n"
              f"  scripts/vhil-docker.sh sim tests/sim/test_{p.marker}.py\n"
              f"  (docs/development/adding-a-part.md)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
