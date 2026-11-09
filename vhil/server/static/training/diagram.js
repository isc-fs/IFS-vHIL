// The car's E/E system as one picture: the shutdown circuit, the tractive
// system (AIRs, precharge, DC link), the accumulator and its cell monitors,
// the AMS and the ECU and the CAN buses between them. Each part is drawn
// from the run's trace at the selected time (Trace.value), and a click on it
// explains it and offers it as a fault location.

const NS = "http://www.w3.org/2000/svg";

// What each part is, for a new member: shown when it is clicked.
export const INFO = {
  "sdc": {
    title: "Shutdown circuit (SDC)",
    text: "A loop of safety switches in series. Only when every switch is closed does current reach AIR+_VCC, the supply of the AIR coils. Any switch opening (an error, a crash, a pressed E-stop) cuts it, and the AIRs fall open: the tractive system is disconnected. After it opens, RST_EXT must be pressed to re-arm the latches.",
  },
  "sdc.interlocks": { title: "Interlocks", text: "Connector and service-plug interlocks: a wire loop through every HV connector. Unplugging one opens the SDC.", part: "sdc.interlocks" },
  "sdc.hv_interlock": { title: "HV interlock", text: "The HV interlock loop through the accumulator and inverter connectors.", part: "sdc.interlocks" },
  "sdc.imd_latch": { title: "IMD latch (K4)", text: "The IMD (insulation monitoring device) checks that HV is isolated from the chassis. If insulation fails, its relay K4 drops and latches open until RST_EXT.", part: "sdc.imd" },
  "sdc.ams_latch": { title: "AMS latch (K5)", text: "K5's coil is driven from the AMS's AMS_OK output (PB4, through Q10). When the AMS finds a fault (a cell over- or under-voltage, a lost temperature sensor, a stale ECU), it drops AMS_OK, K5 opens, and the SDC with it. K5 then stays open until RST_EXT, and only re-closes if AMS_OK is high." },
  "sdc.bspd": { title: "BSPD", text: "Brake system plausibility device: opens the SDC if hard braking and high current happen together.", part: "sdc.bspd" },
  "sdc.inertia": { title: "Inertia switch", text: "Opens on a crash." },
  "sdc.bots": { title: "BOTS", text: "Brake over-travel switch: opens if the brake pedal goes too far." },
  "sdc.estop": { title: "E-stops", text: "The driver's and side shutdown buttons." },
  "sdc.tsms": { title: "TSMS", text: "Tractive System Master Switch: the last switch before the AIR coils. The AMS reads it on PF9 (TSMS_FIL, through a filter) so it knows the SDC is closed and it may precharge.", part: "sdc.tsms" },
  "ts.air_pos": { title: "AIR+", text: "Accumulator isolation relay, positive side. The AMS drives its coil low side on PB5. It closes last, after precharge, when the DC link is above 95 % of the pack.", part: "ts.air_pos" },
  "ts.air_neg": { title: "AIR-", text: "Accumulator isolation relay, negative side (AMS PB6). It closes first, together with the precharge relay.", part: "ts.air_neg" },
  "ts.pre": { title: "Precharge relay and resistor", text: "Charges the inverter's DC-link capacitor slowly through a resistor (AMS PB7) so closing AIR+ doesn't cause a huge inrush. The AMS watches the link voltage rise (relayed by the ECU on 0x100) and closes AIR+ at 95 %.", part: "ts.precharge" },
  "ts.discharge": { title: "Discharge relay and resistor", text: "Empties the DC link when the car is switched off. Its relay is normally closed and is held open while AIR+_VCC is on, so the resistor sits across the link whenever the shutdown circuit is open (or the ECU asks for a discharge). While precharging, it must be open: otherwise the precharge and discharge resistors form a voltage divider and the link can never reach 95 % of the pack. Nothing senses this relay; you see it only in the link voltage.", part: "ts.discharge" },
  "ts.link": { title: "DC link", text: "The inverter's input capacitor. Its voltage is what precharge charges. The inverter reports it on CAN 0x466; the ECU relays it to the AMS in the 0x100 heartbeat.", part: "ts.precharge" },
  "acc": { title: "Accumulator", text: "95 cells in series, in 5 modules of 19. Each module has two LTC6811 cell monitors (upper LTC_1 and lower LTC_2) that measure every cell voltage and, through an ADG731 multiplexer, 20 NTC temperature sensors each: 40 per module, numbered slot 0..39 (0..19 on the upper chip, 20..39 on the lower).", part: "ams.ntc" },
  "acc.chain": { title: "isoSPI daisy chain", text: "The AMS talks to the 10 LTC6811s through one LTC6820 over isoSPI: a two-wire, transformer-isolated link that runs from chip to chip. A break silences every chip after it.", part: "ams.isospi" },
  "ams": { title: "AMS (MainLite, node 0x2)", text: "Accumulator management system. It reads every cell and temperature, decides whether the pack is safe, drives AMS_OK and the AIR coils, and runs the precharge sequence (Start -> Precharge -> Run). Any fault latches Error until an LV power cycle. It logs to its SD card.", part: "firmware" },
  "ecu": { title: "ECU (MainLite, node 0x1)", text: "The vehicle control unit. It reads the pedals (two APPS and the brake sensor), commands the inverter on the inverter CAN bus, and sends the AMS its heartbeat 0x100 every 10 ms with the DC-link voltage. If the AMS stops hearing 0x100 for 200 ms, it latches Error (VcuStale).", part: "firmware" },
  "inv": { title: "Inverter", text: "Turns the DC link into motor current. It talks to the ECU on the inverter bus: commands in (0x360, 0x362), state and DC-link voltage out (0x461, 0x463, 0x466). In the vHIL it is the plant's DC link, not a motor model.", part: "can.inv" },
  "can.can_acu": { title: "ACU CAN bus", text: "ECU FDCAN2 <-> AMS FDCAN1. The heartbeat (0x100), the AMS status (0x4A0, 0x020) and the pit diagnostics (0x6A0..0x6C0, armed by 0x7F0 DE AD BE EF) live here.", part: "can.acu" },
  "can.can_inv": { title: "Inverter CAN bus", text: "ECU FDCAN1 <-> inverter.", part: "can.inv" },
  "can.can_dash": { title: "Dash CAN bus", text: "ECU FDCAN3 <-> dashboard and sensors." },
  "ecu.pedals": { title: "APPS and brake", text: "Two accelerator pedal position sensors (PF8, PF9) that must agree within 10 %, and the brake pressure sensor (PF7), on the ECU's ADC. A disagreement or an out-of-range voltage is a fault (T.11.8.9).", part: "ecu.pedals" },
  "ams.sd": { title: "SD card", text: "The AMS logs its state to a FAT32 SD card: a CSV at 4 Hz and binary logs, each rotated into a new file on size, rows or age.", part: "ams.sd_card" },
  "ams.current": { title: "Pack current sensor", text: "SSA-2-250A, a two-leg analog sensor on PF7/PF8.", part: "ams.current_sensor" },
};

