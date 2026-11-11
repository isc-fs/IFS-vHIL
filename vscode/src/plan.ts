// What a run executes and what it reports, without VS Code: the extension's
// pure half, tested by test/plan.test.ts.
//
// Every command goes through scripts/vhil-docker.sh, as CI's jobs do, and
// pytest writes its results with vhil/pytest_vscode.py (JSON lines).

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

/** vhil-docker.sh's arguments to list every test into `out`. */
export function collectArgs(out: string): string[] {
  return ["run", "python", "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider",
          ...pluginArgs(out), ...SUITES.map((s) => s.root)];
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
}

export type Record =
  | Item
  | Result
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

/** The firmware the last `fw` build left, from /vhil/fw/built.txt ("ecu=/vhil/fw/...elf" lines). */
export function builtFirmware(text: string): Map<string, string> {
  const built = new Map<string, string>();
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) built.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return built;
}
