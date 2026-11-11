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
// HAL's FLASH_SIZE / 2 with DUALBANK set). The flash starts erased (0xFF),
// as a new part's does; the firmware image is loaded over it.
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
//   program    With CR.PG set, the CPU's stores into the flash are checked as
//              they land (RM0351 "Flash memory programming sequence", "Flash
//              program and erase errors"): a double word is two 32-bit
//              stores, the first 8-byte aligned, the second right after it.
//              A store that breaks a rule is undone and raises its flag:
//                SIZERR   a store that is not 32 bits wide
//                PGAERR   a first word not 8-byte aligned, or a second word
//                         that is not at the first + 4 (the first is undone too)
//                WRPERR   a page in an active WRP or PCROP area
//                PROGERR  a double word that is not erased (all 0xFF)
//                PGSERR   PG set together with PER, MER1 or MER2, or a store
//                         with neither PG nor FSTPG set
//              The second word of a good double word ends the operation
//              (EOP, as for an erase). An erase (PER, MER1, MER2) that
//              touches a WRP or PCROP page raises WRPERR and erases nothing.
//              Protection is the option bytes loaded at the last reset; a
//              change takes effect after OBL_LAUNCH.
//   fast       With CR.FSTPG set, a row of 32 double words (256 bytes) is
//   program    programmed by 64 consecutive 32-bit stores from the row's
//              start (RM0351 "Fast programming"); the last ends it (EOP). A
//              store out of that sequence, or a row that is not erased, is
//              FASTERR (the row's stores so far are undone); PGSERR if FSTPG
//              is set with PG, PER or MER. MISERR (data not in time) cannot
//              happen: a store takes no time.
//   PCROP      PCROP1SR/ER, PCROP2SR/ER: start and end offsets in double
//              words from each bank's start (dual bank), inclusive. A data
//              read (not an instruction fetch) inside an area raises RDERR
//              (the read itself is not zeroed: the check runs after the load);
//              program and erase there are WRPERR.
//   errors     An error flag, with CR.ERRIE set, also raises OPERR; FLASH_IRQn
//              is up while EOP & EOPIE, OPERR & ERRIE or RDERR & RDERRIE.
//
//   The checks run on the CPU's loads and stores (VhilMemoryHooks.cs) while
//   they can matter: the flash is unlocked (LOCK clear) or a PCROP area is
//   active, or always with `CheckAllStores` (repl, default false: a hook on
//   every access slows the CPU). They compare with a copy of the flash taken
//   when they switch on and kept in step by every checked program and erase,
//   so a debugger's write while they are on is seen as the flash's content
//   only after the next unlock. A store while the flash is locked and
//   CheckAllStores is false lands unchecked.
//
// Not modelled: option byte effects other than DUALBANK on the bank layout,
// WRP and PCROP (RDP, BFB2 boot, nBOOT0/1, SRAM2 parity and reset, the
// hardware watchdog options). ECC never reports an error (ECCR reads 0).
// PDKEYR (flash power-down in Run mode) is accepted and ignored.
//
using System;
using System.Linq;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Logging.Profiling;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.CPU;
using Antmicro.Renode.Peripherals.Memory;
using Antmicro.Renode.Testing;

namespace Antmicro.Renode.Peripherals.MTD
{
    public class STM32L4_FlashController : IDoubleWordPeripheral, IKnownSize
    {
        public STM32L4_FlashController(IMachine machine, MappedMemory flash, bool checkAllStores = false)
        {
            this.machine = machine;
            this.flash = flash;
            this.checkAllStores = checkAllStores;
            IRQ = new GPIO();
            optionBytes = (uint[])FactoryOptionBytes.Clone();
            // A new part's flash is erased (all 0xFF); Renode's memory starts
            // at 0. The firmware image is loaded over this after the platform.
            Erase(0, FlashSize);
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
            active = (uint[])optionBytes.Clone();
            firstWord = -1;
            rowStart = -1;
            shadow = null;      // the flash may be reloaded before the next run
            UpdateChecking();
            IRQ.Unset();
        }

