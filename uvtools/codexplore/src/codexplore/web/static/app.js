(() => {
"use strict";

/* ═══════════════════════════ Constants ═══════════════════════════ */

const ROW = 18;          // flame / timeline row height (px)
const LANE = 22;         // task lane height (px)
const AXIS = 22;         // time axis height (px)
const GUTTER = 220;      // task label gutter width (px)
const LINE_H = 20;       // source line height (px), must match .l in CSS
const FONT = '11px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const UNIT_SCALE = { seconds: 1, milliseconds: 1e-3, microseconds: 1e-6, nanoseconds: 1e-9 };

const USER_PAL = ["#c8693f", "#c4962f", "#6f9f3e", "#2f9e89", "#3d8bcc", "#7f6fd4", "#b45ea6", "#cc566f",
                  "#4fa364", "#b0823a", "#3d9db3", "#9a6bd0"];
const LIB_PAL = ["#3d4b66", "#3e5a63", "#4b4868", "#3f5c50", "#5a4a60", "#55573f", "#465470", "#5c4a4a"];
const STD_COLOR = "#3a404f", INTERNAL_COLOR = "#2b2f3a", ROOT_COLOR = "#262c3b", DIM_COLOR = "#161920";
const CAT_LABEL = { user: "your code", lib: "library", std: "stdlib", internal: "internal" };

const INTERNAL_NAMES = new Set(["_call_with_frames_removed", "_find_and_load", "_find_and_load_unlocked",
  "_load_unlocked", "_load", "_gcd_import", "_handle_fromlist", "_bootstrap", "_bootstrap_external", "__import__"]);
const TASK_STEP_RE = /^(?:Task\.__step|Task\.\w*step|TaskGroup\._spawn|_task_step)/;
const ASYNC_INTERNAL_RE = /asyncio[\\/]|_selector_events|_unix_events|selectors\.py|threading\.py/;

/* ═══════════════════════════ Helpers ═══════════════════════════ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ESC[c]);

function strHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const store = {
  get(k, d) { try { const v = localStorage.getItem("codexplore:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("codexplore:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1, n = arr[m]; if (n.x + n.w <= x) lo = m + 1; else hi = m; }
  return lo;
}
function findAt(arr, x) {
  const n = arr[lowerBound(arr, x)];
  return n && n.x <= x ? n : null;
}
function maxKey(map) {
  let best = 0, bw = -1;
  if (map) for (const [k, v] of map) if (v > bw) { bw = v; best = k; }
  return best;
}

function fmtDur(sec) {
  if (!(sec > 0)) return "0";
  if (sec >= 3600) return (sec / 3600).toFixed(1) + " h";
  if (sec >= 60) { const m = Math.floor(sec / 60), s = Math.round(sec - m * 60); return m + "m " + String(s).padStart(2, "0") + "s"; }
  if (sec >= 10) return sec.toFixed(1) + " s";
  if (sec >= 1) return sec.toFixed(2) + " s";
  if (sec >= 0.1) return (sec * 1e3).toFixed(0) + " ms";
  if (sec >= 1e-3) return (sec * 1e3).toFixed(1) + " ms";
  return (sec * 1e6).toFixed(0) + " µs";
}
function fmtV(v) {
  if (T.timed) return fmtDur(v * T.scale);
  const n = Math.round(v);
  return n + (n === 1 ? " sample" : " samples");
}
function fmtPct(v, of = T.total) {
  if (!of) return "0%";
  const p = v / of * 100;
  if (p >= 99.95) return "100%";
  if (p >= 10) return p.toFixed(0) + "%";
  if (p >= 0.1) return p.toFixed(1) + "%";
  return p > 0 ? "<0.1%" : "0%";
}
function fmtAxis(t, step) {
  if (!T.timed) return String(Math.round(t));
  if (step >= 1) return t >= 60 ? Math.floor(t / 60) + "m" + String(Math.round(t % 60)).padStart(2, "0") + "s" : t.toFixed(0) + "s";
  if (t >= 1 || step >= 0.1) return t.toFixed(Math.min(6, Math.ceil(-Math.log10(step) - 1e-9))) + "s";
  const ms = t * 1e3, d = Math.max(0, Math.ceil(-Math.log10(step * 1e3) - 1e-9));
  return ms.toFixed(Math.min(4, d)) + "ms";
}
function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
const HEAT_STOPS = [[0, hexToRgb("#2f3a52")], [0.35, hexToRgb("#4b6aa0")], [0.7, hexToRgb("#c28a2e")], [1, hexToRgb("#e8483b")]];
function heatColor(frac) {
  const t = frac > 0 ? clamp((Math.log10(frac) + 3.5) / 3.5, 0, 1) : 0;
  let i = 1; while (i < HEAT_STOPS.length - 1 && HEAT_STOPS[i][0] < t) i++;
  const [ta, a] = HEAT_STOPS[i - 1], [tb, b] = HEAT_STOPS[i], k = (t - ta) / (tb - ta || 1);
  return "rgb(" + a.map((v, j) => Math.round(v + (b[j] - v) * k)).join(",") + ")";
}

/* ═══════════════════════════ State ═══════════════════════════ */

const S = {
  meta: null, raw: null, cwd: "",
  thread: 0,
  view: store.get("view", "flame"),
  frames: store.get("frames", "internals"),
  color: store.get("color", "module"),
  tab: store.get("tab", "functions"),
  search: "", match: null,
  selFn: -1, hoverFn: -1,
  sort: { key: "self", asc: false },
};
if (!["flame", "inverted", "timeline", "tasks"].includes(S.view)) S.view = "flame";

let FN = [];                 // function table: unique (name, file)
let fnByKey = new Map();
let frameFn = new Int32Array(0), frameLine = new Int32Array(0);
let T = null;                // per-thread processed data

/* ═══════════════════════════ Frame classification ═══════════════════════════ */

function normPath(p) { return (p || "").replace(/\\/g, "/"); }

function classify(file) {
  if (!file || file.startsWith("<")) return { cat: "internal", group: file || "?" };
  const p = normPath(file);
  let m = p.match(/\/(?:site|dist)-packages\/([^/]+)/);
  if (m) return { cat: "lib", group: m[1].replace(/\.py$/, "").replace(/-[\d.]+.*$/, "") };
  m = p.match(/\/lib\/python\d+(?:\.\d+)?t?\/([^/]+)/);
  if (m) return { cat: "std", group: m[1].replace(/\.py$/, "") };
  const rel = relPath(file), dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : rel;
  return { cat: "user", group: dir };
}

function relPath(file) {
  if (!file) return "";
  const p = normPath(file);
  let m = p.match(/\/(?:site|dist)-packages\/(.+)$/);
  if (m) return m[1];
  m = p.match(/\/lib\/python\d+(?:\.\d+)?t?\/(.+)$/);
  if (m) return m[1];
  if (S.cwd && p.startsWith(S.cwd + "/")) return p.slice(S.cwd.length + 1);
  const parts = p.split("/");
  return parts.length > 5 ? "…/" + parts.slice(-4).join("/") : p;
}

function makeFn(name, file, line, extra) {
  const { cat, group } = classify(file);
  const base = file ? normPath(file).split("/").pop() : "";
  const fo = {
    id: FN.length, name, file, line, cat, group,
    disp: name === "<module>" && base ? "<module> " + base : name,
    rel: relPath(file),
    internal: INTERNAL_NAMES.has(name) || /frozen/i.test(file) || /importlib[\\/]_bootstrap/.test(file),
    synth: false, color: "", text: "",
  };
  Object.assign(fo, extra);
  const h = strHash(fo.group || fo.name);
  fo.color = fo.cat === "user" ? USER_PAL[h % USER_PAL.length]
    : fo.cat === "lib" ? LIB_PAL[h % LIB_PAL.length]
    : fo.cat === "std" ? STD_COLOR : INTERNAL_COLOR;
  fo.text = fo.cat === "user" ? "rgba(255,255,255,.95)" : fo.cat === "lib" ? "rgba(226,232,244,.88)" : "rgba(210,216,230,.72)";
  FN.push(fo);
  return fo;
}

function buildFunctions() {
  const frames = S.raw.shared?.frames || [];
  FN = []; fnByKey = new Map();
  frameFn = new Int32Array(frames.length);
  frameLine = new Int32Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i] || {}, name = f.name || "<frame " + i + ">", file = f.file || "", line = f.line || 0;
    const key = name + "\u0000" + file;
    let fo = fnByKey.get(key);
    if (!fo) { fo = makeFn(name, file, line); fnByKey.set(key, fo); }
    else if (line > 0 && (fo.line === 0 || line < fo.line)) fo.line = line;
    frameFn[i] = fo.id;
    frameLine[i] = line;
  }
}

function synthFn(key, name, cat, group) {
  let fo = fnByKey.get(key);
  if (!fo) { fo = makeFn(name, "", 0, { cat, group, synth: true, rel: "", disp: name }); fnByKey.set(key, fo); fo.internal = false; }
  return fo.id;
}

/* ═══════════════════════════ Per-thread processing ═══════════════════════════ */

