//
// u-blox ZED-F9P multi-band GNSS receiver with RTK, compiled by Renode at
// load time. One receiver, the port its D_SEL pin picks: I2C or UART1 (D_SEL
// high or open, ZedF9pI2c / ZedF9pUart; the chip has both at once, the model
// the one wired) or SPI (D_SEL low, ZedF9pSpi). In a platform description:
//
//     gnss_i2c: Sensors.ZedF9pI2c @ i2c2 0x42
//
//     gnss: Sensors.ZedF9pUart @ sysbus      // no address: sysbus.gnss
//         uart: usart2
//
//     gnss: Sensors.ZedF9pSpi @ spi1
//     gpioPortA:
//         4 -> gnss@0      // SPI CS, active low
//
// Sources: u-blox ZED-F9P Integration Manual (UBX-18010802, "Communication
// interfaces": I2C, SPI) and the F9 HPG Interface Description (UBX-22008968:
// UBX protocol, NMEA 4.11 messages, configuration items); RTCM 10403.3 for
// the correction framing. Key IDs cross-checked with SparkFun's
// u-blox_config_keys.h.
//
//   I2C ("DDC"): 7-bit address 0x42 (CFG-I2C-ADDRESS, default 0x84 as 8-bit).
//   Registers 0xFD/0xFE hold the number of bytes waiting (big-endian), 0xFF
//   is the data stream: a read there pops the next byte, 0xFF when empty.
//   A read starts at the current address, which auto-increments up to 0xFF
//   and stays there. A write of one byte sets the current address; a longer
//   write is message data for the receiver's input.
//   SPI (mode 0): full duplex while CS is low. Every byte clocked out is the
//   next one waiting, 0xFF when none; the bytes clocked in are the input,
//   where 0xFF outside a message is filler and dropped. With CS high MISO is
//   undriven: reads 0x00 (the vHIL's convention, as in Bmi088.cs).
//   UART1: 8N1 at CFG-UART1-BAUDRATE (default 38400). The MCU's TX is the
//   input; the output goes into the MCU's RX one character time (10 bits)
//   apart. Bytes are not checked against the host UART's rate, which is
//   logged once if it is more than 3 % off.
//
//   Output, every navigation epoch (CFG-RATE-MEAS, default 1000 ms; first
//   epoch one period after power-on), the messages CFG-MSGOUT enables for
//   the port: by default NMEA GGA, GLL, GSA, GSV, RMC and VTG (NMEA 4.11,
//   talker GN; GSV as GP, one signal); UBX NAV-PVT (0x01 0x07) once enabled
//   (CFG-MSGOUT-UBX_NAV_PVT_I2C/_SPI) or polled (empty payload).
//   CFG-<port>OUTPROT-NMEA/UBX gate each protocol. Positions in NMEA have
//   five decimals of a minute (CFG-NMEA-HIGHPREC off).
//
//   Input: UBX (checksummed; a bad checksum is dropped and counted), NMEA
//   (counted, otherwise ignored) and RTCM3 (0xD3 frames, CRC-24Q checked; a
//   bad CRC is dropped and counted), each if CFG-<port>INPROT allows it.
//   UBX handled: CFG-VALSET (0x06 0x8A, RAM layer applied; every key known
//   or the whole message is refused with ACK-NAK, as the receiver does),
//   CFG-VALGET (0x06 0x8B, RAM layer: answers with the values then ACK-ACK),
//   NAV-PVT poll. Any other UBX message logs a warning and, in class CFG,
//   is answered ACK-NAK.
//
//   RTK: the solution uses corrections when a reference station position
//   (RTCM 1005 or 1006) has arrived since power-on and an observation message
//   (1001-1004, 1009-1012, or an MSM: 1071-1137 with type % 10 in 1..7) is
//   younger than CFG-NAVSPG-CONSTR_DGNSSTO (default 60 s), with a 3D fix.
//   Then it is RTK float (GGA quality 5, posMode F, NAV-PVT carrSoln 1) and,
//   with CFG-NAVHPG-DGNSSMODE 3 (RTK fixed, the default; 2 is float only),
//   RTK fixed (quality 4, posMode R, carrSoln 2) after the corrections have
//   been continuous for FixTimeS (default 10 s). How long a real receiver
//   takes to fix ambiguities depends on the sky and the baseline; that value
//   is the model's, not a datasheet figure. GGA carries the corrections' age
//   and the station ID from the 1005/1006.
//
//   Accuracy (NAV-PVT hAcc/vAcc): standalone 1.5 m / 2.0 m, RTK fixed
//   0.01 m / 0.01 m (datasheet CEP figures); RTK float 0.2 m / 0.3 m is the
//   model's. No noise: the position reported is the one the test set.
//
// Not modelled: UART2 and USB (their keys are refused by CFG-VALSET), the
// TX-ready pin, timepulse, CFG-RST and save/load of configuration layers
// (BBR/flash), high-precision NMEA, the other UBX messages, RTCM output
// (base mode), satellite geometry (GSV lists PRNs 1..n with empty elevation,
// azimuth and C/N0), time to first fix (the fix is there as soon as the
// test sets a position) and the TX buffer's real size: the model keeps at
// most 8 kB waiting per port and drops whole messages beyond that (Dropped).
// A power-on (Reset) restores the default configuration and loses the
// corrections; the test's position, velocity and time base survive it.
//
// Test API (monitor), in NAV-PVT's integer units (the monitor parses a
// decimal argument as a 32-bit float): SetPosition(latDeg1e7, lonDeg1e7,
// hMslMm), ClearPosition() (no fix), SetVelocity(northMmS, eastMmS,
// downMmS), Satellites, GeoidSeparationMm, Hdop / Vdop / Pdop, FixTimeS,
// UtcStart (ISO 8601, default 2026-01-01T00:00:00Z; time is that plus
// virtual time), Solution
// ("none", "3d", "float", "fixed"), CorrectionsAge (s, -1 for none),
// StationId, RtcmCount(type), RtcmCrcErrors, UbxChecksumErrors, NmeaInput,
// Pending, Dropped, Config(key). On I2C also Respond (false: the address is
// NACKed, as an unpowered receiver does) and NackCount; on UART BaudRate.
//
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.I2C;
using Antmicro.Renode.Peripherals.SPI;
using Antmicro.Renode.Peripherals.Timers;
using Antmicro.Renode.Peripherals.UART;
using Antmicro.Renode.Time;

