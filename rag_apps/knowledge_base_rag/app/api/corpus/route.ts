/**
 * GET /api/corpus — report built-in corpus status + stats for the UI header.
 * Lets built-in mode show "N chunks from M sources", or a clear "not built yet"
 * message instead of failing opaquely when data/embeddings.json is missing.
 */

import { NextResponse } from "next/server";
import { loadCorpus } from "@/lib/corpus-store";

export const runtime = "nodejs";

export async function GET() {
  const corpus = await loadCorpus();
  if (corpus.status === "ready") {
    return NextResponse.json({ status: "ready", meta: corpus.meta });
  }
  return NextResponse.json({ status: corpus.status, message: corpus.message });
}
