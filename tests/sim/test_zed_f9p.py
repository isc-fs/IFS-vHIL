"""The ZED-F9P GNSS receiver (models/renode/ZedF9p.cs) on the L496's I2C2 and
SPI1, as a SensorHub would wire it through J1 (systems/sensorhub.yaml). Bytes
go through the controllers' registers, as a firmware's would; no firmware
runs. Protocol after the ZED-F9P Integration Manual (UBX-18010802) and the F9
HPG Interface Description (UBX-22008968), RTCM framing after RTCM 10403.3
(cited in the model's header)."""
import struct

import pytest

from tests.sim.test_stm32l496_platform import Platform
from vhil import renode as rn

pytestmark = [pytest.mark.platform_stm32l496, pytest.mark.gnss]

# stm32l496xx.h: I2C2_BASE, SPI1_BASE, GPIOA_BASE, USART2_BASE; I2C_TypeDef
# CR1 0x00, CR2 0x04, ISR 0x18, RXDR 0x24, TXDR 0x28; SPI CR1 0x00, CR2 0x04,
# DR 0x0C; USART CR1 0x00 (UE 0, RE 2, TE 3), BRR 0x0C, ISR 0x1C (RXNE 5),
# RDR 0x24, TDR 0x28.
I2C2, SPI1, GPIOA, USART2 = 0x40005800, 0x40013000, 0x48000000, 0x40004400
CR2_RD_WRN, CR2_START, CR2_AUTOEND = 1 << 10, 1 << 13, 1 << 25
ISR_NACKF = 1 << 4
ADDR = 0x42
RX = "sysbus.i2c2.gnss_rx"
SPI_RX = "sysbus.spi1.gnss"
UART_RX = "sysbus.gnss"                         # on sysbus at no address
CS = 4                                          # PA4, J1.18 SPI_CS_EXT

RATE_MEAS, DGNSS_TO, I2C_OUT_NMEA = 0x30210001, 0x201100C4, 0x10720002
NAV_PVT_I2C = 0x20910006
NMEA_SPI = {"GGA": 0x209100BE, "RMC": 0x209100AF, "GLL": 0x209100CD,
            "GSA": 0x209100C3, "GSV": 0x209100C8, "VTG": 0x209100B4}


def _ubx(cls, mid, payload=b""):
    body = bytes([cls, mid]) + struct.pack("<H", len(payload)) + payload
    a = b = 0
    for x in body:
        a = (a + x) & 0xFF
        b = (b + a) & 0xFF
    return b"\xb5\x62" + body + bytes([a, b])


def _size(key):
    return {1: 1, 2: 1, 3: 2, 4: 4, 5: 8}[(key >> 28) & 7]


def _valset(items):
    payload = bytes([0, 0x01, 0, 0])            # version 0, RAM layer
    for key, value in items:
        payload += struct.pack("<I", key) + value.to_bytes(_size(key), "little")
    return _ubx(0x06, 0x8A, payload)


def _crc24q(data):
    crc = 0
    for x in data:
        crc ^= x << 16
        for _ in range(8):
            crc <<= 1
            if crc & 0x1000000:
                crc ^= 0x1864CFB
    return crc & 0xFFFFFF


def _rtcm(msg_type, station=0, length=19, bad_crc=False):
    """An RTCM3 frame: its message type and reference station ID in the
    payload's first 24 bits, the rest zero (the model reads no more)."""
    payload = bytes([msg_type >> 4, ((msg_type & 0xF) << 4) | (station >> 8), station & 0xFF])
    payload += bytes(length - 3)
    head = bytes([0xD3, len(payload) >> 8, len(payload) & 0xFF]) + payload
    crc = _crc24q(head) ^ (1 if bad_crc else 0)
    return head + crc.to_bytes(3, "big")