function prepareThread() {
  const p = S.raw.profiles[S.thread] || { samples: [] };
  const samples = p.samples || [], n = samples.length;
  const weights = Array.isArray(p.weights) && p.weights.length === n ? p.weights : null;
  const scale = UNIT_SCALE[p.unit];
  const w = new Float64Array(n), starts = new Float64Array(n + 1);
  let total = 0;
  for (let s = 0; s < n; s++) { starts[s] = total; w[s] = weights ? (+weights[s] || 0) : 1; total += w[s]; }
  starts[n] = total;

  // Filtered stacks (root → leaf), flattened.
  const mode = S.frames, fnA = [], lnA = [], offs = new Int32Array(n + 1);
  for (let s = 0; s < n; s++) {
    const stk = samples[s] || [];
    const start = fnA.length;
    let inLibRun = false;
    for (let i = 0; i < stk.length; i++) {
      const idx = stk[i], f = frameFn[idx];
      if (f === undefined) continue;
      const fo = FN[f];
      if (mode === "all") { fnA.push(f); lnA.push(frameLine[idx]); continue; }
      if (fo.internal) continue;
      if (mode === "internals" || fo.cat === "user") { fnA.push(f); lnA.push(frameLine[idx]); inLibRun = false; continue; }
      if (mode === "collapse" && !inLibRun) {
        fnA.push(synthFn("lib:" + fo.group, "[" + fo.group + "]", fo.cat, fo.group)); lnA.push(0);
        inLibRun = true;
      }
    }
    if (fnA.length === start) {
      if (!stk.length) fnA.push(synthFn("empty", "(no Python frames)", "internal", "empty"));
      else fnA.push(synthFn("other", mode === "mine" ? "(outside your code)" : "(interpreter internals)", "internal", "other"));
      lnA.push(0);
    }
    offs[s + 1] = fnA.length;
  }
  const sFn = Int32Array.from(fnA), sLine = Int32Array.from(lnA);

  // Function stats on filtered stacks.
  const nf = FN.length;
  const self = new Float64Array(nf), tot = new Float64Array(nf), stamp = new Int32Array(nf).fill(-1);
  const fnLines = new Array(nf);
  let maxDepth = 0;
  for (let s = 0; s < n; s++) {
    const a = offs[s], b = offs[s + 1], ws = w[s];
    if (b - a > maxDepth) maxDepth = b - a;
    for (let k = a; k < b; k++) {
      const f = sFn[k];
      if (stamp[f] === s) continue;
      stamp[f] = s; tot[f] += ws;
      const ln = sLine[k];
      if (ln > 0) { const m = fnLines[f] || (fnLines[f] = new Map()); m.set(ln, (m.get(ln) || 0) + ws); }
    }
    if (b > a) self[sFn[b - 1]] += ws;
  }

  // Per-line heat on raw stacks (independent of the frame filter).
  const lineStats = new Map(), fstamp = new Int32Array(frameFn.length).fill(-1);
  for (let s = 0; s < n; s++) {
    const stk = samples[s] || [], ws = w[s];
    for (let i = 0; i < stk.length; i++) {
      const idx = stk[i];
      if (fstamp[idx] === s || frameLine[idx] <= 0) continue;
      fstamp[idx] = s;
      const fo = FN[frameFn[idx]];
      if (!fo || !fo.file) continue;
      let m = lineStats.get(fo.file);
      if (!m) lineStats.set(fo.file, m = new Map());
      let e = m.get(frameLine[idx]);
      if (!e) m.set(frameLine[idx], e = [0, 0]);
      e[1] += ws;
      if (i === stk.length - 1) e[0] += ws;
    }
  }

  const heat = new Array(nf);
  for (let f = 0; f < nf; f++) heat[f] = heatColor(total ? self[f] / total : 0);

  const tm = /"([^"]*)"/.exec(p.name || ""), tid = /Thread (\d+)/.exec(p.name || "");
  T = {
    index: S.thread, name: (tm && tm[1]) || (tid ? "Thread " + tid[1] : p.name || "Thread " + S.thread),
    timed: scale !== undefined, scale: scale || 1, n, w, starts, total, offs, sFn, sLine, maxDepth,
    self, tot, fnLines, lineStats, heat, raw: samples,
    tree: null, inv: null, timeline: null, tasks: null,
  };
  updateSearchMatch();
}

function buildTree(inverted) {
  const mk = (fn, parent) => ({ fn, parent, depth: parent ? parent.depth + 1 : 0, value: 0, self: 0, map: new Map(), kids: null, lines: null, x: 0, w: 0 });
  const root = mk(-1, null);
  const { n, w, offs, sFn, sLine } = T;
  const step = (node, f, ln, ws) => {
    let c = node.map.get(f);
    if (!c) { c = mk(f, node); node.map.set(f, c); }
    c.value += ws;
    if (ln > 0) { const m = c.lines || (c.lines = new Map()); m.set(ln, (m.get(ln) || 0) + ws); }
    return c;
  };
  for (let s = 0; s < n; s++) {
    const a = offs[s], b = offs[s + 1], ws = w[s];
    let node = root; root.value += ws;
    if (!inverted) {
      for (let k = a; k < b; k++) node = step(node, sFn[k], sLine[k], ws);
      node.self += ws;
    } else {
      for (let k = b - 1; k >= a; k--) { node = step(node, sFn[k], sLine[k], ws); if (k === b - 1) node.self += ws; }
      if (b === a) root.self += ws;
    }
  }
  const rows = [], stack = [root], tv = root.value || 1;
  root.x = 0; root.w = root.value ? 1 : 0;
  while (stack.length) {
    const nd = stack.pop();
    const kids = Array.from(nd.map.values()).sort((a, b) => b.value - a.value);
    nd.kids = kids; nd.map = null;
    (rows[nd.depth] || (rows[nd.depth] = [])).push(nd);
    let cx = nd.x;
    for (const k of kids) { k.x = cx; k.w = k.value / tv; cx += k.w; }
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return { root, rows };
}

function buildTimeline() {
  const { n, starts, total, offs, sFn } = T, rows = [], open = [], tv = total || 1;
  for (let s = 0; s < n; s++) {
    const a = offs[s], len = offs[s + 1] - a, x0 = starts[s] / tv, x1 = starts[s + 1] / tv;
    let k = 0;
    while (k < open.length && k < len && open[k].fn === sFn[a + k]) k++;
    for (let j = 0; j < k; j++) { open[j].w = x1 - open[j].x; open[j].s1 = s + 1; }
    open.length = k;
    for (let j = k; j < len; j++) {
      const b = { fn: sFn[a + j], d: j, x: x0, w: x1 - x0, s0: s, s1: s + 1 };
      (rows[j] || (rows[j] = [])).push(b);
      open.push(b);
    }
  }
  for (let d = 0; d < rows.length; d++) if (!rows[d]) rows[d] = [];
  return { rows };
}

function buildTasks() {
  const { n, starts, total, raw } = T, tv = total || 1;
  const laneOf = new Int32Array(n), leafFn = new Int32Array(n), leafLine = new Int32Array(n);
  const byFn = new Map(), lanes = [];
  let prevLane = null;
  for (let s = 0; s < n; s++) {
    const stk = raw[s] || [];
    let task = -1;
    for (let k = 0; k < stk.length - 1 && task < 0; k++) {
      if (!TASK_STEP_RE.test(FN[frameFn[stk[k]]].name)) continue;
      for (let j = k + 1; j < stk.length; j++) {
        const fo = FN[frameFn[stk[j]]];
        if (!fo.internal && !TASK_STEP_RE.test(fo.name)) { task = fo.id; break; }
      }
      break;
    }
    let lf = -1, ll = 0;
    for (let k = stk.length - 1; k >= 0; k--) {
      const fo = FN[frameFn[stk[k]]];
      if (fo.cat === "user") { lf = fo.id; ll = frameLine[stk[k]]; break; }
    }
    if (lf < 0 && stk.length) { lf = frameFn[stk[stk.length - 1]]; ll = frameLine[stk[stk.length - 1]]; }
    if (task < 0 && lf >= 0 && FN[lf].cat === "user") task = lf;
    if (task < 0) {
      for (let k = stk.length - 1; k >= 0; k--) {
        const fo = FN[frameFn[stk[k]]];
        if (fo.file && fo.cat !== "internal" && !ASYNC_INTERNAL_RE.test(fo.file)) { task = fo.id; break; }
      }
    }
    if (task < 0) task = lf;
    leafFn[s] = lf; leafLine[s] = ll;
    let lane = byFn.get(task);
    if (!lane) { lane = { fn: task, total: 0, runs: [], first: s, idx: 0 }; byFn.set(task, lane); lanes.push(lane); }
    lane.total += T.w[s];
    const x0 = starts[s] / tv, x1 = starts[s + 1] / tv;
    if (prevLane === lane) { const r = lane.runs[lane.runs.length - 1]; r.w = x1 - r.x; r.s1 = s + 1; }
    else lane.runs.push({ x: x0, w: x1 - x0, s0: s, s1: s + 1 });
    prevLane = lane;
  }
  lanes.sort((a, b) => b.total - a.total || a.first - b.first);
  lanes.forEach((l, i) => { l.idx = i; });
  for (let s = 0; s < n; s++) laneOf[s] = -1;
  for (const l of lanes) for (const r of l.runs) for (let s = r.s0; s < r.s1; s++) laneOf[s] = l.idx;
  return { lanes, laneOf, leafFn, leafLine };
}

const getTree = inv => inv ? (T.inv || (T.inv = buildTree(true))) : (T.tree || (T.tree = buildTree(false)));
const getTimeline = () => T.timeline || (T.timeline = buildTimeline());
const getTasks = () => T.tasks || (T.tasks = buildTasks());

function sampleAt(x) {
  const t = x * T.total, st = T.starts;
  let lo = 0, hi = T.n - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (st[m] <= t) lo = m; else hi = m - 1; }
  return lo;
}

function hotLine(fn) {
  const l = maxKey(T.fnLines[fn]);
  return l || (FN[fn] ? FN[fn].line : 0);
}

function updateSearchMatch() {
  const q = S.search.trim().toLowerCase();
  if (!q) { S.match = null; T && ($("#search-info").textContent = ""); return; }
  const m = new Uint8Array(FN.length);
  for (const fo of FN) if (fo.disp.toLowerCase().includes(q) || (fo.file && fo.file.toLowerCase().includes(q))) m[fo.id] = 1;
  S.match = m;
  if (!T) return;
  let hit = 0;
  for (let s = 0; s < T.n; s++) {
    for (let k = T.offs[s]; k < T.offs[s + 1]; k++) if (m[T.sFn[k]]) { hit += T.w[s]; break; }
  }
  $("#search-info").textContent = fmtPct(hit);
  $("#search-info").title = "Share of samples with a matching frame on the stack";
}

/* ═══════════════════════════ Canvas chart ═══════════════════════════ */

function fillFor(fn) {
  if (fn < 0) return ROOT_COLOR;
  if (S.match && !S.match[fn]) return DIM_COLOR;
  return S.color === "heat" ? T.heat[fn] : FN[fn].color;
}

class Chart {
  constructor() {
    this.plot = $("#plot");
    this.canvas = $("#plot canvas");
    this.ctx = this.canvas.getContext("2d");
    this.miniWrap = $("#minimap");
    this.mini = $("#minimap canvas");
    this.mctx = this.mini.getContext("2d");
    this.hbar = $("#plot .hbar"); this.hthumb = this.hbar.firstElementChild;
    this.vbar = $("#plot .vbar"); this.vthumb = this.vbar.firstElementChild;
    this.x0 = 0; this.x1 = 1; this.sy = 0;
    this.W = 1; this.H = 1; this.MW = 1; this.MH = 1; this.dpr = 1;
    this.model = null; this.raf = 0; this.animId = 0; this.miniCache = null; this.brush = null;
    this.charW = 6.6; this.lastHover = null;
    this.onHover = null; this.onClick = null; this.onView = null;
    new ResizeObserver(() => this.resize()).observe(this.plot);
    new ResizeObserver(() => this.resizeMini()).observe(this.miniWrap);
    this.bindPlot(); this.bindBars(); this.bindMini();
  }

  get left() { return this.model ? this.model.gutter : 0; }
  get top() { return this.model ? this.model.top : 0; }
  get pw() { return Math.max(1, this.W - this.left); }
  get ph() { return Math.max(1, this.H - this.top); }
  get span() { return this.x1 - this.x0; }
  pxToX(px) { return this.x0 + (px - this.left) / this.pw * this.span; }
  maxSy() { return this.model ? Math.max(0, this.model.height() - this.ph) : 0; }