namespace Antmicro.Renode.Peripherals.Sensors
{
    // The receiver: configuration, epochs, the output queue and the input
    // parser. The port classes below only move bytes.
    public abstract class ZedF9p : IPeripheral
    {
        protected ZedF9p(IMachine machine, PortKind port)
        {
            this.machine = machine;
            this.port = port;
            Satellites = 12;
            Hdop = 0.8;
            Vdop = 1.1;
            Pdop = 1.4;
            FixTimeS = 10;
            UtcStart = "2026-01-01T00:00:00Z";
            epochTimer = new LimitTimer(machine.ClockSource, 1000, this, "epoch", limit: DefaultMeasMs,
                                        direction: Direction.Ascending, enabled: false,
                                        workMode: WorkMode.Periodic, eventEnabled: true);
            epochTimer.LimitReached += Epoch;
            Reset();
        }

        public virtual void Reset()
        {
            lock(sync)
            {
                config.Clear();
                foreach(var kv in Defaults())
                {
                    config[kv.Key] = kv.Value;
                }
                output.Clear();
                parser = Parse.Idle;
                frame.Clear();
                refStationSeen = false;
                lastObservation = null;
                StationId = 0;
                rtcmCounts.Clear();
                RtcmCrcErrors = 0;
                UbxChecksumErrors = 0;
                NmeaInput = 0;
                Dropped = 0;
                epochTimer.Reset();
                epochTimer.Limit = DefaultMeasMs;
                epochTimer.Enabled = true;
            }
        }

        // -- test API ----------------------------------------------------------

        // Integers, in NAV-PVT's units: the monitor parses a decimal argument
        // as a 32-bit float, 17 cm off at 40 deg latitude.
        public void SetPosition(long latDeg1e7, long lonDeg1e7, long hMslMm)
        {
            lock(sync)
            {
                lat = latDeg1e7 / 1e7;
                lon = lonDeg1e7 / 1e7;
                hMsl = hMslMm / 1000.0;
                if(!hasPosition)
                {
                    positionAt = NowS();
                }
                hasPosition = true;
            }
        }

        public void ClearPosition()
        {
            lock(sync)
            {
                hasPosition = false;
            }
        }

        public void SetVelocity(long northMmS, long eastMmS, long downMmS)
        {
            lock(sync)
            {
                velN = northMmS / 1000.0;
                velE = eastMmS / 1000.0;
                velD = downMmS / 1000.0;
            }
        }

        public int Satellites { get; set; }

        public long GeoidSeparationMm { get; set; }

        public double Hdop { get; set; }

        public double Vdop { get; set; }

        public double Pdop { get; set; }

        public double FixTimeS { get; set; }

        public string UtcStart
        {
            get => utcStart.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
            set => utcStart = DateTime.Parse(value, CultureInfo.InvariantCulture,
                                             DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal);
        }

        public string Solution
        {
            get
            {
                lock(sync)
                {
                    switch(CurrentSolution())
                    {
                    case Sol.None: return "none";
                    case Sol.Float: return "float";
                    case Sol.Fixed: return "fixed";
                    default: return "3d";
                    }
                }
            }
        }

        public double CorrectionsAge
        {
            get
            {
                lock(sync)
                {
                    return lastObservation.HasValue ? Math.Round(NowS() - lastObservation.Value, 3) : -1;
                }
            }
        }

        public int StationId { get; private set; }

        public int RtcmCount(int type)
        {
            return rtcmCounts.TryGetValue(type, out var n) ? n : 0;
        }

        public int RtcmCrcErrors { get; private set; }

        public int UbxChecksumErrors { get; private set; }

        public int NmeaInput { get; private set; }

        public int Pending
        {
            get { lock(sync) { return output.Count; } }
        }

