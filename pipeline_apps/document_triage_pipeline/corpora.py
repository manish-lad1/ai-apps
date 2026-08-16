"""The two document collections this project can run over.

  demo      documents/  — the curated 10, fixed and version-controlled
  uploads   uploads/    — whatever the user drops into the web UI

They are kept deliberately separate. The demo corpus is the talk's content
and evals/cases.py asserts ground truth against those exact ten files, so
letting uploads land in the same folder would break the eval suite and change
what happens on stage. Each corpus therefore gets its own manifest and index.

run_demo.py and the eval harness only ever touch the demo corpus, and neither
knows this module exists.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = PROJECT_ROOT / "output"

# Generous, but enough to stop someone dropping a 500 MB file into a demo.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024


@dataclass(frozen=True)
class Corpus:
    key: str
    label: str
    directory: Path
    manifest_path: Path
    index_path: Path
    writable: bool

    def ensure(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)


DEMO = Corpus(
    key="demo",
    label="Demo corpus",
    directory=PROJECT_ROOT / "documents",
    manifest_path=OUTPUT_DIR / "manifest.json",
    index_path=OUTPUT_DIR / "index.json",
    writable=False,
)

UPLOADS = Corpus(
    key="uploads",
    label="My documents",
    directory=PROJECT_ROOT / "uploads",
    manifest_path=OUTPUT_DIR / "uploads_manifest.json",
    index_path=OUTPUT_DIR / "uploads_index.json",
    writable=True,
)

ALL = {corpus.key: corpus for corpus in (DEMO, UPLOADS)}


def get(key: str) -> Corpus:
    if key not in ALL:
        raise KeyError(f"Unknown corpus {key!r}. Expected one of: {', '.join(ALL)}")
    return ALL[key]


_SAFE_NAME = re.compile(r"[^A-Za-z0-9._ -]")


def safe_filename(raw: str) -> str:
    """Reduce an uploaded filename to something that cannot escape a directory.

    Browsers can send a path, a name with slashes, or something with a null
    byte in it. Take the basename, strip anything exotic, and refuse the
    dotfile and empty cases outright.
    """
    # Handle both separators regardless of the client's platform.
    base = raw.replace("\\", "/").split("/")[-1].strip()
    base = _SAFE_NAME.sub("_", base)
    base = base.lstrip(".")           # no dotfiles, no ".."
    base = re.sub(r"_{2,}", "_", base)

    if not base or base in {".", ".."}:
        raise ValueError("That filename cannot be used.")
    return base[:120]


def unique_filename(directory: Path, filename: str) -> str:
    """Avoid silently overwriting an existing upload with the same name."""
    candidate = directory / filename
    if not candidate.exists():
        return filename

    stem = Path(filename).stem
    suffix = Path(filename).suffix
    for n in range(2, 1000):
        attempt = f"{stem} ({n}){suffix}"
        if not (directory / attempt).exists():
            return attempt
    raise ValueError("Too many files with that name.")
