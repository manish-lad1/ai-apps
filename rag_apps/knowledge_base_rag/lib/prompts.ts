/**
 * Retrieval tuning constants and the prompt that grounds generation in the
 * retrieved chunks. Prompt/knob changes live here, not inlined in the route
 * handler — same convention as prd_critique_agent.
 */

import type { SearchResult } from "./vector-store";
import type { Citation } from "./types";

/** How many chunks to retrieve and feed to the model. */
export const TOP_K = 5;

/**
 * Minimum cosine similarity a chunk must clear to count as "relevant". Below
 * this, we don't call the model at all — we tell the user nothing was found,
 * rather than letting it answer from general knowledge on weak matches.
 *
 * Note this threshold is provider-relative: Voyage and nomic-embed-text put
 * "relevant" at different score levels, so if you change embedding providers,
 * sanity-check this value. It's deliberately lenient — retrieval recall matters
 * more than precision here, and the prompt itself is the stronger guardrail
 * against ungrounded answers.
 */
export const MIN_SCORE = 0.2;

export type { Citation };

const SYSTEM_PROMPT = `You are a retrieval-grounded assistant. You answer questions using ONLY the numbered context passages provided by the user, which were retrieved from a knowledge base.

Rules:
- Answer strictly from the provided passages. Do not use outside knowledge, and do not guess.
- If the passages do not contain enough information to answer, say so plainly (e.g. "The provided sources don't cover that.") instead of inventing an answer. This is the single most important rule.
- Cite the passages you drew from inline using their bracketed numbers, like [1] or [2][4], placed right after the claim they support.
- Be concise and direct. Prefer specifics from the passages over generic phrasing.
- Do not mention "the context" or "the passages" as an apology; just answer, with citations.`;

/**
 * Build the user prompt: the numbered passages plus the question. The numbers
 * here line up with the citation list returned to the UI, so [1] in the answer
 * maps to citations[0].
 */
export function buildRagPrompt(
  query: string,
  results: SearchResult[]
): { systemPrompt: string; userPrompt: string } {
  const passages = results
    .map((r, i) => {
      const m = r.chunk.metadata;
      const source = m.heading
        ? `${m.sourceTitle} — section "${m.heading}"`
        : m.sourceTitle;
      return `[${i + 1}] (source: ${source})\n${r.chunk.text}`;
    })
    .join("\n\n---\n\n");

  const userPrompt = `Context passages:\n\n${passages}\n\n---\n\nQuestion: ${query}\n\nAnswer using only the passages above, citing them inline with [n].`;

  return { systemPrompt: SYSTEM_PROMPT, userPrompt };
}

/** Turn retrieval results into the citation list the UI renders. */
export function toCitations(results: SearchResult[]): Citation[] {
  return results.map((r) => ({
    sourceTitle: r.chunk.metadata.sourceTitle,
    sourceUrl: r.chunk.metadata.sourceUrl,
    sourceType: r.chunk.metadata.sourceType,
    heading: r.chunk.metadata.heading,
    // A trimmed preview so the UI can show the actual retrieved text on expand.
    snippet:
      r.chunk.text.length > 320
        ? `${r.chunk.text.slice(0, 320).trimEnd()}…`
        : r.chunk.text,
    score: Number(r.score.toFixed(3)),
  }));
}
