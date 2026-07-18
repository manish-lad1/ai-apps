"use client";

import { useState } from "react";
import type { Citation } from "@/lib/types";

const TYPE_LABELS: Record<string, string> = {
  newsletter: "Newsletter",
  "repo-doc": "Repo doc",
  upload: "Upload",
  url: "URL",
};

/** Turn a citation's source into an href. Uploads use a "file:" marker → no link. */
function hrefFor(c: Citation): string | null {
  if (c.sourceUrl.startsWith("file:")) return null;
  if (c.sourceType === "repo-doc") {
    // Repo docs are relative paths; link to the file on GitHub.
    return `https://github.com/manish-lad1/ai-apps/blob/main/${c.sourceUrl}`;
  }
  if (/^https?:\/\//.test(c.sourceUrl)) return c.sourceUrl;
  return null;
}

export default function Citations({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState(false);
  if (citations.length === 0) return null;

  return (
    <div className="mt-3 border-t border-line pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="label flex items-center gap-1.5 text-accent hover:opacity-80"
        aria-expanded={open}
      >
        <span
          className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}
        >
          ▸
        </span>
        {citations.length} source{citations.length === 1 ? "" : "s"}
      </button>

      {open && (
        <ol className="mt-3 space-y-2.5">
          {citations.map((c, i) => {
            const href = hrefFor(c);
            return (
              <li
                key={i}
                className="rounded-lg border border-line bg-paper p-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="label flex h-5 min-w-5 items-center justify-center rounded bg-accent-bg px-1 text-accent">
                    {i + 1}
                  </span>
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-accent"
                    >
                      {c.sourceTitle}
                    </a>
                  ) : (
                    <span className="font-medium text-ink">{c.sourceTitle}</span>
                  )}
                  <span className="label rounded bg-line px-1.5 py-0.5 text-muted">
                    {TYPE_LABELS[c.sourceType] ?? c.sourceType}
                  </span>
                  <span className="label ml-auto text-muted">
                    {(c.score * 100).toFixed(0)}% match
                  </span>
                </div>
                {c.heading && (
                  <div className="mt-1.5 text-xs text-muted">
                    Section: <span className="text-ink-soft">{c.heading}</span>
                  </div>
                )}
                <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
                  {c.snippet}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
