"""Web server for the profile analysis UI."""

import json
import mimetypes
import sys
from pathlib import Path

import click
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, Response
from starlette.routing import Route

from codexplore.utils import get_codexplorer_dir, get_run_dir

# Directory containing the bundled web assets
STATIC_DIR = Path(__file__).parent / "web" / "static"

# The UI is served from the package directory and may change between runs
NO_CACHE = {"Cache-Control": "no-cache"}


def _build_source_allowlist(profile_data: dict) -> set[Path]:
    """Build a set of allowed parent directories from the profile's shared frames.

    Only files under one of these directories can be served by the source API.
    """
    dirs: set[Path] = set()
    for frame in profile_data.get("shared", {}).get("frames", []):
        fp = frame.get("file", "")
        if fp:
            resolved = Path(fp).resolve().parent
            dirs.add(resolved)
    return dirs


def serve_analysis(
    run_id: str,
    port: int = 8125,
    host: str = "127.0.0.1",
    base_dir: str | None = None,
):
    """Start the local web server for analyzing a profiling run."""
    codexplorer_dir = get_codexplorer_dir(base_dir)
    run_dir = get_run_dir(codexplorer_dir, run_id)

    if not run_dir.exists():
        print(f"Error: Run '{run_id}' not found in {codexplorer_dir}", file=sys.stderr)
        print(f"Use 'codexplore list' to see available runs.", file=sys.stderr)
        sys.exit(1)

    meta_file = run_dir / "meta.json"
    if not meta_file.exists():
        print(f"Error: No metadata found for run '{run_id}'", file=sys.stderr)
        sys.exit(1)

    with open(meta_file) as f:
        meta = json.load(f)

    profile_file = run_dir / "profile.json"
    if not profile_file.exists():
        print(f"Error: No profile data found for run '{run_id}'", file=sys.stderr)
        sys.exit(1)

    with open(profile_file) as f:
        profile_for_allowlist = json.load(f)
    allowed_dirs = _build_source_allowlist(profile_for_allowlist)

    # ── API Routes ──────────────────────────────────────────────

    async def index(request: Request) -> HTMLResponse:
        """Serve the main HTML page."""
        html = (STATIC_DIR / "index.html").read_text()
        for name in ("app.css", "app.js"):
            version = int((STATIC_DIR / name).stat().st_mtime)
            html = html.replace(f"/static/{name}", f"/static/{name}?v={version}")
        return HTMLResponse(html, headers=NO_CACHE)

    async def api_meta(request: Request) -> JSONResponse:
        """Return run metadata."""
        return JSONResponse(meta)

    async def api_profile(request: Request) -> Response:
        """Return the profile data (speedscope layout, possibly with timeline extensions)."""
        return Response(profile_file.read_bytes(), media_type="application/json")

    async def api_source(request: Request) -> JSONResponse:
        """Return source code for a given file path.

        Query params:
            path: absolute path to the source file
            line: optional center line number for context
            context: number of lines of context (default: full file)
        """
        file_path = request.query_params.get("path", "")
        center_line = request.query_params.get("line")
        context = request.query_params.get("context")

        if not file_path:
            return JSONResponse({"error": "Missing 'path' parameter"}, status_code=400)

        source_path = Path(file_path).resolve()

        # Security: only allow reading .py files
        if source_path.suffix not in (".py", ".pyx", ".pxd"):
            return JSONResponse(
                {"error": "Only Python source files can be viewed"},
                status_code=403,
            )

        # Security: only allow files under directories that appear in the profile
        if allowed_dirs and not any(
            source_path.parent == d or d in source_path.parents
            for d in allowed_dirs
        ):
            return JSONResponse(
                {"error": "File is outside the profiled codebase"},
                status_code=403,
            )

        if not source_path.exists():
            return JSONResponse(
                {"error": f"File not found: {file_path}", "path": file_path},
                status_code=404,
            )

        try:
            content = source_path.read_text(errors="replace")
            lines = content.splitlines()
            total_lines = len(lines)

            start_line = 1
            end_line = total_lines

            if center_line and context:
                center = int(center_line)
                ctx = int(context)
                start_line = max(1, center - ctx)
                end_line = min(total_lines, center + ctx)
                lines = lines[start_line - 1 : end_line]

            return JSONResponse(
                {
                    "path": file_path,
                    "content": "\n".join(lines),
                    "start_line": start_line,
                    "end_line": end_line,
                    "total_lines": total_lines,
                }
            )
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    async def static_file(request: Request) -> Response:
        """Serve static assets (JS, CSS)."""
        file_path = request.path_params.get("path", "")
        full_path = STATIC_DIR / file_path

        if not full_path.exists() or not full_path.is_file():
            return Response("Not found", status_code=404)

        # Security: ensure path is within STATIC_DIR
        try:
            full_path.resolve().relative_to(STATIC_DIR.resolve())
        except ValueError:
            return Response("Forbidden", status_code=403)

        content_type, _ = mimetypes.guess_type(str(full_path))
        return Response(
            full_path.read_bytes(),
            media_type=content_type or "application/octet-stream",
            headers=NO_CACHE,
        )

    # ── App ─────────────────────────────────────────────────────

    app = Starlette(
        routes=[
            Route("/", index),
            Route("/api/meta", api_meta),
            Route("/api/profile", api_profile),
            Route("/api/source", api_source),
            Route("/static/{path:path}", static_file),
        ],
    )

    click.echo(f"🔬 codexplore — Profile Explorer")
    click.echo(f"   Run:  {click.style(run_id, fg='cyan')}")
    click.echo(f"   Target: {meta.get('command') or meta.get('script', 'unknown')}")
    click.echo(f"   URL: {click.style(f'http://{host}:{port}', fg='green', bold=True)}")
    if host not in ("127.0.0.1", "localhost", "::1"):
        click.echo(
            click.style(
                f"   ⚠️  WARNING: Binding to {host} exposes the source viewer to the network.\n"
                f"   The source API can serve any Python file that appears in the profile.\n"
                f"   Use --host 127.0.0.1 (default) to restrict access to localhost.",
                fg="yellow",
            )
        )
    click.echo(f"   Press Ctrl+C to stop.\n")

    uvicorn.run(app, host=host, port=port, log_level="warning")
