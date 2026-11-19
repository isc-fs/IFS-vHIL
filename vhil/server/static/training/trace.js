// A run's trace (GET /api/runs/{id}/trace, vhil/worker.py) as series the
// Training page can read at any virtual time: pin levels (edges), firmware
// globals (samples), plant values, CAN frames and log lines.

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: opts.body ? { "content-type": "application/json" } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = "/auth/login"; throw new Error("log in"); }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const d = data?.detail;
    throw new Error(Array.isArray(d) ? d.map((x) => x.msg || x).join("; ") : d || res.statusText);
  }
  return { data, res };
}

export async function loadTrace(runId) {
  const recs = [];
  let cursor = "";
  for (let page = 0; page < 200; page++) {
    const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const { data, res } = await api(`/api/runs/${runId}/trace${q}`);
    recs.push(...data);
    const next = res.headers.get("X-Trace-Cursor") || "";
    if (!data.length || next === cursor) break;
    cursor = next;
  }
  return new Trace(recs);
}

// The last value at or before t of a [t_us, value] list sorted by t.
function at(list, t) {
  let lo = 0, hi = list.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid][0] <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best < 0 ? undefined : list[best][1];
}

export class Trace {
  constructor(recs) {
    this.series = new Map();     // "pin:ams.PB4" | "symbol:ams.g_x" | "plant:sdc.sdc_closed"
    this.frames = [];
    this.logs = [];
    this.analog = new Map();     // "ams.PF7" -> [[t, volts]] from the run's own stimuli
    this.end = 0;
    const push = (key, t, v) => {
      if (!this.series.has(key)) this.series.set(key, []);
      this.series.get(key).push([t, v]);
    };
    for (const r of recs) {
      if (typeof r.t_us === "number") this.end = Math.max(this.end, r.t_us);
      if (r.kind === "edge") push(`pin:${r.board}.${r.pin}`, r.t_us, r.level);
      else if (r.kind === "sample") push(`symbol:${r.board}.${r.name}`, r.t_us, r.value);
      else if (r.kind === "plant") push(`plant:${r.plant}.${r.name}`, r.t_us, r.value);
      else if (r.kind === "frame") this.frames.push(r);
      else if (r.kind === "log") {
        this.logs.push(r);
        const m = /stimulus analog (\w+)\.(\w+) = ([\d.]+) V/.exec(r.text || "");
        if (m) {
          const k = `${m[1]}.${m[2]}`;
          if (!this.analog.has(k)) this.analog.set(k, []);
          this.analog.get(k).push([r.t_us, Number(m[3])]);
        }
      }
    }
    for (const list of this.series.values()) list.sort((a, b) => a[0] - b[0]);
    this.frames.sort((a, b) => a.t_us - b.t_us);
  }

  value(key, t) {
    const list = this.series.get(key);
    return list ? at(list, t) : undefined;
  }

  has(key) { return this.series.has(key); }

  keys(prefix = "") { return [...this.series.keys()].filter((k) => k.startsWith(prefix)).sort(); }

  volts(boardPin, t) {
    const list = this.analog.get(boardPin);
    return list ? at(list, t) : undefined;
  }

  // Frames per bus in (t - window, t]: the bus's activity at t.
  activity(t, windowUs = 50_000) {
    const out = {};
    let lo = 0, hi = this.frames.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.frames[m].t_us <= t - windowUs) lo = m + 1; else hi = m; }
    for (let i = lo; i < this.frames.length && this.frames[i].t_us <= t; i++) {
      const b = this.frames[i].bus;
      out[b] = (out[b] || 0) + 1;
    }
    return out;
  }

  // Times where a series changes value: the timeline's markers.
  changes(key) {
    const list = this.series.get(key) || [];
    const out = [];
    let last;
    for (const [t, v] of list) { if (v !== last) out.push([t, v]); last = v; }
    return out;
  }

  // [x seconds], [y] stepped, for a scope channel.
  xy(key) {
    const list = this.series.get(key) || [];
    return { x: list.map(([t]) => t / 1e6), y: list.map(([, v]) => Number(v)) };
  }
}
