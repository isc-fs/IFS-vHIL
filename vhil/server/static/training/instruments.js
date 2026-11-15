// The trainee's instruments over a run's trace: a multimeter on any board
// pin or plant signal at the selected time, a scope of up to four channels
// over the run, the decoded CAN trace, the boards' log, and the SD card.
import { PlotGroup } from "../plot.js";
import { decodeFrame, formatValue, hexId, hexToBytes, lookup } from "../decode.js";

const DOCS = "https://github.com/isc-fs/IFS-vHIL/blob/dev/";
const V_HIGH = 3.3;

export function h(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) e.append(c);
  return e;
}

export const ms = (t) => `${(t / 1000).toFixed(1)} ms`;

// -- the multimeter --------------------------------------------------------------

export class Multimeter {
  constructor(host, signals) {
    this.host = host;
    this.signals = new Map(signals.map((s) => [`${s.board}.${s.pin}`, s]));
    this.key = null;
  }

  probe(key) { this.key = key; }

  show(trace, t) {
    if (!this.key) {
      this.host.replaceChildren(h("p", { class: "muted" },
        "Click a pin on the diagram (a dot on a board's edge) to put the probe on it."));
      return;
    }
    const sig = this.signals.get(this.key) || { board: this.key.split(".")[0], pin: this.key.split(".")[1] };
    const level = trace?.value(`pin:${this.key}`, t);
    const volts = trace?.volts(this.key, t);
    let reading, sub;
    if (level !== undefined) {
      reading = `${level ? V_HIGH.toFixed(2) : "0.00"} V`;
      sub = level ? "logic HIGH" : "logic LOW";
    } else if (volts !== undefined) {
      reading = `${Number(volts).toFixed(3)} V`;
      sub = "analog input (as driven on the bench)";
    } else {
      reading = "- - -";
      sub = "not recorded in this run (pins the boards' state view or the puzzle watch are)";
    }
    const where = [
      ["Car signal", sig.car || sig.signal || "-"],
      ["MCU pin", sig.mcu_pin ? `${sig.pin} (pad ${sig.mcu_pin})` : sig.pin],
      ["MainLite net", sig.net || "-"],
      ["Module connector", sig.module_pins?.length ? sig.module_pins.join(", ") : "on board only"],
      ["Backplane / car side", sig.connector || "not traced"],
      ["Conditioning", sig.conditioning || "-"],
    ];
    this.host.replaceChildren(
      h("div", { class: "dmm" },
        h("div", { class: "dmm-probe" }, `${sig.board.toUpperCase()} ${sig.pin}`),
        h("div", { class: `dmm-reading ${level === 1 ? "hi" : level === 0 ? "lo" : ""}` }, reading),
        h("div", { class: "dmm-sub muted" }, `${sub} at ${ms(t)}`)),
      h("dl", { class: "kv" }, ...where.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
      sig.doc ? h("p", { class: "small" }, "Backplane wiring: ",
        h("a", { href: DOCS + sig.doc, target: "_blank", rel: "noopener" }, sig.doc),
        " · pin model: ",
        h("a", { href: DOCS + "catalog/pin-models/mainlite.pins.yaml", target: "_blank", rel: "noopener" },
          "mainlite.pins.yaml")) : null);
  }
}

// -- the scope ------------------------------------------------------------------

const NAMES = {
  "symbol:ams.g_state_telemetry": "AMS state",
  "symbol:ams.g_fault_reason_telemetry": "AMS fault reason",
  "symbol:ams.g_fault_detail_telemetry": "AMS fault detail",
  "symbol:ecu.g_last_ctrl_state": "ECU control state",
  "plant:sdc.sdc_closed": "SDC closed (AIR+_VCC)",
  "plant:sdc.ams_latch": "AMS latch K5",
  "plant:sdc.imd_latch": "IMD latch K4",
  "plant:ts.v_link": "DC link (V)",
  "plant:ts.air_pos_closed": "AIR+ contact",
  "plant:ts.air_neg_closed": "AIR- contact",
  "plant:ts.pre_closed": "Precharge contact",
  "plant:ts.t_cell_max": "Hottest cell (C)",
};

export const label = (key) => NAMES[key] || key.replace(/^(pin|symbol|plant):/, "");

export class Scope {
  constructor(host, { onPick }) {
    this.host = host;
    this.onPick = onPick;
    this.channels = [];
    this.group = null;
  }

  setTrace(trace) {
    this.trace = trace;
    const preferred = ["plant:sdc.sdc_closed", "symbol:ams.g_state_telemetry", "pin:ams.PB4", "plant:ts.v_link"];
    this.channels = preferred.filter((k) => trace.has(k)).slice(0, 4);
    this.render();
  }

