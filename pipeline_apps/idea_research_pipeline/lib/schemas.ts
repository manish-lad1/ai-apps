import { DEFAULT_CATEGORIES } from "./types";

/**
 * JSON Schemas for every model call in the pipeline. Both providers read from
 * the same schema object, so there is one place to change a shape, not two.
 *
 * Two constraints shape everything here:
 *   - `additionalProperties: false` plus an explicit `required` on every object
 *     is mandatory for Claude's Structured Outputs.
 *   - Nesting stays at 2 levels. Deeper nesting measurably degrades reliability
 *     on local models, which is why (for example) contradictions carry a flat
 *     array of question ids rather than an array of question objects.
 *
 * IDs are deliberately NOT in any schema — they're assigned in code. Asking a
 * model to invent and then consistently reuse identifiers is a reliable way to
 * get collisions and dangling references.
 */

/** Category is open-ended: the agent may add one the four defaults don't cover. */
const categoryProperty = {
  type: "string",
  description: `The research category. Prefer one of: ${DEFAULT_CATEGORIES.join(
    ", "
  )}. Invent a new snake_case category only if the idea genuinely needs one none of those cover.`,
};

// ---------------------------------------------------------------------------
// Stage 1 — question generation
// ---------------------------------------------------------------------------

export const questionsSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      description:
        "Between 5 and 12 research questions, scaled to how complex the idea actually is.",
      items: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "A single, specific, searchable research question. Not a topic — a question with a findable answer.",
          },
          category: categoryProperty,
        },
        required: ["question", "category"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
} as const satisfies Record<string, unknown>;

/**
 * Used when the human adds their own question at the approval gate — the app
 * infers the category rather than making the user pick one, reusing the same
 * categorisation logic Stage 1 applies.
 */
export const categorizeSchema = {
  type: "object",
  properties: {
    category: categoryProperty,
  },
  required: ["category"],
  additionalProperties: false,
} as const satisfies Record<string, unknown>;

// ---------------------------------------------------------------------------
// Stage 2 — research (one call per search round)
// ---------------------------------------------------------------------------

export const researchRoundSchema = {
  type: "object",
  properties: {
    sufficient: {
      type: "boolean",
      description:
        "True if the evidence gathered so far actually answers the question. False if it is still thin, tangential, or missing a key piece.",
    },
    gap: {
      type: "string",
      description:
        "If not sufficient: what specifically is still missing. Empty string if sufficient.",
    },
    next_query: {
      type: "string",
      description:
        "If not sufficient: the next web search query to run, targeting the gap. Must differ from previous queries. Empty string if sufficient.",
    },
    findings: {
      type: "string",
      description:
        "What the evidence shows, in a few sentences. Only claims the retrieved sources support. Say so plainly if the sources do not answer the question.",
    },
    sources: {
      type: "array",
      description:
        "One entry per source actually used. Only URLs that appeared in the supplied search results.",
      items: {
        type: "object",
        properties: {
          claim: {
            type: "string",
            description: "The specific claim this source supports or disputes.",
          },
          url: {
            type: "string",
            description: "The source's full URL, copied exactly from the search results.",
          },
          stance: {
            type: "string",
            enum: ["supports", "contradicts"],
            description:
              "'supports' if the source backs the answer in findings; 'contradicts' if it cuts against it. Label honestly — a disagreement between sources is a real result, not a problem to hide.",
          },
        },
        required: ["claim", "url", "stance"],
        additionalProperties: false,
      },
    },
  },
  required: ["sufficient", "gap", "next_query", "findings", "sources"],
  additionalProperties: false,
} as const satisfies Record<string, unknown>;

// ---------------------------------------------------------------------------
// Stage 3 — report generation
// ---------------------------------------------------------------------------

export const reportSchema = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "An executive summary of what the research found, in a short paragraph or two.",
    },
    per_question_reports: {
      type: "array",
      description: "One entry per researched question, in the order supplied.",
      items: {
        type: "object",
        properties: {
          question_id: {
            type: "string",
            description: "The exact id supplied with the question. Copy it verbatim.",
          },
          question: { type: "string" },
          category: { type: "string" },
          summary: {
            type: "string",
            description: "What the research established for this question.",
          },
          confidence: {
            type: "string",
            enum: ["high", "medium", "low", "unresearched"],
            description:
              "Copy the supplied confidence verbatim. It is computed from the sources — do not re-rate it.",
          },
        },
        required: ["question_id", "question", "category", "summary", "confidence"],
        additionalProperties: false,
      },
    },
    open_contradictions: {
      type: "array",
      description:
        "Genuine disagreements ACROSS questions — where one question's findings imply something another question's findings contradict (e.g. one says the market is crowded, another says there is no real competitor). Empty array if there are none. Never resolve a real contradiction by picking a side or softening the language.",
      items: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "The contradiction in one sentence.",
          },
          question_ids: {
            type: "array",
            description: "The ids of the questions whose findings conflict.",
            items: { type: "string" },
          },
          detail: {
            type: "string",
            description:
              "What each side found, and what it would take to settle it.",
          },
        },
        required: ["summary", "question_ids", "detail"],
        additionalProperties: false,
      },
    },
    overall_recommendation: {
      type: "object",
      properties: {
        verdict: {
          type: "string",
          enum: ["go", "no_go", "go_narrower"],
          description:
            "Take a real position. 'go_narrower' means worth building, but for a narrower scope or segment than proposed.",
        },
        rationale: {
          type: "string",
          description:
            "Why, citing specific findings. Not a neutral restatement of the summary — an argument for this verdict.",
        },
      },
      required: ["verdict", "rationale"],
      additionalProperties: false,
    },
    sources: {
      type: "array",
      description: "Every source cited anywhere in the report, deduplicated.",
      items: {
        type: "object",
        properties: {
          claim: { type: "string" },
          url: { type: "string" },
        },
        required: ["claim", "url"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "summary",
    "per_question_reports",
    "open_contradictions",
    "overall_recommendation",
    "sources",
  ],
  additionalProperties: false,
} as const satisfies Record<string, unknown>;

// ---------------------------------------------------------------------------
// Stage 3 — critique
// ---------------------------------------------------------------------------

export const critiqueSchema = {
  type: "object",
  properties: {
    approved: {
      type: "boolean",
      description:
        "True only if the report clears every rubric item. A report with any high-severity finding is not approved.",
    },
    overall_assessment: {
      type: "string",
      description: "One short paragraph on the report's overall quality.",
    },
    findings: {
      type: "array",
      description:
        "Specific, actionable flaws. Empty array if the report genuinely has none — do not invent nits to look thorough.",
      items: {
        type: "object",
        properties: {
          flaw_type: {
            type: "string",
            enum: [
              "unsupported_claim",
              "unflagged_contradiction",
              "weak_sourcing",
              "ungrounded_recommendation",
            ],
          },
          severity: {
            type: "string",
            enum: ["high", "medium", "low"],
          },
          detail: {
            type: "string",
            description: "What is wrong, quoting the offending text where possible.",
          },
          suggested_fix: {
            type: "string",
            description: "What the report agent should change to resolve it.",
          },
        },
        required: ["flaw_type", "severity", "detail", "suggested_fix"],
        additionalProperties: false,
      },
    },
  },
  required: ["approved", "overall_assessment", "findings"],
  additionalProperties: false,
} as const satisfies Record<string, unknown>;
