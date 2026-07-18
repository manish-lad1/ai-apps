/**
 * POST /api/clear — drop a session's in-memory knowledge base.
 * Body: { sessionId }. Backs the UI's "clear knowledge base" button.
 */

import { NextResponse } from "next/server";
import { clearSession } from "@/lib/session-store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const sessionId = body?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) {
    return NextResponse.json({ error: "Missing sessionId." }, { status: 400 });
  }
  clearSession(sessionId);
  return NextResponse.json({ ok: true });
}
