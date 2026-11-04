"""codexplore tracer: records every call in your code, and the first call out of it.

Runs inside the traced interpreter (started by the sitecustomize next to this file), so it must
use the standard library only and support Python 3.10+.

Engines: `sys.monitoring` on 3.12+ (out-of-scope code is switched off per code object, so
libraries run at full speed) and `sys.setprofile` on 3.10/3.11.

Output, per process, in the configured directory:
  <pid>.bin   chunks of int64 events (time_ns, kind, func, line, aux), one chunk per thread flush
  <pid>.json  tables: functions, strings, threads, aggregates, process info
"""

import array
import atexit
import json
import os
import re
import sys
import threading
import time
import types
from _thread import allocate_lock, get_ident
from bisect import bisect_right

ENTER, EXIT, YIELD, RESUME, UNWIND, BCALL, BRET = 1, 2, 3, 4, 5, 6, 7
F_PY, F_LIB, F_C = 0, 1, 2  # function kinds: your code, library Python function, C callable
K_OUT, K_IN, K_BOUNDARY = 0, 1, 2  # code-object classes

_ARG_SCHEDULE = frozenset((1, 2, 3, 10, 100, 1000, 10000, 100000))
_SECRET_NAME_RE = re.compile(r"token|secret|passw|pwd|api_?key|apikey|auth|cookie|credential|private|session", re.I)
_SECRET_VALUE_RE = re.compile(r"\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|glpat-|xox[abprs]-|AKIA[0-9A-Z]{8,}|ASIA[0-9A-Z]{8,}|AIza[0-9A-Za-z_-]{8,}|hf_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{10,}\.)|-----BEGIN")
_TRIVIAL = frozenset((
    "len", "isinstance", "issubclass", "getattr", "setattr", "hasattr", "delattr", "id", "hash", "type",
    "iter", "next", "callable", "repr", "str", "int", "float", "bool", "bytes", "tuple", "list", "dict", "set",
    "frozenset", "abs", "min", "max", "round", "divmod", "ord", "chr", "range", "enumerate", "zip", "reversed",
    "super", "object", "slice", "__build_class__", "__import__", "property", "staticmethod", "classmethod", "format", "vars", "locals", "globals",
    "list.append", "list.pop", "list.extend", "list.insert", "list.copy", "dict.get", "dict.items", "dict.keys",
    "dict.values", "dict.setdefault", "dict.pop", "dict.update", "dict.copy", "set.add", "set.discard",
    "str.join", "str.format", "str.split", "str.strip", "str.startswith", "str.endswith", "str.replace",
    "str.lower", "str.upper", "str.encode", "bytes.decode", "time.time", "time.perf_counter", "time.monotonic",
    "time.time_ns", "time.perf_counter_ns", "time.monotonic_ns", "math.sqrt", "math.floor", "math.ceil",
))

_cfg: dict = {}
_lock = allocate_lock()
_perf = time.perf_counter_ns
_here = os.path.abspath(__file__)


class _State:
    """Process-global tables (rebuilt in a forked child)."""

    def __init__(self) -> None:
        self.pid = os.getpid()
        self.perf0 = _perf()
        self.wall0 = time.time_ns()
        self.funcs: list = []          # [name, file, line, kind]
        self.fid: dict = {}            # key -> func id
        self.strings: list = []
        self.sid: dict = {}
        self.threads: dict = {}        # ident -> _Thread (live)
        self.done: list = []           # finished threads not yet written
        self.meta_threads: dict = {}   # serial -> info (all threads ever)
        self.serial = 0
        self.agg: dict = {}            # (caller fid, callee fid) -> [count, ns]
        self.calls: dict = {}          # fid -> calls seen (argument schedule)
        self.events = 0
        self.cap = int(_cfg.get("max_events") or 5_000_000)
        self.truncated = False
        self.closed = False
        self.last_flush = self.perf0
        self.chunks = 0
        self.dirty = True
        self.error = ""
        self.finished = False


S: _State = None  # type: ignore[assignment]


class _Thread:
    __slots__ = ("serial", "ident", "ev", "stack", "call", "n", "ref", "busy")

    def __init__(self, ident: int, thread_obj, foreign: bool) -> None:
        S.serial += 1
        self.serial = S.serial
        self.ident = ident
        self.ev = array.array("q")
        self.stack: list = []
        self.call = None   # (callee code, caller code, offset) set by CALL just before PY_START
        self.n = 0
        self.ref = thread_obj
        self.busy = False
        native = threading.get_native_id() if hasattr(threading, "get_native_id") else ident
        name = getattr(thread_obj, "name", "") if thread_obj is not None else ""
        if not name or foreign:
            name = _os_thread_name(native) or name
        S.meta_threads[self.serial] = {
            "ident": ident, "native": native, "name": name, "start": _perf(), "end": None,
            "foreign": foreign, "daemon": bool(getattr(thread_obj, "daemon", False)),
        }
        S.dirty = True