  setModel(model, keepX) {
    this.cancelAnim();
    this.model = model;
    if (!keepX) { this.x0 = 0; this.x1 = 1; this.sy = 0; }
    this.sy = clamp(this.sy, 0, this.maxSy());
    this.miniWrap.hidden = !(model && model.drawMini);
    this.miniCache = null;
    this.lastHover = null;
    this.request();
  }

  resize() {
    const r = this.plot.getBoundingClientRect();
    this.W = Math.max(1, Math.floor(r.width)); this.H = Math.max(1, Math.floor(r.height));
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.W * this.dpr); this.canvas.height = Math.round(this.H * this.dpr);
    this.sy = clamp(this.sy, 0, this.maxSy());
    this.miniCache = null;
    this.drawNow();
  }
  resizeMini() {
    const r = this.miniWrap.getBoundingClientRect();
    if (!r.width) return;
    this.dpr = window.devicePixelRatio || 1;
    this.MW = Math.max(1, Math.floor(r.width)); this.MH = Math.max(1, Math.floor(r.height));
    this.mini.width = Math.round(this.MW * this.dpr); this.mini.height = Math.round(this.MH * this.dpr);
    this.miniCache = null;
    this.drawNow();
  }

  request() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.drawNow(); }); }
  invalidate() { this.miniCache = null; this.request(); }

  setRange(a, b) {
    if (!isFinite(a) || !isFinite(b)) return;
    const minSpan = this.model ? this.model.minSpan : 1e-6;
    let s = b - a;
    if (s < minSpan) { const c = (a + b) / 2; a = c - minSpan / 2; b = c + minSpan / 2; s = minSpan; }
    if (s >= 1) { a = 0; b = 1; }
    else { if (a < 0) { b -= a; a = 0; } if (b > 1) { a -= b - 1; b = 1; } }
    this.x0 = a; this.x1 = b;
    this.request();
  }
  zoomAt(factor, px) {
    const ratio = clamp((px - this.left) / this.pw, 0, 1), x = this.x0 + ratio * this.span;
    const s = clamp(this.span * factor, this.model ? this.model.minSpan : 1e-6, 1);
    this.setRange(x - ratio * s, x - ratio * s + s);
  }
  zoomCenter(factor) {
    const s = clamp(this.span * factor, this.model ? this.model.minSpan : 1e-6, 1), c = (this.x0 + this.x1) / 2;
    this.animateTo(c - s / 2, c + s / 2);
  }
  panPx(dx) { const d = dx / this.pw * this.span; this.setRange(this.x0 + d, this.x1 + d); }
  scrollBy(dy) { const ny = clamp(this.sy + dy, 0, this.maxSy()); if (ny !== this.sy) { this.sy = ny; this.request(); } }

  animateTo(a, b) {
    this.cancelAnim();
    const id = this.animId, fa = this.x0, fb = this.x1, t0 = performance.now(), D = 260;
    const step = now => {
      if (id !== this.animId) return;
      const t = Math.min(1, (now - t0) / D), e = 1 - Math.pow(1 - t, 3);
      this.setRange(fa + (a - fa) * e, fb + (b - fb) * e);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  cancelAnim() { this.animId++; }

  zoomToItem(it) {
    const pad = it.w * 0.03;
    this.animateTo(it.x - pad, it.x + it.w + pad);
    if (it.y != null) {
      const y = it.y, h = it.h || ROW;
      if (y < this.sy || y + h > this.sy + this.ph) { this.sy = clamp(y - this.ph / 3, 0, this.maxSy()); this.request(); }
    }
  }
  revealY(y, h) {
    if (y < this.sy || y + h > this.sy + this.ph) { this.sy = clamp(y - this.ph / 3, 0, this.maxSy()); this.request(); }
  }

  fit(text, px) {
    const n = Math.floor(px / this.charW);
    if (text.length <= n) return text;
    return n >= 3 ? text.slice(0, n - 1) + "…" : "";
  }

  box(ctx, px, y, w, h, fn, label) {
    let a = px, b = px + w;
    if (a < this.left) a = this.left;
    if (b > this.W) b = this.W;
    let bw = b - a;
    if (bw <= 0) { if (w > 0 && px + w > this.left && px < this.W) bw = 1; else return; }
    if (bw < 1) bw = 1;
    const gap = bw > 3 ? 1 : 0, fw = bw - gap, fh = h - 1;
    ctx.fillStyle = fillFor(fn);
    ctx.fillRect(a, y, fw, fh);
    if (fn >= 0 && fn === S.hoverFn) { ctx.fillStyle = "rgba(255,255,255,.17)"; ctx.fillRect(a, y, fw, fh); }
    if (fn >= 0 && fn === S.selFn && fw > 2) {
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5;
      ctx.strokeRect(a + .75, y + .75, fw - 1.5, fh - 1.5);
    }
    if (label !== "" && fw > 26 && !(S.match && fn >= 0 && !S.match[fn])) {
      const t = this.fit(label != null ? label : FN[fn].disp, fw - 8);
      if (t) { ctx.fillStyle = fn < 0 ? "#a0a8bb" : S.color === "heat" ? "rgba(255,255,255,.95)" : FN[fn].text; ctx.fillText(t, a + 4, y + fh / 2 + .5); }
    }
  }

  drawAxis(ctx) {
    const W = this.W, left = this.left, tTot = T.timed ? T.total * T.scale : T.total;
    const t0 = this.x0 * tTot, t1 = this.x1 * tTot, step = niceStep((t1 - t0) / Math.max(1, this.pw / 110));
    ctx.fillStyle = "#0e1117"; ctx.fillRect(0, 0, W, AXIS);
    ctx.fillStyle = "#20252f"; ctx.fillRect(0, AXIS - 1, W, 1);
    ctx.fillStyle = "#687088";
    for (let t = Math.ceil(t0 / step) * step; t <= t1 + step * 1e-6; t += step) {
      const px = left + (t / tTot - this.x0) / this.span * this.pw;
      if (px < left - 1) continue;
      ctx.fillRect(Math.round(px), AXIS - 6, 1, 5);
      ctx.fillText(fmtAxis(t, step), Math.round(px) + 4, AXIS / 2);
    }
  }
  drawGrid(ctx) {
    const tTot = T.timed ? T.total * T.scale : T.total;
    const t0 = this.x0 * tTot, t1 = this.x1 * tTot, step = niceStep((t1 - t0) / Math.max(1, this.pw / 110));
    ctx.fillStyle = "rgba(255,255,255,.035)";
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      const px = this.left + (t / tTot - this.x0) / this.span * this.pw;
      ctx.fillRect(Math.round(px), this.top, 1, this.H - this.top);
    }
  }

  drawNow() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#0a0c11"; ctx.fillRect(0, 0, this.W, this.H);
    if (!this.model || !T) return;
    ctx.font = FONT; ctx.textBaseline = "middle";
    this.charW = ctx.measureText("abcdefghijklmnopqrstuvwxyz").width / 26 || 6.6;
    this.sy = clamp(this.sy, 0, this.maxSy());
    this.model.draw(ctx, this);
    this.updateBars();
    this.drawMini();
    if (this.onView) this.onView();
    if (this.mouse && !this.dragging) {
      const it = this.hitAt(this.mouse);
      if ((it && it.key) !== (this.lastHover && this.lastHover.key)) this.hover(it, this.mouse);
    }
  }

  drawMini() {
    if (!this.model || !this.model.drawMini || this.miniWrap.hidden) return;
    const ctx = this.mctx, dpr = this.dpr, W = this.MW, H = this.MH, left = this.left, pw = Math.max(1, W - left);
    if (!this.miniCache) {
      const off = document.createElement("canvas");
      off.width = Math.round(W * dpr); off.height = Math.round(H * dpr);
      const o = off.getContext("2d");
      o.setTransform(dpr, 0, 0, dpr, 0, 0);
      o.fillStyle = "#0e1117"; o.fillRect(0, 0, W, H);
      this.model.drawMini(o, left, pw, H);
      if (left > 0) {
        o.fillStyle = "#0e1117"; o.fillRect(0, 0, left, H);
        o.font = FONT; o.textBaseline = "middle"; o.fillStyle = "#687088";
        o.fillText("overview · drag to zoom", 12, H / 2);
      }
      this.miniCache = off;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.miniCache, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const a = left + this.x0 * pw, b = left + this.x1 * pw;
    ctx.fillStyle = "rgba(6,8,12,.62)";
    ctx.fillRect(left, 0, Math.max(0, a - left), H);
    ctx.fillRect(b, 0, Math.max(0, W - b), H);
    ctx.strokeStyle = "rgba(130,160,255,.9)"; ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(a) + .5, .5, Math.max(1, Math.round(b - a) - 1), H - 1);
    if (this.brush) {
      const [p, q] = this.brush, l = Math.min(p, q), r = Math.max(p, q);
      ctx.fillStyle = "rgba(130,160,255,.2)"; ctx.fillRect(l, 0, r - l, H);
      ctx.fillStyle = "rgba(130,160,255,.9)"; ctx.fillRect(l, 0, 1, H); ctx.fillRect(r - 1, 0, 1, H);
    }
  }

  updateBars() {
    const span = this.span, vis = this.maxSy() > 0;
    if (span < 0.99999) {
      const trackW = this.pw - (vis ? 14 : 4), thumbW = Math.max(28, span * trackW);
      this.hbar.hidden = false;
      this.hbar.style.left = (this.left + 2) + "px"; this.hbar.style.width = trackW + "px";
      this.hthumb.style.width = thumbW + "px";
      this.hthumb.style.left = (this.x0 / (1 - span)) * (trackW - thumbW) + "px";
      this.hTrack = { trackW, thumbW };
    } else this.hbar.hidden = true;
    if (vis) {
      const trackH = this.ph - 14, ch = this.model.height(), thumbH = Math.max(28, this.ph / ch * trackH);
      this.vbar.hidden = false;
      this.vbar.style.top = (this.top + 2) + "px"; this.vbar.style.height = trackH + "px";
      this.vthumb.style.height = thumbH + "px";
      this.vthumb.style.top = (this.sy / this.maxSy()) * (trackH - thumbH) + "px";
      this.vTrack = { trackH, thumbH };
    } else this.vbar.hidden = true;
  }

  hitAt(e) {
    if (!this.model || !T) return null;
    const r = this.plot.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    if (py < this.top) return null;
    return this.model.hit(px, py, this);
  }

  bindPlot() {
    const p = this.plot;
    let down = null;
    p.addEventListener("wheel", e => {
      if (!this.model) return;
      e.preventDefault();
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.H : 1;
      let dx = e.deltaX * k, dy = e.deltaY * k;
      const mx = e.clientX - p.getBoundingClientRect().left;
      if (e.ctrlKey || e.metaKey) { this.cancelAnim(); this.zoomAt(Math.exp(clamp(dy, -60, 60) * 0.006), Math.max(mx, this.left)); return; }
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }
      if (dx) { this.cancelAnim(); this.panPx(dx); }
      if (dy) { if (this.maxSy() > 0) this.scrollBy(dy); else flashHint(); }
    }, { passive: false });

    p.addEventListener("pointerdown", e => {
      if (e.button !== 0 || !this.model) return;
      if (e.target.closest(".hbar,.vbar")) return;
      p.setPointerCapture(e.pointerId);
      down = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, drag: false };
    });
    p.addEventListener("pointermove", e => {
      this.mouse = { clientX: e.clientX, clientY: e.clientY };
      if (down) {
        if (!down.drag && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) {
          down.drag = true; this.dragging = true; p.classList.add("grabbing"); hideTip(); this.cancelAnim();
        }
        if (down.drag) {
          this.panPx(-(e.clientX - down.lx)); this.scrollBy(-(e.clientY - down.ly));
          down.lx = e.clientX; down.ly = e.clientY;
        }
        return;
      }
      if (e.target.closest(".hbar,.vbar")) { this.hover(null, e); return; }
      this.hover(this.hitAt(e), e);
    });
    const end = e => {
      if (!down) return;
      const wasDrag = down.drag;
      down = null; this.dragging = false; p.classList.remove("grabbing");
      if (!wasDrag && e.type === "pointerup" && this.onClick) this.onClick(this.hitAt(e), e);
    };
    p.addEventListener("pointerup", end);
    p.addEventListener("pointercancel", end);
    p.addEventListener("pointerleave", e => { if (!down) { this.mouse = null; this.hover(null, e); } });
    p.addEventListener("dblclick", e => {
      if (e.target.closest(".hbar,.vbar")) return;
      const it = this.hitAt(e);
      if (it && it.w > 0) this.zoomToItem(it); else this.animateTo(0, 1);
    });
  }

  hover(it, e) {
    const prev = this.lastHover, same = prev && it && prev.key === it.key;
    this.lastHover = it;
    this.plot.classList.toggle("pointer", !!it);
    if (this.onHover) this.onHover(it, e, same);
  }

  bindBars() {
    const drag = (thumb, bar, horiz) => {
      thumb.addEventListener("pointerdown", e => {
        e.stopPropagation(); e.preventDefault();
        thumb.setPointerCapture(e.pointerId); thumb.classList.add("drag"); this.cancelAnim();
        let last = horiz ? e.clientX : e.clientY;
        const mv = ev => {
          const cur = horiz ? ev.clientX : ev.clientY, d = cur - last; last = cur;
          if (horiz) {
            const { trackW, thumbW } = this.hTrack, span = this.span;
            const dx = d * (1 - span) / Math.max(1, trackW - thumbW);
            this.setRange(this.x0 + dx, this.x1 + dx);
          } else {
            const { trackH, thumbH } = this.vTrack;
            this.scrollBy(d * this.maxSy() / Math.max(1, trackH - thumbH));
          }
        };
        const up = () => { thumb.classList.remove("drag"); thumb.removeEventListener("pointermove", mv); };
        thumb.addEventListener("pointermove", mv);
        thumb.addEventListener("pointerup", up, { once: true });
        thumb.addEventListener("pointercancel", up, { once: true });
      });
      bar.addEventListener("pointerdown", e => {
        if (e.target !== bar) return;
        e.stopPropagation();
        const r = thumb.getBoundingClientRect(), before = horiz ? e.clientX < r.left : e.clientY < r.top;
        if (horiz) { const s = this.span * (before ? -0.9 : 0.9); this.animateTo(this.x0 + s, this.x1 + s); }
        else this.scrollBy((before ? -1 : 1) * this.ph * 0.9);
      });
      bar.addEventListener("dblclick", e => e.stopPropagation());
    };
    drag(this.hthumb, this.hbar, true);
    drag(this.vthumb, this.vbar, false);
  }

  bindMini() {
    const m = this.miniWrap;
    let st = null;
    const xOf = e => {
      const r = m.getBoundingClientRect(), pw = Math.max(1, this.MW - this.left);
      return { px: e.clientX - r.left, x: clamp((e.clientX - r.left - this.left) / pw, 0, 1) };
    };
    m.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      const { px, x } = xOf(e);
      if (px < this.left) return;
      m.setPointerCapture(e.pointerId); this.cancelAnim();
      const inside = x >= this.x0 && x <= this.x1 && this.span < 0.999;
      st = { px0: px, x0: x, mode: inside ? "move" : "brush", off: x - this.x0, moved: false };
    });
    m.addEventListener("pointermove", e => {
      if (!st) return;
      const { px, x } = xOf(e);
      if (Math.abs(px - st.px0) > 3) st.moved = true;
      if (st.mode === "move") { const s = this.span; this.setRange(x - st.off, x - st.off + s); }
      else if (st.moved) { this.brush = [st.px0, clamp(px, this.left, this.MW)]; this.request(); }
    });
    const end = e => {
      if (!st) return;
      const { x } = xOf(e), s = st; st = null; this.brush = null;
      if (s.mode === "brush") {
        if (s.moved) { const a = Math.min(s.x0, x), b = Math.max(s.x0, x); if (b > a) this.animateTo(a, b); }
        else { const sp = this.span; this.animateTo(x - sp / 2, x + sp / 2); }
      }
      this.request();
    };
    m.addEventListener("pointerup", end);
    m.addEventListener("pointercancel", end);
    m.addEventListener("wheel", e => {
      e.preventDefault();
      const r = m.getBoundingClientRect();
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { this.panPx(e.shiftKey ? e.deltaY : e.deltaX); return; }
      const pw = Math.max(1, this.MW - this.left), x = clamp((e.clientX - r.left - this.left) / pw, 0, 1);
      const px = this.left + (x - this.x0) / this.span * this.pw;
      this.cancelAnim(); this.zoomAt(Math.exp(clamp(e.deltaY, -60, 60) * 0.006), px);
    }, { passive: false });
    m.addEventListener("dblclick", () => this.animateTo(0, 1));
  }
}

