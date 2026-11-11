// The sidebar's tree views: plain nodes, rebuilt from the extension's state
// each time a view refreshes.
import * as vscode from "vscode";

export class Node extends vscode.TreeItem {
  children?: Node[];
  data?: unknown;
}

export interface NodeOptions {
  description?: string;
  tooltip?: string | vscode.MarkdownString;
  icon?: string;
  color?: string; // a theme colour id, e.g. testing.iconFailed
  context?: string;
  command?: vscode.Command;
  children?: Node[];
  expanded?: boolean;
  data?: unknown;
}

export function node(label: string, o: NodeOptions = {}): Node {
  const state = o.children?.length
    ? (o.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
    : vscode.TreeItemCollapsibleState.None;
  const n = new Node(label, state);
  n.description = o.description;
  n.tooltip = o.tooltip;
  if (o.icon) n.iconPath = new vscode.ThemeIcon(o.icon, o.color ? new vscode.ThemeColor(o.color) : undefined);
  n.contextValue = o.context;
  n.command = o.command;
  n.children = o.children;
  n.data = o.data;
  return n;
}

export class Tree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly roots: () => Node[]) {}

  refresh() {
    this.changed.fire(undefined);
  }

  getTreeItem(n: Node): Node {
    return n;
  }

  getChildren(n?: Node): Node[] {
    return n ? n.children ?? [] : this.roots();
  }

  dispose() {
    this.changed.dispose();
  }
}