def _os_thread_name(native: int) -> str:
    try:
        with open(f"/proc/self/task/{native}/comm") as f:
            return f.read().strip()
    except OSError:
        return ""


# ─── Tables ──────────────────────────────────────────────────────────────────


def _string(s: str) -> int:
    i = S.sid.get(s)
    if i is None:
        i = S.sid[s] = len(S.strings)
        S.strings.append(s)
        S.dirty = True
    return i


def _func(key, name: str, file: str, line: int, kind: int) -> int:
    i = S.fid.get(key)
    if i is None:
        i = S.fid[key] = len(S.funcs)
        S.funcs.append([name, file, line, kind])
        S.dirty = True
    return i


_code_info: dict = {}   # id(code) -> (code, class, fid)
_scope_cache: dict = {}
_lines_cache: dict = {}  # id(code) -> (code, starts, lines)
_boundary_codes: set = set()
_restarts = [0]
_disabled: set = set()


def _file_in_scope(filename: str) -> bool:
    hit = _scope_cache.get(filename)
    if hit is not None:
        return hit
    hit = False
    if filename and not filename.startswith("<"):
        p = os.path.abspath(filename)
        if p == _here or p.startswith(os.path.dirname(_here) + os.sep):
            hit = False
        elif any(f"{os.sep}{name}{os.sep}" in p or p.endswith(f"{os.sep}{name}.py") for name in _cfg.get("include", ())):
            hit = True
        elif "site-packages" in p or "dist-packages" in p:
            hit = False
        elif any(p.startswith(pre + os.sep) for pre in _std_prefixes):
            hit = False
        else:
            root = _cfg.get("root") or ""
            if root and p.startswith(root + os.sep):
                rel = p[len(root) + 1:].split(os.sep)
                hit = not any(part in _SKIP_DIRS for part in rel[:-1])
    _scope_cache[filename] = hit
    return hit


_SKIP_DIRS = frozenset((".venv", "venv", "env", ".env", ".tox", ".nox", "node_modules", ".git", "__pypackages__", "site-packages"))
_std_prefixes: tuple = ()


def _code_name(code) -> str:
    return getattr(code, "co_qualname", None) or code.co_name


def _classify(code):
    """(code, class, fid) for a code object, cached by identity."""
    ent = _code_info.get(id(code))
    if ent is not None and ent[0] is code:
        return ent
    if _file_in_scope(code.co_filename):
        ent = (code, K_IN, _func(code, _code_name(code), code.co_filename, code.co_firstlineno, F_PY))
    elif code in _boundary_codes:
        ent = (code, K_BOUNDARY, _func(code, _code_name(code), code.co_filename, code.co_firstlineno, F_LIB))
    else:
        ent = (code, K_OUT, -1)
    _code_info[id(code)] = ent
    return ent


def _line_of(code, offset: int) -> int:
    ent = _lines_cache.get(id(code))
    if ent is None or ent[0] is not code:
        starts, lines = [], []
        for a, _b, ln in code.co_lines():
            if ln is not None:
                starts.append(a)
                lines.append(ln)
        ent = _lines_cache[id(code)] = (code, starts, lines)
    k = bisect_right(ent[1], offset) - 1
    return ent[2][k] if k >= 0 else code.co_firstlineno


_cname_cache: dict = {}


def _c_name(f) -> str:
    hit = _cname_cache.get(id(f))
    if hit is not None and hit[0] is f:
        return hit[1]
    name = _c_name_uncached(f)
    if len(_cname_cache) < 50_000:
        _cname_cache[id(f)] = (f, name)
    return name


def _c_name_uncached(f) -> str:
    tf = type(f)
    if tf is type or isinstance(f, type):
        return f.__qualname__
    if not hasattr(f, "__qualname__") and not hasattr(f, "__name__"):
        return f"{tf.__qualname__}.__call__"
    selfobj = getattr(f, "__self__", None)
    name = getattr(f, "__qualname__", None) or getattr(f, "__name__", None) or tf.__name__
    if selfobj is not None and type(selfobj).__name__ != "module":
        owner = type(selfobj).__qualname__ if not isinstance(selfobj, type) else selfobj.__qualname__
        return name if "." in name else f"{owner}.{name}"
    mod = getattr(f, "__module__", None)
    if isinstance(selfobj, type(sys)):
        mod = selfobj.__name__
    if mod and mod not in ("builtins", "__main__") and "." not in name:
        return f"{mod}.{name}"
    return name


def _module_file(obj) -> str:
    mod = sys.modules.get(getattr(obj, "__module__", None) or "")
    return getattr(mod, "__file__", "") or ""