/* ─── Chart models ─── */

function flameModel(inverted) {
  const { rows } = getTree(inverted);
  const rootLabel = (inverted ? "all samples (bottom-up) · " : "all samples · ") + T.name + " · " + fmtV(T.total);
  return {
    kind: inverted ? "inverted" : "flame", gutter: 0, top: 0, minSpan: 1e-6, drawMini: null,
    height: () => rows.length * ROW + 6,
    draw(ctx, v) {
      const sx = v.pw / v.span;
      const d0 = Math.max(0, Math.floor(v.sy / ROW)), d1 = Math.min(rows.length - 1, Math.floor((v.sy + v.ph) / ROW));
      for (let d = d0; d <= d1; d++) {
        const row = rows[d], y = d * ROW - v.sy + v.top;
        let last = -1;
        for (let i = lowerBound(row, v.x0); i < row.length; i++) {
          const n = row[i];
          if (n.x >= v.x1) break;
          const px = v.left + (n.x - v.x0) * sx, pw = n.w * sx;
          if (pw < 1) { const ip = px | 0; if (ip <= last) continue; last = ip; }
          else last = (px + pw) | 0;
          v.box(ctx, px, y, pw, ROW, n.fn, n.fn < 0 ? rootLabel : null);
        }
      }
    },
    hit(px, py, v) {
      const d = Math.floor((py - v.top + v.sy) / ROW), row = rows[d];
      if (!row) return null;
      const n = findAt(row, v.pxToX(px));
      if (!n) return null;
      return { kind: "node", key: n, node: n, fn: n.fn, x: n.x, w: n.w, y: d * ROW, h: ROW, line: maxKey(n.lines) };
    },
  };
}

function drawMiniRows(rows, ctx, left, pw, H) {
  const rh = Math.min(4, (H - 4) / Math.max(1, rows.length));
  for (let d = 0; d < rows.length; d++) {
    const row = rows[d], y = 2 + d * rh;
    let last = -1;
    for (let i = 0; i < row.length; i++) {
      const b = row[i], px = left + b.x * pw, w = b.w * pw;
      if (w < 1) { const ip = px | 0; if (ip <= last) continue; last = ip; } else last = (px + w) | 0;
      ctx.fillStyle = S.color === "heat" ? T.heat[b.fn] : FN[b.fn].color;
      ctx.fillRect(px, y, Math.max(1, w), Math.max(1, rh - (rh > 2 ? 0.5 : 0)));
    }
  }
}

function timelineModel() {
  const { rows } = getTimeline();
  return {
    kind: "timeline", gutter: 0, top: AXIS, minSpan: Math.max(1e-7, 0.5 / Math.max(1, T.n)),
    height: () => rows.length * ROW + 6,
    drawMini: (ctx, left, pw, H) => drawMiniRows(rows, ctx, left, pw, H),
    draw(ctx, v) {
      v.drawGrid(ctx);
      const sx = v.pw / v.span;
      const d0 = Math.max(0, Math.floor(v.sy / ROW)), d1 = Math.min(rows.length - 1, Math.floor((v.sy + v.ph) / ROW));
      for (let d = d0; d <= d1; d++) {
        const row = rows[d], y = d * ROW - v.sy + v.top;
        let last = -1;
        for (let i = lowerBound(row, v.x0); i < row.length; i++) {
          const b = row[i];
          if (b.x >= v.x1) break;
          const px = v.left + (b.x - v.x0) * sx, pw = b.w * sx;
          if (pw < 1) { const ip = px | 0; if (ip <= last) continue; last = ip; } else last = (px + pw) | 0;
          v.box(ctx, px, y, pw, ROW, b.fn, null);
        }
      }
      v.drawAxis(ctx);
    },
    hit(px, py, v) {
      const d = Math.floor((py - v.top + v.sy) / ROW), row = rows[d];
      if (!row) return null;
      const b = findAt(row, v.pxToX(px));
      if (!b) return null;
      return { kind: "block", key: b, block: b, fn: b.fn, x: b.x, w: b.w, y: d * ROW, h: ROW };
    },
  };
}

