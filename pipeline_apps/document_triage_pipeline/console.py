"""Console output shaped for a projector at the back of a room.

Rules this module exists to enforce: big obvious stage headers, one line per
document rather than a wall of JSON, and visible timing so a slow cold start
reads as a cold start and not as a crash.
"""

from __future__ import annotations

import sys
import time
from contextlib import contextmanager
from pathlib import Path

WIDTH = 68


def rel(path: Path) -> str:
    """Shorten a path for display — absolute paths do not read at distance."""
    try:
        return str(path.relative_to(Path.cwd()))
    except ValueError:
        return str(path)


def banner(title: str) -> None:
    print()
    print("=" * WIDTH)
    print(f"  {title}")
    print("=" * WIDTH)


def stage_header(number: int, title: str) -> None:
    banner(f"STAGE {number}   {title}")


def section(title: str) -> None:
    print()
    print(f"-- {title} " + "-" * max(0, WIDTH - len(title) - 4))


def info(message: str) -> None:
    print(f"   {message}")


def item(name: str, detail: str, *, ok: bool = True) -> None:
    """One line per document. Fixed-width name column so results line up."""
    mark = "OK  " if ok else "FAIL"
    print(f"   [{mark}] {name:<38.38s} {detail}")


def progress(current: int, total: int, label: str) -> None:
    """Single rewriting line — embedding 10 documents should not scroll."""
    bar_width = 24
    filled = int(bar_width * current / total) if total else bar_width
    bar = "#" * filled + "." * (bar_width - filled)
    sys.stdout.write(f"\r   [{bar}] {current}/{total}  {label:<28.28s}")
    sys.stdout.flush()
    if current >= total:
        sys.stdout.write("\n")
        sys.stdout.flush()


@contextmanager
def timed(label: str):
    """Print how long a phase took, so cold starts are explainable on stage."""
    start = time.perf_counter()
    yield
    print(f"   {label} took {time.perf_counter() - start:.1f}s")


def loading_notice(model_id: str) -> None:
    print(f"   Loading {model_id} into memory (cold start, please wait)...")