# ─── Argument summaries (never calls user __repr__) ─────────────────────────


def _summ(v, depth: int, name: str = "", vals: bool = True) -> str:
    tv = type(v)
    tn = tv.__qualname__
    mod = tv.__module__ or ""
    values = vals and _cfg.get("values")
    if v is None or tv in (bool, int, float, complex):
        if values and not _SECRET_NAME_RE.search(name):
            r = repr(v)
            return r if len(r) <= 40 else tn
        return tn if v is not None else "None"
    if tv is str or tv is bytes:
        if values and not _SECRET_NAME_RE.search(name) and len(v) <= 80:
            r = repr(v)
            return "<redacted>" if _SECRET_VALUE_RE.search(r) else r
        return f"{tn}[{len(v)}]"
    if mod.startswith(("torch", "numpy", "jax", "jaxlib", "cupy", "tensorflow")) and hasattr(v, "shape") and hasattr(v, "dtype"):
        try:
            shape = ",".join(str(int(x)) for x in tuple(v.shape))
            dtype = str(v.dtype).replace("torch.", "")
            dev = getattr(v, "device", None)
            dev = str(dev) if dev is not None else ""
            short = "Tensor" if mod.startswith("torch") else "ndarray" if mod.startswith("numpy") else tn
            return f"{short}[{shape}] {dtype}" + (f" {dev}" if dev and dev != "cpu" else "")
        except Exception:
            return tn
    if mod.startswith("pandas") and hasattr(v, "shape"):
        try:
            return f"{tn}[{','.join(str(int(x)) for x in v.shape)}]"
        except Exception:
            return tn
    if tv in (list, tuple, set, frozenset) or (isinstance(v, tuple) and hasattr(v, "_fields")):
        try:
            n = len(v)
            if hasattr(v, "_fields") and depth < 2:
                parts = [f"{f}: {_summ(getattr(v, f), depth + 1, f)}" for f in list(v._fields)[:6]]
                return f"{tn}({', '.join(parts)}{', …' if len(v._fields) > 6 else ''})"
            if n and depth < 2 and tv in (list, tuple):
                if values and n <= 6 and not _SECRET_NAME_RE.search(name) and all(type(x) in (int, float, bool) for x in v):
                    r = repr(v)
                    if len(r) <= 40:
                        return r
                return f"{tn}[{n}] of {_summ(v[0], depth + 1, name, False)}"
            return f"{tn}[{n}]"
        except Exception:
            return tn
    if tv is dict:
        try:
            n = len(v)
            if n and depth < 2:
                keys = list(v.keys())[:6]
                if all(type(k) is str for k in keys):
                    parts = [f"{k[:24]}: {_summ(v[k], depth + 1, k)}" for k in keys]
                    return "{" + ", ".join(parts) + (", …" if n > 6 else "") + "}"
                k0 = keys[0]
                return f"dict[{n}] {type(k0).__qualname__} → {_summ(v[k0], depth + 1, name)}"
            return f"dict[{n}]"
        except Exception:
            return "dict"
    fields = getattr(tv, "__dataclass_fields__", None)
    if fields is not None and depth < 1:
        d = getattr(v, "__dict__", None)
        if isinstance(d, dict):
            parts = [f"{f}: {_summ(d[f], depth + 1, f)}" for f in list(fields)[:6] if f in d]
            return f"{tn}({', '.join(parts)}{', …' if len(fields) > 6 else ''})"
    if tv is type:
        return f"type[{v.__qualname__}]"
    if callable(v) and hasattr(v, "__qualname__"):
        return f"<{tn} {v.__qualname__}>"
    return tn


def _cap(s: str, n: int = 200) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"


def _args_summary(code, frame) -> str:
    n = code.co_argcount + code.co_kwonlyargcount
    flags = code.co_flags
    names = list(code.co_varnames[:n])
    if flags & 0x04:
        names.append("*" + code.co_varnames[n])
        n += 1
    if flags & 0x08:
        names.append("**" + code.co_varnames[n])
    loc = frame.f_locals
    parts = []
    for i, nm in enumerate(names):
        key = nm.lstrip("*")
        if i == 0 and key in ("self", "cls"):
            continue
        if key not in loc:
            continue
        v = loc[key]
        parts.append(f"{nm}: {'<redacted>' if _SECRET_NAME_RE.search(key) and _cfg.get('values') and type(v) in (str, bytes) else _summ(v, 0, key)}")
    return _cap("(" + ", ".join(parts) + ")")


def _ret_summary(v) -> str:
    return _cap(_summ(v, 0))


# ─── Event writing ──────────────────────────────────────────────────────────


