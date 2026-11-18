// The vHIL in VS Code: every test of tests/unit, tests/sim and
// tests/scenarios in the Testing panel, one status bar item (state, and a
// click runs the tests again), and the system editor in a tab; all run in
// the vHIL's Docker image through scripts/vhil-docker.sh, as CI runs them
// (vscode/README.md). VS Code's own Test Results keep the run history.
//
// Two ways in: the IFS-vHIL checkout open as a folder, or a firmware
// repository the catalogue builds (IFS08-CE-ECU, ...). In a firmware
// repository the extension keeps its own checkout of the vHIL, builds the
// open working tree into the tests (FW_LOCAL) and lists only the tests that
// run that firmware.
import * as cp from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import * as vscode from "vscode";

import {
  builtFirmware, collectArgs, dockerContext, fileOf, Item, Job, labelOf, parseLines, plan,
  Record, runArgs, startsVm, SUITES,
} from "./plan";
import {
  buildSystem, Firmware, firmwareForRepo, firmwareOf, repoSlug, systemsOf, testRuns,
} from "./firmware";
import { boardsOf as debugBoards, debugConfig, Ready } from "./debug";
import { barOf, findings, Fix, GROUP, groupId, Phase, scenarioSystem } from "./status";
import { boardsOf, descriptionOf, ifsHilArgs, SystemInfo, ToolId, TOOLS, validationProblems } from "./systems";
import { compilerDiagnostics, hostPath, PathMap, Snapshot, snapshotMarkdown } from "./trace";
import { TRACE_VIEW, TracePanel } from "./tracePanel";

const SCRIPT = "scripts/vhil-docker.sh";
// Where the plugin's JSON lines go: results/ is git-ignored and inside /work.
const OUT_DIR = "results/vscode";
// Firmware the sim and scenario jobs need (scripts/vhil-docker.sh need_elf).
const NEEDED_FW = ["ecu", "ams", "ecu.bootloader"];
const EDITOR_URL = "http://localhost:8080/editor/";

export async function activate(context: vscode.ExtensionContext) {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const own = folders.find((f) => fs.existsSync(path.join(f.uri.fsPath, SCRIPT)));
  if (own) {
    start(context, new Vhil(own.uri.fsPath, own, context));
    return;
  }
  for (const f of folders) {
    const local = await firmwareRepo(context, f);
    if (local) {
      start(context, new Vhil(local.checkout, f, context, local));
      return;
    }
  }
}

function start(context: vscode.ExtensionContext, vhil: Vhil) {
  // What the palette offers: the maintainer tools in the vHIL repository,
  // updating the checkout in a firmware one.
  void vscode.commands.executeCommand("setContext", "vhil.active", true);
  void vscode.commands.executeCommand("setContext", "vhil.firmwareRepo", !!vhil.isFirmwareRepo);
  context.subscriptions.push(vhil);
  void vhil.refresh();
  void vhil.checkStatus();
}

/** A firmware repository open in VS Code, and the vHIL checkout that tests it. */
interface Local {
  firmware: Firmware;
  dir: string; // the working tree
  checkout: string; // the extension's own IFS-vHIL checkout
}

function git(dir: string, args: string[], timeout = 15000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => cp.execFile("git", ["-C", dir, ...args], { timeout },
    (err, stdout, stderr) => resolve({ ok: !err, out: err ? `${stderr || err}` : stdout })));
}

function vhilRepo(): { url: string; ref: string } {
  const c = vscode.workspace.getConfiguration("vhil");
  return { url: c.get<string>("repository", "") || "https://github.com/isc-fs/IFS-vHIL",
           ref: c.get<string>("ref", "") || "dev" };
}

/**
 * Whether `folder` is a firmware repository the catalogue builds. Its origin
 * must be on the vHIL's GitHub owner before anything is fetched; then the
 * extension's checkout is cloned (once) and its catalogue decides.
 */
async function firmwareRepo(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder): Promise<Local | undefined> {
  const dir = folder.uri.fsPath;
  const origin = await git(dir, ["remote", "get-url", "origin"]);
  const slug = origin.ok ? repoSlug(origin.out) : undefined;
  const owner = repoSlug(vhilRepo().url)?.split("/")[0];
  if (!slug || !owner || slug.split("/")[0].toLowerCase() !== owner.toLowerCase()) return undefined;
  const checkout = path.join(context.globalStorageUri.fsPath, "IFS-vHIL");
  if (!fs.existsSync(path.join(checkout, SCRIPT)) && !(await updateCheckout(context, checkout))) return undefined;
  const dirFw = path.join(checkout, "catalog", "firmware");
  const catalogue = fs.readdirSync(dirFw).filter((f) => f.endsWith(".yaml"))
    .map((f) => firmwareOf(fs.readFileSync(path.join(dirFw, f), "utf8")))
    .filter((f): f is Firmware => !!f);
  const firmware = firmwareForRepo(catalogue, slug);
  return firmware ? { firmware, dir, checkout } : undefined;
}

const UPDATED_KEY = "vhil.checkoutUpdated";

