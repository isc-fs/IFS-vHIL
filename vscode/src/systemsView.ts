// The vHIL sidebar's one view, without VS Code: the stack's state, the
// systems (open one in the system editor, its YAML, run its scenarios; make
// a new one) and the tools. Runs and results stay in VS Code's Testing
// panel. The tree itself is systemsTree.ts. Tested by test/systemsView.test.ts.

import { SystemInfo } from "./systems";

/** What the view shows, without VS Code. */
export interface Row {
  kind: "status" | "system" | "tools";
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon: string;
  command?: string;
  context?: string; // contextValue: which inline actions it gets
}

export interface StackState {
  dockerUp?: boolean; // undefined: not checked yet
  editorUp: boolean;
  context: string;
}

/** An id a new system file can have: systems/<id>.yaml. */
export function newSystemError(id: string, existing: string[]): string | undefined {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return "lowercase letters, digits and dashes, e.g. ecu-ams-dash";
  if (existing.includes(id)) return `${id} exists: open it from the list instead`;
  return undefined;
}

export function statusRow(s: StackState): Row {
  if (s.dockerUp === undefined) {
    return { kind: "status", id: "status", label: "Checking Docker…", icon: "sync~spin" };
  }
  if (!s.dockerUp) {
    return {
      kind: "status", id: "status", label: "Docker not running", description: "Diagnose",
      tooltip: `Docker context ${s.context} doesn't answer. Click to diagnose and fix.`,
      icon: "debug-disconnect", command: "vhil.diagnose",
    };
  }
  return {
    kind: "status", id: "status", label: "Stack ready",
    description: s.editorUp ? "editor running" : "editor stopped",
    tooltip: "Docker answers. Click to check images and firmware too.",
    icon: "pass", command: "vhil.diagnose",
  };
}

export function rows(systems: SystemInfo[], state: StackState, tools: boolean): Row[] {
  const out: Row[] = [statusRow(state)];
  for (const s of systems) {
    const boards = s.boards.map((b) => b.name).join(", ");
    out.push({
      kind: "system", id: `system:${s.id}`, label: s.id,
      description: [boards, s.scenarios ? "scenarios" : ""].filter(Boolean).join(" · "),
      tooltip: `${s.description || s.id}\n\nClick to open it in the system editor.`,
      icon: "circuit-board", command: "vhil.openSystemInEditor",
      context: s.scenarios ? "vhilSystemWithScenarios" : "vhilSystem",
    });
  }
  if (tools) out.push({ kind: "tools", id: "tools", label: "Tools…", icon: "tools", command: "vhil.tools" });
  return out;
}
