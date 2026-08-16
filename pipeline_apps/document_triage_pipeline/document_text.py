"""Turn an uploaded file of almost any office format into plain text.

Three routes, all of them local:

  plain     .txt .md .csv .log        read the bytes
  pdf       .pdf                      pypdf, a pure-Python parser
  textutil  .docx .rtf .html .odt     the macOS built-in at /usr/bin/textutil

`textutil` is worth knowing about: it ships with macOS, handles most of what
Word and TextEdit produce, and costs no Python dependency at all. pypdf is the
one package this project adds beyond the original pinned set, because nothing
in the standard library or in macOS reads PDF text from the command line.

Neither route touches the network, so the offline guarantee is unaffected —
verify_offline.py covers this.

Extraction results are cached next to the corpus in a `.extracted/` directory,
so a PDF is parsed once rather than on every stage that reads it.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

PLAIN_SUFFIXES = {".txt", ".md", ".csv", ".log", ".text"}
PDF_SUFFIXES = {".pdf"}
TEXTUTIL_SUFFIXES = {".docx", ".doc", ".rtf", ".rtfd", ".html", ".htm", ".odt", ".webarchive"}

SUPPORTED_SUFFIXES = PLAIN_SUFFIXES | PDF_SUFFIXES | TEXTUTIL_SUFFIXES

CACHE_DIRNAME = ".extracted"


class UnsupportedDocument(ValueError):
    """The file is not a format this pipeline can read."""


def is_supported(filename: str) -> bool:
    return Path(filename).suffix.lower() in SUPPORTED_SUFFIXES


def describe_supported() -> str:
    return ", ".join(sorted(s.lstrip(".") for s in SUPPORTED_SUFFIXES))


def _extract_plain(path: Path) -> str:
    # errors="replace" rather than failing: a single bad byte in a log file
    # should not take down an upload.
    return path.read_text(encoding="utf-8", errors="replace")


def _extract_pdf(path: Path) -> str:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    pages = [(page.extract_text() or "").strip() for page in reader.pages]
    text = "\n\n".join(p for p in pages if p)

    if not text.strip():
        raise UnsupportedDocument(
            "No text found in this PDF. It is probably a scan — this pipeline "
            "does not do OCR."
        )
    return text


def _extract_textutil(path: Path) -> str:
    result = subprocess.run(
        ["textutil", "-convert", "txt", "-stdout", str(path)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise UnsupportedDocument(
            f"textutil could not read this file: {result.stderr.strip()[:200]}"
        )
    if not result.stdout.strip():
        raise UnsupportedDocument("That file converted to an empty document.")
    return result.stdout


def extract_text(path: Path) -> str:
    """Return the plain text of one document, whatever format it arrived in."""
    suffix = path.suffix.lower()

    if suffix in PLAIN_SUFFIXES:
        return _extract_plain(path)
    if suffix in PDF_SUFFIXES:
        return _extract_pdf(path)
    if suffix in TEXTUTIL_SUFFIXES:
        return _extract_textutil(path)

    raise UnsupportedDocument(
        f"{suffix or 'that file type'} is not supported. "
        f"Supported: {describe_supported()}."
    )


def cached_text(corpus_dir: Path, filename: str) -> str:
    """Extract with a disk cache, so each upload is parsed exactly once.

    The cache is invalidated whenever the source file is newer than the
    cached text, which covers re-uploading under the same name.
    """
    source = corpus_dir / filename

    # A plain text file is its own cache; nothing to gain by copying it.
    if source.suffix.lower() in PLAIN_SUFFIXES:
        return _extract_plain(source)

    cache_dir = corpus_dir / CACHE_DIRNAME
    cached = cache_dir / (filename + ".txt")

    if cached.is_file() and cached.stat().st_mtime >= source.stat().st_mtime:
        return cached.read_text(encoding="utf-8")

    text = extract_text(source)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached.write_text(text, encoding="utf-8")
    return text


def forget(corpus_dir: Path, filename: str) -> None:
    """Drop a cached extraction, used when its source is deleted."""
    cached = corpus_dir / CACHE_DIRNAME / (filename + ".txt")
    cached.unlink(missing_ok=True)
