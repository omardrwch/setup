# codexplore

A private, local Python profiling explorer. Profile your code with [py-spy](https://github.com/benfred/py-spy) and explore the results in an interactive web UI — 100% offline, nothing leaves your machine.

## Install

```bash
uv tool install .
```

Or for development:
```bash
uv tool install -e .
```

## Usage

### Profile a script

```bash
codexplore run my_script.py
codexplore run my_script.py -- --arg1 value1
```

This will:
1. Use py-spy to profile `my_script.py` using the Python from your current virtualenv
2. Save the profile to `codexplorer/run_YYYY-MM-DD_HHMMSS/` next to your script

**Options:**
- `--python PATH` — Use a specific Python interpreter (default: current venv's python)
- `--rate N` — Sampling rate in Hz (default: 100)
- `--subprocesses` — Also profile child processes

### Profile any command

For CLI tools installed as entry points (e.g. `harbor`, `uvicorn`, `flask`), use `exec`:

```bash
codexplore exec -- harbor run <task>
codexplore exec --subprocesses -- harbor run <task>
codexplore exec --rate 200 -- uvicorn app:main
```

The command must be a Python process (py-spy attaches to the Python interpreter inside it). This works with any `console_scripts` entry point installed via pip/uv.

**Options:**
- `--rate N` — Sampling rate in Hz (default: 100)
- `--subprocesses` — Also profile child processes

### Analyze a run

```bash
codexplore analyze run_2025-01-15_143052
```

Opens an interactive web UI at `http://127.0.0.1:8125` with:
- **Flame graph / Bottom-up** — merged call tree (or its inverse), colored by module so your code stands out from libraries
- **Timeline** — call stacks in chronological order, with an overview strip you can drag across to zoom into a time range
- **Tasks** — samples grouped by async task (or active function for sync code)
- **Map** — treemap of where time is spent: your code / libraries / stdlib → package → file → function; click to drill down, Esc to go up
- **Graph** — call graph centered on the selected function (two levels of callers and callees); click a node to recenter, click an edge to open the call site
- **Phases** — the run split into its top-level steps (e.g. setup → load data → train → save), shown as a band above the timeline and as a table; adjust granularity with coarser/finer
- **Functions / Call tree / Callers & callees** — sortable tables; click through callers and callees to navigate the code
- **Source viewer** — click any frame to see its source with per-line inclusive time and the enclosing function highlighted; each line shows chips for the functions it calls, so you can follow the code by clicking, with back/forward history
- **Frame filters** — hide import machinery, collapse library frames into one block, or show only your code

Navigation: Ctrl/⌘ + scroll (or pinch) zooms, Shift + scroll pans, drag moves, double-click zooms to a frame, `1`–`6` switch views, Alt + ←/→ go back/forward in the source viewer. Press `?` in the UI for all shortcuts.

**Options:**
- `--port N` — Port for the web server (default: 8125)
- `--host HOST` — Host to bind to (default: 127.0.0.1)
- `--dir PATH` — Base directory containing the `codexplorer/` folder

#### Async task detection

The **Tasks** swimlane view groups samples by async task. Since py-spy samples OS-thread
stacks (not asyncio internals), task identity is inferred heuristically: the viewer looks
for `Task.__step` in the call stack and uses the coroutine immediately above it as the
task name. Two `Task` instances running the same coroutine will appear as one lane.
Synchronous code falls back to the deepest user-code frame.

### List runs

```bash
codexplore list
```

## py-spy Permissions

py-spy needs to attach to processes. On Linux, you have several options (no sudo required):

```bash
# Option 1: Set ptrace scope (persists until reboot)
echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope

# Option 2: Give py-spy the ptrace capability (permanent)
sudo setcap cap_sys_ptrace+ep $(which py-spy)
```

On macOS, py-spy works without special permissions.

## Privacy

Everything runs locally. The web UI is served from `127.0.0.1` with no external requests — all fonts are system fonts. Profile data, source code, and all analysis stay on your machine.

## How It Works

1. **`codexplore run`** invokes `py-spy record --format speedscope` targeting your script with your venv's Python
2. The speedscope JSON profile is saved alongside metadata in `codexplorer/<run_id>/`
3. **`codexplore analyze`** starts a local Starlette server that serves a self-contained web UI
4. The web UI fetches the profile JSON and renders flame graphs + function tables via Canvas
5. Clicking a function loads its source code from disk via a local API endpoint
