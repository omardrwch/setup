"""Wall-clock timeline recording: thread-name polling and chrometrace conversion.

py-spy's chrometrace output has a real timestamp for every stack change, for every thread of
every process, which is what lets the UI line threads up on one clock. It must be recorded with
--idle: without it, a thread that goes idle keeps its last stack "open" until its next active
sample. Waiting is then recognised heuristically (see `WaitClassifier`), so CPU-style views can
still hide it.

The converted file keeps the speedscope layout the UI already reads, plus per-sample `times`
(seconds since the recording started) and `idle` flags, and a top-level `codexplore` block.
"""

from __future__ import annotations

import json
import re
import subprocess
import threading
import time
from pathlib import Path

# ─── Thread names and lifetimes ─────────────────────────────────────────────


class ThreadPoller(threading.Thread):
    """Periodically asks py-spy for thread names, and notes when threads/processes are alive.

    chrometrace has no thread names, and a thread that exits keeps its last stack open until the
    end of the trace; the liveness seen here lets the converter close it at the right time.
    Best effort: any failure just means fewer names.
    """

    def __init__(self, py_spy: str, recorder_pid: int, t0: float, interval: float = 2.0):
        super().__init__(daemon=True)
        self.py_spy, self.recorder_pid, self.t0, self.interval = py_spy, recorder_pid, t0, interval
        self.threads: dict[str, dict] = {}
        self.processes: dict[int, dict] = {}
        self.stopped = threading.Event()
        self.gap = interval

    def _descendants(self) -> list[tuple[int, int, str]]:
        try:
            out = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,command="], capture_output=True, text=True, timeout=10).stdout
        except (OSError, subprocess.SubprocessError):
            return []
        rows = {}
        for line in out.splitlines():
            parts = line.strip().split(None, 2)
            if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
                rows[int(parts[0])] = (int(parts[1]), parts[2] if len(parts) > 2 else "")
        found, frontier = [], {self.recorder_pid}
        while frontier:
            nxt = {pid for pid, (ppid, _) in rows.items() if ppid in frontier}
            found += [(pid, rows[pid][0], rows[pid][1]) for pid in nxt]
            frontier = nxt
        return found

    def poll_once(self) -> None:
        now = time.monotonic() - self.t0
        for pid, ppid, cmd in self._descendants():
            proc = self.processes.setdefault(pid, {"ppid": ppid, "cmd": cmd, "first": now})
            proc["last"] = now
            if proc.get("fails", 0) >= 2 and not proc.get("ok"):
                continue  # not a Python process (shell, compiler, ...)
            try:
                res = subprocess.run(
                    [self.py_spy, "dump", "--pid", str(pid), "--json", "--nonblocking"],
                    capture_output=True, text=True, timeout=15,
                )
                data = json.loads(res.stdout) if res.returncode == 0 and res.stdout.strip() else None
            except (OSError, subprocess.SubprocessError, ValueError):
                data = None
            if not isinstance(data, list):
                proc["fails"] = proc.get("fails", 0) + 1
                continue
            proc["ok"] = True
            seen = time.monotonic() - self.t0
            for th in data:
                key = f"{th.get('pid', pid)}:{th.get('thread_id')}"
                rec = self.threads.setdefault(key, {"name": "", "os_tid": th.get("os_thread_id"), "first": seen})
                rec["last"] = seen
                rec["gap"] = self.gap
                if th.get("thread_name"):
                    rec["name"] = th["thread_name"]

    def run(self) -> None:
        while not self.stopped.is_set():
            start = time.monotonic()
            self.poll_once()
            spent = time.monotonic() - start
            # Threads are mostly created early; poll fast then, and never spend >25% of a core.
            elapsed = start - self.t0
            base = 0.3 if elapsed < 10 else 1.0 if elapsed < 60 else self.interval
            self.gap = max(base, spent * 3)
            self.stopped.wait(self.gap)

    def stop(self) -> dict:
        self.stopped.set()
        self.join(timeout=20)
        return {"threads": self.threads, "processes": self.processes, "interval": self.interval}


# ─── Waiting detection ──────────────────────────────────────────────────────

