"""OCR for scanned PDFs, using the OCR engine already built into macOS.

Apple's Vision framework does the recognition and Quartz does the page
rendering. Both ship with the operating system: nothing is downloaded, no
model is loaded, and nothing touches the network. A page takes about a third
of a second.

Three things were learned getting this to work, and all three are load-bearing:

  * Vision returns ZERO results on an image with an alpha channel, with no
    error and no warning. A page rendered straight from a PDF has a
    transparent background, so every page is composited onto white first.
    This is the single easiest way to conclude, wrongly, that OCR is broken.

  * Vision returns text in spatial order, not reading order. Left alone, an
    invoice table comes back as every description, then every quantity, then
    every amount — columns detached from their rows, which is worse than
    useless when the question is what a line item cost. Observations are
    therefore regrouped into rows by their bounding boxes.

  * Recognition is good but not perfect. On a clean synthetic scan it
    recovered 9 of 11 key fields, misreading "Supplies" as "Supplles" and
    dropping two digits from a VAT number. On two tightly spaced lines it
    returned a single observation with the characters of both interleaved
    into nonsense — a recognition failure no amount of layout logic can
    undo. Treat OCR'd text as evidence, not as ground truth.
"""

from __future__ import annotations

from pathlib import Path

import Quartz
import Vision
from Foundation import NSURL

# 200 dpi against a 72 dpi PDF user space. Tested at 400 dpi too, which
# recovered exactly the same fields for four times the pixels.
RENDER_SCALE = 200.0 / 72.0

# Two text observations belong to the same row when their vertical centres sit
# within this fraction of the page height. Measured against a real page: text
# on the same row differs by under 0.002, and consecutive rows by about 0.016,
# so anything in that range works. 0.004 keeps a comfortable margin either way.
ROW_TOLERANCE = 0.004


class OCRUnavailable(RuntimeError):
    """The Vision framework could not be used on this machine."""


def _render_page(page, scale: float = RENDER_SCALE):
    """Render one PDF page to a CGImage on an opaque white background."""
    media = Quartz.CGPDFPageGetBoxRect(page, Quartz.kCGPDFMediaBox)
    width = int(Quartz.CGRectGetWidth(media) * scale)
    height = int(Quartz.CGRectGetHeight(media) * scale)
    if width <= 0 or height <= 0:
        raise OCRUnavailable("PDF page has no usable dimensions.")

    colour_space = Quartz.CGColorSpaceCreateDeviceRGB()
    # kCGImageAlphaNoneSkipLast: no alpha channel at all. Vision silently
    # fails on images that have one.
    context = Quartz.CGBitmapContextCreate(
        None, width, height, 8, 0, colour_space,
        Quartz.kCGImageAlphaNoneSkipLast,
    )
    if context is None:
        raise OCRUnavailable("Could not create a bitmap context for rendering.")

    # Paint the page white before drawing, so unmarked areas are not black.
    Quartz.CGContextSetRGBFillColor(context, 1.0, 1.0, 1.0, 1.0)
    Quartz.CGContextFillRect(context, Quartz.CGRectMake(0, 0, width, height))
    Quartz.CGContextScaleCTM(context, scale, scale)
    Quartz.CGContextDrawPDFPage(context, page)

    return Quartz.CGBitmapContextCreateImage(context)


def _recognise(cg_image) -> list[tuple[float, float, str]]:
    """Return (vertical centre, left edge, text) for every observation."""
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    # Language correction "fixes" reference numbers into words. Measured as
    # no better with it on, and it is a liability on codes and amounts.
    request.setUsesLanguageCorrection_(False)

    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(
        cg_image, None
    )
    success, error = handler.performRequests_error_([request], None)
    if not success:
        raise OCRUnavailable(f"Vision failed to process the page: {error}")

    rows = []
    for observation in request.results() or []:
        candidates = observation.topCandidates_(1)
        if not candidates:
            continue
        box = observation.boundingBox()
        # Vision's origin is bottom-left; flip so larger y means further down.
        centre_y = 1.0 - (box.origin.y + box.size.height / 2.0)
        rows.append((centre_y, box.origin.x, candidates[0].string()))
    return rows


def _to_reading_order(observations: list[tuple[float, float, str]]) -> str:
    """Group observations into rows top to bottom, then left to right.

    This is what keeps an invoice table readable: without it the columns
    arrive detached from the rows they belong to.
    """
    if not observations:
        return ""

    lines: list[str] = []
    current: list[tuple[float, float, str]] = []
    current_y: float | None = None

    for centre_y, left, text in sorted(observations, key=lambda o: (o[0], o[1])):
        if current_y is None or abs(centre_y - current_y) <= ROW_TOLERANCE:
            current.append((centre_y, left, text))
            current_y = centre_y if current_y is None else current_y
        else:
            lines.append(" ".join(t for _, _, t in sorted(current, key=lambda o: o[1])))
            current = [(centre_y, left, text)]
            current_y = centre_y

    if current:
        lines.append(" ".join(t for _, _, t in sorted(current, key=lambda o: o[1])))

    return "\n".join(lines)


def pdf_to_text(path: Path, max_pages: int = 20) -> str:
    """OCR a scanned PDF. Returns the recognised text, page by page."""
    url = NSURL.fileURLWithPath_(str(path))
    document = Quartz.CGPDFDocumentCreateWithURL(url)
    if document is None:
        raise OCRUnavailable(f"Could not open {path.name} as a PDF.")

    page_count = Quartz.CGPDFDocumentGetNumberOfPages(document)
    if page_count == 0:
        raise OCRUnavailable(f"{path.name} has no pages.")

    pages = []
    for number in range(1, min(page_count, max_pages) + 1):
        page = Quartz.CGPDFDocumentGetPage(document, number)
        if page is None:
            continue
        text = _to_reading_order(_recognise(_render_page(page)))
        if text.strip():
            pages.append(text)

    if not pages:
        raise OCRUnavailable(
            "OCR found no text on any page. The scan may be blank, upside "
            "down, or handwritten — this uses printed-text recognition only."
        )

    return "\n\n".join(pages)


def image_to_text(path: Path) -> str:
    """OCR a standalone image file."""
    source = Quartz.CGImageSourceCreateWithURL(
        NSURL.fileURLWithPath_(str(path)), None
    )
    if source is None:
        raise OCRUnavailable(f"Could not decode {path.name} as an image.")

    cg_image = Quartz.CGImageSourceCreateImageAtIndex(source, 0, None)
    if cg_image is None:
        raise OCRUnavailable(f"Could not read pixel data from {path.name}.")

    # Redraw onto opaque white: a transparent PNG yields zero results.
    width = Quartz.CGImageGetWidth(cg_image)
    height = Quartz.CGImageGetHeight(cg_image)
    context = Quartz.CGBitmapContextCreate(
        None, width, height, 8, 0,
        Quartz.CGColorSpaceCreateDeviceRGB(),
        Quartz.kCGImageAlphaNoneSkipLast,
    )
    Quartz.CGContextSetRGBFillColor(context, 1.0, 1.0, 1.0, 1.0)
    Quartz.CGContextFillRect(context, Quartz.CGRectMake(0, 0, width, height))
    Quartz.CGContextDrawImage(
        context, Quartz.CGRectMake(0, 0, width, height), cg_image
    )
    flattened = Quartz.CGBitmapContextCreateImage(context)

    text = _to_reading_order(_recognise(flattened))
    if not text.strip():
        raise OCRUnavailable(f"OCR found no text in {path.name}.")
    return text
