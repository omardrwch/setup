(() => {
"use strict";

/* ═══════════════════════════ Constants ═══════════════════════════ */

const ROW = 18;          // flame / timeline row height (px)
const LANE = 22;         // task lane height (px)
const AXIS = 22;         // time axis height (px)
const BAND = 16;         // phase band height under the time axis (px)
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
const PROC_FRAME_RE = /^process (\d+):"([\s\S]*)"$/;   // root frames py-spy adds with --subprocesses
const BOOTSTRAP_FILE_RE = /(?:^|[\\/])threading\.py$|concurrent[\\/]futures[\\/]thread\.py$|multiprocessing[\\/](?:process|spawn|context|popen_\w+|pool|util)\.py$/;

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
  phaseLevel: clamp(+store.get("phaseLevel", 1) || 1, 1, 8),
  waiting: store.get("waiting", "hide") === "show" ? "show" : "hide",
  gutter: clamp(+store.get("gutter", GUTTER) || GUTTER, 120, 900),
  tl: null,   // wall-clock timeline data, for runs recorded with timestamps
};
const VIEWS = ["flame", "inverted", "timeline", "tasks", "map", "graph", "threads"];
const STATIC_VIEWS = new Set(["map", "graph", "threads"]);
if (!VIEWS.includes(S.view)) S.view = "flame";
if (!["functions", "tree", "calls", "phases", "during"].includes(S.tab)) S.tab = "functions";

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
    if (!fo) {
      fo = makeFn(name, file, line);
      fnByKey.set(key, fo);
      const pm = !file && PROC_FRAME_RE.exec(name);
      if (pm) { fo.proc = { pid: +pm[1], cmd: pm[2] }; fo.internal = true; }
    } else if (line > 0 && (fo.line === 0 || line < fo.line)) fo.line = line;
    frameFn[i] = fo.id;
    frameLine[i] = line;
  }
}

function synthFn(key, name, cat, group) {
  let fo = fnByKey.get(key);
  if (!fo) { fo = makeFn(name, "", 0, { cat, group, synth: true, rel: "", disp: name }); fnByKey.set(key, fo); fo.internal = false; }
  return fo.id;
}

/* ═══════════════════════════ Processes & threads ═══════════════════════════ */

let PROFILES = null, PROCS = null;

function shortCmd(cmd) {
  if (!cmd) {
    const c = S.meta?.command || S.meta?.script || "";
    return c ? shortCmd(c) : "main process";
  }
  if (/multiprocessing\.resource_tracker/.test(cmd)) return "multiprocessing resource tracker";
  if (/multiprocessing\.forkserver/.test(cmd)) return "multiprocessing fork server";
  if (/multiprocessing[.\w]*spawn|--multiprocessing-fork/.test(cmd)) return "multiprocessing worker";
  const toks = cmd.split(/\s+/).filter(Boolean);
  if (toks.length && /(?:^|\/)python[\d.]*$/.test(toks[0])) toks.shift();
  if (toks[0] === "-m") return toks.slice(0, 2).join(" ");
  if (toks[0] === "-c") { const code = toks.slice(1).join(" "); return "python -c " + (code.length > 30 ? code.slice(0, 29) + "…" : code); }
  if (toks.length) toks[0] = toks[0].split("/").pop();
  return toks.join(" ");
}

// Per-profile identity (process, thread id, name, active time) and the process tree.
function profileInfo() {
  if (PROFILES) return PROFILES;
  const profs = S.raw.profiles || [], frames = S.raw.shared?.frames || [];
  PROCS = new Map();
  PROFILES = profs.map((p, i) => {
    const m = /^(?:Process (\d+) )?Thread (\d+)(?: "([^"]*)")?/.exec(p.name || "") || [];
    const weights = Array.isArray(p.weights) && p.weights.length ? p.weights : null, idle = p.idle;
    let total = 0, wall = 0;
    if (weights) for (let s = 0; s < weights.length; s++) { const v = +weights[s] || 0; wall += v; if (!(idle && idle[s])) total += v; }
    else total = wall = (p.samples || []).length;
    const scale = UNIT_SCALE[p.unit], timed = !!weights && scale !== undefined;
    const chain = [];
    const stk = (p.samples || []).find(s => s && s.length) || [];
    for (const idx of stk) { const fo = FN[frameFn[idx]]; if (!fo || !fo.proc) break; chain.push(fo.proc); }
    const pid = m[1] ? +m[1] : chain.length ? chain[chain.length - 1].pid : 0;
    for (let k = 0; k < chain.length; k++) {
      const c = chain[k];
      if (!PROCS.has(c.pid)) PROCS.set(c.pid, { pid: c.pid, cmd: c.cmd, parent: k ? chain[k - 1].pid : 0, threads: [], total: 0 });
    }
    if (!PROCS.has(pid)) PROCS.set(pid, { pid, cmd: "", parent: 0, threads: [], total: 0 });
    const name = m[3] || "", tid = m[2] ? +m[2] : i;
    return {
      i, pid, tid, name, label: name || (tid === pid ? "MainThread" : "Thread " + tid), total, timed, scale: timed ? scale : 1,
      secs: timed ? total * scale : total, wall: timed ? wall * scale : wall,
    };
  });
  for (const pi of PROFILES) { const pr = PROCS.get(pi.pid); pr.threads.push(pi.i); pr.total += pi.secs; }
  for (const [pid, extra] of Object.entries(S.raw.codexplore?.processes || {})) {
    const pr = PROCS.get(+pid);
    if (!pr) continue;
    if (!pr.cmd) pr.cmd = extra.cmd || "";
    if (!pr.parent && PROCS.has(extra.ppid)) pr.parent = extra.ppid;
  }
  for (const pr of PROCS.values()) pr.short = shortCmd(pr.cmd);
  return PROFILES;
}

/* ═══════════════════════════ Per-thread processing ═══════════════════════════ */

