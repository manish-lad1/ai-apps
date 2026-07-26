import type { Confidence, Source } from "./types";

/**
 * Confidence is DERIVED, never self-reported.
 *
 * Asking a model "how confident are you?" produces a number that tracks the
 * model's prose fluency, not its evidence. So the model's only job here is to
 * report checkable facts about each source it used — the URL, the claim it
 * supports, and whether it agrees or disagrees with the emerging answer. This
 * function then applies a fixed rule over those facts. Same sources always
 * give the same confidence, and you can audit the rule without re-running
 * anything.
 */

/**
 * Corroboration is counted per DOMAIN, not per URL. Three pages from one site
 * are one outlet repeating itself — treating them as three independent
 * confirmations is exactly how a single press release becomes "high
 * confidence".
 */
function domainOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Drops anything without a real, fetchable http(s) URL behind it. */
export function usableSources(sources: Source[]): Source[] {
  return sources.filter((s) => domainOf(s.url) !== null);
}

export type ConfidenceBreakdown = {
  confidence: Confidence;
  supportingDomains: number;
  contradictingDomains: number;
  usableSourceCount: number;
  /** Plain-English statement of which rule fired, shown in the UI. */
  reason: string;
};

export type ConfidenceInputs = {
  /**
   * Whether the agent ended by deciding it could answer the question, or by
   * running out of search rounds.
   *
   * This matters more than it looks. Counting corroborating domains alone
   * answers "do these sources agree?" — not "do these sources answer the
   * question?". An agent can retrieve three reputable sources that all discuss
   * the topic, agree with each other, and still never address what was asked.
   * Without this input that scores `high` while the findings literally read
   * "the sources do not contain this information", which is the exact
   * overconfidence the derived-confidence design exists to prevent.
   */
  reachedSufficiency: boolean;
};

export function deriveConfidence(
  sources: Source[],
  { reachedSufficiency }: ConfidenceInputs = { reachedSufficiency: true }
): ConfidenceBreakdown {
  const usable = usableSources(sources);

  const supporting = new Set<string>();
  const contradicting = new Set<string>();
  for (const source of usable) {
    const domain = domainOf(source.url);
    if (!domain) continue;
    if (source.stance === "contradicts") contradicting.add(domain);
    else supporting.add(domain);
  }

  const supportingDomains = supporting.size;
  const contradictingDomains = contradicting.size;
  const base = {
    supportingDomains,
    contradictingDomains,
    usableSourceCount: usable.length,
  };

  if (usable.length === 0) {
    return {
      ...base,
      confidence: "unresearched",
      reason: "No usable sources after the maximum number of search rounds.",
    };
  }

  // The agent searched to its round cap and still couldn't answer the
  // question. Whatever it retrieved along the way, the question is unresolved
  // — so it cannot be better than `low`, regardless of how many sources agree
  // with each other about something adjacent.
  if (!reachedSufficiency) {
    return {
      ...base,
      confidence: "low",
      reason: `The agent used every available search round without establishing an answer (${usable.length} source(s) retrieved, none of them settling the question).`,
    };
  }

  const hasDisagreement = contradictingDomains > 0;

  if (supportingDomains >= 3 && !hasDisagreement) {
    return {
      ...base,
      confidence: "high",
      reason: `${supportingDomains} independent domains agree, with no source contradicting them.`,
    };
  }

  if (supportingDomains >= 3 && hasDisagreement) {
    return {
      ...base,
      confidence: "medium",
      reason: `${supportingDomains} independent domains agree, but ${contradictingDomains} ${
        contradictingDomains === 1 ? "contradicts" : "contradict"
      } them — partial agreement.`,
    };
  }

  if (supportingDomains === 2 && !hasDisagreement) {
    return {
      ...base,
      confidence: "medium",
      reason: "2 independent domains agree — corroborated, but thinly.",
    };
  }

  if (hasDisagreement) {
    return {
      ...base,
      confidence: "low",
      reason: `Sources disagree and the disagreement is unresolved (${supportingDomains} supporting vs ${contradictingDomains} contradicting).`,
    };
  }

  return {
    ...base,
    confidence: "low",
    reason: "Only 1 source domain — uncorroborated.",
  };
}
