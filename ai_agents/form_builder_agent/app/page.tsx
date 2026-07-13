"use client";

import { useState } from "react";
import FormRenderer from "@/components/FormRenderer";
import RefinementChat from "@/components/RefinementChat";
import ThemeToggle from "@/components/ThemeToggle";
import { exportAsHTML, exportAsJSX } from "@/lib/export";
import type { FormSpec } from "@/lib/schemas";

const EXAMPLE_PROMPT =
  "A signup form for a newsletter about vintage synthesizers — name, email, and how often they'd like to hear from us.";

type CopyState = "jsx" | "html" | null;

export default function Home() {
  const [description, setDescription] = useState("");
  const [spec, setSpec] = useState<FormSpec | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = description.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: trimmed }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error ?? "Failed to generate form.");
      }

      setSpec(data.spec as FormSpec);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate form.");
    } finally {
      setLoading(false);
    }
  }

  function handleStartOver() {
    setSpec(null);
    setDescription("");
    setError(null);
    setCopyState(null);
    setCopyError(null);
  }

  async function handleCopy(kind: "jsx" | "html") {
    if (!spec) return;
    const code = kind === "jsx" ? exportAsJSX(spec) : exportAsHTML(spec);
    try {
      await navigator.clipboard.writeText(code);
      setCopyError(null);
      setCopyState(kind);
      setTimeout(() => setCopyState((current) => (current === kind ? null : current)), 1600);
    } catch {
      setCopyError("Couldn't copy to clipboard — check your browser's clipboard permission.");
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b-2 border-[var(--line)] bg-[var(--surface)] px-6 py-4">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-bold uppercase tracking-widest text-[var(--ink)]">
            Form Builder
          </span>
          <span className="font-mono text-xs text-[var(--muted)]">{"// agent"}</span>
        </div>
        <div className="flex items-center gap-2">
          {spec && (
            <>
              <button
                onClick={() => handleCopy("jsx")}
                className="border-2 border-[var(--line)] px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-[var(--ink)] hover:border-[var(--accent)]"
              >
                {copyState === "jsx" ? "Copied!" : "Copy as JSX"}
              </button>
              <button
                onClick={() => handleCopy("html")}
                className="border-2 border-[var(--line)] px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-[var(--ink)] hover:border-[var(--accent)]"
              >
                {copyState === "html" ? "Copied!" : "Copy as HTML"}
              </button>
              <button
                onClick={handleStartOver}
                className="border-2 border-[var(--line)] bg-[var(--ink)] px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-[var(--paper)] hover:brightness-110"
              >
                Start over
              </button>
            </>
          )}
          <ThemeToggle />
        </div>
      </header>

      {copyError && (
        <p className="border-b-2 border-[var(--accent)] bg-[var(--paper)] px-6 py-2 text-xs text-[var(--accent)]">
          {copyError}
        </p>
      )}

      <main className="flex flex-1 flex-col">
        {!spec ? (
          <div className="flex flex-1 items-center justify-center px-6 py-16">
            <div className="w-full max-w-xl border-2 border-[var(--line)] bg-[var(--surface)] p-8">
              <h1 className="text-2xl font-semibold text-[var(--ink)]">Describe the form you want</h1>
              <p className="mt-2 text-sm text-[var(--muted)]">
                Plain language in, a real working form out. Refine it conversationally afterward.
              </p>

              <form onSubmit={handleGenerate} className="mt-6 flex flex-col gap-3">
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. A job application form with resume upload, years of experience, and availability."
                  rows={5}
                  className="w-full border-2 border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--muted)] focus:border-[var(--accent)]"
                />

                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setDescription(EXAMPLE_PROMPT)}
                    className="font-mono text-xs uppercase tracking-wide text-[var(--muted)] underline decoration-[var(--line-soft)] underline-offset-4 hover:text-[var(--accent)]"
                  >
                    Use example
                  </button>
                  <button
                    type="submit"
                    disabled={loading || !description.trim()}
                    className="border-2 border-[var(--line)] bg-[var(--accent)] px-6 py-2.5 font-mono text-xs uppercase tracking-wide text-[var(--accent-ink)] hover:brightness-95 disabled:opacity-50"
                  >
                    {loading ? "Building…" : "Build form"}
                  </button>
                </div>
              </form>

              {error && (
                <p className="mt-4 border-2 border-[var(--accent)] bg-[var(--paper)] px-3 py-2 text-xs text-[var(--accent)]">
                  {error}
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="grid flex-1 grid-cols-1 lg:grid-cols-[1.3fr_1fr]">
            <div className="border-b-2 border-[var(--line)] bg-[var(--paper)] p-6 lg:border-b-0 lg:border-r-2">
              <div className="mx-auto max-w-xl border-2 border-[var(--line)] bg-[var(--surface)] p-6">
                <FormRenderer spec={spec} />
              </div>
            </div>
            <div className="bg-[var(--surface)] p-6">
              <RefinementChat spec={spec} onSpecChange={setSpec} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