def _thread() -> "_Thread | None":
    ident = get_ident()
    st = S.threads.get(ident)
    if st is None:
        if ident == _skip_ident[0] or S.closed:
            return None
        obj = threading._active.get(ident)  # type: ignore[attr-defined]
        st = S.threads[ident] = _Thread(ident, obj, obj is None or type(obj).__name__ == "_DummyThread")
    return st


_skip_ident = [0]


def _write(st: _Thread, t: int, kind: int, fid: int, line: int, aux: int) -> None:
    st.ev.extend((t, kind, fid, line, aux))
    S.events += 1
    st.n += 1
    if S.events >= S.cap and not S.truncated:
        S.truncated = True
        S.dirty = True
    if not (st.n & 4095) and t - S.last_flush > 1_000_000_000:
        _flush(False)


def _materialize(st: _Thread) -> None:
    """Write pending boundary calls on the stack (they got a nested call or must be kept)."""
    for e in st.stack:
        if not e[3]:
            if e[0] == 0 or S.truncated:
                continue
            _write(st, e[2], BCALL, e[1], e[6], 1 if e[0] == 2 else 0)
            e[3] = True


def _close_boundary(st: _Thread, e, t: int, exc: int) -> None:
    dur = t - e[2]
    if e[3]:
        _write(st, t, BRET, e[1], 0, exc)
    elif (dur >= _min_ns or exc >= 0) and not S.truncated:
        _write(st, e[2], BCALL, e[1], e[6], 1 if e[0] == 2 else 0)
        _write(st, t, BRET, e[1], 0, exc)
    else:
        a = S.agg.get((e[7], e[1]))
        if a is None:
            S.agg[(e[7], e[1])] = [1, dur]
        else:
            a[0] += 1
            a[1] += dur


def _close_frame(st: _Thread, e, t: int, kind: int, aux: int) -> None:
    if e[3]:
        _write(st, t, kind, e[1], 0, aux)
    else:
        key = (e[7], e[1])
        a = S.agg.get(key)
        if a is None:
            S.agg[key] = [1, t - e[2]]
        else:
            a[0] += 1
            a[1] += t - e[2]


def _top_fid(st: _Thread) -> int:
    for e in reversed(st.stack):
        if e[0] == 0:
            return e[1]
    return -1


def _enter(st: _Thread, code, fid: int, t: int, line: int, frame_getter, resumed: bool, gen: int) -> None:
    aux = -1
    n = 0
    if not resumed:
        n = S.calls.get(fid, 0) + 1
        S.calls[fid] = n
    if not resumed and n in _ARG_SCHEDULE and not S.truncated:
        try:
            st.busy = True
            aux = _string(_args_summary(code, frame_getter()))
        except Exception:
            aux = -1
        finally:
            st.busy = False
    parent = _top_fid(st)
    if S.truncated:
        st.stack.append([0, fid, t, False, aux, code, line, parent])
        return
    _materialize(st)
    _write(st, t, RESUME if resumed else ENTER, fid, line, gen if resumed else aux)
    st.stack.append([0, fid, t, True, aux, code, line, parent])


def _leave(st: _Thread, code, t: int, kind: int, aux_fn, always: bool = False) -> bool:
    """Pop up to and including the frame of `code`; closes anything left above it."""
    stack = st.stack
    for k in range(len(stack) - 1, -1, -1):
        e = stack[k]
        if e[0] == 0 and e[5] is code:
            while len(stack) > k + 1:
                b = stack.pop()
                if b[0] == 0:
                    _close_frame(st, b, t, EXIT, -1)
                else:
                    _close_boundary(st, b, t, -1)
            stack.pop()
            aux = -1
            if aux_fn is not None and e[3] and (always or e[4] >= 0):
                try:
                    st.busy = True
                    aux = aux_fn()
                except Exception:
                    aux = -1
                finally:
                    st.busy = False
            _close_frame(st, e, t, kind, aux)
            return True
    return False


_min_ns = 20_000


# ─── sys.monitoring engine (3.12+) ──────────────────────────────────────────


