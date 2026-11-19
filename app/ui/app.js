// The set-up page: walks a teammate from nothing to the vHIL running, through
// the app's commands (src-tauri/src/main.rs), each a `bin/vhil` command.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (sel) => document.querySelector(sel);
// Arriving from the menu (Set-up and Status) never jumps straight back to the app.
const stay = new URLSearchParams(location.search).has("stay");
let info = null;
let doctor = null;
let running = null; // the task in progress
let autoOpened = false;
// Your own clone against GitHub (main.rs clone_status): undefined while it
// is fetched, null when git can't tell (or the app's own copy).
let clone;

function step(id, level, detail, actions = []) {
  const li = $(`#step-${id}`);
  li.className = running && actions.some((a) => a.task === running) ? "busy" : level;
  li.querySelector(".detail").textContent = detail;
  const box = li.querySelector(".actions");
  box.replaceChildren(
    ...actions.map((a) => {
      const b = document.createElement("button");
      b.textContent = a.label;
      b.disabled = Boolean(running);
      b.onclick = a.run || (() => runTask(a.task));
      return b;
    }),
  );
}

function checksOf(pred) {
  return (doctor?.checks || []).filter((c) => pred(c.message));
}
const isVm = (m) => /Colima VM|Docker reachable|docker CLI/.test(m);
const worst = (cs) =>
  cs.some((c) => c.level === "fail") ? "fail" : cs.some((c) => c.level === "warn") ? "warn" : "ok";

function render() {
  const t = info.tools;
  const mac = info.platform === "macos";
  const win = info.platform === "windows";
  $("#version").textContent = `app ${info.version} · ${info.workspace_ref}`;

  // 1. Tools. macOS: Homebrew installs them. Linux: the distribution's
  // packages. Windows: WSL2, with Docker Desktop's WSL integration.
  const missing = ["git", "docker"].filter((k) => !t[k]);
  if (mac && !t.colima) missing.push("colima");
  const inWsl = win ? " in WSL" : "";
  if (win && !t.wsl) {
    step("tools", "fail",
      "WSL isn't set up. In an administrator terminal run `wsl --install -d Ubuntu`, restart, open Ubuntu once to create your user, then reopen the app.");
  } else if (missing.length === 0) {
    step("tools", "ok", `Git and Docker${mac ? " (Colima)" : ""} are installed${inWsl}.`);
  } else if (mac && t.brew) {
    step("tools", "fail", `Missing: ${missing.join(", ")}.`, [
      { label: "Install with Homebrew", task: "tools" },
    ]);
  } else if (mac) {
    step("tools", "fail", `Missing: ${missing.join(", ")}. Install Homebrew (brew.sh), then reopen the app.`);
  } else if (win) {
    step("tools", "fail",
      `Missing in WSL: ${missing.join(", ")}. Docker: install Docker Desktop and turn on Settings → Resources → WSL integration for your distribution. Git: \`sudo apt install git\` in WSL. Then reopen the app.`);
  } else {
    step("tools", "fail",
      `Missing: ${missing.join(", ")}. Install them with your package manager (Docker Engine: docs.docker.com/engine/install), add yourself to the docker group, log out and in, then reopen the app.`);
  }
  const toolsOk = (!win || t.wsl) && missing.length === 0;

  // 2. Workspace
  const where = info.workspace || "";
  if (!info.present) {
    step("workspace", "fail", info.managed ? "Not downloaded yet (about 25 MB)." : `${where} has no bin/vhil.`,
      info.managed && t.git ? [{ label: "Download", task: "workspace" }] : []);
  } else if (info.managed) {
    step("workspace", info.synced ? "ok" : "warn",
      info.synced ? `The app's copy, at ${info.workspace_ref}: ${where}` : `The app's copy needs moving to ${info.workspace_ref}.`,
      [{ label: "Update", task: "workspace" }]);
  } else {
    const [level, detail, actions] = cloneStep(where);
    step("workspace", level, detail, actions);
  }

  // 3. VM (macOS) and 4. images + firmware: from `vhil doctor`
  $("#step-vm h2").textContent = mac ? "Docker VM" : "Docker";
  if (!toolsOk || !info.present) {
    step("vm", "", "After the tools and files.");
    step("setup", "", "After the VM.");
    $("#step-setup .checks").replaceChildren();
  } else if (!doctor) {
    step("vm", "busy", "Checking…");
    step("setup", "busy", "Checking…");
  } else {
    const vm = checksOf(isVm);
    const vmLevel = worst(vm);
    const down = vm.find((c) => c.level !== "ok")?.message || "";
    const hint = mac ? "" : win ? " Start Docker Desktop, then Check again." : " Start it (sudo systemctl start docker), then Check again.";
    step("vm", vmLevel, vmLevel === "ok" ? "Running." : down + hint,
      vmLevel === "ok" ? [] : mac ? [{ label: "Start", task: "vm" }] : [{ label: "Check again", run: refresh }]);
    const rest = checksOf((m) => !isVm(m));
    const level = vmLevel === "ok" ? worst(rest) : "";
    step("setup", level, level === "ok" ? "Ready." : "Pulls the images and builds the firmware: ~15 min the first time; ~30 min more if no published image fits and it builds them.",
      vmLevel === "ok" ? [{ label: level === "ok" ? "Run again" : "Run set-up", task: "setup" }] : []);
    $("#step-setup .checks").replaceChildren(
      ...rest.map((c) => {
        const li = document.createElement("li");
        li.className = `lvl-${c.level}`;
        li.textContent = c.message;
        return li;
      }),
    );
  }

  const ready = Boolean(doctor?.ok) && toolsOk && info.present && !checksOf(() => true).some((c) => c.level === "fail");
  const fwMissing = checksOf((m) => /no firmware built/.test(m)).length > 0;
  $("#open").disabled = !ready || Boolean(running) || fwMissing;
  $("#ws").placeholder = info.managed ? where : "";
  $("#ws-label").textContent = win
    ? "Use your own clone, as a path in WSL (empty: the app's own copy)"
    : "Use your own clone of the repository (empty: the app's own copy)";
  if (!info.managed && !$("#ws").value) $("#ws").value = where;

  // Sign in is a task too: one at a time (main.rs `busy`).
  $("#account-btn").disabled = Boolean(running);

  // Your clone behind GitHub: stay here, so the warning is seen (Open still works).
  const cloneSettled = info.managed || (clone !== undefined && !cloneAttention());
  if (ready && !fwMissing && !stay && !autoOpened && !running && cloneSettled) {
    autoOpened = true;
    openApp();
  }
}

