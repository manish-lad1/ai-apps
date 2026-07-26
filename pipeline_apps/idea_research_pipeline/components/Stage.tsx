"use client";

import type { ReactNode } from "react";

export type StageState = "idle" | "working" | "done" | "blocked";
export type StageAccent = "ask" | "research" | "report";

const ACCENT: Record<StageAccent, { dot: string; text: string; bg: string }> = {
  ask: { dot: "bg-ask", text: "text-ask", bg: "bg-ask-bg" },
  research: { dot: "bg-research", text: "text-research", bg: "bg-research-bg" },
  report: { dot: "bg-report", text: "text-report", bg: "bg-report-bg" },
};

/**
 * One node in the pipeline: a numbered marker, a connecting rail down to the
 * next stage, and the stage's content. The rail is what makes this read as a
 * pipeline rather than three stacked cards — an artifact moves forward through
 * it and never comes back.
 */
export default function Stage({
  index,
  title,
  accent,
  state,
  meta,
  isLast = false,
  children,
}: {
  index: string;
  title: string;
  accent: StageAccent;
  state: StageState;
  meta?: ReactNode;
  isLast?: boolean;
  children?: ReactNode;
}) {
  const colors = ACCENT[accent];
  const active = state !== "idle";

  return (
    <section className="relative flex gap-4 sm:gap-5 pb-10">
      {/* rail + node */}
      <div className="flex flex-col items-center shrink-0">
        <span
          className={[
            "mt-1 h-3 w-3 rounded-full transition-colors",
            active ? colors.dot : "bg-line-strong",
            state === "working" ? "node-working" : "",
          ].join(" ")}
          aria-hidden
        />
        {!isLast && (
          <span
            className={[
              "mt-2 w-px flex-1 transition-colors",
              state === "done" ? colors.dot : "bg-line",
            ].join(" ")}
            aria-hidden
          />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className={`label ${active ? colors.text : "text-muted"}`}>
            {index}
          </span>
          <h2
            className={[
              "text-lg font-semibold tracking-tight",
              active ? "text-ink" : "text-muted",
            ].join(" ")}
          >
            {title}
          </h2>
          {state === "working" && (
            <span className={`label ${colors.text}`}>working…</span>
          )}
          {meta}
        </header>

        {children && <div className="mt-4 stage-in">{children}</div>}
      </div>
    </section>
  );
}
