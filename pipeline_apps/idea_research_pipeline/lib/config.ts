/**
 * Every tunable knob in the pipeline, read from the environment in exactly one
 * place. Nothing else in the app calls process.env for pipeline limits — that
 * keeps the defaults visible and stops them drifting apart across files.
 */

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    console.warn(`[config] ${name}="${raw}" is not a number. Using ${fallback}.`);
    return fallback;
  }
  if (parsed < min || parsed > max) {
    console.warn(
      `[config] ${name}=${parsed} is outside the supported range ${min}-${max}. Using ${fallback}.`
    );
    return fallback;
  }
  return parsed;
}

/**
 * How many Stage 2 research agents run at once. Anything beyond this queues
 * and backfills as slots free up — it is a concurrency cap, not a question cap.
 */
export function maxConcurrentResearchAgents(): number {
  return intFromEnv("MAX_CONCURRENT_RESEARCH_AGENTS", 5, 1, 20);
}

/**
 * Search rounds a single research agent may run before it must stop and report
 * what it has. Hitting this cap is a normal outcome, not an error — it usually
 * surfaces as `low` or `unresearched` confidence.
 */
export function maxResearchRoundsPerQuestion(): number {
  return intFromEnv("MAX_RESEARCH_ROUNDS_PER_QUESTION", 3, 1, 6);
}

/**
 * Report -> critique -> revise cycles before the loop gives up and escalates
 * to the user. It never silently auto-approves at the cap.
 */
export function maxReportRevisionRounds(): number {
  return intFromEnv("MAX_REPORT_REVISION_ROUNDS", 3, 1, 6);
}

/** Search results requested per query. More context costs more tokens. */
export const RESULTS_PER_SEARCH = 6;
