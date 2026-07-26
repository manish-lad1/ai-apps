import { maxResearchRoundsPerQuestion } from "@/lib/config";
import { deriveConfidence } from "@/lib/confidence";
import { generateStructured } from "@/lib/llm-provider";
import { RESEARCH_AGENT_SYSTEM, researchAgentUser } from "@/lib/prompts";
import { researchRoundSchema } from "@/lib/schemas";
import { search, type SearchResponse } from "@/lib/search-provider";
import type { Question, ResearchEvent, ResearchResult, Source } from "@/lib/types";

/**
 * Stage 2. One instance of this runs per approved question.
 *
 * These agents are DECOMPOSED, not a crew: an instance knows its own question
 * and nothing else. There is no shared scratchpad, no message passing, and no
 * awareness that other agents exist. That is deliberate — it keeps each
 * question's evidence independent, so two questions landing on contradictory
 * answers is a signal Stage 3 can detect rather than something the agents
 * quietly negotiate away between themselves.
 *
 * Within its own question the agent is genuinely agentic: it searches, judges
 * whether what came back is good enough, and searches again against the
 * specific gap if not — up to a hard round cap.
 */

type RoundRecord = { query: string; response: SearchResponse };

type ResearchRoundOutput = {
  sufficient: boolean;
  gap: string;
  next_query: string;
  findings: string;
  sources: Source[];
};

/**
 * Trailing slashes and case differences in the host shouldn't decide whether a
 * citation is accepted, but the path is left case-sensitive because it can be.
 */
function normalizeUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return null;
  }
}

/**
 * Drops any cited URL that never appeared in a search result for this question.
 *
 * The prompt already forbids inventing URLs, but a prompt is a request and this
 * is a guarantee: a fabricated source that slipped through would inflate the
 * derived confidence, which is exactly the thing confidence is supposed to be
 * immune to.
 */
function keepOnlyRetrievedSources(sources: Source[], rounds: RoundRecord[]): Source[] {
  const retrieved = new Map<string, string>();
  for (const round of rounds) {
    for (const result of round.response.results) {
      const key = normalizeUrl(result.url);
      if (key) retrieved.set(key, result.url);
    }
  }

  const kept: Source[] = [];
  for (const source of sources ?? []) {
    if (typeof source?.url !== "string") continue;
    const key = normalizeUrl(source.url);
    if (!key) continue;
    const canonical = retrieved.get(key);
    if (!canonical) {
      console.warn(`[research-agent] Dropping cited URL that was never retrieved: ${source.url}`);
      continue;
    }
    kept.push({
      claim: source.claim ?? "",
      url: canonical,
      stance: source.stance === "contradicts" ? "contradicts" : "supports",
    });
  }
  return kept;
}

/** Later rounds may re-label a source's stance, so the newest label wins. */
function mergeSources(accumulated: Source[], incoming: Source[]): Source[] {
  const byUrl = new Map<string, Source>();
  for (const source of accumulated) byUrl.set(source.url, source);
  for (const source of incoming) byUrl.set(source.url, source);
  return [...byUrl.values()];
}

export async function researchQuestion(
  question: Question,
  onEvent: (event: ResearchEvent) => void
): Promise<ResearchResult> {
  const maxRounds = maxResearchRoundsPerQuestion();
  const rounds: RoundRecord[] = [];

  let query = question.question;
  let findings = "";
  let sources: Source[] = [];
  let roundsUsed = 0;
  let reachedSufficiency = false;

  for (let round = 1; round <= maxRounds; round++) {
    roundsUsed = round;
    onEvent({ type: "round_start", questionId: question.id, round });

    onEvent({ type: "searching", questionId: question.id, round, query });
    const response = await search(query);
    rounds.push({ query, response });
    onEvent({
      type: "search_done",
      questionId: question.id,
      round,
      query,
      resultCount: response.results.length,
    });

    onEvent({ type: "assessing", questionId: question.id, round });
    const assessment = await generateStructured<ResearchRoundOutput>({
      systemPrompt: RESEARCH_AGENT_SYSTEM,
      userPrompt: researchAgentUser(
        question.question,
        question.category,
        rounds,
        maxRounds - round
      ),
      schema: researchRoundSchema,
      maxTokens: 4096,
    });

    findings = assessment.findings?.trim() || findings;
    sources = mergeSources(
      sources,
      keepOnlyRetrievedSources(assessment.sources ?? [], rounds)
    );

    reachedSufficiency = Boolean(assessment.sufficient);

    const nextQuery = assessment.next_query?.trim() ?? "";
    const alreadySearched = rounds.some(
      (r) => r.query.toLowerCase() === nextQuery.toLowerCase()
    );

    // Stop when the agent is satisfied, when it has no distinct next query to
    // try, or when the cap is reached. A repeated query would just burn a round
    // and a search credit on identical results.
    if (reachedSufficiency || !nextQuery || alreadySearched || round === maxRounds) {
      break;
    }

    onEvent({
      type: "insufficient",
      questionId: question.id,
      round,
      reason: assessment.gap?.trim() || "Evidence was too thin to answer the question.",
    });
    query = nextQuery;
  }

  const { confidence } = deriveConfidence(sources, { reachedSufficiency });

  const result: ResearchResult = {
    questionId: question.id,
    question: question.question,
    category: question.category,
    findings: findings || "The searches returned nothing that answers this question.",
    sources,
    confidence,
    roundsUsed,
    reachedSufficiency,
  };

  onEvent({ type: "done", questionId: question.id, result });
  return result;
}

/**
 * Runs the research agents with a hard ceiling on how many are in flight at
 * once. Extra questions wait in the queue and start as slots free up, so
 * approving 12 questions with a cap of 5 runs 5 at a time rather than opening
 * 12 concurrent search + model calls.
 */
export async function researchAll(
  questions: Question[],
  concurrency: number,
  onEvent: (event: ResearchEvent) => void
): Promise<ResearchResult[]> {
  const results = new Array<ResearchResult | null>(questions.length).fill(null);
  let cursor = 0;

  for (const question of questions) {
    onEvent({ type: "queued", questionId: question.id });
  }

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= questions.length) return;
      const question = questions[index];
      try {
        results[index] = await researchQuestion(question, onEvent);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Research failed.";
        onEvent({ type: "error", questionId: question.id, message });
        // One agent failing must not sink the run — the report stage can work
        // with a partial set, and an unresearched question is a valid input to
        // it. Record the failure and carry on.
        results[index] = {
          questionId: question.id,
          question: question.question,
          category: question.category,
          findings: `Research failed for this question: ${message}`,
          sources: [],
          confidence: "unresearched",
          roundsUsed: 0,
          reachedSufficiency: false,
        };
      }
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, questions.length)) },
    () => worker()
  );
  await Promise.all(workers);

  return results.filter((r): r is ResearchResult => r !== null);
}
