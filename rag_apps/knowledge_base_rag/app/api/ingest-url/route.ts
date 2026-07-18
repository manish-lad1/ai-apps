/**
 * POST /api/ingest-url — fetch a URL, extract its readable text, and add it to
 * a session's knowledge base.
 *
 * Body: { sessionId, url }. The heavy lifting (SSRF guard, fetch, redirect
 * re-validation, Readability extraction) lives in lib/url-fetcher.ts; this
 * handler just validates input, calls it, and stores the result.
 */

import { NextResponse } from "next/server";
import { fetchAndExtract, UrlFetchError } from "@/lib/url-fetcher";
import { ingestIntoSession, errorMessage } from "@/lib/route-helpers";

// jsdom + dns need the Node.js runtime.
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const sessionId = body?.sessionId;
    const url = body?.url;

    if (typeof sessionId !== "string" || !sessionId) {
      return NextResponse.json({ error: "Missing sessionId." }, { status: 400 });
    }
    if (typeof url !== "string" || !url.trim()) {
      return NextResponse.json({ error: "Missing URL." }, { status: 400 });
    }

    const page = await fetchAndExtract(url.trim());

    const source = await ingestIntoSession(sessionId, {
      text: page.text,
      title: page.title,
      url: page.url,
      sourceType: "url",
    });

    return NextResponse.json({ source });
  } catch (err) {
    // UrlFetchError carries a user-facing message and is the "expected" failure
    // (bad URL, SSRF block, paywall, non-200) — return it as a 400, not a 500.
    if (err instanceof UrlFetchError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
}
