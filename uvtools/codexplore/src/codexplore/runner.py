"""Profile runner — wraps py-spy to profile target scripts."""

import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

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


def run_profile(
    script: str,
    script_args: list[str],
    python: str | None = None,
    rate: int = 100,
    subprocesses: bool = False,
) -> str | None:
    """Run py-spy on the given script and save results.

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

    # Find py-spy — it's installed as our dependency, so look next to our own python first
    py_spy_path = shutil.which("py-spy")
    if not py_spy_path:
        # uv tool installs put binaries in the same bin/ dir as the tool's python
        own_bin_dir = Path(sys.executable).parent
        candidate = own_bin_dir / "py-spy"
        if candidate.exists():
            py_spy_path = str(candidate)
    if not py_spy_path:
        print(
            "Error: py-spy not found. It should be installed as a dependency of codexplore.\n"
            "Try: uv tool install . --force",
            file=sys.stderr,
        )
        return None

    # Create run directory in current working directory
    codexplorer_dir = get_codexplorer_dir(None)
    run_id = generate_run_id()
    run_dir = get_run_dir(codexplorer_dir, run_id)
    run_dir.mkdir(parents=True, exist_ok=True)

    # Output paths
    profile_output = run_dir / "profile.json"

    # Build py-spy command
    cmd = [
        py_spy_path,
        "record",
        "--format", "speedscope",
        "--output", str(profile_output),
        "--rate", str(rate),
    ]

    if subprocesses:
        cmd.append("--subprocesses")

    cmd.append("--")
    cmd.append(python_path)
    cmd.append(str(script_path))
    cmd.extend(script_args)

    # Save metadata
    meta = {
        "run_id": run_id,
        "script": str(script_path),
        "script_args": script_args,
        "python": python_path,
        "rate": rate,
        "subprocesses": subprocesses,
        "timestamp": datetime.now().isoformat(),
        "cwd": os.getcwd(),
    }

    meta_file = run_dir / "meta.json"
    with open(meta_file, "w") as f:
        json.dump(meta, f, indent=2)

    print(f"🔍 Profiling: {script_path.name}")
    print(f"   Python:    {python_path}")
    print(f"   Rate:      {rate} Hz")
    print(f"   Output:    {run_dir}")
    print(f"   Command:   {' '.join(cmd)}")
    print()

    # Run py-spy
    try:
        result = subprocess.run(
            cmd,
            cwd=str(script_path.parent),
            stdin=sys.stdin,
            stdout=sys.stdout,
            stderr=sys.stderr,
        )
        if result.returncode != 0:
            print(
                f"\n⚠️  Process exited with code {result.returncode}. Profile may be incomplete.",
                file=sys.stderr,
            )
    except PermissionError:
        print(
            "\n❌ Permission denied. py-spy needs permissions to profile processes.\n"
            "   Options:\n"
            "   1. Run with sudo: sudo codexplore run ...\n"
            "   2. Set ptrace scope: echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope\n"
            "   3. Give py-spy CAP_SYS_PTRACE: sudo setcap cap_sys_ptrace+ep $(which py-spy)\n",
            file=sys.stderr,
        )
        return None
    except KeyboardInterrupt:
        print("\n⚠️  Interrupted. Partial profile may have been saved.")

    # Verify output was created
    if not profile_output.exists():
        print(f"Warning: Profile output not created at {profile_output}", file=sys.stderr)
        meta["error"] = "Profile output not generated"
        with open(meta_file, "w") as f:
            json.dump(meta, f, indent=2)
        return None

    _enrich_frame_names(profile_output)

    # Update meta with profile info
    try:
        with open(profile_output) as f:
            profile_data = json.load(f)
        meta["profile_format"] = "speedscope"
        meta["profile_file"] = "profile.json"
        meta["num_profiles"] = len(profile_data.get("profiles", []))
        meta["shared_frames"] = len(profile_data.get("shared", {}).get("frames", []))
    except Exception:
        pass

    with open(meta_file, "w") as f:
        json.dump(meta, f, indent=2)

    return run_id


def exec_profile(
    command: list[str],
    rate: int = 100,
    subprocesses: bool = False,
) -> str | None:
    """Run py-spy on an arbitrary command (must be a Python process).

    Returns the run_id on success, None on failure.
    """
    import shutil as _shutil

    if not command:
        print("Error: No command provided.", file=sys.stderr)
        return None

    executable = _shutil.which(command[0])
    if not executable:
        print(f"Error: Command not found: {command[0]}", file=sys.stderr)
        return None

    py_spy_path = shutil.which("py-spy")
    if not py_spy_path:
        own_bin_dir = Path(sys.executable).parent
        candidate = own_bin_dir / "py-spy"
        if candidate.exists():
            py_spy_path = str(candidate)
    if not py_spy_path:
        print(
            "Error: py-spy not found. It should be installed as a dependency of codexplore.\n"
            "Try: uv tool install . --force",
            file=sys.stderr,
        )
        return None

    codexplorer_dir = get_codexplorer_dir(None)
    run_id = generate_run_id()
    run_dir = get_run_dir(codexplorer_dir, run_id)
    run_dir.mkdir(parents=True, exist_ok=True)

    profile_output = run_dir / "profile.json"

    cmd = [
        py_spy_path,
        "record",
        "--format", "speedscope",
        "--output", str(profile_output),
        "--rate", str(rate),
    ]

    if subprocesses:
        cmd.append("--subprocesses")

    cmd.append("--")
    cmd.append(executable)
    cmd.extend(command[1:])

    command_str = " ".join(command)
    meta = {
        "run_id": run_id,
        "command": command_str,
        "command_args": command,
        "rate": rate,
        "subprocesses": subprocesses,
        "timestamp": datetime.now().isoformat(),
        "cwd": os.getcwd(),
    }

    meta_file = run_dir / "meta.json"
    with open(meta_file, "w") as f:
        json.dump(meta, f, indent=2)

    print(f"🔍 Profiling: {command_str}")
    print(f"   Executable: {executable}")
    print(f"   Rate:       {rate} Hz")
    print(f"   Output:     {run_dir}")
    print(f"   Command:    {' '.join(cmd)}")
    print()

    try:
        result = subprocess.run(
            cmd,
            cwd=os.getcwd(),
            stdin=sys.stdin,
            stdout=sys.stdout,
            stderr=sys.stderr,
        )
        if result.returncode != 0:
            print(
                f"\n⚠️  Process exited with code {result.returncode}. Profile may be incomplete.",
                file=sys.stderr,
            )
    except PermissionError:
        print(
            "\n❌ Permission denied. py-spy needs permissions to profile processes.\n"
            "   Options:\n"
            "   1. Run with sudo: sudo codexplore exec ...\n"
            "   2. Set ptrace scope: echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope\n"
            "   3. Give py-spy CAP_SYS_PTRACE: sudo setcap cap_sys_ptrace+ep $(which py-spy)\n",
            file=sys.stderr,
        )
        return None
    except KeyboardInterrupt:
        print("\n⚠️  Interrupted. Partial profile may have been saved.")

    if not profile_output.exists():
        print(f"Warning: Profile output not created at {profile_output}", file=sys.stderr)
        meta["error"] = "Profile output not generated"
        with open(meta_file, "w") as f:
            json.dump(meta, f, indent=2)
        return None

    _enrich_frame_names(profile_output)

    try:
        with open(profile_output) as f:
            profile_data = json.load(f)
        meta["profile_format"] = "speedscope"
        meta["profile_file"] = "profile.json"
        meta["num_profiles"] = len(profile_data.get("profiles", []))
        meta["shared_frames"] = len(profile_data.get("shared", {}).get("frames", []))
    except Exception:
        pass

    with open(meta_file, "w") as f:
        json.dump(meta, f, indent=2)

    return run_id
