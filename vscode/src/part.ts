// vHIL: New part…, without VS Code: what the answers must look like and the
// `python -m vhil.part new` it runs (vhil/part.py, docs/development/adding-a-part.md).
// Tested by test/part.test.ts.

export const PROTOCOLS = ["i2c", "spi", "uart"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

export interface PartAnswers {
  id: string;
  name: string;
  protocols: Protocol[];
  address?: string; // on I2C, "0x76"
  whoAmI?: string; // "0xD0=0x60"
  place?: { system: string; board: string; bus: string; cs?: string };
}

const num = (s: string): number => (/^(0x[0-9a-f]+|\d+)$/i.test(s.trim()) ? Number(s.trim()) : NaN);

export function partIdError(id: string, existing: string[]): string | undefined {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id)) return "lowercase letters, digits and dashes, e.g. bme280";
  if (existing.includes(id)) return `${id} exists in catalog/models`;
  return undefined;
}

export function addressError(s: string): string | undefined {
  const a = num(s);
  return a >= 0x08 && a <= 0x77 ? undefined : "a 7-bit I2C address, 0x08..0x77 (the datasheet's)";
}

export function whoAmIError(s: string, protocols: Protocol[]): string | undefined {
  if (!s.trim()) return undefined;
  const [reg, val, extra] = s.split("=");
  const top = protocols.includes("spi") ? 0x7f : 0xff; // on SPI bit 7 is the read bit
  const r = num(reg ?? ""), v = num(val ?? "");
  if (extra !== undefined || !(r >= 0 && r <= top) || !(v >= 0 && v <= 0xff)) {
    return `<register>=<value>, e.g. 0x0F=0x33 (register up to 0x${top.toString(16).toUpperCase()})`;
  }
  return undefined;
}

/** The protocol a board's bus speaks, from its name: I2C2, SPI1, USART2, LPUART1. */
export function busProtocol(bus: string): Protocol | undefined {
  const kind = bus.replace(/\d+$/, "").toLowerCase();
  if (kind === "i2c" || kind === "spi") return kind;
  if (/^(lp)?us?art$/.test(kind)) return "uart";
  return undefined;
}

export function busError(bus: string, protocols: Protocol[]): string | undefined {
  const p = busProtocol(bus.trim());
  if (!p) return "a bus of the board, e.g. I2C2, SPI1 or USART2";
  if (!protocols.includes(p)) return `the part speaks ${protocols.join(", ")}, not ${p}`;
  return undefined;
}

export function pinError(pin: string): string | undefined {
  return /^P[A-K]\d{1,2}$/.test(pin.trim()) ? undefined : "a pin of the board, e.g. PA4";
}

/** The arguments to `python -m vhil.part new`. */
export function partArgs(a: PartAnswers): string[] {
  const args = ["new", a.id, "--name", a.name];
  for (const p of a.protocols) args.push("--protocol", p);
  if (a.protocols.includes("i2c") && a.address) args.push("--address", a.address.trim());
  if (a.whoAmI?.trim()) args.push("--who-am-i", a.whoAmI.trim());
  if (a.place) {
    args.push("--place", a.place.system, `${a.place.board}.${a.place.bus.trim()}`);
    if (a.place.cs) args.push("--cs", a.place.cs.trim());
  }
  return args;
}

/** vhil/part.py's class name: the id's words capitalised, dashes dropped. */
export function className(id: string): string {
  return id.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

/** What to open once it is written: the model, its tests, its catalogue entry. */
export function partFiles(id: string): string[] {
  return [`models/renode/${className(id)}.cs`, `tests/sim/test_${id.replace(/-/g, "_")}.py`,
    `catalog/models/${id}.yaml`];
}
