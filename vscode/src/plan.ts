// What a run executes and what it reports, without VS Code: the extension's
// pure half, tested by test/plan.test.ts.
//
// Every command goes through scripts/vhil-docker.sh, as CI's jobs do, and
// pytest writes its results with vhil/pytest_vscode.py (JSON lines).

import * as path from "path";

import { Snapshot } from "./trace";

/** The test folders the extension lists, and the vhil-docker.sh job each runs under. */
export const SUITES = [
  { root: "tests/unit", job: "unit" },
  { root: "tests/sim", job: "sim" },
  { root: "tests/scenarios", job: "scenarios" },
] as const;

export type Job = (typeof SUITES)[number]["job"];

/** The job a test, file or folder id ("tests/sim/test_x.py::test_y") runs under. */
export function jobOf(id: string): Job | undefined {
  return SUITES.find((s) => id === s.root || id.startsWith(s.root + "/"))?.job;
}

/** The plugin's arguments: write JSON lines to `out` (a repo-relative path). */
function pluginArgs(out: string): string[] {
  return ["-p", "vhil.pytest_vscode", "--vscode-out", out];
}

/**
 * vhil-docker.sh's arguments to list every test into `out`. `pytestArgs`
 * (vhil.pytestArgs) go in too: a `-m` or `-k` there changes what is listed.
 */
export function collectArgs(out: string, roots: string[] = SUITES.map((s) => s.root),
                            pytestArgs: string[] = []): string[] {
  return ["run", "python", "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider",
          ...pluginArgs(out), ...pytestArgs, ...roots];
}

/**
 * vhil-docker.sh's arguments to run `ids` (node ids, files or folders, all of
 * one job) minus `deselect` (node ids), writing results to `out`.
 *
 * - unit: pytest itself (`run`): the `unit` job also validates every system,
 *   which a single test doesn't need.
 * - sim, scenarios: their jobs, which find the firmware and run just the
 *   tests/... the arguments name.
 */
export function runArgs(job: Job, ids: string[], deselect: string[], out: string,
                        extra: string[] = []): string[] {
  const tail = [...ids, ...deselect.flatMap((d) => ["--deselect", d]), ...pluginArgs(out), ...extra];
  if (job === "unit") {
    return ["run", "python", "-m", "pytest", "-v", "-p", "no:cacheprovider", ...tail];
  }
  return [job, ...tail];
}

/**
 * Group what a run includes by job, dropping anything inside another included
 * id (a test inside an included file runs anyway).
 */
export function plan(ids: string[]): Map<Job, string[]> {
  const kept = ids.filter((id) => !ids.some((other) => other !== id && contains(other, id)));
  const byJob = new Map<Job, string[]>();
  for (const id of kept) {
    const job = jobOf(id);
    if (!job) continue;
    byJob.set(job, [...(byJob.get(job) ?? []), id]);
  }
  return byJob;
}

/** Whether folder or file `outer` holds `inner`. */
export function contains(outer: string, inner: string): boolean {
  return inner.startsWith(outer + "/") || inner.startsWith(outer + "::");
}

// -- the plugin's JSON lines --------------------------------------------------

export interface Item {
  kind: "item";
  id: string;
  file: string;
  line: number; // 1-based
  name: string;
  markers: string[];
}

export interface Result {
  kind: "result";
  id: string;
  outcome: "passed" | "failed" | "skipped";
  duration: number; // seconds
  message?: string;
  short?: string;
  file?: string | null;
  line?: number; // 1-based
  trace?: string; // its bus trace (.trace.jsonl), repo-relative: docs/test-trace.md
}

export type Record =
  | Item
  | Result
  | Snapshot
  | { kind: "start"; id: string }
  | { kind: "error"; id: string; message: string }
  | { kind: "done"; exitstatus: number };

/**
 * The records in `text`, and the bytes after its last newline (a line still
 * being written), to prepend to the next read. A line that isn't JSON is skipped.
 */