// Appends the frame-filtered stack (root → leaf) of one raw sample to fnA / lnA.
function filterStack(stk, mode, fnA, lnA) {
  const start = fnA.length;
  let inLibRun = false;
  for (let i = 0; i < stk.length; i++) {
    const idx = stk[i], f = frameFn[idx];
    if (f === undefined) continue;
    const fo = FN[f];
    if (fo.proc) continue;
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
}

function prepareThread() {
  const p = S.raw.profiles[S.thread] || { samples: [] };
  let samples = p.samples || [], weights = Array.isArray(p.weights) && p.weights.length === samples.length ? p.weights : null;
  let times = p.times || null;
  if (p.idle && S.waiting === "hide") {
    const keep = [];
    for (let s = 0; s < samples.length; s++) if (!p.idle[s]) keep.push(s);
    samples = keep.map(s => samples[s]);
    if (weights) weights = keep.map(s => weights[s]);
    if (times) times = keep.map(s => times[s]);
  }
  const n = samples.length;
  const scale = UNIT_SCALE[p.unit];
  const w = new Float64Array(n), starts = new Float64Array(n + 1);
  let total = 0;
  for (let s = 0; s < n; s++) { starts[s] = total; w[s] = weights ? (+weights[s] || 0) : 1; total += w[s]; }
  starts[n] = total;

  // Filtered stacks (root → leaf), flattened.
  const mode = S.frames, fnA = [], lnA = [], offs = new Int32Array(n + 1);
  for (let s = 0; s < n; s++) {
    filterStack(samples[s] || [], mode, fnA, lnA);
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
  // lineCallees: file → line → callee fn → weight (what each source line calls into).
  const lineStats = new Map(), lineCallees = new Map(), fstamp = new Int32Array(frameFn.length).fill(-1);
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
      if (i === stk.length - 1) { e[0] += ws; continue; }
      let j = i + 1;
      while (j < stk.length && FN[frameFn[stk[j]]].internal) j++;
      if (j >= stk.length) continue;
      let fc = lineCallees.get(fo.file);
      if (!fc) lineCallees.set(fo.file, fc = new Map());
      let lc = fc.get(frameLine[idx]);
      if (!lc) fc.set(frameLine[idx], lc = new Map());
      const callee = frameFn[stk[j]];
      lc.set(callee, (lc.get(callee) || 0) + ws);
    }
  }

  const heat = new Array(nf);
  for (let f = 0; f < nf; f++) heat[f] = heatColor(total ? self[f] / total : 0);

  T = {
    index: S.thread, name: profileInfo()[S.thread]?.label || "Thread " + S.thread,
    timed: scale !== undefined, scale: scale || 1, n, w, starts, total, offs, sFn, sLine, maxDepth,
    self, tot, fnLines, lineStats, lineCallees, heat, raw: samples, times,
    tree: null, inv: null, timeline: null, tasks: null, treemap: null, edges: null, phases: new Map(),
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
  onGutterEdge(px) { return !!(this.model && this.model.gutter) && Math.abs(px - this.left) <= 4; }
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
    if (this.onResize) this.onResize();
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
    this.target = [a, b];
    const step = now => {
      if (id !== this.animId) return;
      const t = Math.min(1, (now - t0) / D), e = 1 - Math.pow(1 - t, 3);
      this.setRange(fa + (a - fa) * e, fb + (b - fb) * e);
      if (t < 1) requestAnimationFrame(step); else this.target = null;
    };
    requestAnimationFrame(step);
  }
  cancelAnim() { this.animId++; this.target = null; }
  // Zoom that counts as a navigation step (Back returns to the previous range).
  jumpTo(a, b) { navMark(); this.animateTo(a, b); }

  zoomToItem(it) {
    navMark();
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

  axisTotal() { return this.model && this.model.axisSpan != null ? this.model.axisSpan : T.timed ? T.total * T.scale : T.total; }
  drawAxis(ctx) {
    const W = this.W, left = this.left, tTot = this.axisTotal();
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
    const tTot = this.axisTotal();
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
    if (py < this.top) return this.model.hitHeader ? this.model.hitHeader(px, py, this) : null;
    return this.model.hit(px, py, this);
  }

  bindPlot() {
    const p = this.plot;
    let down = null;
    p.addEventListener("wheel", e => {
      if (!this.model) return;
      e.preventDefault();
      if (this.model.static) return;
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
      const r = p.getBoundingClientRect(), py = e.clientY - r.top;
      if (this.onGutterEdge(e.clientX - r.left)) { down = { gutter: true, x: e.clientX, g0: S.gutter }; return; }
      down = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, drag: false, brush: !!this.model.onBrush && py < AXIS };
    });
    p.addEventListener("pointermove", e => {
      if (!this.model) return;
      this.mouse = { clientX: e.clientX, clientY: e.clientY };
      if (down && down.gutter) {
        S.gutter = clamp(down.g0 + e.clientX - down.x, 120, Math.max(120, this.W * 0.6));
        hideTip(); this.request();
        return;
      }
      if (!down) p.classList.toggle("gutter-edge", this.onGutterEdge(e.clientX - p.getBoundingClientRect().left));
      if (down && down.brush) {
        const r = p.getBoundingClientRect();
        if (Math.abs(e.clientX - down.x) > 3) {
          down.drag = true; hideTip();
          this.selDrag = [this.pxToX(Math.max(this.left, down.x - r.left)), this.pxToX(clamp(e.clientX - r.left, this.left, this.W))];
          this.request();
        }
        return;
      }
      if (down) {
        if (!down.drag && !this.model.static && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) {
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
      if (this.model.cursor) this.request();
    });
    const end = e => {
      if (!down) return;
      if (down.gutter) { store.set("gutter", S.gutter); down = null; return; }
      const wasDrag = down.drag;
      if (down.brush && this.selDrag) {
        const [a, b] = this.selDrag;
        this.selDrag = null;
        if (wasDrag && e.type === "pointerup") this.model.onBrush(Math.min(a, b), Math.max(a, b));
        this.request();
      }
      down = null; this.dragging = false; p.classList.remove("grabbing");
      if (!wasDrag && e.type === "pointerup" && this.onClick) this.onClick(this.hitAt(e), e);
    };
    p.addEventListener("pointerup", end);
    p.addEventListener("pointercancel", end);
    p.addEventListener("pointerleave", e => { if (!down && this.model) { this.mouse = null; this.hover(null, e); if (this.model.cursor) this.request(); } });
    p.addEventListener("dblclick", e => {
      if (!this.model || e.target.closest(".hbar,.vbar")) return;
      if (this.onGutterEdge(e.clientX - p.getBoundingClientRect().left)) { S.gutter = GUTTER; store.set("gutter", GUTTER); this.request(); return; }
      const it = this.hitAt(e);
      if (this.model.static) { if (this.model.dblclick) this.model.dblclick(it); return; }
      if (it && it.w > 0) this.zoomToItem(it); else this.jumpTo(0, 1);
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
        if (s.moved) { const a = Math.min(s.x0, x), b = Math.max(s.x0, x); if (b > a) this.jumpTo(a, b); }
        else { const sp = this.span; this.jumpTo(x - sp / 2, x + sp / 2); }
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
    m.addEventListener("dblclick", () => this.jumpTo(0, 1));
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
    kind: "timeline", gutter: 0, top: AXIS + BAND, minSpan: Math.max(1e-7, 0.5 / Math.max(1, T.n)),
    hitHeader: phaseBandHit,
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
      drawPhaseBand(ctx, v);
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
    kind: "tasks", get gutter() { return S.gutter; }, top: AXIS + BAND, minSpan: Math.max(1e-7, 0.5 / Math.max(1, T.n)),
    hitHeader: phaseBandHit,
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
      drawPhaseBand(ctx, v);
      ctx.fillStyle = "#0e1117"; ctx.fillRect(0, 0, v.left, AXIS + BAND);
      ctx.fillStyle = "#687088"; ctx.fillText(lanes.length + " lanes · by share of time", 12, AXIS / 2);
      ctx.fillText("phases", 12, AXIS + BAND / 2);
      ctx.fillStyle = "#20252f"; ctx.fillRect(0, AXIS - 1, v.left, 1); ctx.fillRect(0, AXIS + BAND - 1, v.left, 1); ctx.fillRect(v.left - 1, 0, 1, AXIS + BAND);
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

/* ═══════════════════════════ Wall-clock lanes (all threads) ═══════════════════════════ */

const LSTRIP = 18, LPROC = 22, LIDLE = 18;
const LN = { cache: new Map(), mode: null, expanded: new Set(), collapsedProcs: new Set(), showIdle: new Set(), win: null, layout: null, init: false, hoverLane: -1 };
let hatchPat = null;

function hatch(ctx) {
  if (hatchPat) return hatchPat;
  const c = document.createElement("canvas"), dpr = window.devicePixelRatio || 1, n = Math.round(6 * dpr);
  c.width = c.height = n;
  const g = c.getContext("2d");
  g.fillStyle = "#171b25"; g.fillRect(0, 0, n, n);
  g.strokeStyle = "rgba(150,160,185,.28)"; g.lineWidth = dpr;
  g.beginPath(); g.moveTo(0, n); g.lineTo(n, 0); g.moveTo(-n / 2, n / 2); g.lineTo(n / 2, -n / 2); g.moveTo(n / 2, n * 1.5); g.lineTo(n * 1.5, n / 2); g.stroke();
  hatchPat = ctx.createPattern(c, "repeat");
  if (hatchPat && hatchPat.setTransform) hatchPat.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, 0, 0]));
  return hatchPat;
}

function procTree() {
  profileInfo();
  const out = [], kids = pid => Array.from(PROCS.values()).filter(c => c.parent === pid && c.pid !== pid).sort((a, b) => b.total - a.total);
  const visit = (pr, depth) => { out.push({ pr, depth }); for (const c of kids(pr.pid)) visit(c, depth + 1); };
  for (const r of Array.from(PROCS.values()).filter(p => !p.parent || !PROCS.has(p.parent)).sort((a, b) => b.total - a.total)) visit(r, 0);
  return out;
}

// One thread on the wall clock: segments [t0, t1) with their filtered stack, waiting flag and the
// function that best says what the thread is doing (deepest frame of your code, else the leaf).
function laneData(i) {
  if (LN.mode !== S.frames) { LN.cache.clear(); LN.mode = S.frames; LN.layout = null; }
  const hit = LN.cache.get(i);
  if (hit) return hit;
  const p = S.raw.profiles[i], samples = p.samples || [], n = samples.length, span = S.tl.span || 1;
  const t0 = new Float64Array(n), t1 = new Float64Array(n), idle = new Uint8Array(n), focus = new Int32Array(n), focusLine = new Int32Array(n), leaf = new Int32Array(n);
  const offs = new Int32Array(n + 1), fnA = [], lnA = [], runs = [];
  let active = 0;
  for (let s = 0; s < n; s++) {
    t0[s] = +p.times[s] || 0; t1[s] = t0[s] + (+p.weights[s] || 0); idle[s] = p.idle ? p.idle[s] : 0;
    const a = fnA.length;
    filterStack(samples[s] || [], S.frames, fnA, lnA);
    offs[s + 1] = fnA.length;
    let f = -1, ln = 0;
    for (let k = fnA.length - 1; k >= a; k--) if (FN[fnA[k]].cat === "user") { f = fnA[k]; ln = lnA[k]; break; }
    if (f < 0) { f = fnA[fnA.length - 1]; ln = lnA[lnA.length - 1]; }
    focus[s] = f; focusLine[s] = ln; leaf[s] = fnA.length > a ? fnA[fnA.length - 1] : -1;
    if (!idle[s]) active += t1[s] - t0[s];
    const last = runs[runs.length - 1];
    if (last && last.fn === f && last.idle === idle[s] && Math.abs(last.te - t0[s]) < 1e-6) { last.te = t1[s]; last.w = (last.te - last.ts) / span; last.s1 = s + 1; }
    else runs.push({ fn: f, idle: idle[s], ts: t0[s], te: t1[s], x: t0[s] / span, w: (t1[s] - t0[s]) / span, s0: s, s1: s + 1 });
  }
  const d = { i, n, t0, t1, idle, focus, focusLine, leaf, offs, sFn: Int32Array.from(fnA), sLine: Int32Array.from(lnA), runs, rows: null, active };
  LN.cache.set(i, d);
  return d;
}

// Flame-chart rows for an expanded lane, positioned on the wall clock.
function laneRows(d) {
  if (d.rows) return d.rows;
  const { n, t0, t1, idle, offs, sFn } = d, span = S.tl.span || 1, rows = [], open = [];
  for (let s = 0; s < n; s++) {
    if (s && t0[s] - t1[s - 1] > 1e-6) open.length = 0;
    const a = offs[s], len = offs[s + 1] - a, dur = t1[s] - t0[s];
    let k = 0;
    while (k < open.length && k < len && open[k].fn === sFn[a + k]) k++;
    for (let j = 0; j < k; j++) { const b = open[j]; b.te = t1[s]; b.w = (b.te - b.ts) / span; b.s1 = s + 1; b.wall += dur; if (idle[s]) b.waitW += dur; }
    open.length = k;
    for (let j = k; j < len; j++) {
      const b = { fn: sFn[a + j], d: j, ts: t0[s], te: t1[s], x: t0[s] / span, w: dur / span, s0: s, s1: s + 1, wall: dur, waitW: idle[s] ? dur : 0 };
      (rows[j] || (rows[j] = [])).push(b);
      open.push(b);
    }
  }
  for (let j = 0; j < rows.length; j++) if (!rows[j]) rows[j] = [];
  return (d.rows = rows);
}

function segAt(d, t) {
  let lo = 0, hi = d.n - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (d.t0[m] <= t) lo = m; else hi = m - 1; }
  return d.n && d.t0[lo] <= t && t < d.t1[lo] ? lo : -1;
}

function laneLayout() {
  if (LN.layout) return LN.layout;
  const info = profileInfo(), multi = PROCS.size > 1, tree = procTree();
  if (!LN.init) {
    LN.init = true;
    LN.expanded.add(S.thread);
    if (tree.length > 6) for (const { pr } of tree) if (pr.pid !== info[S.thread].pid) LN.collapsedProcs.add(pr.pid);
  }
  const items = [];
  let y = 0;
  for (const { pr, depth } of tree) {
    if (multi) { items.push({ type: "proc", pr, depth, y, h: LPROC }); y += LPROC; }
    if (multi && LN.collapsedProcs.has(pr.pid)) continue;
    const lanes = pr.threads.map(laneData).sort((a, b) => b.active - a.active);
    const shown = lanes.filter(d => d.active > 0 || d.i === S.thread || LN.showIdle.has(pr.pid)), hidden = lanes.filter(d => !shown.includes(d));
    for (const d of shown) {
      const exp = LN.expanded.has(d.i), rows = exp ? laneRows(d) : null, h = LSTRIP + (exp ? rows.length * ROW + 4 : 0);
      items.push({ type: "lane", d, pi: info[d.i], y, h, exp, rows });
      y += h;
    }
    if (hidden.length) { items.push({ type: "idle", pr, lanes: hidden, y, h: LIDLE }); y += LIDLE; }
  }
  return (LN.layout = { items, height: y });
}

function laneItemAt(y) {
  const { items } = laneLayout();
  let lo = 0, hi = items.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (items[m].y <= y) lo = m; else hi = m - 1; }
  const it = items[lo];
  return it && y >= it.y && y < it.y + it.h ? it : null;
}

// Phases of the current thread, mapped from its active-sample positions onto the wall clock.
function phaseWall(p) {
  if (!S.tl || !T.times) return [p.x, p.w];
  const span = S.tl.span || 1, a = T.times[p.s0], b = T.times[p.s1 - 1] + T.w[p.s1 - 1];
  return [a / span, Math.max(0, b - a) / span];
}

function lanesModel() {
  const span = S.tl.span || 1;
  const lay = () => laneLayout();
  return {
    kind: "lanes", get gutter() { return S.gutter; }, top: AXIS + BAND, minSpan: Math.max(1e-7, 2e-5 / span), axisSpan: span, cursor: true,
    hitHeader: (px, py, v) => phaseBandHit(px, py, v, phaseWall),
    onBrush(a, b) { if ((b - a) * span > 1e-4) setWindow({ t0: a * span, t1: b * span, fn: -1, lane: -1 }); },
    height: () => lay().height + 6,
    drawMini(ctx, left, pw, H) {
      const lanes = lay().items.filter(it => it.type === "lane"), rh = Math.max(1, Math.min(4, (H - 4) / Math.max(1, lanes.length)));
      lanes.forEach((it, k) => {
        if (2 + k * rh > H) return;
        let last = -1;
        for (const r of it.d.runs) {
          if (r.idle) continue;
          const px = left + r.x * pw, w = r.w * pw;
          if (w < 1) { const ip = px | 0; if (ip <= last) continue; last = ip; } else last = (px + w) | 0;
          ctx.fillStyle = FN[r.fn] ? FN[r.fn].color : INTERNAL_COLOR;
          ctx.fillRect(px, 2 + k * rh, Math.max(1, w), Math.max(1, rh - (rh > 2 ? 0.5 : 0)));
        }
      });
    },
    draw(ctx, v) {
      const { items } = lay(), sx = v.pw / v.span, top = v.top, sy = v.sy;
      v.drawGrid(ctx);
      const first = laneItemAt(sy), i0 = first ? items.indexOf(first) : 0;
      const runsIn = (runs, fnDraw) => {
        let last = -1;
        for (let k = lowerBound(runs, v.x0); k < runs.length; k++) {
          const r = runs[k];
          if (r.x >= v.x1) break;
          const px = v.left + (r.x - v.x0) * sx, pw = r.w * sx;
          if (pw < 1) { const ip = px | 0; if (ip <= last) continue; last = ip; } else last = (px + pw) | 0;
          fnDraw(r, px, pw);
        }
      };
      const waitBox = (px, y, pw, h) => {
        const a = Math.max(px, v.left), b = Math.min(px + Math.max(pw, 1), v.W);
        if (b <= a) return;
        ctx.fillStyle = hatch(ctx); ctx.fillRect(a, y, Math.max(1, b - a - (b - a > 3 ? 1 : 0)), h - 1);
      };
      for (let k = i0; k < items.length; k++) {
        const it = items[k], y = it.y - sy + top;
        if (y > v.H) break;
        if (it.type === "proc") {
          ctx.fillStyle = "#10141d"; ctx.fillRect(v.left, y, v.W - v.left, it.h);
          ctx.fillStyle = "rgba(130,160,255,.30)";
          for (const i of it.pr.threads) runsIn(laneData(i).runs, (r, px, pw) => { if (!r.idle) ctx.fillRect(Math.max(px, v.left), y + 5, Math.max(1, pw), it.h - 10); });
          ctx.fillStyle = "#20252f"; ctx.fillRect(v.left, y + it.h - 1, v.W - v.left, 1);
        } else if (it.type === "lane") {
          const cur = it.d.i === S.thread;
          if (cur) { ctx.fillStyle = "rgba(130,160,255,.05)"; ctx.fillRect(v.left, y, v.W - v.left, it.h); }
          runsIn(it.d.runs, (r, px, pw) => {
            if (r.idle) waitBox(px, y + 2, pw, LSTRIP - 3);
            else v.box(ctx, px, y + 2, pw, LSTRIP - 3, r.fn, pw > 60 ? null : "");
          });
          if (it.exp) {
            const ry = y + LSTRIP + 2, d0 = Math.max(0, Math.floor((top - ry) / ROW)), d1 = Math.min(it.rows.length - 1, Math.floor((v.H - ry) / ROW));
            for (let dd = d0; dd <= d1; dd++) {
              const by = ry + dd * ROW;
              runsIn(it.rows[dd], (b, px, pw) => {
                if (b.waitW >= 0.95 * b.wall) {
                  waitBox(px, by, pw, ROW);
                  if (pw > 40) { const t = v.fit(FN[b.fn].disp, pw - 8); if (t) { ctx.fillStyle = "rgba(200,206,220,.7)"; ctx.fillText(t, Math.max(px, v.left) + 4, by + ROW / 2); } }
                } else v.box(ctx, px, by, pw, ROW, b.fn, null);
              });
            }
          }
          ctx.fillStyle = "#1a1f2a"; ctx.fillRect(v.left, y + it.h - 1, v.W - v.left, 1);
        }
      }
      // Selected window, brush and cursor
      const shade = (a, b) => { const pa = v.left + (a - v.x0) * sx, pb = v.left + (b - v.x0) * sx; return [clamp(pa, v.left, v.W), clamp(pb, v.left, v.W)]; };
      if (LN.win) {
        const [a, b] = shade(LN.win.t0 / span, LN.win.t1 / span);
        ctx.fillStyle = "rgba(5,7,10,.55)";
        ctx.fillRect(v.left, top, a - v.left, v.H - top); ctx.fillRect(b, top, v.W - b, v.H - top);
        ctx.fillStyle = "rgba(130,160,255,.85)"; ctx.fillRect(a, top, 1, v.H - top); ctx.fillRect(Math.max(a, b - 1), top, 1, v.H - top);
      }
      if (v.selDrag) {
        const [a, b] = shade(Math.min(...v.selDrag), Math.max(...v.selDrag));
        ctx.fillStyle = "rgba(130,160,255,.16)"; ctx.fillRect(a, top, b - a, v.H - top);
      }
      // Gutter
      ctx.fillStyle = "#0e1117"; ctx.fillRect(0, top, v.left, v.H - top);
      for (let k = i0; k < items.length; k++) {
        const it = items[k], y = it.y - sy + top;
        if (y > v.H) break;
        if (y + it.h < top) continue;
        if (it.type === "proc") {
          ctx.fillStyle = "#141926"; ctx.fillRect(0, y, v.left - 1, it.h);
          const open = !LN.collapsedProcs.has(it.pr.pid), ind = 8 + Math.min(it.depth, 4) * 10;
          ctx.fillStyle = "#8a93a8"; ctx.fillText(open ? "▾" : "▸", ind, y + it.h / 2);
          const amt = fmtDur(it.pr.total), aw = amt.length * v.charW;
          ctx.fillStyle = "#687088"; ctx.fillText(amt, v.left - 10 - aw, y + it.h / 2);
          ctx.fillStyle = "#dfe4ee"; ctx.fillText(v.fit(it.pr.short + "  " + it.pr.pid, v.left - ind - 30 - aw), ind + 14, y + it.h / 2);
        } else if (it.type === "lane") {
          const cur = it.d.i === S.thread, hov = it.d.i === LN.hoverLane;
          if (cur || hov) { ctx.fillStyle = cur ? "#1b2440" : "#181d29"; ctx.fillRect(0, y, v.left - 1, LSTRIP); }
          if (cur) { ctx.fillStyle = "#7c9bff"; ctx.fillRect(0, y, 2, it.h); }
          const ind = PROCS.size > 1 ? 22 : 8;
          ctx.fillStyle = "#8a93a8"; ctx.fillText(it.exp ? "▾" : "▸", ind, y + LSTRIP / 2);
          const amt = fmtDur(it.d.active), aw = amt.length * v.charW;
          ctx.fillStyle = "#687088"; ctx.fillText(amt, v.left - 10 - aw, y + LSTRIP / 2);
          ctx.fillStyle = cur ? "#ffffff" : "#c9cfdc"; ctx.fillText(v.fit(it.pi.label, v.left - ind - 30 - aw), ind + 14, y + LSTRIP / 2);
        } else {
          ctx.fillStyle = "#687088";
          ctx.fillText(v.fit("+ " + it.lanes.length + " idle thread" + (it.lanes.length === 1 ? "" : "s") + " · show", v.left - 30), PROCS.size > 1 ? 36 : 22, y + it.h / 2);
        }
      }
      ctx.fillStyle = "#20252f"; ctx.fillRect(v.left - 1, top, 1, v.H - top);
      v.drawAxis(ctx);
      drawPhaseBand(ctx, v, phaseWall);
      ctx.fillStyle = "#0e1117"; ctx.fillRect(0, 0, v.left, AXIS + BAND);
      ctx.fillStyle = "#687088";
      ctx.fillText(v.fit("wall clock · drag axis to select", v.left - 16), 12, AXIS / 2);
      ctx.fillText(v.fit("phases · " + T.name, v.left - 16), 12, AXIS + BAND / 2);
      ctx.fillStyle = "#20252f"; ctx.fillRect(0, AXIS - 1, v.left, 1); ctx.fillRect(0, AXIS + BAND - 1, v.left, 1); ctx.fillRect(v.left - 1, 0, 1, AXIS + BAND);
      if (LN.win) {
        const [a, b] = shade(LN.win.t0 / span, LN.win.t1 / span);
        ctx.fillStyle = "rgba(130,160,255,.28)"; ctx.fillRect(a, 0, Math.max(1, b - a), AXIS - 1);
      }
      if (v.selDrag) {
        const [a, b] = shade(Math.min(...v.selDrag), Math.max(...v.selDrag)), lbl = fmtDur(Math.abs(v.selDrag[1] - v.selDrag[0]) * span);
        ctx.fillStyle = "rgba(130,160,255,.4)"; ctx.fillRect(a, 0, b - a, AXIS - 1);
        ctx.fillStyle = "#fff"; ctx.fillText(lbl, a + 4, AXIS / 2);
      }
      const m = v.mouse && !v.dragging ? v.mouse : null;
      if (m) {
        const r = v.plot.getBoundingClientRect(), mx = m.clientX - r.left, my = m.clientY - r.top;
        if (mx > v.left && mx < v.W && my > 0 && my < v.H) {
          ctx.fillStyle = "rgba(255,255,255,.35)"; ctx.fillRect(Math.round(mx), top, 1, v.H - top);
          const lbl = fmtAxis(v.pxToX(mx) * span, (v.span * span) / 200), lw = lbl.length * v.charW + 10;
          ctx.fillStyle = "#2a3350"; ctx.fillRect(Math.round(mx) - lw / 2, 1, lw, AXIS - 3);
          ctx.fillStyle = "#e8ecf5"; ctx.fillText(lbl, Math.round(mx) - lw / 2 + 5, AXIS / 2);
        }
      }
    },
    hit(px, py, v) {
      const yy = py - v.top + v.sy, it = laneItemAt(yy);
      if (!it) return null;
      if (px < v.left) {
        if (it.type === "proc") return { kind: "lproc", key: "p" + it.pr.pid, pr: it.pr };
        if (it.type === "idle") return { kind: "lidle", key: "i" + it.pr.pid, item: it };
        return { kind: "llabel", key: "l" + it.d.i, lane: it };
      }
      const x = v.pxToX(px), t = x * span;
      if (it.type === "proc") return { kind: "lprocs", key: "ps" + it.pr.pid + ":" + Math.round(px / 3), pr: it.pr, t };
      if (it.type !== "lane") return null;
      const ly = yy - it.y;
      if (ly < LSTRIP || !it.exp) {
        const r = findAt(it.d.runs, x);
        if (!r) return null;
        return { kind: "lrun", key: r, lane: it, run: r, fn: r.fn, x: r.x, w: r.w, y: it.y, h: LSTRIP, t, s: segAt(it.d, t) };
      }
      const dd = Math.floor((ly - LSTRIP - 2) / ROW), row = it.rows[dd];
      if (!row) return null;
      const b = findAt(row, x);
      if (!b) return null;
      return { kind: "lblock", key: b, lane: it, block: b, fn: b.fn, x: b.x, w: b.w, y: it.y + LSTRIP + 2 + dd * ROW, h: ROW, t };
    },
  };
}

function laneTip(it) {
  const span = S.tl.span || 1, info = profileInfo();
  const where = lane => esc(lane.pi.label) + (PROCS.size > 1 ? ' <span class="t-dim">' + esc(PROCS.get(lane.pi.pid).short) + " · " + lane.pi.pid + "</span>" : "");
  const stackAt = (d, s) => {
    if (s < 0) return "";
    const stk = S.raw.profiles[d.i].samples[s] || [], users = [];
    for (let k = stk.length - 1; k >= 0 && users.length < 7; k--) {
      const fo = FN[frameFn[stk[k]]];
      if (fo.cat === "user") users.push('<div><span class="dot" style="background:' + fo.color + '"></span>' + esc(fo.disp) + ' <span class="loc">' + esc(fo.rel) + ":" + frameLine[stk[k]] + "</span></div>");
    }
    return users.length ? '<div class="t-stack">' + users.join("") + "</div>" : "";
  };
  const hint = '<div class="t-hint">Click: select &amp; see what every other thread did meanwhile · Double-click: zoom</div>';
  if (it.kind === "lrun") {
    const r = it.run;
    return fnHeader(r.fn) + grid([
      ["Thread", where(it.lane)],
      [r.idle ? "Waiting" : "Running", "<b>" + fmtDur(r.te - r.ts) + "</b>"],
      ["From", fmtAxis(r.ts, 0.001) + " → " + fmtAxis(r.te, 0.001)],
    ].concat(r.idle && it.s >= 0 && FN[it.lane.d.leaf[it.s]] ? [["Blocked in", esc(FN[it.lane.d.leaf[it.s]].disp)]] : [])) + stackAt(it.lane.d, it.s) + hint;
  }
  if (it.kind === "lblock") {
    const b = it.block, busy = b.wall - b.waitW;
    return fnHeader(b.fn) + grid([
      ["Thread", where(it.lane)],
      ["Duration", "<b>" + fmtDur(b.te - b.ts) + "</b>"],
      ["Running", fmtDur(busy) + " · " + fmtPct(busy, b.wall || 1)],
      ["Waiting", fmtDur(b.waitW) + " · " + fmtPct(b.waitW, b.wall || 1)],
      ["From", fmtAxis(b.ts, 0.001) + " → " + fmtAxis(b.te, 0.001)],
    ]) + hint;
  }
  if (it.kind === "lprocs") {
    const busy = [];
    for (const i of it.pr.threads) {
      const d = laneData(i), s = segAt(d, it.t);
      if (s >= 0 && !d.idle[s]) busy.push(esc(info[i].label) + ' <span class="t-dim">' + esc(FN[d.focus[s]]?.disp || "?") + "</span>");
    }
    return '<div class="t-name">' + esc(it.pr.short) + ' <span class="t-dim">' + it.pr.pid + "</span></div>" +
      grid([["At", fmtAxis(it.t, 0.001)], ["Busy threads", busy.length + " of " + it.pr.threads.length]]) +
      (busy.length ? '<div class="t-loc">' + busy.slice(0, 10).join("<br>") + "</div>" : "") + '<div class="t-hint">Brightness = how many of its threads are running</div>';
  }
  if (it.kind === "lproc") {
    const pr = it.pr;
    return '<div class="t-name">' + esc(pr.short) + "</div>" + grid([["Process", "pid " + pr.pid + (pr.parent ? " · child of " + pr.parent : "")], ["Running", fmtDur(pr.total)], ["Threads", pr.threads.length]]) +
      (pr.cmd ? '<div class="t-loc">' + esc(pr.cmd.length > 200 ? pr.cmd.slice(0, 199) + "…" : pr.cmd) + "</div>" : "") +
      '<div class="t-hint">Click to ' + (LN.collapsedProcs.has(pr.pid) ? "show" : "hide") + " its threads</div>";
  }
  if (it.kind === "llabel") {
    const d = it.lane.d, pi = it.lane.pi;
    return '<div class="t-name">' + where(it.lane) + "</div>" + grid([["Running", "<b>" + fmtDur(d.active) + "</b>"], ["Alive for", fmtDur(pi.wall)], ["Waiting", fmtPct(pi.wall - d.active, pi.wall || 1)]]) +
      '<div class="t-hint">Click to ' + (it.lane.exp ? "collapse its call stacks" : "expand its call stacks and make it the current thread") + "</div>";
  }
  if (it.kind === "lidle") {
    return '<div class="t-name">' + it.item.lanes.length + " threads with no running samples</div>" +
      '<div class="t-loc">' + it.item.lanes.slice(0, 12).map(d => esc(info[d.i].label)).join("<br>") + "</div>" + '<div class="t-hint">Click to show them</div>';
  }
  return "";
}

function revealLane(i) {
  const pi = profileInfo()[i];
  LN.expanded.add(i); LN.collapsedProcs.delete(pi.pid);
  if (!(laneData(i).active > 0)) LN.showIdle.add(pi.pid);
  LN.layout = null;
  if (S.view !== "timeline") setView("timeline");
  const it = laneLayout().items.find(x => x.type === "lane" && x.d.i === i);
  if (it) chart.revealY(it.y, Math.min(it.h, chart.ph * 0.6));
  chart.request();
}

function laneClick(it) {
  const span = S.tl.span || 1;
  if (it.kind === "lproc") { const p = it.pr.pid; LN.collapsedProcs.has(p) ? LN.collapsedProcs.delete(p) : LN.collapsedProcs.add(p); LN.layout = null; chart.request(); return true; }
  if (it.kind === "lidle") { LN.showIdle.add(it.item.pr.pid); LN.layout = null; chart.request(); return true; }
  if (it.kind === "llabel") {
    const i = it.lane.d.i;
    if (it.lane.exp) LN.expanded.delete(i); else { LN.expanded.add(i); switchThread(i, true); }
    LN.layout = null; chart.request(); return true;
  }
  if (it.kind === "lrun" || it.kind === "lblock") {
    const d = it.lane.d, src = it.kind === "lrun" ? it.run : it.block;
    let line = 0;
    if (it.kind === "lrun") line = it.s >= 0 ? d.focusLine[it.s] : 0;
    else { const m = new Map(); for (let s = src.s0; s < src.s1; s++) { const ln = d.sLine[d.offs[s] + src.d]; if (ln > 0) m.set(ln, (m.get(ln) || 0) + d.t1[s] - d.t0[s]); } line = maxKey(m); }
    switchThread(d.i, true);
    select(src.fn, line, { reveal: false });
    setWindow({ t0: src.ts, t1: src.te, fn: src.fn, lane: d.i, waiting: it.kind === "lrun" ? !!src.idle : src.waitW >= 0.5 * src.wall });
    return true;
  }
  if (it.kind === "lprocs") { setWindow({ t0: it.t - span * chart.span * 0.01, t1: it.t + span * chart.span * 0.01, fn: -1, lane: -1 }); return true; }
  return false;
}

function setWindow(win) {
  navMark();
  LN.win = win;
  renderDuring();
  if (win && S.tab !== "calls" && S.tab !== "tree") setTab("during");
  chart.request();
}

/* ─── "During selection": what every thread did in a time window ─── */

function windowStats(t0, t1) {
  const out = [];
  for (const pi of profileInfo()) {
    const d = laneData(pi.i);
    let lo = 0, hi = d.n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (d.t1[m] <= t0) lo = m + 1; else hi = m; }
    let busy = 0, wait = 0;
    const fns = new Map(), waits = new Map();
    for (let s = lo; s < d.n && d.t0[s] < t1; s++) {
      const ov = Math.min(d.t1[s], t1) - Math.max(d.t0[s], t0);
      if (ov <= 0) continue;
      const m = d.idle[s] ? waits : fns, f = d.idle[s] ? d.leaf[s] : d.focus[s];
      m.set(f, (m.get(f) || 0) + ov);
      if (d.idle[s]) wait += ov; else busy += ov;
    }
    if (busy + wait > 0) out.push({ pi, busy, wait, fns, waits });
  }
  return out;
}

