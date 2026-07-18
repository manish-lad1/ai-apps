/**
 * POST /api/upload — add an uploaded file to a session's knowledge base.
 *
 * Accepts multipart form data: `sessionId` + one `file`. Only .md/.txt/.pdf are
 * allowed; other types are rejected rather than silently mis-parsed. Enforces a
 * per-file size cap and a per-session file count. Extracts text, chunks, embeds,
 * and stores it in the session's in-memory vector store.
 */

import { NextResponse } from "next/server";
import { extractPdfText } from "@/lib/pdf-extractor";
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  countUploadedFiles,
  ingestIntoSession,
  errorMessage,
} from "@/lib/route-helpers";

// Uses Buffer + pdf-parse, so this must run on the Node.js runtime, not Edge.
export const runtime = "nodejs";

const ALLOWED = [".md", ".txt", ".pdf"] as const;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const sessionId = form.get("sessionId");
    const file = form.get("file");

    if (typeof sessionId !== "string" || !sessionId) {
      return NextResponse.json({ error: "Missing sessionId." }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 });
    }

    const ext = extensionOf(file.name);
    if (!ALLOWED.includes(ext as (typeof ALLOWED)[number])) {
      return NextResponse.json(
        {
          error: `Unsupported file type "${ext || "unknown"}". Only ${ALLOWED.join(", ")} are accepted.`,
        },
        { status: 415 }
      );
    }

    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        {
          error: `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)}MB, over the ${MAX_FILE_BYTES / 1024 / 1024}MB limit.`,
        },
        { status: 413 }
      );
    }

    if (countUploadedFiles(sessionId) >= MAX_FILES) {
      return NextResponse.json(
        {
          error: `This session already has the maximum of ${MAX_FILES} files. Clear the knowledge base to add more.`,
        },
        { status: 409 }
      );
    }

    // Extract text. md/txt are read directly; PDF goes through pdf-extractor.
    const buffer = Buffer.from(await file.arrayBuffer());
    let text: string;
    if (ext === ".pdf") {
      text = await extractPdfText(buffer);
    } else {
      text = buffer.toString("utf-8");
    }

    if (text.trim().length === 0) {
      return NextResponse.json(
        { error: `"${file.name}" appears to be empty.` },
        { status: 422 }
      );
    }

    const source = await ingestIntoSession(sessionId, {
      text,
      title: file.name,
      url: `file:${file.name}`,
      sourceType: "upload",
    });

    return NextResponse.json({ source });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
}