function tasksModel() {
  const tk = getTasks(), lanes = tk.lanes, tl = getTimeline();
  return {
    kind: "tasks", gutter: GUTTER, top: AXIS, minSpan: Math.max(1e-7, 0.5 / Math.max(1, T.n)),
    height: () => lanes.length * LANE + 6,
    drawMini: (ctx, left, pw, H) => drawMiniRows(tl.rows, ctx, left, pw, H),
    draw(ctx, v) {
      v.drawGrid(ctx);
      const sx = v.pw / v.span;
      const l0 = Math.max(0, Math.floor(v.sy / LANE)), l1 = Math.min(lanes.length - 1, Math.floor((v.sy + v.ph) / LANE));
      for (let li = l0; li <= l1; li++) {
        const lane = lanes[li], y = li * LANE - v.sy + v.top;
        if (li % 2) { ctx.fillStyle = "rgba(255,255,255,.018)"; ctx.fillRect(v.left, y, v.W - v.left, LANE); }
        let last = -1;
        for (let i = lowerBound(lane.runs, v.x0); i < lane.runs.length; i++) {
          const r = lane.runs[i];
          if (r.x >= v.x1) break;
          const px = v.left + (r.x - v.x0) * sx, pw = r.w * sx;
          if (pw < 1) { const ip = px | 0; if (ip <= last) continue; last = ip; } else last = (px + pw) | 0;
          v.box(ctx, px, y + 3, pw, LANE - 5, lane.fn, "");
        }
      }
      // Label gutter
      ctx.fillStyle = "#0e1117"; ctx.fillRect(0, v.top, v.left, v.H - v.top);
      ctx.fillStyle = "#20252f"; ctx.fillRect(v.left - 1, v.top, 1, v.H - v.top);
      for (let li = l0; li <= l1; li++) {
        const lane = lanes[li], y = li * LANE - v.sy + v.top, fo = FN[lane.fn];
        const sel = lane.fn === S.selFn, hov = lane.fn === S.hoverFn;
        if (sel || hov) { ctx.fillStyle = sel ? "#22304f" : "#1d2230"; ctx.fillRect(0, y, v.left - 1, LANE); }
        ctx.fillStyle = fo ? fillFor(lane.fn) : "#333"; ctx.fillRect(10, y + 7, 8, 8);
        const pct = fmtPct(lane.total), pctW = pct.length * v.charW;
        ctx.fillStyle = "#687088"; ctx.fillText(pct, v.left - 10 - pctW, y + LANE / 2);
        ctx.fillStyle = S.match && fo && !S.match[lane.fn] ? "#4c5368" : "#c9cfdc";
        ctx.fillText(v.fit(fo ? fo.disp : "(no Python frames)", v.left - 44 - pctW), 26, y + LANE / 2);
      }
      v.drawAxis(ctx);
      ctx.fillStyle = "#0e1117"; ctx.fillRect(0, 0, v.left, AXIS);
      ctx.fillStyle = "#687088"; ctx.fillText(lanes.length + " lanes · by share of time", 12, AXIS / 2);
      ctx.fillStyle = "#20252f"; ctx.fillRect(0, AXIS - 1, v.left, 1); ctx.fillRect(v.left - 1, 0, 1, AXIS);
    },
    hit(px, py, v) {
      const li = Math.floor((py - v.top + v.sy) / LANE), lane = lanes[li];
      if (!lane) return null;
      if (px < v.left) return { kind: "lane", key: lane, lane, fn: lane.fn, y: li * LANE, h: LANE };
      const s = sampleAt(v.pxToX(px));
      if (tk.laneOf[s] !== li) return null;
      const r = findAt(lane.runs, T.starts[s] / T.total + 1e-12) || lane.runs[0];
      return { kind: "tsample", key: "s" + s, lane, s, run: r, fn: tk.leafFn[s], line: tk.leafLine[s], x: r.x, w: r.w, y: li * LANE, h: LANE };
    },
  };
}

/* ═══════════════════════════ Tooltip ═══════════════════════════ */

const tipEl = $("#tip");
function showTip(html, e) {
  tipEl.innerHTML = html; tipEl.hidden = false;
  moveTip(e);
}
function moveTip(e) {
  if (tipEl.hidden) return;
  const r = tipEl.getBoundingClientRect(), pad = 14;
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > innerWidth - 6) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 6) y = e.clientY - r.height - pad;
  tipEl.style.left = Math.max(6, x) + "px"; tipEl.style.top = Math.max(6, y) + "px";
}
function hideTip() { tipEl.hidden = true; }

function fnHeader(fn, line) {
  const fo = FN[fn];
  if (!fo) return '<div class="t-name">(unknown)</div>';
  const loc = fo.rel ? esc(fo.rel) + (line || fo.line ? ":" + (line || fo.line) : "") : (fo.synth ? "collapsed frames" : "");
  return '<div class="t-name"><span class="dot" style="background:' + fillFor(fn) + '"></span>' + esc(fo.disp) + '</div>' +
    '<div class="t-loc">' + loc + '<span class="pill ' + fo.cat + '">' + CAT_LABEL[fo.cat] + '</span></div>';
}
function grid(rows) { return '<div class="t-grid">' + rows.map(([k, v]) => "<span>" + k + "</span><span>" + v + "</span>").join("") + "</div>"; }

function tipFor(it) {
  if (it.kind === "node") {
    const n = it.node;
    if (n.fn < 0) return '<div class="t-name">All samples</div>' + grid([["Thread", esc(T.name)], ["Total", "<b>" + fmtV(T.total) + "</b>"], ["Samples", T.n.toLocaleString()]]) +
      '<div class="t-hint">Double-click empty space or press 0 to reset zoom</div>';
    const rows = [
      [S.view === "inverted" ? "Via this path" : "Total", "<b>" + fmtV(n.value) + "</b> · " + fmtPct(n.value)],
      ["Self", fmtV(n.self) + " · " + fmtPct(n.self)],
    ];
    if (n.parent && n.parent.fn >= 0) rows.push([S.view === "inverted" ? "Of callee" : "Of parent", fmtPct(n.value, n.parent.value)]);
    rows.push(["Function overall", fmtV(T.tot[n.fn]) + " · " + fmtPct(T.tot[n.fn])]);
    return fnHeader(n.fn, it.line) + grid(rows) + '<div class="t-hint">Click to select &amp; view source · Double-click to zoom</div>';
  }
  if (it.kind === "block") {
    const b = it.block;
    return fnHeader(b.fn) + grid([
      ["Duration", "<b>" + fmtV(b.w * T.total) + "</b> · " + fmtPct(b.w * T.total)],
      ["Starts at", fmtAxis(b.x * T.total * (T.timed ? T.scale : 1), 0.001)],
      ["Samples", (b.s1 - b.s0).toLocaleString()],
    ]) + '<div class="t-hint">Click to select &amp; view source · Double-click to zoom</div>';
  }
  if (it.kind === "lane") {
    const l = it.lane;
    return fnHeader(l.fn) + grid([["Lane total", "<b>" + fmtV(l.total) + "</b> · " + fmtPct(l.total)], ["Active spans", l.runs.length.toLocaleString()]]) +
      '<div class="t-hint">Click to select &amp; view source</div>';
  }
  if (it.kind === "tsample") {
    const l = it.lane, stk = T.raw[it.s] || [], users = [];
    for (let k = stk.length - 1; k >= 0 && users.length < 7; k--) {
      const fo = FN[frameFn[stk[k]]];
      if (fo.cat === "user") users.push('<div><span class="dot" style="background:' + fo.color + '"></span>' + esc(fo.disp) + ' <span class="loc">' + esc(fo.rel) + ":" + frameLine[stk[k]] + "</span></div>");
    }
    return fnHeader(it.fn, it.line) + grid([
      ["Lane", esc(FN[l.fn] ? FN[l.fn].disp : "?")],
      ["This span", "<b>" + fmtV(it.run.w * T.total) + "</b>"],
      ["Lane total", fmtV(l.total) + " · " + fmtPct(l.total)],
    ]) + (users.length ? '<div class="t-stack">' + users.join("") + "</div>" : "") +
      '<div class="t-hint">Click to view source · Double-click to zoom to span</div>';
  }
  return "";
}

/* ═══════════════════════════ Virtual list ═══════════════════════════ */

class VList {
  constructor(el, rowH, render, rowClass) {
    this.el = el; this.rowH = rowH; this.render = render; this.rowClass = rowClass;
    this.items = []; this.raf = 0;
    this.inner = document.createElement("div"); this.inner.className = "vinner";
    el.appendChild(this.inner);
    el.addEventListener("scroll", () => this.request(), { passive: true });
    new ResizeObserver(() => this.request()).observe(el);
  }
  setItems(items, keepScroll) {
    this.items = items;
    this.inner.style.height = items.length * this.rowH + "px";
    if (!keepScroll) this.el.scrollTop = 0;
    this.paint();
  }
  request() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); }); }
  paint() {
    const h = this.el.clientHeight, top = this.el.scrollTop, n = this.items.length;
    const i0 = Math.max(0, Math.floor(top / this.rowH) - 10), i1 = Math.min(n, Math.ceil((top + h) / this.rowH) + 10);
    let html = "";
    for (let i = i0; i < i1; i++) {
      const it = this.items[i];
      html += '<div class="vrow ' + (this.rowClass ? this.rowClass(it) : "") + '" data-i="' + i + '" style="top:' + (i * this.rowH) + 'px">' + this.render(it, i) + "</div>";
    }
    this.inner.innerHTML = html;
  }
  restyle() {
    for (const r of this.inner.children) r.className = "vrow " + (this.rowClass ? this.rowClass(this.items[+r.dataset.i]) : "");
  }
  itemFromEvent(e) { const r = e.target.closest(".vrow"); return r ? this.items[+r.dataset.i] : undefined; }
  reveal(i) {
    if (i < 0) return;
    const h = this.el.clientHeight, y = i * this.rowH;
    if (y < this.el.scrollTop || y + this.rowH > this.el.scrollTop + h) this.el.scrollTop = Math.max(0, y - h / 3);
  }
}

/* ═══════════════════════════ Functions table ═══════════════════════════ */

let fnList, treeList;

function metric(v, of, color) {
  const p = of ? v / of * 100 : 0;
  return '<div class="metric"><span class="bar" style="width:' + p.toFixed(2) + '%;background:' + color + '"></span>' +
    '<span class="v">' + fmtV(v) + '</span><span class="p">' + fmtPct(v) + "</span></div>";
}

function refreshFunctions(keepScroll) {
  const q = S.search.trim().toLowerCase();
  let ids = [];
  for (let f = 0; f < FN.length; f++) if (T.tot[f] > 0 && (!S.match || S.match[f])) ids.push(f);
  const { key, asc } = S.sort, dir = asc ? 1 : -1;
  const cmp = {
    self: (a, b) => (T.self[a] - T.self[b]) || (T.tot[a] - T.tot[b]),
    total: (a, b) => (T.tot[a] - T.tot[b]) || (T.self[a] - T.self[b]),
    name: (a, b) => FN[b].disp.localeCompare(FN[a].disp),
    file: (a, b) => (FN[b].rel || "~").localeCompare(FN[a].rel || "~") || FN[b].line - FN[a].line,
  }[key];
  ids.sort((a, b) => dir * cmp(a, b));
  fnList.setItems(ids, keepScroll);
  $$("#fn-head .sortable").forEach(h => { h.classList.toggle("sorted", h.dataset.sort === key); h.classList.toggle("asc", h.dataset.sort === key && asc); });
  if (S.tab === "functions") $("#tab-info").textContent = ids.length.toLocaleString() + " functions" + (q ? " matching" : "");
}

