// Each test run's output, kept as a file under results/vscode/runs, so it
// outlives a window reload: the extension's pure half, tested by
// test/runlog.test.ts.

export const RUN_LOG_DIR = "results/vscode/runs";
/** How many run logs a checkout keeps. */
export const RUN_LOGS_KEPT = 30;

/** A run's log file name: sortable by time, unique per window. */
export function runLogName(at: Date, pid: number): string {
  return `${at.toISOString().replace(/[:.]/g, "-")}-${pid}.log`;
}

/** Whether a file name is a run log. */
export function isRunLog(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T[\d-]+Z-\d+\.log$/.test(name);
}

/** The run logs past the newest `keep`, to delete. */
export function toPrune(names: string[], keep = RUN_LOGS_KEPT): string[] {
  return names.filter(isRunLog).sort().reverse().slice(keep);
}

/** A run log's label in the picker: "2026-11-20 10:04:05". */
export function runLogLabel(name: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(name);
  return m ? `${m[1]} ${m[2]}:${m[3]}:${m[4]} UTC` : name;
}
