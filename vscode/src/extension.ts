// The vHIL in VS Code: every test of tests/unit, tests/sim and
// tests/scenarios in the Testing panel, one status bar item (state, and a
// click runs the tests again), and the system editor in a tab; all run in
// the vHIL's Docker image through scripts/vhil-docker.sh, as CI runs them
// (vscode/README.md). VS Code's own Test Results keep the run history.
//
// A sidebar view lists the systems (open one in the editor, make a new one).
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
  Bp, builtLines, clip, collectArgs, debugStops, dockerContext, fileOf, FIRMWARE_SAVE_GLOB, ignoredSave, Item, Job,
  labelOf, parseLines, plan, Record, remapItems, runArgs, startsVm, SUITES,
} from "./plan";
import {
  buildSystem, Firmware, firmwareForRepo, firmwareOf, repoSlug, systemsOf, testRuns,
} from "./firmware";
import { boardsOf as debugBoards, debugConfig, entryBreakpoint, Ready } from "./debug";
import {
  barOf, DebuggerHealth, findings, Fix, GROUP, groupId, holdBack, ImageState, imagesNeeded, parseStatus, Phase, scenarioSystem,
} from "./status";
import { boardsOf, descriptionOf, ifsHilArgs, SystemInfo, ToolId, TOOLS, validationProblems } from "./systems";
import { compilerDiagnostics, hostPath, PathMap, Snapshot, snapshotMarkdown } from "./trace";
import { TRACE_VIEW, TracePanel } from "./tracePanel";
import {
  addressError, busError, partArgs, partFiles, partIdError, pinError, Protocol, PROTOCOLS, whoAmIError,
} from "./part";
import { newSystemError, Row, rows } from "./systemsView";
import { SystemsView } from "./systemsTree";

const SCRIPT = "scripts/vhil-docker.sh";
// Where the plugin's JSON lines go: results/ is git-ignored and inside /work.
const OUT_DIR = "results/vscode";
// Firmware the sim and scenario jobs need (scripts/vhil-docker.sh need_elf).
const NEEDED_FW = ["ecu", "ams", "ecu.bootloader"];
const EDITOR_URL = "http://localhost:8080/editor/";

let current: Vhil | undefined;
// "vHIL: not set up": a firmware repository (a top-level .ioc) whose set-up failed, and why.
let notSetUp: vscode.StatusBarItem | undefined;

export async function activate(context: vscode.ExtensionContext) {
  // Contributed without vhil.active: it is how a failed set-up is retried.
  context.subscriptions.push(vscode.commands.registerCommand("vhil.setup", () => setup(context, true)));
  await setup(context, false);
}

/**
 * Find what the window opened: the vHIL checkout, else a firmware repository
 * the catalogue builds. A folder with a top-level .ioc (an STM32 project)
 * that can't be set up says why in the status bar instead of staying silent.
 */
async function setup(context: vscode.ExtensionContext, retry: boolean) {
  if (current) {
    if (retry && current.isFirmwareRepo) await vscode.commands.executeCommand("vhil.updateVhil");
    else if (retry) void vscode.window.showInformationMessage("vHIL: set up (this is the vHIL checkout).");
    return;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  const own = folders.find((f) => fs.existsSync(path.join(f.uri.fsPath, SCRIPT)));
  if (own) {
    start(context, new Vhil(own.uri.fsPath, own, context));
    return;
  }
  let why: string | undefined;
  for (const f of folders) {
    const r = await firmwareRepo(context, f);
    if ("local" in r) {
      start(context, new Vhil(r.local.checkout, f, context, r.local));
      return;
    }
    if (!why && hasIoc(f.uri.fsPath)) why = `${f.name}: ${r.why}`;
  }
  if (!why) {
    if (retry) void vscode.window.showInformationMessage("vHIL: no vHIL checkout or STM32 firmware repository open.");
    return;
  }
  if (!notSetUp) {
    notSetUp = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    notSetUp.text = "$(warning) vHIL: not set up";
    notSetUp.command = "vhil.setup";
    context.subscriptions.push(notSetUp);
  }
  notSetUp.tooltip = `${why}\nClick to retry (vHIL: Set up / Retry).`;
  notSetUp.show();
  if (retry) void vscode.window.showErrorMessage(`vHIL: not set up: ${why}`);
}

function hasIoc(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith(".ioc"));
  } catch {
    return false;
  }
}

