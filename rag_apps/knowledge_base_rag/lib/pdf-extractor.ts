/**
 * PDF text extraction, isolated behind one function so the rest of the app
 * never touches the PDF library directly.
 *
 * pdf-parse v2 is ESM and pulls in pdfjs-dist, which doesn't survive Next's
 * server bundling — so it's marked external in next.config.ts and imported
 * dynamically here to keep it out of the module graph until it's actually used.
 */

export type PdfExtractError = { message: string };

/** Extract all text from a PDF buffer. Throws with a clean message on failure. */
export async function extractPdfText(data: Buffer): Promise<string> {
  // Dynamic import: keeps the heavy pdfjs dependency off the hot path and lets
  // Next treat it as an external, runtime-resolved module.
  const { PDFParse } = await import("pdf-parse");

  const parser = new PDFParse({ data: new Uint8Array(data) });
  try {
    const result = await parser.getText();
    const text = (result.text ?? "").trim();
    if (text.length === 0) {
      throw new Error(
        "No extractable text found in that PDF. It may be a scanned image (no OCR), or otherwise text-free."
      );
    }
    return text;
  } catch (err) {
    if (err instanceof Error) throw err;
    throw new Error("Failed to read that PDF.");
  } finally {
    await parser.destroy();
  }
}
