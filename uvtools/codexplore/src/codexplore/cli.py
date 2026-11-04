"""CLI entry point for codexplore."""

import click
import sys

from codexplore.runner import exec_profile, run_profile
from codexplore.server import serve_analysis

CPU_HELP = (
    "Record CPU samples only, without the wall-clock timeline across threads "
    "(smaller files, no waiting time)."
)


def trace_options(f):
    """Options shared by `run` and `exec` for exact tracing."""
    f = click.option("--max-events", default=5_000_000, type=int, show_default=True,
                     help="With --trace: stop recording individual calls after this many events (counts continue).")(f)
    f = click.option("--values", is_flag=True, default=False,
                     help="With --trace: also record short reprs of scalar/string arguments and return values "
                          "(secret-looking names and values are redacted). Off by default: only types and shapes.")(f)
    f = click.option("--include", multiple=True, metavar="PKG",
                     help="With --trace: also trace inside this installed package (repeatable), e.g. --include transformers.")(f)
    f = click.option("--trace", "trace", is_flag=True, default=False,
                     help="Record every call in your code exactly (in-process tracer instead of sampling): "
                          "call counts, order, argument types/shapes, exceptions.")(f)
    return f


def _trace_cfg(trace, cpu, include, values, max_events):
    if not trace:
        if include or values:
            raise click.UsageError("--include and --values need --trace.")
        return None
    if cpu:
        raise click.UsageError("--trace and --cpu are different recording modes; pick one.")
    return {"include": list(include), "values": values, "max_events": max_events}


@click.group()
@click.version_option()
def main():
    """codexplore — profile and explore your Python code, 100% locally."""
    pass


@main.command("run")
@click.argument("script", type=click.Path(exists=True))
@click.argument("script_args", nargs=-1, type=click.UNPROCESSED)
@click.option(
    "--python",
    default=None,
    help="Path to the Python interpreter to use. Defaults to 'python' in current PATH.",
)
@click.option(
    "--rate",
    default=100,
    type=int,
    help="Sampling rate in Hz (default: 100).",
)
@click.option(
    "--subprocesses",
    is_flag=True,
    default=False,
    help="Profile subprocesses as well.",
)
@click.option("--cpu", is_flag=True, default=False, help=CPU_HELP)
@trace_options
def run_cmd(script, script_args, python, rate, subprocesses, cpu, trace, include, values, max_events):
    """Profile a Python script.

    Usage: codexplore run <script.py> [-- script args...]
    """
    run_id = run_profile(
        script=script,
        script_args=list(script_args),
        python=python,
        rate=rate,
        subprocesses=subprocesses,
        cpu=cpu,
        trace=_trace_cfg(trace, cpu, include, values, max_events),
    )
    if run_id:
        click.echo(f"\n✅ Profile saved. Run ID: {click.style(run_id, fg='green', bold=True)}")
        click.echo(f"   Analyze with: codexplore analyze {run_id}")
    else:
        click.echo("\n❌ Profiling failed.", err=True)
        sys.exit(1)


@main.command("exec", context_settings={"ignore_unknown_options": True})
@click.argument("command", nargs=-1, type=click.UNPROCESSED, required=True)
@click.option(
    "--rate",
    default=100,
    type=int,
    help="Sampling rate in Hz (default: 100).",
)
@click.option(
    "--subprocesses",
    is_flag=True,
    default=False,
    help="Profile subprocesses as well.",
)
@click.option("--cpu", is_flag=True, default=False, help=CPU_HELP)
@trace_options
def exec_cmd(command, rate, subprocesses, cpu, trace, include, values, max_events):
    """Profile any command (must be a Python process).

    Usage: codexplore exec -- harbor run <task>
           codexplore exec --rate 200 -- uvicorn app:main
           codexplore exec --trace -- python -m mypkg.train
    """
    run_id = exec_profile(
        command=list(command),
        rate=rate,
        subprocesses=subprocesses,
        cpu=cpu,
        trace=_trace_cfg(trace, cpu, include, values, max_events),
    )
    if run_id:
        click.echo(f"\n✅ Profile saved. Run ID: {click.style(run_id, fg='green', bold=True)}")
        click.echo(f"   Analyze with: codexplore analyze {run_id}")
    else:
        click.echo("\n❌ Profiling failed.", err=True)
        sys.exit(1)


@main.command("analyze")
@click.argument("run_id")
@click.option(
    "--port",
    default=8125,
    type=int,
    help="Port for the local web server (default: 8125).",
)
@click.option(
    "--host",
    default="127.0.0.1",
    help="Host to bind to (default: 127.0.0.1).",
)
@click.option(
    "--dir",
    "base_dir",
    default=None,
    help="Base directory containing the codexplorer/ folder. Defaults to cwd.",
)
def analyze_cmd(run_id, port, host, base_dir):
    """Launch the profile explorer web UI for a given run.

    Usage: codexplore analyze <run_id>
    """
    serve_analysis(run_id=run_id, port=port, host=host, base_dir=base_dir)


@main.command("list")
@click.option(
    "--dir",
    "base_dir",
    default=None,
    help="Base directory containing the codexplorer/ folder. Defaults to cwd.",
)
def list_cmd(base_dir):
    """List all available profiling runs."""
    from codexplore.utils import get_codexplorer_dir, list_runs

    codexplorer_dir = get_codexplorer_dir(base_dir)
    runs = list_runs(codexplorer_dir)
    if not runs:
        click.echo("No runs found.")
        return
    click.echo(f"Found {len(runs)} run(s):\n")
    for run in runs:
        label = run.get("command") or run.get("script", "unknown")
        click.echo(f"  {click.style(run['id'], fg='cyan')}  {run['timestamp']}  {label}")


if __name__ == "__main__":
    main()
