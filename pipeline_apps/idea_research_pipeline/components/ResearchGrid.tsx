"use client";

import { useState } from "react";
import ConfidenceBadge from "./ConfidenceBadge";
import { deriveConfidence } from "@/lib/confidence";
import type { Question, ResearchResult } from "@/lib/types";

export type RowStatus = "queued" | "searching" | "assessing" | "done" | "error";

export type ResearchRow = {
  question: Question;
  status: RowStatus;
  round: number;
  /** Mono trace lines, appended as the agent works. */
  trace: string[];
  result: ResearchResult | null;
  error: string | null;
};

const STATUS_STYLE: Record<RowStatus, { dot: string; label: string }> = {
  queued: { dot: "text-muted", label: "queued" },
  searching: { dot: "text-research", label: "searching" },
  assessing: { dot: "text-research", label: "assessing" },
  done: { dot: "text-research", label: "done" },
  error: { dot: "text-conf-low", label: "error" },
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * The live status grid — one row per approved question, updating as its agent
 * moves through search rounds.
 *
 * The visual pattern is lifted from github_insights_mcp's tool-trace panel:
 * a mono line per real operation, expandable, with the raw detail underneath.
 * The point in both cases is the same — an agent that shows its actual tool
 * calls is auditable, and one that shows a spinner is not.
 */
export default function ResearchGrid({
  rows,
  concurrency,
}: {
  rows: ResearchRow[];
  concurrency: number;
}) {
  const active = rows.filter(
    (r) => r.status === "searching" || r.status === "assessing"
  ).length;
  const queued = rows.filter((r) => r.status === "queued").length;
  const done = rows.filter((r) => r.status === "done").length;

  return (
    <div>
      <p className="label mb-2 text-muted">
        {done}/{rows.length} complete · {active} running (cap {concurrency})
        {queued > 0 ? ` · ${queued} queued` : ""}
      </p>

      <div className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <ResearchRowCard key={row.question.id} row={row} />
        ))}
      </div>
    </div>
  );
}

function ResearchRowCard({ row }: { row: ResearchRow }) {
  const [open, setOpen] = useState(false);
  const style = STATUS_STYLE[row.status];
  const working = row.status === "searching" || row.status === "assessing";

  return (
    <div className="relative overflow-hidden rounded-md border border-trace-border bg-trace-bg text-trace-ink">
      {working && <span className="row-scan absolute inset-0" aria-hidden />}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative flex w-full items-start justify-between gap-3 px-3 py-2 text-left"
      >
        <span className="flex min-w-0 items-start gap-2">
          <span className={`shrink-0 ${style.dot}`} aria-hidden>
            ●
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm text-ink">
              {row.question.question}
            </span>
            <span className="label mt-0.5 flex flex-wrap items-center gap-2 text-trace-muted">
              <span>{row.question.category.replace(/_/g, " ")}</span>
              <span>·</span>
              <span>{style.label}</span>
              {row.round > 0 && (
                <>
                  <span>·</span>
                  <span>
                    round {row.round}
                    {row.result ? ` (${row.result.roundsUsed} used)` : ""}
                  </span>
                </>
              )}
              {row.result && (
                <>
                  <span>·</span>
                  <span>{row.result.sources.length} sources</span>
                  {!row.result.reachedSufficiency && (
                    <>
                      <span>·</span>
                      <span className="text-conf-medium">unsettled</span>
                    </>
                  )}
                </>
              )}
            </span>
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-2">
          {row.result && (
            <ConfidenceBadge
              confidence={row.result.confidence}
              // Re-derived here purely for the tooltip. It's a pure function of
              // the sources, so the client can recompute the explanation
              // without the server having to ship it.
              reason={
                deriveConfidence(row.result.sources, {
                  reachedSufficiency: row.result.reachedSufficiency,
                }).reason
              }
            />
          )}
          <span className="text-xs text-trace-muted">{open ? "▾" : "▸"}</span>
        </span>
      </button>

      {open && (
        <div className="relative border-t border-trace-border px-3 py-3">
          {row.trace.length > 0 && (
            <pre className="mb-3 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-trace-ink/90">
              {row.trace.join("\n")}
            </pre>
          )}

          {row.error && <p className="text-sm text-conf-low">{row.error}</p>}

          {row.result && (
            <>
              <p className="text-sm leading-relaxed text-ink-soft">
                {row.result.findings}
              </p>

              {row.result.sources.length > 0 ? (
                <ul className="mt-3 flex flex-col gap-1.5">
                  {row.result.sources.map((source, i) => (
                    <li key={`${source.url}-${i}`} className="text-xs">
                      <span
                        className={[
                          "label mr-2 rounded px-1 py-0.5",
                          source.stance === "contradicts"
                            ? "bg-conf-low-bg text-conf-low"
                            : "bg-conf-high-bg text-conf-high",
                        ].join(" ")}
                      >
                        {source.stance}
                      </span>
                      <span className="text-ink-soft">{source.claim}</span>{" "}
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-research underline underline-offset-2"
                      >
                        {hostOf(source.url)}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-xs text-trace-muted">
                  No usable sources — this question stays unresearched rather than
                  being answered from model knowledge.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
