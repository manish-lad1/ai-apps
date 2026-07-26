import { deriveConfidence } from "./confidence";
import {
  MIN_APPROVED_QUESTIONS,
  type Question,
  type ResearchResult,
  type Source,
} from "./types";

/** Turn any thrown value into a clean message for the client. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected error.";
}

export function requireIdea(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("An idea description is required.");
  }
  if (value.length > 8000) {
    throw new Error("That idea description is too long — keep it under 8,000 characters.");
  }
  return value.trim();
}

/**
 * The approval gate, enforced server-side. The UI blocks the button below the
 * minimum, but the gate is the thing that stops Stage 2 firing — so it has to
 * hold even if someone posts straight to the route.
 */
export function requireApprovedQuestions(value: unknown): Question[] {
  if (!Array.isArray(value)) {
    throw new Error("Approved questions are required.");
  }

  const questions: Question[] = [];
  const seenIds = new Set<string>();

  for (const raw of value) {
    if (
      typeof raw?.id !== "string" ||
      typeof raw?.question !== "string" ||
      raw.question.trim().length === 0
    ) {
      continue;
    }
    if (seenIds.has(raw.id)) continue;
    seenIds.add(raw.id);
    questions.push({
      id: raw.id,
      question: raw.question.trim(),
      category: typeof raw.category === "string" ? raw.category : "uncategorized",
    });
  }

  if (questions.length < MIN_APPROVED_QUESTIONS) {
    throw new Error(
      `At least ${MIN_APPROVED_QUESTIONS} approved questions are required to run research (got ${questions.length}).`
    );
  }

  return questions;
}

/**
 * Stage 2's output comes back through the browser to reach Stage 3, since
 * nothing is persisted server-side between requests. That makes it untrusted
 * input like any other POST body — so `confidence` is recomputed from the
 * sources here rather than taken from the payload. It's a pure function of the
 * sources, which means there is no reason to trust a client-supplied value for
 * it, and re-running it costs nothing.
 */
export function requireResearchResults(value: unknown): ResearchResult[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Research results are required before a report can be generated.");
  }

  const results: ResearchResult[] = [];
  for (const raw of value) {
    if (typeof raw?.questionId !== "string" || typeof raw?.question !== "string") continue;

    const sources: Source[] = Array.isArray(raw.sources)
      ? raw.sources
          .filter((s: unknown): s is Source => typeof (s as Source)?.url === "string")
          .map((s: Source) => ({
            claim: typeof s.claim === "string" ? s.claim : "",
            url: s.url,
            stance: s.stance === "contradicts" ? "contradicts" : "supports",
          }))
      : [];

    const reachedSufficiency = raw.reachedSufficiency === true;

    results.push({
      questionId: raw.questionId,
      question: raw.question,
      category: typeof raw.category === "string" ? raw.category : "uncategorized",
      findings: typeof raw.findings === "string" ? raw.findings : "",
      sources,
      confidence: deriveConfidence(sources, { reachedSufficiency }).confidence,
      roundsUsed: Number.isFinite(raw.roundsUsed) ? raw.roundsUsed : 0,
      reachedSufficiency,
    });
  }

  if (results.length === 0) {
    throw new Error("No usable research results were supplied.");
  }

  return results;
}

/**
 * Streams newline-delimited JSON back to the browser.
 *
 * NDJSON rather than SSE because the client only needs one-way progress
 * updates and this parses with a `split("\n")` — no EventSource, no reconnect
 * semantics, no extra dependency.
 *
 * A thrown error inside `produce` is emitted as a final event rather than
 * tearing the connection down, so the UI can show what went wrong instead of
 * a stream that just stops.
 */
export function ndjsonStream<T>(
  produce: (emit: (event: T) => void) => Promise<void>,
  toErrorEvent: (message: string) => T
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (event: T) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        await produce(emit);
      } catch (err) {
        emit(toErrorEvent(errorMessage(err)));
      } finally {
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