# Python-level functions that block (keyed by path suffix). A sample whose innermost frame is one
# of these is waiting, not computing.
_WAIT_FUNCS: list[tuple[str, set[str]]] = [
    ("threading.py", {"wait", "wait_for", "acquire", "join", "_wait_for_tstate_lock", "_acquire_restore"}),
    ("queue.py", {"get", "put", "join"}),
    ("selectors.py", {"select"}),
    ("asyncio/base_events.py", {"_run_once", "run_forever", "run_until_complete"}),
    ("asyncio/runners.py", {"run"}),
    ("asyncio/locks.py", {"wait", "acquire"}),
    ("asyncio/queues.py", {"get", "put"}),
    ("asyncio/tasks.py", {"sleep", "wait", "gather"}),
    ("concurrent/futures/_base.py", {"result", "exception", "wait", "as_completed", "_result_or_cancel"}),
    ("concurrent/futures/thread.py", {"_worker"}),
    ("concurrent/futures/process.py", {"wait_result_broken_or_wakeup", "_wait_for_notification"}),
    ("multiprocessing/connection.py", {"recv", "recv_bytes", "_recv", "_recv_bytes", "poll", "_poll", "wait", "accept", "_recv_bytes_into"}),
    ("multiprocessing/synchronize.py", {"acquire", "wait", "__enter__"}),
    ("multiprocessing/queues.py", {"get", "put", "_feed"}),
    ("multiprocessing/pool.py", {"worker", "wait", "get", "_handle_workers", "_handle_tasks", "_handle_results"}),
    ("multiprocessing/popen_fork.py", {"wait", "poll"}),
    ("multiprocessing/process.py", {"join"}),
    ("multiprocessing/resource_tracker.py", {"main"}),
    ("subprocess.py", {"wait", "_wait", "communicate", "_communicate", "_try_wait"}),
    ("socket.py", {"accept", "readinto", "recv_into"}),
    ("socketserver.py", {"serve_forever"}),
    ("ssl.py", {"read", "recv", "recv_into", "do_handshake"}),
    ("zmq/sugar/socket.py", {"recv", "recv_multipart", "recv_pyobj", "recv_json", "recv_string"}),
    ("zmq/sugar/poll.py", {"poll"}),
    ("grpc/_channel.py", {"_blocking", "_next", "result", "_end_unary_response_blocking"}),
    ("grpc/_common.py", {"wait", "_wait_once"}),
    ("grpc/_server.py", {"_serve", "_serve_requests"}),
    ("ray/_private/worker.py", {"get_objects", "main_loop", "wait", "get"}),
    ("torch/utils/data/dataloader.py", {"_try_get_data", "_get_data"}),
    ("tornado/ioloop.py", {"start"}),
]

# Blocking calls into C code leave the caller as the innermost Python frame; its source line
# tells what it is doing (time.sleep, lock.acquire, fut.result(), q.get(timeout=...), ...).
_WAIT_LINE_RE = re.compile(
    r"\b(?:time\.)?sleep\s*\(|"
    r"\.(?:wait|wait_for|acquire|result|recv|recv_into|recv_bytes|recv_multipart|recvfrom|accept|communicate|select|join)\s*\(|"
    r"\.get\(\s*(?:\)|block|timeout|True)|"
    r"\b(?:ray\.(?:get|wait)|select\.(?:select|poll|epoll)|os\.waitpid|input|signal\.pause)\s*\("
)
_NOT_WAIT_LINE_RE = re.compile(r"""["'\]]\s*\.join\(|path\.join\(|\bstr\.join\(""")


class WaitClassifier:
    def __init__(self) -> None:
        self._lines: dict[str, list[str] | None] = {}
        self._cache: dict[tuple, bool] = {}

    def _line(self, file: str, line: int) -> str:
        if file not in self._lines:
            try:
                self._lines[file] = Path(file).read_text(errors="replace").splitlines() if file and not file.startswith("<") else None
            except OSError:
                self._lines[file] = None
        lines = self._lines[file]
        return lines[line - 1] if lines and 0 < line <= len(lines) else ""

    def is_waiting(self, name: str, file: str, line: int) -> bool:
        key = (name, file, line)
        hit = self._cache.get(key)
        if hit is None:
            p = file.replace("\\", "/")
            short = name.rsplit(".", 1)[-1]
            hit = any(p.endswith(suffix) and short in funcs for suffix, funcs in _WAIT_FUNCS)
            if not hit:
                src = self._line(file, line)
                hit = bool(src and _WAIT_LINE_RE.search(src) and not _NOT_WAIT_LINE_RE.search(src))
            self._cache[key] = hit
        return hit


# ─── Conversion ─────────────────────────────────────────────────────────────


