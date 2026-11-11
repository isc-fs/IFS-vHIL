// The vHIL in VS Code's Testing panel: every test of tests/unit, tests/sim
// and tests/scenarios, run in the vHIL's Docker image through
// scripts/vhil-docker.sh, as CI runs them (vscode/README.md).
import * as cp from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import {
  builtFirmware, collectArgs, dockerContext, fileOf, Item, Job, labelOf, parseLines, plan,
  Record, runArgs, SUITES,
} from "./plan";

const SCRIPT = "scripts/vhil-docker.sh";
// Where the plugin's JSON lines go: results/ is git-ignored and inside /work.
const OUT_DIR = "results/vscode";
// Firmware the sim and scenario jobs need (scripts/vhil-docker.sh need_elf).
const NEEDED_FW = ["ecu", "ams", "ecu.bootloader"];

export function activate(context: vscode.ExtensionContext) {
  const folder = vscode.workspace.workspaceFolders?.find((f) =>
    fs.existsSync(path.join(f.uri.fsPath, SCRIPT)));
  if (!folder) return;
  const vhil = new Vhil(folder.uri.fsPath, context);
  context.subscriptions.push(vhil);
  void vhil.refresh();
  void vhil.checkStatus();
}

export function deactivate() {}

class Vhil implements vscode.Disposable {
  private readonly controller: vscode.TestController;
  private readonly status: vscode.StatusBarItem;
  private readonly log: vscode.OutputChannel;
  private readonly tags = new Map<string, vscode.TestTag>();
  private readonly byId = new Map<string, vscode.TestItem>();
  private readonly disposables: vscode.Disposable[] = [];
  private refreshing: Promise<void> | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(private readonly repo: string, context: vscode.ExtensionContext) {
    this.controller = vscode.tests.createTestController("vhil", "vHIL");
    this.controller.refreshHandler = () => this.refresh();
    this.controller.createRunProfile("Run", vscode.TestRunProfileKind.Run,
      (request, token) => this.run(request, token), true);

    this.log = vscode.window.createOutputChannel("vHIL");
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = "vhil.menu";
    this.status.text = "$(beaker) vHIL";
    this.status.show();

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(repo, "tests/{unit,sim,scenarios}/**/*.py"));
    const later = () => this.refreshSoon();
    this.disposables.push(
      this.controller, this.status, this.log, watcher,
      watcher.onDidChange(later), watcher.onDidCreate(later), watcher.onDidDelete(later),
      vscode.commands.registerCommand("vhil.refreshTests", () => this.refresh()),
      vscode.commands.registerCommand("vhil.checkStatus", () => this.checkStatus()),
      vscode.commands.registerCommand("vhil.startVm", () => this.terminal("vm")),
      vscode.commands.registerCommand("vhil.buildFirmware", () => this.buildFirmware()),
      vscode.commands.registerCommand("vhil.openEditor", () => this.openEditor()),
      vscode.commands.registerCommand("vhil.menu", () => this.menu()),
      vscode.window.onDidCloseTerminal((t) => {
        if (t.name.startsWith("vHIL")) void this.checkStatus();
      }),
    );
    void context;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }

  // -- settings and processes -------------------------------------------------

  private config() {
    const c = vscode.workspace.getConfiguration("vhil");
    return {
      context: dockerContext(c.get<string>("dockerContext", ""), process.platform),
      ifsHilRef: c.get<string>("ifsHilRef", ""),
      firmwareRefs: c.get<string>("firmwareRefs", ""),
      cpus: c.get<number>("cpus", 0),
      pytestArgs: c.get<string[]>("pytestArgs", []),
    };
  }

  /** The environment vhil-docker.sh reads, from the settings. */
  private env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const c = this.config();
    const env: NodeJS.ProcessEnv = { ...process.env, VHIL_DOCKER_CONTEXT: c.context, ...extra };
    if (c.ifsHilRef) env.IFS_HIL_REF = c.ifsHilRef;
    if (c.firmwareRefs) env.FW_REFS = c.firmwareRefs;
    if (c.cpus > 0) env.VHIL_DOCKER_CPUS = String(c.cpus);
    return env;
  }

  /** Run vhil-docker.sh with `args`; `onData` gets its output as it comes. */
  private script(args: string[], env: NodeJS.ProcessEnv,
                 onData?: (text: string) => void): { done: Promise<number>; proc: cp.ChildProcess } {
    const proc = cp.spawn(path.join(this.repo, SCRIPT), args, { cwd: this.repo, env });
    const out = (b: Buffer) => onData?.(b.toString());
    proc.stdout.on("data", out);
    proc.stderr.on("data", out);
    const done = new Promise<number>((resolve) => {
      proc.on("error", (e) => { onData?.(`${e}\n`); resolve(-1); });
      proc.on("close", (code) => resolve(code ?? -1));
    });
    return { done, proc };
  }

  /** A command in a terminal, for the long ones the user should watch. */
  private terminal(...args: string[]) {
    const t = vscode.window.createTerminal({ name: `vHIL ${args[0]}`, cwd: this.repo, env: this.env() });
    t.show();
    t.sendText([SCRIPT, ...args].map(shellQuote).join(" ") + "; exit");
  }

  private outFile(name: string): { rel: string; abs: string } {
    const rel = `${OUT_DIR}/${name}.jsonl`;
    const abs = path.join(this.repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.rmSync(abs, { force: true });
    return { rel, abs };
  }

  // -- the test tree ----------------------------------------------------------

  private refreshSoon() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), 1500);
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.collect().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async collect() {
    const out = this.outFile("collect");
    let text = "";
    const job = this.script(collectArgs(out.rel), this.env(), (t) => { text += t; this.log.append(t); });
    const code = await vscode.window.withProgress(
      { location: { viewId: "workbench.view.testing" }, title: "vHIL: listing tests" },
      () => job.done);
    const records = fs.existsSync(out.abs) ? parseLines(fs.readFileSync(out.abs, "utf8")).records : [];
    const items = records.filter((r): r is Item => r.kind === "item");
    if (!items.length) {
      this.log.show(true);
      void vscode.window.showErrorMessage(
        `vHIL: listing the tests failed (exit ${code}). Is the Docker VM up? See the vHIL output.`,
        "Start VM").then((a) => { if (a) this.terminal("vm"); });
      return;
    }
    this.build(items, records);
  }

  private tag(marker: string): vscode.TestTag {
    let t = this.tags.get(marker);
    if (!t) this.tags.set(marker, (t = new vscode.TestTag(marker)));
    return t;
  }

  private build(items: Item[], records: Record[]) {
    this.byId.clear();
    const roots: vscode.TestItem[] = [];
    for (const suite of SUITES) {
      const root = this.controller.createTestItem(suite.root, suite.root,
        vscode.Uri.file(path.join(this.repo, suite.root)));
      this.byId.set(suite.root, root);
      roots.push(root);
    }
    const files = new Map<string, vscode.TestItem>();
    for (const item of items) {
      const root = this.byId.get(SUITES.find((s) => item.id.startsWith(s.root + "/"))?.root ?? "");
      if (!root) continue;
      const file = fileOf(item.id);
      const uri = vscode.Uri.file(path.join(this.repo, item.file));
      let parent = files.get(file);
      if (!parent) {
        parent = this.controller.createTestItem(file, path.relative(root.id, file), uri);
        files.set(file, parent);
        this.byId.set(file, parent);
        root.children.add(parent);
      }
      const test = this.controller.createTestItem(item.id, labelOf(item.id), uri);
      test.range = new vscode.Range(item.line - 1, 0, item.line - 1, 0);
      test.tags = item.markers.map((m) => this.tag(m));
      parent.children.add(test);
      this.byId.set(item.id, test);
    }
    // A file that didn't import: an error on its root, with pytest's text.
    for (const r of records) {
      if (r.kind === "error") {
        const node = this.byId.get(r.id) ?? this.byId.get(SUITES.find((s) => r.id.startsWith(s.root))?.root ?? "");
        if (node) node.error = new vscode.MarkdownString().appendCodeblock(r.message);
      }
    }
    this.controller.items.replace(roots);
  }

  // -- runs -------------------------------------------------------------------

  private leaves(item: vscode.TestItem, into: vscode.TestItem[] = []): vscode.TestItem[] {
    if (item.children.size === 0) into.push(item);
    item.children.forEach((c) => this.leaves(c, into));
    return into;
  }

  private async run(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    if (!this.byId.size) await this.refresh();
    const included = request.include ?? [...this.controller.items].map(([, i]) => i);
    const excluded = request.exclude ?? [];
    const excludedIds = new Set(excluded.flatMap((e) => this.leaves(e)).map((e) => e.id));
    const run = this.controller.createTestRun(request);
    const all = included.flatMap((i) => this.leaves(i)).filter((t) => !excludedIds.has(t.id));
    for (const t of all) run.enqueued(t);

    const groups = plan(included.map((i) => i.id));
    const c = this.config();
    try {
      for (const [job, ids] of groups) {
        if (token.isCancellationRequested) break;
        const mine = all.filter((t) => ids.some((id) => t.id === id || t.id.startsWith(id + "/") || t.id.startsWith(id + "::")));
        const deselect = [...excludedIds].filter((id) => ids.some((g) => id.startsWith(g + "/") || id.startsWith(g + "::")));
        await this.runJob(run, job, ids, deselect, mine, c.pytestArgs, c.context, token);
      }
    } finally {
      run.end();
    }
  }

  private async runJob(run: vscode.TestRun, job: Job, ids: string[], deselect: string[],
                       tests: vscode.TestItem[], extra: string[], context: string,
                       token: vscode.CancellationToken) {
    const name = `vhil-vscode-${crypto.randomBytes(4).toString("hex")}`;
    const out = this.outFile(name);
    const args = runArgs(job, ids, deselect, out.rel, extra);
    run.appendOutput(`$ ${SCRIPT} ${args.map(shellQuote).join(" ")}\r\n`);
    let text = "";
    const proc = this.script(args, this.env({ VHIL_DOCKER_NAME: name }), (t) => {
      text += t;
      run.appendOutput(t.replace(/\r?\n/g, "\r\n"));
    });
    const cancel = token.onCancellationRequested(() => {
      // The container, not just the script: docker run doesn't pass SIGTERM on to pytest.
      cp.execFile("docker", ["--context", context, "kill", name], () => proc.proc.kill());
    });

    const reported = new Set<string>();
    let offset = 0;
    let rest = "";
    const read = () => {
      if (!fs.existsSync(out.abs)) return;
      const fd = fs.openSync(out.abs, "r");
      try {
        const size = fs.fstatSync(fd).size;
        if (size <= offset) return;
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        offset = size;
        const parsed = parseLines(rest + buf.toString("utf8"));
        rest = parsed.rest;
        for (const r of parsed.records) this.report(run, r, reported);
      } finally {
        fs.closeSync(fd);
      }
    };
    const timer = setInterval(read, 500);
    const code = await proc.done;
    clearInterval(timer);
    cancel.dispose();
    read();
    fs.rmSync(out.abs, { force: true });

    // Tests the run never reached: why, from the job's last lines.
    const left = tests.filter((t) => !reported.has(t.id));
    if (!left.length) return;
    if (token.isCancellationRequested) {
      for (const t of left) run.skipped(t);
      return;
    }
    const tail = text.trim().split("\n").slice(-15).join("\n");
    const why = new vscode.TestMessage(`${SCRIPT} ${job} exited ${code} before this test ran:\n\n${tail}`);
    for (const t of left) run.errored(t, why);
  }

  private report(run: vscode.TestRun, r: Record, reported: Set<string>) {
    if (r.kind === "start") {
      const t = this.byId.get(r.id);
      if (t) run.started(t);
      return;
    }
    if (r.kind !== "result") return;
    const t = this.byId.get(r.id);
    if (!t) return;
    reported.add(r.id);
    const ms = r.duration * 1000;
    if (r.outcome === "passed") {
      run.passed(t, ms);
    } else if (r.outcome === "skipped") {
      run.skipped(t);
    } else {
      const msg = new vscode.TestMessage(r.message ?? r.short ?? "failed");
      if (r.file && r.line) {
        msg.location = new vscode.Location(vscode.Uri.file(path.join(this.repo, r.file)),
          new vscode.Position(r.line - 1, 0));
      }
      run.failed(t, msg, ms);
    }
  }

  // -- VM, firmware, editor ---------------------------------------------------

  async checkStatus() {
    const { context } = this.config();
    this.status.text = "$(sync~spin) vHIL";
    const up = await new Promise<boolean>((resolve) =>
      cp.execFile("docker", ["--context", context, "info", "--format", "{{.ServerVersion}}"],
        { timeout: 15000 }, (err) => resolve(!err)));
    if (!up) {
      this.status.text = "$(debug-disconnect) vHIL: VM down";
      this.status.tooltip = `Docker context ${context} doesn't answer. Click to start the VM.`;
      this.status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      return;
    }
    let text = "";
    const code = await this.script(["run", "sh", "-c", "cat /vhil/fw/built.txt 2>/dev/null || true"],
      this.env(), (t) => { text += t; }).done;
    const built = builtFirmware(code === 0 ? text : "");
    const missing = NEEDED_FW.filter((b) => !built.get(b));
    this.status.backgroundColor = missing.length
      ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    this.status.text = missing.length ? "$(beaker) vHIL: no firmware" : "$(beaker) vHIL";
    this.status.tooltip = new vscode.MarkdownString(
      `**vHIL** on Docker context \`${context}\`\n\n` +
      (built.size ? [...built].map(([b, elf]) => `- ${b}: \`${path.basename(elf)}\``).join("\n")
                  : "No firmware built: sim and scenario tests need ecu, ams and the bootloader.") +
      "\n\nClick for actions.");
  }

  private async buildFirmware() {
    const pick = await vscode.window.showQuickPick(
      [{ label: "ecu ams", description: "what sim and scenario tests need" },
       { label: "ecu ams udv", description: "and the uDV, for its tests" },
       { label: "", description: "every board of every system", detail: "fw with no arguments" }],
      { title: "vHIL: build firmware (IFS_HIL's recipes, in Docker)" });
    if (pick) this.terminal("fw", ...pick.label.split(" ").filter(Boolean));
  }

  private async openEditor() {
    const url = "http://localhost:8080/editor/";
    const up = await fetch(url).then((r) => r.ok, () => false);
    if (!up) {
      this.terminal("editor");
      void vscode.window.showInformationMessage("vHIL: starting the editor; open it once it's up.", "Open")
        .then((a) => { if (a) void vscode.env.openExternal(vscode.Uri.parse(url)); });
      return;
    }
    void vscode.env.openExternal(vscode.Uri.parse(url));
  }

  private async menu() {
    const actions: { label: string; run: () => unknown }[] = [
      { label: "$(refresh) Refresh tests", run: () => this.refresh() },
      { label: "$(vm) Start the Docker VM", run: () => this.terminal("vm") },
      { label: "$(tools) Build firmware…", run: () => this.buildFirmware() },
      { label: "$(type-hierarchy) Open the system editor", run: () => this.openEditor() },
      { label: "$(pulse) Check VM and firmware", run: () => this.checkStatus() },
      { label: "$(gear) Settings", run: () => vscode.commands.executeCommand("workbench.action.openSettings", "vhil.") },
    ];
    const pick = await vscode.window.showQuickPick(actions, { title: "vHIL" });
    await pick?.run();
  }
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
