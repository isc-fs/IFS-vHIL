// The Training page (/training/): a new electrical member's way through a
// puzzle (vhil/server/training.py, training/README.md). One screen: the job
// card and the steps on the left, the car's E/E system in the middle with a
// timeline under it, the instruments on the right.
import { api, loadTrace } from "./trace.js";
import { AMS_STATES, Diagram, INFO } from "./diagram.js";
import { CanTrace, Multimeter, Scope, h, ms, showCard, showLog } from "./instruments.js";

const view = document.getElementById("view");
const TERMINAL = new Set(["passed", "failed", "error", "cancelled"]);
const STATE_TEXT = { queued: "waiting for a worker", building: "building the firmware",
                     running: "running (a real power-on through each bootloader)",
                     passed: "done", failed: "done", error: "the run failed", cancelled: "cancelled" };

let parts = null;
let poll = null;

window.addEventListener("hashchange", route);
route();

async function route() {
  clearInterval(poll);
  const m = /^#\/p\/([a-z0-9-]+)/.exec(location.hash);
  try {
    if (!parts) parts = (await api("/api/training/parts")).data;
    if (m) await puzzlePage(m[1]); else await listPage();
  } catch (e) {
    view.replaceChildren(h("p", { class: "error" }, String(e.message || e)));
  }
}

// -- the list --------------------------------------------------------------------

async function listPage() {
  const { data } = await api("/api/training/puzzles");
  view.replaceChildren(
    h("header", { class: "top" }, h("h1", {}, "vHIL training"),
      h("p", { class: "muted" }, "The whole car, emulated: its boards run the team's real firmware. Each puzzle has one fault seeded into it, in the hardware or the firmware. Find where it is, then fix it.")),
    h("div", { class: "cards" }, ...data.map((p) => h("a", { class: "card", href: `#/p/${p.id}` },
      h("div", { class: "card-tags" },
        h("span", { class: `tag ${p.fault}` }, p.fault === "hardware" ? "Hardware fault" : "Firmware fault"),
        h("span", { class: "tag" }, `Level ${p.level}`),
        p.progress.solved ? h("span", { class: "tag ok" }, "Solved")
          : p.progress.located ? h("span", { class: "tag warn" }, "Located")
          : p.progress.started ? h("span", { class: "tag" }, "Started") : null),
      h("h2", {}, p.title), h("p", {}, p.summary),
      h("div", { class: "topics" }, ...p.topics.map((t) => h("span", { class: "chip" }, t)))))),
    h("p", { class: "small muted foot" }, "Out of scope: analog and physical effects (EMI, noise, soldering). The vHIL models logic, timing, CAN and the measurement chain."));
}

// -- one puzzle -------------------------------------------------------------------