// The AMS's states the puzzles name (state_machine.hpp); any other shows as its number.
export const AMS_STATES = { 0: "Start", 1: "Precharge", 3: "Run", 5: "Error" };

function el(name, attrs = {}, parent = null, text = null) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

export class Diagram {
  constructor(host, { onPick = () => {}, onProbe = () => {} } = {}) {
    this.onPick = onPick;
    this.onProbe = onProbe;
    this.svg = el("svg", { viewBox: "0 0 1000 640", class: "ee", role: "img",
                           "aria-label": "The car's E/E system" });
    host.replaceChildren(this.svg);
    this.parts = {};
    this.draw();
  }

  part(id, g) {
    g.classList.add("part");
    g.dataset.part = id;
    g.setAttribute("tabindex", "0");
    g.addEventListener("click", (e) => { e.stopPropagation(); this.select(id); });
    g.addEventListener("keydown", (e) => { if (e.key === "Enter") this.select(id); });
    this.parts[id] = g;
    return g;
  }

  select(id) {
    for (const g of Object.values(this.parts)) g.classList.toggle("selected", g.dataset.part === id);
    this.onPick(id);
  }

  // A probe point on a board pin: a click puts the multimeter on it.
  pin(parent, x, y, board, pin, label, side = "right") {
    const g = el("g", { class: "pin" }, parent);
    el("circle", { cx: x, cy: y, r: 5 }, g);
    const tx = side === "right" ? x + 9 : x - 9;
    el("text", { x: tx, y: y + 4, class: "pin-label", "text-anchor": side === "right" ? "start" : "end" },
       g, `${pin} ${label}`);
    g.dataset.probe = `${board}.${pin}`;
    g.addEventListener("click", (e) => { e.stopPropagation(); this.onProbe(`${board}.${pin}`); });
    this.pins = this.pins || {};
    this.pins[`${board}.${pin}`] = g;
    return g;
  }

