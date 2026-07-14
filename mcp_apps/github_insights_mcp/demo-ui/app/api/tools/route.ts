import { NextRequest, NextResponse } from "next/server";
import { ensureIdleSweep, getSession, listSessionTools } from "@/lib/mcp-client";

export const runtime = "nodejs";

type ToolsRequestBody = {
  sessionId: string;
};

/**
 * Returns the live tool list from the MCP server (name + description +
 * input schema) — read from a real running server, not a hardcoded list,
 * so this stays truthful if mcp-server's tools ever change.
 */
export async function POST(req: NextRequest) {
  ensureIdleSweep();

  let body: ToolsRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.sessionId) {
    return NextResponse.json({ error: "sessionId is required." }, { status: 400 });
  }

  try {
    await getSession(body.sessionId);
    const tools = listSessionTools(body.sessionId).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
    }));
    return NextResponse.json({ tools });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
