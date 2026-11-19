// The vHIL sidebar's one view, without VS Code: the stack's state, the
// systems (open one in the system editor, its YAML, run its scenarios; make
// a new one) and the tools. Runs and results stay in VS Code's Testing
// panel. The tree itself is systemsTree.ts. Tested by test/systemsView.test.ts.

import { ImageState, imagesCost, imagesNeeded } from "./status";
import { SavedBranch } from "./branches";
import { SystemInfo } from "./systems";

/** What the view shows, without VS Code. */
export interface Row {
  kind: "status" | "system" | "branch" | "tools";
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
  baseState?: ImageState; // from vhil-docker.sh status; undefined: not known
  editorState?: ImageState;
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
  // The status bar says the same: a run would pull or build them first.
  if (imagesNeeded(s.baseState, s.editorState)) {
    return {
      kind: "status", id: "status", label: "Images needed", description: "Pull",
      tooltip: `${imagesCost(s.baseState, s.editorState)}\nClick to get them now, in a terminal.`,
      icon: "cloud-download", command: "vhil.pullImages",
    };
  }
  return {
    kind: "status", id: "status", label: "Stack ready",
    description: s.editorUp ? "editor running" : "editor stopped",
    tooltip: "Docker answers. Click to check images and firmware too.",
    icon: "pass", command: "vhil.diagnose",
  };
}

export function rows(systems: SystemInfo[], state: StackState, tools: boolean,
                     branches: SavedBranch[] = []): Row[] {
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
  // Saved by the editor's Commit… in the extension's checkout, not pushed yet.
  for (const b of branches) {
    out.push({
      kind: "branch", id: `branch:${b.branch}`, label: b.branch,
      description: ["not pushed", b.systems.join(", ")].filter(Boolean).join(" · "),
      tooltip: `Committed by the system editor in the vHIL checkout VS Code keeps for this repository` +
        `${b.systems.length ? ` (${b.systems.join(", ")})` : ""}, and on no remote yet.\n\n` +
        "Click to push it with your git and open its pull request.",
      icon: "git-branch", command: "vhil.pushSystemBranch", context: "vhilBranch",
    });
  }
  if (tools) out.push({ kind: "tools", id: "tools", label: "Tools…", icon: "tools", command: "vhil.tools" });
  return out;
}