def _messages(stream: bytes):
    """Split an output stream into NMEA sentences (str) and UBX frames (bytes);
    every NMEA checksum and UBX checksum is checked."""
    out, i = [], 0
    while i < len(stream):
        if stream[i:i + 1] == b"$":
            end = stream.index(b"\r\n", i)
            line = stream[i + 1:end].decode()
            body, cs = line.rsplit("*", 1)
            x = 0
            for c in body:
                x ^= ord(c)
            assert int(cs, 16) == x, line
            out.append(body)
            i = end + 2
        elif stream[i:i + 2] == b"\xb5\x62":
            n = struct.unpack_from("<H", stream, i + 4)[0]
            frame = stream[i:i + 8 + n]
            assert _ubx(frame[2], frame[3], frame[6:6 + n]) == frame
            out.append(frame)
            i += 8 + n
        else:
            raise AssertionError(f"stray byte {stream[i]:#x} at {i}: {stream!r}")
    return out


def _nmea(messages, kind):
    return [m.split(",") for m in messages if isinstance(m, str) and m[2:5] == kind]


class I2c:
    def __init__(self, p):
        self.p = p

    def write(self, data: bytes, autoend=True):
        for at in range(0, len(data), 255):
            chunk = data[at:at + 255]
            last = at + 255 >= len(data)
            self.p.wr(I2C2 + 0x04, (ADDR << 1) | (len(chunk) << 16) | CR2_START
                      | (CR2_AUTOEND if autoend and last else 0))
            for b in chunk:
                self.p.wr(I2C2 + 0x28, b)

    def read(self, n: int) -> bytes:
        out = b""
        while n > 0:
            k = min(n, 255)
            self.p.wr(I2C2 + 0x04, (ADDR << 1) | CR2_RD_WRN | (k << 16) | CR2_AUTOEND | CR2_START)
            out += bytes(self.p.rd(I2C2 + 0x24) & 0xFF for _ in range(k))
            n -= k
        return out

    def waiting(self) -> int:
        """Point at 0xFD (a one-byte write), then read 0xFD/0xFE after a
        repeated START; the address is 0xFF after them."""
        self.write(bytes([0xFD]), autoend=False)
        hi, lo = self.read(2)
        return hi << 8 | lo

    def drain(self) -> list:
        return _messages(self.read(self.waiting()))


def _run(p, s):
    p.mon.execute(f'emulation RunFor "{s}"')


@pytest.fixture
def hub(tmp_path):
    p = Platform()
    repl = tmp_path / "gnss.repl"
    repl.write_text(f"gnss_rx: Sensors.ZedF9pI2c @ i2c2 0x{ADDR:02X}\n")
    p.mon.execute(f"machine LoadPlatformDescription {rn.file_arg(repl)}")
    p.run_program([], seconds="0.001")
    p.wr(I2C2, 1)                                # CR1: PE
    yield p
    p.close()


def test_without_a_position_it_sends_the_default_nmea_set_and_no_fix(hub):
    i2c = I2c(hub)
    assert i2c.waiting() == 0, "nothing before the first epoch"
    assert i2c.read(2) == b"\xff\xff", "the stream reads 0xFF when empty"
    _run(hub, "1.01")
    msgs = i2c.drain()
    assert [m[:5] for m in msgs] == ["GNRMC", "GNVTG", "GNGGA", "GNGSA", "GPGSV", "GNGLL"]
    gga = _nmea(msgs, "GGA")[0]
    assert gga[1] == "000001.00" and gga[2:7] == ["", "", "", "", "0"] and gga[8] == "99.99"
    assert _nmea(msgs, "RMC")[0][2] == "V" and _nmea(msgs, "RMC")[0][12] == "N"
    assert i2c.waiting() == 0


def test_a_position_gives_a_standalone_fix(hub):
    hub.mon.execute(f"{RX} SetPosition 404168000 -37038000 650000")
    hub.mon.execute(f"{RX} SetVelocity 10000 0 0")
    _run(hub, "1.01")
    msgs = I2c(hub).drain()
    gga = _nmea(msgs, "GGA")[0]
    assert gga[2:10] == ["4025.00800", "N", "00342.22800", "W", "1", "12", "0.80", "650.0"]
    assert gga[13:15] == ["", ""], "no corrections: no age, no station"
    rmc = _nmea(msgs, "RMC")[0]
    assert (rmc[2], rmc[7], rmc[8], rmc[9], rmc[12]) == ("A", "19.438", "0.00", "010126", "A")
    assert hub.value(f"{RX} Solution") == "3d"