async function puzzlePage(pid) {
  const S = { pid, t: 0, trace: null, runId: null, selected: null, playing: false };
  let { data } = await api(`/api/training/puzzles/${pid}`);
  let P = data.puzzle;
  const signals = (await api(`/api/training/systems/${P.system}/signals`)).data;

  const left = h("aside", { class: "steps" });
  const diagramHost = h("div", { class: "diagram" });
  const timeline = h("div", { class: "timeline" });
  const tabs = h("nav", { class: "tabs", role: "tablist" });
  const panel = h("section", { class: "panel" });
  view.replaceChildren(h("div", { class: "layout" },
    left, h("main", { class: "center" }, diagramHost, timeline), h("aside", { class: "instruments" }, tabs, panel)));

  const dmmHost = h("div"), scopeHost = h("div"), canHost = h("div"), logHost = h("div"),
        infoHost = h("div"), cardHost = h("div");
  const meter = new Multimeter(dmmHost, signals);
  const scope = new Scope(scopeHost, { onPick: (t) => seek(t) });
  const can = new CanTrace(canHost, { onPick: (t) => seek(t) });
  const diagram = new Diagram(diagramHost, {
    onPick: (id) => { S.selected = id; showInfo(); openTab("part"); },
    onProbe: (key) => { meter.probe(key); diagram.probe(key); openTab("meter"); refresh(); },
  });

  const TABS = [["part", "Part", infoHost], ["meter", "Multimeter", dmmHost], ["scope", "Scope", scopeHost],
                ["can", "CAN trace", canHost], ["log", "Log", logHost]];
  if (P.mode === "pytest") TABS.push(["card", "SD card", cardHost]);
  let tab = "part";
  function openTab(id) {
    tab = id;
    for (const b of tabs.children) b.setAttribute("aria-selected", String(b.dataset.tab === id));
    panel.replaceChildren(TABS.find((x) => x[0] === id)[2]);
    if (id === "scope") scope.render();
    refresh();
  }
  tabs.replaceChildren(...TABS.map(([id, name]) => {
    const b = h("button", { role: "tab", onclick: () => openTab(id) }, name);
    b.dataset.tab = id;
    return b;
  }));

  function showInfo() {
    const id = S.selected || "sdc";
    const info = INFO[id] || { title: id, text: "" };
    infoHost.replaceChildren(...[h("h3", {}, info.title), h("p", {}, info.text),
      info.part ? h("button", { class: "secondary", onclick: () => diagnose(info.part) },
        "The fault is here…") : null,
      h("p", { class: "small muted" }, "Click any part of the diagram to read what it does. Click a pin dot to probe it.")]
      .filter(Boolean));
  }

  // -- the steps -------------------------------------------------------------------
  function steps() {
    const pr = data.progress;
    const car = pr.car_run ? pr.runs[pr.car_run] : null;
    const last = pr.check_runs.length ? pr.check_runs[pr.check_runs.length - 1] : null;
    const checks = last ? last.run_ids.map((i) => pr.runs[i]?.state || "queued") : [];
    const step = (n, title, done, ...body) => h("section", { class: `step ${done ? "done" : ""}` },
      h("h3", {}, h("span", { class: "n" }, done ? "✓" : String(n)), title), ...body);
    left.replaceChildren(...[
      h("a", { href: "#/", class: "small" }, "← all puzzles"),
      h("h2", {}, P.title),
      h("div", { class: "card-tags" }, h("span", { class: `tag ${P.fault}` }, P.fault === "hardware" ? "Hardware fault" : "Firmware fault"),
        h("span", { class: "tag" }, `Level ${P.level}`)),
      h("div", { class: "brief" }, ...markdown(P.brief)),
      step(1, "Run your car", !!car && TERMINAL.has(car.state),
        car ? h("p", { class: "small" }, `Run ${pr.car_run}: ${STATE_TEXT[car.state] || car.state}`) : null,
        h("button", { onclick: start, disabled: car && !TERMINAL.has(car.state) }, car ? "Run it again" : "Power on the car")),
      step(2, "Investigate", pr.located,
        h("p", { class: "small" }, "Scrub the timeline. Watch which part changes first. Probe pins, scope signals, read the CAN trace."),
        P.hints.length ? h("ol", { class: "hints" }, ...P.hints.map((x) => h("li", {}, x))) : null,
        P.hints.length < P.hints_total ? h("button", { class: "secondary", onclick: hint },
          `Hint ${P.hints.length + 1} of ${P.hints_total}`) : null),
      step(3, "Name the fault's location", pr.located,
        h("p", { class: "small" }, pr.located ? "Located." : `A repair is only accepted where the fault is. Attempts so far: ${pr.attempts.length}.`),
        pr.located ? null : h("button", { onclick: () => diagnose(INFO[S.selected]?.part) }, "Diagnose…")),
      step(4, P.fault === "hardware" ? "Repair it" : "Fix the firmware", pr.solved,
        pr.solved ? null
          : !pr.located ? h("p", { class: "small muted" }, "Locked until the location is right.")
          : P.fault === "hardware"
            ? h("button", { onclick: () => check(null), disabled: checks.some((s) => !TERMINAL.has(s)) },
                "Replace the part and run the check")
            : fixForm(),
        last ? h("p", { class: "small" }, "Check: ", ...last.run_ids.map((i, k) => h("a", {
          href: `/editor/?run=${i}`, target: "_blank", rel: "noopener", class: `state ${checks[k]}` }, `run ${i} ${checks[k]}  `))) : null),
      pr.solved ? h("section", { class: "step done solved" }, h("h3", {}, "Solved"),
        h("p", {}, P.answer?.explain || ""), P.fix_note ? h("p", { class: "small" }, P.fix_note) : null,
        Object.keys(P.fix || {}).length ? h("p", { class: "small" }, "The team's fix: ",
          ...Object.entries(P.fix).map(([b, r]) => `${b} ${r.slice(0, 12)} `)) : null,
        h("ul", { class: "small" }, ...(P.sources || []).map((s) => h("li", {}, s)))) : null,
    ].filter(Boolean));
  }

  function fixForm() {
    const input = h("input", { placeholder: "your branch or commit, e.g. fix/heartbeat", "aria-label": "Firmware ref" });
    return h("div", { class: "fix" },
      h("p", { class: "small" }, `Fix it in the ${P.answer?.board?.toUpperCase() || "board"}'s firmware repository, push a branch, and check it here. The check builds that ref and runs the grading tests.`),
      input, h("button", { onclick: () => check(input.value.trim()) }, "Check my fix"));
  }

  async function reload() {
    data = (await api(`/api/training/puzzles/${pid}`)).data;
    P = data.puzzle;
    steps();
    const pr = data.progress;
    const car = pr.car_run ? pr.runs[pr.car_run] : null;
    if (car && TERMINAL.has(car.state) && S.runId !== pr.car_run) await loadRun(pr.car_run);
    const pending = (car && !TERMINAL.has(car.state))
      || pr.check_runs.slice(-1).some((c) => c.run_ids.some((i) => !TERMINAL.has(pr.runs[i]?.state)));
    clearInterval(poll);
    if (pending) poll = setInterval(() => reload().catch(() => {}), 3000);
  }

  async function start() {
    await api(`/api/training/puzzles/${pid}/start`, { method: "POST" });
    S.runId = null;
    await reload();
  }

  async function hint() {
    await api(`/api/training/puzzles/${pid}/hint`, { method: "POST" });
    await reload();
  }

  async function check(ref) {
    try {
      await api(`/api/training/puzzles/${pid}/check`, { method: "POST", body: { fix_ref: ref } });
    } catch (e) { alert(e.message); }
    await reload();
  }

  // -- diagnosis ---------------------------------------------------------------------
  function diagnose(prefill) {
    const dlg = h("dialog", { class: "diag" });
    const partSel = h("select", { "aria-label": "Part" },
      h("option", { value: "", selected: !prefill }, "Choose a part…"),
      ...Object.entries(parts.parts).map(([id, p]) => h("option", { value: id, selected: id === prefill }, `${p.label} — ${p.where}`)));
    const fields = h("div", { class: "fields" });
    const msg = h("p", { class: "small" });
    const render = () => {
      const p = parts.parts[partSel.value] || { fields: {} };
      const kept = Object.fromEntries([...fields.querySelectorAll("[name]")].map((i) => [i.name, i.value]));
      fields.replaceChildren(...Object.entries(p.fields).map(([name, spec]) => {
        let input;
        if (name === "module" && partSel.value === "firmware") {
          input = h("select", { name }, ...((parts.firmware_modules[kept.board || "ecu"]) || [])
            .map((m) => h("option", { value: m }, m.replaceAll("_", " "))));
        } else if (Array.isArray(spec) && typeof spec[0] === "number") {
          input = h("input", { name, type: "number", min: spec[0], max: spec[1], required: true });
        } else if (Array.isArray(spec)) {
          input = h("select", { name, onchange: render }, ...spec.map((x) => h("option", { value: x }, x.toUpperCase())));
        } else {
          input = h("input", { name });
        }
        return h("label", {}, name.replace("_", " "), input);
      }));
      for (const i of fields.querySelectorAll("[name]")) {
        if (kept[i.name] !== undefined && [...(i.options || [{ value: kept[i.name] }])].some((o) => o.value === kept[i.name])) i.value = kept[i.name];
      }
    };
    partSel.addEventListener("change", render);
    render();
    const submit = async () => {
      if (!partSel.value) { msg.textContent = "Choose a part first."; msg.className = "small bad"; return; }
      const loc = { part: partSel.value };
      for (const i of fields.querySelectorAll("[name]")) loc[i.name] = i.type === "number" ? Number(i.value) : i.value;
      try {
        const { data: r } = await api(`/api/training/puzzles/${pid}/diagnose`, { method: "POST", body: { location: loc } });
        if (r.correct) { dlg.close(); dlg.remove(); await reload(); return; }
        msg.textContent = `Not there (attempt ${r.attempts}). Go back to the instruments: what does the evidence point at?`;
        msg.className = "small bad";
        reload().catch(() => {});
      } catch (e) { msg.textContent = e.message; msg.className = "small bad"; }
    };
    dlg.append(h("h3", {}, "Where is the fault?"),
      h("p", { class: "small muted" }, "Name the part and its position. Every attempt is counted."),
      h("label", {}, "Part", partSel), fields, msg,
      h("div", { class: "row" }, h("button", { onclick: submit }, "This is the fault"),
        h("button", { class: "secondary", onclick: () => { dlg.close(); dlg.remove(); } }, "Back")));
    document.body.append(dlg);
    dlg.showModal();
  }

  // -- the run and the timeline -----------------------------------------------------
  async function loadRun(runId) {
    S.runId = runId;
    if (P.mode === "pytest") {
      try {
        const { data: card } = await api(`/api/runs/${runId}/artifacts/sim-logs/card.json`);
        showCard(cardHost, card);
      } catch { showCard(cardHost, null); }
    }
    S.trace = await loadTrace(runId);
    let contract = null;
    try { contract = (await api(`/api/runs/${runId}/contract`)).data; } catch { /* no contract */ }
    scope.setTrace(S.trace);
    can.setTrace(S.trace, contract);
    drawTimeline();
    seek(Math.min(S.trace.end, firstTrouble() ?? S.trace.end));
  }

  // Where the story is: the first time the AMS errors or the SDC opens in Run.
  function firstTrouble() {
    const err = S.trace.changes("symbol:ams.g_state_telemetry").find(([, v]) => v === 5);
    return err ? Math.max(0, err[0] - 1_500_000) : null;
  }

  function drawTimeline() {
    const end = S.trace.end || 1;
    const range = h("input", { type: "range", min: 0, max: end, step: 1000, value: 0, "aria-label": "Virtual time",
                               oninput: (e) => seek(Number(e.target.value), false) });
    const play = h("button", { class: "secondary", onclick: () => toggle() }, "▶ Play");
    const time = h("span", { class: "mono" }, "0.0 ms");
    const marks = h("div", { class: "marks" });
    const lastIn = {};
    const mark = (t, text, cls, row) => {
      // Marks closer than 4 % of the run share one label: "Precharge → Run".
      const prev = lastIn[row];
      if (prev && (t - prev.t) / end < 0.04) {
        prev.el.textContent = `${prev.el.textContent} → ${text}`;
        prev.el.className = `mark ${cls} row${row}`;
        prev.el.title = `${prev.el.title}; ${text} at ${ms(t)}`;
        return;
      }
      const m = h("button", { class: `mark ${cls} row${row}`, title: `${text} at ${ms(t)}`, onclick: () => seek(t) }, text);
      m.dataset.left = String(100 * t / end);
      marks.append(m);
      lastIn[row] = { t, el: m };
    };
    for (const [t, v] of S.trace.changes("symbol:ams.g_state_telemetry")) {
      mark(t, AMS_STATES[v] || `AMS state ${v}`, v === 5 ? "bad" : v === 3 ? "good" : "", 1);
    }
    for (const [t, v] of S.trace.changes("plant:sdc.sdc_closed")) mark(t, v ? "SDC closed" : "SDC open", v ? "good" : "bad", 2);
    timeline.replaceChildren(h("div", { class: "row" }, play, range, time), marks,
      h("p", { class: "small muted" }, "Virtual time from power-on. The markers are what the AMS and the shutdown circuit did."));
    for (const m of marks.children) m.style.left = `${m.dataset.left}%`;
    S.range = range; S.time = time; S.play = play;
  }

  function toggle() {
    S.playing = !S.playing;
    S.play.textContent = S.playing ? "❚❚ Pause" : "▶ Play";
    if (!S.playing) return;
    let last = performance.now();
    const step = (now) => {
      if (!S.playing) return;
      const dt = (now - last) * 1000;            // 1 s of virtual time per second
      last = now;
      const t = S.t + dt;
      if (t >= S.trace.end) { seek(S.trace.end); toggle(); return; }
      seek(t);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function seek(t, moveRange = true) {
    S.t = Math.max(0, Math.round(t));
    if (S.range && moveRange) S.range.value = String(S.t);
    if (S.time) S.time.textContent = ms(S.t);
    refresh();
  }

  function refresh() {
    diagram.show(S.trace, S.t);
    if (tab === "meter") meter.show(S.trace, S.t);
    if (tab === "can") can.render(S.t);
    if (tab === "log") showLog(logHost, S.trace, S.t);
    if (tab === "scope") scope.marker(S.t);
  }

  showInfo();
  openTab("part");
  await reload();
}

// The brief's few marks: paragraphs and **bold**.
function markdown(text) {
  return String(text || "").split(/\n\s*\n/).map((para) => {
    const p = h("p");
    para.split(/(\*\*[^*]+\*\*)/).forEach((bit) => {
      if (bit.startsWith("**")) p.append(h("strong", {}, bit.slice(2, -2))); else p.append(bit);
    });
    return p;
  });
}
