import { NextRequest, NextResponse } from "next/server";
import { closeSession } from "@/lib/mcp-client";

export const runtime = "nodejs";

type CloseSessionBody = {
  sessionId: string;
};

/**
 * Closes an MCP session's subprocess. Called when the user resets the chat
 * (e.g. to switch repos) so the old subprocess doesn't sit around until the
 * idle sweep eventually reaps it.
 */
export async function POST(req: NextRequest) {
  let body: CloseSessionBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.sessionId) {
    return NextResponse.json({ error: "sessionId is required." }, { status: 400 });
  }

  await closeSession(body.sessionId);
  return NextResponse.json({ ok: true });
}
