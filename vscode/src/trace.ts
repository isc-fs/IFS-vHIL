// A failed test in firmware terms, without VS Code: its boards' snapshots
// (vhil/testtrace.py) as text and C frames, and a firmware build's compiler
// errors, with the container's paths mapped back to the host. Tested by
// test/trace.test.ts.

/** A C frame of a snapshot: PC, then LR. */
export interface CFrame {
  symbol: string;
  file: string | null;
  line: number | null;
  address: string;
}

/** A decoded frame of a snapshot's bus tail. */
export interface TailFrame {
  t_us: number;
  bus: string;
  id: number;
  data: string;
  name?: string;
  sender?: string;
  signals?: { [name: string]: number };
}

/** One board's failure snapshot: a `snapshot` line of vhil/pytest_vscode.py. */
export interface Snapshot {
  kind: "snapshot";
  id: string;
  sim: string;
  board: string;
  time_us: number | null;
  summary: string;
  exception: string | null;
  task: string | null;
  fault: { [reg: string]: string };
  frames: CFrame[];
  bus_tail: TailFrame[];
}

/** Where the container's files are on the host. */
export interface PathMap {
  repo: string; // the vHIL checkout, /work in the container
  firmware?: string; // the open firmware's catalogue id (FW_LOCAL)
  dir?: string; // its working tree
}

/**
 * A container path on the host: /work/... is the vHIL checkout, and
 * /vhil/fw/<firmware>@local/... the open working tree (a copy of it is what
 * was built). Anything else (a firmware built from a ref) lives only in the
 * container: undefined.
 */
export function hostPath(file: string, m: PathMap): string | undefined {
  if (file.startsWith("/work/")) return join(m.repo, file.slice("/work/".length));
  if (m.firmware && m.dir) {
    const prefix = `/vhil/fw/${m.firmware}@local/`;
    if (file.startsWith(prefix)) return join(m.dir, file.slice(prefix.length));
  }
  return undefined;
}

/** A posix path without `.` and `..` segments. */
function normalise(path: string): string {
  const parts: string[] = [];
  for (const p of path.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  return "/" + parts.join("/");
}

function join(dir: string, rel: string): string {
  return dir.replace(/\/+$/, "") + "/" + rel;
}

export function hex(id: number): string {
  return "0x" + id.toString(16).toUpperCase().padStart(3, "0");
}

export function seconds(t_us: number | null): string {
  return t_us === null ? "?" : (t_us / 1e6).toFixed(6) + " s";
}

function signalText(s: { [name: string]: number } | undefined, max = 4): string {
  if (!s) return "";
  const entries = Object.entries(s);
  const shown = entries.slice(0, max).map(([k, v]) => `${k}=${Number.isInteger(v) ? v : v.toFixed(3)}`);
  return shown.join(" ") + (entries.length > max ? " …" : "");
}

/**
 * A failed test's snapshots as Markdown, under the assertion: per board where
 * it was (summary, fault registers, the C frames) and the last frames on the
 * bus before the failure.
 */
export function snapshotMarkdown(snaps: Snapshot[], tail = 10): string {
  const out: string[] = [];
  for (const s of snaps) {
    out.push(`**${s.board}** (${s.sim}) at ${seconds(s.time_us)}: ${s.exception ?? "?"}` +
             (s.task ? `, task \`${s.task}\`` : ""));
    const faults = Object.entries(s.fault).filter(([, v]) => !/^0x0+$/.test(v));
    if (faults.length) out.push(`fault: ${faults.map(([k, v]) => `${k} ${v}`).join(", ")}`);
    for (const f of s.frames) {
      out.push(`- \`${f.symbol}\` ${f.file ? `${f.file.split("/").pop()}:${f.line}` : f.address}`);
    }
    const last = s.bus_tail.slice(-tail);
    if (last.length) {
      out.push("", `Last ${last.length} frames before the failure:`, "",
               "| t | bus | id | message | signals |", "|---|---|---|---|---|");
      for (const f of last) {
        out.push(`| ${(f.t_us / 1e6).toFixed(6)} | ${f.bus} | ${hex(f.id)} | ${f.name ?? f.data} | ${signalText(f.signals)} |`);
      }
    }
    out.push("");
  }
  return out.join("\n");
}

/** A compiler diagnostic of a firmware build, at its host path. */
export interface Diagnostic {
  file: string;
  line: number; // 1-based
  column: number; // 1-based
  severity: "error" | "warning";
  message: string;
}

/**
 * The errors and warnings of a build's output (gcc's `file:line:col:
 * severity: message`), those in files on the host only. A relative path
 * (a Makefile build) is resolved against make's directory. A linker error
 * names no line: it stays in the build's output.
 */
export function compilerDiagnostics(text: string, m: PathMap): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  // A Makefile build (CubeMX's) names sources relative to the directory
  // make runs in: make's "Entering directory" says which, else the open
  // working tree's build copy is.
  let cwd = m.firmware ? `/vhil/fw/${m.firmware}@local` : undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const enter = /^make(?:\[\d+\])?: Entering directory [`'](.*)'$/.exec(line);
    if (enter) { cwd = enter[1]; continue; }
    const g = /^((?:[A-Za-z]:)?[^:\s][^:]*?):(\d+):(\d+): (fatal error|error|warning): (.*)$/.exec(line);
    if (!g) continue;
    let path = g[1];
    if (!path.startsWith("/") && !/^[A-Za-z]:/.test(path)) {
      if (!cwd) continue;
      path = normalise(`${cwd}/${path}`);
    }
    const file = hostPath(path, m);
    if (!file) continue;
    const d: Diagnostic = { file, line: +g[2], column: +g[3],
                            severity: g[4] === "warning" ? "warning" : "error", message: g[5] };
    const key = `${d.file}:${d.line}:${d.column}:${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}
