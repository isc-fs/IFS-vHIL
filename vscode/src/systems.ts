// The vHIL's systems and its palette tools, without VS Code. Tested by
// test/systems.test.ts.

/** A board of a system: its name in the system, its catalogue board and role. */
export interface Board {
  name: string;
  board: string;
  role?: string;
}

export interface SystemInfo {
  id: string; // systems/<id>.yaml
  description: string;
  boards: Board[];
  scenarios: boolean; // systems/<id>.scenarios/ exists
  smoke: boolean; // tests/<id>_smoke.robot exists
}

/** The top-level block `key:` of a system file: its indented lines, comments dropped. */
function block(yaml: string, key: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l.startsWith(key + ":"));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    if (line.trim() && !line.trim().startsWith("#")) out.push(line);
  }
  return out;
}

/**
 * The boards of a system file, from its `boards:` block. Each board is one
 * flow-style line (`  ecu: {board: mainlite, role: ecu}`), as every file of
 * systems/ writes it; the vHIL itself validates the whole file.
 */
export function boardsOf(yaml: string): Board[] {
  const boards: Board[] = [];
  for (const line of block(yaml, "boards")) {
    const m = /^ {2}([\w-]+):\s*\{([^}]*)\}/.exec(line);
    if (!m) continue;
    const fields = new Map(m[2].split(",").map((f) => {
      const at = f.indexOf(":");
      return [f.slice(0, at).trim(), f.slice(at + 1).trim()] as const;
    }));
    const board = fields.get("board");
    if (board) boards.push({ name: m[1], board, role: fields.get("role") || undefined });
  }
  return boards;
}

/** A system file's `description:`, inline or folded (`>-`), as one line. */
export function descriptionOf(yaml: string): string {
  const inline = /^description:[ \t]+([^>|\s].*)$/m.exec(yaml);
  if (inline) return inline[1].trim();
  return block(yaml, "description").map((l) => l.trim()).join(" ");
}

// -- tools --------------------------------------------------------------------

/** The palette's tools (vHIL repository only): a vhil-docker.sh command each, some asking for arguments first. */
export const TOOLS = [
  { id: "shell", label: "Shell in the container", icon: "terminal",
    detail: "bash in the vHIL's image, the checkout at /work" },
  { id: "ifs-hil", label: "IFS_HIL suite…", icon: "beaker",
    detail: "IFS_HIL's pytest suite against the emulated ECU or AMS, over vcan" },
  { id: "coverage", label: "Firmware coverage…", icon: "graph",
    detail: "the firmware lines tests/sim reaches, into results/coverage" },
  { id: "speed", label: "Speed", icon: "dashboard",
    detail: "real-time factor of ams, ecu and ecu-ams, into results/speed" },
  { id: "prune", label: "Prune firmware builds…", icon: "trash",
    detail: "old commit builds in /vhil/fw" },
  { id: "export-run", label: "Export a run…", icon: "export",
    detail: "a run of the web app as a .vhilrun file" },
  { id: "import-run", label: "Import a run…", icon: "cloud-download",
    detail: "a .vhilrun file as a new run of the web app" },
  { id: "smoke", label: "Smoke suite…", icon: "debug-alt",
    detail: "a system's Robot smoke suite (tests/<system>_smoke.robot)" },
  { id: "validate", label: "Validate a system…", icon: "check",
    detail: "python -m vhil.system validate on a systems/*.yaml" },
] as const;

export type ToolId = (typeof TOOLS)[number]["id"];

/** The script arguments and environment of the IFS_HIL suite for a DUT and suite. */
export function ifsHilArgs(dut: "ecu" | "ams", suite: string): { args: string[]; env: Record<string, string> } {
  return { args: ["ifs-hil", ...(suite.trim() ? [suite.trim()] : [])], env: { VHIL_DUT: dut } };
}

/** A `validate` error of a system file, at the line it is about. */
export interface Problem {
  line: number; // 0-based
  message: string;
}

/**
 * `python -m vhil.system validate`'s errors, each at the first line of the
 * file holding a name it quotes ('nope', 'FDCAN9'), else the first line:
 * validate names what is wrong, not where.
 */
export function validationProblems(output: string, text: string): Problem[] {
  const lines = text.split("\n");
  const out: Problem[] = [];
  for (const raw of output.split("\n")) {
    const m = /^(?:error|Error):\s*(.*)$/.exec(raw.trim());
    if (!m) continue;
    const names = [...m[1].matchAll(/'([^']+)'/g)].map((q) => q[1]).reverse();
    let line = 0;
    for (const name of names) {
      const at = lines.findIndex((l) => !l.trim().startsWith("#") && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(l));
      if (at >= 0) { line = at; break; }
    }
    out.push({ line, message: m[1] });
  }
  return out;
}

/**
 * The web app's port for a vHIL checkout (the script's VHIL_WEB_PORT): the
 * one set, else 8080 for a checkout of your own and, for the extension's own
 * checkout (a firmware repository's), a port of its own from its path, so its
 * stack runs beside the one of your checkout instead of fighting for 8080.
 */
export function webPort(checkout: string, extensionOwned: boolean, set?: string): number {
  const n = Number(set);
  if (set && Number.isInteger(n) && n > 0 && n < 65536) return n;
  if (!extensionOwned) return 8080;
  let h = 0x811c9dc5; // FNV-1a
  for (const c of checkout) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return 8100 + (h % 800);
}