function renderFnRow(f) {
  const fo = FN[f];
  return metric(T.self[f], T.total, "#f0695a") + metric(T.tot[f], T.total, "#82a0ff") +
    '<div class="t-name" title="' + esc(fo.disp + (fo.rel ? "\n" + fo.rel + ":" + hotLine(f) : "")) + '"><span class="dot" style="background:' + fillFor(f) + '"></span><span class="nm">' + esc(fo.disp) + "</span></div>" +
    '<div class="loc" title="' + esc(fo.file) + '">' + (fo.rel ? esc(fo.rel) + ":" + hotLine(f) : fo.synth ? "collapsed" : "") + "</div>";
}

/* ═══════════════════════════ Call tree ═══════════════════════════ */

const TV = { expanded: new Set(), inv: null, root: null };

function refreshTree(reset) {
  const inv = S.view === "inverted", tree = getTree(inv);
  if (reset || TV.root !== tree.root) {
    TV.root = tree.root; TV.inv = inv; TV.expanded = new Set();
    let budget = 400;
    const auto = n => { for (const k of n.kids) if (k.value >= T.total * 0.08 && budget-- > 0) { TV.expanded.add(k); auto(k); } };
    auto(tree.root);
  }
  const out = [];
  const walk = (n, d) => { for (const k of n.kids) { out.push({ n: k, d }); if (TV.expanded.has(k)) walk(k, d + 1); } };
  walk(TV.root, 0);
  treeList.setItems(out, !reset);
  if (S.tab === "tree") $("#tab-info").textContent = inv ? "bottom-up (callers below)" : "top-down";
}

function renderTreeRow(it) {
  const n = it.n, fo = FN[n.fn], open = TV.expanded.has(n), d = it.d;
  return '<div class="t-name" style="padding-left:min(' + (d * 10) + 'px, 45%)">' +
    (d >= 12 ? '<span class="depth-badge" title="Call depth">' + d + "</span>" : "") +
    '<span class="caret" data-caret="1">' + (n.kids.length ? (open ? "▾" : "▸") : "") + "</span>" +
    '<span class="dot" style="background:' + fillFor(n.fn) + '"></span><span class="nm">' + esc(fo.disp) + "</span>" +
    '<span class="loc">' + esc(fo.rel ? fo.rel + ":" + (maxKey(n.lines) || fo.line) : "") + "</span></div>" +
    metric(n.value, T.total, "#82a0ff") +
    '<div class="num loc">' + (n.self ? fmtV(n.self) : "") + "</div>";
}

function toggleTreeNode(n, deep) {
  if (!n.kids.length) return;
  if (TV.expanded.has(n)) {
    TV.expanded.delete(n);
    if (deep) { const rm = x => { for (const k of x.kids) { TV.expanded.delete(k); rm(k); } }; rm(n); }
  } else {
    TV.expanded.add(n);
    if (deep) { let budget = 300; const add = x => { for (const k of x.kids) if (budget-- > 0) { TV.expanded.add(k); add(k); } }; add(n); }
  }
  refreshTree(false);
}

/* ═══════════════════════════ Callers & callees ═══════════════════════════ */

function renderCalls() {
  const el = $("#calls"), fn = S.selFn;
  if (fn < 0 || !FN[fn] || !(T.tot[fn] > 0)) {
    el.innerHTML = '<div class="placeholder">Select a function (click it in the graph or a table) to see who calls it and what it calls.</div>';
    return;
  }
  const { n, w, offs, sFn, sLine } = T;
  const callers = new Map(), callees = new Map();
  const bump = (m, f, ln, ws, site) => {
    let e = m.get(f);
    if (!e) m.set(f, e = { f, w: 0, lines: new Map(), sites: new Map() });
    e.w += ws;
    if (ln > 0) e.lines.set(ln, (e.lines.get(ln) || 0) + ws);
    if (site > 0) e.sites.set(site, (e.sites.get(site) || 0) + ws);
  };
  for (let s = 0; s < n; s++) {
    const a = offs[s], b = offs[s + 1], ws = w[s];
    let seenR = null, seenE = null;
    for (let k = a; k < b; k++) {
      if (sFn[k] !== fn) continue;
      const cr = k > a ? sFn[k - 1] : -2, ce = k + 1 < b ? sFn[k + 1] : -1;
      if (!seenR || !seenR.has(cr)) { (seenR || (seenR = new Set())).add(cr); bump(callers, cr, k > a ? sLine[k - 1] : 0, ws, 0); }
      if (!seenE || !seenE.has(ce)) { (seenE || (seenE = new Set())).add(ce); bump(callees, ce, k + 1 < b ? sLine[k + 1] : 0, ws, sLine[k]); }
    }
  }
  const total = T.tot[fn], fo = FN[fn];
  const row = (e, kind) => {
    const pct = e.w / total * 100, bar = '<span class="bar" style="width:' + pct.toFixed(2) + '%"></span>';
    const nums = '<span class="pct">' + fmtPct(e.w, total) + '</span><span class="time">' + fmtV(e.w) + "</span>";
    if (e.f === -1) return '<div class="crow self">' + bar + nums + '<span class="nm">(self time in this function)</span><span></span></div>';
    if (e.f === -2) return '<div class="crow self">' + bar + nums + '<span class="nm">(thread entry point)</span><span></span></div>';
    const c = FN[e.f], ln = maxKey(e.lines) || c.line, site = maxKey(e.sites);
    const chip = kind === "callee" && site ? '<button class="chip" data-site="' + site + '" title="Show where ' + esc(fo.disp) + ' calls this">from L' + site + "</button>"
      : kind === "caller" && ln ? '<span class="loc">calls at L' + ln + "</span>" : "<span></span>";
    return '<div class="crow" data-fn="' + e.f + '" data-line="' + ln + '" title="' + esc(c.disp + (c.rel ? "  " + c.rel + ":" + ln : "")) + '">' + bar + nums +
      '<span class="nm"><span class="dot" style="background:' + fillFor(e.f) + '"></span>' + esc(c.disp) + '<span class="loc">' + esc(c.rel) + "</span></span>" + chip + "</div>";
  };
  const list = (m, kind) => {
    const arr = Array.from(m.values()).sort((a, b) => b.w - a.w).slice(0, 200);
    return arr.length ? arr.map(e => row(e, kind)).join("") : '<div class="placeholder">None</div>';
  };
  el.innerHTML =
    '<div class="calls-head"><span class="dot" style="background:' + fillFor(fn) + '"></span><span class="title">' + esc(fo.disp) + '</span>' +
    '<span class="loc">' + esc(fo.rel || "") + '</span><span class="grow"></span>' +
    '<span class="stat">total <b>' + fmtV(total) + "</b> (" + fmtPct(total) + ')</span><span class="stat">self <b>' + fmtV(T.self[fn]) + "</b> (" + fmtPct(T.self[fn]) + ")</span>" +
    (fo.file && !fo.synth ? '<button class="chip" data-src="1">view source</button>' : "") + "</div>" +
    '<div class="calls-cols"><div class="calls-col"><h4>Called by</h4>' + list(callers, "caller") + "</div>" +
    '<div class="calls-col"><h4>Calls into</h4>' + list(callees, "callee") + "</div></div>";
  if (S.tab === "calls") $("#tab-info").textContent = "% of " + fo.disp + " total";
}

/* ═══════════════════════════ Source viewer ═══════════════════════════ */

const SRC = { cache: new Map(), file: null, thread: -1, lines: null, rows: null, tok: 0, cur: 0, range: null };

const PY_KW = new Set(("False None True and as assert async await break class continue def del elif else except finally for from " +
  "global if import in is lambda nonlocal not or pass raise return try while with yield match case type").split(" "));
const PY_BI = new Set(("print len range dict list set tuple str int float bool bytes type isinstance issubclass super object enumerate " +
  "zip map filter sorted reversed min max sum any all open getattr setattr hasattr delattr iter next repr abs round id hash callable " +
  "vars dir format frozenset property staticmethod classmethod NotImplemented Ellipsis").split(" "));

function highlightPy(lines) {
  const out = new Array(lines.length);
  let open = null;
  const sp = (c, s) => '<span class="tk-' + c + '">' + esc(s) + "</span>";
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li], len = line.length;
    let h = "", i = 0, prev = "";
    if (open) {
      const end = line.indexOf(open);
      if (end < 0) { out[li] = sp("str", line); continue; }
      h += sp("str", line.slice(0, end + 3)); i = end + 3; open = null;
    }
    while (i < len) {
      const c = line[i];
      if (c === "#") { h += sp("com", line.slice(i)); break; }
      let strStart = -1, q = "";
      if (c === '"' || c === "'") { strStart = i; q = c; }
      else if (/[A-Za-z_]/.test(c)) {
        let j = i + 1;
        while (j < len && /\w/.test(line[j])) j++;
        const word = line.slice(i, j);
        if (j < len && (line[j] === '"' || line[j] === "'") && /^[rbufRBUF]{1,2}$/.test(word)) { strStart = i; q = line[j]; i = j; }
        else {
          let cls = "";
          if (prev === "def" || prev === "class") cls = "def";
          else if (PY_KW.has(word)) cls = "kw";
          else if (word === "self" || word === "cls") cls = "self";
          else if (PY_BI.has(word)) cls = "bi";
          else if (/^\s*\(/.test(line.slice(j, j + 3))) cls = /^[A-Z]/.test(word) ? "cls" : "call";
          else if (/^[A-Z][a-z]/.test(word) && /[a-z]/.test(word)) cls = "cls";
          h += cls ? sp(cls, word) : esc(word);
          prev = word; i = j; continue;
        }
      }
      if (strStart >= 0) {
        const triple = line.substr(i, 3) === q + q + q;
        let j;
        if (triple) {
          const end = line.indexOf(q + q + q, i + 3);
          if (end < 0) { h += sp("str", line.slice(strStart)); open = q + q + q; i = len; break; }
          j = end + 3;
        } else {
          j = i + 1;
          while (j < len && line[j] !== q) j += line[j] === "\\" ? 2 : 1;
          j = Math.min(len, j + 1);
        }
        h += sp("str", line.slice(strStart, j)); i = j; prev = ""; continue;
      }
      if (/[0-9]/.test(c) && !/\w/.test(line[i - 1] || "")) {
        let j = i + 1;
        while (j < len && /[0-9a-fA-FxXoObBeE_.jJ]/.test(line[j])) j++;
        h += sp("num", line.slice(i, j)); i = j; continue;
      }
      if (c === "@" && /^\s*$/.test(line.slice(0, i))) {
        let j = i + 1;
        while (j < len && /[\w.]/.test(line[j])) j++;
        h += sp("dec", line.slice(i, j)); i = j; continue;
      }
      if (c !== " " && c !== "\t") prev = "";
      h += esc(c); i++;
    }
    out[li] = h;
  }
  return out;
}