function renderDuring() {
  const el = $("#during");
  if (!el) return;
  if (!S.tl) {
    el.innerHTML = '<div class="placeholder">This run has no wall-clock timestamps, so threads can’t be lined up in time.<br>' +
      "Record it again with <code>codexplore run</code> or <code>codexplore exec</code> (without <code>--cpu</code>) to see what every thread was doing at the same moment.</div>";
    return;
  }
  const win = LN.win;
  if (!win) {
    el.innerHTML = '<div class="placeholder">On the <b>Timeline</b>, click any call — or drag across the time axis — to see what every other thread and process was doing during that time.</div>';
    if (S.tab === "during") $("#tab-info").textContent = "";
    return;
  }
  const dur = Math.max(1e-9, win.t1 - win.t0), stats = windowStats(win.t0, win.t1), info = profileInfo(), multi = PROCS.size > 1;
  const chips = (m, i, max, cls = "") => Array.from(m).sort((a, b) => b[1] - a[1]).slice(0, max).map(([f, w]) =>
    '<button class="chip dchip' + cls + '" data-i="' + i + '" data-fn="' + f + '" title="' + esc(FN[f]?.rel || "") + '"><span class="dot" style="background:' + (FN[f] ? fillFor(f) : INTERNAL_COLOR) + '"></span>' +
    esc(FN[f]?.disp || "?") + "<em>" + fmtDur(w) + "</em></button>").join("");
  const own = win.lane >= 0 ? stats.find(r => r.pi.i === win.lane) : null;
  const others = stats.filter(r => r !== own);
  let h = '<div class="during-head"><span class="title">' + (win.fn >= 0 ? "While <b>" + esc(FN[win.fn].disp) + "</b> ran" + (own ? " on " + esc(own.pi.label) : "") : "Selected window") + "</span>" +
    '<span class="stat">' + fmtAxis(win.t0, dur / 100) + " → " + fmtAxis(win.t1, dur / 100) + " · <b>" + fmtDur(dur) + "</b></span>" +
    '<span class="grow"></span><button class="chip" data-act="zoom">Zoom to window</button><button class="chip" data-act="clear">Clear</button></div>';
  if (own) {
    const waitPct = own.wait / dur;
    h += '<div class="during-own">This thread: running <b>' + fmtDur(own.busy) + "</b> · waiting <b>" + fmtDur(own.wait) + "</b>" +
      (own.waits.size ? ' blocked in <span class="loc">' + esc(FN[maxKey(own.waits)]?.disp || "") + "</span>" : "") +
      (waitPct >= 0.5 ? '<span class="during-note">Mostly waiting — the work probably happened on the threads below.</span>' : "") + "</div>";
  }
  const allFns = new Map();
  for (const r of others) for (const [f, w] of r.fns) allFns.set(f, (allFns.get(f) || 0) + w);
  if (allFns.size) h += '<div class="during-all"><span class="lbl">Busiest elsewhere</span>' + chips(allFns, -1, 6) + "</div>";
  const busyRows = others.filter(r => r.busy > 0).sort((a, b) => b.busy - a.busy), waitingOnly = others.filter(r => r.busy <= 0);
  h += '<div class="drow dhead"><span>Thread</span><span>Running</span><span class="num">Waiting</span><span>Doing</span></div>';
  const row = r => '<div class="drow" data-i="' + r.pi.i + '"><span class="nm" title="' + esc(r.pi.label + (multi ? "\n" + (PROCS.get(r.pi.pid).cmd || PROCS.get(r.pi.pid).short) + " · pid " + r.pi.pid : "")) + '">' + esc(r.pi.label) + (multi ? '<span class="loc">' + esc(PROCS.get(r.pi.pid).short) + " · " + r.pi.pid + "</span>" : "") + "</span>" +
    '<span class="dbar"><i style="width:' + Math.min(100, r.busy / dur * 100).toFixed(1) + '%"></i><b>' + fmtDur(r.busy) + "</b> " + fmtPct(r.busy, dur) + "</span>" +
    '<span class="num loc">' + (r.wait > 0 ? fmtDur(r.wait) : "") + "</span>" +
    '<span class="dchips">' + chips(r.fns, r.pi.i, 3) + "</span></div>";
  if (multi) {
    const byProc = new Map();
    for (const r of busyRows) (byProc.get(r.pi.pid) || byProc.set(r.pi.pid, []).get(r.pi.pid)).push(r);
    for (const [pid, rows] of Array.from(byProc).sort((a, b) => b[1].reduce((x, r) => x + r.busy, 0) - a[1].reduce((x, r) => x + r.busy, 0))) {
      const pr = PROCS.get(pid), busy = rows.reduce((x, r) => x + r.busy, 0);
      h += '<div class="drow dproc"><span class="nm">' + esc(pr.short) + ' <span class="loc">' + pid + "</span></span><span><b>" + fmtDur(busy) + "</b> across " + rows.length + " thread" + (rows.length === 1 ? "" : "s") + "</span></div>";
      h += rows.map(row).join("");
    }
  } else h += busyRows.map(row).join("");
  if (!busyRows.length) h += '<div class="placeholder small">No other thread was running during this window.</div>';
  if (waitingOnly.length) h += '<div class="during-idle">' + waitingOnly.length + " other thread" + (waitingOnly.length === 1 ? " was" : "s were") + " only waiting: " +
    waitingOnly.slice(0, 12).map(r => esc(r.pi.label) + (multi ? ' <span class="loc">(' + esc(PROCS.get(r.pi.pid).short) + ")</span>" : "")).join(", ") + (waitingOnly.length > 12 ? ", …" : "") + "</div>";
  el.innerHTML = h;
  colHandles("during");
  if (S.tab === "during") $("#tab-info").textContent = busyRows.length + " threads running in this window · click one to open it";
}

