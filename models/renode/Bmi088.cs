//
// Bosch BMI088 6-axis IMU: two dies in one package, compiled by Renode at
// load time. On I2C each die is its own target; on SPI the package is one
// slave with a chip select per die (Bmi088Spi, below). In a platform
// description:
//
//     imu_acc: Sensors.Bmi088Accelerometer @ i2c2_h7 0x18
//     imu_gyr: Sensors.Bmi088Gyroscope @ i2c2_h7 0x68
//
//     imu: Sensors.Bmi088Spi @ spi3
//     gpioPortC:
//         4 -> imu@0      // CSB1, the accelerometer
//         5 -> imu@1      // CSB2, the gyroscope
//
// Source: Bosch BMI088 datasheet (BST-BMI088-DS001); register names are its
// register maps', sections its chapters (3 Quick Start Guide, 4 Functional
// Description, 5 Register Description, 6 Digital Interfaces).
//
//   I2C (ch. 6): 7-bit addresses 0x18/0x19 (accelerometer, SDO1 low/high)
//   and 0x68/0x69 (gyroscope, SDO2 low/high). A write's first byte is the
//   register address; further bytes, and the bytes of a read after a
//   repeated START, go to/come from consecutive registers (auto-increment).
//   The accelerometer's dummy byte applies to SPI reads only, not to I2C.
//
//   SPI (ch. 6.1, mode 0 or 3): a transaction is the chip select's low
//   window. Its first byte is the register address with bit 7 set for a read
//   (the Bosch BMI08x API's BMI08_SPI_RD_MASK 0x80); a write's next bytes,
//   and a read's, go to/come from consecutive registers. On an accelerometer
//   read the first byte after the address is a dummy byte, then the data;
//   the gyroscope sends data at once. The accelerometer starts in I2C mode
//   and switches to SPI on a rising edge of CSB1, until the next power-on
//   (ch. 6.1); a soft reset puts it back, which is why the BMI08x API
//   repeats the dummy read after one (bmi08a.c bmi08a_soft_reset). Until
//   then it ignores SPI. Bytes the chip does not drive (the address byte's,
//   the dummy byte, an ignored or unpowered die) read 0x00.
//   Chip IDs (ch. 5, ACC_CHIP_ID / GYRO_CHIP_ID, reg 0x00): 0x1E and 0x0F.
//   Accelerometer power (ch. 3 and ch. 4 power modes): after power-on it is
//   suspended (ACC_PWR_CONF 0x7C = 0x03) and off (ACC_PWR_CTRL 0x7D = 0x00);
//   it converts with ACC_PWR_CONF = 0x00 (active) and ACC_PWR_CTRL = 0x04
//   (on). Until then its data registers hold their reset value, 0.
//   Accelerometer data (ch. 5, ACC_X_LSB..ACC_Z_MSB, 0x12..0x17, little-endian
//   int16): mg = counts / 32768 * 1000 * 2^(ACC_RANGE + 1) * 1.5, ACC_RANGE
//   (0x41, reset 0x01) 0..3 = +/-3/6/12/24 g. ACC_CONF (0x40, reset 0xA8)
//   holds bandwidth/ODR. ACC_STATUS (0x03) bit 7 and ACC_INT_STAT_1 (0x1D)
//   bit 7: data ready. ACC_ERR_REG (0x02): no error. ACC_SOFTRESET (0x7E) <-
//   0xB6.
//   Gyroscope (ch. 5): GYRO_RANGE (0x0F, reset 0x00) 0..4 = +/-2000/1000/500/
//   250/125 dps at 16.384/32.768/65.536/131.072/262.144 LSB/dps;
//   RATE_X_LSB..RATE_Z_MSB 0x02..0x07, little-endian int16; GYRO_BANDWIDTH
//   (0x10, reset 0x80) bit 7 always reads 1; GYRO_LPM1 (0x11, reset 0x00) =
//   normal, 0x80 suspend, 0x20 deep suspend, and only normal mode converts;
//   GYRO_INT_STAT_1 0x0A; GYRO_SOFTRESET 0x14 <- 0xB6. The gyroscope starts
//   in normal mode.
//
// Each read returns the value the test set, converted at the range in force:
// no noise, no filtering, no ODR quantisation and no start-up settling (the
// firmware only waits fixed delays). Registers this model does not hold
// (temperature, sensor time, interrupt pins, FIFO, self-test) read 0 and are
// logged as Renode logs an unmodelled register, so the peripheral guard
// fails a run that reads or writes one.
//
// Test API on SPI (Bmi088Spi): SetAcceleration, SetAngularRate,
// AccelerometerResponds / GyroscopeResponds (false: the die never drives
// MISO and ignores writes), AccelerometerSpiMode, AccelerometerReadCount /
// GyroscopeReadCount(register), AccelerometerRegister / GyroscopeRegister.
//
// Test API on I2C, per die (monitor): SetAcceleration(xMg, yMg, zMg) on the
// accelerometer, SetAngularRate(xDps, yDps, zDps) on the gyroscope; on
// both: Respond (false: the die NACKs its address, as an unpowered or missing
// chip does), ReadCount(register) (reads that started at that register),
// NackCount, RegisterValue(register). What the test set survives a reset;
// the registers do not.
//
using System;
using System.Collections.Generic;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.I2C;
using Antmicro.Renode.Peripherals.SPI;