  // A switch in the shutdown circuit: two contacts and a blade.
  sw(parent, id, x, y, label) {
    const g = this.part(id, el("g", { class: "sw" }, parent));
    el("rect", { x: x - 30, y: y - 26, width: 60, height: 52, rx: 6, class: "hit" }, g);
    el("circle", { cx: x - 14, cy: y, r: 3 }, g);
    el("circle", { cx: x + 14, cy: y, r: 3 }, g);
    el("line", { x1: x - 14, y1: y, x2: x + 14, y2: y, class: "blade" }, g);
    el("text", { x, y: y + 20, "text-anchor": "middle", class: "small" }, g, label);
    return g;
  }

  draw() {
    const s = this.svg;
    el("rect", { x: 0, y: 0, width: 1000, height: 640, class: "canvas" }, s);
    s.addEventListener("click", () => this.select("sdc"));

    // -- the shutdown circuit, top --------------------------------------------
    const sdc = el("g", {}, s);
    el("text", { x: 20, y: 28, class: "title" }, sdc, "Shutdown circuit");
    el("text", { x: 20, y: 46, class: "small muted" }, sdc, "LV +  ->  every switch in series  ->  AIR+_VCC (the AIR coils' supply)");
    this.sdcWire = el("path", { d: "M 40 80 H 960", class: "wire sdc-wire" }, sdc);
    const switches = [["sdc.interlocks", "Interlocks"], ["sdc.hv_interlock", "HV interlock"],
      ["sdc.imd_latch", "IMD K4"], ["sdc.ams_latch", "AMS K5"], ["sdc.bspd", "BSPD"],
      ["sdc.inertia", "Inertia"], ["sdc.bots", "BOTS"], ["sdc.estop", "E-stops"], ["sdc.tsms", "TSMS"]];
    switches.forEach(([id, label], i) => this.sw(sdc, id, 100 + i * 95, 80, label));
    this.vcc = el("text", { x: 960, y: 70, "text-anchor": "end", class: "small" }, sdc, "AIR+_VCC");

    // -- the accumulator, left ------------------------------------------------
    const acc = this.part("acc", el("g", {}, s));
    el("rect", { x: 20, y: 140, width: 250, height: 330, rx: 10, class: "box acc" }, acc);
    el("text", { x: 35, y: 164, class: "title" }, acc, "Accumulator");
    el("text", { x: 35, y: 182, class: "small muted" }, acc, "5 modules x 19 cells, 2 LTC6811 each");
    this.modules = [];
    for (let m = 0; m < 5; m++) {
      const y = 196 + m * 52;
      const g = el("g", { class: "module" }, acc);
      el("rect", { x: 35, y, width: 150, height: 42, rx: 5, class: "mod" }, g);
      el("text", { x: 45, y: y + 17, class: "small" }, g, `Module ${m}`);
      el("text", { x: 45, y: y + 33, class: "tiny muted" }, g, `NTC slots 0-39`);
      el("rect", { x: 195, y: y + 4, width: 30, height: 15, rx: 2, class: "chip" }, g);
      el("rect", { x: 195, y: y + 23, width: 30, height: 15, rx: 2, class: "chip" }, g);
      el("text", { x: 230, y: y + 15, class: "tiny muted" }, g, `${2 * m}`);
      el("text", { x: 230, y: y + 34, class: "tiny muted" }, g, `${2 * m + 1}`);
      this.modules.push(g);
    }
    const chain = this.part("acc.chain", el("g", {}, s));
    el("path", { d: "M 255 460 V 500 H 330", class: "wire spi" }, chain);
    el("text", { x: 262, y: 492, class: "tiny muted" }, chain, "isoSPI");

    // -- the AMS, middle -------------------------------------------------------
    const ams = this.part("ams", el("g", {}, s));
    el("rect", { x: 330, y: 300, width: 200, height: 250, rx: 10, class: "box board ams" }, ams);
    el("text", { x: 345, y: 324, class: "title" }, ams, "AMS");
    el("text", { x: 395, y: 324, class: "small muted" }, ams, "MainLite 0x2");
    this.amsState = el("text", { x: 345, y: 348, class: "state" }, ams, "-");
    this.amsReason = el("text", { x: 345, y: 366, class: "small muted" }, ams, "");
    const pins = el("g", {}, s);
    this.pin(pins, 530, 390, "ams", "PB4", "AMS_OK");
    this.pin(pins, 530, 412, "ams", "PB5", "AIR+");
    this.pin(pins, 530, 434, "ams", "PB6", "AIR-");
    this.pin(pins, 530, 456, "ams", "PB7", "PRECHARGE");
    this.pin(pins, 330, 390, "ams", "PF9", "TSMS", "left");
    this.pin(pins, 330, 412, "ams", "PF10", "DASH_CHG", "left");
    this.pin(pins, 330, 434, "ams", "PF7", "I_P", "left");
    this.pin(pins, 330, 456, "ams", "PF8", "I_N", "left");
    const sd = this.part("ams.sd", el("g", {}, s));
    el("rect", { x: 350, y: 505, width: 46, height: 30, rx: 3, class: "chip sd" }, sd);
    el("text", { x: 373, y: 524, "text-anchor": "middle", class: "tiny" }, sd, "SD");
    // AMS_OK up to K5, TSMS sense from AIR+_VCC
    el("path", { d: "M 530 390 H 560 V 130 H 385 V 106", class: "wire gpio" }, s);
    el("path", { d: "M 330 390 H 300 V 120 H 940 V 80", class: "wire gpio faint" }, s);

    // -- the tractive system, right ---------------------------------------------
    const ts = el("g", {}, s);
    el("text", { x: 640, y: 164, class: "title" }, ts, "Tractive system");
    this.vbar = el("rect", { x: 640, y: 180, width: 0, height: 10, rx: 2, class: "vbar" }, ts);
    el("rect", { x: 640, y: 180, width: 320, height: 10, rx: 2, class: "vtrack" }, ts);
    this.vtext = el("text", { x: 640, y: 206, class: "small" }, ts, "DC link -");
    this.contact(ts, "ts.air_pos", 700, 260, "AIR+");
    this.contact(ts, "ts.pre", 700, 330, "PRE + R");
    this.contact(ts, "ts.air_neg", 700, 420, "AIR-");
    el("path", { d: "M 600 260 H 670 M 730 260 H 840 M 600 330 H 670 M 730 330 H 780 V 260 M 600 260 V 330 M 600 420 H 670 M 730 420 H 840", class: "wire hv" }, ts);
    el("text", { x: 585, y: 264, "text-anchor": "end", class: "tiny muted" }, ts, "pack +");
    el("text", { x: 585, y: 424, "text-anchor": "end", class: "tiny muted" }, ts, "pack -");
    const link = this.part("ts.link", el("g", {}, s));
    el("line", { x1: 840, y1: 260, x2: 840, y2: 330, class: "wire hv" }, link);
    el("line", { x1: 825, y1: 330, x2: 855, y2: 330, class: "cap" }, link);
    el("line", { x1: 825, y1: 340, x2: 855, y2: 340, class: "cap" }, link);
    el("line", { x1: 840, y1: 340, x2: 840, y2: 420, class: "wire hv" }, link);
    el("text", { x: 862, y: 340, class: "tiny muted" }, link, "C link");
    const dis = this.part("ts.discharge", el("g", { class: "sw" }, ts));
    el("rect", { x: 790, y: 270, width: 30, height: 140, rx: 4, class: "hit" }, dis);
    el("line", { x1: 805, y1: 260, x2: 805, y2: 295, class: "wire hv" }, dis);
    el("rect", { x: 798, y: 295, width: 14, height: 34, rx: 2, class: "res" }, dis);
    el("line", { x1: 805, y1: 329, x2: 805, y2: 352, class: "wire hv" }, dis);
    el("circle", { cx: 805, cy: 355, r: 3 }, dis);
    el("line", { x1: 805, y1: 355, x2: 805, y2: 385, class: "blade" }, dis);
    el("circle", { cx: 805, cy: 385, r: 3 }, dis);
    el("line", { x1: 805, y1: 388, x2: 805, y2: 420, class: "wire hv" }, dis);
    el("text", { x: 805, y: 446, "text-anchor": "middle", class: "tiny muted" }, dis, "DIS + R");
    const inv = this.part("inv", el("g", {}, s));
    el("rect", { x: 880, y: 280, width: 100, height: 120, rx: 10, class: "box board inv" }, inv);
    el("text", { x: 930, y: 345, "text-anchor": "middle", class: "title" }, inv, "Inverter");
    // coils: AMS PB5..PB7 to the contacts
    el("path", { d: "M 530 412 H 580 V 245 H 700 V 248", class: "wire gpio faint" }, s);
    el("path", { d: "M 530 456 H 590 V 316 H 700 V 318", class: "wire gpio faint" }, s);
    el("path", { d: "M 530 434 H 570 V 405 H 700 V 408", class: "wire gpio faint" }, s);

    // -- the ECU and the CAN buses, bottom ---------------------------------------
    const ecu = this.part("ecu", el("g", {}, s));
    el("rect", { x: 620, y: 470, width: 200, height: 130, rx: 10, class: "box board ecu" }, ecu);
    el("text", { x: 635, y: 494, class: "title" }, ecu, "ECU");
    el("text", { x: 685, y: 494, class: "small muted" }, ecu, "MainLite 0x1");
    this.ecuState = el("text", { x: 635, y: 518, class: "small" }, ecu, "-");
    const ped = this.part("ecu.pedals", el("g", {}, s));
    el("rect", { x: 635, y: 535, width: 170, height: 50, rx: 5, class: "mod" }, ped);
    el("text", { x: 645, y: 555, class: "small" }, ped, "Pedals: APPS1/2, brake");
    el("text", { x: 645, y: 573, class: "tiny muted" }, ped, "PF8, PF9, PF7 (ADC)");
    this.bus(s, "can.can_acu", "M 530 520 H 620", "ACU bus", 560, 512);
    this.bus(s, "can.can_inv", "M 820 500 H 930 V 400", "INV bus", 860, 492);
    this.bus(s, "can.can_dash", "M 720 600 V 625 H 980", "DASH bus", 860, 618);
  }