export function parseLines(text: string): { records: Record[]; rest: string } {
  const end = text.lastIndexOf("\n");
  const records: Record[] = [];
  for (const line of text.slice(0, end + 1).split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as Record);
    } catch {
      // Not ours: skip it.
    }
  }
  return { records, rest: text.slice(end + 1) };
}

/** The file part of a node id ("tests/sim/test_x.py::Cls::test_y[1]" -> "tests/sim/test_x.py"). */
export function fileOf(id: string): string {
  return id.split("::")[0];
}

/** A test's label under its file ("Cls::test_y[1]"). */
export function labelOf(id: string): string {
  return id.split("::").slice(1).join("::") || id;
}

/** The Docker context: the setting, else the script's default for this host. */
export function dockerContext(setting: string, platform: string): string {
  return setting.trim() || (platform === "darwin" ? "colima-vhil" : "default");
}

/** Whether `vhil-docker.sh vm` starts this context: only its Colima VM (colima-<profile>). */
export function startsVm(context: string): boolean {
  return context.startsWith("colima-");
}

/** The firmware the last `fw` build left, from /vhil/fw/built.txt ("ecu=/vhil/fw/...elf" lines). */
export function builtFirmware(text: string): Map<string, string> {
  const built = new Map<string, string>();
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) built.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return built;
}

/**
 * The `<board>=<elf>` lines `fw` prints as it builds (what it appends to
 * built.txt), in any other output: only a board id and an absolute path, so
 * an echoed command line (`$ FW_LOCAL=ecu=...`) or a log line isn't one.
 * Later lines win, as in built.txt.
 */
export function builtLines(text: string): Map<string, string> {
  const built = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([\w.-]+)=(\/\S+)\s*$/.exec(line);
    if (m) built.set(m[1], m[2]);
  }
  return built;
}

/**
 * The items still listed for `ids`, in order: a run request holds the
 * TestItems of the listing it was made from, and a refresh since replaced
 * them (or dropped a test). Group and folder ids remap the same way.
 */
export function remapItems<T>(ids: string[], byId: Map<string, T>): T[] {
  return ids.map((id) => byId.get(id)).filter((t): t is T => t !== undefined);
}

/** A breakpoint as debugStops sees it (vscode.SourceBreakpoint / FunctionBreakpoint). */
export interface Bp {
  enabled: boolean;
  kind: "source" | "function" | "other";
  path?: string; // a source breakpoint's file
}

const FIRMWARE_SOURCE = /\.(c|h|cpp|hpp|cc|s|S)$/;

/**
 * Whether a debug session should stop at entry: no enabled breakpoint that
 * firmware can hit (one in a C, C++ or assembly file, or on a function).
 * A Python or YAML breakpoint left in the workspace would otherwise let the
 * test run straight through.
 */
export function debugStops(bps: Bp[]): boolean {
  return !bps.some((b) => b.enabled &&
    (b.kind === "function" || (b.kind === "source" && !!b.path && FIRMWARE_SOURCE.test(b.path))));
}

/** What Run on save watches in a firmware repository: sources, the linker script, the build files. */
export const FIRMWARE_SAVE_GLOB =
  "**/{*.c,*.h,*.cpp,*.hpp,*.cc,*.s,*.S,*.ld,*.ioc,*.cmake,*.mk,CMakeLists.txt,Makefile}";

/**
 * Whether a save under `base` (the watched folder) is one Run on save
 * ignores: build output, results, git and node_modules. Tested against the
 * path inside `base`, so a checkout that itself sits under a `build/`
 * folder still runs.
 */
export function ignoredSave(base: string, file: string): boolean {
  const rel = path.relative(base, file);
  return /(^|[\\/])(build|results|\.git|node_modules)([\\/]|$)/.test(rel);
}

/** `text` cut to `max` characters, saying how many more there were. */
export function clip(text: string, max = 4096): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}