def _install_monitoring() -> bool:
    mon = getattr(sys, "monitoring", None)
    if mon is None:
        return False
    tool = None
    for cand in (getattr(mon, "PROFILER_ID", 2), 3, 4):
        try:
            mon.use_tool_id(cand, "codexplore")
            tool = cand
            break
        except ValueError:
            continue
    if tool is None:
        sys.stderr.write("codexplore: no free sys.monitoring tool id; tracing disabled\n")
        return True
    E = mon.events
    DISABLE = mon.DISABLE
    getframe = sys._getframe
    FunctionType, MethodType = types.FunctionType, types.MethodType

    def fail(e: BaseException) -> None:
        S.error = repr(e)
        S.closed = True
        try:
            mon.set_events(tool, 0)
        except Exception:
            pass
        sys.stderr.write(f"codexplore: tracer error, tracing stopped: {e!r}\n")

    def py_start(code, offset):
        try:
            ent = _classify(code)
            cls = ent[1]
            if cls == K_OUT:
                _disabled.add(id(code))
                return DISABLE
            if S.closed:
                return None
            st = _thread()
            if st is None or st.busy:
                return None
            t = _perf()
            if cls == K_IN:
                call = st.call
                line = 0
                if call is not None and call[0] is code:
                    line = _line_of(call[1], call[2])
                st.call = None
                _enter(st, code, ent[2], t, line, lambda: getframe(3), False, 0)
            else:
                stack = st.stack
                if stack:
                    top = stack[-1]
                    if top[0] == 1 and top[5] is code:
                        top[4] += 1  # started (0) or recursive entry (>0)
            return None
        except Exception as e:  # pragma: no cover - defensive
            fail(e)
            return None

    def py_resume(code, offset):
        try:
            ent = _classify(code)
            if ent[1] == K_OUT:
                return DISABLE
            if S.closed or ent[1] != K_IN:
                return None
            st = _thread()
            if st is None or st.busy:
                return None
            st.call = None
            _enter(st, code, ent[2], _perf(), 0, None, True, id(getframe(1)))
            return None
        except Exception as e:
            fail(e)
            return None

    def py_throw(code, offset, exc):
        try:
            ent = _classify(code)
            if ent[1] != K_IN or S.closed:
                return None
            st = _thread()
            if st is None or st.busy:
                return None
            _enter(st, code, ent[2], _perf(), 0, None, True, id(getframe(1)))
        except Exception as e:
            fail(e)
        return None

    def _end_boundary(st, code, t, exc):
        stack = st.stack
        if stack:
            top = stack[-1]
            if top[0] == 1 and top[5] is code:
                if top[4] > 0:
                    top[4] -= 1
                else:
                    stack.pop()
                    _close_boundary(st, top, t, exc)

    def py_return(code, offset, retval):
        try:
            ent = _classify(code)
            cls = ent[1]
            if cls == K_OUT:
                return DISABLE
            if S.closed:
                return None
            st = _thread()
            if st is None or st.busy:
                return None
            t = _perf()
            if cls == K_IN:
                _leave(st, code, t, EXIT, lambda: _string(_ret_summary(retval)))
            else:
                _end_boundary(st, code, t, -1)
            return None
        except Exception as e:
            fail(e)
            return None

    def py_yield(code, offset, retval):
        try:
            ent = _classify(code)
            cls = ent[1]
            if cls == K_OUT:
                return DISABLE
            if S.closed:
                return None
            st = _thread()
            if st is None or st.busy:
                return None
            t = _perf()
            if cls == K_IN:
                gen = id(getframe(1))
                stack = st.stack
                for k in range(len(stack) - 1, -1, -1):
                    if stack[k][0] == 0 and stack[k][5] is code:
                        while len(stack) > k + 1:
                            b = stack.pop()
                            (_close_frame(st, b, t, EXIT, -1) if b[0] == 0 else _close_boundary(st, b, t, -1))
                        e = stack.pop()
                        _close_frame(st, e, t, YIELD, gen)
                        break
            else:
                _end_boundary(st, code, t, -1)
            return None
        except Exception as e:
            fail(e)
            return None

    def py_unwind(code, offset, exc):
        try:
            ent = _classify(code)
            cls = ent[1]
            if cls == K_OUT or S.closed:
                return None
            st = _thread()
            if st is None or st.busy:
                return None
            t = _perf()
            sid = _string(type(exc).__qualname__)
            if cls == K_IN:
                _leave(st, code, t, UNWIND, lambda: sid, True)
            else:
                _end_boundary(st, code, t, sid)
        except Exception as e:
            fail(e)
        return None

    def call(code, offset, func, arg0):
        try:
            ent = _classify(code)
            if ent[1] != K_IN:
                return DISABLE
            if S.closed:
                return None
            st = _thread()
            if st is None or st.busy:
                return None
            stack = st.stack
            # A Python boundary that never started (it returned a generator) ends here.
            while stack and stack[-1][0] == 1 and stack[-1][4] < 0:
                _close_boundary(st, stack.pop(), _perf(), -1)
            tf = type(func)
            c = None
            if tf is FunctionType:
                c = func.__code__
            elif tf is MethodType:
                inner = func.__func__
                if type(inner) is FunctionType:
                    c = inner.__code__
            if c is not None:
                ce = _classify(c)
                if ce[1] == K_IN:
                    st.call = (c, code, offset)
                    return None
                if ce[1] == K_OUT:
                    _boundary_codes.add(c)
                    _code_info.pop(id(c), None)
                    if id(c) in _disabled and _restarts[0] < 400:
                        _restarts[0] += 1
                        _disabled.clear()
                        mon.restart_events()
                    ce = _classify(c)
                fid = ce[2]
                stack.append([1, fid, _perf(), False, -1, c, _line_of(code, offset), ent[2]])
                return None
            if tf is type:
                init = getattr(func, "__init__", None)
                ic = getattr(init, "__code__", None)
                if (ic is not None and _classify(ic)[1] == K_IN) or _file_in_scope(_module_file(func)):
                    return None
            else:
                tc = getattr(getattr(tf, "__call__", None), "__code__", None)
                if tc is not None and _classify(tc)[1] == K_IN:
                    return None
            name = _c_name(func)
            if name in _TRIVIAL:
                return None
            fid = _func(("c", name), name, "", 0, F_C)
            stack.append([2, fid, _perf(), False, 0, func, _line_of(code, offset), ent[2]])
            return None
        except Exception as e:
            fail(e)
            return None

    def c_return(code, offset, func, arg0):
        try:
            if S.closed:
                return None
            st = S.threads.get(get_ident())
            if st is None:
                return None
            stack = st.stack
            if stack and stack[-1][0] == 2 and stack[-1][5] is func:
                _close_boundary(st, stack.pop(), _perf(), -1)
        except Exception as e:
            fail(e)
        return None

    def c_raise(code, offset, func, arg0):
        try:
            if S.closed:
                return None
            st = S.threads.get(get_ident())
            if st is None:
                return None
            stack = st.stack
            if stack and stack[-1][0] == 2 and stack[-1][5] is func:
                _close_boundary(st, stack.pop(), _perf(), _string("exception"))
        except Exception as e:
            fail(e)
        return None

    reg = mon.register_callback
    reg(tool, E.PY_START, py_start)
    reg(tool, E.PY_RESUME, py_resume)
    reg(tool, E.PY_THROW, py_throw)
    reg(tool, E.PY_RETURN, py_return)
    reg(tool, E.PY_YIELD, py_yield)
    reg(tool, E.PY_UNWIND, py_unwind)
    reg(tool, E.CALL, call)
    reg(tool, E.C_RETURN, c_return)
    reg(tool, E.C_RAISE, c_raise)
    mon.set_events(tool, E.PY_START | E.PY_RESUME | E.PY_THROW | E.PY_RETURN | E.PY_YIELD | E.PY_UNWIND | E.CALL | E.C_RETURN | E.C_RAISE)

    def stop() -> None:
        try:
            mon.set_events(tool, 0)
        except Exception:
            pass

    _engine_stop[0] = stop
    return True