function enclosingFn(lines, line) {
  const ind = s => s.length - s.trimStart().length;
  let i = clamp(line - 1, 0, lines.length - 1);
  while (i > 0 && !lines[i].trim()) i--;
  const ti = ind(lines[i]);
  let start = -1;
  for (let j = i; j >= 0; j--) {
    const m = /^(\s*)(?:async\s+def|def|class)\s/.exec(lines[j]);
    if (m && (j === i || m[1].length < ti)) { start = j; break; }
  }
  if (start < 0) return null;
  while (start > 0 && /^\s*@/.test(lines[start - 1])) start--;
  let di = ind(lines[start]), k = start;
  while (/^\s*@/.test(lines[k]) && k < lines.length - 1) k++;
  di = ind(lines[k]);
  let open = 0, end = k;
  for (let j = k; j < lines.length; j++) {
    const s = lines[j], t = s.trim();
    if (j > k && t && open <= 0 && ind(s) <= di && !t.startsWith("#") && !/^[)\]}]/.test(t)) break;
    if (t) end = j;
    for (const ch of t) { if ("([{".includes(ch)) open++; else if (")]}".includes(ch)) open--; }
  }
  return [start + 1, end + 1];
}

function setSourcePanel(open) {
  $("#main").classList.toggle("with-side", open);
  $("#btn-source").classList.toggle("on", open);
  store.set("sourceOpen", open);
}
const sourceOpen = () => $("#main").classList.contains("with-side");

async function openSource(fn, line) {
  const fo = FN[fn];
  if (!fo) return;
  setSourcePanel(true);
  const body = $("#src-body");
  $("#src-fn").textContent = fo.disp;
  $("#src-path").textContent = fo.file ? "\u200e" + (fo.rel || fo.file) + (line ? ":" + line : "") + "\u200e" : "";
  $("#src-path").title = fo.file;
  const tok = ++SRC.tok;
  if (!fo.file || fo.synth || fo.file.startsWith("<")) {
    SRC.file = null;
    body.innerHTML = '<div class="src-msg">' + (fo.synth
      ? "This is a group of collapsed library frames. Switch <b>Frames</b> to “All frames” to see the individual functions."
      : "No source file for this frame (" + esc(fo.file || "native/builtin") + ").") + "</div>";
    return;
  }
  if (SRC.file !== fo.file || SRC.thread !== T.index) {
    body.innerHTML = '<div class="src-msg">Loading…</div>';
    let p = SRC.cache.get(fo.file);
    if (!p) {
      p = fetch("/api/source?path=" + encodeURIComponent(fo.file)).then(r => r.json()).catch(err => ({ error: err.message }));
      SRC.cache.set(fo.file, p);
    }
    const data = await p;
    if (tok !== SRC.tok) return;
    if (data.error) {
      SRC.cache.delete(fo.file); SRC.file = null;
      body.innerHTML = '<div class="src-msg err">' + esc(data.error) + "</div>";
      return;
    }
    renderSource(fo.file, data);
  }
  setSourceTarget(line || hotLine(fn) || fo.line);
}

function renderSource(file, data) {
  const lines = (data.content || "").split("\n"), sl = data.start_line || 1;
  const hl = /\.pyx?$|\.pxd$/.test(file) ? highlightPy(lines) : lines.map(esc);
  const stats = T.lineStats.get(file);
  const parts = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const ln = sl + i, e = stats && stats.get(ln);
    let cls = "l", style = "", heat = "";
    if (e) {
      const p = e[1] / T.total * 100;
      heat = '<i style="width:' + Math.max(2, Math.min(60, p * 0.6)).toFixed(1) + 'px"></i><b>' + fmtPct(e[1]) + "</b>";
      if (p >= 0.5) { cls += " hot"; style = ' style="--h:' + Math.min(0.26, 0.04 + p / 100 * 0.3).toFixed(3) + '"'; }
    }
    const title = e ? ' title="Line ' + ln + ": " + fmtV(e[1]) + " inclusive (" + fmtPct(e[1]) + "), " + fmtV(e[0]) + ' self"' : "";
    parts[i] = '<div class="' + cls + '"' + style + title + '><span class="no">' + ln + '</span><span class="heat">' + heat + '</span><span class="code">' + (hl[i] || " ") + "</span></div>";
  }
  const body = $("#src-body");
  body.innerHTML = '<div class="src">' + parts.join("") + "</div>";
  SRC.file = file; SRC.thread = T.index; SRC.lines = lines; SRC.start = sl;
  SRC.rows = body.firstChild.children; SRC.cur = 0; SRC.range = null;
}

function setSourceTarget(line) {
  if (!SRC.rows) return;
  const rows = SRC.rows, sl = SRC.start, row = i => rows[i - sl];
  if (SRC.cur && row(SRC.cur)) row(SRC.cur).classList.remove("cur");
  if (SRC.range) for (let i = SRC.range[0]; i <= SRC.range[1]; i++) row(i) && row(i).classList.remove("infn");
  SRC.cur = line;
  SRC.range = line ? enclosingFn(SRC.lines, line - sl + 1) : null;
  if (SRC.range) { SRC.range = [SRC.range[0] + sl - 1, SRC.range[1] + sl - 1]; for (let i = SRC.range[0]; i <= SRC.range[1]; i++) row(i) && row(i).classList.add("infn"); }
  if (line && row(line)) row(line).classList.add("cur");
  const body = $("#src-body");
  if (line) {
    let y = (line - sl) * LINE_H - body.clientHeight * 0.35;
    if (SRC.range) { const fy = (SRC.range[0] - sl) * LINE_H - 30; if (fy < y && (line - SRC.range[0]) * LINE_H < body.clientHeight * 0.6) y = fy; }
    body.scrollTop = Math.max(0, y);
    body.scrollLeft = 0;
  }
}

/* ═══════════════════════════ App wiring ═══════════════════════════ */

let chart;

function modelForView() {
  if (!T || !T.n) return null;
  switch (S.view) {
    case "inverted": return flameModel(true);
    case "timeline": return timelineModel();
    case "tasks": return tasksModel();
    default: return flameModel(false);
  }
}

function setView(v, keep) {
  const prev = S.view;
  S.view = v; store.set("view", v);
  $$("#views button").forEach(b => b.classList.toggle("on", b.dataset.view === v));
  const timeLike = x => x === "timeline" || x === "tasks";
  chart.setModel(modelForView(), keep !== undefined ? keep : (timeLike(prev) && timeLike(v)));
  updateChartInfo();
  if ((prev === "inverted") !== (v === "inverted")) refreshTree(true);
}

function updateChartInfo() {
  if (!T) return;
  const parts = ["<b>" + esc(T.name) + "</b>", fmtV(T.total), T.n.toLocaleString() + " samples"];
  if (S.view === "timeline" || S.view === "tasks") {
    if (T.timed) parts.push("x-axis: sampled time (idle gaps removed)");
    if (S.view === "tasks") parts.push(getTasks().lanes.length + " lanes");
  } else parts.push("depth " + T.maxDepth);
  $("#chart-info").innerHTML = parts.join(" · ");
  $("#plot-empty").hidden = T.n > 0;
  $("#plot-empty").textContent = "This thread has no samples.";
}

function onChartView() {
  const z = 1 / chart.span;
  let txt = z < 10 ? z.toFixed(z < 1.05 ? 0 : 1) + "×" : z < 1000 ? Math.round(z) + "×" : (z / 1000).toFixed(1) + "k×";
  $("#zoom-level").textContent = txt;
}

let hintTimer = 0;
function flashHint() {
  const h = $("#chart-hint");
  h.classList.add("flash");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => h.classList.remove("flash"), 900);
}

function setHover(fn) {
  if (fn === S.hoverFn) return;
  S.hoverFn = fn;
  chart.request();
  fnList.restyle();
}

function select(fn, line, opts = {}) {
  if (fn == null || fn < 0 || !FN[fn]) {
    S.selFn = -1;
  } else {
    S.selFn = fn;
  }
  chart.request();
  fnList.restyle();
  treeList.restyle();
  renderCalls();
  updateStatus();
  if (S.selFn >= 0) {
    if (opts.reveal !== false) fnList.reveal(fnList.items.indexOf(fn));
    if (opts.source !== false) openSource(fn, line);
  }
}

function updateStatus() {
  const el = $("#status-sel"), fn = S.selFn;
  if (fn < 0 || !T) { el.innerHTML = ""; return; }
  const fo = FN[fn];
  el.innerHTML = "selected <b>" + esc(fo.disp) + "</b> · total " + fmtV(T.tot[fn]) + " (" + fmtPct(T.tot[fn]) + ") · self " + fmtV(T.self[fn]) + " (" + fmtPct(T.self[fn]) + ")";
}

function setTab(tab) {
  S.tab = tab; store.set("tab", tab);
  $$("#tabs [data-tab]").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  $$(".tab-body").forEach(b => { b.hidden = b.dataset.body !== tab; });
  $("#left").classList.remove("collapsed");
  if (tab === "functions") { fnList.request(); refreshFunctions(true); }
  if (tab === "tree") refreshTree(false);
  if (tab === "calls") renderCalls();
}

function rebuildAll(resetSel) {
  prepareThread();
  if (resetSel) S.selFn = -1;
  if (S.selFn >= 0 && !(T.tot[S.selFn] > 0)) S.selFn = -1;
  S.hoverFn = -1;
  SRC.thread = -1;
  chart.setModel(modelForView(), false);
  updateChartInfo();
  refreshFunctions(false);
  refreshTree(true);
  renderCalls();
  updateStatus();
  if (sourceOpen() && S.selFn >= 0) openSource(S.selFn, SRC.cur || 0);
}

function initThreads() {
  const sel = $("#thread"), profs = S.raw.profiles || [];
  const sums = profs.map(p => (Array.isArray(p.weights) && p.weights.length ? p.weights.reduce((a, b) => a + (+b || 0), 0) : (p.samples || []).length));
  const order = profs.map((_, i) => i).sort((a, b) => sums[b] - sums[a]);
  sel.innerHTML = order.map(i => {
    const p = profs[i], m = /"([^"]*)"/.exec(p.name || ""), tid = /Thread (\d+)/.exec(p.name || "");
    const nm = (m && m[1]) || (tid ? "Thread " + tid[1] : p.name || "Thread " + i);
    const scale = UNIT_SCALE[p.unit];
    const amt = scale !== undefined ? fmtDur(sums[i] * scale) : sums[i] + " samples";
    return '<option value="' + i + '">' + esc(nm) + " — " + amt + "</option>";
  }).join("");
  S.thread = order.length ? order[0] : 0;
  sel.value = String(S.thread);
  sel.addEventListener("change", () => { S.thread = +sel.value; rebuildAll(true); });
}