function bindDuring() {
  const el = $("#during"), span = () => S.tl.span || 1;
  el.addEventListener("click", e => {
    const act = e.target.closest("[data-act]");
    if (act) {
      if (act.dataset.act === "clear") setWindow(null);
      else if (LN.win) {
        if (S.view !== "timeline") setView("timeline");
        const a = LN.win.t0 / span(), b = LN.win.t1 / span(), pad = (b - a) * 0.05;
        chart.jumpTo(a - pad, b + pad);
      }
      return;
    }
    const chip = e.target.closest(".dchip"), r = e.target.closest(".drow[data-i]");
    if (chip) {
      e.stopPropagation();
      const i = +chip.dataset.i, fn = +chip.dataset.fn;
      if (i >= 0) { revealLane(i); switchThread(i, true); }
      select(fn, 0, { reveal: false });
      return;
    }
    if (r) { const i = +r.dataset.i; revealLane(i); switchThread(i, true); }
  });
  el.addEventListener("mouseover", e => {
    const r = e.target.closest(".drow[data-i]"), c = e.target.closest(".dchip");
    const i = r ? +r.dataset.i : -1;
    if (i !== LN.hoverLane) { LN.hoverLane = i; chart.request(); }
    setHover(c ? +c.dataset.fn : -1);
  });
  el.addEventListener("mouseleave", () => { LN.hoverLane = -1; setHover(-1); chart.request(); });
}

/* ═══════════════════════════ Phases ═══════════════════════════ */

// Splits the run into consecutive stretches by "which part of your code is running", measured
// below the user frames that nearly every sample shares (e.g. the test function).
function computePhases(level) {
  const cached = T.phases.get(level);
  if (cached) return cached;
  const { n, w, offs, sFn, starts, total } = T, tv = total || 1;
  const lists = new Array(n);
  let userW = 0;
  for (let s = 0; s < n; s++) {
    const arr = [];
    for (let k = offs[s]; k < offs[s + 1]; k++) {
      const f = sFn[k];
      if (FN[f].cat === "user" && arr[arr.length - 1] !== f) arr.push(f);
    }
    lists[s] = arr;
    if (arr.length) userW += w[s];
  }
  const prefix = [];
  let cand = [];
  for (let s = 0; s < n; s++) if (lists[s].length) cand.push(s);
  while (cand.length) {
    const d = prefix.length, cnt = new Map();
    for (const s of cand) if (lists[s].length > d + 1) cnt.set(lists[s][d], (cnt.get(lists[s][d]) || 0) + w[s]);
    let best = -1, bw = 0;
    for (const [f, x] of cnt) if (x > bw) { bw = x; best = f; }
    if (best < 0 || bw < 0.9 * userW) break;
    prefix.push(best);
    cand = cand.filter(s => lists[s][d] === best);
  }
  const keyOf = s => {
    const l = lists[s];
    if (!l.length) return null;
    let base = prefix.length;
    for (let i = 0; i < prefix.length; i++) if (l[i] !== prefix[i]) { base = 0; break; }
    const seg = l.slice(base, base + level);
    return seg.length ? seg : [l[l.length - 1]];
  };
  const runs = [];
  for (let s = 0; s < n; s++) {
    const seg = keyOf(s), key = seg ? seg.join(",") : "~", last = runs[runs.length - 1];
    if (last && last.key === key) { last.s1 = s + 1; last.wt += w[s]; }
    else runs.push({ key, fns: seg || [], s0: s, s1: s + 1, wt: w[s] });
  }
  const minW = tv * 0.01, out = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && (r.wt < minW || last.key === r.key)) { last.s1 = r.s1; last.wt += r.wt; continue; }
    out.push({ ...r });
  }
  if (out.length > 1 && out[0].wt < minW) { out[1].s0 = out[0].s0; out[1].wt += out[0].wt; out.shift(); }
  for (const p of out) {
    p.x = starts[p.s0] / tv; p.w = (starts[p.s1] - starts[p.s0]) / tv;
    p.fn = p.fns.length ? p.fns[p.fns.length - 1] : -1;
  }
  const res = { prefix, phases: out, level };
  T.phases.set(level, res);
  return res;
}

function phaseName(p) { return p.fn >= 0 ? FN[p.fn].disp : "(outside your code)"; }

function drawPhaseBand(ctx, v, xf) {
  const { phases } = computePhases(S.phaseLevel), y = AXIS;
  ctx.fillStyle = "#0e1117"; ctx.fillRect(v.left, y, v.W - v.left, BAND);
  for (const p of phases) {
    const [x, w] = xf ? xf(p) : [p.x, p.w];
    const px = v.left + (x - v.x0) / v.span * v.pw, pw = w / v.span * v.pw;
    const a = Math.max(px, v.left), b = Math.min(px + pw, v.W);
    if (b - a < 0.5) continue;
    ctx.fillStyle = p.fn >= 0 ? fillFor(p.fn) : INTERNAL_COLOR;
    ctx.fillRect(a, y + 2, Math.max(1, b - a - 1), BAND - 4);
    if (p.fn >= 0 && p.fn === S.hoverFn) { ctx.fillStyle = "rgba(255,255,255,.18)"; ctx.fillRect(a, y + 2, Math.max(1, b - a - 1), BAND - 4); }
    if (b - a > 30) {
      const t = v.fit(phaseName(p), b - a - 8);
      if (t) { ctx.fillStyle = p.fn >= 0 && S.color !== "heat" ? FN[p.fn].text : "rgba(230,234,244,.9)"; ctx.fillText(t, a + 4, y + BAND / 2); }
    }
  }
  ctx.fillStyle = "#20252f"; ctx.fillRect(v.left, y + BAND - 1, v.W - v.left, 1);
}

function phaseBandHit(px, py, v, xf) {
  if (py < AXIS) return null;
  const { phases } = computePhases(S.phaseLevel), x = v.pxToX(px);
  const p = xf ? phases.find(q => { const [a, w] = xf(q); return a <= x && x < a + w; }) : findAt(phases, x);
  if (!p) return null;
  const [a, w] = xf ? xf(p) : [p.x, p.w];
  return { kind: "phase", key: p, phase: p, fn: p.fn, x: a, w };
}

function renderPhases() {
  const el = $("#phases");
  if (!T || !T.n) { el.innerHTML = '<div class="placeholder">No samples.</div>'; return; }
  const { prefix, phases, level } = computePhases(S.phaseLevel);
  const tTot = T.timed ? T.total * T.scale : T.total;
  const ctx = prefix.length ? "inside " + prefix.map(f => "<b>" + esc(FN[f].disp) + "</b>").join(" › ") : "top-level calls into your code";
  let h = '<div class="phases-head"><span class="title">' + phases.length + " phases</span>" +
    '<span class="loc">' + ctx + '</span><span class="grow"></span>' +
    '<button class="chip" data-level="-1"' + (level <= 1 ? " disabled" : "") + ">coarser</button>" +
    '<span class="stat">level ' + level + "</span>" +
    '<button class="chip" data-level="1"' + (level >= 8 ? " disabled" : "") + ">finer</button></div>";
  h += '<div class="prow phead"><span>#</span><span>Phase</span><span class="num">Start</span><span class="num">Duration</span><span class="num">Share</span><span>Timeline</span></div>';
  const pos = S.tl && T.times ? phaseWall : p => [p.x, p.w], axTot = S.tl && T.times ? S.tl.span : tTot;
  phases.forEach((p, i) => {
    const fo = FN[p.fn], path = p.fns.map(f => FN[f].disp).join(" › "), [px, pw] = pos(p);
    h += '<div class="prow' + (p.fn >= 0 && p.fn === S.selFn ? " sel" : "") + '" data-i="' + i + '" title="' + esc(path || "time spent outside your code (libraries, interpreter, startup)") + '">' +
      '<span class="loc">' + (i + 1) + "</span>" +
      '<span class="nm"><span class="dot" style="background:' + (p.fn >= 0 ? fillFor(p.fn) : INTERNAL_COLOR) + '"></span>' + esc(phaseName(p)) +
      (fo && fo.rel ? '<span class="loc">' + esc(fo.rel) + "</span>" : "") + "</span>" +
      '<span class="num loc">' + fmtAxis(px * axTot, 0.01) + "</span>" +
      '<span class="num">' + fmtV(p.wt) + '</span><span class="num loc">' + fmtPct(p.wt) + "</span>" +
      '<span class="gantt"><i style="left:' + (px * 100).toFixed(3) + "%;width:max(2px," + (pw * 100).toFixed(3) + "%);background:" + (p.fn >= 0 ? fillFor(p.fn) : INTERNAL_COLOR) + '"></i></span></div>';
  });
  el.innerHTML = h;
  colHandles("phases");
  if (S.tab === "phases") $("#tab-info").textContent = "click a phase to zoom the timeline";
}

function focusPhase(p) {
  if (S.view !== "timeline" && S.view !== "tasks") setView("timeline", false);
  const [x, w] = S.view === "timeline" && S.tl ? phaseWall(p) : [p.x, p.w], pad = w * 0.02;
  chart.jumpTo(x - pad, x + w + pad);
  if (p.fn >= 0) select(p.fn, 0, { reveal: false });
}

/* ═══════════════════════════ Codebase map ═══════════════════════════ */

const TM = { focus: null, rects: null, key: "", crumbs: [] };
const CAT_TITLE = { user: "Your code", lib: "Libraries", std: "Standard library", internal: "Interpreter / other" };
const TM_TOP = 26;

function buildTreemap() {
  const root = { name: "All code", kind: "root", value: 0, count: 0, kids: new Map(), parent: null };
  const child = (node, key, name, kind) => {
    let c = node.kids.get(key);
    if (!c) { c = { name, kind, value: 0, count: 0, kids: new Map(), parent: node }; node.kids.set(key, c); }
    return c;
  };
  for (let f = 0; f < FN.length; f++) {
    const v = T.self[f];
    if (!(v > 0)) continue;
    const fo = FN[f];
    let node = child(root, fo.cat, CAT_TITLE[fo.cat], "cat");
    const segs = (fo.rel || "").split("/").filter(s => s && s !== "…");
    for (let i = 0; i < segs.length - 1; i++) node = child(node, segs[i], segs[i], "dir");
    if (segs.length) { node = child(node, segs[segs.length - 1], segs[segs.length - 1], "file"); node.file = fo.file; }
    const leaf = child(node, "\u0000" + f, fo.disp, "fn");
    leaf.fn = f;
    for (let x = leaf; x; x = x.parent) { x.value += v; x.count++; }
  }
  const fin = n => {
    n.kids = Array.from(n.kids.values()).sort((a, b) => b.value - a.value);
    n.kids.forEach(fin);
    while (n.kind === "dir" && n.kids.length === 1 && n.kids[0].kind === "dir") {
      const c = n.kids[0];
      n.name += "/" + c.name; n.kids = c.kids; n.kids.forEach(k => { k.parent = n; });
    }
  };
  fin(root);
  return root;
}
const getTreemap = () => T.treemap || (T.treemap = buildTreemap());