namespace Antmicro.Renode.Peripherals.Sensors
{
    public abstract class Bmi088Die : II2CPeripheral, II2CStartCondition
    {
        protected Bmi088Die()
        {
            Respond = true;
            Reset();
        }

        public void Reset()
        {
            Array.Clear(registers, 0, registers.Length);
            ResetRegisters();
            Array.Clear(held, 0, held.Length);
            pointer = 0;
            expectRegister = true;
        }

        public bool OnStart(bool read)
        {
            if(!Respond)
            {
                NackCount++;
                return false;
            }
            if(!read)
            {
                expectRegister = true;
            }
            return true;
        }

        public void Write(byte[] data)
        {
            foreach(var b in data)
            {
                if(expectRegister)
                {
                    Point(b);
                    expectRegister = false;
                    continue;
                }
                WriteNext(b);
            }
        }

        public byte[] Read(int count = 1)
        {
            BeginRead();
            var result = new byte[count];
            for(var i = 0; i < count; i++)
            {
                result[i] = ReadNext();
            }
            expectRegister = true;
            return result;
        }

        public void FinishTransmission()
        {
            expectRegister = true;
        }

        public bool Respond { get; set; }

        public int NackCount { get; private set; }

        public int ReadCount(int register)
        {
            return readCounts.TryGetValue(register, out var n) ? n : 0;
        }

        public int RegisterValue(int register)
        {
            return registers[register & 0x7F];
        }

        // The register access both interfaces share: point at a register,
        // start a read (the data registers latch one conversion for the whole
        // burst), then read or write consecutive registers.
        internal void Point(int register)
        {
            pointer = register & 0x7F;
        }

        internal void BeginRead()
        {
            readCounts.TryGetValue(pointer, out var n);
            readCounts[pointer] = n + 1;
            if(Converting)
            {
                Convert(held);
            }
        }

        internal byte ReadNext()
        {
            var value = ReadRegister(pointer);
            pointer = (pointer + 1) & 0x7F;
            return value;
        }

        internal void WriteNext(byte value)
        {
            WriteRegister(pointer, value);
            pointer = (pointer + 1) & 0x7F;
        }

        // On SPI the dies are not peripherals of their own: they log as the
        // package (Bmi088Spi), so the peripheral guard names it.
        internal IPeripheral Owner { get; set; }

        // Register file contents at power-on.
        protected abstract void ResetRegisters();

        protected abstract bool Converting { get; }

        // The three axes, in counts, at the range in force.
        protected abstract void Convert(short[] counts);

        // First data register (X LSB) of the six.
        protected abstract int DataRegister { get; }

        // Register-specific reads; null for a register the die does not hold.
        protected abstract byte? ReadOther(int register);

        // Register-specific writes; false for a register the die does not take.
        protected abstract bool WriteOther(int register, byte value);

        protected static short Saturate(double counts)
        {
            return (short)Math.Max(short.MinValue, Math.Min(short.MaxValue, Math.Round(counts)));
        }

        protected readonly byte[] registers = new byte[0x80];

        private byte ReadRegister(int register)
        {
            if(register >= DataRegister && register < DataRegister + 6)
            {
                var axis = held[(register - DataRegister) / 2];
                return (byte)(((register - DataRegister) % 2 == 0) ? axis & 0xFF : (axis >> 8) & 0xFF);
            }
            var value = ReadOther(register);
            if(value.HasValue)
            {
                return value.Value;
            }
            LogAs().Log(LogLevel.Warning, "Unhandled read from offset 0x{0:X2}{1}", register, Die);
            return 0;
        }

