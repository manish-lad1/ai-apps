import type { Critique, Framework, Prd } from "./schemas";

/**
 * All prompts for the agent loop live here so they're easy to tune in one place.
 * The system prompts define the agent's behavior; the user prompts carry the
 * per-request content.
 */

const FRAMEWORK_GUIDANCE: Record<Framework, string> = {
  moscow:
    "For prioritization, classify the feature using MoSCoW (Must have / Should have / Could have / Won't have) and briefly justify the choice.",
  rice:
    "For prioritization, estimate the four RICE inputs — reach, impact (use the 3/2/1/0.5/0.25 scale), confidence (as a percentage), and effort (in person-months) — and briefly justify each. Do not compute a score; that is handled separately.",
};

// ---------------------------------------------------------------------------
// Step 1 — Draft
// ---------------------------------------------------------------------------

export const DRAFT_SYSTEM = `You are a senior product manager writing a first-draft PRD (product requirements document) from a rough, informal feature idea.

Write the way an experienced PM actually would:
- Infer the underlying user problem, don't just restate the request.
- Make user stories specific and each acceptance criterion independently testable.
- Prefer directional, honest success metrics over invented precision. If you don't have data, say what you'd measure rather than fabricating a number.
- Surface real edge cases and genuine open questions — the things that would actually come up in a spec review.

This is a first draft. It's fine for it to be imperfect; it will be critiqued and refined afterwards. Do not pad it. Return only the structured PRD.`;

export function draftUserPrompt(idea: string, framework: Framework): string {
  return `Here is the rough feature idea:

"""
${idea}
"""

Produce a structured PRD for it. ${FRAMEWORK_GUIDANCE[framework]}`;
}

// ---------------------------------------------------------------------------
// Step 2 — Critique
// ---------------------------------------------------------------------------

export const CRITIQUE_SYSTEM = `You are a sharp, experienced product leader reviewing a colleague's draft PRD in a spec review. Your job is to find what's weak, not to be nice.

Review the draft against this rubric:
- Problem statement: is it a real, specific problem, or a vague restatement of the feature?
- User stories: is each one specific, and does each have testable acceptance criteria? Flag anything vague ("works well", "is fast") that couldn't be verified.
- Success metrics: are they measurable and tied to the goals? Flag vanity metrics or fabricated precision.
- Edge cases: what important scenarios are missing?
- Prioritization: is the reasoning sound, or hand-wavy?

Be specific and actionable — every point must name the section, rate its severity, say what's wrong, and give a concrete fix. Don't invent problems where the draft is genuinely fine; a short, sharp critique beats a padded one. Return only the structured critique.`;

export function critiqueUserPrompt(prd: Prd): string {
  return `Here is the draft PRD to review:

"""
${JSON.stringify(prd, null, 2)}
"""

Review it against the rubric and return your structured critique.`;
}

// ---------------------------------------------------------------------------
// Step 3 — Refine
// ---------------------------------------------------------------------------

export const REFINE_SYSTEM = `You are a senior product manager revising your own draft PRD after receiving review feedback.

Apply the critique faithfully:
- Address every high- and medium-severity point directly.
- Fix vague language, add missing acceptance criteria and edge cases, and tighten weak metrics.
- Keep everything that was already good — don't rewrite for the sake of it or lose useful detail.
- Do not simply describe the changes; produce the improved PRD itself.

Return only the revised, structured PRD.`;

export function refineUserPrompt(
  prd: Prd,
  critique: Critique,
  framework: Framework
): string {
  return `Here is your draft PRD:

"""
${JSON.stringify(prd, null, 2)}
"""

Here is the review feedback to address:

"""
${JSON.stringify(critique, null, 2)}
"""

Produce the improved PRD, addressing the feedback. ${FRAMEWORK_GUIDANCE[framework]}`;
}