function squarify(items, x, y, w, h) {
  const out = [], total = items.reduce((a, b) => a + b.value, 0);
  if (!(total > 0) || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  let i = 0;
  while (i < items.length && w > 0.5 && h > 0.5) {
    const side = Math.min(w, h), mx = items[i].value * scale;
    let j = i, sum = 0, best = Infinity;
    while (j < items.length) {
      const a = items[j].value * scale, s = sum + a;
      const r = Math.max(side * side * mx / (s * s), (s * s) / (side * side * a));
      if (r > best) break;
      best = r; sum = s; j++;
    }
    if (w >= h) {
      const cw = sum / h; let cy = y;
      for (let k = i; k < j; k++) { const ch = items[k].value * scale / cw; out.push([items[k], x, cy, cw, ch]); cy += ch; }
      x += cw; w -= cw;
    } else {
      const rh = sum / w; let cx = x;
      for (let k = i; k < j; k++) { const cw = items[k].value * scale / rh; out.push([items[k], cx, y, cw, rh]); cx += cw; }
      y += rh; h -= rh;
    }
    i = j;
  }
  return out;
}

function layoutTreemap(v) {
  const root = getTreemap();
  if (!TM.focus || TM.root !== root) { TM.focus = root; TM.root = root; }
  const key = v.W + "x" + v.H + ":" + TM.focus.name + TM.focus.value;
  if (TM.key === key && TM.rects) return;
  const rects = [];
  const place = (n, x, y, w, h, depth) => {
    rects.push({ n, x, y, w, h, depth });
    if (n.kind === "fn" || !n.kids.length) return;
    const head = w >= 50 && h >= 32 ? 17 : 0, pad = 2;
    const ix = x + pad, iy = y + (head || pad), iw = w - 2 * pad, ih = h - (head || pad) - pad;
    if (iw < 3 || ih < 3) return;
    for (const [c, cx, cy, cw, ch] of squarify(n.kids, ix, iy, iw, ih)) place(c, cx, cy, cw, ch, depth + 1);
  };
  for (const [c, cx, cy, cw, ch] of squarify(TM.focus.kids, 4, TM_TOP + 2, v.W - 8, v.H - TM_TOP - 6)) place(c, cx, cy, cw, ch, 0);
  TM.rects = rects; TM.key = key;
}

function tmPath(n) {
  const parts = [];
  for (let x = n; x && x.kind !== "root"; x = x.parent) parts.unshift(x.name);
  return parts;
}

function setTreemapFocus(n) {
  if (n && n !== TM.focus && n.kind !== "fn") navMark();
  TM.focus = n && n.kind !== "fn" ? n : TM.focus;
  TM.key = "";
  chart.request();
  updateChartInfo();
}

function treemapModel() {
  const BG = ["#151922", "#1a1f2b", "#1f2532"];
  return {
    kind: "map", static: true, gutter: 0, top: TM_TOP, minSpan: 1, drawMini: null,
    height: () => 0,
    draw(ctx, v) {
      layoutTreemap(v);
      // Breadcrumb
      ctx.fillStyle = "#0e1117"; ctx.fillRect(0, 0, v.W, TM_TOP);
      ctx.fillStyle = "#20252f"; ctx.fillRect(0, TM_TOP - 1, v.W, 1);
      const chain = [];
      for (let x = TM.focus; x; x = x.parent) chain.unshift(x);
      let cx = 10;
      TM.crumbs = [];
      chain.forEach((n, i) => {
        const label = n.name + (i === chain.length - 1 ? "  " + fmtV(n.value) + " self time" : "");
        const wpx = label.length * v.charW;
        ctx.fillStyle = i === chain.length - 1 ? "#e4e7ef" : "#82a0ff";
        ctx.fillText(label, cx, TM_TOP / 2);
        TM.crumbs.push({ n, x0: cx - 4, x1: cx + wpx + 4 });
        cx += wpx;
        if (i < chain.length - 1) { ctx.fillStyle = "#687088"; ctx.fillText("  ›  ", cx, TM_TOP / 2); cx += 5 * v.charW; }
      });
      for (const r of TM.rects) {
        const n = r.n;
        if (r.w < 1 || r.h < 1) continue;
        if (n.kind === "fn") {
          ctx.fillStyle = fillFor(n.fn);
          ctx.fillRect(r.x + .5, r.y + .5, Math.max(1, r.w - 1), Math.max(1, r.h - 1));
          if (n.fn === S.hoverFn) { ctx.fillStyle = "rgba(255,255,255,.17)"; ctx.fillRect(r.x + .5, r.y + .5, r.w - 1, r.h - 1); }
          if (n.fn === S.selFn && r.w > 3 && r.h > 3) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.strokeRect(r.x + 1.25, r.y + 1.25, r.w - 2.5, r.h - 2.5); }
          if (r.w > 34 && r.h > 13 && !(S.match && !S.match[n.fn])) {
            ctx.fillStyle = S.color === "heat" ? "rgba(255,255,255,.95)" : FN[n.fn].text;
            const t = v.fit(n.name, r.w - 8);
            if (t) ctx.fillText(t, r.x + 4, r.y + Math.min(r.h / 2, 10));
            if (r.h > 28) {
              ctx.globalAlpha = .7;
              const t2 = v.fit(fmtV(n.value) + " · " + fmtPct(n.value), r.w - 8);
              if (t2) ctx.fillText(t2, r.x + 4, r.y + 23);
              ctx.globalAlpha = 1;
            }
          }
        } else {
          ctx.fillStyle = BG[r.depth % 3];
          ctx.fillRect(r.x, r.y, r.w, r.h);
          ctx.strokeStyle = n.kind === "cat" ? "#3a4258" : "#2a3040"; ctx.lineWidth = 1;
          ctx.strokeRect(r.x + .5, r.y + .5, r.w - 1, r.h - 1);
          if (r.w >= 50 && r.h >= 32) {
            const t = v.fit((n.kind === "dir" ? n.name + "/" : n.name) + "  " + fmtPct(n.value), r.w - 10);
            ctx.fillStyle = n.kind === "cat" ? "#e4e7ef" : n.kind === "file" ? "#c9cfdc" : "#a0a8bb";
            if (t) ctx.fillText(t, r.x + 5, r.y + 9);
          }
        }
      }
    },
    hit(px, py) {
      const rs = TM.rects || [];
      for (let i = rs.length - 1; i >= 0; i--) {
        const r = rs[i];
        if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h)
          return { kind: "tm", key: r.n, node: r.n, fn: r.n.kind === "fn" ? r.n.fn : -1 };
      }
      return null;
    },
    hitHeader(px) {
      const c = TM.crumbs.find(c => px >= c.x0 && px <= c.x1);
      return c && c.n !== TM.focus ? { kind: "crumb", key: c.n, node: c.n, fn: -1 } : null;
    },
    dblclick(it) {
      if (it && it.kind === "tm" && it.node.kind === "fn" && it.node.parent) setTreemapFocus(it.node.parent);
    },
  };
}

/* ═══════════════════════════ Call graph ═══════════════════════════ */

const SVGNS = "http://www.w3.org/2000/svg";

function getEdges() {
  if (T.edges) return T.edges;
  const { n, w, offs, sFn, sLine } = T, em = new Map();
  for (let s = 0; s < n; s++) {
    const a = offs[s], b = offs[s + 1], ws = w[s];
    let seen = null;
    for (let k = a + 1; k < b; k++) {
      const c = sFn[k - 1], e = sFn[k];
      if (c === e) continue;
      const kk = c * 1048576 + e;
      if (seen && seen.has(kk)) continue;
      (seen || (seen = new Set())).add(kk);
      let ed = em.get(kk);
      if (!ed) em.set(kk, ed = { from: c, to: e, w: 0, lines: new Map() });
      ed.w += ws;
      const ln = sLine[k - 1];
      if (ln > 0) ed.lines.set(ln, (ed.lines.get(ln) || 0) + ws);
    }
  }
  const out = new Map(), inn = new Map();
  for (const ed of em.values()) {
    (out.get(ed.from) || out.set(ed.from, []).get(ed.from)).push(ed);
    (inn.get(ed.to) || inn.set(ed.to, []).get(ed.to)).push(ed);
  }
  for (const l of out.values()) l.sort((a, b) => b.w - a.w);
  for (const l of inn.values()) l.sort((a, b) => b.w - a.w);
  return (T.edges = { out, inn });
}

function graphCenter() {
  if (S.selFn >= 0 && T.tot[S.selFn] > 0) return S.selFn;
  let best = -1;
  for (let f = 0; f < FN.length; f++) if (FN[f].cat === "user" && T.tot[f] > 0 && (best < 0 || T.tot[f] > T.tot[best])) best = f;
  if (best < 0) for (let f = 0; f < FN.length; f++) if (T.tot[f] > 0 && !FN[f].synth && (best < 0 || T.tot[f] > T.tot[best])) best = f;
  return best;
}

function computeEgoGraph(center, maxPerCol, depth = 2) {
  const { out, inn } = getEdges(), minW = T.total * 0.002;
  const nodes = new Map([[center, { fn: center, col: 0, w: T.tot[center] }]]), edges = new Set();
  for (const side of [-1, 1]) {
    let frontier = [center];
    for (let d = 1; d <= depth; d++) {
      const next = new Map(), k = d === 1 ? 9 : 4;
      for (const f of frontier) {
        let taken = 0;
        for (const ed of (side < 0 ? inn.get(f) : out.get(f)) || []) {
          if (taken >= k || ed.w < minW) break;
          const other = side < 0 ? ed.from : ed.to;
          edges.add(ed); taken++;
          if (!nodes.has(other)) next.set(other, (next.get(other) || 0) + ed.w);
        }
      }
      const placed = Array.from(next).sort((a, b) => b[1] - a[1]).slice(0, maxPerCol);
      for (const [f, wt] of placed) nodes.set(f, { fn: f, col: side * d, w: wt });
      frontier = placed.map(p => p[0]);
    }
  }
  const es = Array.from(edges).filter(e => nodes.has(e.from) && nodes.has(e.to));
  return { nodes: Array.from(nodes.values()), edges: es };
}

function renderGraph() {
  const svg = $("#graph");
  if (S.view !== "graph" || !T) { svg.setAttribute("hidden", ""); return; }
  svg.removeAttribute("hidden");
  const W = chart.W, H = chart.H;
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.setAttribute("width", W); svg.setAttribute("height", H);
  const center = graphCenter();
  if (center < 0) { svg.innerHTML = '<text x="' + W / 2 + '" y="' + H / 2 + '" class="g-empty">No samples.</text>'; return; }
  const NH = 38, GAP = 12, maxPerCol = Math.max(3, Math.floor((H - 60) / (NH + GAP)));
  const { nodes, edges } = computeEgoGraph(center, maxPerCol, W < 5 * 170 ? 1 : 2);
  const cols = Array.from(new Set(nodes.map(n => n.col))).sort((a, b) => a - b);
  const colW = W / cols.length, NW = Math.max(90, Math.min(250, colW - 50));
  const pos = new Map();
  for (const [ci, c] of cols.entries()) {
    const list = nodes.filter(n => n.col === c).sort((a, b) => b.w - a.w);
    const total = list.length * NH + (list.length - 1) * GAP;
    let y = Math.max(44, (H - total) / 2);
    const x = ci * colW + (colW - NW) / 2;
    for (const n of list) { pos.set(n.fn, { x, y, n }); y += NH + GAP; }
  }
  const maxE = Math.max(...edges.map(e => e.w), 1e-12);
  let h = "";
  for (const [ci, c] of cols.entries()) {
    const label = c === 0 ? "selected" : c < 0 ? (c === -1 ? "called by" : "called by (2 levels up)") : (c === 1 ? "calls" : "calls (2 levels down)");
    h += '<text class="g-col" x="' + (ci * colW + colW / 2) + '" y="22">' + label + "</text>";
  }
  for (const e of edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    const back = a.x >= b.x;
    const x1 = back ? a.x : a.x + NW, y1 = a.y + NH / 2, x2 = back ? b.x + NW : b.x, y2 = b.y + NH / 2;
    const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (back ? -1 : 1);
    const sw = (1.2 + 9 * Math.sqrt(e.w / maxE)).toFixed(1);
    const d = "M" + x1 + "," + y1 + " C" + (x1 + dx) + "," + y1 + " " + (x2 - dx) + "," + y2 + " " + x2 + "," + y2;
    h += '<path class="gedge' + (back ? " back" : "") + '" data-from="' + e.from + '" data-to="' + e.to + '" d="' + d + '" stroke-width="' + sw + '"/>';
    if (e.w >= T.total * 0.02 && !back) h += '<text class="g-elabel" x="' + ((x1 + x2) / 2) + '" y="' + ((y1 + y2) / 2 - 4) + '">' + fmtPct(e.w) + "</text>";
  }
  const cw = 6.6;
  for (const { x, y, n } of pos.values()) {
    const fo = FN[n.fn], isC = n.fn === center, maxC = Math.floor((NW - 16) / cw);
    const nm = fo.disp.length > maxC ? fo.disp.slice(0, maxC - 1) + "…" : fo.disp;
    const sub = "total " + fmtPct(T.tot[n.fn]) + " · self " + fmtPct(T.self[n.fn]) + (fo.cat !== "user" ? " · " + CAT_LABEL[fo.cat] : "");
    const dim = S.match && !S.match[n.fn];
    h += '<g class="gnode' + (isC ? " center" : "") + (dim ? " dim" : "") + '" data-fn="' + n.fn + '" transform="translate(' + x + "," + y + ')">' +
      '<rect width="' + NW + '" height="' + NH + '" rx="7" fill="' + fillFor(n.fn) + '"/>' +
      '<text x="9" y="15" fill="' + (S.color === "heat" ? "#fff" : fo.text) + '" class="g-name">' + esc(nm) + "</text>" +
      '<text x="9" y="29" class="g-sub">' + esc(sub.length > maxC + 6 ? sub.slice(0, maxC + 5) + "…" : sub) + "</text></g>";
  }
  svg.innerHTML = h;
  if (!edges.length) svg.insertAdjacentHTML("beforeend", '<text class="g-empty" x="' + W / 2 + '" y="' + (H - 30) + '">No calls recorded for this function with the current frame filter.</text>');
  highlightGraph(S.hoverFn);
}

function highlightGraph(fn) {
  const svg = $("#graph");
  if (svg.hasAttribute("hidden")) return;
  svg.classList.toggle("hovering", fn >= 0);
  for (const e of svg.querySelectorAll(".gedge")) e.classList.toggle("hl", fn >= 0 && (+e.dataset.from === fn || +e.dataset.to === fn));
  for (const g of svg.querySelectorAll(".gnode")) g.classList.toggle("hl", +g.dataset.fn === fn);
}

