"""Profile runner — wraps py-spy to profile target scripts."""

import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from codexplore.trace import ThreadPoller, convert_chrometrace
from codexplore.utils import (
    find_python_interpreter,
    generate_run_id,
    get_codexplorer_dir,
    get_run_dir,
)

_DUNDER_RE = re.compile(r"^__\w+__$")
_CLASS_RE = re.compile(r"^(\s*)class\s+(\w+)")


def _find_enclosing_class(filepath: str, line: int, cache: dict) -> str | None:
    """Walk backwards from `line` to find the nearest enclosing class declaration."""
    if filepath not in cache:
        try:
            cache[filepath] = Path(filepath).read_text(errors="replace").splitlines()
        except OSError:
            cache[filepath] = None
    lines = cache[filepath]
    if not lines or line <= 0 or line > len(lines):
        return None
    target_indent = len(lines[line - 1]) - len(lines[line - 1].lstrip())
    for i in range(line - 2, -1, -1):
        m = _CLASS_RE.match(lines[i])
        if m and len(m.group(1)) < target_indent:
            return m.group(2)
    return None


def _enrich_frame_names(profile_path: Path) -> None:
    """Qualify bare dunder method names (e.g. __call__ -> MyClass.__call__).

    py-spy uses co_qualname on Python 3.11+ which already includes the class,
    but this handles older Pythons and edge cases (C extensions, etc.).
    """
    with open(profile_path) as f:
        data = json.load(f)
    frames = data.get("shared", {}).get("frames", [])
    changed = False
    file_cache: dict[str, list[str] | None] = {}
    for frame in frames:
        name = frame.get("name", "")
        if not _DUNDER_RE.match(name) or "." in name:
            continue
        fp, line = frame.get("file", ""), frame.get("line", 0)
        if not fp or line <= 0:
            continue
        cls = _find_enclosing_class(fp, line, file_cache)
        if cls:
            frame["name"] = f"{cls}.{name}"
            changed = True
    if changed:
        with open(profile_path, "w") as f:
            json.dump(data, f)


def _find_py_spy() -> str | None:
    found = shutil.which("py-spy")
    if found:
        return found
    # uv tool installs put binaries in the same bin/ dir as the tool's python
    candidate = Path(sys.executable).parent / "py-spy"
    if candidate.exists():
        return str(candidate)
    print(
        "Error: py-spy not found. It should be installed as a dependency of codexplore.\n"
        "Try: uv tool install . --force",
        file=sys.stderr,
    )
    return None


