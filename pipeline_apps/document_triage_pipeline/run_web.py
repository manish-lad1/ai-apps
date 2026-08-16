"""Launch the local web UI.

    python run_web.py            http://127.0.0.1:8000
    python run_web.py --port 9000

Same pipeline as run_demo.py, driven from a browser instead of the terminal.
Bound to loopback only — this serves document contents, so it has no business
listening on anything else.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import uvicorn

# The stage modules live in the project root, one level up from web/.
PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))


def main() -> int:
    parser = argparse.ArgumentParser(description="Local web UI for the pipeline.")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    print(f"\n  Document Triage Pipeline — http://127.0.0.1:{args.port}\n")
    uvicorn.run(
        "web.server:app",
        host="127.0.0.1",
        port=args.port,
        log_level="warning",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
