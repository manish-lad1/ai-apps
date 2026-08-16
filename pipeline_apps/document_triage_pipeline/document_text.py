"""Turn an uploaded file of almost any office format into plain text.

Four routes, all of them local:

  plain     .txt .md .csv .log        read the bytes
  pdf       .pdf                      pypdf, a pure-Python parser
  textutil  .docx .rtf .html .odt     the macOS built-in at /usr/bin/textutil
  ocr       scans, .png .jpg .heic    the macOS Vision framework, via ocr.py

`textutil` is worth knowing about: it ships with macOS, handles most of what
Word and TextEdit produce, and costs no Python dependency at all. pypdf reads
PDF text layers, because nothing in the standard library or in macOS does it
from the command line.

The OCR route is a fallback rather than a choice. A scanned PDF has no text
layer, so pypdf returns nothing — and that empty result is exactly the signal
to rasterise the pages and recognise them instead. See ocr.py.

No route touches the network, so the offline guarantee is unaffected —
verify_offline.py covers this.

Extraction results are cached next to the corpus in a `.extracted/` directory,
so a PDF is parsed once rather than on every stage that reads it.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

PLAIN_SUFFIXES = {".txt", ".md", ".csv", ".log", ".text"}
PDF_SUFFIXES = {".pdf"}
TEXTUTIL_SUFFIXES = {".docx", ".doc", ".rtf", ".rtfd", ".html", ".htm", ".odt", ".webarchive"}
# Photographs and scans of documents, read by OCR.
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".tiff", ".tif", ".heic", ".gif", ".bmp"}

SUPPORTED_SUFFIXES = (
    PLAIN_SUFFIXES | PDF_SUFFIXES | TEXTUTIL_SUFFIXES | IMAGE_SUFFIXES
)

CACHE_DIRNAME = ".extracted"

# Bumped whenever extraction changes shape. Without it a cached extraction
# outlives the code that produced it: the mtime check only notices a newer
# source file, so editing this module leaves every existing cache entry
# looking valid. That cost an hour of debugging a fix that was working.
EXTRACTION_VERSION = 3


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
    """Read a PDF's text layer, falling back to OCR when it has none.

    A born-digital PDF carries its text and pypdf reads it exactly. A scan
    carries only pixels, and pypdf returns nothing at all — that empty result
    is the signal to hand the file to the OCR path.
    """
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    pages = [(page.extract_text() or "").strip() for page in reader.pages]
    text = "\n\n".join(p for p in pages if p)

    if text.strip():
        return text

    try:
        import ocr
    except ImportError as exc:
        raise UnsupportedDocument(
            "No text found in this PDF. It is probably a scan, and OCR is "
            "unavailable on this machine."
        ) from exc

    try:
        return ocr.pdf_to_text(path)
    except ocr.OCRUnavailable as exc:
        raise UnsupportedDocument(f"No text layer, and OCR failed: {exc}") from exc


def _extract_image(path: Path) -> str:
    """OCR a photograph or scan supplied as an image rather than a PDF."""
    try:
        import ocr
    except ImportError as exc:
        raise UnsupportedDocument(
            "Reading images requires OCR, which is unavailable on this machine."
        ) from exc

    try:
        return ocr.image_to_text(path)
    except ocr.OCRUnavailable as exc:
        raise UnsupportedDocument(str(exc)) from exc


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


def normalise_whitespace(text: str) -> str:
    """Collapse the layout padding that PDF extraction leaves behind.

    A PDF laid out in fixed-width columns extracts with every line padded
    out to the page width, which roughly doubles the character count without
    adding a word of content. On the demo corpus this measured 1.9x to 2.7x.

    That padding is not harmless. Stage 1 hands the document back to the
    model as a tool result, and one padded invoice reliably caused the model
    to produce no write_manifest call at all — three times out of three,
    where the same document unpadded succeeded. Collapsing runs of spaces
    took it from 2488 characters to 1016 and fixed it.

    Blank lines are preserved, because Stage 2 chunks on paragraph breaks.
    """
    lines = [re.sub(r"[ \t]+", " ", line).rstrip() for line in text.splitlines()]
    collapsed = "\n".join(lines)
    return re.sub(r"\n{3,}", "\n\n", collapsed).strip()


def extract_text(path: Path) -> str:
    """Return the plain text of one document, whatever format it arrived in."""
    suffix = path.suffix.lower()

    if suffix in PLAIN_SUFFIXES:
        # Author-written text is left exactly as it is; its whitespace is
        # meaningful, and the demo corpus relies on aligned invoice tables.
        return _extract_plain(path)
    if suffix in PDF_SUFFIXES:
        return normalise_whitespace(_extract_pdf(path))
    if suffix in TEXTUTIL_SUFFIXES:
        return normalise_whitespace(_extract_textutil(path))
    if suffix in IMAGE_SUFFIXES:
        return normalise_whitespace(_extract_image(path))

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
    cached = cache_dir / f"{filename}.v{EXTRACTION_VERSION}.txt"

    if cached.is_file() and cached.stat().st_mtime >= source.stat().st_mtime:
        return cached.read_text(encoding="utf-8")

    text = extract_text(source)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached.write_text(text, encoding="utf-8")
    return text


def forget(corpus_dir: Path, filename: str) -> None:
    """Drop cached extractions for a file, used when its source is deleted."""
    cache_dir = corpus_dir / CACHE_DIRNAME
    if not cache_dir.is_dir():
        return
    for stale in cache_dir.glob(f"{filename}.v*.txt"):
        stale.unlink(missing_ok=True)