  render() {
    const trace = this.trace;
    if (!trace) { this.host.replaceChildren(h("p", { class: "muted" }, "Run the car first.")); return; }
    const options = trace.keys().filter((k) => !/bleed_c\d/.test(k));
    const pickers = [0, 1, 2, 3].map((i) => h("select", {
      "aria-label": `Channel ${i + 1}`,
      onchange: (e) => { this.channels[i] = e.target.value || null; this.channels = this.channels.filter(Boolean); this.render(); },
    }, h("option", { value: "" }, `CH${i + 1}: off`),
      ...options.map((k) => h("option", { value: k, selected: this.channels[i] === k }, label(k)))));
    const plots = h("div", { class: "plots" });
    this.host.replaceChildren(h("div", { class: "scope-ch" }, ...pickers), plots,
      h("p", { class: "small muted" }, "Drag to zoom, double-click for the whole run, click to move the cursor."));
    this.group?.destroy?.();
    this.group = new PlotGroup({ onPick: (tUs) => this.onPick(tUs) });
    const end = trace.end / 1e6;
    this.channels.forEach((key, i) => {
      const { x, y } = trace.xy(key);
      if (x.length && x[x.length - 1] < end) { x.push(end); y.push(y[y.length - 1]); }
      const div = h("div", {});
      plots.append(div);
      this.group.add(div, { label: label(key), x, y, height: 110,
                            color: getComputedStyle(document.documentElement).getPropertyValue(`--s${i + 1}`).trim() });
    });
  }

  marker(t) { this.group?.setMarker(t); }
}

// -- the CAN trace --------------------------------------------------------------

export class CanTrace {
  constructor(host, { onPick }) {
    this.host = host;
    this.onPick = onPick;
    this.bus = "";
    this.ids = "";
    this.contract = null;
  }

  setTrace(trace, contract) {
    this.trace = trace;
    this.contract = contract;
    this.render(0);
  }

  render(t) {
    const trace = this.trace;
    if (!trace) { this.host.replaceChildren(h("p", { class: "muted" }, "Run the car first.")); return; }
    this.t = t;
    const want = this.ids.split(/[\s,]+/).filter(Boolean).map((x) => parseInt(x, 16));
    const rows = trace.frames.filter((f) => (!this.bus || f.bus === this.bus) && (!want.length || want.includes(f.id)));
    // The 60 frames up to the cursor.
    let i = rows.findIndex((f) => f.t_us > t);
    if (i < 0) i = rows.length;
    const shown = rows.slice(Math.max(0, i - 60), i).reverse();
    const buses = [...new Set(trace.frames.map((f) => f.bus))].sort();
    const table = h("table", { class: "can" },
      h("thead", {}, h("tr", {}, h("th", {}, "time"), h("th", {}, "bus"), h("th", {}, "id"),
        h("th", {}, "message"), h("th", {}, "decoded"))),
      h("tbody", {}, ...shown.map((f) => {
        const msg = this.contract ? lookup(this.contract, f) : undefined;
        const dec = msg ? decodeFrame(msg, hexToBytes(f.data)).map((d) => `${d.name}=${formatValue(d)}`).join("  ") : f.data;
        return h("tr", { class: f.src === "stimulus" ? "stim" : "", onclick: () => this.onPick(f.t_us) },
          h("td", {}, ms(f.t_us)), h("td", {}, f.bus), h("td", { class: "mono" }, hexId(f.id, f.ext)),
          h("td", {}, msg?.name || "?"), h("td", { class: "mono small" }, dec));
      })));
    const counts = {};
    for (const f of rows) counts[f.id] = (counts[f.id] || 0) + 1;
    this.host.replaceChildren(
      h("div", { class: "can-filter" },
        h("select", { "aria-label": "Bus", onchange: (e) => { this.bus = e.target.value; this.render(this.t); } },
          h("option", { value: "" }, "all buses"), ...buses.map((b) => h("option", { value: b, selected: b === this.bus }, b))),
        h("input", { placeholder: "ids, hex: 100 4A0", value: this.ids, "aria-label": "CAN ids",
                     onchange: (e) => { this.ids = e.target.value; this.render(this.t); } }),
        h("span", { class: "small muted" }, `${rows.length} frames in the run; the last 60 before the cursor`)),
      shown.length ? table : h("p", { class: "muted" }, "No frames before the cursor."));
  }
}

// -- the log and the SD card ----------------------------------------------------

export function showLog(host, trace, t) {
  const lines = (trace?.logs || []).filter((r) => r.t_us <= t && r.source !== "scenario").slice(-200);
  host.replaceChildren(lines.length
    ? h("pre", { class: "log" }, lines.map((r) => `${ms(r.t_us).padStart(11)}  ${r.source || ""}  ${r.text}`).join("\n"))
    : h("p", { class: "muted" }, "Nothing logged before the cursor."));
}

export function showCard(host, card) {
  if (!card) {
    host.replaceChildren(h("p", { class: "muted" }, "The SD card is read after the run ends."));
    return;
  }
  const max = Math.max(1, ...card.files.map((f) => f.bytes));
  host.replaceChildren(
    h("p", {}, `After ${card.drive_s} s of driving the card holds `, h("strong", {}, `${card.files.length} files`),
      ` (${(card.bytes / 1024).toFixed(1)} KiB).`),
    h("div", { class: "files" }, ...card.files.map((f) => h("div", {
      class: "file", title: `${f.name}: ${f.bytes} bytes`,
    }, h("span", { class: "fname" }, f.name), h("span", { class: "fsize" }, `${f.bytes} B`),
      h("span", { class: "fbar", "data-w": String(Math.round(100 * f.bytes / max)) })))));
  for (const bar of host.querySelectorAll(".fbar")) bar.style.width = `${bar.dataset.w}%`;
}
