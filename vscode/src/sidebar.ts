// What the vHIL sidebar shows and runs, without VS Code: the systems and
// their tests, the runs list and the tools. Tested by test/sidebar.test.ts.

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

/** The pytest marker of a system's sim tests (pytest.ini): ecu-ams -> system_ecu_ams. */
export function systemMarker(id: string): string {
  return "system_" + id.replace(/-/g, "_");
}

/** Whether a scenario test is one of the system's: test_scenario[<system>/<name>]. */
export function isScenarioOf(testId: string, system: string): boolean {
  return testId.startsWith("tests/scenarios/") && testId.includes(`[${system}/`);
}

/** The sim and scenario tests of a system, from the listed tests and their markers. */
export function systemTests(tests: { id: string; markers: string[] }[], system: string):
    { sim: string[]; scenarios: string[] } {
  const marker = systemMarker(system);
  return {
    sim: tests.filter((t) => t.id.startsWith("tests/sim/") && t.markers.includes(marker)).map((t) => t.id),
    scenarios: tests.filter((t) => isScenarioOf(t.id, system)).map((t) => t.id),
  };
}

// -- runs ---------------------------------------------------------------------

/** A run in the Runs view: a test run, or a script command run as a task. */
export interface RunRecord {
  id: string;
  label: string;
  started: number; // ms since the epoch
  ms: number;
  kind: "tests" | "task";
  // tests
  passed?: number;
  failed?: string[]; // ids, failed or errored
  skipped?: number;
  cancelled?: boolean;
  include?: string[]; // what the run included, to run it again
  // task
  args?: string[];
  env?: Record<string, string>;
  exit?: number;
}

/** How long, short: 850 ms, 12 s, 3 min 5 s, 1 h 2 min. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
}

/** How long ago, short: just now, 5 min ago, 2 h ago, 3 d ago. */
export function ago(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** Whether a run went well: every test passed (or skipped), or the command exited 0. */
export function runOk(r: RunRecord): boolean | undefined {
  if (r.cancelled) return undefined;
  return r.kind === "tests" ? !r.failed?.length : r.exit === 0;
}

/** A run's line under its label: what passed and failed, how long, when. */
export function runDescription(r: RunRecord, now: number): string {
  const parts: string[] = [];
  if (r.kind === "tests") {
    if (r.failed?.length) parts.push(`${r.failed.length} failed`);
    parts.push(`${r.passed ?? 0} passed`);
    if (r.skipped) parts.push(`${r.skipped} skipped`);
    if (r.cancelled) parts.push("cancelled");
  } else {
    parts.push(r.cancelled || r.exit === undefined ? "stopped" : `exit ${r.exit}`);
  }
  parts.push(duration(r.ms), ago(r.started, now));
  return parts.join(" · ");
}

/** The runs kept: the newest first, at most `max`. */
export function keepRuns(runs: RunRecord[], add: RunRecord, max = 20): RunRecord[] {
  return [add, ...runs.filter((r) => r.id !== add.id)].slice(0, max);
}

// -- tools --------------------------------------------------------------------

/** The Tools view: a vhil-docker.sh command each, some asking for its arguments first. */
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
] as const;

export type ToolId = (typeof TOOLS)[number]["id"];

/** The script arguments and environment of the IFS_HIL suite for a DUT and suite. */
export function ifsHilArgs(dut: "ecu" | "ams", suite: string): { args: string[]; env: Record<string, string> } {
  return { args: ["ifs-hil", ...(suite.trim() ? [suite.trim()] : [])], env: { VHIL_DUT: dut } };
}
