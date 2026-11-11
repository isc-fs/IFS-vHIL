// The vHIL in VS Code: every test of tests/unit, tests/sim and
// tests/scenarios in the Testing panel, and a vHIL sidebar (Status, Systems,
// Runs, Tools), all run in the vHIL's Docker image through
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
import {
  boardsOf, descriptionOf, ifsHilArgs, keepRuns, RunRecord, runDescription, runOk, SystemInfo,
  systemTests, ToolId, TOOLS,
} from "./sidebar";
import { node, Node, Tree } from "./views";

const SCRIPT = "scripts/vhil-docker.sh";
// Where the plugin's JSON lines go: results/ is git-ignored and inside /work.
const OUT_DIR = "results/vscode";
// Firmware the sim and scenario jobs need (scripts/vhil-docker.sh need_elf).
const NEEDED_FW = ["ecu", "ams", "ecu.bootloader"];
const EDITOR_URL = "http://localhost:8080/editor/";
const RUNS_KEY = "vhil.runs";
// A test run's output kept for Show output, per run.
const MAX_OUTPUT = 4 * 1024 * 1024;

export function activate(context: vscode.ExtensionContext) {
  const folder = vscode.workspace.workspaceFolders?.find((f) =>
    fs.existsSync(path.join(f.uri.fsPath, SCRIPT)));
  if (!folder) return;
  const vhil = new Vhil(folder, context);
  context.subscriptions.push(vhil);
  void vhil.refresh();
  void vhil.checkStatus();
}

export function deactivate() {}

/** What a test run counted, for the Runs view. */
interface Tally {
  passed: number;
  failed: Set<string>;
  skipped: number;
  output: string[];
  size: number;
}

class Vhil implements vscode.Disposable {
  private readonly repo: string;
  private readonly controller: vscode.TestController;
  private readonly status: vscode.StatusBarItem;
  private readonly log: vscode.OutputChannel;
  private readonly tags = new Map<string, vscode.TestTag>();
  private readonly byId = new Map<string, vscode.TestItem>();
  private readonly disposables: vscode.Disposable[] = [];
  private refreshing: Promise<void> | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;

  // The sidebar's state.
  private readonly statusTree = new Tree(() => this.statusNodes());
  private readonly systemsTree = new Tree(() => this.systemNodes());
  private readonly runsTree = new Tree(() => this.runNodes());
  private readonly toolsTree = new Tree(() => this.toolNodes());
  private vmUp: boolean | undefined;
  private built = new Map<string, string>();
  private editorUp = false;
  private editorTask: vscode.TaskExecution | undefined;
  private checking: Promise<void> | undefined;
  private checked = 0;
  private systems: SystemInfo[] = [];
  private runs: RunRecord[];
  private readonly outputs = new Map<string, string>();

