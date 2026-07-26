/**
 * Shared wire types. Everything that crosses the client/server boundary — or
 * moves between pipeline stages — is defined here so there's one definition
 * per concept rather than one per file.
 */

// ---------------------------------------------------------------------------
// Stage 1 — questions
// ---------------------------------------------------------------------------

/**
 * The four default research categories. The question-generating agent may
 * invent a fifth if an idea genuinely warrants one, so `category` is typed as
 * a plain string — these are the defaults, not an exhaustive enum.
 */
export const DEFAULT_CATEGORIES = [
  "market_competitive",
  "technical_feasibility",
  "user_demand",
  "business_pricing",
] as const;

export type Question = {
  id: string;
  question: string;
  category: string;
};

/** Minimum approved questions before Stage 2 is allowed to fire. */
export const MIN_APPROVED_QUESTIONS = 3;

// ---------------------------------------------------------------------------
// Stage 2 — research
// ---------------------------------------------------------------------------

/**
 * Derived from the collected sources by a deterministic function — never
 * self-reported by the model. See lib/confidence.ts.
 */
export type Confidence = "high" | "medium" | "low" | "unresearched";

/**
 * Whether a source backs up the emerging answer or cuts against it. The model
 * labels each source it cites; the *confidence rule* over those labels is
 * deterministic code.
 */
export type Stance = "supports" | "contradicts";

export type Source = {
  claim: string;
  url: string;
  stance: Stance;
};

export type ResearchResult = {
  questionId: string;
  question: string;
  category: string;
  findings: string;
  sources: Source[];
  confidence: Confidence;
  roundsUsed: number;
  /**
   * True if the agent stopped because it judged the evidence enough, false if
   * it stopped because it ran out of rounds. A deterministic input to
   * confidence — see lib/confidence.ts.
   */
  reachedSufficiency: boolean;
};

/** Live status pushed to the UI as each research agent works. */
export type ResearchEvent =
  /** Emitted once, first, so the UI can show the real server-side cap. */
  | { type: "started"; concurrency: number; questionCount: number }
  | { type: "queued"; questionId: string }
  | { type: "round_start"; questionId: string; round: number }
  | { type: "searching"; questionId: string; round: number; query: string }
  | {
      type: "search_done";
      questionId: string;
      round: number;
      query: string;
      resultCount: number;
    }
  | { type: "assessing"; questionId: string; round: number }
  | { type: "insufficient"; questionId: string; round: number; reason: string }
  | { type: "done"; questionId: string; result: ResearchResult }
  | { type: "error"; questionId: string; message: string };

// ---------------------------------------------------------------------------
// Stage 3 — report + critique
// ---------------------------------------------------------------------------

export type Verdict = "go" | "no_go" | "go_narrower";

export type PerQuestionReport = {
  question_id: string;
  question: string;
  category: string;
  summary: string;
  confidence: Confidence;
};

/**
 * A genuine disagreement between two questions' findings — e.g. one implies a
 * crowded market and another implies no real competitor. Surfaced inline in
 * the report, never smoothed into confident prose.
 */
export type Contradiction = {
  summary: string;
  question_ids: string[];
  detail: string;
};

export type ReportSource = {
  claim: string;
  url: string;
};

export type Report = {
  summary: string;
  per_question_reports: PerQuestionReport[];
  open_contradictions: Contradiction[];
  overall_recommendation: {
    verdict: Verdict;
    rationale: string;
  };
  sources: ReportSource[];
};

export type CritiqueFinding = {
  flaw_type:
    | "unsupported_claim"
    | "unflagged_contradiction"
    | "weak_sourcing"
    | "ungrounded_recommendation";
  severity: "high" | "medium" | "low";
  detail: string;
  suggested_fix: string;
};

export type Critique = {
  approved: boolean;
  overall_assessment: string;
  findings: CritiqueFinding[];
};

/**
 * One trip around the generator/critic loop. Every round is persisted — the
 * draft AND the critique that came back — because the point of this project is
 * showing the loop, not just its output.
 */
export type ReportRound = {
  round: number;
  report: Report;
  critique: Critique | null;
};

/** How the loop ended. `escalated` means the cap was hit without approval. */
export type ReportOutcome = "approved" | "escalated";

export type ReportEvent =
  | { type: "drafting"; round: number }
  | { type: "draft_done"; round: number; report: Report }
  | { type: "critiquing"; round: number }
  | { type: "critique_done"; round: number; critique: Critique }
  | {
      type: "complete";
      outcome: ReportOutcome;
      rounds: ReportRound[];
      finalReport: Report;
      /** Populated only when `outcome` is "escalated". */
      outstandingObjections: CritiqueFinding[];
    }
  | { type: "error"; message: string };