/** Whether your clone wants a look: behind its upstream, or merged into dev. */
function cloneAttention() {
  return Boolean(clone && (clone.behind > 0 || clone.merged > 0));
}

/** The "vHIL files" step for your own clone: [level, detail, actions]. */
function cloneStep(where) {
  const head = `Your clone: ${where}`;
  if (clone === undefined) return ["ok", `${head} (checking GitHub…)`, []];
  if (!clone) return ["ok", head, []];
  const b = clone.branch;
  const offline = clone.fetched ? "" : " (GitHub didn't answer: as of the last fetch)";
  const n = (k) => `${k} commit${k === 1 ? "" : "s"}`;
  if (clone.merged > 0) {
    // Everything on the branch is in dev already: dev is the place to be.
    return ["warn",
      `${head}. ${b} is already in ${clone.base}, which is ${n(clone.merged)} ahead${offline}. ` +
        "The vHIL runs the code of the branch you're on." +
        (clone.dirty ? " Commit or stash your changes to switch." : ""),
      clone.dirty ? [] : [{ label: `Switch to ${clone.base}`, task: "switch-clone" }]];
  }
  if (clone.behind > 0 && clone.ahead > 0) {
    return ["warn",
      `${head}. ${b} and ${clone.upstream} have both moved on (${clone.ahead} ahead, ${clone.behind} behind)${offline}: merge or rebase it with git.`, []];
  }
  if (clone.behind > 0) {
    return ["warn", `${head}. ${b} is ${n(clone.behind)} behind ${clone.upstream}${offline}.`,
      [{ label: "Update", task: "update-clone" }]];
  }
  return ["ok", `${head}, on ${b}${clone.upstream ? `, up to date with ${clone.upstream}` : ""}${offline}.`, []];
}

async function refresh() {
  info = await invoke("info");
  doctor = null;
  clone = info.managed ? null : undefined;
  render();
  if (!info.managed && info.present) {
    invoke("clone_status").then((c) => { clone = c ?? null; }, () => { clone = null; }).then(render);
  } else {
    clone = null;
  }
  if (info.present && info.tools.docker) {
    try {
      doctor = await invoke("doctor");
    } catch (e) {
      doctor = { ok: false, checks: [{ level: "fail", message: String(e) }] };
    }
    render();
    // Later launches: the VM is often stopped. Start it without asking.
    const vmDown = checksOf((m) => /Colima VM .* not running/.test(m)).length > 0;
    if (vmDown && !stay && !running && !autoOpened) {
      autoOpened = true;
      runTask("vm");
    }
  }
}

