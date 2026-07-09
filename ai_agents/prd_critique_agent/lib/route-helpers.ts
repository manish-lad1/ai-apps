import {
  computeRiceScore,
  type Framework,
  type Prd,
} from "./schemas";

/** Frameworks we accept from the client. */
export function isFramework(value: unknown): value is Framework {
  return value === "moscow" || value === "rice";
}

/**
 * After the model returns a PRD, if it's a RICE priority we (re)compute the
 * score ourselves so the arithmetic is always correct and never the model's job.
 */
export function withComputedScore(prd: Prd): Prd {
  if (prd.priority.framework === "rice") {
    prd.priority.score = computeRiceScore(prd.priority);
  }
  return prd;
}

/** Turn any thrown value into a clean message for the client. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected error.";
}