        private void WriteRegister(int register, byte value)
        {
            if(!WriteOther(register, value))
            {
                LogAs().Log(LogLevel.Warning, "Unhandled write to offset 0x{0:X2}, value 0x{1:X2}{2}", register, value, Die);
            }
        }

        private IPeripheral LogAs() => Owner ?? this;

        private string Die => Owner == null ? "" : $" ({GetType().Name})";

        private readonly short[] held = new short[3];
        private readonly Dictionary<int, int> readCounts = new Dictionary<int, int>();
        private int pointer;
        private bool expectRegister;

        protected const byte SoftResetCommand = 0xB6;
    }

    public class Bmi088Accelerometer : Bmi088Die
    {
        public void SetAcceleration(double xMg, double yMg, double zMg)
        {
            mg[0] = xMg;
            mg[1] = yMg;
            mg[2] = zMg;
        }

        // Whether the die listens on SPI: from a rising edge of CSB1 until a
        // power-on or a soft reset (header).
        internal bool SpiMode { get; set; }

        // Lying flat at rest: 1 g along +Z.
        private readonly double[] mg = { 0, 0, 1000 };

        protected override void ResetRegisters()
        {
            SpiMode = false;
            registers[ChipId] = 0x1E;
            registers[Conf] = 0xA8;
            registers[Range] = 0x01;
            registers[PwrConf] = 0x03;
            registers[PwrCtrl] = 0x00;
        }

        protected override bool Converting => registers[PwrConf] == 0x00 && registers[PwrCtrl] == 0x04;

        protected override void Convert(short[] counts)
        {
            var fullScaleMg = 1000.0 * (1 << (registers[Range] + 1)) * 1.5;
            for(var i = 0; i < 3; i++)
            {
                counts[i] = Saturate(mg[i] / fullScaleMg * 32768.0);
            }
        }

        protected override int DataRegister => 0x12;

        protected override byte? ReadOther(int register)
        {
            switch(register)
            {
            case ChipId:
            case Conf:
            case Range:
            case PwrConf:
            case PwrCtrl:
                return registers[register];
            case ErrReg:
                return 0;
            case Status:
            case IntStat1:
                return (byte)(Converting ? 0x80 : 0x00);
            default:
                return null;
            }
        }

        protected override bool WriteOther(int register, byte value)
        {
            switch(register)
            {
            case Conf:
            case PwrConf:
            case PwrCtrl:
                registers[register] = value;
                return true;
            case Range:
                registers[register] = (byte)(value & 0x03);
                return true;
            case SoftReset:
                if(value == SoftResetCommand)
                {
                    ResetRegisters();
                }
                return true;
            default:
                return false;
            }
        }

        private const int ChipId = 0x00;
        private const int ErrReg = 0x02;
        private const int Status = 0x03;
        private const int IntStat1 = 0x1D;
        private const int Conf = 0x40;
        private const int Range = 0x41;
        private const int PwrConf = 0x7C;
        private const int PwrCtrl = 0x7D;
        private const int SoftReset = 0x7E;
    }

    public class Bmi088Gyroscope : Bmi088Die
    {
        public void SetAngularRate(double xDps, double yDps, double zDps)
        {
            dps[0] = xDps;
            dps[1] = yDps;
            dps[2] = zDps;
        }

        private readonly double[] dps = { 0, 0, 0 };

        protected override void ResetRegisters()
        {
            registers[ChipId] = 0x0F;
            registers[Range] = 0x00;
            registers[Bandwidth] = 0x80;
            registers[Lpm1] = 0x00;
        }

        protected override bool Converting => registers[Lpm1] == 0x00;

        protected override void Convert(short[] counts)
        {
            var fullScaleDps = 2000.0 / (1 << Math.Min((int)registers[Range], 4));
            for(var i = 0; i < 3; i++)
            {
                counts[i] = Saturate(dps[i] / fullScaleDps * 32768.0);
            }
        }

        protected override int DataRegister => 0x02;

        protected override byte? ReadOther(int register)
        {
            switch(register)
            {
            case ChipId:
            case Range:
            case Lpm1:
                return registers[register];
            case Bandwidth:
                return (byte)(registers[register] | 0x80);
            case IntStat1:
                return (byte)(Converting ? 0x80 : 0x00);
            default:
                return null;
            }
        }

