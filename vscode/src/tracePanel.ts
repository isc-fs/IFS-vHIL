// The vHIL Trace panel: one view in the bottom panel showing a test's bus
// trace (docs/test-trace.md), drawn by media/trace.js. It shows the last
// failed test of a run by itself, without taking focus; any traced test
// opens in it from the Testing panel (Show bus trace).
import * as crypto from "crypto";
import * as fs from "fs";
import * as vscode from "vscode";

export const TRACE_VIEW = "vhil.trace";

export class TracePanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private current: { title: string; file: string } | undefined;
  private ready = false;

  constructor(private readonly extension: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.ready = false;
    const media = vscode.Uri.joinPath(this.extension, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = html(view.webview, vscode.Uri.joinPath(media, "trace.js"));
    view.webview.onDidReceiveMessage((m) => {
      if (m?.type !== "ready") return;
      this.ready = true;
      this.post();
    });
    view.onDidDispose(() => { this.view = undefined; this.ready = false; });
  }

  /** Show `file` (a .trace.jsonl); `reveal` brings the panel up. */
  async show(file: string, title: string, reveal: boolean) {
    this.current = { file, title };
    if (reveal) await vscode.commands.executeCommand(`${TRACE_VIEW}.focus`);
    this.post();
  }

  private post() {
    if (!this.view || !this.ready || !this.current) return;
    let records: unknown[] = [];
    try {
      records = fs.readFileSync(this.current.file, "utf8").split("\n").filter((l) => l.trim())
        .flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    } catch (e) {
      records = [{ kind: "error", what: "read", message: `${e}` }];
    }
    void this.view.webview.postMessage({ type: "trace", title: this.current.title, records });
    this.view.description = this.current.title;
  }
}

function html(webview: vscode.Webview, script: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
body { padding: 0 8px; margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
       color: var(--vscode-foreground); display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
.bar { display: flex; gap: 8px; align-items: center; padding: 6px 0; flex-wrap: wrap; }
#title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40%; }
.outcome { font-size: 11px; padding: 0 6px; border-radius: 8px; }
.outcome.failed { background: var(--vscode-testing-iconFailed); color: var(--vscode-editor-background); }
.outcome.passed { background: var(--vscode-testing-iconPassed); color: var(--vscode-editor-background); }
#filter { flex: 1; min-width: 160px; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
          border: 1px solid var(--vscode-input-border, transparent); padding: 2px 6px; }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
         border: 0; padding: 2px 8px; cursor: pointer; }
.muted { color: var(--vscode-descriptionForeground); font-size: 11px; }
#lanes { width: 100%; display: block; cursor: crosshair; }
#rows { flex: 1; overflow: auto; position: relative; min-height: 80px; border-top: 1px solid var(--vscode-panel-border); }
#view { position: absolute; top: 0; left: 0; right: 0; }
.row { position: absolute; left: 0; right: 0; height: 20px; line-height: 20px; white-space: nowrap; cursor: pointer;
       font-family: var(--vscode-editor-font-family); font-size: 12px; }
.row:hover { background: var(--vscode-list-hoverBackground); }
.row.picked { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.row.bad { color: var(--vscode-errorForeground); }
.row span { display: inline-block; overflow: hidden; text-overflow: ellipsis; vertical-align: top; padding-right: 8px; }
.t { width: 90px; text-align: right; } .lane { width: 130px; } .id { width: 70px; } .name { width: 200px; }
.data { width: 150px; } .note { width: 120px; color: var(--vscode-descriptionForeground); }
#detail { white-space: pre; font-family: var(--vscode-editor-font-family); font-size: 12px; max-height: 30%;
          overflow: auto; border-top: 1px solid var(--vscode-panel-border); padding: 4px 0; }
#detail:empty { display: none; }
#errors { color: var(--vscode-errorForeground); white-space: pre; font-size: 11px; }
#errors:empty, #empty { display: none; }
details { font-size: 12px; } #uart-lines { white-space: pre; font-family: var(--vscode-editor-font-family);
  max-height: 120px; overflow: auto; }
</style></head><body>
<div class="bar"><span id="title">Run a test: its buses show here.</span><span id="outcome" class="outcome"></span>
<input id="filter" placeholder="Filter: id, message, signal, bus, board (all words)">
<span id="count" class="muted"></span><span id="span" class="muted"></span>
<button id="to-fail" title="The 2 s before the failure">Failure</button><button id="reset" title="Whole test (double-click the lanes)">All</button></div>
<div id="empty" class="muted">This test recorded nothing.</div>
<div id="errors"></div>
<canvas id="lanes"></canvas>
<div id="rows"><div id="spacer"></div><div id="view"></div></div>
<div id="detail"></div>
<details id="uart" style="display:none"><summary>UART <span id="uart-count" class="muted"></span></summary><div id="uart-lines"></div></details>
<script nonce="${nonce}" src="${webview.asWebviewUri(script)}"></script>
</body></html>`;
}