function bindGraph() {
  const svg = $("#graph");
  svg.addEventListener("mousemove", e => {
    const g = e.target.closest(".gnode"), p = e.target.closest(".gedge");
    if (g) {
      const fn = +g.dataset.fn;
      if (fn !== S.hoverFn) { setHover(fn); showTip(fnHeader(fn) + grid([["Total", "<b>" + fmtV(T.tot[fn]) + "</b> · " + fmtPct(T.tot[fn])], ["Self", fmtV(T.self[fn]) + " · " + fmtPct(T.self[fn])]]) + '<div class="t-hint">Click to center the graph here and view source</div>', e); }
      else moveTip(e);
    } else if (p) {
      const a = +p.dataset.from, b = +p.dataset.to, ed = (getEdges().out.get(a) || []).find(x => x.to === b);
      setHover(-1);
      if (ed) {
        const site = maxKey(ed.lines);
        showTip('<div class="t-name">' + esc(FN[a].disp) + " → " + esc(FN[b].disp) + "</div>" + grid([["Time in call", "<b>" + fmtV(ed.w) + "</b> · " + fmtPct(ed.w)], ["Of callee total", fmtPct(ed.w, T.tot[b])]].concat(site ? [["Call site", esc(FN[a].rel) + ":" + site]] : [])) + '<div class="t-hint">Click to open the call site</div>', e);
      }
    } else { hideTip(); setHover(-1); }
  });
  svg.addEventListener("mouseleave", () => { hideTip(); setHover(-1); });
  svg.addEventListener("click", e => {
    const g = e.target.closest(".gnode"), p = e.target.closest(".gedge");
    hideTip();
    if (g) select(+g.dataset.fn, 0);
    else if (p) {
      const a = +p.dataset.from, b = +p.dataset.to, ed = (getEdges().out.get(a) || []).find(x => x.to === b);
      if (ed) openSource(a, maxKey(ed.lines));
    }
  });
}

/* ═══════════════════════════ Threads overview ═══════════════════════════ */

const TH = { mode: null, list: null, expanded: new Set(), nodes: null };

const isBootstrap = fo => fo.internal || !!fo.proc || fo.synth || BOOTSTRAP_FILE_RE.test(normPath(fo.file)) || (fo.name === "<module>" && fo.file === "<string>");
const fmtT = v => (PROFILES?.[0]?.timed ? fmtDur(v) : Math.round(v) + " samples");

// Per thread: entry point (first non-bootstrap frame) and hot functions
// (deepest frame of your code below the entry, else the leaf of the filtered stack).
function summarizeThreads() {
  const key = S.frames + "|" + S.waiting;
  if (TH.mode === key && TH.list) return TH.list;
  const info = profileInfo(), profs = S.raw.profiles || [], mode = S.frames;
  TH.list = info.map(pi => {
    const p = profs[pi.i], samples = p.samples || [], weights = Array.isArray(p.weights) && p.weights.length === samples.length ? p.weights : null;
    const skip = p.idle && S.waiting === "hide" ? p.idle : null;
    const entries = new Map(), hot = new Map(), sEntry = new Int32Array(samples.length).fill(-1);
    for (let s = 0; s < samples.length; s++) {
      if (skip && skip[s]) continue;
      const stk = samples[s] || [], ws = (weights ? +weights[s] || 0 : 1) * pi.scale;
      for (const idx of stk) {
        const fo = FN[frameFn[idx]];
        if (fo && !isBootstrap(fo)) { sEntry[s] = fo.id; entries.set(fo.id, (entries.get(fo.id) || 0) + ws); break; }
      }
    }
    const entry = maxKey(entries) ?? -1, fnA = [], lnA = [];
    for (let s = 0; s < samples.length; s++) {
      if (skip && skip[s]) continue;
      const ws = (weights ? +weights[s] || 0 : 1) * pi.scale;
      fnA.length = 0; lnA.length = 0;
      filterStack(samples[s] || [], mode, fnA, lnA);
      let from = sEntry[s] === entry ? fnA.indexOf(entry) : -1, pick = -1;
      for (let k = fnA.length - 1; k > from; k--) if (FN[fnA[k]].cat === "user") { pick = fnA[k]; break; }
      if (pick < 0 && fnA.length - 1 > from) pick = fnA[fnA.length - 1];
      if (pick >= 0 && pick !== entry) hot.set(pick, (hot.get(pick) || 0) + ws);
    }
    return { pi, entry: entries.size ? entry : -1, entryW: entries.get(entry) || 0, hot };
  });
  TH.mode = key;
  return TH.list;
}

// Thread nodes after merging pools and folding tiny threads; plus entry / hot nodes and edges.
function threadsGraph() {
  const list = summarizeThreads(), info = profileInfo(), grand = info.reduce((a, b) => a + b.secs, 0) || 1;
  const procOrder = [];
  const visit = pr => { procOrder.push(pr); for (const c of Array.from(PROCS.values()).filter(c => c.parent === pr.pid && c !== pr).sort((a, b) => b.total - a.total)) visit(c); };
  for (const r of Array.from(PROCS.values()).filter(p => !p.parent || !PROCS.has(p.parent)).sort((a, b) => b.total - a.total)) visit(r);
  const depth = pr => { let d = 0, p = pr; while (p.parent && PROCS.has(p.parent) && d < 8) { p = PROCS.get(p.parent); d++; } return d; };

  const threads = [];
  for (const pr of procOrder) {
    const groups = new Map();
    for (const i of pr.threads) {
      const t = list[i], base = t.pi.name.replace(/[-_.\s]*\d+$/, "");
      const key = base + "\u0000" + t.entry;
      (groups.get(key) || groups.set(key, []).get(key)).push(t);
    }
    let nodes = [];
    for (const members of groups.values()) {
      members.sort((a, b) => b.pi.secs - a.pi.secs);
      const one = members.length === 1, t0 = members[0], base = t0.pi.name.replace(/[-_.\s]*\d+$/, "");
      const hot = new Map();
      for (const m of members) for (const [f, w] of m.hot) hot.set(f, (hot.get(f) || 0) + w);
      nodes.push({
        kind: "thread", pid: pr.pid, members, hot, entry: t0.entry,
        label: one ? t0.pi.label : (base ? base + "* ×" + members.length : "unnamed ×" + members.length),
        total: members.reduce((a, m) => a + m.pi.secs, 0), entryW: members.reduce((a, m) => a + m.entryW, 0),
      });
    }
    nodes.sort((a, b) => b.total - a.total);
    const small = nodes.filter(n => n.total < grand * 0.005);
    if (small.length > 1 && !TH.expanded.has(pr.pid)) {
      nodes = nodes.filter(n => !small.includes(n));
      nodes.push({ kind: "small", pid: pr.pid, members: small.flatMap(n => n.members), groups: small, hot: new Map(), entry: -1,
        label: small.reduce((a, n) => a + n.members.length, 0) + " small threads", total: small.reduce((a, n) => a + n.total, 0), entryW: 0 });
    }
    threads.push(...nodes);
  }
  threads.forEach((n, k) => { n.id = "t" + k; n.tset = [n.id]; });

  const entries = new Map(), hots = new Map(), edges = [];
  const fnNode = (map, kind, fn) => map.get(fn) || map.set(fn, { kind, fn, id: kind[0] + fn, total: 0, tset: [], by: new Map() }).get(fn);
  const multiProc = PROCS.size > 1;
  const procNodes = multiProc ? procOrder.map(pr => ({ kind: "proc", pr, id: "p" + pr.pid, total: pr.total, depth: depth(pr), tset: threads.filter(t => t.pid === pr.pid).map(t => t.id), label: pr.short })) : [];
  for (const t of threads) {
    if (multiProc) edges.push({ from: "p" + t.pid, to: t.id, w: t.total, tset: [t.id] });
    if (t.entry < 0) continue;
    const e = fnNode(entries, "entry", t.entry);
    e.total += t.entryW; e.tset.push(t.id); e.by.set(t, t.entryW);
    edges.push({ from: t.id, to: e.id, w: t.entryW, tset: [t.id] });
    const top = Array.from(t.hot).sort((a, b) => b[1] - a[1]);
    const keep = top.filter(([, w], k) => k === 0 || w >= t.total * 0.02).slice(0, 4);
    for (const [f, w] of keep) {
      const h = fnNode(hots, "hot", f);
      h.total += w; h.tset.push(t.id); h.by.set(t, w);
      let ed = edges.find(x => x.from === e.id && x.to === h.id);
      if (!ed) edges.push(ed = { from: e.id, to: h.id, w: 0, tset: [] });
      ed.w += w; ed.tset.push(t.id);
    }
  }
  return { grand, procNodes, threads, entries: Array.from(entries.values()), hots: Array.from(hots.values()), edges };
}

function renderThreads() {
  const wrap = $("#threads-wrap"), svg = $("#threads");
  if (S.view !== "threads" || !S.raw) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const G = threadsGraph(), H = wrap.clientHeight || chart.H;
  const cols = [G.procNodes, G.threads, G.entries, G.hots].filter((c, k) => k !== 0 || c.length);
  const W = Math.max(wrap.clientWidth || chart.W, cols.length * 175);
  const titles = (G.procNodes.length ? ["processes"] : []).concat(["threads", "entry points", "where time goes"]);
  const NH = 40, GAP = 10, TOP = 44, colW = W / cols.length, NW = clamp(colW - 46, 110, 270);
  const pos = new Map();
  const place = (list, ci, key) => {
    if (key) for (const n of list) {
      let sw = 0, sy = 0;
      for (const t of n.tset) { const p = pos.get(t); if (p) { const w = n.by?.get(G.threads.find(x => x.id === t)) || 1; sw += w; sy += p.y * w; } }
      n.bary = sw ? sy / sw : 0;
    }
    if (key) list.sort((a, b) => a.bary - b.bary || b.total - a.total);
    let y = TOP;
    for (const n of list) { pos.set(n.id, { x: ci * colW + (colW - NW) / 2, y, n }); y += NH + GAP; }
  };
  cols.forEach((list, ci) => place(list, ci, ci >= cols.length - 2));
  const contentH = Math.max(...cols.map(c => TOP + c.length * (NH + GAP))) + 20;
  for (const col of cols) {   // center short columns vertically
    const used = col.length * (NH + GAP) - GAP, off = Math.max(0, (Math.max(H, contentH) - TOP - 20 - used) / 2);
    for (const n of col) pos.get(n.id).y += off;
  }
  const SH = Math.max(H, contentH);
  svg.setAttribute("width", W); svg.setAttribute("height", SH); svg.setAttribute("viewBox", "0 0 " + W + " " + SH);

  let h = titles.map((t, ci) => '<text class="g-col" x="' + (ci * colW + colW / 2) + '" y="22">' + t + "</text>").join("");
  const maxE = Math.max(...G.edges.map(e => e.w), 1e-12);
  for (const e of G.edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2, dx = Math.max(30, (x2 - x1) / 2);
    h += '<path class="gedge" data-t="' + e.tset.join(" ") + '" d="M' + x1 + "," + y1 + " C" + (x1 + dx) + "," + y1 + " " + (x2 - dx) + "," + y2 + " " + x2 + "," + y2 +
      '" stroke-width="' + (1.2 + 9 * Math.sqrt(e.w / maxE)).toFixed(1) + '"/>';
  }
  const maxC = Math.floor((NW - 16) / 6.6), cut = (s, n = maxC) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const nodeSvg = (n, name, sub, cls, fill, text) => {
    const { x, y } = pos.get(n.id), frac = n.total / G.grand;
    return '<g class="gnode ' + cls + '" data-id="' + n.id + '" data-t="' + n.tset.join(" ") + '" transform="translate(' + x + "," + y + ')">' +
      '<rect width="' + NW + '" height="' + NH + '" rx="7" fill="' + fill + '"/>' +
      '<rect class="th-bar" x="6" y="' + (NH - 5) + '" height="2.5" rx="1" width="' + Math.max(1, (NW - 12) * frac).toFixed(1) + '"/>' +
      '<text x="9" y="15" class="g-name"' + (text ? ' fill="' + text + '"' : "") + ">" + esc(cut(name)) + "</text>" +
      '<text x="9" y="28" class="g-sub">' + esc(cut(sub, maxC + 6)) + "</text></g>";
  };
  for (const n of G.procNodes) h += nodeSvg(n, (n.depth ? "↳ ".repeat(Math.min(n.depth, 3)) : "") + n.label, "pid " + n.pr.pid + " · " + n.tset.length + " thread node" + (n.tset.length === 1 ? "" : "s") + " · " + fmtPct(n.total, G.grand), "th-proc", "#1d2740");
  for (const n of G.threads) {
    const sub = fmtT(n.total) + " · " + fmtPct(n.total, G.grand) + (n.kind === "small" ? " · click to expand" : n.members.length > 1 ? " · " + n.members.length + " threads" : "");
    h += nodeSvg(n, n.label, sub, n.kind === "small" ? "th-thread th-small" : "th-thread", n.kind === "small" ? "#1a1f2b" : "#25304a");
  }
  for (const n of G.entries.concat(G.hots)) {
    const fo = FN[n.fn], dim = S.match && !S.match[n.fn];
    const sub = fmtT(n.total) + " · " + fmtPct(n.total, G.grand) + (n.tset.length > 1 ? " · " + n.tset.length + " threads" : "") + (fo.cat !== "user" ? " · " + CAT_LABEL[fo.cat] : "");
    h += nodeSvg(n, fo.disp, sub, "th-fn" + (dim ? " dim" : ""), fo.color, fo.text);
  }
  svg.innerHTML = h;
  TH.nodes = new Map([...G.procNodes, ...G.threads, ...G.entries, ...G.hots].map(n => [n.id, n]));
  TH.grand = G.grand;
}

function highlightThreads(ids) {
  const svg = $("#threads");
  svg.classList.toggle("hovering", !!ids);
  const set = new Set(ids || []);
  for (const el of svg.querySelectorAll("[data-t]")) el.classList.toggle("hl", !!ids && el.dataset.t.split(" ").some(t => set.has(t)));
}

function switchThread(i, keepView) {
  if (i == null || i === S.thread) return;
  navMark();
  S.thread = i;
  LN.layout = null;
  syncPickers();
  rebuildAll(true, keepView);
}

