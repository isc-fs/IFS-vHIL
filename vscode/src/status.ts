// The extension's one status bar item and its Diagnose list, without VS
// Code: what they show for the vHIL's state. Tested by test/status.test.ts.

/** Where the vHIL is: what the status bar shows. */
export type Phase =
  | { kind: "checking" }
  | { kind: "down"; context: string }
  | { kind: "idle"; firmware?: string; dirty?: boolean; missing: string[] }
  | { kind: "building"; firmware: string }
  | { kind: "running"; done: number; total: number }
  | { kind: "result"; passed: number; failed: number; skipped: number; cancelled?: boolean };

/** What a click on the status bar does. */
export type Action = "diagnose" | "run" | "none";

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
      return p.failed
        ? { text: `$(error) vHIL ${p.failed} failed`, tooltip: `${counts}. Click to run them again.`, warn: true, action: "run" }
        : { text: `$(pass) vHIL ${p.passed}`, tooltip: `${counts}. Click to run them again.`, warn: false, action: "run" };
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
}

export interface Health {
  context: string;
  startsVm: boolean; // vhil-docker.sh vm starts this context (Colima)
  dockerUp: boolean;
  built: Map<string, string>; // board -> ELF, from /vhil/fw/built.txt
  needed: string[]; // the firmware sim and scenario tests need
  editorUp: boolean;
}

/** What Diagnose lists: each check, and the fix when it fails. */
export function findings(h: Health): Finding[] {
  const out: Finding[] = [];
  if (!h.dockerUp) {
    out.push(h.startsVm
      ? { ok: false, label: "Docker VM is down", detail: `context ${h.context}`, fix: "startVm" }
      : { ok: false, label: "Docker doesn't answer", detail: `context ${h.context}: start Docker, or pick another context`, fix: "openSettings" });
    return out;
  }
  out.push({ ok: true, label: "Docker answers", detail: `context ${h.context}` });
  out.push({ ok: true, label: "Images", detail: "pulled on first use; pull again for a fresh copy", fix: "pullImages" });
  const missing = h.needed.filter((b) => !h.built.get(b));
  out.push(missing.length
    ? { ok: false, label: "Firmware missing", detail: missing.join(", "), fix: "buildFirmware" }
    : { ok: true, label: "Firmware built", detail: [...h.built.keys()].sort().join(", ") });
  out.push({ ok: h.editorUp, label: "System editor", detail: h.editorUp ? "running · localhost:8080" : "stopped", fix: "openEditor" });
  return out;
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