        public int Dropped { get; private set; }

        public long Config(long key)
        {
            lock(sync)
            {
                return config.TryGetValue((uint)key, out var v) ? (long)v : -1;
            }
        }

        // -- the port's side ---------------------------------------------------

        // The next byte waiting, or null when none.
        protected byte? PopOutput()
        {
            lock(sync)
            {
                if(output.Count == 0)
                {
                    return null;
                }
                return output.Dequeue();
            }
        }

        protected int OutputCount()
        {
            lock(sync)
            {
                return output.Count;
            }
        }

        // One byte of the host's input stream.
        protected void Input(byte b)
        {
            lock(sync)
            {
                switch(parser)
                {
                case Parse.Idle:
                    frame.Clear();
                    if(b == 0xB5)
                    {
                        parser = Parse.Ubx;
                        frame.Add(b);
                    }
                    else if(b == 0xD3)
                    {
                        parser = Parse.Rtcm;
                        frame.Add(b);
                    }
                    else if(b == (byte)'$')
                    {
                        parser = Parse.Nmea;
                        frame.Add(b);
                    }
                    // Anything else between messages (0xFF filler) is dropped.
                    return;
                case Parse.Ubx:
                    frame.Add(b);
                    if(frame.Count == 2 && b != 0x62)
                    {
                        parser = Parse.Idle;
                    }
                    else if(frame.Count >= 6 && frame.Count == 8 + (frame[4] | (frame[5] << 8)))
                    {
                        parser = Parse.Idle;
                        UbxIn(frame.ToArray());
                    }
                    else if(frame.Count > MaxInput)
                    {
                        parser = Parse.Idle;
                    }
                    return;
                case Parse.Rtcm:
                    frame.Add(b);
                    if(frame.Count == 2 && (b & 0xFC) != 0)
                    {
                        // The six bits after the preamble are reserved, 0.
                        parser = Parse.Idle;
                    }
                    else if(frame.Count >= 3 && frame.Count == 6 + (((frame[1] & 0x03) << 8) | frame[2]))
                    {
                        parser = Parse.Idle;
                        RtcmIn(frame.ToArray());
                    }
                    return;
                default:
                    frame.Add(b);
                    if(b == (byte)'\n' || frame.Count > 82)
                    {
                        parser = Parse.Idle;
                        if(Enabled(PortKey(I2cInNmea, Uart1InNmea, SpiInNmea)))
                        {
                            NmeaInput++;
                        }
                    }
                    return;
                }
            }
        }

        // -- epochs ------------------------------------------------------------

        private void Epoch()
        {
            lock(sync)
            {
                var t = Utc();
                var sol = CurrentSolution();
                if(Enabled(PortKey(I2cOutNmea, Uart1OutNmea, SpiOutNmea)))
                {
                    // Order as the receiver sends them: RMC, VTG, GGA, GSA, GSV, GLL.
                    if(Enabled(MsgOut("RMC"))) Queue(Nmea(Rmc(t, sol)));
                    if(Enabled(MsgOut("VTG"))) Queue(Nmea(Vtg(sol)));
                    if(Enabled(MsgOut("GGA"))) Queue(Nmea(Gga(t, sol)));
                    if(Enabled(MsgOut("GSA"))) Queue(Nmea(Gsa(sol)));
                    if(Enabled(MsgOut("GSV")))
                    {
                        foreach(var s in Gsv(sol))
                        {
                            Queue(Nmea(s));
                        }
                    }
                    if(Enabled(MsgOut("GLL"))) Queue(Nmea(Gll(t, sol)));
                }
                if(Enabled(PortKey(I2cOutUbx, Uart1OutUbx, SpiOutUbx)) && Enabled(MsgOut(NavPvtI2c)))
                {
                    Queue(Ubx(0x01, 0x07, NavPvt(t, sol)));
                }
            }
        }

        // Corrections count once a reference station is known and the last
        // observation is younger than the timeout; the float-to-fixed clock
        // starts at the latest of: the observations' stream starting, the
        // station arriving, the fix arriving.
        private Sol CurrentSolution()
        {
            if(!hasPosition)
            {
                return Sol.None;
            }
            var now = NowS();
            var mode = config[DgnssMode];
            var usable = refStationSeen && lastObservation.HasValue
                         && now - lastObservation.Value <= config[DgnssTimeout] && (mode == 2 || mode == 3);
            if(!usable)
            {
                return Sol.Fix3d;
            }
            var since = Math.Max(streamStart, Math.Max(refStationAt, positionAt));
            return mode == 3 && now - since >= FixTimeS ? Sol.Fixed : Sol.Float;
        }

        // -- NMEA --------------------------------------------------------------

        private string Rmc(DateTime t, Sol sol)
        {
            var fix = sol != Sol.None;
            return "GNRMC," + Time(t) + "," + (fix ? "A" : "V") + "," + LatLon(fix) + ","
                   + (fix ? F(Knots(), 3) : "") + "," + (fix ? F(Course(), 2) : "") + ","
                   + t.ToString("ddMMyy", CultureInfo.InvariantCulture) + ",,," + PosMode(sol) + ",V";
        }