function threadTip(n) {
  const G = TH.grand;
  if (n.kind === "proc") {
    return '<div class="t-name">' + esc(n.pr.short) + "</div>" + grid([["Process", "pid " + n.pr.pid + (n.pr.parent ? " · child of " + n.pr.parent : "")], ["Active", "<b>" + fmtT(n.total) + "</b> · " + fmtPct(n.total, G)], ["Threads", n.pr.threads.length]]) +
      (n.pr.cmd ? '<div class="t-loc">' + esc(n.pr.cmd.length > 200 ? n.pr.cmd.slice(0, 199) + "…" : n.pr.cmd) + "</div>" : "") + '<div class="t-hint">Click to open its busiest thread</div>';
  }
  if (n.kind === "thread" || n.kind === "small") {
    const rows = [["Active", "<b>" + fmtT(n.total) + "</b> · " + fmtPct(n.total, G)]];
    if (PROCS.size > 1) rows.push(["Process", esc(PROCS.get(n.pid).short) + " (" + n.pid + ")"]);
    if (n.entry >= 0) rows.push(["Entry point", esc(FN[n.entry].disp)]);
    const top = Array.from(n.hot).sort((a, b) => b[1] - a[1]).slice(0, 4);
    for (const [f, w] of top) rows.push(["→ " + esc(cut40(FN[f].disp)), fmtT(w) + " · " + fmtPct(w, n.total)]);
    const names = n.members.slice(0, 8).map(m => esc(m.pi.label) + ' <span class="t-dim">' + m.pi.tid + " · " + fmtT(m.pi.secs) + "</span>").join("<br>");
    return '<div class="t-name">' + esc(n.label) + "</div>" + grid(rows) + (n.members.length > 1 ? '<div class="t-loc">' + names + (n.members.length > 8 ? "<br>…" : "") + "</div>" : "") +
      '<div class="t-hint">' + (n.kind === "small" ? "Click to show these threads" : S.tl ? "Click to open it on the timeline" : "Click to open this thread in the flame graph") + "</div>";
  }
  const rows = [["Time", "<b>" + fmtT(n.total) + "</b> · " + fmtPct(n.total, G) + (n.kind === "entry" ? " (as entry point)" : " (deepest frame of your code)")]];
  for (const [t, w] of Array.from(n.by).sort((a, b) => b[1] - a[1]).slice(0, 6)) rows.push([esc(cut40(t.label)), fmtT(w)]);
  return fnHeader(n.fn) + grid(rows) + '<div class="t-hint">Click to switch to its busiest thread and view source</div>';
}
const cut40 = s => (s.length > 40 ? s.slice(0, 39) + "…" : s);

function bindThreads() {
  const svg = $("#threads");
  let cur = null;
  svg.addEventListener("mousemove", e => {
    const g = e.target.closest(".gnode"), n = g && TH.nodes.get(g.dataset.id);
    if (!n) { if (cur) { cur = null; hideTip(); highlightThreads(null); } return; }
    if (n !== cur) { cur = n; highlightThreads(n.tset); showTip(threadTip(n), e); } else moveTip(e);
  });
  svg.addEventListener("mouseleave", () => { cur = null; hideTip(); highlightThreads(null); });
  svg.addEventListener("click", e => {
    const g = e.target.closest(".gnode"), n = g && TH.nodes.get(g.dataset.id);
    if (!n) return;
    hideTip(); cur = null;
    if (n.kind === "small") { TH.expanded.add(n.pid); renderThreads(); return; }
    const open = i => { switchThread(i); if (S.tl) revealLane(i); else setView("flame"); };
    if (n.kind === "proc") { open(n.pr.threads.slice().sort((a, b) => PROFILES[b].secs - PROFILES[a].secs)[0]); return; }
    if (n.kind === "thread") { open(n.members[0].pi.i); return; }
    const best = Array.from(n.by).sort((a, b) => b[1] - a[1])[0];
    if (best) switchThread(best[0].members[0].pi.i);
    if (!FN[n.fn].synth) select(n.fn, 0);
  });
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
  if (it.kind[0] === "l" && it.kind !== "lane") return laneTip(it);
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
  if (it.kind === "phase") {
    const p = it.phase, path = p.fns.map(f => esc(FN[f].disp)).join(" › ");
    return (p.fn >= 0 ? fnHeader(p.fn) : '<div class="t-name">(outside your code)</div>') + grid([
      ["Duration", "<b>" + fmtV(p.wt) + "</b> · " + fmtPct(p.wt)],
      ["Starts at", fmtAxis(it.x * chart.axisTotal(), 0.01)],
    ].concat(path ? [["Path", path]] : [])) + '<div class="t-hint">Click to zoom to this phase · Phases tab lists them all</div>';
  }
  if (it.kind === "tm") {
    const n = it.node;
    if (n.kind === "fn") return fnHeader(n.fn) + grid([["Self", "<b>" + fmtV(n.value) + "</b> · " + fmtPct(n.value)], ["Total", fmtV(T.tot[n.fn]) + " · " + fmtPct(T.tot[n.fn])]]) +
      '<div class="t-hint">Click to view source · Double-click to zoom into its file</div>';
    return '<div class="t-name">' + esc(n.name) + '</div><div class="t-loc">' + esc(tmPath(n).join(" / ")) + "</div>" +
      grid([["Self time", "<b>" + fmtV(n.value) + "</b> · " + fmtPct(n.value)], ["Functions", n.count.toLocaleString()]]) + '<div class="t-hint">Click to zoom in · Esc to go back up</div>';
  }
  if (it.kind === "crumb") return '<div class="t-name">' + esc(it.node.name) + '</div><div class="t-hint">Click to go back to this level</div>';
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

/* ─── Resizable table columns ─── */

// Each table keeps one flexible column that absorbs the slack; dragged columns get pixel widths.
const COLS = {
  functions: { head: "#fn-head", flex: 2 },
  tree: { head: '.tab-body[data-body="tree"] .grid-head', flex: 0 },
  phases: { head: "#phases .prow.phead", flex: 1 },
  during: { head: "#during .drow.dhead", flex: 3 },
};
const COL_MIN = 60, COL_FLEX_MIN = 80;

function applyCols(name, widths) {
  const body = $('.tab-body[data-body="' + name + '"]'), c = COLS[name];
  const w = widths !== undefined ? widths : store.get("cols:" + name, null);
  if (!Array.isArray(w)) { body.style.removeProperty("--cols"); body.classList.remove("custom"); return; }
  body.style.setProperty("--cols", w.map((x, k) => k === c.flex ? "minmax(" + COL_FLEX_MIN + "px, 1fr)" : Math.round(x) + "px").join(" "));
  body.classList.add("custom");
}

function colHandles(name) {
  const head = $(COLS[name].head);
  if (!head) return;
  Array.from(head.children).slice(0, -1).forEach((cell, k) => {
    if (cell.querySelector(":scope > .col-rs")) return;
    const h = document.createElement("i");
    h.className = "col-rs"; h.dataset.table = name; h.dataset.k = k;
    h.title = "Drag to resize · double-click to reset all columns";
    cell.appendChild(h);
  });
}

function bindColResize() {
  document.addEventListener("pointerdown", e => {
    const h = e.target.closest && e.target.closest(".col-rs");
    if (!h) return;
    e.preventDefault(); e.stopPropagation();
    const name = h.dataset.table, k = +h.dataset.k, c = COLS[name], head = $(c.head);
    const w0 = Array.from(head.children).map(el => el.getBoundingClientRect().width);
    // Left of the flexible column a handle resizes its own column; right of it, the next one.
    const j = k < c.flex ? k : k + 1, sign = k < c.flex ? 1 : -1, room = Math.max(0, w0[c.flex] - COL_FLEX_MIN), x0 = e.clientX;
    let w = w0;
    h.setPointerCapture(e.pointerId);
    document.body.classList.add("col-resizing");
    const move = ev => {
      w = w0.slice();
      w[j] = clamp(w0[j] + sign * (ev.clientX - x0), COL_MIN, w0[j] + room);
      applyCols(name, w);
    };
    const up = () => {
      h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); h.removeEventListener("pointercancel", up);
      document.body.classList.remove("col-resizing");
      if (w !== w0) store.set("cols:" + name, w);
    };
    h.addEventListener("pointermove", move); h.addEventListener("pointerup", up); h.addEventListener("pointercancel", up);
  }, true);
  const swallow = e => { if (e.target.closest && e.target.closest(".col-rs")) { e.stopPropagation(); e.preventDefault(); return true; } return false; };
  document.addEventListener("click", swallow, true);
  document.addEventListener("dblclick", e => {
    if (!swallow(e)) return;
    const name = e.target.closest(".col-rs").dataset.table;
    store.set("cols:" + name, null); applyCols(name, null);
  }, true);
  for (const name of Object.keys(COLS)) { applyCols(name); colHandles(name); }
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
  return '<div class="t-name" style="padding-left:min(' + (d * 10) + 'px, 45%)" title="' + esc(fo.disp + (fo.rel ? "\n" + fo.rel + ":" + (maxKey(n.lines) || fo.line) : "")) + '">' +
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

const SRC = { cache: new Map(), file: null, thread: -1, lines: null, rows: null, tok: 0, cur: 0, range: null, hist: [], pos: -1 };

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

function pushHistory(fn, line) {
  const h = SRC.hist, cur = h[SRC.pos];
  if (cur && cur.fn === fn && cur.line === line) return;
  h.length = SRC.pos + 1;
  h.push({ fn, line });
  if (h.length > 200) h.shift();
  SRC.pos = h.length - 1;
  updateHistoryButtons();
}
function updateHistoryButtons() {
  $("#src-back").disabled = SRC.pos <= 0;
  $("#src-fwd").disabled = SRC.pos >= SRC.hist.length - 1;
}
function historyGo(delta) {
  const i = SRC.pos + delta, e = SRC.hist[i];
  if (!e || !FN[e.fn]) return;
  SRC.pos = i;
  updateHistoryButtons();
  select(e.fn, e.line, { fromHistory: true });
}

function lineCallChips(file, ln) {
  const m = T.lineCallees.get(file), lc = m && m.get(ln);
  if (!lc) return "";
  const arr = Array.from(lc).sort((a, b) => b[1] - a[1]);
  let h = '<span class="ccalls">';
  for (const [f, wt] of arr.slice(0, 3)) {
    const fo = FN[f];
    h += '<button class="cchip" data-fn="' + f + '" title="' + esc("Calls " + fo.disp + (fo.rel ? "  (" + fo.rel + ")" : "") + " · " + fmtV(wt)) + '">' +
      '<span class="dot" style="background:' + fillFor(f) + '"></span>' + esc(fo.disp) + " <em>" + fmtPct(wt) + "</em></button>";
  }
  if (arr.length > 3) h += '<button class="cchip more" data-more="' + ln + '">+' + (arr.length - 3) + "</button>";
  return h + "</span>";
}

function showCallMenu(btn, ln) {
  closeCallMenu();
  const lc = T.lineCallees.get(SRC.file)?.get(ln);
  if (!lc) return;
  const menu = document.createElement("div");
  menu.className = "call-menu"; menu.id = "call-menu";
  menu.innerHTML = '<div class="call-menu-head">Line ' + ln + " calls</div>" + Array.from(lc).sort((a, b) => b[1] - a[1]).slice(0, 80).map(([f, wt]) => {
    const fo = FN[f];
    return '<div class="crow" data-fn="' + f + '"><span class="pct">' + fmtPct(wt) + '</span><span class="time">' + fmtV(wt) + '</span><span class="nm"><span class="dot" style="background:' + fillFor(f) + '"></span>' + esc(fo.disp) + '<span class="loc">' + esc(fo.rel) + "</span></span><span></span></div>";
  }).join("");
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect(), mr = menu.getBoundingClientRect();
  menu.style.left = clamp(r.left, 6, innerWidth - mr.width - 6) + "px";
  menu.style.top = (r.bottom + 4 + mr.height > innerHeight ? Math.max(6, r.top - mr.height - 4) : r.bottom + 4) + "px";
}
function closeCallMenu() { const m = $("#call-menu"); if (m) m.remove(); }

async function openSource(fn, line, opts = {}) {
  const fo = FN[fn];
  if (!fo) return;
  line = line || hotLine(fn) || fo.line;
  if (!opts.fromHistory) pushHistory(fn, line);
  closeCallMenu();
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
  setSourceTarget(line);
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
    parts[i] = '<div class="' + cls + '"' + style + title + '><span class="no">' + ln + '</span><span class="heat">' + heat + '</span><span class="code">' + (hl[i] || " ") + "</span>" + lineCallChips(file, ln) + "</div>";
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
    case "timeline": return S.tl ? lanesModel() : timelineModel();
    case "tasks": return tasksModel();
    case "map": return treemapModel();
    case "graph": case "threads": return null;
    default: return flameModel(false);
  }
}

/* ─── Back / forward: views, threads, zoom, selection, Map drill-down and time windows ─── */

const NAV = { back: [], fwd: [], ready: false, restoring: false, batched: false };

function navPlace() {
  const [x0, x1] = chart.target || [chart.x0, chart.x1], h = SRC.hist[SRC.pos];
  return {
    view: S.view, thread: S.thread, tab: S.tab, x0, x1, sy: chart.sy, fn: S.selFn,
    line: h && h.fn === S.selFn ? h.line : 0, win: LN.win, tm: TM.focus ? tmPath(TM.focus) : [],
  };
}

function samePlace(a, b) {
  return a.view === b.view && a.thread === b.thread && a.fn === b.fn && a.win === b.win && a.tab === b.tab &&
    Math.abs(a.x0 - b.x0) < 1e-9 && Math.abs(a.x1 - b.x1) < 1e-9 && Math.abs(a.sy - b.sy) < 1 && a.tm.join("/") === b.tm.join("/");
}

// Call before a navigation step; steps triggered by one user action collapse into one entry.
function navMark() {
  if (!NAV.ready || NAV.restoring || NAV.batched) return;
  NAV.batched = true;
  queueMicrotask(() => { NAV.batched = false; });
  const p = navPlace(), top = NAV.back[NAV.back.length - 1];
  if (top && samePlace(top, p)) return;
  NAV.back.push(p);
  if (NAV.back.length > 200) NAV.back.shift();
  NAV.fwd.length = 0;
  updateNavButtons();
}

function updateNavButtons() {
  const b = $("#nav-back"), f = $("#nav-fwd");
  b.disabled = !NAV.back.length; f.disabled = !NAV.fwd.length;
}

function navGo(delta) {
  const from = delta < 0 ? NAV.back : NAV.fwd, to = delta < 0 ? NAV.fwd : NAV.back;
  if (!from.length) return;
  const cur = navPlace();
  let p = from.pop();
  while (p && samePlace(p, cur) && from.length) p = from.pop();
  if (!p || samePlace(p, cur)) { updateNavButtons(); return; }
  to.push(cur);
  NAV.restoring = true;
  try { restorePlace(p); } finally { NAV.restoring = false; }
  updateNavButtons();
}