        // Program errors raised so far (test API): SR flags ever set.
        public uint ErrorsSeen => errorsSeen;

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
                UpdateChecking();
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
            var before = cr;
            // LOCK and OPTLOCK are set-only; STRT, OPTSTRT and OBL_LAUNCH act
            // and read back 0.
            cr = (value & CrMask & ~(STRT | OPTSTRT | OBL_LAUNCH)) | (cr & (LOCK | OPTLOCK)) | (value & (LOCK | OPTLOCK));
            if((cr & PG) != 0 && (cr & (PER | MER1 | MER2 | FSTPG)) != 0)
            {
                Error(PGSERR, "PG set with PER/MER/FSTPG");
            }
            if((cr & FSTPG) != 0 && (cr & (PER | MER1 | MER2)) != 0)
            {
                Error(PGSERR, "FSTPG set with PER/MER");
            }
            if((before & PG) != 0 && (cr & PG) == 0 && firstWord >= 0)
            {
                Undo(firstWord, 4);   // a lone first word is never programmed
                firstWord = -1;
            }
            if((before & FSTPG) != 0 && (cr & FSTPG) == 0 && rowStart >= 0)
            {
                Undo(rowStart, (int)(rowNext - rowStart));
                Error(FASTERR, "FSTPG cleared before the row's last word");
                rowStart = -1;
            }
            UpdateChecking();
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
                var start = bank * bankSize + page * PageSize;
                if(AnyProtected(start, PageSize))
                {
                    Error(WRPERR, $"erase of write-protected page {page} of bank {bank + 1}");
                    return;
                }
                Erase(start, PageSize);
            }
            else if((value & (MER1 | MER2)) != 0)
            {
                if(((value & MER1) != 0 && AnyProtected(0, bankSize))
                   || (dualBank && (value & MER2) != 0 && AnyProtected(bankSize, bankSize)))
                {
                    Error(WRPERR, "mass erase of a bank with write-protected pages");
                    return;
                }
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
            if(shadow != null)
            {
                Array.Copy(ones, 0, shadow, start, ones.Length);
            }
        }

        // --- programming checks

        private bool PcropActive => PcropArea(0) != null || PcropArea(1) != null;

        private void UpdateChecking()
        {
            if(machine == null)
            {
                return;
            }
            var on = checkAllStores || (cr & LOCK) == 0 || PcropActive;
            if(on && (shadow == null || !checking))
            {
                shadow = flash.ReadBytes(0, (int)FlashSize);
                firstWord = -1;
                rowStart = -1;
            }
            if(on == checking)
            {
                return;
            }
            checking = on;
            VhilMemoryHooks.For(machine).Set("flash", on ? (VhilMemoryAccess)OnAccess : null);
        }

        // Called after the access has landed.
        private void OnAccess(MemoryOperation operation, ulong address, uint width, ulong value)
        {
            if(operation != MemoryOperation.MemoryWrite && operation != MemoryOperation.MemoryRead)
            {
                return;
            }
            long offset;
            if(address >= FlashBase && address < FlashBase + (ulong)FlashSize)
            {
                offset = (long)(address - FlashBase);
            }
            else if(address < (ulong)FlashSize)
            {
                offset = (long)address;   // the boot alias at 0
            }
            else
            {
                return;
            }
            if(operation == MemoryOperation.MemoryRead)
            {
                if(InPcrop(offset, (int)width))
                {
                    Error(RDERR, $"data read at 0x{offset:X} in a PCROP area");
                    UpdateIrq();
                }
                return;
            }
            var count = (int)Math.Min(width, (uint)(FlashSize - offset));
            if((cr & PG) != 0)
            {
                Program(offset, width, count);
            }
            else if((cr & FSTPG) != 0)
            {
                FastProgram(offset, width, count);
            }
            else
            {
                Undo(offset, count);
                Error(PGSERR, $"store at 0x{offset:X} with neither PG nor FSTPG");
            }
            UpdateIrq();
        }

        private void Program(long offset, uint width, int count)
        {
            uint error = 0;
            string why = null;
            if(width != 4)
            {
                error = SIZERR;
                why = $"{width}-byte store at 0x{offset:X}";
            }
            else if(firstWord >= 0 ? offset != firstWord + 4 : offset % 8 != 0)
            {
                error = PGAERR;
                why = $"word at 0x{offset:X} breaks the double word";
            }
            else if(AnyProtected(offset, 4))
            {
                error = WRPERR;
                why = $"program at 0x{offset:X} in a write-protected or PCROP area";
            }
            else if(firstWord < 0 && !Erased(offset, 8))
            {
                error = PROGERR;
                why = $"double word at 0x{offset:X} is not erased";
            }
            if(error != 0)
            {
                Undo(offset, count);
                if(firstWord >= 0)
                {
                    Undo(firstWord, 4);
                    firstWord = -1;
                }
                Error(error, why);
                return;
            }
            if(firstWord < 0)
            {
                firstWord = offset;
                return;
            }
            // The double word is programmed: keep the copy in step.
            Array.Copy(flash.ReadBytes(firstWord, 8), 0, shadow, firstWord, 8);
            firstWord = -1;
            Done();
        }

        private void FastProgram(long offset, uint width, int count)
        {
            string why = null;
            if(width != 4)
            {
                why = $"{width}-byte store at 0x{offset:X}";
            }
            else if(rowStart < 0 ? offset % RowSize != 0 : offset != rowNext)
            {
                why = $"store at 0x{offset:X} out of the row's sequence";
            }
            else if(rowStart < 0 && (AnyProtected(offset, RowSize) || !Erased(offset, RowSize)))
            {
                why = $"row at 0x{offset:X} is protected or not erased";
            }
            if(why != null)
            {
                Undo(offset, count);
                if(rowStart >= 0)
                {
                    Undo(rowStart, (int)(rowNext - rowStart));
                    rowStart = -1;
                }
                Error(FASTERR, why);
                return;
            }
            if(rowStart < 0)
            {
                rowStart = offset;
            }
            rowNext = offset + 4;
            if(rowNext - rowStart == RowSize)
            {
                Array.Copy(flash.ReadBytes(rowStart, (int)RowSize), 0, shadow, rowStart, RowSize);
                rowStart = -1;
                Done();
            }
        }

