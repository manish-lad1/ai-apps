import { NextResponse } from "next/server";
import { researchAll } from "@/agents/research-agent";
import { maxConcurrentResearchAgents } from "@/lib/config";
import {
  errorMessage,
  ndjsonStream,
  requireApprovedQuestions,
} from "@/lib/route-helpers";
import type { ResearchEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 800;

/**
 * Stage 2. Fires only once the approval gate has passed — the minimum question
 * count is re-checked here, not just in the UI.
 *
 * Streams NDJSON status events as the parallel agents work, so the grid can
 * show each question moving through its search rounds live rather than the
 * whole stage landing at once when the last agent finishes.
 */
export async function POST(request: Request) {
  let questions;
  try {
    const body = await request.json();
    questions = requireApprovedQuestions(body?.questions);
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 400 });
  }

  const approved = questions;
  const concurrency = maxConcurrentResearchAgents();

  return ndjsonStream<ResearchEvent>(
    async (emit) => {
      emit({
        type: "started",
        concurrency,
        questionCount: approved.length,
      });
      await researchAll(approved, concurrency, emit);
    },
    (message) => ({ type: "error", questionId: "*", message })
  );
}