/** Clone the extension's vHIL checkout, or bring it to the configured ref. */
async function updateCheckout(context: vscode.ExtensionContext, checkout: string): Promise<boolean> {
  const { url, ref } = vhilRepo();
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `vHIL: fetching ${repoSlug(url) ?? url}@${ref}` },
    async () => {
      let r;
      if (!fs.existsSync(path.join(checkout, ".git"))) {
        fs.mkdirSync(path.dirname(checkout), { recursive: true });
        r = await git(path.dirname(checkout), ["clone", "-q", "--depth", "1", "-b", ref, url, checkout], 300000);
      } else {
        r = await git(checkout, ["fetch", "-q", "--depth", "1", url, ref], 300000);
        if (r.ok) r = await git(checkout, ["reset", "-q", "--hard", "FETCH_HEAD"]);
      }
      if (!r.ok) {
        void vscode.window.showErrorMessage(`vHIL: couldn't fetch ${url}@${ref}: ${r.out.trim()}`);
        return false;
      }
      await context.globalState.update(UPDATED_KEY, Date.now());
      return true;
    });
}


export function deactivate() {}

/** What a test run counted, for the status bar. */
interface Tally {
  passed: number;
  failed: Set<string>;
  skipped: number;
  total: number;
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

  private phase: Phase = { kind: "checking" };
  private busy = false; // a run owns the status bar
  private lastRequest: vscode.TestRunRequest | undefined;
  private dockerUp: boolean | undefined;
  private dirty = false;
  private built = new Map<string, string>();
  private editorUp = false;
  private editorTask: vscode.TaskExecution | undefined;
  private editorPanel: vscode.WebviewPanel | undefined;
  /** The page the panel frames once the editor answers, and whether it does yet. */
  private editorPage = EDITOR_URL;
  private editorReady = false;
  private checking: Promise<void> | undefined;
  private systems: SystemInfo[] = [];
  // A test's bus trace (.trace.jsonl, absolute) and its failure snapshots.
  private readonly traces = new Map<string, string>();
  private readonly snapshots = new Map<string, Snapshot[]>();
  private readonly tracePanel: TracePanel;
  private readonly problems = vscode.languages.createDiagnosticCollection("vHIL firmware build");
  private readonly systemProblems = vscode.languages.createDiagnosticCollection("vHIL systems");

