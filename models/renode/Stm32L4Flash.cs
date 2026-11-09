//
// The STM32L496's embedded flash controller, compiled by Renode at load time
// and placed by platforms/cpus/stm32l496.repl at FLASH_R_BASE 0x40022000
// (AHB1PERIPH_BASE + 0x2000, stm32l496xx.h:1310). Renode has none for the L4:
// HAL_RCC_ClockConfig writes ACR.LATENCY and reads it back, and returns
// HAL_ERROR when it differs, so the clock setup failed on unmapped flash
// registers.
//
// Registers: FLASH_TypeDef (stm32l496xx.h:540-561), reset values from RM0351
// "FLASH registers", writable bits the header's FLASH_<reg>_*_Msk fields.
// The 1 MB part is two 512 KB banks of 2 KB pages (DUALBANK = 1, its factory
// value): bank 1 at 0x08000000, bank 2 at 0x08080000 (FLASH_BANK_SIZE, the
// HAL's FLASH_SIZE / 2 with DUALBANK set).
//
//   ACR        LATENCY, PRFTEN, ICEN, DCEN, RUN_PD, SLEEP_PD: read back as
//              written, no effect (the emulated flash has no wait states).
//              ICRST/DCRST are stored too; the HAL sets and clears them.
//   KEYR       0x45670123 then 0xCDEF89AB clears CR.LOCK (FLASH_KEY1/2,
//              stm32l4xx_hal_flash.h). A wrong key keeps it locked until
//              reset (RM0351 "Unlocking the Flash memory").
//   OPTKEYR    0x08192A3B then 0x4C5D6E7F, with LOCK clear, clears OPTLOCK.
//   CR         Ignored while LOCK is set, except setting LOCK. STRT with PER
//              erases page PNB of bank BKER to 0xFF; with MER1/MER2 erases
//              the bank(s). The operation takes no time: BSY reads 0, STRT
//              clears itself, and SR.EOP is set if CR.EOPIE is (RM0351: EOP
//              "is set only if the end of operation interrupts are
//              enabled"). FLASH_IRQn (4, stm32l496xx.h:82) is up while EOP
//              and EOPIE are.
//   SR         EOP and the error flags clear by writing 1.
//   option     OPTR, PCROP1SR/ER, WRP1AR/BR, PCROP2SR/ER, WRP2AR/BR read the
//   bytes      option bytes; with OPTLOCK clear they take writes, which
//              OPTSTRT programs into the option bytes. The option bytes live
//              in the controller object, so they survive reset, and every
//              reset (OBL_LAUNCH's included, which resets the machine)
//              reloads the registers from them: an unlaunched change is lost.
//              Factory values (RM0351 "Option bytes"): OPTR 0xFFEFF8AA (RDP
//              level 0, DUALBANK), no PCROP (start 0xFFFF > end 0) and no
//              write protection (start 0xFF > end 0).
//
// Not modelled: programming checks. The CPU stores into the flash memory
// directly, PG set or not, so the program errors (PROGERR, SIZERR, PGAERR,
// PGSERR, MISERR, FASTERR) and WRPERR are never raised, and a write-protected
// or PCROP area is still written and erased. Option byte effects other than
// DUALBANK on the bank layout (RDP, BFB2 boot, nBOOT0/1, SRAM2 parity) do
// nothing. ECC never reports an error (ECCR reads 0). PDKEYR (flash power-down
// in Run mode) is accepted and ignored.
//
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.Memory;

namespace Antmicro.Renode.Peripherals.MTD
{
    public class STM32L4_FlashController : IDoubleWordPeripheral, IKnownSize
    {
        public STM32L4_FlashController(IMachine machine, MappedMemory flash)
        {
            this.machine = machine;
            this.flash = flash;
            IRQ = new GPIO();
            optionBytes = (uint[])FactoryOptionBytes.Clone();
            Reset();
        }

