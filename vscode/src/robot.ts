// The Robot smoke suites (tests/<system>_smoke.robot) as test items, and
// their results from Robot's output.xml: the extension's pure half, tested by
// test/robot.test.ts. A suite runs whole under `vhil-docker.sh smoke
// <system>`, which writes results/smoke-<system>/output.xml.

/** The tree's root for the smoke suites (not a path: pytest never sees it). */
export const SMOKE_ROOT = "smoke";

const SUITE = /^tests\/([a-z0-9-]+)_smoke\.robot$/;

/** The system a suite file ("tests/ecu_smoke.robot") or one of its cases runs, or undefined. */
export function smokeSystem(id: string): string | undefined {
  return SUITE.exec(id.split("::")[0])?.[1];
}

/** Whether an id is the smoke root, a suite or one of its cases. */
export function isSmoke(id: string): boolean {
  return id === SMOKE_ROOT || smokeSystem(id) !== undefined;
}

/** A suite's results folder, as the smoke job writes it (repo-relative). */
export function smokeResults(system: string): string {
  return `results/smoke-${system}/output.xml`;
}

export interface RobotCase {
  name: string;
  /** 1-based line of the case's name. */
  line: number;
}

/** The test cases of a .robot file: the names under `*** Test Cases ***`. */
export function robotCases(text: string): RobotCase[] {
  const out: RobotCase[] = [];
  let inCases = false;
  text.split(/\r?\n/).forEach((line, i) => {
    const header = /^\*{3}\s*([^*]+?)\s*\*{3}/.exec(line);
    if (header) {
      inCases = /^test cases?$/i.test(header[1].trim());
      return;
    }
    if (!inCases || !line.trim() || /^\s/.test(line) || line.startsWith("#")) return;
    // A name ends at the first separator (two spaces or a tab).
    out.push({ name: line.split(/\s{2,}|\t/)[0].trim(), line: i + 1 });
  });
  return out;
}

export interface RobotResult {
  status: "PASS" | "FAIL" | "SKIP" | "NOT RUN";
  message: string;
  /** ms, when output.xml says. */
  duration?: number;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescape(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? unescape(m[1]) : undefined;
}

// Robot 6: starttime="20261120 10:00:00.123"
function stamp(s: string | undefined): number | undefined {
  const m = s && /^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(s);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : undefined;
}

/**
 * Each test case's result from output.xml, by name: its own <status> (the
 * last one in its element; the keywords' come before it). Robot 7 gives
 * `elapsed` in seconds, Robot 6 `starttime` and `endtime`.
 */
export function robotResults(xml: string): Map<string, RobotResult> {
  const out = new Map<string, RobotResult>();
  const test = /<test\b([^>]*)>([\s\S]*?)<\/test>/g;
  for (let m; (m = test.exec(xml)); ) {
    const name = attr(m[1], "name");
    if (name === undefined) continue;
    const statuses = [...m[2].matchAll(/<status\b([^>]*?)(?:\/>|>([\s\S]*?)<\/status>)/g)];
    const last = statuses[statuses.length - 1];
    if (!last) continue;
    const status = (attr(last[1], "status") ?? "FAIL") as RobotResult["status"];
    const elapsed = attr(last[1], "elapsed");
    const start = stamp(attr(last[1], "starttime")), end = stamp(attr(last[1], "endtime"));
    const duration = elapsed !== undefined ? Math.round(parseFloat(elapsed) * 1000)
      : start !== undefined && end !== undefined ? end - start : undefined;
    out.set(name, { status, message: unescape(last[2] ?? "").trim(), duration });
  }
  return out;
}