  contact(parent, id, x, y, label) {
    const g = this.part(id, el("g", { class: "sw contact" }, parent));
    el("rect", { x: x - 34, y: y - 26, width: 68, height: 48, rx: 6, class: "hit" }, g);
    el("circle", { cx: x - 28, cy: y, r: 3 }, g);
    el("circle", { cx: x + 28, cy: y, r: 3 }, g);
    el("line", { x1: x - 28, y1: y, x2: x + 28, y2: y, class: "blade" }, g);
    el("text", { x, y: y + 18, "text-anchor": "middle", class: "small" }, g, label);
    return g;
  }

  bus(parent, id, d, label, lx, ly) {
    const g = this.part(id, el("g", { class: "bus" }, parent));
    el("path", { d, class: "wire can hit-wide" }, g);
    el("path", { d, class: "wire can" }, g);
    el("text", { x: lx, y: ly, class: "tiny" }, g, label);
    return g;
  }

  // The picture at virtual time t.
  show(trace, t) {
    const v = (k) => trace?.value(k, t);
    const set = (id, closed) => {
      const g = this.parts[id];
      if (!g) return;
      g.classList.toggle("closed", closed === 1 || closed === true);
      g.classList.toggle("open", closed === 0 || closed === false);
      g.classList.toggle("unknown", closed === undefined);
    };
    for (const k of ["interlocks", "hv_interlock", "imd_latch", "ams_latch", "bspd", "inertia", "bots", "estop", "tsms"]) {
      set(`sdc.${k}`, v(`plant:sdc.sdc_${k}`) ?? (k.endsWith("latch") ? v(`plant:sdc.${k}`) : undefined));
    }
    const closed = v("plant:sdc.sdc_closed");
    this.sdcWire.classList.toggle("live", closed === 1);
    this.vcc.textContent = closed === 1 ? "AIR+_VCC: on" : closed === 0 ? "AIR+_VCC: off" : "AIR+_VCC";
    set("ts.air_pos", v("plant:ts.air_pos_closed"));
    set("ts.air_neg", v("plant:ts.air_neg_closed"));
    set("ts.pre", v("plant:ts.pre_closed"));
    const link = v("plant:ts.v_link"), pack = v("plant:ts.v_pack");
    const frac = pack ? Math.max(0, Math.min(1, link / pack)) : 0;
    this.vbar.setAttribute("width", String(Math.round(320 * frac)));
    this.vtext.textContent = link === undefined ? "DC link -"
      : `DC link ${Number(link).toFixed(0)} V of ${Number(pack || 0).toFixed(0)} V pack (${Math.round(frac * 100)} %)`;

    const st = v("symbol:ams.g_state_telemetry");
    this.amsState.textContent = st === undefined ? "-" : (AMS_STATES[st] || `state ${st}`);
    this.amsState.classList.toggle("bad", st === 5);
    this.amsState.classList.toggle("good", st === 3);
    const reason = v("symbol:ams.g_fault_reason_telemetry");
    const detail = v("symbol:ams.g_fault_detail_telemetry");
    this.amsReason.textContent = st === 5 && reason !== undefined
      ? `fault reason ${reason}${detail !== undefined ? `, detail 0x${Number(detail).toString(16)}` : ""}` : "";
    const es = v("symbol:ecu.g_last_ctrl_state");
    this.ecuState.textContent = es === undefined ? "-" : `control state ${es}`;

    for (const [key, g] of Object.entries(this.pins || {})) {
      const lv = v(`pin:${key}`);
      g.classList.toggle("high", lv === 1);
      g.classList.toggle("low", lv === 0);
    }
    const act = trace ? trace.activity(t) : {};
    for (const bus of ["can_acu", "can_inv", "can_dash"]) {
      this.parts[`can.${bus}`]?.classList.toggle("busy", (act[bus] || 0) > 0);
    }
  }

  // The probe the multimeter is on.
  probe(key) {
    for (const [k, g] of Object.entries(this.pins || {})) g.classList.toggle("probed", k === key);
  }
}
