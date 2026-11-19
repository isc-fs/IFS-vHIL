// The Systems view's tree (systemsView.ts has what it shows).

import * as vscode from "vscode";

import { Row } from "./systemsView";

/** The tree view over `rows`; the extension calls `update` when anything changes. */
export class SystemsView implements vscode.TreeDataProvider<Row> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private current: Row[] = [];

  update(next: Row[]) {
    this.current = next;
    this.changed.fire();
  }

  getChildren(element?: Row): Row[] {
    return element ? [] : this.current;
  }

  getTreeItem(r: Row): vscode.TreeItem {
    const item = new vscode.TreeItem(r.label, vscode.TreeItemCollapsibleState.None);
    item.id = r.id;
    item.description = r.description;
    item.tooltip = r.tooltip;
    item.iconPath = new vscode.ThemeIcon(r.icon);
    item.contextValue = r.context;
    if (r.command) {
      const system = r.kind === "system" ? r.label : undefined;
      item.command = { command: r.command, title: r.label, arguments: system ? [system] : [] };
    }
    return item;
  }

  dispose() {
    this.changed.dispose();
  }
}
