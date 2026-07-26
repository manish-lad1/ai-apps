import { generateStructured } from "@/lib/llm-provider";
import {
  REPORT_GENERATOR_SYSTEM,
  reportGeneratorUser,
  reportRevisionUser,
} from "@/lib/prompts";
import { reportSchema } from "@/lib/schemas";
import type { Critique, Report, ResearchResult } from "@/lib/types";

/**
 * Stage 3, generator half. Reads every Stage 2 output at once — the first and
 * only point in the pipeline with a whole-picture view — and writes the report.
 *
 * It is the same agent on the first pass and every revision; only the prompt
 * differs. Keeping one generator across rounds is what makes the loop a
 * revision loop rather than a series of unrelated drafts.
 */

export async function generateReport(
  idea: string,
  results: ResearchResult[]
): Promise<Report> {
  const report = await generateStructured<Report>({
    systemPrompt: REPORT_GENERATOR_SYSTEM,
    userPrompt: reportGeneratorUser(idea, results),
    schema: reportSchema,
    maxTokens: 8192,
  });

  return reconcileReport(report, results);
}

export async function reviseReport(
  idea: string,
  results: ResearchResult[],
  previousReport: Report,
  critique: Critique
): Promise<Report> {
  const report = await generateStructured<Report>({
    systemPrompt: REPORT_GENERATOR_SYSTEM,
    userPrompt: reportRevisionUser(idea, results, previousReport, critique),
    schema: reportSchema,
    maxTokens: 8192,
  });

  return reconcileReport(report, results);
}

/**
 * Repairs the parts of the report that are facts rather than judgements.
 *
 * The model is asked to copy each question's confidence verbatim, but a value
 * we already computed shouldn't depend on the model remembering to copy it —
 * so confidence, question text, and category are overwritten from the Stage 2
 * results here. Same reasoning as recomputing an arithmetic score in code
 * instead of trusting the model to do the sum.
 *
 * This also drops references to question ids that don't exist and re-adds any
 * question the model silently skipped, so a report can never quietly cover
 * fewer questions than were researched.
 */
function reconcileReport(report: Report, results: ResearchResult[]): Report {
  const byId = new Map(results.map((r) => [r.questionId, r]));

  const reconciled = (report.per_question_reports ?? [])
    .filter((entry) => byId.has(entry.question_id))
    .map((entry) => {
      const source = byId.get(entry.question_id)!;
      return {
        ...entry,
        question: source.question,
        category: source.category,
        // Computed in lib/confidence.ts — not the model's to re-rate.
        confidence: source.confidence,
      };
    });

  const covered = new Set(reconciled.map((entry) => entry.question_id));
  for (const result of results) {
    if (covered.has(result.questionId)) continue;
    console.warn(
      `[report-generator] Report omitted question ${result.questionId}; re-adding it.`
    );
    reconciled.push({
      question_id: result.questionId,
      question: result.question,
      category: result.category,
      summary: result.findings,
      confidence: result.confidence,
    });
  }

  // Keep the researched order so the report reads in the order questions were
  // approved, regardless of what order the model emitted them in.
  const order = new Map(results.map((r, i) => [r.questionId, i]));
  reconciled.sort(
    (a, b) => (order.get(a.question_id) ?? 0) - (order.get(b.question_id) ?? 0)
  );

  const contradictions = (report.open_contradictions ?? []).map((c) => ({
    ...c,
    question_ids: (c.question_ids ?? []).filter((id) => byId.has(id)),
  }));

  return {
    ...report,
    per_question_reports: reconciled,
    open_contradictions: contradictions,
  };
}