def convert_chrometrace(trace_path: Path, out_path: Path, poll: dict | None = None) -> dict:
    """Convert a py-spy chrometrace (recorded with --idle) into the timeline profile format."""
    with open(trace_path) as f:
        events = json.load(f)
    if isinstance(events, dict):
        events = events.get("traceEvents", [])

    poll = poll or {}
    names: dict[str, dict] = poll.get("threads", {})
    procs_seen: dict = {int(k): v for k, v in poll.get("processes", {}).items()}
    interval = float(poll.get("interval") or 2.0)

    frames: list[dict] = []
    frame_idx: dict[tuple, int] = {}
    threads: dict[tuple[int, int], dict] = {}
    end_ts = 0

    for e in events:
        ph = e.get("ph")
        if ph not in ("B", "E"):
            continue
        key = (e.get("pid", 0), e.get("tid", 0))
        ts = e.get("ts", 0)
        if ts > end_ts:
            end_ts = ts
        th = threads.get(key)
        if th is None:
            th = threads[key] = {"stack": [], "cur": ts, "segs": []}
        if ts != th["cur"]:
            th["segs"].append((th["cur"], ts, tuple(th["stack"])))
            th["cur"] = ts
        if ph == "B":
            args = e.get("args") or {}
            fk = (e.get("name", ""), args.get("filename", ""), args.get("line", 0))
            fi = frame_idx.get(fk)
            if fi is None:
                fi = frame_idx[fk] = len(frames)
                frames.append({"name": fk[0], "file": fk[1], "line": fk[2]})
            th["stack"].append(fi)
        elif th["stack"]:
            th["stack"].pop()

    waits = WaitClassifier()
    profiles = []
    for (pid, tid), th in threads.items():
        segs = [s for s in th["segs"] if s[1] > s[0]]
        if not segs:
            continue
        info = names.get(f"{pid}:{tid}", {})
        # A thread that exited keeps its last stack open until the trace ends; close it shortly
        # after the last time it (or its process) was seen alive.
        last_seen, gap = info.get("last"), info.get("gap", interval)
        proc_last = procs_seen.get(pid, {}).get("last")
        if proc_last is not None and (last_seen is None or proc_last < last_seen):
            last_seen = proc_last
        if last_seen is not None:
            cut = (last_seen + gap) * 1e6
            a, b, stk = segs[-1]
            if b == end_ts and cut < b:
                segs[-1] = (a, max(a + 1, cut), stk)

        samples, weights, times, idle = [], [], [], []
        active = 0.0
        for a, b, stk in segs:
            proc_frames = 0
            while proc_frames < len(stk) and frames[stk[proc_frames]]["file"] == "" and frames[stk[proc_frames]]["name"].startswith("process "):
                proc_frames += 1
            if proc_frames == len(stk):
                waiting = True
            else:
                leaf = frames[stk[-1]]
                waiting = waits.is_waiting(leaf["name"], leaf["file"], leaf["line"])
            dur = (b - a) / 1e6
            samples.append(list(stk))
            weights.append(round(dur, 6))
            times.append(round(a / 1e6, 6))
            idle.append(1 if waiting else 0)
            if not waiting:
                active += dur
        name = info.get("name", "")
        os_tid = info.get("os_tid") or tid
        profiles.append({
            "type": "sampled",
            "name": f'Process {pid} Thread {os_tid} "{name}"' if name else f"Process {pid} Thread {os_tid}",
            "unit": "seconds",
            "startValue": times[0],
            "endValue": round(segs[-1][1] / 1e6, 6),
            "samples": samples,
            "weights": weights,
            "times": times,
            "idle": idle,
            "_active": active,
        })
    profiles.sort(key=lambda p: -p.pop("_active"))

    processes = {
        str(pid): {"cmd": v.get("cmd", ""), "ppid": v.get("ppid", 0), "first": v.get("first"), "last": v.get("last")}
        for pid, v in procs_seen.items() if v.get("ok")
    }
    data = {
        "$schema": "https://www.speedscope.app/file-format-schema.json",
        "exporter": "codexplore (py-spy chrometrace)",
        "shared": {"frames": frames},
        "profiles": profiles,
        "codexplore": {"timeline": True, "span": round(end_ts / 1e6, 6), "processes": processes, "named_threads": len(names)},
    }
    with open(out_path, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    return {"threads": len(profiles), "frames": len(frames), "span": end_ts / 1e6}