  constructor(private readonly folder: vscode.WorkspaceFolder, private readonly context: vscode.ExtensionContext) {
    this.repo = folder.uri.fsPath;
    this.runs = context.workspaceState.get<RunRecord[]>(RUNS_KEY, []);
    this.controller = vscode.tests.createTestController("vhil", "vHIL");
    this.controller.refreshHandler = () => this.refresh();
    this.controller.createRunProfile("Run", vscode.TestRunProfileKind.Run,
      (request, token) => this.run(request, token), true);

    this.log = vscode.window.createOutputChannel("vHIL");
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = "vhil.menu";
    this.status.text = "$(beaker) vHIL";
    this.status.show();

    const statusView = vscode.window.createTreeView("vhil.status", { treeDataProvider: this.statusTree });
    const views = [
      statusView,
      vscode.window.createTreeView("vhil.systems", { treeDataProvider: this.systemsTree }),
      vscode.window.createTreeView("vhil.runs", { treeDataProvider: this.runsTree }),
      vscode.window.createTreeView("vhil.tools", { treeDataProvider: this.toolsTree }),
    ];
    this.readSystems();

    const tests = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.repo, "tests/{unit,sim,scenarios}/**/*.py"));
    const systems = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.repo, "systems/**"));
    const later = () => this.refreshSoon();
    const reread = () => this.readSystems();
    const command = (id: string, f: (...a: any[]) => unknown) => vscode.commands.registerCommand(id, f);
    this.disposables.push(
      this.controller, this.status, this.log, tests, systems, ...views,
      this.statusTree, this.systemsTree, this.runsTree, this.toolsTree,
      tests.onDidChange(later), tests.onDidCreate(later), tests.onDidDelete(later),
      systems.onDidChange(reread), systems.onDidCreate(reread), systems.onDidDelete(reread),
      statusView.onDidChangeVisibility((e) => {
        if (e.visible && Date.now() - this.checked > 15000) void this.checkStatus();
      }),
      vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution === this.editorTask) this.editorTask = undefined;
        if (e.execution.task.source === "vHIL") void this.checkStatus();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("vhil")) this.statusTree.refresh();
      }),

      command("vhil.refreshTests", () => this.refresh()),
      command("vhil.checkStatus", () => this.checkStatus()),
      command("vhil.menu", () => this.menu()),
      command("vhil.startVm", () => this.task("Start the Docker VM", ["vm"])),
      command("vhil.pullImages", () => this.task("Pull images", ["pull"])),
      command("vhil.buildImages", () => this.task("Build images", ["image"])),
      command("vhil.buildFirmware", () => this.buildFirmware()),
      command("vhil.rebuildBoard", (n: Node) => this.task(`Build firmware: ${n.data}`, ["fw", String(n.data)])),
      command("vhil.openEditor", () => this.openEditor()),
      command("vhil.stopEditor", () => this.editorTask?.terminate()),
      command("vhil.openSettings", (key?: string) =>
        vscode.commands.executeCommand("workbench.action.openSettings", typeof key === "string" ? key : "vhil.")),

      command("vhil.openSystemFile", (n: Node) =>
        vscode.window.showTextDocument(vscode.Uri.file(path.join(this.repo, `systems/${this.systemOf(n).id}.yaml`)))),
      command("vhil.validateSystem", (n: Node) => {
        const s = this.systemOf(n);
        return this.task(`Validate ${s.id}`, ["run", "python", "-m", "vhil.system", "validate", `systems/${s.id}.yaml`]);
      }),
      command("vhil.runSystemSim", (n: Node) => this.runSystem(this.systemOf(n), "sim")),
      command("vhil.runSystemScenarios", (n: Node) => this.runSystem(this.systemOf(n), "scenarios")),
      command("vhil.runSystemSmoke", (n: Node) => {
        const s = this.systemOf(n);
        return this.task(`Smoke: ${s.id}`, ["smoke", s.id]);
      }),

      command("vhil.runAgain", (n: Node) => this.runAgain(n.data as RunRecord, false)),
      command("vhil.rerunFailed", (n: Node) => this.runAgain(n.data as RunRecord, true)),
      command("vhil.showRunOutput", (n: Node) => this.showOutput(n.data as RunRecord)),
      command("vhil.clearRuns", () => this.setRuns([])),
      command("vhil.revealTest", (id: string) => {
        const item = this.byId.get(id);
        if (item) return vscode.commands.executeCommand("vscode.revealTestInExplorer", item);
      }),
      command("vhil.tool", (id: ToolId) => this.tool(id)),
    );
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

  /** The variables vhil-docker.sh reads, from the settings. */
  private overrides(): { [key: string]: string } {
    const c = this.config();
    const env: { [key: string]: string } = { VHIL_DOCKER_CONTEXT: c.context };
    if (c.ifsHilRef) env.IFS_HIL_REF = c.ifsHilRef;
    if (c.firmwareRefs) env.FW_REFS = c.firmwareRefs;
    if (c.cpus > 0) env.VHIL_DOCKER_CPUS = String(c.cpus);
    return env;
  }

  private env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return { ...process.env, ...this.overrides(), ...extra };
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

  /**
   * A vhil-docker.sh command as a VS Code task: in the terminal panel, where
   * it can be watched and stopped. Resolves with its exit code; a finished
   * command goes in the Runs view unless `record` is false.
   */
  private async task(label: string, args: string[], extraEnv: { [key: string]: string } = {},
                     record = true): Promise<number | undefined> {
    const env = { ...this.overrides(), ...extraEnv };
    const t = new vscode.Task({ type: "vhil", args }, this.folder, label, "vHIL",
      new vscode.ShellExecution(`./${SCRIPT}`, args, { cwd: this.repo, env }));
    t.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
    const started = Date.now();
    let execution: vscode.TaskExecution | undefined;
    const ended = new Promise<number | undefined>((resolve) => {
      const sub = vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution !== execution) return;
        sub.dispose();
        resolve(e.exitCode);
      });
    });
    execution = await vscode.tasks.executeTask(t);
    if (args[0] === "editor") {
      this.editorTask = execution;
      setTimeout(() => void this.checkStatus(), 15000);
    }
    const exit = await ended;
    if (record) {
      this.addRun({ id: crypto.randomUUID(), label, kind: "task", started, ms: Date.now() - started,
                    args, env: extraEnv, exit });
    }
    return exit;
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
    const job = this.script(collectArgs(out.rel), this.env(), (t) => this.log.append(t));
    const code = await vscode.window.withProgress(
      { location: { viewId: "workbench.view.testing" }, title: "vHIL: listing tests" },
      () => job.done);
    const records = fs.existsSync(out.abs) ? parseLines(fs.readFileSync(out.abs, "utf8")).records : [];
    const items = records.filter((r): r is Item => r.kind === "item");
    if (!items.length) {
      this.log.show(true);
      void vscode.window.showErrorMessage(
        `vHIL: listing the tests failed (exit ${code}). Is the Docker VM up? See the vHIL output.`,
        "Start VM").then((a) => { if (a) void this.task("Start the Docker VM", ["vm"]); });
      return;
    }
    this.build(items, records);
    this.systemsTree.refresh();
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

  /** Every listed test with its markers. */
  private listed(): { id: string; markers: string[] }[] {
    return [...this.byId.values()]
      .filter((t) => t.children.size === 0 && t.id.includes("::"))
      .map((t) => ({ id: t.id, markers: t.tags.map((g) => g.id) }));
  }

  // -- runs -------------------------------------------------------------------

  private leaves(item: vscode.TestItem, into: vscode.TestItem[] = []): vscode.TestItem[] {
    if (item.children.size === 0) into.push(item);
    item.children.forEach((c) => this.leaves(c, into));
    return into;
  }

  private async run(request: vscode.TestRunRequest, token: vscode.CancellationToken, label?: string) {
    if (!this.byId.size) await this.refresh();
    const included = request.include ?? [...this.controller.items].map(([, i]) => i);
    const excluded = request.exclude ?? [];
    const excludedIds = new Set(excluded.flatMap((e) => this.leaves(e)).map((e) => e.id));
    const run = this.controller.createTestRun(request, label);
    const all = included.flatMap((i) => this.leaves(i)).filter((t) => !excludedIds.has(t.id));
    for (const t of all) run.enqueued(t);

    const started = Date.now();
    const tally: Tally = { passed: 0, failed: new Set(), skipped: 0, output: [], size: 0 };
    const groups = plan(included.map((i) => i.id));
    const c = this.config();
    try {
      for (const [job, ids] of groups) {
        if (token.isCancellationRequested) break;
        const mine = all.filter((t) => ids.some((id) => t.id === id || t.id.startsWith(id + "/") || t.id.startsWith(id + "::")));
        const deselect = [...excludedIds].filter((id) => ids.some((g) => id.startsWith(g + "/") || id.startsWith(g + "::")));
        await this.runJob(run, tally, job, ids, deselect, mine, c.pytestArgs, c.context, token);
      }
    } finally {
      run.end();
      const id = crypto.randomUUID();
      this.outputs.set(id, tally.output.join(""));
      this.addRun({
        id, kind: "tests", started, ms: Date.now() - started,
        label: label ?? (request.include?.length === 1 ? request.include[0].id
                         : request.include ? `${all.length} tests` : "All tests"),
        passed: tally.passed, failed: [...tally.failed], skipped: tally.skipped,
        cancelled: token.isCancellationRequested || undefined,
        include: included.map((i) => i.id),
      });
    }
  }

  private async runJob(run: vscode.TestRun, tally: Tally, job: Job, ids: string[], deselect: string[],
                       tests: vscode.TestItem[], extra: string[], context: string,
                       token: vscode.CancellationToken) {
    const name = `vhil-vscode-${crypto.randomBytes(4).toString("hex")}`;
    const out = this.outFile(name);
    const args = runArgs(job, ids, deselect, out.rel, extra);
    const write = (t: string) => {
      run.appendOutput(t.replace(/\r?\n/g, "\r\n"));
      if (tally.size < MAX_OUTPUT) {
        tally.output.push(t);
        tally.size += t.length;
      }
    };
    write(`$ ${SCRIPT} ${args.map(shellQuote).join(" ")}\n`);
    let text = "";
    const proc = this.script(args, this.env({ VHIL_DOCKER_NAME: name }), (t) => {
      text += t;
      write(t);
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
        for (const r of parsed.records) this.report(run, tally, r, reported);
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
    for (const t of left) {
      run.errored(t, why);
      tally.failed.add(t.id);
    }
  }

  private report(run: vscode.TestRun, tally: Tally, r: Record, reported: Set<string>) {
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
      tally.passed++;
    } else if (r.outcome === "skipped") {
      run.skipped(t);
      tally.skipped++;
    } else {
      const msg = new vscode.TestMessage(r.message ?? r.short ?? "failed");
      if (r.file && r.line) {
        msg.location = new vscode.Location(vscode.Uri.file(path.join(this.repo, r.file)),
          new vscode.Position(r.line - 1, 0));
      }
      run.failed(t, msg, ms);
      tally.failed.add(r.id);
    }
  }

  /** Run `ids` from the sidebar, with a notification to follow and cancel it. */
  private async runTests(label: string, ids: string[]) {
    if (!this.byId.size) await this.refresh();
    const items = ids.map((id) => this.byId.get(id)).filter((t): t is vscode.TestItem => !!t);
    if (!items.length) {
      void vscode.window.showInformationMessage(`vHIL: no tests to run for ${label}.`);
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `vHIL: ${label}`, cancellable: true },
      (_, token) => this.run(new vscode.TestRunRequest(items), token, label));
  }

  // -- the sidebar: Status ----------------------------------------------------

  async checkStatus(): Promise<void> {
    this.checking ??= this.check().finally(() => { this.checking = undefined; this.checked = Date.now(); });
    return this.checking;
  }

  private async check() {
    const { context } = this.config();
    this.status.text = "$(sync~spin) vHIL";
    const [up, editor] = await Promise.all([
      new Promise<boolean>((resolve) =>
        cp.execFile("docker", ["--context", context, "info", "--format", "{{.ServerVersion}}"],
          { timeout: 15000 }, (err) => resolve(!err))),
      editorAnswers(),
    ]);
    this.vmUp = up;
    this.editorUp = editor;
    if (up) {
      let text = "";
      const code = await this.script(["run", "sh", "-c", "cat /vhil/fw/built.txt 2>/dev/null || true"],
        this.env(), (t) => { text += t; }).done;
      this.built = builtFirmware(code === 0 ? text : "");
    }
    this.statusTree.refresh();
    this.updateStatusBar();
  }

  private missingFirmware(): string[] {
    return NEEDED_FW.filter((b) => !this.built.get(b));
  }

  private updateStatusBar() {
    const { context } = this.config();
    if (!this.vmUp) {
      this.status.text = "$(debug-disconnect) vHIL: VM down";
      this.status.tooltip = `Docker context ${context} doesn't answer. Click for actions.`;
      this.status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      return;
    }
    const missing = this.missingFirmware();
    this.status.backgroundColor = missing.length
      ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    this.status.text = missing.length ? "$(beaker) vHIL: no firmware" : "$(beaker) vHIL";
    this.status.tooltip = new vscode.MarkdownString(
      `**vHIL** on Docker context \`${context}\`\n\n` +
      (this.built.size ? [...this.built].map(([b, elf]) => `- ${b}: \`${path.basename(elf)}\``).join("\n")
                       : "No firmware built: sim and scenario tests need ecu, ams and the bootloader.") +
      "\n\nClick for actions.");
  }

  private statusNodes(): Node[] {
    const c = this.config();
    const checking = this.vmUp === undefined;
    const vm = node("Docker VM", {
      description: `${c.context} · ${checking ? "checking…" : this.vmUp ? "up" : "down"}`,
      icon: this.vmUp ? "vm-running" : "vm-outline",
      color: this.vmUp === false ? "problemsWarningIcon.foreground" : undefined,
      tooltip: this.vmUp === false ? `Docker context ${c.context} doesn't answer: start the VM.` : undefined,
      context: this.vmUp ? "vm.up" : "vm.down",
    });
    const images = node("Images", {
      description: "pull or rebuild", icon: "package", context: "images",
      tooltip: "The vHIL's Docker images: pull the published ones of this checkout, or build them from docker/.",
    });
    const names = [...new Set([...NEEDED_FW, ...this.built.keys()])].sort();
    const boards = names.map((b) => {
      const elf = this.built.get(b);
      return node(b, {
        description: elf ? path.basename(elf) : "not built",
        tooltip: elf ?? `No ${b} firmware: build it.`,
        icon: elf ? "pass" : "warning",
        color: elf ? "testing.iconPassed" : "problemsWarningIcon.foreground",
        // A board rebuilds by its system's name; a bootloader comes with its board.
        context: b.includes(".") ? "fw.part" : "fw.board",
        data: b,
      });
    });
    const missing = this.missingFirmware();
    const firmware = node("Firmware", {
      description: !this.vmUp ? "" : missing.length ? `missing ${missing.join(", ")}` : `${this.built.size} built`,
      icon: "circuit-board", context: "firmware", children: boards, expanded: true,
      tooltip: "What the last `fw` left in /vhil/fw/built.txt: what sim, scenario and smoke tests run.",
    });
    const ours = !!this.editorTask;
    const editor = node("System editor", {
      description: this.editorUp ? "running · localhost:8080" : ours ? "starting…" : "stopped",
      icon: "type-hierarchy",
      context: this.editorUp ? (ours ? "editor.up.ours" : "editor.up") : ours ? "editor.down.ours" : "editor.down",
      command: this.editorUp ? { command: "vhil.openEditor", title: "Open" } : undefined,
    });
    const refs = node("Firmware refs", {
      description: `IFS_HIL ${c.ifsHilRef || "dev"}${c.firmwareRefs ? ` · ${c.firmwareRefs}` : ""}`,
      icon: "git-branch",
      tooltip: "The IFS_HIL ref and firmware refs firmware builds use: click to change.",
      command: { command: "vhil.openSettings", title: "Settings", arguments: ["vhil.ifsHilRef"] },
    });
    return [vm, images, firmware, editor, refs];
  }

  private async buildFirmware() {
    const pick = await vscode.window.showQuickPick(
      [{ label: "ecu ams", description: "what sim and scenario tests need" },
       { label: "ecu ams udv", description: "and the uDV, for its tests" },
       { label: "udv", description: "the uDV only" }],
      { title: "vHIL: build firmware (IFS_HIL's recipes, in Docker)" });
    if (pick) await this.task(`Build firmware: ${pick.label}`, ["fw", ...pick.label.split(" ")]);
  }

  private async openEditor() {
    if (await editorAnswers()) {
      void vscode.env.openExternal(vscode.Uri.parse(EDITOR_URL));
      return;
    }
    if (!this.editorTask) void this.task("System editor", ["editor"], {}, false);
    this.statusTree.refresh();
    void vscode.window.showInformationMessage("vHIL: starting the editor; open it once it's up.", "Open")
      .then((a) => { if (a) void vscode.env.openExternal(vscode.Uri.parse(EDITOR_URL)); });
  }

  // -- the sidebar: Systems ---------------------------------------------------

  private readSystems() {
    const dir = path.join(this.repo, "systems");
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort() : [];
    this.systems = files.map((f) => {
      const id = f.slice(0, -".yaml".length);
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      return {
        id, description: descriptionOf(text), boards: boardsOf(text),
        scenarios: fs.existsSync(path.join(dir, `${id}.scenarios`)),
        smoke: fs.existsSync(path.join(this.repo, `tests/${id}_smoke.robot`)),
      };
    });
    this.systemsTree.refresh();
  }

  private systemOf(n: Node): SystemInfo {
    return n.data as SystemInfo;
  }

  private systemNodes(): Node[] {
    const listed = this.byId.size ? this.listed() : undefined;
    return this.systems.map((s) => {
      const counts = listed ? systemTests(listed, s.id) : undefined;
      const parts = [s.boards.map((b) => b.name).join(", ")];
      if (counts) {
        parts.push(`${counts.sim.length} sim`);
        if (s.scenarios) parts.push(`${counts.scenarios.length} scenarios`);
      }
      const boards = s.boards.map((b) => node(b.name, {
        description: b.role ? `${b.board} · ${b.role}` : b.board, icon: "chip",
      }));
      return node(s.id, {
        description: parts.join(" · "),
        tooltip: new vscode.MarkdownString(`**systems/${s.id}.yaml**\n\n${s.description}`),
        icon: "circuit-board",
        context: ["system", s.scenarios && "scenarios", s.smoke && "smoke"].filter(Boolean).join("."),
        children: boards,
        data: s,
      });
    });
  }

  private async runSystem(s: SystemInfo, kind: "sim" | "scenarios") {
    if (!this.byId.size) await this.refresh();
    const ids = systemTests(this.listed(), s.id)[kind];
    await this.runTests(`${s.id}: ${kind === "sim" ? "sim tests" : "scenarios"}`, ids);
  }

  // -- the sidebar: Runs ------------------------------------------------------

  private addRun(r: RunRecord) {
    this.setRuns(keepRuns(this.runs, r));
  }

  private setRuns(runs: RunRecord[]) {
    this.runs = runs;
    const kept = new Set(runs.map((r) => r.id));
    for (const id of this.outputs.keys()) if (!kept.has(id)) this.outputs.delete(id);
    void this.context.workspaceState.update(RUNS_KEY, runs);
    this.runsTree.refresh();
  }

  private runNodes(): Node[] {
    const now = Date.now();
    return this.runs.map((r) => {
      const ok = runOk(r);
      const failed = (r.failed ?? []).map((id) => node(labelOf(id), {
        description: fileOf(id), icon: "error", color: "testing.iconFailed",
        command: { command: "vhil.revealTest", title: "Show", arguments: [id] },
      }));
      const output = this.outputs.has(r.id);
      return node(r.label, {
        description: runDescription(r, now),
        tooltip: `${new Date(r.started).toLocaleString()}${r.args ? `\n${SCRIPT} ${r.args.join(" ")}` : ""}`,
        icon: ok === undefined ? "circle-slash" : ok ? "pass" : "error",
        color: ok === undefined ? undefined : ok ? "testing.iconPassed" : "testing.iconFailed",
        context: ["run", r.kind, r.failed?.length && "failed", output && "output"].filter(Boolean).join("."),
        children: failed, data: r,
        command: output ? { command: "vhil.showRunOutput", title: "Output", arguments: [{ data: r }] } : undefined,
      });
    });
  }

  private async runAgain(r: RunRecord, onlyFailed: boolean) {
    if (r.kind === "task") {
      await this.task(r.label, r.args ?? [], r.env ?? {});
      return;
    }
    const ids = onlyFailed ? r.failed ?? [] : r.include ?? [];
    await this.runTests(onlyFailed ? `${r.label} (failures)` : r.label, ids);
  }

  private async showOutput(r: RunRecord) {
    const text = this.outputs.get(r.id);
    if (text === undefined) return;
    const doc = await vscode.workspace.openTextDocument({ content: text, language: "log" });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  // -- the sidebar: Tools -----------------------------------------------------

  private toolNodes(): Node[] {
    return TOOLS.map((t) => node(t.label, {
      icon: t.icon, tooltip: t.detail,
      command: { command: "vhil.tool", title: t.label, arguments: [t.id] },
    }));
  }

  private async tool(id: ToolId) {
    switch (id) {
      case "shell":
        await this.task("Shell", ["shell"], {}, false);
        return;
      case "speed":
        await this.task("Speed", ["speed"]);
        return;
      case "ifs-hil": {
        const dut = await vscode.window.showQuickPick(
          [{ label: "ecu", description: "IFS_HIL's ECU suite" }, { label: "ams", description: "IFS_HIL's AMS suite" }],
          { title: "vHIL: IFS_HIL suite against which board?" });
        if (!dut) return;
        const suite = await vscode.window.showInputBox({
          title: "vHIL: IFS_HIL suite", value: "smoke",
          prompt: "A suite name or path, as IFS_HIL's `tools.bench suite` expands it" });
        if (suite === undefined) return;
        const { args, env } = ifsHilArgs(dut.label as "ecu" | "ams", suite);
        await this.task(`IFS_HIL ${dut.label}: ${suite.trim() || "smoke"}`, args, env);
        return;
      }
      case "coverage": {
        const glob = await vscode.window.showInputBox({
          title: "vHIL: firmware coverage", value: "test_*",
          prompt: "The tests/sim files to run, as a glob (tests/sim/<glob>.py)" });
        if (glob) await this.task(`Coverage: ${glob}`, ["coverage", glob]);
        return;
      }
      case "prune": {
        const pick = await vscode.window.showQuickPick(
          [{ label: "Dry run", description: "list what would go", args: ["prune", "--dry-run"] },
           { label: "Prune", description: "delete old commit builds", args: ["prune"] }],
          { title: "vHIL: prune firmware builds in /vhil/fw" });
        if (pick) await this.task(`Prune firmware (${pick.label.toLowerCase()})`, pick.args);
        return;
      }
      case "export-run": {
        const run = await vscode.window.showInputBox({ title: "vHIL: export a run", prompt: "The web app's run id" });
        if (!run) return;
        const file = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(this.repo, `${run}.vhilrun`)), filters: { "vHIL run": ["vhilrun"] } });
        if (file) await this.task(`Export run ${run}`, ["export-run", run, "-o", file.fsPath]);
        return;
      }
      case "import-run": {
        const files = await vscode.window.showOpenDialog({ filters: { "vHIL run": ["vhilrun"] }, canSelectMany: false });
        if (files?.[0]) await this.task(`Import ${path.basename(files[0].fsPath)}`, ["import-run", files[0].fsPath]);
        return;
      }
    }
  }

  private async menu() {
    const actions: { label: string; run: () => unknown }[] = [
      { label: "$(beaker) Show the vHIL sidebar", run: () => vscode.commands.executeCommand("workbench.view.extension.vhil") },
      { label: "$(refresh) Refresh tests", run: () => this.refresh() },
      { label: "$(vm) Start the Docker VM", run: () => this.task("Start the Docker VM", ["vm"]) },
      { label: "$(tools) Build firmware…", run: () => this.buildFirmware() },
      { label: "$(type-hierarchy) Open the system editor", run: () => this.openEditor() },
      { label: "$(pulse) Check VM and firmware", run: () => this.checkStatus() },
      { label: "$(gear) Settings", run: () => vscode.commands.executeCommand("workbench.action.openSettings", "vhil.") },
    ];
    const pick = await vscode.window.showQuickPick(actions, { title: "vHIL" });
    await pick?.run();
  }
}

/** Whether the system editor answers on its proxy. */
function editorAnswers(): Promise<boolean> {
  return fetch(EDITOR_URL, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