        public long Size => 0x400;
        public GPIO IRQ { get; }

        public void Reset()
        {
            acr = AcrReset;
            sr = 0;
            cr = CrReset;
            keyStep = 0;
            optKeyStep = 0;
            keyFailed = false;
            options = (uint[])optionBytes.Clone();
            IRQ.Unset();
        }

        public uint ReadDoubleWord(long offset)
        {
            switch(offset)
            {
            case ACR: return acr;
            case PDKEYR:
            case KEYR:
            case OPTKEYR:
                return 0;   // write-only
            case SR: return sr;
            case CR: return cr;
            case ECCR: return 0;
            }
            var i = OptionIndex(offset);
            if(i >= 0)
            {
                return options[i] | OptionReserved[i];
            }
            this.Log(LogLevel.Warning, "Unhandled read from offset 0x{0:X}.", offset);
            return 0;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            switch(offset)
            {
            case ACR:
                acr = value & AcrMask;
                return;
            case PDKEYR:
            case ECCR:
                return;
            case KEYR:
                Key(value);
                return;
            case OPTKEYR:
                OptKey(value);
                return;
            case SR:
                sr &= ~(value & SrClearable);
                UpdateIrq();
                return;
            case CR:
                WriteCr(value);
                return;
            }
            var i = OptionIndex(offset);
            if(i >= 0)
            {
                if((cr & OPTLOCK) != 0)
                {
                    this.Log(LogLevel.Warning, "Option register write 0x{0:X} at 0x{1:X} ignored: OPTLOCK is set.", value, offset);
                    return;
                }
                options[i] = value & OptionMask[i];
                return;
            }
            this.Log(LogLevel.Warning, "Unhandled write to offset 0x{0:X}, value 0x{1:X}.", offset, value);
        }

        private void Key(uint value)
        {
            if(keyFailed)
            {
                return;
            }
            if(keyStep == 0 && value == Key1)
            {
                keyStep = 1;
                return;
            }
            if(keyStep == 1 && value == Key2)
            {
                cr &= ~LOCK;
                keyStep = 0;
                return;
            }
            keyFailed = true;   // locked until the next reset
            this.Log(LogLevel.Warning, "Wrong flash key sequence: locked until reset.");
        }

        private void OptKey(uint value)
        {
            if((cr & LOCK) != 0)
            {
                return;
            }
            if(optKeyStep == 0 && value == OptKey1)
            {
                optKeyStep = 1;
                return;
            }
            if(optKeyStep == 1 && value == OptKey2)
            {
                cr &= ~OPTLOCK;
            }
            optKeyStep = 0;
        }

        private void WriteCr(uint value)
        {
            if((cr & LOCK) != 0)
            {
                cr |= value & (LOCK | OPTLOCK);
                return;
            }
            // LOCK and OPTLOCK are set-only; STRT, OPTSTRT and OBL_LAUNCH act
            // and read back 0.
            cr = (value & CrMask & ~(STRT | OPTSTRT | OBL_LAUNCH)) | (cr & (LOCK | OPTLOCK)) | (value & (LOCK | OPTLOCK));
            if((value & STRT) != 0)
            {
                Start(value);
            }
            if((value & OPTSTRT) != 0 && (cr & OPTLOCK) == 0)
            {
                optionBytes = (uint[])options.Clone();
                Done();
            }
            if((value & OBL_LAUNCH) != 0 && (cr & OPTLOCK) == 0)
            {
                // Reloads the option bytes through a system reset (RM0351
                // "Option bytes loading").
                machine.RequestReset();
            }
            UpdateIrq();
        }

