"""Conversion of trace-mode recordings (see tracer/_codexplore_tracer.py).

Produces two files:
  profile.json  the timeline profile format (as for py-spy runs), built from exact call spans, so
                every existing view works unchanged
  calls.json    per-thread call spans, exact call counts, caller→callee edges, argument/return
                type summaries and exceptions, for the Calls view and call counts in the UI
"""

from __future__ import annotations

import array
import json
from collections import Counter, defaultdict
from pathlib import Path

from codexplore.trace import WaitClassifier

ENTER, EXIT, YIELD, RESUME, UNWIND, BCALL, BRET = 1, 2, 3, 4, 5, 6, 7
F_PY, F_LIB, F_C = 0, 1, 2

# Span flags (calls.json)
FL_RESUMED, FL_EXC, FL_BOUNDARY, FL_C, FL_WAIT, FL_SUSPENDED = 1, 2, 4, 8, 16, 32

MAX_SEGMENTS = 1_000_000
MAX_SPANS = 2_000_000

# Blocking C callables (the caller's source line catches most others, e.g. `x.wait(`).
_C_WAIT = {
    "time.sleep", "lock.acquire", "RLock.acquire", "_thread.lock.acquire", "select.select", "select.poll",
    "poll.poll", "epoll.poll", "kqueue.control", "socket.recv", "socket.recv_into", "socket.recvfrom",
    "socket.accept", "socket.connect", "posix.read", "posix.waitpid", "posix.wait", "os.read", "os.waitpid",
    "SimpleQueue.get", "_queue.SimpleQueue.get", "Event.wait", "Condition.wait", "signal.pause",
    "_overlapped.GetQueuedCompletionStatus", "builtins.input", "input",
}


def _qualify_names(funcs: list[list]) -> None:
    """Bare dunder names on Python < 3.11 (no co_qualname): __init__ -> MyClass.__init__."""
    from codexplore.runner import _DUNDER_RE, _find_enclosing_class

    cache: dict = {}
    for f in funcs:
        name, file, line = f[0], f[1], f[2]
        if file and line > 0 and _DUNDER_RE.match(name) and "." not in name:
            cls = _find_enclosing_class(file, line, cache)
            if cls:
                f[0] = f"{cls}.{name}"


