// The extension's one status bar item and its Diagnose list, without VS
// Code: what they show for the vHIL's state. Tested by test/status.test.ts.

import { builtLines } from "./plan";

/**
 * An image of this checkout (scripts/vhil-docker.sh status): here by its
 * key, published but not pulled, published nowhere (the first run builds
 * it), or not known (the registry didn't answer).
 */
export type ImageState = "local" | "published" | "missing" | "unknown";

/** What `scripts/vhil-docker.sh status` says, as key=value lines. */
export interface StackStatus {
  docker: "up" | "down" | "nocli";
  baseState?: ImageState;
  editorState?: ImageState;
  built: Map<string, string>; // board -> ELF, from its built=<board>=<elf> lines
}

const STATES: ImageState[] = ["local", "published", "missing", "unknown"];

/**
 * `vhil-docker.sh status`'s output, or undefined when it isn't that (a
 * checkout whose script has no `status` verb prints its usage instead): no
 * `docker=` line. Later built= lines for a board win, as in built.txt.
 */
export function parseStatus(text: string): StackStatus | undefined {
  let docker: StackStatus["docker"] | undefined;
  let baseState: ImageState | undefined;
  let editorState: ImageState | undefined;
  const built: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at);
    const value = line.slice(at + 1);
    const state = STATES.find((s) => s === value);
    if (key === "docker" && (value === "up" || value === "down" || value === "nocli")) docker = value;
    else if (key === "base_state" && state) baseState = state;
    else if (key === "editor_state" && state) editorState = state;
    else if (key === "built") built.push(value);
  }
  if (!docker) return undefined;
  return { docker, baseState, editorState, built: builtLines(built.join("\n")) };
}

/** Whether a run would first pull or build an image: one of them isn't here. */
export function imagesNeeded(base?: ImageState, editor?: ImageState): boolean {
  return [base, editor].some((s) => s === "missing" || s === "published");
}

/** What getting the images costs, for a tooltip. */
export function imagesCost(base?: ImageState, editor?: ImageState): string {
  if (base === "missing") return "No published image matches this checkout: the base builds from source, ~30 min.";
  if (editor === "missing" && base !== "published") {
    return "The editor image builds on the published base (a few minutes).";
  }
  return "The published images of this checkout aren't here yet: pull several GB once.";
}

/** Where the vHIL is: what the status bar shows. */
export type Phase =
  | { kind: "checking" }
  | { kind: "down"; context: string }
  | { kind: "images"; base?: ImageState; editor?: ImageState }
  | { kind: "idle"; firmware?: string; dirty?: boolean; missing: string[] }
  | { kind: "building"; firmware: string }
  | { kind: "running"; done: number; total: number }
  | { kind: "result"; passed: number; failed: number; skipped: number; cancelled?: boolean };

/** What a click on the status bar does. */
export type Action = "diagnose" | "run" | "pullImages" | "none";

export interface Bar {
  text: string;
  tooltip: string;
  warn: boolean;
  action: Action;
}

/** The status bar for a phase. Idle or after a run, a click runs the tests again. */
export function barOf(p: Phase): Bar {
  switch (p.kind) {
    case "checking":
      return { text: "$(sync~spin) vHIL", tooltip: "vHIL: checking Docker and the firmware…", warn: false, action: "none" };
    case "down":
      return {
        text: "$(debug-disconnect) vHIL: Docker not running",
        tooltip: `Docker context ${p.context} doesn't answer. Click to diagnose and fix.`,
        warn: true, action: "diagnose",
      };
    case "images":
      return {
        text: "$(cloud-download) vHIL: images needed",
        tooltip: `${imagesCost(p.base, p.editor)}\nClick to get them now, in a terminal (else the first run does).`,
        warn: false, action: "pullImages",
      };
    case "idle": {
      const mine = p.firmware ? ` ${p.firmware}@local${p.dirty ? "*" : ""}` : "";
      return {
        text: `$(beaker) vHIL${mine}`,
        tooltip: (p.firmware ? `Testing your working tree of ${p.firmware}${p.dirty ? " (uncommitted changes)" : ""}, built before each run.\n` : "") +
                 (p.missing.length ? `The first run also builds ${p.missing.join(", ")}.\n` : "") +
                 "Click to run the tests.",
        warn: false, action: "run",
      };
    }
    case "building":
      return { text: `$(sync~spin) vHIL: building ${p.firmware}`, tooltip: "Building the firmware before the run.", warn: false, action: "none" };
    case "running":
      return { text: `$(sync~spin) vHIL ${p.done}/${p.total}`, tooltip: "Running the tests: see the Testing panel.", warn: false, action: "none" };
    case "result": {
      const counts = `${p.passed} passed, ${p.failed} failed${p.skipped ? `, ${p.skipped} skipped` : ""}`;
      if (p.cancelled) {
        return { text: "$(circle-slash) vHIL cancelled", tooltip: `${counts}. Click to run them again.`, warn: false, action: "run" };
      }
      if (p.failed) {
        return { text: `$(error) vHIL ${p.failed} failed`, tooltip: `${counts}. Click to run them again.`, warn: true, action: "run" };
      }
      // Nothing passed and nothing failed: nothing was tested, which is no pass.
      if (!p.passed && p.skipped) {
        return { text: `$(warning) vHIL: ${p.skipped} skipped`, tooltip: `${counts}: no test ran. Click to run them again.`, warn: true, action: "run" };
      }
      return { text: `$(pass) vHIL ${p.passed}`, tooltip: `${counts}. Click to run them again.`, warn: false, action: "run" };
    }
  }
}