        private void Undo(long offset, int count)
        {
            if(shadow != null)
            {
                flash.WriteBytes(offset, shadow, (int)offset, count);
            }
        }

        private bool Erased(long offset, long length)
        {
            for(var i = 0; i < length; i++)
            {
                if(shadow[offset + i] != 0xFF)
                {
                    return false;
                }
            }
            return true;
        }

        // PCROP area of a bank as [start, end] byte offsets in the flash, or
        // null: PCROPxSR/ER [15:0] in double words from the bank's start.
        private (long start, long end)? PcropArea(int bank)
        {
            var sr = active[bank == 0 ? 1 : 5] & 0xFFFF;
            var er = active[bank == 0 ? 2 : 6] & 0xFFFF;
            if(sr > er)
            {
                return null;
            }
            var bankStart = bank * BankSize();
            return (bankStart + sr * 8, bankStart + er * 8 + 7);
        }

        private long BankSize()
        {
            return (active[0] & DUALBANK) != 0 ? FlashSize / 2 : FlashSize;
        }

        private bool InPcrop(long start, int length)
        {
            for(var bank = 0; bank < 2; bank++)
            {
                var area = PcropArea(bank);
                if(area.HasValue && start <= area.Value.end && start + length - 1 >= area.Value.start)
                {
                    return true;
                }
            }
            return false;
        }

        // WRP1A/B cover bank 1's pages, WRP2A/B bank 2's: STRT [7:0] to END
        // [23:16], inclusive; STRT > END is no area.
        private bool AnyProtected(long start, long length)
        {
            if(InPcrop(start, (int)length))
            {
                return true;
            }
            var bankPages = ((active[0] & DUALBANK) != 0 ? FlashSize / 2 : FlashSize) / PageSize;
            for(var page = start / PageSize; page <= (start + length - 1) / PageSize; page++)
            {
                var bank = page >= bankPages ? 1 : 0;
                var local = page - bank * bankPages;
                foreach(var area in bank == 0 ? new[] { active[3], active[4] } : new[] { active[7], active[8] })
                {
                    if(local >= (area & 0xFF) && local <= ((area >> 16) & 0xFF))
                    {
                        return true;
                    }
                }
            }
            return false;
        }

        private void Error(uint flag, string why)
        {
            sr |= flag;
            if((cr & ERRIE) != 0 && flag != RDERR)
            {
                sr |= OPERR;
            }
            errorsSeen |= flag;
            this.Log(LogLevel.Warning, "Flash error 0x{0:X}: {1}.", flag, why);
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
            IRQ.Set(((sr & EOP) != 0 && (cr & EOPIE) != 0)
                    || ((sr & OPERR) != 0 && (cr & ERRIE) != 0)
                    || ((sr & RDERR) != 0 && (cr & RDERRIE) != 0));
        }

        private static int OptionIndex(long offset)
        {
            return System.Array.IndexOf(OptionOffsets, offset);
        }

        private const long ACR = 0x00, PDKEYR = 0x04, KEYR = 0x08, OPTKEYR = 0x0C, SR = 0x10, CR = 0x14, ECCR = 0x18;
        private const uint AcrReset = 0x00000600, AcrMask = 0x00007F07;
        private const uint CrReset = 0xC0000000, CrMask = 0xCF078FFF;
        private const uint PG = 1u << 0, PER = 1u << 1, MER1 = 1u << 2, BKER = 1u << 11, MER2 = 1u << 15,
            STRT = 1u << 16, OPTSTRT = 1u << 17, FSTPG = 1u << 18, EOPIE = 1u << 24, ERRIE = 1u << 25,
            RDERRIE = 1u << 26, OBL_LAUNCH = 1u << 27,
            OPTLOCK = 1u << 30, LOCK = 1u << 31;
        private const uint EOP = 1u << 0, OPERR = 1u << 1, PROGERR = 1u << 3, WRPERR = 1u << 4, PGAERR = 1u << 5,
            SIZERR = 1u << 6, PGSERR = 1u << 7, FASTERR = 1u << 9, RDERR = 1u << 14;
        private const long RowSize = 256;
        private const ulong FlashBase = 0x08000000;
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
        private uint[] active;      // the option bytes loaded at the last reset
        private byte[] shadow;      // the flash as the checks last saw it
        private readonly bool checkAllStores;
        private long firstWord = -1;
        private long rowStart = -1;
        private long rowNext;
        private bool checking;
        private uint errorsSeen;
        private uint acr;
        private uint sr;
        private uint cr;
        private int keyStep;
        private int optKeyStep;
        private bool keyFailed;
    }
}