def test_rtcm_corrections_give_rtk_float_then_fixed_and_time_out(hub):
    i2c = I2c(hub)
    hub.mon.execute(f"{RX} SetPosition 404168000 -37038000 650000")
    hub.mon.execute(f"{RX} FixTimeS 2")
    i2c.write(_valset([(DGNSS_TO, 2)]))
    assert _messages(i2c.read(i2c.waiting())) == [_ubx(0x05, 0x01, bytes([0x06, 0x8A]))]
    i2c.write(_rtcm(1005, station=2003) + _rtcm(1077, station=2003, length=40))
    i2c.write(_rtcm(1077, length=40, bad_crc=True))
    assert int(hub.value(f"{RX} RtcmCrcErrors"), 0) == 1
    assert int(hub.value(f"{RX} RtcmCount 1077"), 0) == 1
    _run(hub, "1.01")
    gga = _nmea(i2c.drain(), "GGA")[0]
    assert (gga[6], gga[14]) == ("5", "2003"), "float, with the 1005's station"
    assert gga[13] == "1.0", "age of the last observation"
    for _ in range(2):
        i2c.write(_rtcm(1077, length=40))
        _run(hub, "1.0")
    msgs = i2c.drain()
    assert [g[6] for g in _nmea(msgs, "GGA")] == ["5", "4"], "fixed 2 s after the stream began"
    assert _nmea(msgs, "RMC")[-1][12] == "R"
    _run(hub, "3.0")                              # no observations for > 2 s
    assert [g[6] for g in _nmea(i2c.drain(), "GGA")][-1] == "1"
    assert hub.value(f"{RX} Solution") == "3d"


def test_valset_switches_to_nav_pvt_and_valget_reads_back(hub):
    i2c = I2c(hub)
    hub.mon.execute(f"{RX} SetPosition 404168000 -37038000 650000")
    hub.mon.execute(f"{RX} GeoidSeparationMm 51500")
    i2c.write(_valset([(I2C_OUT_NMEA, 0), (NAV_PVT_I2C, 1), (RATE_MEAS, 200)]))
    i2c.write(_ubx(0x06, 0x8B, bytes([0, 0, 0, 0]) + struct.pack("<I", RATE_MEAS)))
    assert _messages(i2c.read(i2c.waiting())) == [
        _ubx(0x05, 0x01, bytes([0x06, 0x8A])),
        _ubx(0x06, 0x8B, bytes([1, 0, 0, 0]) + struct.pack("<IH", RATE_MEAS, 200)),
        _ubx(0x05, 0x01, bytes([0x06, 0x8B]))]
    _run(hub, "0.21")
    (pvt,) = i2c.drain()
    p = pvt[6:-2]
    assert pvt[2:4] == b"\x01\x07" and len(p) == 92
    assert struct.unpack_from("<H", p, 4)[0] == 2026 and p[20] == 3 and p[23] == 12
    lon, lat, height, hmsl, hacc = struct.unpack_from("<iiiiI", p, 24)
    assert (lon, lat, height, hmsl, hacc) == (-37038000, 404168000, 701500, 650000, 1500)
    assert p[21] & 0xC0 == 0, "no carrier solution without corrections"


def test_valset_with_an_unknown_key_is_refused_whole(hub):
    i2c = I2c(hub)
    i2c.write(_valset([(RATE_MEAS, 200), (0x10770001, 1)]))   # + CFG-USBINPROT-UBX (no USB)
    assert _messages(i2c.read(i2c.waiting())) == [_ubx(0x05, 0x00, bytes([0x06, 0x8A]))]
    assert int(hub.value(f"{RX} Config {RATE_MEAS:#x}"), 0) == 1000


def test_a_power_on_restores_the_defaults_and_keeps_the_position(hub):
    i2c = I2c(hub)
    hub.mon.execute(f"{RX} SetPosition 404168000 -37038000 650000")
    i2c.write(_valset([(RATE_MEAS, 200)]))
    hub.reset()
    assert int(hub.value(f"{RX} Config {RATE_MEAS:#x}"), 0) == 1000
    assert int(hub.value(f"{RX} Pending"), 0) == 0
    assert hub.value(f"{RX} Solution") == "3d"


