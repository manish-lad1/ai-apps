"use client";

import { useState } from "react";
import ConfidenceBadge from "./ConfidenceBadge";
import {
  downloadMarkdown,
  historyToMarkdown,
  reportToMarkdown,
} from "@/lib/export-markdown";
import type {
  CritiqueFinding,
  Report,
  ReportOutcome,
  ReportRound,
} from "@/lib/types";

const VERDICT: Record<string, { label: string; className: string }> = {
  go: { label: "GO", className: "bg-conf-high-bg text-conf-high" },
  no_go: { label: "NO-GO", className: "bg-conf-low-bg text-conf-low" },
  go_narrower: {
    label: "GO — NARROWER SCOPE",
    className: "bg-conf-medium-bg text-conf-medium",
  },
};

const SEVERITY: Record<string, string> = {
  high: "bg-conf-low-bg text-sev-high",
  medium: "bg-conf-medium-bg text-sev-med",
  low: "bg-conf-none-bg text-sev-low",
};

export default function ReportView({
  idea,
  report,
  outcome,
  outstandingObjections,
  rounds,
}: {
  idea: string;
  report: Report;
  outcome: ReportOutcome;
  outstandingObjections: CritiqueFinding[];
  rounds: ReportRound[];
}) {
  const [editing, setEditing] = useState(false);
  const [markdown, setMarkdown] = useState(() =>
    reportToMarkdown(idea, report, outcome, outstandingObjections)
  );
  const [showHistory, setShowHistory] = useState(false);

  // Note: the caller remounts this component (via a `key`) whenever a new
  // report is generated, which resets the editor. Syncing that with an effect
  // instead would mean a render pass with stale edits still on screen.

  const verdict =
    VERDICT[report.overall_recommendation?.verdict ?? ""] ?? VERDICT.go_narrower;

  return (
    <div className="flex flex-col gap-5">
      {/* escalation banner — the loop ran out of rounds without approval */}
      {outcome === "escalated" && (
        <div className="rounded-lg border border-sev-high/30 bg-conf-low-bg px-4 py-3">
          <p className="label text-sev-high">Escalated — not approved</p>
          <p className="mt-1.5 text-sm text-ink-soft">
            The revision loop hit its round cap with objections still
            outstanding. The report is below, but it was not signed off — the
            reviewer&apos;s remaining objections are listed at the end. Nothing is
            auto-approved here; this is your call to make.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setEditing((e) => !e)}
          className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-report-bg"
        >
          {editing ? "Done editing" : "Edit report"}
        </button>
        <button
          type="button"
          onClick={() => downloadMarkdown("idea-research-report.md", markdown)}
          className="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          Export Markdown
        </button>
        {rounds.length > 0 && (
          <button
            type="button"
            onClick={() =>
              downloadMarkdown(
                "idea-research-revision-history.md",
                historyToMarkdown(rounds)
              )
            }
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-soft transition-colors hover:bg-report-bg"
          >
            Export revision history
          </button>
        )}
      </div>

      {editing ? (
        <>
          <p className="label text-muted">
            Editing the Markdown — this is exactly what Export writes out.
          </p>
          <textarea
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            rows={28}
            aria-label="Report markdown"
            className="w-full resize-y rounded-lg border border-line bg-card px-3.5 py-3 font-mono text-xs leading-relaxed text-ink outline-none focus:border-line-strong"
          />
        </>
      ) : (
        <article className="flex flex-col gap-6">
          <section>
            <p className="label text-muted">Summary</p>
            <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
              {report.summary}
            </p>
          </section>

          <section>
            <p className="label text-muted">Recommendation</p>
            <p
              className={`label mt-1.5 inline-block rounded px-2 py-1 ${verdict.className}`}
            >
              {verdict.label}
            </p>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
              {report.overall_recommendation?.rationale}
            </p>
          </section>

          {/* contradictions are called out inline, not hidden in an appendix */}
          {report.open_contradictions?.length > 0 && (
            <section>
              <p className="label text-sev-high">
                Open contradictions ({report.open_contradictions.length})
              </p>
              <div className="mt-2 flex flex-col gap-2">
                {report.open_contradictions.map((contradiction, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-sev-high/30 bg-conf-low-bg px-3 py-2.5"
                  >
                    <p className="text-sm font-medium text-ink">
                      {contradiction.summary}
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-ink-soft">
                      {contradiction.detail}
                    </p>
                    {contradiction.question_ids?.length > 0 && (
                      <p className="label mt-1.5 text-sev-high">
                        {contradiction.question_ids.join(" · ")}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <p className="label text-muted">Findings by question</p>
            <div className="mt-2 flex flex-col gap-3">
              {report.per_question_reports?.map((entry) => (
                <div
                  key={entry.question_id}
                  className="rounded-lg border border-line bg-card p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <ConfidenceBadge confidence={entry.confidence} />
                    <span className="label text-muted">
                      {entry.category.replace(/_/g, " ")}
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm font-medium text-ink">
                    {entry.question}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
                    {entry.summary}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {outcome === "escalated" && outstandingObjections.length > 0 && (
            <section>
              <p className="label text-sev-high">
                Outstanding reviewer objections ({outstandingObjections.length})
              </p>
              <div className="mt-2 flex flex-col gap-2">
                {outstandingObjections.map((finding, i) => (
                  <FindingCard key={i} finding={finding} />
                ))}
              </div>
            </section>
          )}

          {report.sources?.length > 0 && (
            <section>
              <p className="label text-muted">Sources ({report.sources.length})</p>
              <ul className="mt-2 flex flex-col gap-1">
                {report.sources.map((source, i) => (
                  <li key={`${source.url}-${i}`} className="text-xs text-ink-soft">
                    {source.claim}{" "}
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-report underline underline-offset-2"
                    >
                      {source.url}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </article>
      )}

      {/* every round's draft + the critique it drew */}
      {rounds.length > 0 && (
        <section className="border-t border-line pt-4">
          <button
            type="button"
            onClick={() => setShowHistory((s) => !s)}
            className="label flex items-center gap-2 text-muted transition-colors hover:text-ink"
          >
            <span>{showHistory ? "▾" : "▸"}</span>
            Revision history ({rounds.length}{" "}
            {rounds.length === 1 ? "round" : "rounds"})
          </button>

          {showHistory && (
            <div className="mt-3 flex flex-col gap-3">
              {rounds.map((round) => (
                <div
                  key={round.round}
                  className="rounded-lg border border-line bg-card p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="label text-report">Round {round.round}</span>
                    {round.critique && (
                      <span
                        className={[
                          "label rounded px-1.5 py-0.5",
                          round.critique.approved
                            ? "bg-conf-high-bg text-conf-high"
                            : "bg-conf-medium-bg text-conf-medium",
                        ].join(" ")}
                      >
                        {round.critique.approved ? "approved" : "changes requested"}
                      </span>
                    )}
                    <span className="label text-muted">
                      verdict: {round.report.overall_recommendation?.verdict}
                    </span>
                  </div>

                  <p className="mt-2 text-xs leading-relaxed text-ink-soft">
                    <span className="label text-muted">Draft summary — </span>
                    {round.report.summary}
                  </p>

                  {round.critique && (
                    <>
                      <p className="mt-2 text-xs leading-relaxed text-ink-soft">
                        <span className="label text-muted">Critique — </span>
                        {round.critique.overall_assessment}
                      </p>
                      {round.critique.findings.length > 0 && (
                        <div className="mt-2 flex flex-col gap-1.5">
                          {round.critique.findings.map((finding, i) => (
                            <FindingCard key={i} finding={finding} compact />
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function FindingCard({
  finding,
  compact = false,
}: {
  finding: CritiqueFinding;
  compact?: boolean;
}) {
  return (
    <div
      className={[
        "rounded border border-line bg-paper px-2.5 py-2",
        compact ? "text-xs" : "text-sm",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`label rounded px-1.5 py-0.5 ${
            SEVERITY[finding.severity] ?? SEVERITY.low
          }`}
        >
          {finding.severity}
        </span>
        <span className="label text-muted">
          {finding.flaw_type.replace(/_/g, " ")}
        </span>
      </div>
      <p className="mt-1.5 leading-relaxed text-ink-soft">{finding.detail}</p>
      <p className="mt-1 leading-relaxed text-muted">
        <span className="label">fix — </span>
        {finding.suggested_fix}
      </p>
    </div>
  );
}