_engine_stop = [lambda: None]


# ─── sys.setprofile engine (3.10 / 3.11) ────────────────────────────────────


def _install_setprofile() -> None:
    # sys.setprofile reports a generator/coroutine resume as "call" and a yield or an exception
    # as "return"; the instruction the frame stopped at tells them apart.
    import dis

    op = dis.opmap
    RESUME_OP, RET_OP = op.get("RESUME"), op["RETURN_VALUE"]
    YIELD_OPS = {op["YIELD_VALUE"], op.get("YIELD_FROM", -1)}
    GENLIKE = 0x20 | 0x80 | 0x200  # CO_GENERATOR | CO_COROUTINE | CO_ASYNC_GENERATOR
    co_code: dict = {}

    def code_bytes(code):
        b = co_code.get(code)
        if b is None:
            b = co_code[code] = code.co_code
        return b

    def resumed(frame) -> bool:
        code = frame.f_code
        if not code.co_flags & GENLIKE:
            return False
        i = frame.f_lasti
        if RESUME_OP is None:
            return i >= 0
        b = code_bytes(code)
        return 0 <= i < len(b) - 1 and b[i] == RESUME_OP and b[i + 1] != 0

    def exit_kind(frame) -> int:
        b, i = code_bytes(frame.f_code), frame.f_lasti
        o = b[i] if 0 <= i < len(b) else RET_OP
        if o == RET_OP:
            return EXIT
        if frame.f_code.co_flags & GENLIKE:
            # 3.10 parks a suspended `yield from`/`await` one instruction before YIELD_FROM
            if o in YIELD_OPS or (RESUME_OP is None and i + 2 < len(b) and b[i + 2] in YIELD_OPS):
                return YIELD
        return UNWIND

    exc_sid = [-1]

    def prof(frame, event, arg):
        if S.closed:
            return
        try:
            st = _thread()
            if st is None or st.busy:
                return
            code = frame.f_code
            if event == "call":
                ent = _classify(code)
                t = _perf()
                if ent[1] == K_IN:
                    if resumed(frame):
                        _enter(st, code, ent[2], t, 0, None, True, id(frame))
                        return
                    back = frame.f_back
                    line = back.f_lineno if back is not None and _classify(back.f_code)[1] == K_IN else 0
                    _enter(st, code, ent[2], t, line, lambda: frame, False, 0)
                else:
                    back = frame.f_back
                    if back is not None and _classify(back.f_code)[1] == K_IN and not resumed(frame):
                        fid = _func(code, _code_name(code), code.co_filename, code.co_firstlineno, F_LIB)
                        st.stack.append([1, fid, t, False, 0, frame, back.f_lineno, _top_fid(st)])
            elif event == "return":
                ent = _classify(code)
                t = _perf()
                kind = exit_kind(frame)
                if exc_sid[0] < 0:
                    exc_sid[0] = _string("exception")  # the type isn't visible to a profile hook
                if ent[1] == K_IN:
                    if kind == EXIT:
                        _leave(st, code, t, EXIT, lambda: _string(_ret_summary(arg)))
                    elif kind == YIELD:
                        _leave(st, code, t, YIELD, lambda: id(frame), True)
                    else:
                        _leave(st, code, t, UNWIND, lambda: exc_sid[0], True)
                else:
                    stack = st.stack
                    if stack and stack[-1][0] == 1 and stack[-1][5] is frame:
                        _close_boundary(st, stack.pop(), t, exc_sid[0] if kind == UNWIND else -1)
            elif event == "c_call":
                if _classify(code)[1] == K_IN:
                    name = _c_name(arg)
                    if name not in _TRIVIAL:
                        fid = _func(("c", name), name, "", 0, F_C)
                        st.stack.append([2, fid, _perf(), False, 0, arg, frame.f_lineno, _top_fid(st)])
            elif event in ("c_return", "c_exception"):
                stack = st.stack
                if stack and stack[-1][0] == 2 and stack[-1][5] is arg:
                    _close_boundary(st, stack.pop(), _perf(), _string("exception") if event == "c_exception" else -1)
        except Exception as e:
            S.error = repr(e)
            S.closed = True
            sys.setprofile(None)
            sys.stderr.write(f"codexplore: tracer error, tracing stopped: {e!r}\n")

    threading.setprofile(prof)
    sys.setprofile(prof)

    def stop() -> None:
        sys.setprofile(None)
        threading.setprofile(None)  # type: ignore[arg-type]

    _engine_stop[0] = stop