        private string Vtg(Sol sol)
        {
            var fix = sol != Sol.None;
            return "GNVTG," + (fix ? F(Course(), 2) : "") + ",T,,M," + (fix ? F(Knots(), 3) : "") + ",N,"
                   + (fix ? F(GroundSpeed() * 3.6, 3) : "") + ",K," + PosMode(sol);
        }

        private string Gga(DateTime t, Sol sol)
        {
            var fix = sol != Sol.None;
            var quality = sol == Sol.None ? 0 : sol == Sol.Float ? 5 : sol == Sol.Fixed ? 4 : 1;
            var corrected = sol == Sol.Float || sol == Sol.Fixed;
            return "GNGGA," + Time(t) + "," + LatLon(fix) + "," + quality + ","
                   + (fix ? Satellites : 0).ToString("00", CultureInfo.InvariantCulture) + ","
                   + (fix ? F(Hdop, 2) : "99.99") + ","
                   + (fix ? F(hMsl, 1) + ",M," + F(GeoidSeparationMm / 1000.0, 1) + ",M," : ",,,,")
                   + (corrected ? F(NowS() - lastObservation.Value, 1) + "," + StationId.ToString("0000", CultureInfo.InvariantCulture) : ",");
        }

        private string Gsa(Sol sol)
        {
            var fix = sol != Sol.None;
            var prns = Enumerable.Range(1, 12).Select(i => fix && i <= Satellites ? i.ToString("00", CultureInfo.InvariantCulture) : "");
            return "GNGSA,A," + (fix ? "3" : "1") + "," + string.Join(",", prns) + ","
                   + (fix ? F(Pdop, 2) + "," + F(Hdop, 2) + "," + F(Vdop, 2) : "99.99,99.99,99.99") + ",1";
        }

        private IEnumerable<string> Gsv(Sol sol)
        {
            var n = sol == Sol.None ? 0 : Satellites;
            var messages = Math.Max(1, (n + 3) / 4);
            for(var m = 0; m < messages; m++)
            {
                var s = new StringBuilder("GPGSV," + messages + "," + (m + 1) + "," + n.ToString("00", CultureInfo.InvariantCulture));
                for(var i = m * 4; i < Math.Min(n, m * 4 + 4); i++)
                {
                    s.Append("," + (i + 1).ToString("00", CultureInfo.InvariantCulture) + ",,,");
                }
                s.Append(",1");
                yield return s.ToString();
            }
        }

        private string Gll(DateTime t, Sol sol)
        {
            var fix = sol != Sol.None;
            return "GNGLL," + LatLon(fix) + "," + Time(t) + "," + (fix ? "A" : "V") + "," + PosMode(sol);
        }

        private static string PosMode(Sol sol)
        {
            switch(sol)
            {
            case Sol.None: return "N";
            case Sol.Float: return "F";
            case Sol.Fixed: return "R";
            default: return "A";
            }
        }

        private string LatLon(bool fix)
        {
            if(!fix)
            {
                return ",,,";
            }
            return Dm(Math.Abs(lat), 2) + "," + (lat < 0 ? "S" : "N") + "," + Dm(Math.Abs(lon), 3) + "," + (lon < 0 ? "W" : "E");
        }

        // ddmm.mmmmm / dddmm.mmmmm
        private static string Dm(double deg, int degDigits)
        {
            var d = (int)Math.Floor(deg);
            var m = Math.Round((deg - d) * 60.0, 5);
            if(m >= 60.0)
            {
                d++;
                m -= 60.0;
            }
            return d.ToString(new string('0', degDigits), CultureInfo.InvariantCulture)
                   + m.ToString("00.00000", CultureInfo.InvariantCulture);
        }

        private static string Time(DateTime t)
        {
            return t.ToString("HHmmss", CultureInfo.InvariantCulture) + "." + (t.Millisecond / 10).ToString("00", CultureInfo.InvariantCulture);
        }

        private static string F(double v, int decimals)
        {
            return v.ToString("F" + decimals, CultureInfo.InvariantCulture);
        }

        private static byte[] Nmea(string body)
        {
            byte cs = 0;
            foreach(var c in body)
            {
                cs ^= (byte)c;
            }
            return Encoding.ASCII.GetBytes("$" + body + "*" + cs.ToString("X2") + "\r\n");
        }

        private double GroundSpeed() => Math.Sqrt(velN * velN + velE * velE);

        private double Knots() => GroundSpeed() * 3600.0 / 1852.0;

        private double Course()
        {
            var c = Math.Atan2(velE, velN) * 180.0 / Math.PI;
            return c < 0 ? c + 360.0 : c;
        }

        // -- UBX ---------------------------------------------------------------

