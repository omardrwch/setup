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
- `--cpu` — Record CPU samples only (no wall-clock timestamps); see [Recording modes](#recording-modes)

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
- `--cpu` — Record CPU samples only (no wall-clock timestamps)

Options go after the subcommand: `codexplore exec --subprocesses -- cmd`.

### Recording modes

By default runs are recorded as a **wall-clock timeline**: every sample is timestamped, idle
time is kept, and thread names are read from the live processes. That lets the UI line up
all threads and processes on one clock, so you can see what a rollout worker was doing while
the trainer sat in `queue.get()`.

Time spent blocked (sleeping, waiting on a lock, queue, future, socket, `ray.get`, …) is
detected from the call that was running and shown hatched. The **Waiting** picker decides
whether it counts toward totals in the flame graph, tables and Threads view (hidden by
default, so they show where CPU time goes). Detection is heuristic: a C extension that
blocks without releasing a recognisable Python frame will look busy.

`--cpu` records the older CPU-only format, where idle time is dropped. Use it for long runs
where you only care about hot code.

### Analyze a run

```bash
codexplore analyze run_2025-01-15_143052
```

Opens an interactive web UI at `http://127.0.0.1:8125` with:
- **Flame graph / Bottom-up** — merged call tree (or its inverse), colored by module so your code stands out from libraries
- **Timeline** — for wall-clock runs, every thread of every process on one clock: one strip per thread (waiting hatched), grouped under its process. Click a thread's name to expand its full call stacks; click a process to fold it. For `--cpu` runs, the call stacks of the current thread in chronological order. Drag across the overview strip to zoom into a time range
- **Meanwhile** — click any call on the timeline (or drag across the time axis) to see what every other thread and process did during that time: how long each was running vs. waiting, and the functions it was busy in. Click a thread or function to jump to it. This is how you follow work that hops threads, e.g. `trainer.step()` waiting on a future while a rollout process generates the data
- **Tasks** — samples grouped by async task (or active function for sync code)
- **Map** — treemap of where time is spent: your code / libraries / stdlib → package → file → function; click to drill down, Esc to go up
- **Graph** — call graph centered on the selected function (two levels of callers and callees); click a node to recenter, click an edge to open the call site
- **Threads** — every process and thread in one graph: each thread's entry point and the code it spends time in, so you can see what each thread does and which code they share. Thread pools (`worker_0`, `worker_1`, …) are merged; runs recorded with `--subprocesses` add a column with the process tree. Click a thread to open it
- **Phases** — the run split into its top-level steps (e.g. setup → load data → train → save), shown as a band above the timeline and as a table; adjust granularity with coarser/finer
- **Functions / Call tree / Callers & callees** — sortable tables; click through callers and callees to navigate the code
- **Source viewer** — click any frame to see its source with per-line inclusive time and the enclosing function highlighted; each line shows chips for the functions it calls, so you can follow the code by clicking, with back/forward history
- **Frame filters** — hide import machinery, collapse library frames into one block, or show only your code

Navigation: Ctrl/⌘ + scroll (or pinch) zooms, Shift + scroll pans, drag moves, double-click zooms to a frame, `1`–`7` switch views. The toolbar's ← → buttons (or Alt + ←/→, or the mouse back/forward buttons) step back and forward through where you've been: view, thread, zoom, selection, Map drill-down and time window; the source panel's own ← → step through visited code only. Drag a column edge in the tables, or the edge of the timeline's name gutter, to resize it (double-click to reset). Press `?` in the UI for all shortcuts.

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

1. **`codexplore run`** invokes `py-spy record --format chrometrace --idle` (or `--format speedscope` with `--cpu`) targeting your script with your venv's Python, while polling `py-spy dump` for thread names
2. The trace is converted to a speedscope-style JSON profile (with per-sample timestamps and waiting flags) and saved alongside metadata in `codexplorer/<run_id>/`
3. **`codexplore analyze`** starts a local Starlette server that serves a self-contained web UI
4. The web UI fetches the profile JSON and renders flame graphs + function tables via Canvas
5. Clicking a function loads its source code from disk via a local API endpoint