        private void Start(uint value)
        {
            var dualBank = (optionBytes[0] & DUALBANK) != 0;
            var bankSize = dualBank ? FlashSize / 2 : FlashSize;
            if((value & PER) != 0)
            {
                var bank = dualBank && (value & BKER) != 0 ? 1 : 0;
                var page = (value >> 3) & 0xFF;
                Erase(bank * bankSize + page * PageSize, PageSize);
            }
            else if((value & (MER1 | MER2)) != 0)
            {
                if((value & MER1) != 0)
                {
                    Erase(0, bankSize);
                }
                if(dualBank && (value & MER2) != 0)
                {
                    Erase(bankSize, bankSize);
                }
            }
            else
            {
                return;
            }
            Done();
        }

        private void Erase(long start, long length)
        {
            var ones = new byte[length];
            for(var i = 0; i < ones.Length; i++)
            {
                ones[i] = 0xFF;
            }
            flash.WriteBytes(start, ones, 0, ones.Length);
        }

        private void Done()
        {
            if((cr & EOPIE) != 0)
            {
                sr |= EOP;
            }
        }

        private void UpdateIrq()
        {
            IRQ.Set((sr & EOP) != 0 && (cr & EOPIE) != 0);
        }

        private static int OptionIndex(long offset)
        {
            return System.Array.IndexOf(OptionOffsets, offset);
        }

        private const long ACR = 0x00, PDKEYR = 0x04, KEYR = 0x08, OPTKEYR = 0x0C, SR = 0x10, CR = 0x14, ECCR = 0x18;
        private const uint AcrReset = 0x00000600, AcrMask = 0x00007F07;
        private const uint CrReset = 0xC0000000, CrMask = 0xCF078FFF;
        private const uint PER = 1u << 1, MER1 = 1u << 2, BKER = 1u << 11, MER2 = 1u << 15,
            STRT = 1u << 16, OPTSTRT = 1u << 17, EOPIE = 1u << 24, OBL_LAUNCH = 1u << 27,
            OPTLOCK = 1u << 30, LOCK = 1u << 31;
        private const uint EOP = 1u << 0;
        // EOP, OPERR, PROGERR, WRPERR, PGAERR, SIZERR, PGSERR, MISERR, FASTERR,
        // RDERR, OPTVERR (FLASH_SR_*_Msk; BSY and PEMPTY are not write-1-clear).
        private const uint SrClearable = 0x0000C3FB;
        private const uint DUALBANK = 1u << 21;
        private const uint Key1 = 0x45670123, Key2 = 0xCDEF89AB, OptKey1 = 0x08192A3B, OptKey2 = 0x4C5D6E7F;
        private const long FlashSize = 0x100000, PageSize = 0x800;

        // OPTR, PCROP1SR, PCROP1ER, WRP1AR, WRP1BR, PCROP2SR, PCROP2ER, WRP2AR, WRP2BR.
        private static readonly long[] OptionOffsets = { 0x20, 0x24, 0x28, 0x2C, 0x30, 0x44, 0x48, 0x4C, 0x50 };
        private static readonly uint[] OptionMask = { 0x0FBF77FF, 0x0000FFFF, 0x8000FFFF, 0x00FF00FF, 0x00FF00FF,
                                                      0x0000FFFF, 0x0000FFFF, 0x00FF00FF, 0x00FF00FF };
        // Reserved bits of the option registers read 1 (RM0351 reset values).
        private static readonly uint[] OptionReserved = { 0xF0408800, 0xFFFF0000, 0x0FFF0000, 0xFF00FF00, 0xFF00FF00,
                                                          0xFFFF0000, 0xFFFF0000, 0xFF00FF00, 0xFF00FF00 };
        private static readonly uint[] FactoryOptionBytes = { 0x0FAF70AA, 0x0000FFFF, 0x00000000, 0x000000FF, 0x000000FF,
                                                              0x0000FFFF, 0x00000000, 0x000000FF, 0x000000FF };

        private readonly IMachine machine;
        private readonly MappedMemory flash;
        private uint[] optionBytes;
        private uint[] options;
        private uint acr;
        private uint sr;
        private uint cr;
        private int keyStep;
        private int optKeyStep;
        private bool keyFailed;
    }
}