        protected override bool WriteOther(int register, byte value)
        {
            switch(register)
            {
            case Range:
                if(value > 0x04)
                {
                    this.Log(LogLevel.Warning, "GYRO_RANGE 0x{0:X2} is reserved; kept 0x{1:X2}", value, registers[Range]);
                    return true;
                }
                registers[register] = value;
                return true;
            case Bandwidth:
                registers[register] = (byte)(value | 0x80);
                return true;
            case Lpm1:
                registers[register] = value;
                return true;
            case SoftReset:
                if(value == SoftResetCommand)
                {
                    ResetRegisters();
                }
                return true;
            default:
                return false;
            }
        }

        private const int ChipId = 0x00;
        private const int IntStat1 = 0x0A;
        private const int Range = 0x0F;
        private const int Bandwidth = 0x10;
        private const int Lpm1 = 0x11;
        private const int SoftReset = 0x14;
    }

    // The package on SPI: one slave on the controller, the dies picked by
    // their chip selects (GPIO inputs 0 = CSB1, the accelerometer, and 1 =
    // CSB2, the gyroscope; active low). Header: protocol and test API.
    public class Bmi088Spi : ISPIPeripheral, IGPIOReceiver
    {
        public Bmi088Spi()
        {
            acc = new Bmi088Accelerometer { Owner = this };
            gyr = new Bmi088Gyroscope { Owner = this };
            dies = new Bmi088Die[] { acc, gyr };
            Reset();
        }

        public void Reset()
        {
            // The chip select levels are the MCU's pins: they keep their state.
            acc.Reset();
            gyr.Reset();
            phase = Phase.Address;
        }

        public void OnGPIO(int number, bool value)
        {
            if(number < 0 || number > 1)
            {
                this.Log(LogLevel.Warning, "No chip select {0}: 0 is CSB1, 1 is CSB2", number);
                return;
            }
            if(csHigh[number] == value)
            {
                return;
            }
            csHigh[number] = value;
            // Either edge ends one transaction; a falling one starts the next.
            phase = Phase.Address;
            if(value && number == 0)
            {
                acc.SpiMode = true;
            }
        }

        public byte Transmit(byte data)
        {
            var die = Selected();
            if(die == null)
            {
                return 0;
            }
            switch(phase)
            {
            case Phase.Address:
                die.Point(data);
                if((data & 0x80) != 0)
                {
                    die.BeginRead();
                    phase = die == acc ? Phase.Dummy : Phase.Read;
                }
                else
                {
                    phase = Phase.Write;
                }
                return 0;
            case Phase.Dummy:
                phase = Phase.Read;
                return 0;
            case Phase.Read:
                return die.ReadNext();
            default:
                die.WriteNext(data);
                return 0;
            }
        }

        // The frame is the chip select's window (OnGPIO), not the controller's
        // transfer: a HAL call can split one transaction (address, then data).
        public void FinishTransmission()
        {
        }

        public void SetAcceleration(double xMg, double yMg, double zMg) => acc.SetAcceleration(xMg, yMg, zMg);

        public void SetAngularRate(double xDps, double yDps, double zDps) => gyr.SetAngularRate(xDps, yDps, zDps);

        public bool AccelerometerResponds { get => acc.Respond; set => acc.Respond = value; }

        public bool GyroscopeResponds { get => gyr.Respond; set => gyr.Respond = value; }

        public bool AccelerometerSpiMode => acc.SpiMode;

        public int AccelerometerReadCount(int register) => acc.ReadCount(register);

        public int GyroscopeReadCount(int register) => gyr.ReadCount(register);

        public int AccelerometerRegister(int register) => acc.RegisterValue(register);

        public int GyroscopeRegister(int register) => gyr.RegisterValue(register);

        // The die a byte goes to: the one whose chip select is low, if it
        // listens. Null (MISO undriven) for none, both (a host bug), an
        // unpowered die, or the accelerometer still in I2C mode.
        private Bmi088Die Selected()
        {
            if(!csHigh[0] && !csHigh[1])
            {
                this.Log(LogLevel.Warning, "Both chip selects low: neither die answers");
                return null;
            }
            if(csHigh[0] && csHigh[1])
            {
                this.Log(LogLevel.Warning, "SPI transfer with both chip selects high");
                return null;
            }
            var die = dies[csHigh[0] ? 1 : 0];
            if(!die.Respond || (die == acc && !acc.SpiMode))
            {
                return null;
            }
            return die;
        }

        private readonly Bmi088Accelerometer acc;
        private readonly Bmi088Gyroscope gyr;
        private readonly Bmi088Die[] dies;
        // Renode's GPIO starts low: both selected until the MCU drives them.
        private readonly bool[] csHigh = new bool[2];
        private Phase phase;

        private enum Phase
        {
            Address,
            Dummy,
            Read,
            Write,
        }
    }
}