        private byte[] NavPvt(DateTime t, Sol sol)
        {
            var p = new byte[92];
            var fix = sol != Sol.None;
            var gps = t.AddSeconds(LeapSeconds) - GpsEpoch;
            Put(p, 0, (uint)((long)gps.TotalMilliseconds % (7L * 24 * 3600 * 1000)), 4);
            Put(p, 4, (uint)t.Year, 2);
            p[6] = (byte)t.Month;
            p[7] = (byte)t.Day;
            p[8] = (byte)t.Hour;
            p[9] = (byte)t.Minute;
            p[10] = (byte)t.Second;
            p[11] = (byte)(fix ? 0x07 : 0x00);                    // validDate, validTime, fullyResolved
            Put(p, 12, fix ? 30u : 0xFFFFFFFFu, 4);               // tAcc ns
            Put(p, 16, (uint)(t.Millisecond * 1000000), 4);       // nano
            p[20] = (byte)(fix ? 3 : 0);                          // fixType
            var carr = sol == Sol.Float ? 1 : sol == Sol.Fixed ? 2 : 0;
            p[21] = (byte)((fix ? 0x01 : 0) | (carr > 0 ? 0x02 : 0) | (carr << 6));
            p[22] = (byte)(fix ? 0xE0 : 0x00);                    // confirmedAvai/Date/Time
            p[23] = (byte)(fix ? Satellites : 0);
            if(fix)
            {
                Put(p, 24, (uint)(int)Math.Round(lon * 1e7), 4);
                Put(p, 28, (uint)(int)Math.Round(lat * 1e7), 4);
                Put(p, 32, (uint)(int)Math.Round(hMsl * 1000 + GeoidSeparationMm), 4);
                Put(p, 36, (uint)(int)Math.Round(hMsl * 1000), 4);
            }
            var acc = sol == Sol.Fixed ? new[] { 10u, 10u } : sol == Sol.Float ? new[] { 200u, 300u }
                      : fix ? new[] { 1500u, 2000u } : new[] { 0xFFFFFFFFu, 0xFFFFFFFFu };
            Put(p, 40, acc[0], 4);
            Put(p, 44, acc[1], 4);
            Put(p, 48, (uint)(int)Math.Round(velN * 1000), 4);
            Put(p, 52, (uint)(int)Math.Round(velE * 1000), 4);
            Put(p, 56, (uint)(int)Math.Round(velD * 1000), 4);
            Put(p, 60, (uint)(int)Math.Round(GroundSpeed() * 1000), 4);
            Put(p, 64, (uint)(int)Math.Round(Course() * 1e5), 4);
            Put(p, 68, fix ? 50u : 0xFFFFFFFFu, 4);               // sAcc mm/s
            Put(p, 72, fix ? 500000u : 0xFFFFFFFFu, 4);           // headAcc 1e-5 deg
            Put(p, 76, (uint)Math.Round((fix ? Pdop : 99.99) * 100), 2);
            return p;
        }

        private void UbxIn(byte[] m)
        {
            byte a = 0, b = 0;
            for(var i = 2; i < m.Length - 2; i++)
            {
                a += m[i];
                b += a;
            }
            if(a != m[m.Length - 2] || b != m[m.Length - 1])
            {
                UbxChecksumErrors++;
                this.Log(LogLevel.Warning, "UBX message with a bad checksum dropped");
                return;
            }
            if(!Enabled(PortKey(I2cInUbx, Uart1InUbx, SpiInUbx)))
            {
                return;
            }
            var cls = m[2];
            var id = m[3];
            var payload = new byte[m.Length - 8];
            Array.Copy(m, 6, payload, 0, payload.Length);
            if(cls == 0x06 && id == 0x8A)
            {
                Ack(cls, id, ValSet(payload));
            }
            else if(cls == 0x06 && id == 0x8B)
            {
                var reply = ValGet(payload);
                if(reply != null)
                {
                    Queue(Ubx(0x06, 0x8B, reply));
                }
                Ack(cls, id, reply != null);
            }
            else if(cls == 0x01 && id == 0x07 && payload.Length == 0)
            {
                Queue(Ubx(0x01, 0x07, NavPvt(Utc(), CurrentSolution())));
            }
            else
            {
                this.Log(LogLevel.Warning, "UBX message 0x{0:X2} 0x{1:X2} ({2} bytes) not modelled", cls, id, payload.Length);
                if(cls == 0x06)
                {
                    Ack(cls, id, false);
                }
            }
        }

        // version 0, layers, 2 reserved, then key (U4) / value pairs.
        private bool ValSet(byte[] p)
        {
            if(p.Length < 4 || p[0] != 0x00 || (p[1] & 0x01) == 0)
            {
                // Only the RAM layer is modelled (bit 0); BBR/flash alone are refused.
                this.Log(LogLevel.Warning, "CFG-VALSET without the RAM layer (layers 0x{0:X2}) refused", p.Length > 1 ? p[1] : 0);
                return false;
            }
            var changes = new Dictionary<uint, ulong>();
            var i = 4;
            while(i < p.Length)
            {
                if(i + 4 > p.Length)
                {
                    return false;
                }
                var key = (uint)Get(p, i, 4);
                var size = Size(key);
                if(!Known.Contains(key) || size == 0 || i + 4 + size > p.Length)
                {
                    this.Log(LogLevel.Warning, "CFG-VALSET key 0x{0:X8} not modelled; message refused", key);
                    return false;
                }
                changes[key] = Get(p, i + 4, size);
                i += 4 + size;
            }
            foreach(var kv in changes)
            {
                config[kv.Key] = kv.Value;
            }
            epochTimer.Limit = Math.Max(25UL, config[RateMeas]);
            ConfigChanged();
            return true;
        }

