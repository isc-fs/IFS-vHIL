// Which vHIL stack the editor tab frames. A web port may be held by another
// checkout's stack (the desktop app's copy on 8080 while your clone is open),
// and a stack of this checkout may still run older code than the checkout
// (after a pull, a switch, Update vHIL). vhil-docker.sh `stack` names this
// checkout's compose project and the one that holds the port; /api/health's
// started_ref is the commit the server's code was loaded from.

export interface StackInfo {
  project: string; // this checkout's compose project
  port: number;
  owner: string; // the project publishing the port, "" when none does
}

/** vhil-docker.sh `stack`'s output, or undefined (a checkout without the verb). */
export function parseStack(out: string): StackInfo | undefined {
  const kv = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  const project = kv.get("project");
  const port = Number(kv.get("port"));
  if (!project || !Number.isInteger(port)) return undefined;
  return { project, port, owner: kv.get("owner") ?? "" };
}

export type Verdict =
  | { kind: "free" } // nothing on the port: start this checkout's
  | { kind: "ours" } // this checkout's, on its code: frame it
  | { kind: "foreign"; owner: string } // another stack holds the port
  | { kind: "stale"; started: string; head: string }; // ours, on older code: restart it

/**
 * What to do before framing. `startedRef` is /api/health's started_ref (a
 * server from before it existed has none: left as it is), `head` this
 * checkout's HEAD ("" when git can't tell).
 */
export function judge(info: StackInfo, startedRef: string | undefined, head: string): Verdict {
  if (!info.owner) return { kind: "free" };
  if (info.owner !== info.project) return { kind: "foreign", owner: info.owner };
  if (startedRef && head && startedRef !== head) return { kind: "stale", started: startedRef, head };
  return { kind: "ours" };
}

/**
 * The stack id (VHIL_STACK_ID) of a firmware repository's stack: one per
 * repository over the extension's one checkout, so two firmware windows never
 * share a stack (each mounts its own working tree at /src/local). FNV-1a of
 * the path, 8 hex digits, like the script's own cksum-based id.
 */
export function stackId(dir: string): string {
  let h = 0x811c9dc5;
  for (const c of dir) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}