# ─── Threads, flushing, process lifecycle ───────────────────────────────────


def _patch_threads() -> None:
    orig = threading.Thread._bootstrap_inner  # type: ignore[attr-defined]

    def _bootstrap_inner(self):
        if S is not None and not S.closed:
            ident = get_ident()
            old = S.threads.pop(ident, None)
            if old is not None:  # an exited thread's ident is being reused
                S.done.append(old)
                S.meta_threads[old.serial]["end"] = S.meta_threads[old.serial]["end"] or _perf()
            S.threads[ident] = _Thread(ident, self, False)
        try:
            orig(self)
        finally:
            if S is not None:
                st = S.threads.pop(get_ident(), None)
                if st is not None:
                    info = S.meta_threads.get(st.serial)
                    if info is not None:
                        info["end"] = _perf()
                        info["name"] = self.name or info["name"]
                    S.done.append(st)
                    S.dirty = True

    threading.Thread._bootstrap_inner = _bootstrap_inner  # type: ignore[attr-defined]


def _cmdline() -> str:
    try:
        with open("/proc/self/cmdline", "rb") as f:
            raw = f.read().rstrip(b"\0").split(b"\0")
        return " ".join(x.decode(errors="replace") for x in raw)
    except OSError:
        return " ".join(getattr(sys, "orig_argv", None) or [sys.executable, *sys.argv])


def _flush(final: bool) -> None:
    if S is None or S.pid != os.getpid() or not _lock.acquire(blocking=final):
        return
    try:
        now = _perf()
        S.last_flush = now
        out = _cfg["out"]
        chunks = []
        for st in list(S.threads.values()) + S.done:
            ev = st.ev
            if len(ev):
                st.ev = array.array("q")
                chunks.append((st.serial, ev))
            info = S.meta_threads.get(st.serial)
            if info is not None and st.ref is not None:
                name = getattr(st.ref, "name", "")
                if name and name != info["name"] and not info["foreign"]:
                    info["name"] = name
                    S.dirty = True
        S.done = [st for st in S.done if len(st.ev)]
        if chunks:
            with open(os.path.join(out, f"{S.pid}.bin"), "ab") as f:
                for serial, ev in chunks:
                    f.write(array.array("q", (serial, len(ev))).tobytes())
                    f.write(ev.tobytes())
            S.chunks += len(chunks)
        if chunks or S.dirty or final:
            meta = {
                "version": 1, "pid": S.pid, "ppid": os.getppid(), "cmd": _cmdline(), "python": sys.version.split()[0],
                "engine": _engine_name[0], "perf0": S.perf0, "wall0": S.wall0, "end": now, "final": final,
                "funcs": S.funcs, "strings": S.strings,
                "threads": {str(k): v for k, v in S.meta_threads.items()},
                "agg": [[a, b, c[0], c[1]] for (a, b), c in S.agg.items()],
                "calls": {str(k): v for k, v in S.calls.items()},
                "events": S.events, "truncated": S.truncated, "error": S.error,
            }
            tmp = os.path.join(out, f"{S.pid}.json.tmp")
            with open(tmp, "w") as f:
                json.dump(meta, f, separators=(",", ":"))
            os.replace(tmp, os.path.join(out, f"{S.pid}.json"))
            S.dirty = False
    except Exception as e:  # never break the traced program
        if final:
            sys.stderr.write(f"codexplore: could not write trace: {e!r}\n")
    finally:
        _lock.release()