function restorePlace(p) {
  hideTip();
  if (p.thread !== S.thread && PROFILES[p.thread]) { S.thread = p.thread; LN.layout = null; syncPickers(); rebuildAll(true, true); }
  if (p.view !== S.view) setView(p.view, true);
  if (p.tm.length || TM.focus) {
    let n = getTreemap();
    for (const name of p.tm) { const c = n.kids.find(k => k.name === name); if (!c) break; n = c; }
    setTreemapFocus(n);
  }
  LN.win = p.win;
  renderDuring();
  if (p.tab !== S.tab) setTab(p.tab);
  if (p.fn !== S.selFn) select(p.fn, p.line, { reveal: false, fromHistory: true });
  if (!STATIC_VIEWS.has(S.view) && S.view !== "map") {
    chart.cancelAnim();
    chart.sy = clamp(p.sy, 0, chart.maxSy());
    chart.animateTo(p.x0, p.x1);
  }
  chart.request();
}

function setView(v, keep) {
  if (v !== S.view) navMark();
  const prev = S.view;
  S.view = v; store.set("view", v);
  $$("#views button").forEach(b => b.classList.toggle("on", b.dataset.view === v));
  $(".toolbar").classList.toggle("static-view", STATIC_VIEWS.has(v));
  const timeLike = x => x === "timeline" || x === "tasks";
  hideTip();
  chart.setModel(modelForView(), keep !== undefined ? keep : (timeLike(prev) && timeLike(v)));
  renderGraph();
  renderThreads();
  updateChartInfo();
  if ((prev === "inverted") !== (v === "inverted")) refreshTree(true);
}

function updateChartInfo() {
  if (!T) return;
  if (S.view === "threads") {
    const info = profileInfo(), tot = info.reduce((a, b) => a + b.secs, 0);
    $("#chart-info").innerHTML = (PROCS.size > 1 ? "<b>" + PROCS.size + "</b> processes · " : "") + "<b>" + info.length + "</b> threads · " + fmtT(tot) +
      " active · " + (S.tl ? (S.waiting === "hide" ? "waiting excluded" : "waiting included") + " · click a thread to open it on the timeline"
        : "times are sampled activity, not wall-clock (idle time isn't recorded) · click a thread to open it");
    $("#plot-empty").hidden = true;
    return;
  }
  if (S.view === "timeline" && S.tl) {
    const info = profileInfo();
    $("#chart-info").innerHTML = (PROCS.size > 1 ? "<b>" + PROCS.size + "</b> processes · " : "") + "<b>" + info.length + "</b> threads · " + fmtDur(S.tl.span) +
      " wall clock · hatched = waiting · click a call to see what other threads did meanwhile · drag across the time axis to pick a window";
    $("#plot-empty").hidden = true;
    return;
  }
  const parts = ["<b>" + esc(T.name) + "</b>", fmtV(T.total), T.n.toLocaleString() + " samples"];
  if (S.view === "timeline" || S.view === "tasks") {
    if (T.timed) parts.push("x-axis: sampled time (idle gaps removed)");
    if (S.view === "tasks") parts.push(getTasks().lanes.length + " lanes");
  } else if (S.view === "map") {
    parts.push("area = self time · click to zoom in · Esc to go up");
  } else if (S.view === "graph") {
    parts.push("edge width = time spent in the call · click a node to recenter");
    if (S.frames !== "collapse" && S.frames !== "mine") parts.push("tip: Frames → “Collapse libraries” for a cleaner graph");
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
  highlightGraph(fn);
}

function select(fn, line, opts = {}) {
  if (!opts.fromHistory && (fn ?? -1) !== S.selFn) navMark();
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
  renderGraph();
  if (S.tab === "phases") renderPhases();
  if (S.selFn >= 0) {
    if (opts.reveal !== false) fnList.reveal(fnList.items.indexOf(fn));
    if (opts.source !== false) openSource(fn, line, { fromHistory: opts.fromHistory });
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
  if (tab === "phases") renderPhases();
  if (tab === "during") renderDuring();
}

function rebuildAll(resetSel, keepView) {
  prepareThread();
  if (resetSel) S.selFn = -1;
  if (S.selFn >= 0 && !(T.tot[S.selFn] > 0)) S.selFn = -1;
  S.hoverFn = -1;
  SRC.thread = -1;
  TM.focus = null;
  LN.layout = null;
  chart.setModel(modelForView(), !!keepView);
  renderGraph();
  renderThreads();
  updateChartInfo();
  refreshFunctions(false);
  refreshTree(true);
  renderCalls();
  renderPhases();
  renderDuring();
  updateStatus();
  if (sourceOpen() && S.selFn >= 0) openSource(S.selFn, SRC.cur || 0);
}

const fmtAmt = pi => (pi.timed ? fmtDur(pi.secs) : pi.secs + " samples");

// Process picker (only with several processes) and the thread picker for the chosen process.
function syncPickers() {
  const info = profileInfo(), pid = info[S.thread]?.pid, pr = PROCS.get(pid);
  const psel = $("#process"), tsel = $("#thread");
  if (PROCS.size > 1) psel.value = String(pid);
  const order = (pr ? pr.threads : info.map(pi => pi.i)).slice().sort((a, b) => info[b].secs - info[a].secs);
  tsel.innerHTML = order.map(i => '<option value="' + i + '">' + esc(info[i].label) + " — " + fmtAmt(info[i]) + "</option>").join("");
  tsel.value = String(S.thread);
}

function initThreads() {
  const info = profileInfo(), psel = $("#process"), tsel = $("#thread");
  if (PROCS.size > 1) {
    const procs = [], depth = new Map();
    const visit = (pr, d) => {
      procs.push(pr); depth.set(pr.pid, d);
      for (const c of Array.from(PROCS.values()).filter(c => c.parent === pr.pid && c !== pr).sort((a, b) => b.total - a.total)) visit(c, d + 1);
    };
    for (const r of Array.from(PROCS.values()).filter(p => !p.parent || !PROCS.has(p.parent)).sort((a, b) => b.total - a.total)) visit(r, 0);
    psel.innerHTML = procs.map(pr => {
      const amt = info[0]?.timed ? fmtDur(pr.total) : pr.total + " samples";
      const nm = pr.short.length > 40 ? pr.short.slice(0, 39) + "…" : pr.short;
      return '<option value="' + pr.pid + '">' + "\u00a0\u00a0".repeat(Math.min(depth.get(pr.pid), 4)) + (depth.get(pr.pid) ? "↳ " : "") +
        esc(nm) + " (" + pr.pid + ") — " + amt + "</option>";
    }).join("");
    $("#process-field").hidden = false;
    psel.addEventListener("change", () => {
      const pr = PROCS.get(+psel.value);
      if (!pr || !pr.threads.length) return;
      S.thread = pr.threads.slice().sort((a, b) => info[b].secs - info[a].secs)[0];
      syncPickers(); rebuildAll(true);
    });
  }
  S.thread = info.length ? info.map(pi => pi.i).sort((a, b) => info[b].secs - info[a].secs)[0] : 0;
  syncPickers();
  tsel.addEventListener("change", () => { S.thread = +tsel.value; rebuildAll(true); });
}

function bindUI() {
  chart.onView = onChartView;
  chart.onHover = (it, e, same) => {
    if (!it) { hideTip(); setHover(-1); return; }
    setHover(it.fn);
    if (same) moveTip(e); else showTip(tipFor(it), e);
  };
  chart.onResize = () => { if (S.view === "graph") renderGraph(); if (S.view === "threads") renderThreads(); };
  chart.onClick = it => {
    if (!it) return;
    hideTip();
    if (chart.model && chart.model.kind === "lanes" && laneClick(it)) return;
    if (it.kind === "node" && it.fn < 0) return;
    if (it.kind === "phase") { chart.zoomToItem(it); if (it.fn >= 0) select(it.fn, 0, { reveal: false }); return; }
    if (it.kind === "crumb") { setTreemapFocus(it.node); return; }
    if (it.kind === "tm") { if (it.node.kind === "fn") select(it.fn, 0); else setTreemapFocus(it.node); return; }
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
    if (z === "in") chart.zoomCenter(0.5); else if (z === "out") chart.zoomCenter(2); else chart.jumpTo(0, 1);
  }));

  const frames = $("#frames"), color = $("#color"), waiting = $("#waiting");
  frames.value = S.frames; color.value = S.color; waiting.value = S.waiting;
  waiting.addEventListener("change", () => { S.waiting = waiting.value; store.set("waiting", S.waiting); rebuildAll(false, true); renderThreads(); });
  frames.addEventListener("change", () => { S.frames = frames.value; store.set("frames", S.frames); rebuildAll(false); });
  color.addEventListener("change", () => {
    S.color = color.value; store.set("color", S.color);
    $("#legend-module").hidden = S.color !== "module"; $("#legend-heat").hidden = S.color === "module";
    chart.invalidate(); fnList.paint(); treeList.paint(); renderCalls(); renderGraph(); renderPhases();
  });
  $("#legend-module").hidden = S.color !== "module"; $("#legend-heat").hidden = S.color === "module";

  let st = 0;
  const search = $("#search");
  search.addEventListener("input", () => {
    clearTimeout(st);
    st = setTimeout(() => { S.search = search.value; updateSearchMatch(); chart.request(); refreshFunctions(false); renderGraph(); renderThreads(); }, 90);
  });
  search.addEventListener("keydown", e => {
    if (e.key === "Escape") { search.value = ""; S.search = ""; updateSearchMatch(); chart.request(); refreshFunctions(false); renderGraph(); renderThreads(); search.blur(); e.stopPropagation(); }
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
  $("#src-back").addEventListener("click", () => historyGo(-1));
  $("#src-fwd").addEventListener("click", () => historyGo(1));
  $("#nav-back").addEventListener("click", () => navGo(-1));
  $("#nav-fwd").addEventListener("click", () => navGo(1));
  updateHistoryButtons();
  $("#src-body").addEventListener("click", e => {
    const chip = e.target.closest(".cchip");
    if (!chip) return;
    e.stopPropagation();
    if (chip.dataset.more) showCallMenu(chip, +chip.dataset.more);
    else select(+chip.dataset.fn, 0);
  });
  $("#src-body").addEventListener("mouseover", e => { const c = e.target.closest(".cchip[data-fn]"); setHover(c ? +c.dataset.fn : -1); });
  $("#src-body").addEventListener("scroll", closeCallMenu, { passive: true });
  document.addEventListener("click", e => {
    const menu = $("#call-menu");
    if (!menu) return;
    const r = e.target.closest("#call-menu .crow[data-fn]");
    if (r) { closeCallMenu(); select(+r.dataset.fn, 0); }
    else if (!e.target.closest("#call-menu")) closeCallMenu();
  });
  document.addEventListener("mouseup", e => {
    if (e.button === 3 || e.button === 4) { e.preventDefault(); navGo(e.button === 3 ? -1 : 1); }
  });

  // Phases
  $("#phases").addEventListener("click", e => {
    const b = e.target.closest("[data-level]");
    if (b) {
      S.phaseLevel = clamp(S.phaseLevel + +b.dataset.level, 1, 8); store.set("phaseLevel", S.phaseLevel);
      renderPhases(); chart.request();
      return;
    }
    const r = e.target.closest(".prow[data-i]");
    if (r) focusPhase(computePhases(S.phaseLevel).phases[+r.dataset.i]);
  });
  $("#phases").addEventListener("mouseover", e => {
    const r = e.target.closest(".prow[data-i]");
    const p = r && computePhases(S.phaseLevel).phases[+r.dataset.i];
    setHover(p ? p.fn : -1);
  });
  $("#phases").addEventListener("mouseleave", () => setHover(-1));

  bindGraph();
  bindThreads();
  bindDuring();
  bindColResize();
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
      if ($("#call-menu")) { closeCallMenu(); return; }
      if (sourceOpen()) { setSourcePanel(false); return; }
      if (S.view === "map" && TM.focus && TM.focus.parent) { setTreemapFocus(TM.focus.parent); return; }
      if (LN.win) { setWindow(null); return; }
      if (chart.span < 0.9999) { chart.jumpTo(0, 1); return; }
      if (S.selFn >= 0) select(-1);
      return;
    }
    if (e.altKey && !inInput && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); navGo(e.key === "ArrowLeft" ? -1 : 1); return; }
    if (inInput || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === "/") { e.preventDefault(); $("#search").focus(); $("#search").select(); return; }
    if (k === "?") { $("#help").hidden = !$("#help").hidden; return; }
    if (k >= "1" && k <= String(VIEWS.length)) { setView(VIEWS[+k - 1]); return; }
    if (k === "s" || k === "S") { $("#btn-source").click(); return; }
    if (e.target.closest(".vlist")) return;
    if (STATIC_VIEWS.has(S.view)) return;
    if (k === "+" || k === "=") { chart.zoomCenter(0.5); return; }
    if (k === "-" || k === "_") { chart.zoomCenter(2); return; }
    if (k === "0") { chart.jumpTo(0, 1); return; }
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
  if (S.raw.codexplore?.timeline) {
    let span = +S.raw.codexplore.span || 0;
    if (!span) for (const p of S.raw.profiles || []) span = Math.max(span, +p.endValue || 0);
    S.tl = { span: span || 1 };
  }
  $("#wait-field").hidden = !S.tl;
  $("#tab-during").hidden = !S.tl;
  if (!S.tl && S.tab === "during") S.tab = "functions";
  $("#app").hidden = false;
  $("#loading").hidden = true;

  chart = new Chart();
  fnList = new VList($("#fn-list"), 24, renderFnRow, f => "fn-cols" + (f === S.selFn ? " sel" : f === S.hoverFn ? " hov" : ""));
  treeList = new VList($("#tree-list"), 24, renderTreeRow, it => "tree-cols" + (it && it.n.fn === S.selFn ? " sel" : ""));
  initThreads();
  bindUI();
  prepareThread();
  setView(S.view, false);
  setTab(S.tab);
  refreshFunctions(false);
  refreshTree(true);
  renderCalls();
  NAV.ready = true;
  updateNavButtons();
  if (store.get("sourceOpen", false)) {
    setSourcePanel(true);
    $("#src-body").innerHTML = '<div class="src-msg">Click a function in the graph or tables to see its source with per-line timing.</div>';
  }
}

document.addEventListener("DOMContentLoaded", boot);
})();