        // version 0, layer, position U2, keys (U4 each). RAM layer only.
        private byte[] ValGet(byte[] p)
        {
            if(p.Length < 8 || p[0] != 0x00 || p[1] != 0x00 || (p.Length - 4) % 4 != 0)
            {
                return null;
            }
            var reply = new List<byte> { 0x01, 0x00, p[2], p[3] };
            for(var i = 4; i < p.Length; i += 4)
            {
                var key = (uint)Get(p, i, 4);
                if(!Known.Contains(key))
                {
                    this.Log(LogLevel.Warning, "CFG-VALGET key 0x{0:X8} not modelled", key);
                    return null;
                }
                var size = Size(key);
                var buf = new byte[4 + size];
                Put(buf, 0, key, 4);
                Put(buf, 4, (uint)config[key], size);
                reply.AddRange(buf);
            }
            return reply.ToArray();
        }

        private void Ack(byte cls, byte id, bool ok)
        {
            Queue(Ubx(0x05, (byte)(ok ? 0x01 : 0x00), new[] { cls, id }));
        }

        private static byte[] Ubx(byte cls, byte id, byte[] payload)
        {
            var m = new byte[payload.Length + 8];
            m[0] = 0xB5;
            m[1] = 0x62;
            m[2] = cls;
            m[3] = id;
            m[4] = (byte)payload.Length;
            m[5] = (byte)(payload.Length >> 8);
            Array.Copy(payload, 0, m, 6, payload.Length);
            byte a = 0, b = 0;
            for(var i = 2; i < m.Length - 2; i++)
            {
                a += m[i];
                b += a;
            }
            m[m.Length - 2] = a;
            m[m.Length - 1] = b;
            return m;
        }

        // A key's value size from its size bits (28..30): 1 bit (stored in a
        // byte), 1, 2, 4 or 8 bytes.
        private static int Size(uint key)
        {
            switch((key >> 28) & 0x7)
            {
            case 1:
            case 2: return 1;
            case 3: return 2;
            case 4: return 4;
            case 5: return 8;
            default: return 0;
            }
        }

        // -- RTCM3 -------------------------------------------------------------

        private void RtcmIn(byte[] m)
        {
            var n = m.Length - 3;
            var crc = Crc24q(m, n);
            if(crc != (uint)((m[n] << 16) | (m[n + 1] << 8) | m[n + 2]))
            {
                RtcmCrcErrors++;
                this.Log(LogLevel.Warning, "RTCM3 frame with a bad CRC dropped");
                return;
            }
            if(!Enabled(PortKey(I2cInRtcm, Uart1InRtcm, SpiInRtcm)) || n < 5)
            {
                return;
            }
            var type = (m[3] << 4) | (m[4] >> 4);
            rtcmCounts[type] = RtcmCount(type) + 1;
            var now = NowS();
            if(type == 1005 || type == 1006)
            {
                if(!refStationSeen)
                {
                    refStationAt = now;
                }
                refStationSeen = true;
                StationId = ((m[4] & 0x0F) << 8) | (n > 5 ? m[5] : 0);
            }
            else if((type >= 1001 && type <= 1004) || (type >= 1009 && type <= 1012)
                    || (type >= 1071 && type <= 1137 && type % 10 >= 1 && type % 10 <= 7))
            {
                if(!lastObservation.HasValue || now - lastObservation.Value > config[DgnssTimeout])
                {
                    streamStart = now;
                }
                lastObservation = now;
            }
        }

        private static uint Crc24q(byte[] data, int length)
        {
            uint crc = 0;
            for(var i = 0; i < length; i++)
            {
                crc ^= (uint)data[i] << 16;
                for(var bit = 0; bit < 8; bit++)
                {
                    crc <<= 1;
                    if((crc & 0x1000000) != 0)
                    {
                        crc ^= 0x1864CFB;
                    }
                }
            }
            return crc & 0xFFFFFF;
        }

        // -- helpers -----------------------------------------------------------

        private void Queue(byte[] message)
        {
            if(output.Count + message.Length > MaxOutput)
            {
                Dropped++;
                return;
            }
            foreach(var b in message)
            {
                output.Enqueue(b);
            }
            OutputQueued();
        }

        // Called with bytes newly waiting (the lock held): a port that sends
        // by itself (UART) starts sending.
        protected virtual void OutputQueued()
        {
        }

        // A configuration change applied (the lock held).
        protected virtual void ConfigChanged()
        {
        }

        protected ulong ConfigValue(uint key)
        {
            return config[key];
        }

        private bool Enabled(uint key) => config.TryGetValue(key, out var v) && v != 0;

        // A message's CFG-MSGOUT keys run I2C, UART1, UART2, USB, SPI: the
        // I2C key plus the port's offset.
        private uint MsgOut(uint i2cKey) => i2cKey + (port == PortKind.Spi ? 4u : port == PortKind.Uart1 ? 1u : 0u);