_engine_name = [""]


def _final() -> None:
    if S is None or S.pid != os.getpid() or S.finished:
        return
    S.finished = True
    _flush(True)
    S.closed = True
    _engine_stop[0]()


def _after_fork_child() -> None:
    global S
    if S is None:
        return
    if not _cfg.get("subprocesses"):
        S.closed = True
        _engine_stop[0]()
        return
    me = S.threads.get(get_ident())
    funcs, fid, strings, sid = S.funcs, S.fid, S.strings, S.sid
    S = _State()
    S.funcs, S.fid, S.strings, S.sid = funcs, fid, strings, sid
    try:
        if _lock.locked():
            _lock.release()
    except RuntimeError:
        pass
    if me is not None:
        st = _Thread(get_ident(), threading._active.get(get_ident()), False)  # type: ignore[attr-defined]
        S.threads[st.ident] = st
        t = _perf()
        for e in me.stack:  # the child starts inside its parent's call stack
            e = list(e)
            if e[0] == 0:
                e[3] = True
                st.ev.extend((t, RESUME, e[1], e[6], 0))  # continues, not a new call
            elif e[3]:
                st.ev.extend((t, BCALL, e[1], e[6], (1 if e[0] == 2 else 0) | 2))
            e[2] = t if e[3] else e[2]
            st.stack.append(e)


def _wrap_exit_paths() -> None:
    orig_exit = os._exit

    def _exit(code):
        try:
            _final()
        except Exception:
            pass
        orig_exit(code)

    os._exit = _exit
    for name in ("execv", "execve"):
        orig = getattr(os, name, None)
        if orig is None:
            continue

        def make(orig):
            def wrapped(*a, **k):
                try:
                    _final()
                except Exception:
                    pass
                return orig(*a, **k)
            return wrapped

        setattr(os, name, make(orig))


def start() -> None:
    global S, _cfg, _std_prefixes, _min_ns
    if S is not None:
        return
    _cfg = json.loads(os.environ["CODEXPLORE_TRACE"])
    _cfg["root"] = os.path.abspath(_cfg.get("root") or os.getcwd())
    _min_ns = int(float(_cfg.get("min_boundary_us", 20)) * 1000)
    pre = set()
    for p in (sys.prefix, sys.base_prefix, sys.exec_prefix, getattr(sys, "base_exec_prefix", sys.exec_prefix)):
        if p:
            pre.add(os.path.join(os.path.abspath(p), "lib"))
            pre.add(os.path.join(os.path.abspath(p), "Lib"))
    root = _cfg["root"]
    # A venv inside the project would otherwise look like project code.
    _std_prefixes = tuple(sorted(p for p in pre if not root.startswith(p + os.sep)))
    os.makedirs(_cfg["out"], exist_ok=True)
    if not _cfg.get("subprocesses"):
        os.environ.pop("CODEXPLORE_TRACE", None)
        here = os.path.dirname(_here)
        pp = [p for p in os.environ.get("PYTHONPATH", "").split(os.pathsep) if p and os.path.abspath(p) != here]
        if pp:
            os.environ["PYTHONPATH"] = os.pathsep.join(pp)
        else:
            os.environ.pop("PYTHONPATH", None)
    S = _State()
    main = threading.main_thread()
    S.threads[get_ident()] = _Thread(get_ident(), main, False)
    _patch_threads()
    _wrap_exit_paths()
    if hasattr(os, "register_at_fork"):
        os.register_at_fork(after_in_child=_after_fork_child)
    atexit.register(_final)
    if sys.version_info >= (3, 12) and _install_monitoring():
        _engine_name[0] = "monitoring"
    else:
        _install_setprofile()
        _engine_name[0] = "setprofile"
    _flush(True)
