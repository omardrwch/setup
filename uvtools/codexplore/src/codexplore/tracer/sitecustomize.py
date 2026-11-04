"""codexplore trace bootstrap.

This directory is put on PYTHONPATH by `codexplore run/exec --trace`, so Python imports this file
at startup. It starts the tracer when CODEXPLORE_TRACE is set, then runs the user's own
sitecustomize (if there is one) exactly as Python would have without us.
"""

import os
import sys


def _chain_user_sitecustomize() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    for entry in sys.path:
        if not entry or os.path.abspath(entry) == here:
            continue
        for cand in (os.path.join(entry, "sitecustomize.py"), os.path.join(entry, "sitecustomize", "__init__.py")):
            if os.path.isfile(cand):
                import importlib.util

                spec = importlib.util.spec_from_file_location("sitecustomize", cand)
                if spec and spec.loader:
                    mod = importlib.util.module_from_spec(spec)
                    sys.modules["sitecustomize"] = mod
                    spec.loader.exec_module(mod)
                return


if os.environ.get("CODEXPLORE_TRACE"):
    try:
        import _codexplore_tracer

        _codexplore_tracer.start()
    except Exception as e:  # never break the traced program
        sys.stderr.write(f"codexplore: tracer failed to start: {e!r}\n")

_chain_user_sitecustomize()