        private uint MsgOut(string nmea) => MsgOut(NmeaI2c[nmea]);

        private uint PortKey(uint i2c, uint uart1, uint spiKey) => port == PortKind.Spi ? spiKey : port == PortKind.Uart1 ? uart1 : i2c;

        private static readonly Dictionary<string, uint> NmeaI2c = new Dictionary<string, uint>
        {
            { "GGA", 0x209100BA }, { "RMC", 0x209100AB }, { "GLL", 0x209100C9 },
            { "GSA", 0x209100BF }, { "GSV", 0x209100C4 }, { "VTG", 0x209100B0 },
        };

        private double NowS() => machine.ElapsedVirtualTime.TimeElapsed.TotalMicroseconds / 1e6;

        private DateTime Utc() => utcStart.AddSeconds(NowS());

        private static void Put(byte[] p, int at, uint v, int size)
        {
            for(var i = 0; i < size; i++)
            {
                p[at + i] = (byte)(v >> (8 * i));
            }
        }

        private static ulong Get(byte[] p, int at, int size)
        {
            ulong v = 0;
            for(var i = 0; i < size; i++)
            {
                v |= (ulong)p[at + i] << (8 * i);
            }
            return v;
        }

        private static Dictionary<uint, ulong> Defaults()
        {
            var d = new Dictionary<uint, ulong>
            {
                { RateMeas, DefaultMeasMs }, { RateNav, 1 }, { DgnssMode, 3 }, { DgnssTimeout, 60 },
                { I2cInUbx, 1 }, { I2cInNmea, 1 }, { I2cInRtcm, 1 }, { I2cOutUbx, 1 }, { I2cOutNmea, 1 },
                { Uart1InUbx, 1 }, { Uart1InNmea, 1 }, { Uart1InRtcm, 1 }, { Uart1OutUbx, 1 }, { Uart1OutNmea, 1 },
                { SpiInUbx, 1 }, { SpiInNmea, 1 }, { SpiInRtcm, 1 }, { SpiOutUbx, 1 }, { SpiOutNmea, 1 },
                { I2cAddress, 0x84 }, { Uart1Baud, DefaultBaud },
            };
            // NAV-PVT off and the six NMEA messages on, on every modelled port.
            foreach(var offset in new uint[] { 0, 1, 4 })
            {
                d[NavPvtI2c + offset] = 0;
                foreach(var k in NmeaI2c.Values)
                {
                    d[k + offset] = 1;
                }
            }
            return d;
        }

        private static readonly HashSet<uint> Known = new HashSet<uint>(Defaults().Keys);

        private const uint RateMeas = 0x30210001;       // U2 ms
        private const uint RateNav = 0x30210002;        // U2 epochs per solution (kept, not applied)
        private const uint DgnssMode = 0x20140011;      // E1: 2 RTK float, 3 RTK fixed
        private const uint DgnssTimeout = 0x201100C4;   // U1 s
        private const uint I2cInUbx = 0x10710001, I2cInNmea = 0x10710002, I2cInRtcm = 0x10710004;
        private const uint I2cOutUbx = 0x10720001, I2cOutNmea = 0x10720002;
        private const uint SpiInUbx = 0x10790001, SpiInNmea = 0x10790002, SpiInRtcm = 0x10790004;
        private const uint SpiOutUbx = 0x107A0001, SpiOutNmea = 0x107A0002;
        private const uint Uart1InUbx = 0x10730001, Uart1InNmea = 0x10730002, Uart1InRtcm = 0x10730004;
        private const uint Uart1OutUbx = 0x10740001, Uart1OutNmea = 0x10740002;
        protected const uint Uart1Baud = 0x40520001;    // U4 baud
        protected const ulong DefaultBaud = 38400;
        private const uint NavPvtI2c = 0x20910006;
        private const uint I2cAddress = 0x20510001;     // kept; the address is the platform's
        private const ulong DefaultMeasMs = 1000;
        private const int MaxOutput = 8192;
        private const int MaxInput = 4096;
        private const int LeapSeconds = 18;             // GPS - UTC since 2017
        private static readonly DateTime GpsEpoch = new DateTime(1980, 1, 6, 0, 0, 0, DateTimeKind.Utc);

        private readonly IMachine machine;
        private readonly PortKind port;
        private readonly LimitTimer epochTimer;
        private readonly object sync = new object();
        private readonly Dictionary<uint, ulong> config = new Dictionary<uint, ulong>();
        private readonly Queue<byte> output = new Queue<byte>();
        private readonly List<byte> frame = new List<byte>();
        private readonly Dictionary<int, int> rtcmCounts = new Dictionary<int, int>();
        private DateTime utcStart;
        private Parse parser;
        private bool hasPosition;
        private double lat, lon, hMsl, velN, velE, velD;
        private bool refStationSeen;
        private double? lastObservation;
        private double streamStart, refStationAt, positionAt;

        protected enum PortKind
        {
            I2c,
            Uart1,
            Spi,
        }