function start(context: vscode.ExtensionContext, vhil: Vhil) {
  current = vhil;
  notSetUp?.dispose();
  notSetUp = undefined;
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
 * Whether `folder` is a firmware repository the catalogue builds, else why
 * not. Its `origin` (or, in a fork, `upstream`) must be on the vHIL's GitHub
 * owner before anything is fetched; then the extension's checkout is cloned
 * (once) and its catalogue decides.
 */
async function firmwareRepo(context: vscode.ExtensionContext,
                            folder: vscode.WorkspaceFolder): Promise<{ local: Local } | { why: string }> {
  const dir = folder.uri.fsPath;
  const owner = repoSlug(vhilRepo().url)?.split("/")[0];
  const slugs: string[] = [];
  for (const remote of ["origin", "upstream"]) {
    const r = await git(dir, ["remote", "get-url", remote]);
    const slug = r.ok ? repoSlug(r.out) : undefined;
    if (slug) slugs.push(slug);
  }
  const ours = slugs.filter((s) => owner && s.split("/")[0].toLowerCase() === owner.toLowerCase());
  if (!ours.length) {
    return { why: slugs.length ? `${slugs.join(", ")} is not on ${owner} (origin or upstream)`
                               : `no GitHub origin or upstream remote on ${owner}` };
  }
  const checkout = path.join(context.globalStorageUri.fsPath, "IFS-vHIL");
  if (!fs.existsSync(path.join(checkout, SCRIPT))) {
    const r = await updateCheckout(context, checkout);
    if (!r.ok) return { why: `cloning the vHIL failed: ${r.error}` };
  }
  const dirFw = path.join(checkout, "catalog", "firmware");
  const catalogue = fs.readdirSync(dirFw).filter((f) => f.endsWith(".yaml"))
    .map((f) => firmwareOf(fs.readFileSync(path.join(dirFw, f), "utf8")))
    .filter((f): f is Firmware => !!f);
  for (const slug of ours) {
    const firmware = firmwareForRepo(catalogue, slug);
    if (firmware) return { local: { firmware, dir, checkout } };
  }
  return { why: `${ours.join(", ")} is not in the vHIL's catalogue (catalog/firmware)` };
}

const UPDATED_KEY = "vhil.checkoutUpdated";

/**
 * Clone the extension's vHIL checkout, or bring it to the configured ref.
 * With `env` (vhil-docker.sh's settings), a ref whose newest commit has no
 * images yet keeps the commit it was on (holdBack): the new commit's own
 * `vhil-docker.sh status` says, after the reset, and a hold resets back.
 */
async function updateCheckout(context: vscode.ExtensionContext, checkout: string,
                              env?: NodeJS.ProcessEnv,
                              log?: (line: string) => void): Promise<{ ok: boolean; error?: string }> {
  const { url, ref } = vhilRepo();
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `vHIL: fetching ${repoSlug(url) ?? url}@${ref}` },
    async () => {
      let r;
      if (!fs.existsSync(path.join(checkout, ".git"))) {
        fs.mkdirSync(path.dirname(checkout), { recursive: true });
        r = await git(path.dirname(checkout), ["clone", "-q", "--depth", "1", "-b", ref, url, checkout], 300000);
      } else {
        const before = (await git(checkout, ["rev-parse", "HEAD"])).out.trim();
        r = await git(checkout, ["fetch", "-q", "--depth", "1", url, ref], 300000);
        if (r.ok) r = await git(checkout, ["reset", "-q", "--hard", "FETCH_HEAD"]);
        const after = r.ok ? (await git(checkout, ["rev-parse", "HEAD"])).out.trim() : "";
        if (r.ok && env && before && after && after !== before) {
          const tip = await tipImages(checkout, env);
          if (tip && holdBack(tip)) {
            const back = await git(checkout, ["reset", "-q", "--hard", before]);
            if (back.ok) {
              const line = `${ref}'s newest commit ${after.slice(0, 7)} has no published images yet ` +
                           `(they publish minutes after a push): staying on ${before.slice(0, 7)}.`;
              log?.(line);
              void vscode.window.showInformationMessage(`vHIL: ${line} Update again later.`);
              // Not marked updated: the next start tries again.
              return { ok: true };
            }
          }
        }
      }
      if (!r.ok) {
        void vscode.window.showErrorMessage(`vHIL: couldn't fetch ${url}@${ref}: ${r.out.trim()}`);
        return { ok: false, error: r.out.trim().split("\n")[0] };
      }
      await context.globalState.update(UPDATED_KEY, Date.now());
      return { ok: true };
    });
}


/** The checkout's image states (its own vhil-docker.sh status) and its HEAD's age. */
async function tipImages(checkout: string, env: NodeJS.ProcessEnv) {
  const text = await new Promise<string>((resolve) =>
    cp.execFile("bash", [path.join(checkout, SCRIPT), "status"], { env, cwd: checkout, timeout: 60000 },
      (_err, stdout) => resolve(stdout ?? "")));
  const status = parseStatus(text);
  const time = Number((await git(checkout, ["log", "-1", "--format=%ct", "HEAD"])).out.trim());
  if (!status || !time) return undefined;
  return { base: status.baseState, editor: status.editorState, ageS: Date.now() / 1000 - time };
}

export function deactivate() {}

/** How a run is made: the job's extra environment, and who wants its TestRun (Debug Test). */
interface RunOptions {
  env?: { [key: string]: string };
  onRun?: (run: vscode.TestRun) => void;
}

/**
 * A firmware build that failed before the compiler ran: Docker or the image,
 * not the working tree. Its tests didn't run, so they don't fail.
 */
