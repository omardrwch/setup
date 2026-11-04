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
- `--trace` — Record every call in your code exactly instead of sampling; see [Trace mode](#trace-mode). With it: `--include PKG` (repeatable), `--values`, `--max-events N`

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
- `--trace`, `--include PKG`, `--values`, `--max-events N` — exact tracing, see [Trace mode](#trace-mode)

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

### Trace mode

```bash
codexplore run --trace my_script.py
codexplore exec --trace --subprocesses -- python -m mypkg.train
codexplore run --trace --include transformers my_script.py
```

`--trace` swaps the sampler for an in-process tracer, so nothing is missed between samples:
every call of **your code** is recorded with its exact start and end, plus the **first call
out of it** into a library or builtin (`model.generate`, `time.sleep`, `queue.get`, …), whose
inside is not traced. That gives you, on top of all the usual views:

- **Exact call counts** — in the Functions table (sortable *Calls* column), tooltips, Callers &
  callees, Graph nodes and edges, and the source panel's call chips (`×42` calls from this line)
- **Signatures** — the argument and return types each function was called with, shown at the
  top of the source panel and in tooltips: `forward(x: Tensor[8,512] bfloat16 cuda:0) → Tensor[8,512,32000] bfloat16 cuda:0`.
  Tensors and arrays (torch, numpy, jax, cupy, tensorflow) show shape, dtype and device;
  containers show their length and element type; dataclasses and namedtuples their fields
- **Exceptions** — which functions raised what, and how often
- **Calls view** (key `8`) — every call of the current thread in order, indented by depth,
  with arguments, return values, library calls and waits. Runs of repeated calls fold into one
  row (`fetch ×128`); click to unfold. Click a call to open it and see what every other thread
  did meanwhile; double-click to show it on the timeline. Search (`/`) filters the list
- The timeline, Meanwhile and Threads views use exact times instead of samples, and hovering
  a call shows the arguments and return value of that particular call

**Scope.** Your code is everything under the script's directory (for `exec`, the current
directory), except virtualenvs, `site-packages` and the standard library. `--include PKG` also
traces inside an installed package (repeatable). Subprocesses are traced with `--subprocesses`
(`multiprocessing` with spawn or fork, and Python children started with `subprocess`). Works on
Python 3.10+; 3.12+ uses `sys.monitoring` (faster), older versions `sys.setprofile`, where the
exception type isn't available (shown as *exception*).

**Privacy.** By default only types and shapes are recorded, never values. `--values` adds
short reprs of numbers, strings and small tuples; arguments whose name looks secret
(`password`, `token`, `api_key`, …) and values that look like credentials (`sk-…`, `ghp_…`,
JWTs, private keys, …) are recorded as `<redacted>`. User-defined `__repr__` is never called.

**Overhead.** Roughly 5 µs per traced call: negligible when time goes into libraries, GPUs or
I/O, up to ~10× (3.12+) or ~15× (3.10/3.11) on code made of tiny pure-Python functions.
Calls into libraries shorter than 20 µs are only counted, not recorded one by one. After
`--max-events` (default 5M) individual calls stop being recorded but are still counted; the
UI says so.

**Limits.** Native threads that never run Python code are invisible. Code inside libraries is
not traced unless you `--include` it. The target must be started by codexplore (it can't
attach to a running process).

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
- **Calls** — trace-mode runs only: every call in order with its arguments, see [Trace mode](#trace-mode)

Navigation: Ctrl/⌘ + scroll (or pinch) zooms, Shift + scroll pans, drag moves, double-click zooms to a frame, `1`–`8` switch views. The toolbar's ← → buttons (or Alt + ←/→, or the mouse back/forward buttons) step back and forward through where you've been: view, thread, zoom, selection, Map drill-down and time window; the source panel's own ← → step through visited code only. Drag a column edge in the tables, or the edge of the timeline's name gutter, to resize it (double-click to reset). Press `?` in the UI for all shortcuts.

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

With `--trace`, step 1 runs the target directly instead, with a small `sitecustomize` on
`PYTHONPATH` that starts the tracer (and then runs your own `sitecustomize`, if any). Each
process appends its calls to `codexplorer/<run_id>/trace/<pid>.bin`; afterwards they are
turned into the same timeline profile plus `calls.json` (call spans, counts, signatures), and
the raw files are deleted.