def _record(
    py_spy: str,
    target: list[str],
    cwd: str,
    meta: dict,
    rate: int,
    subprocesses: bool,
    cpu: bool,
    label: str,
) -> str | None:
    """Run py-spy on `target`, then post-process the output into run_dir/profile.json."""
    codexplorer_dir = get_codexplorer_dir(None)
    run_id = generate_run_id()
    run_dir = get_run_dir(codexplorer_dir, run_id)
    run_dir.mkdir(parents=True, exist_ok=True)
    profile_output = run_dir / "profile.json"
    raw_output = profile_output if cpu else run_dir / "trace.json"

    cmd = [py_spy, "record", "--format", "speedscope" if cpu else "chrometrace", "--output", str(raw_output), "--rate", str(rate)]
    if not cpu:
        cmd.append("--idle")  # without it, idle threads look busy in their last stack
    if subprocesses:
        cmd.append("--subprocesses")
    cmd += ["--", *target]

    meta.update({
        "run_id": run_id,
        "rate": rate,
        "subprocesses": subprocesses,
        "mode": "cpu" if cpu else "timeline",
        "timestamp": datetime.now().isoformat(),
        "cwd": os.getcwd(),
    })
    meta_file = run_dir / "meta.json"
    meta_file.write_text(json.dumps(meta, indent=2))

    print(f"🔍 Profiling: {label}")
    print(f"   Mode:      {'CPU samples' if cpu else 'wall-clock timeline (all threads, incl. waiting)'}")
    print(f"   Rate:      {rate} Hz")
    print(f"   Output:    {run_dir}")
    print(f"   Command:   {' '.join(cmd)}")
    print()

    poller = None
    try:
        proc = subprocess.Popen(cmd, cwd=cwd, stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr)
        if not cpu:
            poller = ThreadPoller(py_spy, proc.pid, time.monotonic())
            poller.start()
        try:
            returncode = proc.wait()
        except KeyboardInterrupt:
            print("\n⚠️  Interrupted. Waiting for py-spy to write the partial profile...")
            returncode = proc.wait()
        if returncode != 0:
            print(f"\n⚠️  Process exited with code {returncode}. Profile may be incomplete.", file=sys.stderr)
    except PermissionError:
        print(
            "\n❌ Permission denied. py-spy needs permissions to profile processes.\n"
            "   Options:\n"
            "   1. Run with sudo: sudo codexplore ...\n"
            "   2. Set ptrace scope: echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope\n"
            "   3. Give py-spy CAP_SYS_PTRACE: sudo setcap cap_sys_ptrace+ep $(which py-spy)\n",
            file=sys.stderr,
        )
        return None
    poll = poller.stop() if poller else None

    if not raw_output.exists():
        print(f"Warning: Profile output not created at {raw_output}", file=sys.stderr)
        meta["error"] = "Profile output not generated"
        meta_file.write_text(json.dumps(meta, indent=2))
        return None

    if not cpu:
        print("   Building the timeline...", flush=True)
        try:
            summary = convert_chrometrace(raw_output, profile_output, poll)
        except Exception as e:  # keep the raw trace so nothing is lost
            print(f"Error: could not convert {raw_output}: {e}", file=sys.stderr)
            meta["error"] = f"Trace conversion failed: {e}"
            meta_file.write_text(json.dumps(meta, indent=2))
            return None
        raw_output.unlink()
        named = sum(1 for t in (poll or {}).get("threads", {}).values() if t.get("name"))
        print(f"   {summary['threads']} threads over {summary['span']:.1f} s ({named} named)")
        if not named:
            print("   Note: thread names unavailable (py-spy dump could not attach); threads are labelled by id.")

    _enrich_frame_names(profile_output)
    _finish_meta(meta, meta_file, profile_output)
    return run_id


def _finish_meta(meta: dict, meta_file: Path, profile_output: Path) -> None:
    try:
        profile_data = json.loads(profile_output.read_text())
        meta["profile_format"] = "speedscope"
        meta["profile_file"] = "profile.json"
        meta["num_profiles"] = len(profile_data.get("profiles", []))
        meta["shared_frames"] = len(profile_data.get("shared", {}).get("frames", []))
    except (OSError, ValueError):
        pass
    meta_file.write_text(json.dumps(meta, indent=2))


TRACER_DIR = Path(__file__).parent / "tracer"


