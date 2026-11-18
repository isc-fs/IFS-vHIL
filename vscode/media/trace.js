// The vHIL Trace panel (src/tracePanel.ts): one test's bus trace
// (docs/test-trace.md) as lanes on virtual time and a filterable list.
// Drag on the lanes to zoom, double-click to zoom out, click a row for its
// signals. No dependencies; colours from VS Code's theme.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const ROW = 20;
  const LANE = 16;
  const LEFT = 150;

  let records = [];   // timed records (can, gpio, radio), by time
  let uart = [];
  let lanes = [];     // [{key, label}]
  let fail = [];      // snapshot times (us)
  let end = 1;
  let range = [0, 1];
  let shown = [];     // records in range and filter
  let picked = -1;
  let drag = null;

  const hex = (n) => "0x" + n.toString(16).toUpperCase().padStart(3, "0");
  const sec = (us) => (us / 1e6).toFixed(6);
  const multi = () => new Set(records.map((r) => r.sim)).size > 1;

  function laneOf(r, many) {
    const p = many ? r.sim + " " : "";
    if (r.kind === "can") return { key: "can:" + r.sim + ":" + r.bus, label: p + r.bus };
    if (r.kind === "gpio") {
      const pin = String(r.pin).replace(/^sysbus\.gpioPort/, "P").replace(":", "");
      return { key: "gpio:" + r.sim + ":" + r.board + ":" + r.pin, label: p + r.board + " " + pin };
    }
    if (r.kind === "radio") return { key: "radio:" + r.sim + ":" + r.device, label: p + r.device };
    return { key: "other", label: "other" };
  }

  function what(r) {
    if (r.kind === "can") {
      const id = hex(r.id);
      return { id, name: r.name || "", data: r.remote ? "remote" : r.data.toUpperCase(),
               note: r.outcome !== "ok" ? r.outcome : (r.sender || "") };
    }
    if (r.kind === "gpio") return { id: "", name: r.level ? "high" : "low", data: "", note: "" };
    if (r.kind === "radio") return { id: "", name: "payload", data: r.data.toUpperCase(), note: r.board || "" };
    return { id: "", name: r.kind, data: "", note: "" };
  }

  function load(msg) {
    const all = msg.records || [];
    const meta = all.find((r) => r.kind === "meta") || {};
    records = all.filter((r) => typeof r.t_us === "number" && ["can", "gpio", "radio"].includes(r.kind))
      .sort((a, b) => a.t_us - b.t_us);
    uart = all.filter((r) => r.kind === "uart");
    fail = all.filter((r) => r.kind === "snapshot" && typeof r.time_us === "number").map((r) => r.time_us);
    const errors = all.filter((r) => r.kind === "error");
    end = Math.max(meta.end_us || 0, records.length ? records[records.length - 1].t_us : 0, 1);
    range = [0, end];
    const many = multi();
    const seen = new Map();
    for (const r of records) {
      const l = laneOf(r, many);
      r._lane = l.key;
      if (!seen.has(l.key)) seen.set(l.key, l);
    }
    lanes = [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
    $("title").textContent = msg.title || meta.test || "";
    $("outcome").textContent = meta.outcome || "";
    $("outcome").className = "outcome " + (meta.outcome || "");
    $("empty").style.display = records.length || uart.length ? "none" : "block";
    $("errors").textContent = errors.map((e) => e.what + ": " + e.message).join("\n");
    $("uart").style.display = uart.length ? "block" : "none";
    $("uart-count").textContent = uart.length + " lines";
    $("uart-lines").textContent = uart.map((u) => u.board + "." + u.uart + "  " + u.line).join("\n");
    picked = -1;
    $("detail").textContent = "";
    apply();
    // The failure in view: the last 2 s before it.
    if (fail.length) zoom(Math.max(0, fail[0] - 2e6), Math.min(end, fail[0] + 2e5));
  }

  function matches(r, tokens) {
    if (!tokens.length) return true;
    const w = what(r);
    const hay = [r.bus, r.board, r.device, r.sim, r.pin, w.id, w.name, w.data, w.note,
                 r.signals ? Object.keys(r.signals).join(" ") : ""].join(" ").toLowerCase();
    return tokens.every((t) => hay.includes(t));
  }

  function apply() {
    const tokens = $("filter").value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = records.filter((r) => r.t_us >= range[0] && r.t_us <= range[1] && matches(r, tokens));
    $("count").textContent = shown.length + " of " + records.length;
    $("span").textContent = sec(range[0]) + " – " + sec(range[1]) + " s";
    draw();
    table();
  }

  function zoom(a, b) {
    if (b - a < 50) return;
    range = [a, b];
    apply();
  }

  // -- lanes ------------------------------------------------------------------

  function css(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }

  function draw() {
    const c = $("lanes");
    const w = c.clientWidth;
    const h = Math.max(lanes.length, 1) * LANE + 18;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr;
    c.height = h * dpr;
    c.style.height = h + "px";
    const g = c.getContext("2d");
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const fg = css("--vscode-foreground") || "#ccc";
    const dim = css("--vscode-descriptionForeground") || "#888";
    const ok = css("--vscode-charts-blue") || "#3794ff";
    const bad = css("--vscode-charts-red") || "#f14c4c";
    const plot = w - LEFT - 8;
    const x = (t) => LEFT + ((t - range[0]) / (range[1] - range[0])) * plot;
    g.font = "11px " + (css("--vscode-font-family") || "sans-serif");
    const tokens = $("filter").value.toLowerCase().split(/\s+/).filter(Boolean);
    lanes.forEach((l, i) => {
      const y = i * LANE;
      g.fillStyle = dim;
      g.fillText(l.label, 4, y + 12);
      g.fillStyle = css("--vscode-editorWidget-border") || "#444";
      g.fillRect(LEFT, y + LANE - 1, plot, 1);
    });
    // One tick per pixel column and lane: thousands of frames stay cheap.
    const cols = new Map();
    for (const r of records) {
      if (r.t_us < range[0] || r.t_us > range[1]) continue;
      const li = lanes.findIndex((l) => l.key === r._lane);
      const px = Math.round(x(r.t_us));
      const key = li * 100000 + px;
      const hit = matches(r, tokens);
      const prev = cols.get(key) || 0;
      cols.set(key, Math.max(prev, r.kind === "can" && r.outcome !== "ok" ? 3 : hit ? 2 : 1));
    }
    for (const [key, v] of cols) {
      const li = Math.floor(key / 100000);
      const px = key % 100000;
      g.fillStyle = v === 3 ? bad : v === 2 ? ok : dim;
      g.globalAlpha = v === 1 ? 0.35 : 1;
      g.fillRect(px, li * LANE + 3, 1, LANE - 6);
    }
    g.globalAlpha = 1;
    for (const t of fail) {
      if (t < range[0] || t > range[1]) continue;
      g.fillStyle = bad;
      g.fillRect(Math.round(x(t)), 0, 2, lanes.length * LANE);
    }
    if (picked >= 0 && shown[picked]) {
      g.fillStyle = fg;
      g.fillRect(Math.round(x(shown[picked].t_us)), 0, 1, lanes.length * LANE);
    }
    if (drag) {
      g.fillStyle = ok;
      g.globalAlpha = 0.2;
      g.fillRect(Math.min(drag.a, drag.b), 0, Math.abs(drag.b - drag.a), lanes.length * LANE);
      g.globalAlpha = 1;
    }
    g.fillStyle = dim;
    const axis = lanes.length * LANE + 13;
    for (let k = 0; k <= 4; k++) {
      const t = range[0] + ((range[1] - range[0]) * k) / 4;
      const label = sec(t);
      const tx = Math.min(x(t), w - g.measureText(label).width - 2);
      g.fillText(label, tx, axis);
    }
  }

  function timeAt(px) {
    const plot = $("lanes").clientWidth - LEFT - 8;
    return range[0] + ((px - LEFT) / plot) * (range[1] - range[0]);
  }

  $("lanes").addEventListener("mousedown", (e) => {
    if (e.offsetX < LEFT) return;
    drag = { a: e.offsetX, b: e.offsetX };
  });
  $("lanes").addEventListener("mousemove", (e) => {
    if (e.offsetX >= LEFT) $("lanes").title = sec(timeAt(e.offsetX)) + " s";
    if (!drag) return;
    drag.b = e.offsetX;
    draw();
  });
  window.addEventListener("mouseup", () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (Math.abs(d.b - d.a) > 4) {
      zoom(Math.max(0, timeAt(Math.min(d.a, d.b))), Math.min(end, timeAt(Math.max(d.a, d.b))));
    } else {
      // A click: the row nearest that time.
      const t = timeAt(d.a);
      let i = shown.findIndex((r) => r.t_us >= t);
      if (i < 0) i = shown.length - 1;
      pick(i, true);
    }
  });
  $("lanes").addEventListener("dblclick", () => zoom(0, end));
  $("reset").addEventListener("click", () => zoom(0, end));
  $("to-fail").addEventListener("click", () => {
    if (fail.length) zoom(Math.max(0, fail[0] - 2e6), Math.min(end, fail[0] + 2e5));
  });

  // -- the list -----------------------------------------------------------------

  function table() {
    const box = $("rows");
    $("spacer").style.height = shown.length * ROW + "px";
    const top = box.scrollTop;
    const first = Math.max(0, Math.floor(top / ROW) - 5);
    const last = Math.min(shown.length, first + Math.ceil(box.clientHeight / ROW) + 10);
    const html = [];
    for (let i = first; i < last; i++) {
      const r = shown[i];
      const w = what(r);
      const lane = lanes.find((l) => l.key === r._lane);
      const cls = "row" + (i === picked ? " picked" : "") + (r.kind === "can" && r.outcome !== "ok" ? " bad" : "");
      html.push(`<div class="${cls}" data-i="${i}" style="top:${i * ROW}px">` +
        `<span class="t">${sec(r.t_us)}</span><span class="lane">${esc(lane ? lane.label : "")}</span>` +
        `<span class="id">${esc(w.id)}</span><span class="name">${esc(w.name)}</span>` +
        `<span class="data">${esc(w.data)}</span><span class="note">${esc(w.note)}</span></div>`);
    }
    $("view").innerHTML = html.join("");
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => "&#" + c.charCodeAt(0) + ";");
  }

  function pick(i, scroll) {
    picked = i;
    const r = shown[i];
    if (!r) return;
    if (scroll) $("rows").scrollTop = Math.max(0, i * ROW - $("rows").clientHeight / 2);
    const lines = [];
    if (r.kind === "can") {
      lines.push(`${hex(r.id)}${r.name ? " " + r.name : ""} on ${r.bus} at ${sec(r.t_us)} s` +
                 ` (until ${sec(r.end_us)}), from ${r.node || "?"}${r.sender ? ", sender " + r.sender : ""}`);
      lines.push(`data ${r.data.toUpperCase()} (dlc ${r.dlc})${r.ext ? ", extended" : ""}, ${r.outcome}`);
      for (const [k, v] of Object.entries(r.signals || {})) {
        const label = r.labels && r.labels[k] ? `  (${r.labels[k]})` : "";
        lines.push(`  ${k} = ${v}${label}`);
      }
    } else {
      lines.push(JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("_")))));
    }
    $("detail").textContent = lines.join("\n");
    table();
    draw();
  }

  $("rows").addEventListener("scroll", table);
  $("view").addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (row) pick(+row.dataset.i, false);
  });
  let timer;
  $("filter").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { picked = -1; $("detail").textContent = ""; apply(); vscode.setState({ filter: $("filter").value }); }, 120);
  });
  window.addEventListener("resize", () => { draw(); table(); });
  window.addEventListener("message", (e) => { if (e.data.type === "trace") load(e.data); });

  const state = vscode.getState();
  if (state && state.filter) $("filter").value = state.filter;
  vscode.postMessage({ type: "ready" });
})();
