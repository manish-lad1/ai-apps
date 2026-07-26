import { generateStructured } from "@/lib/llm-provider";
import { REPORT_CRITIC_SYSTEM, reportCriticUser } from "@/lib/prompts";
import { critiqueSchema } from "@/lib/schemas";
import type { Critique, Report, ResearchResult } from "@/lib/types";

/**
 * Stage 3, critic half. Asymmetric by design: this is a reviewer, not a peer.
 *
 * It never writes an alternative report and never negotiates with the
 * generator — it applies a flaw-based rubric and either approves the draft or
 * sends back specific objections. Two agents free to rewrite each other's work
 * converge on a compromise; a reviewer with a rubric produces findings you can
 * check. That asymmetry is the whole reason the loop improves anything.
 *
 * It also sees the raw Stage 2 research, not just the report, so it can catch
 * the failure mode that matters most here: a claim that reads well but that
 * nothing in the research supports.
 */

export async function critiqueReport(
  idea: string,
  results: ResearchResult[],
  report: Report,
  round: number
): Promise<Critique> {
  const critique = await generateStructured<Critique>({
    systemPrompt: REPORT_CRITIC_SYSTEM,
    userPrompt: reportCriticUser(idea, results, report, round),
    schema: critiqueSchema,
    maxTokens: 4096,
  });

  const findings = critique.findings ?? [];

  // A critic that lists substantive flaws and approves anyway has produced an
  // internally inconsistent review — and smaller local models do exactly this,
  // returning approved=true alongside four findings. The rubric says only
  // low-severity nits are compatible with approval, so enforce that here
  // rather than hoping the model holds both halves in mind at once.
  const blocking = findings.filter(
    (f) => f.severity === "high" || f.severity === "medium"
  );
  const approved = Boolean(critique.approved) && blocking.length === 0;

  if (critique.approved && blocking.length > 0) {
    console.warn(
      `[report-critic] Model approved a report carrying ${blocking.length} high/medium finding(s); overriding to not-approved.`
    );
  }

  return { ...critique, approved, findings };
}