def _load(trace_dir: Path) -> list[dict]:
    procs = []
    for jf in sorted(trace_dir.glob("*.json")):
        try:
            meta = json.loads(jf.read_text())
        except (OSError, ValueError):
            continue
        chunks: dict[int, array.array] = defaultdict(lambda: array.array("q"))
        bf = jf.with_suffix(".bin")
        if bf.exists():
            a = array.array("q")
            a.frombytes(bf.read_bytes()[: (bf.stat().st_size // 8) * 8])
            i, n = 0, len(a)
            while i + 2 <= n:
                serial, m = a[i], a[i + 1]
                i += 2
                if m < 0 or i + m > n:
                    break  # torn final write (process killed mid-flush)
                chunks[serial].extend(a[i:i + m])
                i += m
        meta["_chunks"] = chunks
        procs.append(meta)
    return procs


def convert_exact_trace(trace_dir: Path, profile_out: Path, calls_out: Path, t0_wall_ns: int | None = None) -> dict:
    procs = _load(trace_dir)
    if not procs:
        raise RuntimeError("no trace data was written (was the target a Python program?)")
    T0 = t0_wall_ns or min(p["wall0"] for p in procs)

    # Global function and string tables.
    gfuncs: list[list] = []
    gfid: dict[tuple, int] = {}
    gstrings: list[str] = []
    gsid: dict[str, int] = {}

    def gs(s: str) -> int:
        i = gsid.get(s)
        if i is None:
            i = gsid[s] = len(gstrings)
            gstrings.append(s)
        return i

    for p in procs:
        fmap = []
        for name, file, line, kind in p["funcs"]:
            key = (name, file, line, kind)
            i = gfid.get(key)
            if i is None:
                i = gfid[key] = len(gfuncs)
                gfuncs.append([name, file, line, kind])
            fmap.append(i)
        p["_fmap"] = fmap
        p["_smap"] = [gs(s) for s in p["strings"]]
    _qualify_names(gfuncs)

    frames: list[dict] = []
    frame_idx: dict[tuple, int] = {}

    def frame(g: int, line: int) -> int:
        key = (g, line)
        i = frame_idx.get(key)
        if i is None:
            i = frame_idx[key] = len(frames)
            f = gfuncs[g]
            frames.append({"name": f[0], "file": f[1], "line": line})
        return i

    waits = WaitClassifier()
    wait_cache: dict[tuple, bool] = {}

    def is_wait(g: int, caller: int, call_line: int) -> bool:
        key = (g, caller, call_line)
        hit = wait_cache.get(key)
        if hit is None:
            name, file, _line, kind = gfuncs[g]
            hit = name in _C_WAIT or (kind == F_LIB and waits.is_waiting(name, file, 0))
            if not hit and caller >= 0 and call_line > 0:
                hit = waits.is_waiting(name, gfuncs[caller][1], call_line)
            wait_cache[key] = hit
        return hit

    counts: Counter = Counter()
    totals: defaultdict = defaultdict(float)
    edges: dict[tuple, list] = {}
    sigs: defaultdict = defaultdict(Counter)
    excs: defaultdict = defaultdict(Counter)
    threads_out = []
    profiles = []
    processes = {}
    span_budget = [MAX_SPANS]
    truncated = False
    end_all = 0.0

    for p in procs:
        pid, fmap, smap = p["pid"], p["_fmap"], p["_smap"]
        perf0, wall0 = p["perf0"], p["wall0"]
        to_s = lambda t: (wall0 + (t - perf0) - T0) / 1e9  # noqa: E731
        p_end = to_s(p["end"])
        end_all = max(end_all, p_end)
        truncated = truncated or bool(p.get("truncated"))
        processes[str(pid)] = {"cmd": p.get("cmd", ""), "ppid": p.get("ppid", 0), "first": round(to_s(perf0), 6), "last": round(p_end, 6)}
        for a, b, c, ns in p.get("agg", []):
            ga, gb = (fmap[a] if a >= 0 else -1), fmap[b]
            counts[gb] += c
            totals[gb] += ns / 1e9
            e = edges.setdefault((ga, gb), [0, 0.0])
            e[0] += c
            e[1] += ns / 1e9
        tinfo = p.get("threads", {})
        for serial, ev in p["_chunks"].items():
            if not len(ev):
                continue
            info = tinfo.get(str(serial), {})
            t_end = to_s(info["end"]) if info.get("end") else p_end
            # Stack entries: [gfid, t0, span, call_line, frame_id_as_leaf]
            stack: list[list] = []
            fstack: list[int] = []
            active: Counter = Counter()
            segs: list[tuple] = []
            sp = {k: [] for k in ("fn", "t0", "t1", "parent", "line", "flags", "args", "ret", "exc", "prev")}
            gen_last: dict[tuple, int] = {}
            cur = None

            def seg_to(t: float) -> None:
                nonlocal cur
                if cur is not None and t > cur:
                    idle = True
                    if stack:
                        top = stack[-1]
                        g = top[0]
                        if gfuncs[g][3] == F_PY:
                            idle = False
                        else:
                            caller = stack[-2][0] if len(stack) > 1 else -1
                            idle = is_wait(g, caller, top[3])
                    segs.append((cur, t, tuple(fstack), idle))
                cur = t

            def open_span(g: int, t: float, line: int, flags: int, args: int, prev: int) -> int:
                if span_budget[0] <= 0:
                    return -1
                span_budget[0] -= 1
                i = len(sp["fn"])
                sp["fn"].append(g)
                sp["t0"].append(round(t, 7))
                sp["t1"].append(round(t, 7))
                sp["parent"].append(stack[-1][2] if stack else -1)
                sp["line"].append(line)
                sp["flags"].append(flags)
                sp["args"].append(args)
                sp["ret"].append(-1)
                sp["exc"].append(-1)
                sp["prev"].append(prev)
                return i

            def push(g: int, t: float, line: int, flags: int, args: int, prev: int, resumed: bool) -> None:
                if fstack:
                    fstack[-1] = frame(stack[-1][0], line or gfuncs[stack[-1][0]][2])
                parent = stack[-1][0] if stack else -1
                si = open_span(g, t, line, flags, args, prev)
                stack.append([g, t, si, line, resumed])
                fstack.append(frame(g, gfuncs[g][2]))
                if not resumed:
                    counts[g] += 1
                    e = edges.setdefault((parent, g), [0, 0.0])
                    e[0] += 1
                active[g] += 1

            def pop(g: int, t: float, flags: int = 0, ret: int = -1, exc: int = -1) -> int:
                k = len(stack) - 1
                while k >= 0 and stack[k][0] != g:
                    k -= 1
                if k < 0:
                    return -1
                si = -1
                while len(stack) > k:
                    e = stack.pop()
                    fstack.pop()
                    dur = t - e[1]
                    active[e[0]] -= 1
                    if active[e[0]] == 0:
                        totals[e[0]] += dur
                    parent = stack[-1][0] if stack else -1
                    ed = edges.get((parent, e[0]))
                    if ed is not None:
                        ed[1] += dur
                    si = e[2]
                    if si >= 0:
                        sp["t1"][si] = round(t, 7)
                        if len(stack) == k:
                            sp["flags"][si] |= flags
                            sp["ret"][si] = ret
                            sp["exc"][si] = exc
                if fstack:
                    fstack[-1] = frame(stack[-1][0], gfuncs[stack[-1][0]][2])
                return si

            n = len(ev)
            for j in range(0, n - 4, 5):
                t = to_s(ev[j])
                kind, f, line, aux = ev[j + 1], ev[j + 2], ev[j + 3], ev[j + 4]
                if f < 0 or f >= len(fmap):
                    continue
                g = fmap[f]
                if cur is None:
                    cur = t
                seg_to(t)
                if kind == ENTER:
                    a = smap[aux] if aux >= 0 else -1
                    push(g, t, line, 0, a, -1, False)
                elif kind == RESUME:
                    prev = gen_last.get((g, aux), -1)
                    push(g, t, line, FL_RESUMED, -1, prev, True)
                elif kind == BCALL:
                    inherited = bool(aux & 2)  # already running when the process forked
                    fl = FL_BOUNDARY | (FL_C if aux & 1 else 0) | (FL_RESUMED if inherited else 0)
                    push(g, t, line, fl, -1, -1, inherited)
                elif kind == EXIT:
                    si = pop(g, t, 0, smap[aux] if aux >= 0 else -1)
                    if si >= 0 and sp["ret"][si] >= 0:
                        sigs[g][(sp["args"][si], sp["ret"][si])] += 1
                    elif si >= 0 and sp["args"][si] >= 0:
                        sigs[g][(sp["args"][si], -1)] += 1
                elif kind == YIELD:
                    si = pop(g, t, FL_SUSPENDED)
                    if si >= 0:
                        gen_last[(g, aux)] = si
                elif kind == UNWIND:
                    exc = smap[aux] if aux >= 0 else -1
                    si = pop(g, t, FL_EXC, -1, exc)
                    if exc >= 0:
                        excs[g][gstrings[exc]] += 1
                    if si >= 0 and sp["args"][si] >= 0:
                        sigs[g][(sp["args"][si], -1)] += 1
                elif kind == BRET:
                    exc = smap[aux] if aux >= 0 else -1
                    pop(g, t, FL_EXC if aux >= 0 else 0, -1, exc)
                    if exc >= 0:
                        excs[g][gstrings[exc]] += 1
            # Close whatever is still open when the thread (or process) ended.
            if cur is not None:
                last = max(cur, t_end)
                seg_to(last)
                while stack:
                    pop(stack[-1][0], last)
            for i, fl in enumerate(sp["flags"]):
                if fl & FL_BOUNDARY:
                    k = sp["parent"][i]
                    caller = sp["fn"][k] if k >= 0 else -1
                    if is_wait(sp["fn"][i], caller, sp["line"][i]):
                        sp["flags"][i] = fl | FL_WAIT
            if not segs:
                continue
            name = (info.get("name") or "").replace('"', "'")
            native = info.get("native") or serial
            active_s = sum(b - a for a, b, _s, idle in segs if not idle)
            profiles.append({
                "type": "sampled",
                "name": f'Process {pid} Thread {native} "{name}"' if name else f"Process {pid} Thread {native}",
                "unit": "seconds",
                "startValue": round(segs[0][0], 6),
                "endValue": round(segs[-1][1], 6),
                "_segs": segs,
                "_active": active_s,
                "_key": (pid, serial),
            })
            threads_out.append({"key": (pid, serial), "pid": pid, "name": name, "native": native, **sp})

    # Keep the browser responsive on huge traces: merge the shortest segments into their neighbour.
    total = sum(len(p["_segs"]) for p in profiles)
    thr = 1e-6
    while total > MAX_SEGMENTS and thr < 1:
        thr *= 2
        total = 0
        for p in profiles:
            merged = []
            for s in p["_segs"]:
                if merged and s[1] - s[0] < thr:
                    a, _b, stk, idle = merged[-1]
                    merged[-1] = (a, s[1], stk, idle)
                else:
                    merged.append(s)
            p["_segs"] = merged
            total += len(merged)

    profiles.sort(key=lambda p: -p["_active"])
    index = {p["_key"]: i for i, p in enumerate(profiles)}
    for p in profiles:
        segs = p.pop("_segs")
        p.pop("_active"), p.pop("_key")
        p["samples"] = [list(s[2]) for s in segs]
        p["weights"] = [round(s[1] - s[0], 7) for s in segs]
        p["times"] = [round(s[0], 7) for s in segs]
        p["idle"] = [1 if s[3] else 0 for s in segs]

    data = {
        "$schema": "https://www.speedscope.app/file-format-schema.json",
        "exporter": "codexplore (trace)",
        "shared": {"frames": frames},
        "profiles": profiles,
        "codexplore": {
            "timeline": True, "mode": "trace", "span": round(end_all, 6), "processes": processes,
            "named_threads": sum(1 for t in threads_out if t["name"]), "truncated": truncated,
        },
    }
    with open(profile_out, "w") as f:
        f.write(json.dumps(data, separators=(",", ":")))  # dumps uses the C encoder, dump doesn't

    for t in threads_out:
        t["profile"] = index.get(t.pop("key"), -1)
    calls = {
        "version": 1,
        "funcs": gfuncs,
        "strings": gstrings,
        "threads": sorted((t for t in threads_out if t["profile"] >= 0), key=lambda t: t["profile"]),
        "counts": {str(g): [c, round(totals[g], 7)] for g, c in counts.items()},
        "edges": [[a, b, c[0], round(c[1], 7)] for (a, b), c in edges.items()],
        "sigs": {str(g): [[a, r, n] for (a, r), n in c.most_common(6)] for g, c in sigs.items()},
        "excs": {str(g): c.most_common(6) for g, c in excs.items()},
        "truncated": truncated,
        "spans_truncated": span_budget[0] <= 0,
        "engines": sorted({p.get("engine", "") for p in procs}),
        "errors": [p["error"] for p in procs if p.get("error")],
    }
    with open(calls_out, "w") as f:
        f.write(json.dumps(calls, separators=(",", ":")))  # dumps uses the C encoder, dump doesn't

    return {
        "threads": len(profiles), "processes": len(processes), "functions": sum(1 for f in gfuncs if f[3] == F_PY),
        "calls": sum(counts.values()), "span": end_all, "truncated": truncated,
        "named": data["codexplore"]["named_threads"], "errors": calls["errors"],
    }