/** A fix Diagnose offers, as the command it runs. */
export type Fix = "startVm" | "pullImages" | "buildFirmware" | "openSettings" | "openEditor";

export interface Finding {
  ok: boolean;
  label: string;
  detail: string;
  fix?: Fix;
  setting?: string; // openSettings: which one
}

/** The debugger Debug Test needs: the C/C++ extension and the host's GDB. */
export interface DebuggerHealth {
  cpptools: boolean;
  gdb: string; // the command tried (vhil.gdbPath, else arm-none-eabi-gdb)
  version?: string; // `gdb --version`'s first line; undefined: it didn't run
}

export interface Health {
  context: string;
  startsVm: boolean; // vhil-docker.sh vm starts this context (Colima)
  dockerCli: boolean; // the docker command exists
  dockerUp: boolean;
  baseState?: ImageState; // undefined: the checkout's script has no `status`
  editorState?: ImageState;
  built: Map<string, string>; // board -> ELF, from /vhil/fw/built.txt
  needed: string[]; // the firmware sim and scenario tests need
  editorUp: boolean;
  debugger?: DebuggerHealth;
}

/** The images' finding, from their states. */
function imagesFinding(h: Health): Finding {
  const { baseState: b, editorState: e } = h;
  if (b === undefined && e === undefined) {
    return { ok: true, label: "Images", detail: "pulled on first use; pull again for a fresh copy", fix: "pullImages" };
  }
  if (b === "local" && e === "local") return { ok: true, label: "Images", detail: "this checkout's, here" };
  if (b === "missing") {
    return { ok: false, label: "Images", detail: "no published image: the first run builds Renode (~30 min)", fix: "pullImages" };
  }
  if (b === "unknown" || e === "unknown") {
    return { ok: false, label: "Images", detail: "registry unreachable: can't tell whether they are published" };
  }
  if (b === "published" || e === "published") {
    return { ok: false, label: "Images", detail: "published, not pulled yet (several GB)", fix: "pullImages" };
  }
  return { ok: false, label: "Images", detail: "the editor image builds on the published base (a few minutes)" };
}

function debuggerFinding(d: DebuggerHealth): Finding {
  if (!d.cpptools) {
    return { ok: false, label: "Debugger", detail: "Debug Test needs the C/C++ extension (ms-vscode.cpptools)" };
  }
  return d.version
    ? { ok: true, label: "Debugger", detail: d.version }
    : { ok: false, label: "Debugger", detail: `${d.gdb} doesn't run: install it, or set vhil.gdbPath`,
        fix: "openSettings", setting: "vhil.gdbPath" };
}

/** What Diagnose lists: each check, and the fix when it fails. */
export function findings(h: Health): Finding[] {
  const out: Finding[] = [];
  const tail = () => (h.debugger ? [...out, debuggerFinding(h.debugger)] : out);
  if (!h.dockerCli) {
    out.push({ ok: false, label: "Docker CLI not found", detail: "brew install colima docker docker-compose" });
    return tail();
  }
  if (!h.dockerUp) {
    out.push(h.startsVm
      ? { ok: false, label: "Docker VM is down", detail: `context ${h.context}`, fix: "startVm" }
      : { ok: false, label: "Docker doesn't answer", detail: `context ${h.context}: start Docker, or pick another context`,
          fix: "openSettings", setting: "vhil.dockerContext" });
    return tail();
  }
  out.push({ ok: true, label: "Docker answers", detail: `context ${h.context}` });
  out.push(imagesFinding(h));
  const missing = h.needed.filter((b) => !h.built.get(b));
  out.push(missing.length
    ? { ok: false, label: "Firmware missing", detail: missing.join(", "), fix: "buildFirmware" }
    : { ok: true, label: "Firmware built", detail: [...h.built.keys()].sort().join(", ") });
  out.push({ ok: h.editorUp, label: "System editor", detail: h.editorUp ? "running · localhost:8080" : "stopped", fix: "openEditor" });
  return tail();
}

/** The system of a scenario test (test_scenario[<system>/<name>]), else undefined. */
export function scenarioSystem(testId: string): string | undefined {
  if (!testId.startsWith("tests/scenarios/")) return undefined;
  return /\[([\w.-]+)\/[^\]]*\]$/.exec(testId)?.[1];
}

/** The id of a scenario system's group in the test tree. Not a pytest id: runs expand it. */
export const GROUP = "group:";
export function groupId(system: string): string {
  return `${GROUP}scenarios/${system}`;
}
