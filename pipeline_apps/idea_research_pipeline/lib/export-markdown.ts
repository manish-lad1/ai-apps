import type {
  CritiqueFinding,
  Report,
  ReportOutcome,
  ReportRound,
} from "./types";

/**
 * Renders the finished report as Markdown — the export format, and also the
 * text the in-app editor edits. Making the editable representation the same
 * thing as the exported one means what you see edited is exactly what you get
 * out; there's no second serialisation path to drift.
 */

const VERDICT_LABEL: Record<string, string> = {
  go: "GO",
  no_go: "NO-GO",
  go_narrower: "GO — NARROWER SCOPE",
};

function sourceList(sources: { claim: string; url: string }[]): string {
  if (sources.length === 0) return "_No sources._\n";
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const source of sources) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    lines.push(`- ${source.claim} — <${source.url}>`);
  }
  return `${lines.join("\n")}\n`;
}

export function reportToMarkdown(
  idea: string,
  report: Report,
  outcome: ReportOutcome,
  outstandingObjections: CritiqueFinding[]
): string {
  const parts: string[] = [];

  parts.push("# Idea Research Report\n");
  parts.push(`**Idea:** ${idea}\n`);

  if (outcome === "escalated") {
    parts.push(
      "> ⚠️ **Escalated — not approved by the review agent.**\n>\n" +
        "> The revision loop hit its round cap with objections still outstanding.\n" +
        "> They are listed at the end of this report. Read them before acting on\n" +
        "> the recommendation.\n"
    );
  }

  parts.push("## Summary\n");
  parts.push(`${report.summary}\n`);

  const verdict = report.overall_recommendation?.verdict ?? "go_narrower";
  parts.push("## Recommendation\n");
  parts.push(`**${VERDICT_LABEL[verdict] ?? verdict.toUpperCase()}**\n`);
  parts.push(`${report.overall_recommendation?.rationale ?? ""}\n`);

  if (report.open_contradictions?.length) {
    parts.push("## ⚠️ Open contradictions\n");
    parts.push(
      "_Genuine disagreements between findings. Left unresolved on purpose — " +
        "smoothing them over would hide a real signal._\n"
    );
    report.open_contradictions.forEach((contradiction, i) => {
      const ids = contradiction.question_ids?.length
        ? ` _(${contradiction.question_ids.join(", ")})_`
        : "";
      // A numbered heading rather than the summary text: the schema asks for
      // one sentence, but models routinely return a paragraph, and a paragraph
      // as an H3 renders badly everywhere Markdown is read.
      parts.push(`### Contradiction ${i + 1}${ids}\n`);
      parts.push(`**${contradiction.summary}**\n`);
      parts.push(`${contradiction.detail}\n`);
    });
  }

  parts.push("## Findings by question\n");
  for (const entry of report.per_question_reports ?? []) {
    parts.push(
      `### ${entry.question}\n\n` +
        `\`${entry.category}\` · confidence: **${entry.confidence}**\n`
    );
    parts.push(`${entry.summary}\n`);
  }

  parts.push("## Sources\n");
  parts.push(sourceList(report.sources ?? []));

  if (outcome === "escalated" && outstandingObjections.length > 0) {
    parts.push("## Outstanding reviewer objections\n");
    parts.push(
      "_The review agent raised these and they were not resolved within the " +
        "revision cap._\n"
    );
    for (const finding of outstandingObjections) {
      parts.push(
        `- **[${finding.severity}] ${finding.flaw_type.replace(/_/g, " ")}** — ` +
          `${finding.detail}\n  - Suggested fix: ${finding.suggested_fix}`
      );
    }
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * The round-by-round history, exported separately. It is the record of how the
 * report got here — which objections were raised and what changed in response.
 */
export function historyToMarkdown(rounds: ReportRound[]): string {
  const parts: string[] = ["# Report revision history\n"];

  for (const round of rounds) {
    parts.push(`## Round ${round.round}\n`);
    parts.push("### Draft summary\n");
    parts.push(`${round.report.summary}\n`);
    parts.push(
      `**Verdict:** ${round.report.overall_recommendation?.verdict ?? "—"}\n`
    );

    if (!round.critique) {
      parts.push("_No critique recorded for this round._\n");
      continue;
    }

    parts.push(
      `### Critique — ${round.critique.approved ? "APPROVED" : "CHANGES REQUESTED"}\n`
    );
    parts.push(`${round.critique.overall_assessment}\n`);

    if (round.critique.findings.length > 0) {
      for (const finding of round.critique.findings) {
        parts.push(
          `- **[${finding.severity}] ${finding.flaw_type.replace(/_/g, " ")}** — ` +
            `${finding.detail}\n  - Suggested fix: ${finding.suggested_fix}`
        );
      }
      parts.push("");
    }
  }

  return parts.join("\n");
}

/** Triggers a client-side download without a round trip to the server. */
export function downloadMarkdown(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