  constructor(repo: string, private readonly folder: vscode.WorkspaceFolder,
              private readonly context: vscode.ExtensionContext, private readonly local?: Local) {
    this.repo = repo;
    this.controller = vscode.tests.createTestController("vhil", "vHIL");
    this.controller.refreshHandler = () => this.refresh();
    const runProfile = this.controller.createRunProfile("Run", vscode.TestRunProfileKind.Run,
      (request, token) => request.continuous ? this.runOnSave(request, token) : this.run(request, token), true);
    runProfile.supportsContinuousRun = true;
    this.controller.createRunProfile("Debug", vscode.TestRunProfileKind.Debug,
      (request, token) => this.debug(request, token), true);

    this.log = vscode.window.createOutputChannel("vHIL");
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = "vhil.statusClick";
    this.setPhase(this.phase);
    this.status.show();
    this.readSystems();
    this.tracePanel = new TracePanel(context.extensionUri);

    // The extension's own checkout changes only when it updates it.
    const watch = (glob: string) => vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(local ? path.join(this.repo, ".none") : this.repo, glob));
    const tests = watch("tests/{unit,sim,scenarios}/**/*.py");
    const systems = watch("systems/**");
    const later = () => this.refreshSoon();
    const reread = () => this.readSystems();
    // A system file changed on disk (a save, a checkout, a revert): validate's errors in Problems.
    const timers = new Map<string, NodeJS.Timeout>();
    const revalidate = (uri: vscode.Uri) => {
      reread();
      if (!/\/systems\/[^/]+\.yaml$/.test(uri.fsPath)) return;
      clearTimeout(timers.get(uri.fsPath));
      timers.set(uri.fsPath, setTimeout(() => { timers.delete(uri.fsPath); void this.validate(uri); }, 300));
    };
    const command = (id: string, f: (...a: any[]) => unknown) => vscode.commands.registerCommand(id, f);
    this.disposables.push(
      this.controller, this.status, this.log, tests, systems, this.problems, this.systemProblems,
      vscode.window.registerWebviewViewProvider(TRACE_VIEW, this.tracePanel,
        { webviewOptions: { retainContextWhenHidden: true } }),
      tests.onDidChange(later), tests.onDidCreate(later), tests.onDidDelete(later),
      systems.onDidChange(revalidate), systems.onDidCreate(revalidate),
      systems.onDidDelete((uri) => { reread(); this.systemProblems.delete(uri); }),
      vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution === this.editorTask) this.editorTask = undefined;
        if (e.execution.task.source === "vHIL") void this.checkStatus();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("vhil")) void this.checkStatus();
      }),

      command("vhil.statusClick", () => this.statusClick()),
      command("vhil.diagnose", () => this.diagnose()),
      command("vhil.refreshTests", () => this.refresh()),
      command("vhil.startVm", () => this.task("Start the Docker VM", ["vm"])),
      command("vhil.pullImages", () => this.task("Pull images", ["pull"])),
      command("vhil.buildImages", () => this.task("Build images", ["image"])),
      command("vhil.buildFirmware", () => this.buildFirmware()),
      command("vhil.openEditor", () => this.openEditor()),
      // From a scenario system's group in the Testing panel, or the palette.
      command("vhil.openSystemInEditor", async (item?: vscode.TestItem) => {
        const id = item?.id.startsWith(GROUP) ? item.id.split("/").pop() : await this.pickSystem("Open in the system editor");
        if (id) await this.openEditor(id);
      }),
      command("vhil.stopEditor", () => this.editorTask?.terminate()),
      command("vhil.tools", () => this.tools()),
      // From the Testing panel (a test item), or a failure's link (its id).
      command("vhil.showTrace", (item?: vscode.TestItem | string) => {
        const id = typeof item === "string" ? item : item?.id;
        const file = id ? this.traces.get(id) : undefined;
        if (id && file) return this.tracePanel.show(file, labelOf(id), true);
        void vscode.window.showInformationMessage("vHIL: no bus trace for that test: run it first.");
      }),
      command("vhil.updateVhil", () => this.updateVhil()),
    );
    if (local) {
      this.log.appendLine(`${local.dir}: ${local.firmware.id} (${local.firmware.repo}), ` +
                          `tested by the vHIL checkout ${this.repo}`);
      // Once a day, bring the checkout to the configured ref.
      const updated = context.globalState.get<number>(UPDATED_KEY, 0);
      if (Date.now() - updated > 24 * 3600 * 1000) void this.updateVhil();
    }
  }

  get isFirmwareRepo(): boolean {
    return !!this.local;
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
    if (this.local) env.FW_LOCAL = `${this.local.firmware.id}=${this.local.dir}`;
    return env;
  }

  private env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return { ...process.env, ...this.overrides(), ...extra };
  }

  /** Where the container's files are on the host. */
  private pathMap(): PathMap {
    return { repo: this.repo, firmware: this.local?.firmware.id, dir: this.local?.dir };
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
   * it can be watched and stopped. Resolves with its exit code.
   */
  private async task(label: string, args: string[], extraEnv: { [key: string]: string } = {}): Promise<number | undefined> {
    const env = { ...this.overrides(), ...extraEnv };
    const t = new vscode.Task({ type: "vhil", args }, this.folder, label, "vHIL",
      new vscode.ShellExecution(`./${SCRIPT}`, args, { cwd: this.repo, env }));
    t.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
    let execution: vscode.TaskExecution | undefined;
    const ended = new Promise<number | undefined>((resolve) => {
      const sub = vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution !== execution) return;
        sub.dispose();
        resolve(e.exitCode);
      });
    });
    execution = await vscode.tasks.executeTask(t);
    if (args[0] === "editor") this.editorTask = execution;
    return ended;
  }

  private outFile(name: string): { rel: string; abs: string } {
    // Per window: two windows may share the extension's checkout.
    const rel = `${OUT_DIR}/${name}-${process.pid}.jsonl`;
    const abs = path.join(this.repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.rmSync(abs, { force: true });
    return { rel, abs };
  }

  // -- the status bar ---------------------------------------------------------

  private setPhase(p: Phase) {
    this.phase = p;
    const bar = barOf(p);
    this.status.text = bar.text;
    this.status.tooltip = bar.tooltip;
    this.status.backgroundColor = bar.warn ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  }

  /** The bar's phase when no run owns it: from the last check. */
  private idlePhase(): Phase {
    if (this.dockerUp === undefined) return { kind: "checking" };
    if (!this.dockerUp) return { kind: "down", context: this.config().context };
    return { kind: "idle", firmware: this.local?.firmware.id, dirty: this.dirty, missing: this.missingFirmware() };
  }

  private async statusClick() {
    const action = barOf(this.phase).action;
    if (action === "diagnose") return this.diagnose();
    if (action !== "run") return;
    // The last run again, else every listed test.
    const request = this.lastRequest ?? new vscode.TestRunRequest();
    const cts = new vscode.CancellationTokenSource();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "vHIL: running the tests", cancellable: true },
      (_, token) => {
        token.onCancellationRequested(() => cts.cancel());
        return this.run(request, cts.token);
      });
  }

  async checkStatus(): Promise<void> {
    this.checking ??= this.check().finally(() => { this.checking = undefined; });
    return this.checking;
  }

  private async check() {
    const { context } = this.config();
    const [up, editor] = await Promise.all([
      new Promise<boolean>((resolve) =>
        cp.execFile("docker", ["--context", context, "info", "--format", "{{.ServerVersion}}"],
          { timeout: 15000 }, (err) => resolve(!err))),
      editorAnswers(),
    ]);
    this.dockerUp = up;
    this.editorUp = editor;
    if (this.local) {
      const status = await git(this.local.dir, ["status", "--porcelain"]);
      this.dirty = status.ok && !!status.out.trim();
    }
    if (up) {
      let text = "";
      const code = await this.script(["run", "sh", "-c", "cat /vhil/fw/built.txt 2>/dev/null || true"],
        this.env(), (t) => { text += t; }).done;
      this.built = builtFirmware(code === 0 ? text : "");
    }
    if (!this.busy) this.setPhase(this.idlePhase());
  }

  private missingFirmware(): string[] {
    return NEEDED_FW.filter((b) => !this.built.get(b));
  }

  /** Each check with its fix: what replaces a status view. */
  private async diagnose() {
    await this.checkStatus();
    const { context } = this.config();
    const list = findings({
      context, startsVm: startsVm(context), dockerUp: !!this.dockerUp, built: this.built,
      needed: NEEDED_FW, editorUp: this.editorUp,
    });
    const fixes: { [f in Fix]: string } = {
      startVm: "Start the Docker VM", pullImages: "Pull the images", buildFirmware: "Build firmware",
      openSettings: "Change the Docker context", openEditor: "Open the system editor",
    };
    const pick = await vscode.window.showQuickPick(list.map((f) => ({
      label: `$(${f.ok ? "pass" : "warning"}) ${f.label}`,
      description: f.detail,
      detail: f.fix ? `Fix: ${fixes[f.fix]}` : undefined,
      fix: f.fix,
    })), { title: "vHIL: diagnose", placeHolder: "Pick one to fix it" });
    switch (pick?.fix) {
      case "startVm": return this.task("Start the Docker VM", ["vm"]);
      case "pullImages": return this.task("Pull images", ["pull"]);
      case "buildFirmware": return this.buildFirmware();
      case "openSettings": return vscode.commands.executeCommand("workbench.action.openSettings", "vhil.dockerContext");
      case "openEditor": return this.openEditor();
    }
  }

  /**
   * Docker up before a run: the Colima VM is started here (vhil-docker.sh
   * pulls the images and builds missing firmware itself); any other context
   * is the user's to start. Listing tests on open (`start` false) only
   * checks: the status bar then says Docker is down.
   */
  private async ensureDocker(start = true): Promise<boolean> {
    await this.checkStatus();
    if (this.dockerUp) return true;
    if (!start) return false;
    const { context } = this.config();
    if (startsVm(context)) {
      await this.task("Start the Docker VM", ["vm"]);
      await this.checkStatus();
      if (this.dockerUp) return true;
    }
    void vscode.window.showErrorMessage(`vHIL: Docker (context ${context}) doesn't answer.`, "Diagnose")
      .then((a) => { if (a) void this.diagnose(); });
    return false;
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

  /** The listed tests of this checkout's commit, from the last listing: no 20 s wait on open. */
  private cacheKey(head: string): string {
    return `vhil.tests:${this.repo}:${head}:${this.local?.firmware.id ?? ""}`;
  }

  private async head(): Promise<string> {
    const r = await git(this.repo, ["rev-parse", "HEAD"]);
    return r.ok ? r.out.trim() : "";
  }

  private async collect() {
    // In a firmware repository the tests are the checkout's, which changes
    // only with its commit: a cached listing is the listing.
    const head = this.local ? await this.head() : "";
    const cached = head ? this.context.workspaceState.get<Record[]>(this.cacheKey(head)) : undefined;
    if (cached?.length && !this.byId.size) {
      this.build(cached.filter((r): r is Item => r.kind === "item"), cached);
      return;
    }
    if (!(await this.ensureDocker(false))) return;
    const out = this.outFile("collect");
    const roots = SUITES.map((s) => s.root).filter((r) => !this.local || r !== "tests/unit");
    const job = this.script(collectArgs(out.rel, roots), this.env(), (t) => this.log.append(t));
    const code = await vscode.window.withProgress(
      { location: { viewId: "workbench.view.testing" }, title: "vHIL: listing tests" },
      () => job.done);
    const records = fs.existsSync(out.abs) ? parseLines(fs.readFileSync(out.abs, "utf8")).records : [];
    const systems = this.mySystems().map((s) => s.id);
    const items = records.filter((r): r is Item => r.kind === "item")
      .filter((r) => !this.local || testRuns(r, this.local.firmware.id, systems));
    if (!items.length) {
      this.log.show(true);
      void vscode.window.showErrorMessage(`vHIL: listing the tests failed (exit ${code}). See the vHIL output.`,
        "Diagnose").then((a) => { if (a) void this.diagnose(); });
      return;
    }
    this.build(items, records);
    if (head) void this.context.workspaceState.update(this.cacheKey(head), [...items, ...records.filter((r) => r.kind === "error")]);
  }

  private tag(marker: string): vscode.TestTag {
    let t = this.tags.get(marker);
    if (!t) this.tags.set(marker, (t = new vscode.TestTag(marker)));
    return t;
  }

  /**
   * The tree: the suites, their files and tests; the scenarios grouped by
   * system (a group's id is not pytest's: a run expands it to its tests).
   */
  private build(items: Item[], records: Record[]) {
    this.byId.clear();
    const roots: vscode.TestItem[] = [];
    for (const suite of SUITES) {
      if (this.local && suite.root === "tests/unit") continue;
      const root = this.controller.createTestItem(suite.root, suite.root,
        vscode.Uri.file(path.join(this.repo, suite.root)));
      this.byId.set(suite.root, root);
      roots.push(root);
    }
    const parents = new Map<string, vscode.TestItem>();
    for (const item of items) {
      const root = this.byId.get(SUITES.find((s) => item.id.startsWith(s.root + "/"))?.root ?? "");
      if (!root) continue;
      const uri = vscode.Uri.file(path.join(this.repo, item.file));
      const system = scenarioSystem(item.id);
      const key = system ? groupId(system) : fileOf(item.id);
      let parent = parents.get(key);
      if (!parent) {
        parent = system
          ? this.controller.createTestItem(key, system, vscode.Uri.file(path.join(this.repo, "systems", `${system}.yaml`)))
          : this.controller.createTestItem(key, path.relative(root.id, key), uri);
        parents.set(key, parent);
        this.byId.set(key, parent);
        root.children.add(parent);
      }
      const label = system ? labelOf(item.id).replace(/^test_scenario\[[^/]+\/(.*)\]$/, "$1") : labelOf(item.id);
      const test = this.controller.createTestItem(item.id, label, uri);
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

  private async run(request: vscode.TestRunRequest, token: vscode.CancellationToken,
                    extraEnv: { [key: string]: string } = {}) {
    if (!this.byId.size) {
      if (!(await this.ensureDocker())) return;
      await this.refresh();
    }
    if (!extraEnv.VHIL_DEBUG) this.lastRequest = request;
    const included = request.include ?? [...this.controller.items].map(([, i]) => i);
    const excluded = request.exclude ?? [];
    const excludedIds = new Set(excluded.flatMap((e) => this.leaves(e)).map((e) => e.id));
    const run = this.controller.createTestRun(request);
    const all = included.flatMap((i) => this.leaves(i)).filter((t) => !excludedIds.has(t.id));
    for (const t of all) run.enqueued(t);

    const tally: Tally = { passed: 0, failed: new Set(), skipped: 0, total: all.length };
    // A scenario group isn't a pytest id: its tests are.
    const ids = included.flatMap((i) => i.id.startsWith(GROUP) ? this.leaves(i).map((l) => l.id) : [i.id]);
    const groups = plan(ids);
    const c = this.config();
    this.busy = true;
    try {
      if (!(await this.ensureDocker())) {
        for (const t of all) run.skipped(t);
        return;
      }
      if (this.local && [...groups.keys()].some((j) => j !== "unit")) {
        this.setPhase({ kind: "building", firmware: `${this.local.firmware.id}@local` });
        if (!(await this.buildLocal(run, tally, all, token))) return;
      }
      this.progress(tally);
      for (const [job, jobIds] of groups) {
        if (token.isCancellationRequested) break;
        const mine = all.filter((t) => jobIds.some((id) => t.id === id || t.id.startsWith(id + "/") || t.id.startsWith(id + "::")));
        const deselect = [...excludedIds].filter((id) => jobIds.some((g) => id.startsWith(g + "/") || id.startsWith(g + "::")));
        await this.runJob(run, tally, job, jobIds, deselect, mine, c.pytestArgs, c.context, token, extraEnv);
      }
    } finally {
      run.end();
      this.busy = false;
      // The first failure's buses, in the panel, without taking focus.
      const failed = all.find((t) => tally.failed.has(t.id) && this.traces.has(t.id));
      if (failed) void this.tracePanel.show(this.traces.get(failed.id)!, labelOf(failed.id), false);
      this.setPhase({ kind: "result", passed: tally.passed, failed: tally.failed.size, skipped: tally.skipped,
                      cancelled: token.isCancellationRequested || undefined });
    }
  }

  private progress(tally: Tally) {
    this.setPhase({ kind: "running", done: tally.passed + tally.failed.size + tally.skipped, total: tally.total });
  }

  private async runJob(run: vscode.TestRun, tally: Tally, job: Job, ids: string[], deselect: string[],
                       tests: vscode.TestItem[], extra: string[], context: string,
                       token: vscode.CancellationToken, extraEnv: { [key: string]: string } = {}) {
    const name = `vhil-vscode-${crypto.randomBytes(4).toString("hex")}`;
    const out = this.outFile(name);
    const args = runArgs(job, ids, deselect, out.rel, extra);
    const write = (t: string) => run.appendOutput(t.replace(/\r?\n/g, "\r\n"));
    write(`$ ${SCRIPT} ${args.map(shellQuote).join(" ")}\n`);
    let text = "";
    const proc = this.script(args, this.env({ VHIL_DOCKER_NAME: name, ...extraEnv }), (t) => {
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

  /**
   * Build the open working tree (FW_LOCAL, FW_LOCAL_ONLY) before a run, into
   * the run's output. On failure every test of the run errors with the
   * build's last lines.
   */
  private async buildLocal(run: vscode.TestRun, tally: Tally, tests: vscode.TestItem[],
                           token: vscode.CancellationToken): Promise<boolean> {
    const fw = this.local!.firmware.id;
    const system = buildSystem(this.systems, fw);
    if (!system) return true;
    // First run: what the sim and scenario jobs need besides this firmware,
    // from its refs, in the same build.
    const missing = this.missingFirmware().length > 0;
    const args = missing ? ["fw", ...new Set(["ecu", "ams", system])] : ["fw", system];
    let text = "";
    const write = (t: string) => {
      text += t;
      run.appendOutput(t.replace(/\r?\n/g, "\r\n"));
    };
    const only = missing ? "0" : "1";
    write(`$ FW_LOCAL=${fw}=${this.local!.dir} FW_LOCAL_ONLY=${only} ${SCRIPT} ${args.join(" ")}\n`);
    const name = `vhil-vscode-${crypto.randomBytes(4).toString("hex")}`;
    const proc = this.script(args, this.env({ FW_LOCAL_ONLY: only, VHIL_DOCKER_NAME: name }), write);
    const cancel = token.onCancellationRequested(() => {
      cp.execFile("docker", ["--context", this.config().context, "kill", name], () => proc.proc.kill());
    });
    const code = await proc.done;
    cancel.dispose();
    void this.checkStatus();
    // The compiler's errors and warnings in Problems, at the working tree's lines.
    const diags = compilerDiagnostics(text, this.pathMap());
    this.problems.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const d of diags) {
      const range = new vscode.Range(d.line - 1, Math.max(d.column - 1, 0), d.line - 1, Math.max(d.column - 1, 0));
      const v = new vscode.Diagnostic(range, d.message,
        d.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      v.source = `vHIL build (${fw})`;
      byFile.set(d.file, [...(byFile.get(d.file) ?? []), v]);
    }
    for (const [file, list] of byFile) this.problems.set(vscode.Uri.file(file), list);
    if (code === 0) return true;
    const errors = diags.filter((d) => d.severity === "error");
    const why = errors.length
      ? new vscode.TestMessage(`Building ${fw} failed: ${errors.length} error${errors.length > 1 ? "s" : ""}, see Problems.\n\n` +
          `${path.relative(this.local!.dir, errors[0].file)}:${errors[0].line}: ${errors[0].message}`)
      : new vscode.TestMessage(`Building ${fw} from ${this.local!.dir} failed (exit ${code}):\n\n` +
          text.trim().split("\n").slice(-20).join("\n"));
    if (errors.length) {
      why.location = new vscode.Location(vscode.Uri.file(errors[0].file),
        new vscode.Position(errors[0].line - 1, Math.max(errors[0].column - 1, 0)));
      void vscode.commands.executeCommand("workbench.actions.view.problems");
    }
    for (const t of tests) {
      if (token.isCancellationRequested) run.skipped(t);
      else {
        run.errored(t, why);
        tally.failed.add(t.id);
      }
    }
    return false;
  }

  private report(run: vscode.TestRun, tally: Tally, r: Record, reported: Set<string>) {
    if (r.kind === "start") {
      const t = this.byId.get(r.id);
      if (t) run.started(t);
      this.snapshots.delete(r.id);
      return;
    }
    if (r.kind === "snapshot") {
      this.snapshots.set(r.id, [...(this.snapshots.get(r.id) ?? []), r]);
      return;
    }
    if (r.kind !== "result") return;
    const t = this.byId.get(r.id);
    if (!t) return;
    reported.add(r.id);
    if (r.trace) {
      this.traces.set(r.id, path.isAbsolute(r.trace) ? r.trace : path.join(this.repo, r.trace));
      void vscode.commands.executeCommand("setContext", "vhil.traced", [...this.traces.keys()]);
    }
    const ms = r.duration * 1000;
    if (r.outcome === "passed") {
      run.passed(t, ms);
      tally.passed++;
    } else if (r.outcome === "skipped") {
      run.skipped(t);
      tally.skipped++;
    } else {
      const msg = this.failure(r);
      if (r.file && r.line) {
        msg.location = new vscode.Location(vscode.Uri.file(path.join(this.repo, r.file)),
          new vscode.Position(r.line - 1, 0));
      }
      run.failed(t, msg, ms);
      tally.failed.add(r.id);
    }
    this.progress(tally);
  }

  /**
   * A failed test's message: the assertion, then where each board's firmware
   * was (its C frames, clickable in the working tree) and the last frames on
   * its buses, with a link to the whole trace. Without a snapshot, pytest's
   * text as before.
   */
  private failure(r: Extract<Record, { kind: "result" }>): vscode.TestMessage {
    const snaps = this.snapshots.get(r.id) ?? [];
    this.snapshots.delete(r.id);
    if (!snaps.length && !r.trace) return new vscode.TestMessage(r.message ?? r.short ?? "failed");
    const md = new vscode.MarkdownString();
    md.appendCodeblock(r.short ?? r.message ?? "failed", "text");
    if (snaps.length) md.appendMarkdown("\n" + snapshotMarkdown(snaps));
    if (r.trace) {
      const args = encodeURIComponent(JSON.stringify([r.id]));
      md.appendMarkdown(`\n[Show the bus trace](command:vhil.showTrace?${args})`);
      md.isTrusted = { enabledCommands: ["vhil.showTrace"] };
    }
    const msg = new vscode.TestMessage(md);
    const map = this.pathMap();
    msg.stackTrace = snaps.flatMap((s) => s.frames.map((f) => {
      const host = f.file ? hostPath(f.file, map) : undefined;
      const where = f.file ? ` ${f.file.split("/").pop()}:${f.line}` : ` ${f.address}`;
      return new vscode.TestMessageStackFrame(`${s.board}: ${f.symbol}${host ? "" : where}`,
        host ? vscode.Uri.file(host) : undefined,
        host && f.line ? new vscode.Position(f.line - 1, 0) : undefined);
    }));
    return msg;
  }

  /**
   * Continuous run: the request again each time a source file is saved (C
   * and headers in a firmware repository; Python, systems and models in the
   * vHIL's), one run at a time, until it is turned off.
   */
  private async runOnSave(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    const glob = this.local ? "**/*.{c,h,cpp,hpp,cc,s,S,ld,ioc}" : "{vhil,models,systems,catalog,tests}/**";
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.local?.dir ?? this.repo, glob));
    let timer: NodeJS.Timeout | undefined;
    let running: Promise<void> | undefined;
    let again = false;
    const once = new vscode.TestRunRequest(request.include, request.exclude, request.profile);
    const go = () => {
      if (running) { again = true; return; }
      const cts = new vscode.CancellationTokenSource();
      const stop = token.onCancellationRequested(() => cts.cancel());
      running = this.run(once, cts.token).finally(() => {
        stop.dispose();
        running = undefined;
        if (again && !token.isCancellationRequested) { again = false; go(); }
      });
    };
    const changed = (uri: vscode.Uri) => {
      if (/[\\/](build|results|\.git|node_modules)[\\/]/.test(uri.fsPath)) return;
      clearTimeout(timer);
      timer = setTimeout(go, 800);
    };
    const subs = [watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed)];
    await new Promise<void>((resolve) => token.onCancellationRequested(() => resolve()));
    clearTimeout(timer);
    for (const d of subs) d.dispose();
    await running;
  }

  /** `validate` on a system file as it is on disk: its errors in Problems, at the lines they name. */
  private async validate(uri: vscode.Uri) {
    const rel = path.relative(this.repo, uri.fsPath);
    let out = "";
    const code = await this.script(["run", "python", "-m", "vhil.system", "validate", rel],
      this.env(), (t) => { out += t; }).done;
    let text: string;
    try { text = fs.readFileSync(uri.fsPath, "utf8"); } catch { this.systemProblems.delete(uri); return; }
    const lines = text.split("\n");
    this.systemProblems.set(uri, code === 0 ? [] : validationProblems(out, text).map((p) => {
      const n = Math.min(p.line, lines.length - 1);
      const range = new vscode.Range(n, 0, n, lines[n].replace(/\r$/, "").length);
      const d = new vscode.Diagnostic(range, p.message, vscode.DiagnosticSeverity.Error);
      d.source = "vhil.system validate";
      return d;
    }));
  }

  // -- debugging a test (#425) -------------------------------------------------

  /**
   * Run one test with a board held for VS Code's debugger
   * (vhil/debugattach.py): once the board waits (ready.json), attach the
   * host's arm-none-eabi-gdb through cppdbg; the test goes on when the board
   * runs, and its result comes in as any run's.
   */
  private async debug(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    if (!this.byId.size) await this.refresh();
    const tests = (request.include ?? []).flatMap((i) => this.leaves(i));
    if (tests.length !== 1 || !tests[0].id.includes("::") || tests[0].id.startsWith("tests/unit/")) {
      void vscode.window.showErrorMessage("vHIL: debug one sim or scenario test at a time.");
      return;
    }
    const test = tests[0];
    if (!vscode.extensions.getExtension("ms-vscode.cpptools")) {
      const a = await vscode.window.showErrorMessage(
        "vHIL: debugging a test needs the C/C++ extension (ms-vscode.cpptools).", "Install");
      if (a) await vscode.commands.executeCommand("workbench.extensions.installExtension", "ms-vscode.cpptools");
      return;
    }
    const boards = debugBoards({ id: test.id, markers: test.tags.map((t) => t.id) }, this.local?.firmware.id);
    const board = boards.length > 1
      ? (await vscode.window.showQuickPick(boards, { title: "vHIL: debug which board?" }))
      : boards[0] ?? (await vscode.window.showInputBox({ title: "vHIL: debug which board?", prompt: "ecu, ams or udv" }));
    if (!board) return;
    const port = await freePort();
    const dir = path.join(this.repo, "results", "vscode", "debug");
    const readyFile = path.join(dir, "ready.json");
    fs.rmSync(readyFile, { force: true });
    const gdb = vscode.workspace.getConfiguration("vhil").get<string>("gdbPath", "") || "arm-none-eabi-gdb";

    let done = false;
    let session: vscode.DebugSession | undefined;
    const started = vscode.debug.onDidStartDebugSession((s) => {
      if (s.configuration.miDebuggerServerAddress === `127.0.0.1:${port}`) session = s;
    });
    // Attach once the board waits; the build and the boot to it come first.
    const attach = (async () => {
      while (!done && !token.isCancellationRequested) {
        if (fs.existsSync(readyFile)) {
          try {
            const ready = JSON.parse(fs.readFileSync(readyFile, "utf8")) as Ready;
            const local = this.local ? { firmware: this.local.firmware.id, dir: this.local.dir } : undefined;
            // No breakpoint would run the test straight through: stop at the first instruction.
            const stop = !vscode.debug.breakpoints.some((b) => b.enabled);
            await vscode.debug.startDebugging(this.folder,
              debugConfig(ready, dir, gdb, local, stop) as vscode.DebugConfiguration);
            if (stop) {
              void vscode.window.showInformationMessage(
                `vHIL: ${ready.board} is paused at its first instruction (no breakpoints set). ` +
                "Set breakpoints, then Continue (F5).");
            }
            return;
          } catch {
            // Still being written: the next poll.
          }
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    })();
    try {
      await this.run(new vscode.TestRunRequest([test], undefined, request.profile), token,
                     { VHIL_DEBUG: `${board}:${port}` });
    } finally {
      done = true;
      await attach;
      started.dispose();
      if (session) await vscode.debug.stopDebugging(session);
    }
  }

  // -- firmware, the system editor, systems -----------------------------------

  private async buildFirmware() {
    const pick = await vscode.window.showQuickPick(
      [{ label: "ecu ams", description: "what sim and scenario tests need" },
       { label: "ecu ams udv", description: "and the uDV, for its tests" },
       { label: "udv", description: "the uDV only" }],
      { title: "vHIL: build firmware (IFS_HIL's recipes, in Docker)" });
    if (pick) await this.task(`Build firmware: ${pick.label}`, ["fw", ...pick.label.split(" ")]);
  }

  /**
   * The system editor in a VS Code tab: a webview framing EDITOR_URL (the
   * editor's frame-ancestors allows VS Code, vhil/server/security.py). Starts
   * the editor first if it doesn't answer, and frames it once it does, on
   * `system` if given (the editor's ?system=).
   */
  private async openEditor(system?: string) {
    const page = system ? `${EDITOR_URL}?system=${encodeURIComponent(system)}` : EDITOR_URL;
    if (this.editorPanel) {
      this.editorPanel.reveal();
      if (system && this.editorReady) {
        const url = await vscode.env.asExternalUri(vscode.Uri.parse(page));
        this.editorPanel.webview.html = editorHtml(url.toString(true));
      } else if (system) {
        this.editorPage = page;
      }
      return;
    }
    this.editorPage = page;
    this.editorReady = false;
    const panel = vscode.window.createWebviewPanel("vhil.editor", "vHIL system editor",
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.editorPanel = panel;
    let open = true;
    panel.onDidDispose(() => { open = false; this.editorPanel = undefined; this.editorReady = false; });
    panel.webview.html = editorHtml(undefined, "Starting the system editor…");
    const deadline = Date.now() + 5 * 60_000;
    while (open && !(await editorAnswers())) {
      if (!this.editorTask) void this.task("System editor", ["editor"]);
      if (Date.now() > deadline) {
        panel.webview.html = editorHtml(undefined,
          "The system editor didn't start in 5 minutes. See the System editor terminal.");
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!open) return;
    // Through asExternalUri, so a remote window reaches it through a forwarded port.
    const url = await vscode.env.asExternalUri(vscode.Uri.parse(this.editorPage));
    panel.webview.html = editorHtml(url.toString(true));
    this.editorReady = true;
  }

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
  }

  /** The systems shown: in a firmware repository, those that run its firmware. */
  private mySystems(): SystemInfo[] {
    return this.local ? systemsOf(this.systems, this.local.firmware.id) : this.systems;
  }

  private async pickSystem(title: string, only?: (s: SystemInfo) => boolean): Promise<string | undefined> {
    const pick = await vscode.window.showQuickPick(
      this.mySystems().filter((s) => !only || only(s)).map((s) => ({
        label: s.id, description: s.boards.map((b) => b.name).join(", "), detail: s.description,
      })), { title: `vHIL: ${title}` });
    return pick?.label;
  }

  private async updateVhil() {
    if (!this.local) {
      void vscode.window.showInformationMessage("vHIL: this is your own checkout: update it with git.");
      return;
    }
    if (await updateCheckout(this.context, this.repo)) {
      this.readSystems();
      await this.refresh();
    }
  }

  // -- the palette's tools (the vHIL repository) ------------------------------

  private async tools() {
    const pick = await vscode.window.showQuickPick(
      TOOLS.map((t) => ({ label: `$(${t.icon}) ${t.label}`, detail: t.detail, id: t.id })),
      { title: "vHIL: tools" });
    if (pick) await this.tool(pick.id);
  }

  private async tool(id: ToolId) {
    switch (id) {
      case "shell":
        await this.task("Shell", ["shell"]);
        return;
      case "speed":
        await this.task("Speed", ["speed"]);
        return;
      case "smoke": {
        const s = await this.pickSystem("smoke suite of which system?", (x) => x.smoke);
        if (s) await this.task(`Smoke: ${s}`, ["smoke", s]);
        return;
      }
      case "validate": {
        const s = await this.pickSystem("validate which system?");
        if (s) await this.task(`Validate ${s}`, ["run", "python", "-m", "vhil.system", "validate", `systems/${s}.yaml`]);
        return;
      }
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
}

/** The editor panel's page: the editor framed at `url`, else `message`. */
function editorHtml(url: string | undefined, message = ""): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const origin = url ? new URL(url).origin : "";
  const csp = `default-src 'none'; style-src 'unsafe-inline'${origin ? `; frame-src ${origin}` : ""}`;
  const body = url
    ? `<iframe src="${esc(url)}" allow="clipboard-read; clipboard-write"></iframe>`
    : `<p>${esc(message)}</p>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
iframe { border: 0; width: 100%; height: 100%; display: block; }
p { padding: 1em; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }</style>
</head><body>${body}</body></html>`;
}

/** Whether the system editor answers on its proxy. */
function editorAnswers(): Promise<boolean> {
  return fetch(EDITOR_URL, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
}

/** A free TCP port on the host, for a held board's debugger. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
