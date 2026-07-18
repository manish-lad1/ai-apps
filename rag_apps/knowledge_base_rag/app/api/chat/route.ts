/**
 * POST /api/chat — the retrieval-augmented answer endpoint.
 *
 * Body: { query, mode: "builtin" | "session", sessionId? }
 *
 * Steps:
 *   1. Embed the query with input_type="query".
 *   2. Cosine-similarity search the right store (built-in corpus or the
 *      session's uploaded KB) for the top-K chunks.
 *   3. If nothing clears the minimum similarity threshold, DON'T call the model
 *      — say nothing relevant was found, so the model can't fabricate from
 *      general knowledge.
 *   4. Otherwise, build a grounded prompt and generate an answer.
 *   5. Return the answer plus a structured citation list.
 */

import { NextResponse } from "next/server";
import { embedOne } from "@/lib/embedding-provider";
import { generateText } from "@/lib/llm-provider";
import { loadCorpus } from "@/lib/corpus-store";
import { getSession } from "@/lib/session-store";
import { VectorStore } from "@/lib/vector-store";
import { buildRagPrompt, toCitations, TOP_K, MIN_SCORE } from "@/lib/prompts";
import { errorMessage } from "@/lib/route-helpers";

export const runtime = "nodejs";

type ChatBody = {
  query?: unknown;
  mode?: unknown;
  sessionId?: unknown;
};

/** Resolve the vector store for the requested mode, or a user-facing error. */
async function resolveStore(
  mode: string,
  sessionId: string | undefined
): Promise<{ store: VectorStore } | { error: string; status: number }> {
  if (mode === "builtin") {
    const corpus = await loadCorpus();
    if (corpus.status !== "ready") {
      return { error: corpus.message, status: 503 };
    }
    return { store: corpus.store };
  }

  if (mode === "session") {
    if (!sessionId) {
      return { error: "Missing sessionId for session mode.", status: 400 };
    }
    const session = getSession(sessionId);
    if (!session || session.store.size === 0) {
      return {
        error:
          "Your knowledge base is empty. Upload a file or add a URL first, then ask a question.",
        status: 400,
      };
    }
    return { store: session.store };
  }

  return { error: `Unknown mode "${mode}".`, status: 400 };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as ChatBody | null;
    const query = typeof body?.query === "string" ? body.query.trim() : "";
    const mode = typeof body?.mode === "string" ? body.mode : "";
    const sessionId =
      typeof body?.sessionId === "string" ? body.sessionId : undefined;

    if (!query) {
      return NextResponse.json({ error: "Empty question." }, { status: 400 });
    }

    const resolved = await resolveStore(mode, sessionId);
    if ("error" in resolved) {
      return NextResponse.json(
        { error: resolved.error },
        { status: resolved.status }
      );
    }

    // 1 + 2: embed the query and retrieve.
    const queryVector = await embedOne(query, "query");
    const results = resolved.store.search(queryVector, TOP_K, MIN_SCORE);

    // 3: nothing relevant — refuse to answer rather than inviting a hallucination.
    if (results.length === 0) {
      return NextResponse.json({
        answer:
          "I couldn't find anything relevant in this knowledge base to answer that. Try rephrasing, or ask about something the sources actually cover.",
        citations: [],
        grounded: false,
      });
    }

    // 4 + 5: grounded generation, with the citation list the UI renders.
    const { systemPrompt, userPrompt } = buildRagPrompt(query, results);
    const answer = await generateText({ systemPrompt, userPrompt });

    return NextResponse.json({
      answer,
      citations: toCitations(results),
      grounded: true,
    });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
}
