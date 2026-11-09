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
  $("#version").textContent = `app ${info.version} · ${info.workspace_ref}`;

  // 1. Tools
  const missing = ["git", "docker"].filter((k) => !t[k]);
  if (t.mac && !t.colima) missing.push("colima");
  if (missing.length === 0) {
    step("tools", "ok", "Git, Docker" + (t.mac ? " and Colima are installed." : " are installed."));
  } else if (t.brew) {
    step("tools", "fail", `Missing: ${missing.join(", ")}.`, [
      { label: "Install with Homebrew", task: "tools" },
    ]);
  } else {
    step("tools", "fail", `Missing: ${missing.join(", ")}. Install Homebrew (brew.sh), then reopen the app.`);
  }
  const toolsOk = missing.length === 0;

  // 2. Workspace
  const where = info.workspace;
  if (!info.present) {
    step("workspace", "fail", info.managed ? "Not downloaded yet (about 25 MB)." : `${where} has no bin/vhil.`,
      info.managed && t.git ? [{ label: "Download", task: "workspace" }] : []);
  } else {
    step("workspace", "ok", info.managed ? `The app's copy, at ${info.workspace_ref}: ${where}` : `Your clone: ${where}`,
      info.managed ? [{ label: "Update", task: "workspace" }] : []);
  }

  // 3. VM (macOS) and 4. images + firmware: from `vhil doctor`
  $("#step-vm").hidden = !t.mac;
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
    step("vm", vmLevel, vmLevel === "ok" ? "Running." : vm.find((c) => c.level !== "ok")?.message || "",
      vmLevel === "ok" ? [] : [{ label: "Start", task: "vm" }]);
    const rest = checksOf((m) => !isVm(m));
    const level = vmLevel === "ok" ? worst(rest) : "";
    step("setup", level, level === "ok" ? "Ready." : "Pulls the images and builds the firmware (~15 min the first time).",
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
  if (!info.managed && !$("#ws").value) $("#ws").value = where;

  if (ready && !fwMissing && !stay && !autoOpened && !running) {
    autoOpened = true;
    openApp();
  }
}

async function refresh() {
  info = await invoke("info");
  doctor = null;
  render();
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

async function checkUpdate() {
  const tag = await invoke("latest_release");
  if (!tag || tag === `v${info.version}`) return;
  const b = $("#update");
  b.replaceChildren(`A newer vHIL app is out: ${tag}. `);
  const btn = document.createElement("button");
  btn.textContent = "Download";
  btn.onclick = () => invoke("open_release", { tag });
  b.append(btn);
  b.hidden = false;
}

refresh().then(checkUpdate);