const INFRA_FAILURE = /Cannot connect to the Docker daemon|error during connect|docker: command not found|pull access denied|manifest unknown|no space left on device|failed to (solve|pull)/i;

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
  private busy = 0; // runs that own the status bar (queued behind each other)
  // Every run goes through this queue (the Run profile, the status bar,
  // a system's scenarios, Debug Test, run on save): two at once would share
  // results/vscode, the firmware build and the host's cores.
  private queue: Promise<void> = Promise.resolve();
  private lastRequest: vscode.TestRunRequest | undefined;
  private dockerUp: boolean | undefined;
  private dockerCli = true;
  // `docker info` on the run path: at most once per 30 s.
  private dockerAt = 0;
  private baseState: ImageState | undefined;
  private editorState: ImageState | undefined;
  private dirty = false;
  private built = new Map<string, string>();
  private editorUp = false;
  private editorTask: vscode.TaskExecution | undefined;
  private editorEnded: Promise<number | undefined> | undefined;
  private editorPanel: vscode.WebviewPanel | undefined;
  /** The page the panel frames once the editor answers, and whether it does yet. */
  private editorPage = EDITOR_URL;
  private editorReady = false;
  /** The framed editor said vhil.ready: it opens systems without a reload. */
  private editorHandshake = false;
  private editorWait: Promise<void> | undefined;
  private checking: Promise<void> | undefined;
  private systems: SystemInfo[] = [];
  // A test's bus trace (.trace.jsonl, absolute) and its failure snapshots.
  private readonly traces = new Map<string, string>();
  private readonly snapshots = new Map<string, Snapshot[]>();
  private readonly tracePanel: TracePanel;
  private readonly systemsView = new SystemsView();
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
      this.systemsView, vscode.window.registerTreeDataProvider("vhil.systems", this.systemsView),
      vscode.window.registerWebviewViewProvider(TRACE_VIEW, this.tracePanel,
        { webviewOptions: { retainContextWhenHidden: true } }),
      tests.onDidChange(later), tests.onDidCreate(later), tests.onDidDelete(later),
      systems.onDidChange(revalidate), systems.onDidCreate(revalidate),
      systems.onDidDelete((uri) => { reread(); this.systemProblems.delete(uri); }),
      vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution === this.editorTask) { this.editorTask = undefined; this.editorEnded = undefined; }
        if (e.execution.task.source === "vHIL") void this.checkStatus();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("vhil")) void this.checkStatus();
      }),

      command("vhil.statusClick", () => this.statusClick()),
      command("vhil.diagnose", () => this.diagnose()),
      command("vhil.refreshTests", () => this.refresh()),
      command("vhil.startVm", () => this.task("Start the Docker VM", ["vm"])),
      command("vhil.pullImages", () => this.pullImages()),
      command("vhil.buildImages", () => this.task("Build images", ["image"])),
      command("vhil.buildFirmware", () => this.buildFirmware()),
      command("vhil.openEditor", () => this.openEditor()),
      // From a scenario system's group in the Testing panel, or the palette.
      // From the Systems view (its id), a scenario system's group in the Testing panel, or the palette.
      command("vhil.openSystemInEditor", async (item?: vscode.TestItem | Row | string) => {
        const id = systemOf(item) ?? await this.pickSystem("Open in the system editor");
        if (id) await this.openEditor(id);
      }),
      command("vhil.newSystem", () => this.newSystem()),
      command("vhil.newPart", () => this.newPart()),
      command("vhil.openSystemYaml", async (item?: Row | string) => {
        const id = systemOf(item) ?? await this.pickSystem("Open which system file?");
        if (id) await vscode.window.showTextDocument(vscode.Uri.file(path.join(this.repo, "systems", `${id}.yaml`)));
      }),
      command("vhil.runSystemScenarios", (item?: Row | string) => this.runScenarios(systemOf(item))),
      command("vhil.openEditorInBrowser", async () => {
        const url = await vscode.env.asExternalUri(vscode.Uri.parse(this.editorPage));
        await vscode.env.openExternal(url);
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
    // The script names its context colima-<profile>: a context set here names the profile `vm` starts.
    if (startsVm(c.context)) env.VHIL_COLIMA_PROFILE = c.context.slice("colima-".length);
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
    // Its own process group: Cancel stops the script and every child it started.
    const proc = cp.spawn(path.join(this.repo, SCRIPT), args,
      { cwd: this.repo, env, detached: process.platform !== "win32" });
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
   * Stop a job: SIGTERM to the script's process group, then `docker kill`
   * its container every 500 ms until the script exits (docker run doesn't
   * pass SIGTERM on to pytest, and the container may not exist yet).
   */
  private stopJob(job: { done: Promise<number>; proc: cp.ChildProcess }, name: string) {
    const pid = job.proc.pid;
    try {
      if (pid) process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    let closed = false;
    void job.done.then(() => { closed = true; });
    const kill = () => {
      if (closed) return;
      cp.execFile("docker", ["--context", this.config().context, "kill", name],
        () => { if (!closed) setTimeout(kill, 500); });
    };
    kill();
  }

  /**
   * A vhil-docker.sh command as a VS Code task: in the terminal panel, where
   * it can be watched and stopped. `ended` resolves with its exit code.
   */
  private startTask(label: string, args: string[], extraEnv: { [key: string]: string } = {}):
      { execution: Thenable<vscode.TaskExecution>; ended: Promise<number | undefined> } {
    const env = { ...this.overrides(), ...extraEnv };
    const t = new vscode.Task({ type: "vhil", args }, this.folder, label, "vHIL",
      new vscode.ShellExecution(`./${SCRIPT}`, args, { cwd: this.repo, env }));
    t.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
    let execution: vscode.TaskExecution | undefined;
    let end!: (code: number | undefined) => void;
    const ended = new Promise<number | undefined>((resolve) => { end = resolve; });
    const sub = vscode.tasks.onDidEndTaskProcess((e) => {
      if (!execution || e.execution !== execution) return;
      sub.dispose();
      end(e.exitCode);
    });
    const started = vscode.tasks.executeTask(t);
    // A task that never starts has ended too, so nobody waits on it forever.
    Promise.resolve(started).then((e) => { execution = e; }, () => { sub.dispose(); end(-1); });
    return { execution: started, ended };
  }

  private async task(label: string, args: string[], extraEnv: { [key: string]: string } = {}): Promise<number | undefined> {
    const t = this.startTask(label, args, extraEnv);
    await t.execution;
    return t.ended;
  }

  private pullImages() {
    // `images`: pull what's published, build what isn't (as a run would).
    return this.task("Get images", ["images"]);
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
    if (imagesNeeded(this.baseState, this.editorState)) {
      return { kind: "images", base: this.baseState, editor: this.editorState };
    }
    return { kind: "idle", firmware: this.local?.firmware.id, dirty: this.dirty, missing: this.missingFirmware() };
  }

  private async statusClick() {
    const action = barOf(this.phase).action;
    if (action === "diagnose") return this.diagnose();
    if (action === "pullImages") return this.pullImages();
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

  /**
   * Whether Docker answers (`docker info`), and whether the docker command
   * exists at all. Cheap: the run path asks only this, at most every 30 s.
   */
  private async dockerInfo(): Promise<boolean> {
    const { context } = this.config();
    const r = await new Promise<{ up: boolean; cli: boolean }>((resolve) =>
      cp.execFile("docker", ["--context", context, "info", "--format", "{{.ServerVersion}}"],
        { timeout: 15000 }, (err) => resolve({ up: !err, cli: (err as NodeJS.ErrnoException | null)?.code !== "ENOENT" })));
    this.dockerUp = r.up;
    this.dockerCli = r.cli;
    this.dockerAt = r.up ? Date.now() : 0;
    return r.up;
  }

  /**
   * The whole state, in the background: Docker first (the view and the bar
   * update as soon as it answers), then the editor, the working tree, and
   * `vhil-docker.sh status` (image states, built firmware), which starts no
   * container. A checkout whose script has no `status` keeps what it knew.
   */
  private async check() {
    const up = await this.dockerInfo();
    this.updateView();
    this.settle();
    const editor = editorAnswers();
    if (this.local) {
      const status = await git(this.local.dir, ["status", "--porcelain"]);
      this.dirty = status.ok && !!status.out.trim();
    }
    if (up) {
      let text = "";
      const code = await this.script(["status"], this.env(), (t) => { text += t; }).done;
      const status = parseStatus(text);
      if (status && !(code !== 0 && /usage/i.test(text))) {
        this.baseState = status.baseState;
        this.editorState = status.editorState;
        this.built = status.built;
      }
    }
    this.editorUp = await editor;
    this.updateView();
    this.settle();
  }

  /**
   * The bar back to the idle phase when no run owns it. A run's result stays
   * up (the check after a run must not wipe it) unless something is wrong.
   */
  private settle() {
    if (this.busy) return;
    const idle = this.idlePhase();
    if (this.phase.kind === "result" && idle.kind === "idle") return;
    this.setPhase(idle);
  }

  private missingFirmware(): string[] {
    return NEEDED_FW.filter((b) => !this.built.get(b));
  }

  /** The C/C++ extension and the host's GDB, for Debug Test. */
  private async debuggerHealth(): Promise<DebuggerHealth> {
    const gdb = this.gdbPath();
    const version = await new Promise<string | undefined>((resolve) =>
      cp.execFile(gdb, ["--version"], { env: this.env(), timeout: 10000 },
        (err, stdout) => resolve(err ? undefined : stdout.split("\n")[0].trim() || gdb)));
    return { cpptools: !!vscode.extensions.getExtension("ms-vscode.cpptools"), gdb, version };
  }

  private gdbPath(): string {
    return vscode.workspace.getConfiguration("vhil").get<string>("gdbPath", "") || "arm-none-eabi-gdb";
  }

  /**
   * Each check with its fix: what replaces a status view. From the last
   * check (only `docker info` is asked when nothing was checked yet); a
   * fresh one runs in the background for next time.
   */
  private async diagnose() {
    if (this.dockerUp === undefined) await this.dockerInfo();
    void this.checkStatus();
    const { context } = this.config();
    const list = findings({
      context, startsVm: startsVm(context), dockerCli: this.dockerCli, dockerUp: !!this.dockerUp,
      baseState: this.baseState, editorState: this.editorState, built: this.built,
      needed: NEEDED_FW, editorUp: this.editorUp, debugger: await this.debuggerHealth(),
    });
    const fixes: { [f in Fix]: string } = {
      startVm: "Start the Docker VM", pullImages: "Get the images", buildFirmware: "Build firmware",
      openSettings: "Open the setting", openEditor: "Open the system editor",
    };
    const pick = await vscode.window.showQuickPick(list.map((f) => ({
      label: `$(${f.ok ? "pass" : "warning"}) ${f.label}`,
      description: f.detail,
      detail: f.fix ? `Fix: ${fixes[f.fix]}${f.setting ? ` (${f.setting})` : ""}` : undefined,
      fix: f.fix,
      setting: f.setting,
    })), { title: "vHIL: diagnose", placeHolder: "Pick one to fix it" });
    switch (pick?.fix) {
      case "startVm": return this.task("Start the Docker VM", ["vm"]);
      case "pullImages": return this.pullImages();
      case "buildFirmware": return this.buildFirmware();
      case "openSettings":
        return vscode.commands.executeCommand("workbench.action.openSettings", pick.setting ?? "vhil.dockerContext");
      case "openEditor": return this.openEditor();
    }
  }

  /**
   * Docker up before a run: only `docker info` (cached 30 s), never a
   * container. The Colima VM is started here (vhil-docker.sh pulls the
   * images and builds missing firmware itself); any other context is the
   * user's to start. Listing tests on open (`start` false) only checks: the
   * status bar then says Docker is down.
   */
  private async ensureDocker(start = true): Promise<boolean> {
    if (this.dockerUp && Date.now() - this.dockerAt < 30_000) return true;
    if (await this.dockerInfo()) return true;
    if (!start) {
      if (!this.busy) this.setPhase(this.idlePhase());
      return false;
    }
    const { context } = this.config();
    if (startsVm(context)) {
      await this.task("Start the Docker VM", ["vm"]);
      if (await this.dockerInfo()) return true;
    }
    this.updateView();
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
    // vhil.pytestArgs change what is listed (-m, -k): a listing is theirs too.
    const args = JSON.stringify(this.config().pytestArgs);
    return `vhil.tests:${this.repo}:${head}:${this.local?.firmware.id ?? ""}:${args}`;
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
    const job = this.script(collectArgs(out.rel, roots, this.config().pytestArgs), this.env(), (t) => this.log.append(t));
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

  /**
   * Run `request` after whatever run is queued before it: one run at a time.
   * Resolves when this one has ended.
   */
  private run(request: vscode.TestRunRequest, token: vscode.CancellationToken, opts: RunOptions = {}): Promise<void> {
    const mine = this.queue.then(() => this.runNow(request, token, opts));
    this.queue = mine.catch((e) => { this.log.appendLine(`vHIL: a run failed: ${e}`); });
    return mine;
  }

  /** The items of the current listing for `items` (a request made before a refresh). */
  private remap(items: readonly vscode.TestItem[]): vscode.TestItem[] {
    return remapItems(items.map((i) => i.id), this.byId);
  }

  private async runNow(request: vscode.TestRunRequest, token: vscode.CancellationToken, opts: RunOptions) {
    if (token.isCancellationRequested) return;
    if (!this.byId.size) {
      if (!(await this.ensureDocker())) return;
      await this.refresh();
    }
    // The request's items may be from before a refresh (a rerun, a run that
    // waited in the queue): this listing's, minus what is gone.
    const include = request.include ? this.remap(request.include) : undefined;
    if (request.include && !include?.length) return;
    request = new vscode.TestRunRequest(include, request.exclude ? this.remap(request.exclude) : undefined,
      request.profile);
    if (!opts.env?.VHIL_DEBUG) this.lastRequest = request;
    const included = request.include ?? [...this.controller.items].map(([, i]) => i);
    const excluded = request.exclude ?? [];
    const excludedIds = new Set(excluded.flatMap((e) => this.leaves(e)).map((e) => e.id));
    const run = this.controller.createTestRun(request);
    opts.onRun?.(run);
    const all = included.flatMap((i) => this.leaves(i)).filter((t) => !excludedIds.has(t.id));
    for (const t of all) run.enqueued(t);

    const tally: Tally = { passed: 0, failed: new Set(), skipped: 0, total: all.length };
    // A scenario group isn't a pytest id: its tests are.
    const ids = included.flatMap((i) => i.id.startsWith(GROUP) ? this.leaves(i).map((l) => l.id) : [i.id]);
    const groups = plan(ids);
    const c = this.config();
    // Whether the run tested anything: a job ran, or the working tree didn't
    // compile. Docker down or a build that never got to the compiler is no
    // result: the bar goes back to saying what's wrong.
    const tested = { started: false };
    const skipAll = (why: string) => {
      run.appendOutput(`${why}\r\n`);
      for (const t of all) run.skipped(t);
      tally.skipped = all.length;
    };
    this.busy++;
    try {
      if (!(await this.ensureDocker())) {
        skipAll(`vHIL: Docker (context ${c.context}) doesn't answer: nothing ran.`);
        return;
      }
      if (this.local && [...groups.keys()].some((j) => j !== "unit")) {
        this.setPhase({ kind: "building", firmware: `${this.local.firmware.id}@local` });
        const built = await this.buildLocal(run, tally, all, token);
        if (built === "failed") tested.started = true;
        if (built === "cancelled") skipAll("vHIL: cancelled during the firmware build: nothing ran.");
        if (built === "infra") {
          skipAll("vHIL: the firmware build didn't get to the compiler: nothing ran.");
          void vscode.window.showErrorMessage(
            `vHIL: building ${this.local.firmware.id}@local failed before compiling (see the test run's output).`,
            "Diagnose").then((a) => { if (a) void this.diagnose(); });
        }
        if (built !== "ok") return;
      }
      this.progress(tally);
      for (const [job, jobIds] of groups) {
        if (token.isCancellationRequested) break;
        const mine = all.filter((t) => jobIds.some((id) => t.id === id || t.id.startsWith(id + "/") || t.id.startsWith(id + "::")));
        const deselect = [...excludedIds].filter((id) => jobIds.some((g) => id.startsWith(g + "/") || id.startsWith(g + "::")));
        tested.started = true;
        await this.runJob(run, tally, job, jobIds, deselect, mine, c.pytestArgs, token, opts.env);
      }
    } finally {
      run.end();
      this.busy--;
      // The run may have pulled or built the images, and built firmware.
      void this.checkStatus();
      // The first failure's buses, in the panel, without taking focus.
      const failed = all.find((t) => tally.failed.has(t.id) && this.traces.has(t.id));
      if (failed) void this.tracePanel.show(this.traces.get(failed.id)!, labelOf(failed.id), false);
      const cancelled = token.isCancellationRequested;
      if (!tested.started && !cancelled) {
        if (!this.busy) this.setPhase(this.idlePhase());
      } else {
        this.setPhase({ kind: "result", passed: tally.passed, failed: tally.failed.size, skipped: tally.skipped,
                        cancelled: cancelled || undefined });
      }
    }
  }

  private progress(tally: Tally) {
    this.setPhase({ kind: "running", done: tally.passed + tally.failed.size + tally.skipped, total: tally.total });
  }

  private async runJob(run: vscode.TestRun, tally: Tally, job: Job, ids: string[], deselect: string[],
                       tests: vscode.TestItem[], extra: string[],
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
    const cancel = token.onCancellationRequested(() => this.stopJob(proc, name));

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
   * the run's output. A compile failure ("failed") errors every test of the
   * run with the build's errors; a build that never got to the compiler
   * (Docker, an image pull, the script itself: "infra") is the caller's to
   * report as nothing ran.
   */
  private async buildLocal(run: vscode.TestRun, tally: Tally, tests: vscode.TestItem[],
                           token: vscode.CancellationToken): Promise<"ok" | "failed" | "infra" | "cancelled"> {
    const fw = this.local!.firmware.id;
    const system = buildSystem(this.systems, fw);
    if (!system) return "ok";
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
    const cancel = token.onCancellationRequested(() => this.stopJob(proc, name));
    const code = await proc.done;
    cancel.dispose();
    // What it built, from the board=elf lines `fw` prints: no container to read built.txt.
    for (const [board, elf] of builtLines(text)) this.built.set(board, elf);
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
    if (code === 0) return "ok";
    // Cancel (or a debugger that didn't start) killed the build: not a failure.
    if (token.isCancellationRequested) return "cancelled";
    const errors = diags.filter((d) => d.severity === "error");
    if (!errors.length && (code === -1 || INFRA_FAILURE.test(text))) return "infra";
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
    return "failed";
  }

  private report(run: vscode.TestRun, tally: Tally, r: Record, reported: Set<string>) {
    if (r.kind === "start") {
      const t = this.byId.get(r.id);
      if (t) run.started(t);
      this.snapshots.delete(r.id);
      // The last run's trace is not this run's: Show bus trace waits for the new one.
      if (this.traces.delete(r.id)) {
        void vscode.commands.executeCommand("setContext", "vhil.traced", [...this.traces.keys()]);
      }
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
    // pytest's whole report last: the summary above is one line of it.
    if (r.message && r.short) {
      md.appendMarkdown("\n\n");
      md.appendCodeblock(clip(r.message), "text");
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
    const glob = this.local ? FIRMWARE_SAVE_GLOB : "{vhil,models,systems,catalog,tests}/**";
    const base = this.local?.dir ?? this.repo;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, glob));
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
      if (ignoredSave(base, uri.fsPath)) return;
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
    // A checkout from before the debug hold would run the test straight through.
    if (!fs.existsSync(path.join(this.repo, "vhil", "debugattach.py"))) {
      void vscode.window.showErrorMessage("vHIL: This vHIL checkout can't hold a board for a debugger yet " +
        "(needs the debug-hold change, PR #431). Update the checkout.");
      return;
    }
    if (!this.byId.size) await this.refresh();
    const tests = (request.include ?? []).flatMap((i) => this.leaves(this.byId.get(i.id) ?? i));
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
    // The host's GDB before a run that would wait on it: else a held board waits for nobody.
    const gdb = this.gdbPath();
    const gdbError = await new Promise<string | undefined>((resolve) =>
      cp.execFile(gdb, ["--version"], { env: this.env(), timeout: 10000 }, (err) => resolve(err ? `${err.message}` : undefined)));
    if (gdbError) {
      const a = await vscode.window.showErrorMessage(
        `vHIL: ${gdb} doesn't run (${gdbError.split("\n")[0]}). Debug Test needs the host's arm-none-eabi-gdb.`,
        "Open setting");
      if (a) await vscode.commands.executeCommand("workbench.action.openSettings", "vhil.gdbPath");
      return;
    }
    const boards = debugBoards({ id: test.id, markers: test.tags.map((t) => t.id) }, this.local?.firmware.id);
    if (!boards.length) {
      void vscode.window.showErrorMessage("vHIL: This test runs no MainLite a debugger can hold.");
      return;
    }
    const board = boards.length > 1
      ? (await vscode.window.showQuickPick(boards, { title: "vHIL: debug which board?" }))
      : boards[0];
    if (!board) return;
    const port = await freePort();
    const dir = path.join(this.repo, "results", "vscode", "debug");
    const readyFile = path.join(dir, "ready.json");
    try {
      fs.rmSync(readyFile, { force: true });
    } catch {
      // A stale one is told apart by its port.
    }

    // Our own token: a debugger that doesn't start cancels the run, as Cancel does.
    const cts = new vscode.CancellationTokenSource();
    const linked = token.onCancellationRequested(() => cts.cancel());
    let done = false;
    let held = false;
    let session: vscode.DebugSession | undefined;
    let liveRun: vscode.TestRun | undefined;
    let attachError: unknown;
    let entryBp: vscode.FunctionBreakpoint | undefined;
    const started = vscode.debug.onDidStartDebugSession((s) => {
      if (s.configuration.miDebuggerServerAddress === `127.0.0.1:${port}`) session = s;
    });
    const ended = vscode.debug.onDidTerminateDebugSession((s) => {
      if (s !== session || done) return;
      session = undefined;
      liveRun?.appendOutput("\r\nvHIL: debugger detached: the test runs on to its result\r\n");
    });
    // Attach once the board waits; the build and the boot to it come first.
    const attach = (async () => {
      while (!done && !cts.token.isCancellationRequested) {
        let ready: Ready | undefined;
        try {
          ready = JSON.parse(fs.readFileSync(readyFile, "utf8")) as Ready;
        } catch (e) {
          // Not there yet (ENOENT) or still being written (SyntaxError): the next poll.
          const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
          if (!missing && !(e instanceof SyntaxError)) throw e;
        }
        // A ready.json of another debug run (an older one, another window) isn't ours.
        if (ready && ready.port === port) {
          held = true;
          const local = this.local ? { firmware: this.local.firmware.id, dir: this.local.dir } : undefined;
          // No breakpoint firmware can hit would run the test straight through:
          // stop at the app's main, on a breakpoint this session removes.
          const stop = debugStops(vscode.debug.breakpoints.map(bpOf));
          const at = stop ? entryBreakpoint(ready) : undefined;
          if (at) {
            entryBp = new vscode.FunctionBreakpoint(at);
            vscode.debug.addBreakpoints([entryBp]);
          }
          const ok = await vscode.debug.startDebugging(this.folder,
            debugConfig(ready, dir, gdb, local, stop) as vscode.DebugConfiguration);
          if (!ok) {
            cts.cancel();
            void vscode.window.showErrorMessage(
              `vHIL: the debugger didn't start on ${ready.board}: the run is cancelled.`);
          } else if (at) {
            void vscode.window.showInformationMessage(
              `vHIL: ${ready.board} stops at the app's main, after the bootloader hands over. ` +
              "Set breakpoints, then Continue (F5).");
          } else if (stop) {
            void vscode.window.showInformationMessage(
              `vHIL: ${ready.board} is paused at the bootloader's main (the app's has no symbol). ` +
              "Set breakpoints in the app, then Continue (F5).");
          }
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    })().catch((e) => {
      // A held board would wait for a debugger that never comes.
      attachError = e;
      cts.cancel();
    });
    try {
      await this.run(new vscode.TestRunRequest([test], undefined, request.profile), cts.token,
                     { env: { VHIL_DEBUG: `${board}:${port}` }, onRun: (r) => { liveRun = r; } });
    } finally {
      done = true;
      await attach;
      if (attachError) void vscode.window.showErrorMessage(`vHIL: reading ${readyFile} failed: ${attachError}`);
      started.dispose();
      ended.dispose();
      linked.dispose();
      if (!held && !attachError && !token.isCancellationRequested) {
        void vscode.window.showWarningMessage(liveRun
          ? `vHIL: no board was held: ${board} never started in ${labelOf(test.id)}.`
          : `vHIL: ${labelOf(test.id)} is no longer in the test listing: nothing ran.`);
      }
      if (session) await vscode.debug.stopDebugging(session);
      if (entryBp) vscode.debug.removeBreakpoints([entryBp]);
      cts.dispose();
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
   * `system` if given (the editor's ?system=; with &new=1, a new one).
   */
  private async openEditor(system?: string, isNew = false) {
    const firmware = this.local?.firmware.id;
    const page = system
      ? `${EDITOR_URL}?system=${encodeURIComponent(system)}${isNew ? "&new=1" : ""}` +
        `${isNew && firmware ? `&firmware=${encodeURIComponent(firmware)}` : ""}`
      : EDITOR_URL;
    const panel = this.editorPanel;
    if (panel) {
      panel.reveal();
      if (!this.editorReady) {
        // Still starting, or it gave up: wait (again) for it, on this page.
        if (system) this.editorPage = page;
        void this.waitForEditor();
        return;
      }
      if (!system) return;
      if (this.editorHandshake) {
        // The editor opens it itself, as its own Open would (its unsaved-changes guard included).
        void panel.webview.postMessage({ type: "vhil.open", system, isNew, ...(firmware ? { firmware } : {}) });
        return;
      }
      // An editor without the handshake: only a reload opens another system.
      const a = await vscode.window.showWarningMessage(
        `Open ${system} in the editor tab? Uncommitted changes there are lost.`, { modal: true }, "Open");
      if (a !== "Open" || panel !== this.editorPanel) return;
      this.editorPage = page;
      await this.frameEditor(panel);
      return;
    }
    this.editorPage = page;
    this.editorReady = false;
    this.editorHandshake = false;
    const created = vscode.window.createWebviewPanel("vhil.editor", "vHIL system editor",
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.editorPanel = created;
    created.onDidDispose(() => {
      this.editorPanel = undefined;
      this.editorReady = false;
      this.editorHandshake = false;
    });
    created.webview.onDidReceiveMessage((m) => this.editorMessage(created, m));
    void this.waitForEditor();
  }

  /** What the editor tab's relay passes on from the framed editor. */
  private async editorMessage(panel: vscode.WebviewPanel, m: unknown) {
    if (!m || typeof m !== "object" || panel !== this.editorPanel) return;
    const msg = m as { type?: string; url?: unknown };
    if (msg.type === "vhil.ready") {
      this.editorHandshake = true;
    } else if (msg.type === "vhil.openInBrowser") {
      await vscode.commands.executeCommand("vhil.openEditorInBrowser");
    } else if (msg.type === "vhil.openExternal" && typeof msg.url === "string") {
      // Only the editor's own pages and GitHub (a PR it made): the framed page can't open anything else.
      let origin: string;
      try {
        origin = new URL(msg.url).origin;
      } catch {
        return;
      }
      const editor = new URL(this.editorPage).origin;
      const framed = (await vscode.env.asExternalUri(vscode.Uri.parse(this.editorPage))).toString(true);
      if (origin === editor || origin === new URL(framed).origin || origin === "https://github.com") {
        await vscode.env.openExternal(vscode.Uri.parse(msg.url, true));
      }
    }
  }

  /**
   * Wait for the editor to answer, starting its task once if it doesn't,
   * then frame it. Polls while the task runs (a first start pulls or builds
   * its image); if the task ends first, the tab says so and offers Retry:
   * never a relaunch loop. One wait at a time.
   */
  private waitForEditor(): Promise<void> {
    this.editorWait ??= this.waitOnce().finally(() => { this.editorWait = undefined; });
    return this.editorWait;
  }

  private async waitOnce() {
    const panel = this.editorPanel;
    if (!panel) return;
    const open = () => panel === this.editorPanel;
    panel.webview.html = editorHtml(undefined, "Starting the system editor…");
    if (!(await editorAnswers())) {
      if (!this.editorTask || !this.editorEnded) {
        const t = this.startTask("System editor", ["editor"]);
        this.editorEnded = t.ended;
        try {
          this.editorTask = await t.execution;
        } catch {
          // ended resolves with -1: reported below.
        }
      }
      let exit: number | undefined | null = null; // null: still running
      void this.editorEnded!.then((code) => { exit = code ?? -1; });
      while (open() && !(await editorAnswers())) {
        if (exit !== null) {
          panel.webview.html = editorHtml(undefined, `The system editor exited (code ${exit}): see its terminal.`);
          void vscode.window.showErrorMessage(`vHIL: the system editor exited (code ${exit}).`, "Retry", "Diagnose")
            .then((a) => {
              if (a === "Retry") void this.openEditor();
              if (a === "Diagnose") void this.diagnose();
            });
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (open()) await this.frameEditor(panel);
  }

  /** Frame the editor at editorPage: through asExternalUri, so a remote window reaches it through a forwarded port. */
  private async frameEditor(panel: vscode.WebviewPanel) {
    const url = await vscode.env.asExternalUri(vscode.Uri.parse(this.editorPage));
    if (panel !== this.editorPanel) return;
    this.editorHandshake = false;
    panel.webview.html = editorHtml(url.toString(true), "", crypto.randomBytes(16).toString("base64"));
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
    this.updateView();
  }

  private updateView() {
    this.systemsView.update(rows(this.mySystems(),
      { dockerUp: this.dockerUp, editorUp: this.editorUp, context: this.config().context,
        baseState: this.baseState, editorState: this.editorState }, !this.local));
  }

  /** A new system: its id, then the editor on an empty canvas (?new=1); saved by its Commit…. */
  private async newSystem() {
    const existing = this.systems.map((s) => s.id);
    const id = await vscode.window.showInputBox({
      title: "vHIL: new system",
      prompt: "Its id, the file systems/<id>.yaml. Place boards and wire buses in the editor, then Commit….",
      placeHolder: "ecu-ams-dash",
      validateInput: (v) => newSystemError(v.trim(), existing),
    });
    if (id) await this.openEditor(id.trim(), true);
  }

  /**
   * A new part (a sensor or chip on a bus): its id, name, buses and ID
   * register, optionally wired into a system, then `python -m vhil.part new`
   * in the container writes its model, tests, marker and CI rule
   * (docs/development/adding-a-part.md) and the model and tests open.
   */
  private async newPart() {
    if (this.local) {
      void vscode.window.showInformationMessage(
        "vHIL: a new part goes into the vHIL repository: open your IFS-vHIL checkout to add one.");
      return;
    }
    const title = (step: number) => `vHIL: new part (${step}/5)`;
    const models = path.join(this.repo, "catalog", "models");
    const existing = fs.existsSync(models)
      ? fs.readdirSync(models).filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -5)) : [];
    const id = (await vscode.window.showInputBox({
      title: title(1), prompt: "Its id: catalog/models/<id>.yaml, the chip's part number.",
      placeHolder: "bme280", validateInput: (v) => partIdError(v.trim(), existing),
    }))?.trim();
    if (!id) return;
    const name = (await vscode.window.showInputBox({
      title: title(2), prompt: "What it is, as the docs and the CI rule will name it.",
      placeHolder: "Bosch BME280 pressure sensor", validateInput: (v) => (v.trim() ? undefined : "a name"),
    }))?.trim();
    if (!name) return;
    const picked = await vscode.window.showQuickPick(
      PROTOCOLS.map((p) => ({ label: p.toUpperCase(), protocol: p, picked: p === "i2c" })),
      { title: title(3), placeHolder: "The buses it speaks (a device wires one)", canPickMany: true });
    if (!picked?.length) return;
    const protocols: Protocol[] = picked.map((p) => p.protocol);
    let address: string | undefined;
    if (protocols.includes("i2c")) {
      address = (await vscode.window.showInputBox({
        title: title(4), prompt: "Its 7-bit I2C address (the datasheet's).", value: "0x40",
        validateInput: (v) => addressError(v),
      }))?.trim();
      if (!address) return;
    }
    const whoAmI = await vscode.window.showInputBox({
      title: title(4), prompt: "Its ID register and the value it reads, <register>=<value>; empty: none yet.",
      placeHolder: "0xD0=0x60", validateInput: (v) => whoAmIError(v, protocols),
    });
    if (whoAmI === undefined) return;
    const place = await this.placePart(title(5), protocols);
    if (place === null) return;
    const args = partArgs({ id, name, protocols, address, whoAmI, place });
    const code = await this.task(`New part ${id}`, ["run", "python", "-m", "vhil.part", ...args]);
    if (code !== 0) return;
    for (const [i, rel] of partFiles(id).entries()) {
      const file = path.join(this.repo, rel);
      if (fs.existsSync(file)) {
        await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false, preserveFocus: i > 0 });
      }
    }
    if (place) this.readSystems();
    await this.refresh();
    void vscode.window.showInformationMessage(
      `vHIL: ${id} written. Fill its TODOs from the datasheet; its tests run as generated.`, "The guide")
      .then((a) => a && vscode.env.openExternal(vscode.Uri.file(
        path.join(this.repo, "docs", "development", "adding-a-part.md"))));
  }

  /** Where a new part goes: a system, its board, bus and (on SPI) CS; undefined: nowhere; null: cancelled. */
  private async placePart(title: string, protocols: Protocol[]) {
    const none = { label: "Not now", description: "add it to a system later (devices:)", id: "" };
    const pick = await vscode.window.showQuickPick(
      [none, ...this.systems.map((s) => ({ label: s.id, description: s.boards.map((b) => b.name).join(", "), id: s.id }))],
      { title, placeHolder: "Wire it into a system?" });
    if (!pick) return null;
    if (!pick.id) return undefined;
    const boards = this.systems.find((s) => s.id === pick.id)?.boards ?? [];
    const board = boards.length === 1 ? boards[0].name : (await vscode.window.showQuickPick(
      boards.map((b) => ({ label: b.name, description: b.role ? `${b.board}, ${b.role}` : b.board })),
      { title, placeHolder: "On which board?" }))?.label;
    if (!board) return null;
    const bus = (await vscode.window.showInputBox({
      title, prompt: `The bus of ${board} it is on.`,
      placeHolder: protocols.includes("i2c") ? "I2C2" : protocols.includes("spi") ? "SPI1" : "USART2",
      validateInput: (v) => busError(v, protocols),
    }))?.trim();
    if (!bus) return null;
    let cs: string | undefined;
    if (/^spi/i.test(bus)) {
      cs = (await vscode.window.showInputBox({
        title, prompt: `The pin of ${board} its chip select is on.`, placeHolder: "PA4",
        validateInput: (v) => pinError(v),
      }))?.trim();
      if (!cs) return null;
    }
    return { system: pick.id, board, bus, cs };
  }

  /** A system's scenarios (its group in the Testing panel), as a run from the panel. */
  private async runScenarios(system?: string) {
    const id = system ?? await this.pickSystem("Run the scenarios of which system?", (s) => s.scenarios);
    if (!id) return;
    if (!this.byId.size) await this.refresh();
    const group = this.byId.get(groupId(id));
    if (!group) {
      void vscode.window.showInformationMessage(`vHIL: ${id} has no scenarios in the Testing panel.`);
      return;
    }
    await vscode.commands.executeCommand("workbench.view.testing.focus");
    const cts = new vscode.CancellationTokenSource();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `vHIL: ${id} scenarios`, cancellable: true },
      (_, token) => {
        token.onCancellationRequested(() => cts.cancel());
        return this.run(new vscode.TestRunRequest([group]), cts.token);
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
    if ((await updateCheckout(this.context, this.repo, this.env(), (l) => this.log.appendLine(l))).ok) {
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

/** A VS Code breakpoint as debugStops sees it. */
function bpOf(b: vscode.Breakpoint): Bp {
  if (b instanceof vscode.SourceBreakpoint) return { enabled: b.enabled, kind: "source", path: b.location.uri.fsPath };
  if (b instanceof vscode.FunctionBreakpoint) return { enabled: b.enabled, kind: "function" };
  return { enabled: b.enabled, kind: "other" };
}

/** The system a command was given: a Systems view row, a scenario group, or its id. */
function systemOf(item?: vscode.TestItem | Row | string): string | undefined {
  if (typeof item === "string") return item;
  if (!item) return undefined;
  if ("kind" in item) return item.kind === "system" ? item.label : undefined;
  return item.id.startsWith(GROUP) ? item.id.split("/").pop() : undefined;
}

/**
 * The editor panel's page: the editor framed at `url`, else `message`. With
 * a frame, a nonce'd script relays between the extension and the editor:
 * vhil.open in (open a system without reloading the page), vhil.ready and
 * vhil.openExternal out, only from the framed editor's origin. With no
 * vhil.ready in 15 s it offers the browser (a VS Code build that won't frame it).
 */
function editorHtml(url: string | undefined, message = "", nonce = ""): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const origin = url ? new URL(url).origin : "";
  const csp = `default-src 'none'; style-src 'unsafe-inline'` +
    (origin ? `; frame-src ${origin}; script-src 'nonce-${nonce}'` : "");
  const body = url
    ? `<div id="slow" hidden>Editor not loading here? <button id="browser">Open in browser</button></div>
<iframe src="${esc(url)}" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const frame = document.querySelector("iframe");
const origin = ${JSON.stringify(origin)};
const slow = document.getElementById("slow");
let ready = false;
window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || typeof m !== "object") return;
  if (e.source === frame.contentWindow) {
    if (e.origin !== origin) return;
    if (m.type === "vhil.ready") { ready = true; slow.hidden = true; vscode.postMessage({ type: "vhil.ready" }); }
    else if (m.type === "vhil.openExternal" && typeof m.url === "string") vscode.postMessage({ type: "vhil.openExternal", url: m.url });
    return;
  }
  if (m.type === "vhil.open") frame.contentWindow.postMessage(m, origin);
});
setTimeout(() => { if (!ready) slow.hidden = false; }, 15000);
document.getElementById("browser").addEventListener("click", () => vscode.postMessage({ type: "vhil.openInBrowser" }));
</script>`
    : `<p>${esc(message)}</p>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; display: flex; flex-direction: column; }
iframe { border: 0; width: 100%; flex: 1; display: block; }
#slow { padding: 4px 8px; font-family: var(--vscode-font-family); font-size: 12px;
  color: var(--vscode-foreground); background: var(--vscode-editorWidget-background); }
#slow[hidden] { display: none; }
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
