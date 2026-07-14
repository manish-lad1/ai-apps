import { NextRequest, NextResponse } from "next/server";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { callTool, ensureIdleSweep, getSession, listSessionTools } from "@/lib/mcp-client";
import { generateChatTurn, type ChatMessage, type NormalizedTool, type ToolCall } from "@/lib/llm-provider";

export const runtime = "nodejs";

// Caps how many rounds of tool calls a single chat turn can make before the
// loop is forced to answer with whatever it has — avoids a runaway loop if
// the model keeps requesting tools indefinitely.
const MAX_TOOL_ROUNDTRIPS = 6;

type ChatRequestBody = {
  sessionId: string;
  owner: string;
  repo: string;
  githubToken?: string;
  messages: { role: "user" | "assistant"; content: string }[];
};

type ToolTraceEntry = {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  isError: boolean;
};

function extractText(result: CallToolResult): string {
  const block = result.content.find(
    (b): b is { type: "text"; text: string } => b.type === "text"
  );
  return block?.text ?? JSON.stringify(result.content);
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function POST(req: NextRequest) {
  ensureIdleSweep();

  let body: ChatRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { sessionId, owner, repo, githubToken, messages } = body;
  if (!sessionId || !owner || !repo || !Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json(
      { error: "sessionId, owner, repo, and a non-empty messages array are required." },
      { status: 400 }
    );
  }

  try {
    await getSession(sessionId, githubToken);
    const mcpTools = listSessionTools(sessionId);
    const tools: NormalizedTool[] = mcpTools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    }));

    const systemPrompt =
      `You are an assistant that answers questions about the GitHub repository ${owner}/${repo} ` +
      `by calling the read-only tools available to you — never guess at repo contents, issues, PRs, ` +
      `or activity when a tool can answer it directly. Unless the user names a different repo, assume ` +
      `every question is about ${owner}/${repo}. Give clear, concise natural-language answers built ` +
      `from the structured data the tools return; don't just dump raw JSON back at the user.`;

    const chatMessages: ChatMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
    const toolTrace: ToolTraceEntry[] = [];
    let finalText = "";

    for (let round = 0; round <= MAX_TOOL_ROUNDTRIPS; round++) {
      const turn = await generateChatTurn({ systemPrompt, messages: chatMessages, tools });
      chatMessages.push({ role: "assistant", content: turn.content, toolCalls: turn.toolCalls });

      if (!turn.toolCalls || turn.toolCalls.length === 0) {
        finalText = turn.content;
        break;
      }

      if (round === MAX_TOOL_ROUNDTRIPS) {
        // Out of budget — don't execute more tools, just use whatever text
        // came back alongside the (ignored) tool request.
        finalText =
          turn.content ||
          "I made several tool calls but hit the round-trip limit before finishing. Here's what I found so far — try a more specific follow-up.";
        break;
      }

      const results = await Promise.all(
        turn.toolCalls.map(async (tc: ToolCall) => {
          try {
            const result = await callTool(sessionId, tc.name, tc.args);
            const text = extractText(result);
            toolTrace.push({ name: tc.name, args: tc.args, result: safeParse(text), isError: Boolean(result.isError) });
            return { toolCallId: tc.id, toolName: tc.name, content: text, isError: Boolean(result.isError) };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            toolTrace.push({ name: tc.name, args: tc.args, result: { error: message }, isError: true });
            return { toolCallId: tc.id, toolName: tc.name, content: JSON.stringify({ error: message }), isError: true };
          }
        })
      );

      chatMessages.push({ role: "tool_results", results });
    }

    return NextResponse.json({ reply: finalText, toolTrace });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
