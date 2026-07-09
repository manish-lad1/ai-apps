/**
 * Single source of truth for the shapes the agent produces.
 *
 * Two artifacts flow through the loop:
 *   - PRD:      produced by the Draft step, and again (improved) by Refine.
 *   - Critique: produced by the Critique step, reviewing a draft PRD.
 *
 * The PRD schema is built dynamically per request so that each call to the
 * model contains only ONE priority shape (MoSCoW or RICE) — never a union.
 * Simpler schemas are more reliable, especially for a local model.
 */

// ---------------------------------------------------------------------------
// Prioritization framework
// ---------------------------------------------------------------------------

export type Framework = "moscow" | "rice";

export type MoscowLevel =
  | "must_have"
  | "should_have"
  | "could_have"
  | "wont_have";

export type MoscowPriority = {
  framework: "moscow";
  level: MoscowLevel;
  rationale: string;
};

export type RicePriority = {
  framework: "rice";
  reach: number;
  impact: number;
  confidence: number;
  effort: number;
  /** Computed in code, NOT by the model: (reach * impact * confidence/100) / effort */
  score: number;
  rationale: string;
};

export type Priority = MoscowPriority | RicePriority;

// ---------------------------------------------------------------------------
// PRD
// ---------------------------------------------------------------------------

export type UserStory = {
  persona: string;
  story: string;
  acceptance_criteria: string[];
};

export type Prd = {
  title: string;
  problem_statement: string;
  goals: string[];
  success_metrics: string[];
  user_stories: UserStory[];
  edge_cases: string[];
  open_questions: string[];
  priority: Priority;
};

// ---------------------------------------------------------------------------
// Critique
// ---------------------------------------------------------------------------

export type CritiquePoint = {
  /** Which part of the PRD this refers to, e.g. "user_stories", "success_metrics". */
  section: string;
  /** Severity so the UI (and the Refine step) can prioritize. */
  severity: "high" | "medium" | "low";
  /** What's wrong or missing. */
  issue: string;
  /** A concrete, actionable suggestion for fixing it. */
  suggestion: string;
};

export type Critique = {
  /** One-line overall read on the draft's quality. */
  summary: string;
  points: CritiquePoint[];
};

// ---------------------------------------------------------------------------
// JSON Schemas (for the model's structured-output constraint)
// ---------------------------------------------------------------------------

const userStorySchema = {
  type: "object",
  properties: {
    persona: { type: "string", description: 'The "As a [role]" part.' },
    story: {
      type: "string",
      description: 'The "I want [capability] so that [benefit]" part.',
    },
    acceptance_criteria: {
      type: "array",
      items: { type: "string" },
      description: "Specific, testable conditions that must be true to consider this story done.",
    },
  },
  required: ["persona", "story", "acceptance_criteria"],
  additionalProperties: false,
};

const moscowPrioritySchema = {
  type: "object",
  properties: {
    framework: { type: "string", enum: ["moscow"] },
    level: {
      type: "string",
      enum: ["must_have", "should_have", "could_have", "wont_have"],
      description: "MoSCoW classification for this feature.",
    },
    rationale: {
      type: "string",
      description: "Why this feature belongs in that MoSCoW category.",
    },
  },
  required: ["framework", "level", "rationale"],
  additionalProperties: false,
};

// Note: `score` is intentionally omitted here — the model estimates the four
// inputs; our code computes and attaches the score afterwards.
const ricePrioritySchema = {
  type: "object",
  properties: {
    framework: { type: "string", enum: ["rice"] },
    reach: {
      type: "number",
      description: "How many people/events this affects per time period (e.g. per quarter).",
    },
    impact: {
      type: "number",
      description: "Per-person impact. Use the standard RICE scale: 3=massive, 2=high, 1=medium, 0.5=low, 0.25=minimal.",
    },
    confidence: {
      type: "number",
      description: "Confidence in the reach/impact estimates, as a percentage from 0 to 100.",
    },
    effort: {
      type: "number",
      description: "Estimated effort in person-months.",
    },
    rationale: {
      type: "string",
      description: "Brief reasoning behind the reach, impact, confidence, and effort estimates.",
    },
  },
  required: ["framework", "reach", "impact", "confidence", "effort", "rationale"],
  additionalProperties: false,
};

/**
 * Build the PRD JSON Schema for a given framework choice.
 * Each returned schema contains exactly one priority shape.
 */
export function buildPrdSchema(framework: Framework): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      title: { type: "string", description: "Short, clear name for the feature." },
      problem_statement: {
        type: "string",
        description: "The problem this solves — what is broken, missing, or painful today, and for whom.",
      },
      goals: {
        type: "array",
        items: { type: "string" },
        description: "Qualitative outcomes that define success.",
      },
      success_metrics: {
        type: "array",
        items: { type: "string" },
        description: "Measurable signals that the goals are met. Prefer directional targets over invented precision.",
      },
      user_stories: {
        type: "array",
        items: userStorySchema,
        description: "The core user stories, each with testable acceptance criteria.",
      },
      edge_cases: {
        type: "array",
        items: { type: "string" },
        description: "Scenarios that could break the feature or need explicit handling.",
      },
      open_questions: {
        type: "array",
        items: { type: "string" },
        description: "Unknowns or decisions to resolve before or during the build.",
      },
      priority: framework === "moscow" ? moscowPrioritySchema : ricePrioritySchema,
    },
    required: [
      "title",
      "problem_statement",
      "goals",
      "success_metrics",
      "user_stories",
      "edge_cases",
      "open_questions",
      "priority",
    ],
    additionalProperties: false,
  };
}

export const critiqueSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "One-line overall assessment of the draft PRD's quality.",
    },
    points: {
      type: "array",
      items: {
        type: "object",
        properties: {
          section: {
            type: "string",
            description: "Which PRD section this point is about (e.g. 'user_stories', 'success_metrics').",
          },
          severity: {
            type: "string",
            enum: ["high", "medium", "low"],
          },
          issue: { type: "string", description: "What is wrong, vague, or missing." },
          suggestion: {
            type: "string",
            description: "A concrete, actionable fix.",
          },
        },
        required: ["section", "severity", "issue", "suggestion"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "points"],
  additionalProperties: false,
};

/** Compute the RICE score deterministically in code. */
export function computeRiceScore(p: {
  reach: number;
  impact: number;
  confidence: number;
  effort: number;
}): number {
  if (!p.effort) return 0;
  const raw = (p.reach * p.impact * (p.confidence / 100)) / p.effort;
  return Math.round(raw * 100) / 100;
}