def _trace_record(target: list[str], cwd: str, root: str, meta: dict, trace: dict, subprocesses: bool, label: str) -> str | None:
    """Run `target` with the in-process tracer, then convert its output (exact calls)."""
    from codexplore.tracefmt import convert_exact_trace

    codexplorer_dir = get_codexplorer_dir(None)
    run_id = generate_run_id()
    run_dir = get_run_dir(codexplorer_dir, run_id)
    run_dir.mkdir(parents=True, exist_ok=True)
    trace_dir = run_dir / "trace"
    profile_output = run_dir / "profile.json"

    meta.update({
        "run_id": run_id,
        "subprocesses": subprocesses,
        "mode": "trace",
        "include": list(trace.get("include") or []),
        "values": bool(trace.get("values")),
        "timestamp": datetime.now().isoformat(),
        "cwd": os.getcwd(),
    })
    meta_file = run_dir / "meta.json"
    meta_file.write_text(json.dumps(meta, indent=2))

    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join([str(TRACER_DIR), *filter(None, [env.get("PYTHONPATH")])])
    config = {
        "out": str(trace_dir),
        "root": root,
        "include": list(trace.get("include") or []),
        "values": bool(trace.get("values")),
        "subprocesses": subprocesses,
        "max_events": int(trace.get("max_events") or 5_000_000),
    }
    env["CODEXPLORE_TRACE"] = json.dumps(config)

    print(f"🔍 Tracing: {label}")
    print("   Mode:      exact trace (every call in your code, plus its first library call)")
    print(f"   Scope:     {root}" + (f" + {', '.join(config['include'])}" if config["include"] else ""))
    if config["values"]:
        print("   Values:    short value reprs are recorded (secret-looking names/values redacted)")
    print(f"   Output:    {run_dir}")
    print()

    t0 = time.time_ns()
    try:
        proc = subprocess.Popen(target, cwd=cwd, env=env, stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr)
        try:
            returncode = proc.wait()
        except KeyboardInterrupt:
            print("\n⚠️  Interrupted. Waiting for the program to write its trace...")
            returncode = proc.wait()
    except OSError as e:
        print(f"Error: could not start {target[0]}: {e}", file=sys.stderr)
        return None
    if returncode != 0:
        print(f"\n⚠️  Process exited with code {returncode}. Trace may be incomplete.", file=sys.stderr)

    print("   Building the timeline...", flush=True)
    try:
        summary = convert_exact_trace(trace_dir, profile_output, run_dir / "calls.json", t0)
    except Exception as e:  # keep the raw trace so nothing is lost
        print(f"Error: could not convert {trace_dir}: {e}", file=sys.stderr)
        meta["error"] = f"Trace conversion failed: {e}"
        meta_file.write_text(json.dumps(meta, indent=2))
        return None
    shutil.rmtree(trace_dir, ignore_errors=True)
    procs = f" in {summary['processes']} processes" if summary["processes"] > 1 else ""
    print(f"   {summary['calls']:,} calls to {summary['functions']} functions, "
          f"{summary['threads']} threads{procs} over {summary['span']:.1f} s ({summary['named']} named)")
    if summary["truncated"]:
        print(f"   ⚠️  Event cap reached ({config['max_events']:,}); later calls were counted but not recorded. Raise --max-events.")
    for err in summary["errors"]:
        print(f"   ⚠️  Tracer stopped early: {err}", file=sys.stderr)
    meta["calls_file"] = "calls.json"
    _finish_meta(meta, meta_file, profile_output)
    return run_id


def run_profile(
    script: str,
    script_args: list[str],
    python: str | None = None,
    rate: int = 100,
    subprocesses: bool = False,
    cpu: bool = False,
    trace: dict | None = None,
) -> str | None:
    """Run py-spy (or the tracer, with `trace`) on the given script and save results.

    Returns the run_id on success, None on failure.
    """
    script_path = Path(script).resolve()
    if not script_path.exists():
        print(f"Error: Script not found: {script_path}", file=sys.stderr)
        return None

    # Resolve the python interpreter from the USER's environment, not ours
    try:
        python_path = find_python_interpreter(python)
    except RuntimeError as e:
        print(f"Error: {e}", file=sys.stderr)
        return None

    meta = {"script": str(script_path), "script_args": script_args, "python": python_path}
    print(f"   Python:    {python_path}")
    if trace is not None:
        target = [python_path, str(script_path), *script_args]
        return _trace_record(target, str(script_path.parent), str(script_path.parent), meta, trace, subprocesses, script_path.name)

    py_spy = _find_py_spy()
    if not py_spy:
        return None
    return _record(
        py_spy, [python_path, str(script_path), *script_args], str(script_path.parent),
        meta, rate, subprocesses, cpu, script_path.name,
    )


def exec_profile(
    command: list[str],
    rate: int = 100,
    subprocesses: bool = False,
    cpu: bool = False,
    trace: dict | None = None,
) -> str | None:
    """Run py-spy (or the tracer, with `trace`) on an arbitrary command (must be a Python process).

    Returns the run_id on success, None on failure.
    """
    if not command:
        print("Error: No command provided.", file=sys.stderr)
        return None

    executable = shutil.which(command[0])
    if not executable:
        print(f"Error: Command not found: {command[0]}", file=sys.stderr)
        return None

    command_str = " ".join(command)
    meta = {"command": command_str, "command_args": command}
    if trace is not None:
        return _trace_record([executable, *command[1:]], os.getcwd(), os.getcwd(), meta, trace, subprocesses, command_str)

    py_spy = _find_py_spy()
    if not py_spy:
        return None
    return _record(py_spy, [executable, *command[1:]], os.getcwd(), meta, rate, subprocesses, cpu, command_str)