function bindUI() {
  chart.onView = onChartView;
  chart.onHover = (it, e, same) => {
    if (!it) { hideTip(); setHover(-1); return; }
    setHover(it.fn);
    if (same) moveTip(e); else showTip(tipFor(it), e);
  };
  chart.onClick = it => {
    if (!it) return;
    hideTip();
    if (it.kind === "node" && it.fn < 0) return;
    let line = it.line;
    if (it.kind === "block") {
      const b = it.block, m = new Map();
      for (let s = b.s0; s < b.s1; s++) { const ln = T.sLine[T.offs[s] + b.d]; if (ln > 0) m.set(ln, (m.get(ln) || 0) + T.w[s]); }
      line = maxKey(m);
    }
    if (it.kind === "lane") line = hotLine(it.fn);
    select(it.fn, line);
  };

  $$("#views button").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
  $$(".zoom button").forEach(b => b.addEventListener("click", () => {
    const z = b.dataset.zoom;
    if (z === "in") chart.zoomCenter(0.5); else if (z === "out") chart.zoomCenter(2); else chart.animateTo(0, 1);
  }));

  const frames = $("#frames"), color = $("#color");
  frames.value = S.frames; color.value = S.color;
  frames.addEventListener("change", () => { S.frames = frames.value; store.set("frames", S.frames); rebuildAll(false); });
  color.addEventListener("change", () => {
    S.color = color.value; store.set("color", S.color);
    $("#legend-module").hidden = S.color !== "module"; $("#legend-heat").hidden = S.color === "module";
    chart.invalidate(); fnList.paint(); treeList.paint(); renderCalls();
  });
  $("#legend-module").hidden = S.color !== "module"; $("#legend-heat").hidden = S.color === "module";

  let st = 0;
  const search = $("#search");
  search.addEventListener("input", () => {
    clearTimeout(st);
    st = setTimeout(() => { S.search = search.value; updateSearchMatch(); chart.request(); refreshFunctions(false); }, 90);
  });
  search.addEventListener("keydown", e => {
    if (e.key === "Escape") { search.value = ""; S.search = ""; updateSearchMatch(); chart.request(); refreshFunctions(false); search.blur(); e.stopPropagation(); }
    if (e.key === "Enter") { const f = fnList.items[0]; if (f !== undefined) select(f, 0); }
  });

  // Functions list
  const fl = $("#fn-list");
  fl.addEventListener("click", e => { const f = fnList.itemFromEvent(e); if (f !== undefined) select(f, 0, { reveal: false }); });
  fl.addEventListener("mouseover", e => { const f = fnList.itemFromEvent(e); setHover(f === undefined ? -1 : f); });
  fl.addEventListener("mouseleave", () => setHover(-1));
  $$("#fn-head .sortable").forEach(h => h.addEventListener("click", () => {
    const k = h.dataset.sort;
    if (S.sort.key === k) S.sort.asc = !S.sort.asc; else S.sort = { key: k, asc: k === "name" || k === "file" };
    refreshFunctions(false);
  }));

  // Call tree
  const tl = $("#tree-list");
  tl.addEventListener("click", e => {
    const it = treeList.itemFromEvent(e);
    if (!it) return;
    if (e.target.closest("[data-caret]") && it.n.kids.length) { toggleTreeNode(it.n, e.altKey || e.shiftKey); return; }
    select(it.n.fn, maxKey(it.n.lines), { reveal: true });
  });
  tl.addEventListener("dblclick", e => {
    const it = treeList.itemFromEvent(e);
    if (!it || e.target.closest("[data-caret]")) return;
    const want = TV.inv ? "inverted" : "flame";
    if (S.view !== want) setView(want, false);
    const n = it.n;
    chart.zoomToItem({ x: n.x, w: n.w, y: n.depth * ROW, h: ROW });
  });
  tl.addEventListener("mouseover", e => { const it = treeList.itemFromEvent(e); setHover(it ? it.n.fn : -1); });
  tl.addEventListener("mouseleave", () => setHover(-1));
  tl.tabIndex = 0;
  tl.addEventListener("keydown", e => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const it = treeList.items.find(x => x.n.fn === S.selFn);
    if (!it) return;
    const open = TV.expanded.has(it.n);
    if ((e.key === "ArrowRight") !== open) toggleTreeNode(it.n, false);
    e.preventDefault(); e.stopPropagation();
  });

  // Callers & callees
  $("#calls").addEventListener("click", e => {
    const site = e.target.closest("[data-site]");
    if (site) { e.stopPropagation(); openSource(S.selFn, +site.dataset.site); return; }
    if (e.target.closest("[data-src]")) { openSource(S.selFn, 0); return; }
    const r = e.target.closest(".crow[data-fn]");
    if (r) select(+r.dataset.fn, +r.dataset.line);
  });
  $("#calls").addEventListener("mouseover", e => { const r = e.target.closest(".crow[data-fn]"); setHover(r ? +r.dataset.fn : -1); });
  $("#calls").addEventListener("mouseleave", () => setHover(-1));

  // Tabs & panels
  $$("#tabs [data-tab]").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));
  $("#btn-collapse").addEventListener("click", () => {
    const c = $("#left").classList.toggle("collapsed");
    $("#btn-collapse").textContent = c ? "▴" : "▾";
    store.set("collapsed", c);
  });
  $("#btn-source").addEventListener("click", () => {
    if (sourceOpen()) setSourcePanel(false);
    else if (S.selFn >= 0) openSource(S.selFn, SRC.cur || 0);
    else { setSourcePanel(true); if (!SRC.file) $("#src-body").innerHTML = '<div class="src-msg">Click a function in the graph or tables to see its source with per-line timing.</div>'; }
  });
  $("#src-close").addEventListener("click", () => setSourcePanel(false));
  $("#btn-help").addEventListener("click", () => { $("#help").hidden = false; });
  $("#help").addEventListener("click", e => { if (e.target.id === "help" || e.target.closest("[data-close]")) $("#help").hidden = true; });

  bindSplitters();
  bindKeys();
}

function bindSplitters() {
  const left = $("#left"), main = $("#main");
  const sh = store.get("bottomH", 0), sw = store.get("sideW", 0);
  if (sh) left.style.setProperty("--bottom-h", sh + "px");
  if (sw) main.style.setProperty("--side-w", sw + "px");
  if (store.get("collapsed", false)) { left.classList.add("collapsed"); $("#btn-collapse").textContent = "▴"; }

  const drag = (el, cls, onMove) => {
    el.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add("drag"); document.body.classList.add("resizing", cls);
      const mv = ev => onMove(ev);
      const up = () => {
        el.classList.remove("drag"); document.body.classList.remove("resizing", cls);
        el.removeEventListener("pointermove", mv);
      };
      el.addEventListener("pointermove", mv);
      el.addEventListener("pointerup", up, { once: true });
      el.addEventListener("pointercancel", up, { once: true });
    });
  };
  drag($("#split-h"), "rows", e => {
    const r = left.getBoundingClientRect(), h = Math.round(clamp(r.bottom - e.clientY - 2, 34, r.height - 155));
    left.classList.remove("collapsed"); $("#btn-collapse").textContent = "▾"; store.set("collapsed", false);
    left.style.setProperty("--bottom-h", h + "px"); store.set("bottomH", h);
  });
  drag($("#split-v"), "cols", e => {
    const r = main.getBoundingClientRect(), w = Math.round(clamp(r.right - e.clientX - 2, 280, r.width - 385));
    main.style.setProperty("--side-w", w + "px"); store.set("sideW", w);
  });
}

function bindKeys() {
  document.addEventListener("keydown", e => {
    const inInput = e.target.matches("input, select, textarea");
    if (e.key === "Escape") {
      if (!$("#help").hidden) { $("#help").hidden = true; return; }
      if (inInput) { e.target.blur(); return; }
      if (sourceOpen()) { setSourcePanel(false); return; }
      if (chart.span < 0.9999) { chart.animateTo(0, 1); return; }
      if (S.selFn >= 0) select(-1);
      return;
    }
    if (inInput || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === "/") { e.preventDefault(); $("#search").focus(); $("#search").select(); return; }
    if (k === "?") { $("#help").hidden = !$("#help").hidden; return; }
    if (k === "1" || k === "2" || k === "3" || k === "4") { setView(["flame", "inverted", "timeline", "tasks"][+k - 1]); return; }
    if (k === "s" || k === "S") { $("#btn-source").click(); return; }
    if (e.target.closest(".vlist")) return;
    if (k === "+" || k === "=") { chart.zoomCenter(0.5); return; }
    if (k === "-" || k === "_") { chart.zoomCenter(2); return; }
    if (k === "0") { chart.animateTo(0, 1); return; }
    if (k === "ArrowLeft" || k === "ArrowRight") { e.preventDefault(); chart.cancelAnim(); chart.panPx((k === "ArrowLeft" ? -1 : 1) * chart.pw * 0.15); return; }
    if (k === "ArrowUp" || k === "ArrowDown") { e.preventDefault(); chart.scrollBy((k === "ArrowUp" ? -1 : 1) * ROW * 3); return; }
  });
}

async function boot() {
  try {
    const [mr, pr] = await Promise.all([fetch("/api/meta"), fetch("/api/profile")]);
    if (!mr.ok) throw new Error("Failed to load metadata (HTTP " + mr.status + ")");
    if (!pr.ok) throw new Error("Failed to load profile (HTTP " + pr.status + ")");
    S.meta = await mr.json();
    S.raw = await pr.json();
  } catch (err) {
    const m = $("#loading .msg");
    m.classList.add("err");
    m.textContent = "Failed to load profile data: " + err.message;
    $("#loading .spinner").hidden = true;
    return;
  }
  S.cwd = normPath(S.meta.cwd || "").replace(/\/+$/, "");
  const target = S.meta.command || S.meta.script || "unknown";
  const ts = (S.meta.timestamp || "").replace("T", " ").replace(/\.\d+$/, "");
  $("#target").innerHTML = "<b>" + esc(target) + "</b>" + (ts ? " · " + esc(ts) : "");
  $("#target").title = target + (S.meta.cwd ? "\ncwd: " + S.meta.cwd : "");
  document.title = "codexplore · " + target;

  buildFunctions();
  $("#app").hidden = false;
  $("#loading").hidden = true;

  chart = new Chart();
  fnList = new VList($("#fn-list"), 24, renderFnRow, f => "fn-cols" + (f === S.selFn ? " sel" : f === S.hoverFn ? " hov" : ""));
  treeList = new VList($("#tree-list"), 24, renderTreeRow, it => "tree-cols" + (it && it.n.fn === S.selFn ? " sel" : ""));
  initThreads();
  bindUI();
  prepareThread();
  $$("#views button").forEach(b => b.classList.toggle("on", b.dataset.view === S.view));
  chart.setModel(modelForView(), false);
  updateChartInfo();
  setTab(S.tab);
  refreshFunctions(false);
  refreshTree(true);
  renderCalls();
  if (store.get("sourceOpen", false)) {
    setSourcePanel(true);
    $("#src-body").innerHTML = '<div class="src-msg">Click a function in the graph or tables to see its source with per-line timing.</div>';
  }
}

document.addEventListener("DOMContentLoaded", boot);
})();