        private enum Parse
        {
            Idle,
            Ubx,
            Rtcm,
            Nmea,
        }

        private enum Sol
        {
            None,
            Fix3d,
            Float,
            Fixed,
        }
    }

    // The receiver on I2C (D_SEL high): one target at 0x42. Header: protocol.
    public class ZedF9pI2c : ZedF9p, II2CPeripheral, II2CStartCondition
    {
        public ZedF9pI2c(IMachine machine) : base(machine, PortKind.I2c)
        {
            Respond = true;
        }

        public override void Reset()
        {
            base.Reset();
            address = 0xFF;
            pending.Clear();
        }

        public bool OnStart(bool read)
        {
            if(!Respond)
            {
                NackCount++;
                return false;
            }
            EndWrite();
            return true;
        }

        // The master hands a write over a byte at a time: what one write
        // means is known when it ends (a repeated START or a STOP).
        public void Write(byte[] data)
        {
            pending.AddRange(data);
        }

        public byte[] Read(int count = 1)
        {
            var result = new byte[count];
            for(var i = 0; i < count; i++)
            {
                if(address == 0xFF)
                {
                    result[i] = PopOutput() ?? 0xFF;
                    continue;
                }
                var n = OutputCount();
                result[i] = address == 0xFD ? (byte)(n >> 8) : address == 0xFE ? (byte)n : (byte)0;
                address++;
            }
            return result;
        }

        public void FinishTransmission()
        {
            EndWrite();
        }

        public bool Respond { get; set; }

        public int NackCount { get; private set; }

        private void EndWrite()
        {
            if(pending.Count == 1)
            {
                address = pending[0];
            }
            else
            {
                foreach(var b in pending)
                {
                    Input(b);
                }
            }
            pending.Clear();
        }

        private readonly List<byte> pending = new List<byte>();
        private byte address;
    }

    // The receiver's UART1 (D_SEL high or open), on the MCU's UART: the MCU's
    // TX is the receiver's input, and the receiver sends its bytes into the
    // MCU's RX one character time apart (8N1: 10 bits at CFG-UART1-BAUDRATE,
    // default 38400), as the line would; a byte the MCU's USART is not
    // enabled to take is lost there, as on the chip. A VALSET of the baud
    // rate changes the pace at once (the host must follow, as on the chip);
    // a host UART at another rate (beyond 3 %) is logged once per rate.
    public class ZedF9pUart : ZedF9p
    {
        public ZedF9pUart(IMachine machine, IUART uart) : base(machine, PortKind.Uart1)
        {
            this.uart = uart;
            sendTimer = new LimitTimer(machine.ClockSource, (long)DefaultBaud, this, "uart1", limit: 10,
                                       direction: Direction.Ascending, enabled: false,
                                       workMode: WorkMode.Periodic, eventEnabled: true);
            sendTimer.LimitReached += SendNext;
            uart.CharReceived += Input;
            Reset();
        }

        public override void Reset()
        {
            base.Reset();
            if(sendTimer != null)
            {
                sendTimer.Reset();
                sendTimer.Frequency = DefaultBaud;
                sendTimer.Limit = 10;
            }
        }

        public long BaudRate => (long)sendTimer.Frequency;

        protected override void OutputQueued()
        {
            if(sendTimer != null && !sendTimer.Enabled)
            {
                sendTimer.Value = 0;
                sendTimer.Enabled = true;
            }
        }

        protected override void ConfigChanged()
        {
            sendTimer.Frequency = Math.Max(1UL, ConfigValue(Uart1Baud));
        }

        private void SendNext()
        {
            var b = PopOutput();
            if(!b.HasValue)
            {
                sendTimer.Enabled = false;
                return;
            }
            var host = (long)uart.BaudRate;
            var rate = (long)sendTimer.Frequency;
            if(host > 0 && Math.Abs(host - rate) * 100 > 3 * rate && host != warnedBaud)
            {
                warnedBaud = host;
                this.Log(LogLevel.Warning, "Host UART at {0} baud, receiver at {1}: the bytes would arrive garbled",
                         host, rate);
            }
            uart.WriteChar(b.Value);
        }

        private readonly IUART uart;
        private readonly LimitTimer sendTimer;
        private long warnedBaud;
    }

    // The receiver on SPI (D_SEL low): GPIO input 0 is CS, active low.
    public class ZedF9pSpi : ZedF9p, ISPIPeripheral, IGPIOReceiver
    {
        public ZedF9pSpi(IMachine machine) : base(machine, PortKind.Spi)
        {
        }

        public void OnGPIO(int number, bool value)
        {
            if(number != 0)
            {
                this.Log(LogLevel.Warning, "No GPIO input {0}: 0 is CS", number);
                return;
            }
            csHigh = value;
        }

        public byte Transmit(byte data)
        {
            if(csHigh)
            {
                return 0;
            }
            var out_ = PopOutput() ?? 0xFF;
            Input(data);
            return out_;
        }

        public void FinishTransmission()
        {
        }

        // Renode's GPIO starts low: selected until the MCU drives CS high.
        private bool csHigh;
    }
}
