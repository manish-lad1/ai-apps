/**
 * Cheap, model-agnostic guardrails against degenerate LLM output.
 *
 * Eval testing surfaced two real failure modes, both independent of which
 * model caused them:
 *   1. A token-repetition loop — the same short chunk repeated back-to-back
 *      many times (e.g. "thought_process_content-thought_process_content-...").
 *   2. Near-duplicate list entries — the same user story or point generated
 *      over and over inside an array, padding the output with copies.
 *
 * Neither is a JSON-validity problem (both can still be perfectly parseable
 * JSON), so schema validation alone won't catch them. This module runs after
 * parsing and lets the caller retry once before giving up.
 */

/**
 * Detects a substring (20-300 chars) that repeats immediately, 4+ times in a
 * row, with no other content in between. Legitimate PRD content never does
 * this — repeated phrases like "Acceptance criteria" always have differing
 * content around them. The upper bound is wide enough to catch a whole
 * duplicated story block (observed repeat units up to ~180 chars in testing),
 * and the scan is capped to keep the regex fast on bounded model output.
 */
export function hasRepeatedSubstringLoop(text: string): boolean {
  const sample = text.slice(0, 50_000);
  // [\s\S] matches any character including newlines, without needing the
  // dotAll ("s") flag — kept for compatibility with this project's TS target.
  const loopPattern = /([\s\S]{20,300}?)\1{3,}/;
  return loopPattern.test(sample);
}

/**
 * Recursively walks parsed JSON looking for arrays where the same entry
 * (by deep value) appears more than `maxDuplicates` times — the signature of
 * a runaway generation loop padding an array with copies of the same item.
 */
export function hasDuplicateEntries(
  value: unknown,
  maxDuplicates = 2
): boolean {
  if (Array.isArray(value)) {
    const seen = new Map<string, number>();
    for (const item of value) {
      const key = typeof item === "string" ? item : JSON.stringify(item);
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count > maxDuplicates) return true;
    }
    return value.some((item) => hasDuplicateEntries(item, maxDuplicates));
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((v) =>
      hasDuplicateEntries(v, maxDuplicates)
    );
  }
  return false;
}

/** True if the raw text or the parsed structure shows signs of degeneration. */
export function isDegenerate(rawText: string, parsed: unknown): boolean {
  return hasRepeatedSubstringLoop(rawText) || hasDuplicateEntries(parsed);
}