def test_an_unpowered_receiver_nacks_its_address(hub):
    hub.mon.execute(f"{RX} Respond false")
    hub.wr(I2C2 + 0x04, (ADDR << 1) | CR2_RD_WRN | (2 << 16) | CR2_AUTOEND | CR2_START)
    assert hub.rd(I2C2 + 0x18) & ISR_NACKF
    assert int(hub.value(f"{RX} NackCount"), 0) == 1


@pytest.fixture
def spi(tmp_path):
    p = Platform()
    repl = tmp_path / "gnss.repl"
    repl.write_text(f"gnss: Sensors.ZedF9pSpi @ spi1\n\ngpioPortA:\n    {CS} -> gnss@0\n")
    p.mon.execute(f"machine LoadPlatformDescription {rn.file_arg(repl)}")
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
        p.mon.execute(f"sysbus WriteByte {SPI1 + 0x0C:#x} {b:#x}")
        out.append(int(p.mon.execute(f"sysbus ReadByte {SPI1 + 0x0C:#x}").strip(), 16))
    p.wr(GPIOA + 0x14, 1 << CS)
    return bytes(out)


def test_on_spi_it_streams_full_duplex_while_selected(spi):
    assert _xfer(spi, b"\xff" * 4) == b"\xff" * 4, "nothing waiting: 0xFF"
    # Every NMEA message off but GGA, written as the input stream.
    off = _valset([(k, 0) for n, k in NMEA_SPI.items() if n != "GGA"])
    assert _xfer(spi, off) == b"\xff" * len(off)
    # The ACK goes out while the next bytes come in.
    ack = _ubx(0x05, 0x01, bytes([0x06, 0x8A]))
    frame = _rtcm(1005, station=7)
    assert _xfer(spi, frame) == ack + b"\xff" * (len(frame) - len(ack))
    assert int(spi.value(f"{SPI_RX} RtcmCount 1005"), 0) == 1
    spi.mon.execute(f"{SPI_RX} SetPosition 404168000 -37038000 650000")
    spi.mon.execute('emulation RunFor "1.01"')
    waiting = int(spi.value(f"{SPI_RX} Pending"), 0)
    spi.mon.execute(f"sysbus WriteByte {SPI1 + 0x0C:#x} 0xff")      # CS high: undriven
    assert int(spi.mon.execute(f"sysbus ReadByte {SPI1 + 0x0C:#x}").strip(), 16) == 0
    assert int(spi.value(f"{SPI_RX} Pending"), 0) == waiting
    msgs = _messages(_xfer(spi, b"\xff" * waiting))
    assert [m[:5] for m in msgs] == ["GNGGA"] and _nmea(msgs, "GGA")[0][6] == "1"


@pytest.fixture
def uart(tmp_path):
    p = Platform()
    repl = tmp_path / "gnss.repl"
    repl.write_text("gnss: Sensors.ZedF9pUart @ sysbus\n    uart: usart2\n")
    p.mon.execute(f"machine LoadPlatformDescription {rn.file_arg(repl)}")
    p.run_program([], seconds="0.001")
    p.wr(USART2 + 0x0C, 104)                     # BRR: 4 MHz / 104 = 38462 baud
    p.wr(USART2 + 0x00, 0b1101)                  # CR1: UE, RE, TE
    yield p
    p.close()


def _rx(p) -> bytes:
    out = b""
    while p.rd(USART2 + 0x1C) & (1 << 5):
        out += bytes([p.rd(USART2 + 0x24) & 0xFF])
    return out


def test_on_uart_it_sends_one_character_time_apart(uart):
    """38400 8N1 is 3840 characters a second: 50 ms after the epoch, 192 of
    the epoch's bytes are in the MCU's RX (within one, the sync quantum);
    the rest follow."""
    assert int(uart.value(f"{UART_RX} BaudRate"), 0) == 38400
    uart.mon.execute(f"{UART_RX} SetPosition 404168000 -37038000 650000")
    uart.mon.execute('emulation RunFor "1.049"')       # to 1.050 s; the epoch at 1.000 s
    first = _rx(uart)
    assert abs(len(first) - 0.050 * 3840) <= 1, len(first)
    uart.mon.execute('emulation RunFor "0.5"')
    msgs = _messages(first + _rx(uart))
    assert [m[:5] for m in msgs] == ["GNRMC", "GNVTG", "GNGGA", "GNGSA", "GPGSV", "GPGSV", "GPGSV", "GNGLL"]
    assert _nmea(msgs, "GGA")[0][6] == "1"