async function runTask(task) {
  try {
    running = task;
    $("#log").textContent = "";
    $("#log-task").textContent = `(${task})`;
    $("#log-box").open = true;
    render();
    await invoke("run", { task });
  } catch (e) {
    running = null;
    log(`error: ${e}`);
    render();
  }
}

async function openApp() {
  running = "ui";
  $("#open-status").textContent = "Starting the app's containers…";
  $("#log-task").textContent = "(ui)";
  render();
  try {
    await invoke("open_app");
  } catch (e) {
    running = null;
    $("#open-status").textContent = String(e);
    render();
  }
}

function log(line) {
  const pre = $("#log");
  const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  pre.textContent += line + "\n";
  if (atEnd) pre.scrollTop = pre.scrollHeight;
}

listen("log", (e) => log(e.payload.line));
listen("done", (e) => {
  const { task, code } = e.payload;
  running = null;
  if (task === "ui") {
    $("#open-status").textContent =
      code === 0 ? "" : code === 2 ? "The app didn't answer within 5 minutes: see Output." : "The app stopped: see Output.";
    if (code !== 0) $("#log-box").open = true;
    render();
    return;
  }
  log(code === 0 ? `— ${task}: done` : `— ${task}: failed (exit ${code})`);
  refresh();
});

// Team sharing: the GitHub account the team store shares as (`vhil login`,
// GitHub's device flow). Signing in prints the code to enter on GitHub.
let login = null;
async function refreshAccount() {
  login = await invoke("account").catch(() => null);
  $("#account-status").textContent = login
    ? `Signed in as ${login}: systems and tests you commit in the editor are shared with the team (its Team view).`
    : "Sign in to share the systems and tests you make with the team. Teammates' work opens without it.";
  $("#account-btn").textContent = login ? "Sign out" : "Sign in with GitHub";
}
$("#account-btn").onclick = () => runTask(login ? "logout" : "login");
listen("log", (e) => {
  const m = /^Open (\S+) and enter (\S+)$/.exec(e.payload.line);
  if (!m) return;
  const p = $("#account-code");
  p.replaceChildren(`Enter ${m[2]} on GitHub (copied). `);
  const btn = document.createElement("button");
  btn.textContent = "Open GitHub";
  btn.onclick = () => invoke("open_device_page");
  p.append(btn);
  p.hidden = false;
  navigator.clipboard?.writeText(m[2]).catch(() => {});
  invoke("open_device_page").catch(() => {});
});
listen("done", (e) => {
  if (e.payload.task !== "login" && e.payload.task !== "logout") return;
  $("#account-code").hidden = true;
  refreshAccount();
  if (e.payload.code !== 0 && e.payload.task === "login") {
    $("#account-status").textContent = "Sign-in failed: see Output.";
  }
  // A running vHIL reads the account live (vhil/server/account.py): no restart.
});

$("#open").onclick = openApp;
$("#ws-save").onclick = async () => {
  try {
    await invoke("set_workspace", { path: $("#ws").value || null });
    refresh();
  } catch (e) {
    $("#cli-status").textContent = String(e);
  }
};
$("#cli").onclick = async () => {
  try {
    $("#cli-status").textContent = await invoke("install_cli");
  } catch (e) {
    $("#cli-status").textContent = String(e);
  }
};

// A newer app on the team's update channel: install it in place. The
// download is checked against the signing key built into the app.
async function checkUpdate() {
  const up = await invoke("check_update");
  if (!up) return;
  const b = $("#update");
  b.replaceChildren(`vHIL ${up.version} is out (you have ${info.version}). `);
  const btn = document.createElement("button");
  btn.textContent = "Install and restart";
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Installing…";
    try {
      await invoke("install_update");
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Install and restart";
      b.append(` ${e}`);
    }
  };
  b.append(btn);
  b.hidden = false;
}

// After an update the app's own copy moves to the new release first.
async function start() {
  await refresh();
  refreshAccount();
  // The menu's Sign in / Sign Out (main.rs show_setup_for).
  const account = new URLSearchParams(location.search).get("account");
  if ((account === "login" || account === "logout") && !running) {
    history.replaceState(null, "", location.pathname + "?stay=1");
    runTask(account);
    return;
  }
  if (info.managed && info.present && !info.synced && !running) runTask("workspace");
  checkUpdate();
}

start();