def test_on_uart_the_mcus_tx_is_its_input(uart):
    """A VALSET written to the MCU's TDR is acknowledged on its RX; the baud
    rate it sets paces what follows."""
    for b in _valset([(0x40520001, 115200)]):      # CFG-UART1-BAUDRATE
        uart.wr(USART2 + 0x28, b)
    uart.mon.execute('emulation RunFor "0.01"')
    assert _messages(_rx(uart)) == [_ubx(0x05, 0x01, bytes([0x06, 0x8A]))]
    assert int(uart.value(f"{UART_RX} BaudRate"), 0) == 115200
    for b in _rtcm(1005, station=12) + b"$GNGGA,dummy*00\r\n":
        uart.wr(USART2 + 0x28, b)
    assert int(uart.value(f"{UART_RX} RtcmCount 1005"), 0) == 1
    assert int(uart.value(f"{UART_RX} NmeaInput"), 0) == 1


def test_a_correction_radio_on_uart2_gives_rtk(hub):
    """RTCM3 from a radio on UART2 (InjectUart2), position read on I2C: the
    usual RTK wiring. UART2 is open, so nothing queues there."""
    hub.mon.execute(f"{RX} SetPosition 404168000 -37038000 650000")
    hub.mon.execute(f"{RX} FixTimeS 0")
    frames = _rtcm(1005, station=401) + _rtcm(1077, length=40)
    hub.mon.execute(f'{RX} InjectUart2 "{frames.hex()}"')
    assert int(hub.value(f"{RX} RtcmCount 1077"), 0) == 1
    _run(hub, "1.01")
    gga = _nmea(I2c(hub).drain(), "GGA")[0]
    assert (gga[6], gga[14]) == ("4", "0401")
    assert int(hub.value(f"{RX} Uart2Pending"), 0) == 0


@pytest.fixture
def hub_uart2(tmp_path):
    """The receiver on I2C2, its UART2 on the MCU's USART2."""
    p = Platform()
    repl = tmp_path / "gnss.repl"
    repl.write_text(f"gnss_rx: Sensors.ZedF9pI2c @ i2c2 0x{ADDR:02X}\n    uart2: usart2\n")
    p.mon.execute(f"machine LoadPlatformDescription {rn.file_arg(repl)}")
    p.run_program([], seconds="0.001")
    p.wr(I2C2, 1)
    p.wr(USART2 + 0x0C, 104)
    p.wr(USART2 + 0x00, 0b1101)
    yield p
    p.close()


def test_uart2_on_a_board_uart_answers_there_and_sends_what_it_enables(hub_uart2):
    p = hub_uart2
    i2c = I2c(p)
    p.mon.execute(f"{RX} SetPosition 404168000 -37038000 650000")
    # A VALSET in on UART2: its ACK goes out on UART2, not on I2C.
    for b in _valset([(0x10760002, 1)] + [(k - 2, 0) for n, k in NMEA_SPI.items() if n != "GGA"]):
        p.wr(USART2 + 0x28, b)                   # CFG-UART2OUTPROT-NMEA on, GGA only
    p.mon.execute('emulation RunFor "0.01"')
    assert _messages(_rx(p)) == [_ubx(0x05, 0x01, bytes([0x06, 0x8A]))]
    assert i2c.waiting() == 0
    # The keys were UART2's (SPI's minus 2): I2C still sends the full set.
    # GGA's ~70 bytes take ~18 ms at 38400: read 50 ms after the epoch.
    p.mon.execute('emulation RunFor "1.04"')
    assert [m[:5] for m in _messages(_rx(p))] == ["GNGGA"]
    assert len(i2c.drain()) == 8
    assert int(p.value(f"{RX} Uart2BaudRate"), 0) == 38400


def test_uart2_sends_no_nmea_by_default(hub_uart2):
    hub_uart2.mon.execute('emulation RunFor "1.05"')
    assert _rx(hub_uart2) == b""
    assert len(I2c(hub_uart2).drain()) == 6, "no fix: one GSV"
