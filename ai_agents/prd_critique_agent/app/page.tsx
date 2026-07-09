"use client";

import { useState } from "react";
import type { Critique, Framework, Prd } from "@/lib/schemas";
import Stage from "@/components/Stage";
import PrdView from "@/components/PrdView";
import CritiqueView from "@/components/CritiqueView";

type Phase = "idle" | "drafting" | "critiquing" | "refining" | "done";

const EXAMPLE =
  "We keep getting support tickets from users who can't find where their exported reports went. Some kind of way to see and re-download past exports would help. Maybe notify them when an export is ready too.";

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? "Request failed.");
  return data as T;
}

export default function Home() {
  const [idea, setIdea] = useState("");
  const [framework, setFramework] = useState<Framework>("moscow");
  const [phase, setPhase] = useState<Phase>("idle");
  const [draft, setDraft] = useState<Prd | null>(null);
  const [critique, setCritique] = useState<Critique | null>(null);
  const [refined, setRefined] = useState<Prd | null>(null);
  const [error, setError] = useState<string | null>(null);

  const running = phase !== "idle" && phase !== "done";

  async function run() {
    if (!idea.trim() || running) return;
    setError(null);
    setDraft(null);
    setCritique(null);
    setRefined(null);

    try {
      setPhase("drafting");
      const { prd } = await postJSON<{ prd: Prd }>("/api/draft", {
        idea,
        framework,
      });
      setDraft(prd);

      setPhase("critiquing");
      const { critique: crit } = await postJSON<{ critique: Critique }>(
        "/api/critique",
        { prd }
      );
      setCritique(crit);

      setPhase("refining");
      const { prd: improved } = await postJSON<{ prd: Prd }>("/api/refine", {
        prd,
        critique: crit,
        framework,
      });
      setRefined(improved);

      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPhase("idle");
    }
  }

  const draftState =
    phase === "drafting" ? "working" : draft ? "done" : "idle";
  const critiqueState =
    phase === "critiquing" ? "working" : critique ? "done" : "idle";
  const refineState =
    phase === "refining" ? "working" : refined ? "done" : "idle";

  const started = phase !== "idle" || !!draft;

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-14 sm:py-20">
      {/* Hero */}
      <header className="max-w-2xl">
        <p className="label text-critique">PM Agent</p>
        <h1 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight text-ink leading-[1.1]">
          From a rough idea to a review-ready PRD.
        </h1>
        <p className="mt-4 text-base text-ink-soft leading-relaxed">
          This agent drafts a PRD from your rough notes, critiques its own draft
          against a product-review rubric, then rewrites it to fix what it found
          — and shows you every step, not just the final answer.
        </p>
      </header>

      {/* Input */}
      <div className="mt-9 rounded-2xl border border-line bg-card p-4 sm:p-5 shadow-sm">
        <label htmlFor="idea" className="label text-muted">
          The rough idea
        </label>
        <textarea
          id="idea"
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          placeholder="A messy sentence or two is all it needs — the kind of thing a stakeholder drops in Slack."
          rows={4}
          disabled={running}
          className="mt-2 w-full resize-y rounded-lg border border-line bg-paper px-3.5 py-3 text-sm text-ink placeholder:text-muted/70 outline-none focus:border-line-strong focus:ring-2 focus:ring-ink/5 disabled:opacity-60"
        />

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="label text-muted">Priority</span>
            <div className="inline-flex rounded-lg border border-line p-0.5">
              {(["moscow", "rice"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFramework(f)}
                  disabled={running}
                  className={[
                    "rounded-md px-3 py-1 label transition-colors disabled:opacity-60",
                    framework === f
                      ? "bg-ink text-white"
                      : "text-muted hover:text-ink",
                  ].join(" ")}
                >
                  {f === "moscow" ? "MoSCoW" : "RICE"}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3">
            {!idea.trim() && !running && (
              <button
                type="button"
                onClick={() => setIdea(EXAMPLE)}
                className="label text-muted hover:text-ink transition-colors"
              >
                Try an example
              </button>
            )}
            <button
              type="button"
              onClick={run}
              disabled={!idea.trim() || running}
              className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {running ? "Working…" : started ? "Run again" : "Generate PRD"}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-5 rounded-lg border border-sev-high/30 bg-sev-high/5 px-4 py-3 text-sm text-sev-high">
          {error}
        </div>
      )}

      {/* The loop */}
      {started && (
        <div className="mt-12">
          <Stage
            index="01"
            title="Draft"
            accent="draft"
            state={draftState}
          >
            {draft && <PrdView prd={draft} />}
          </Stage>

          <Stage
            index="02"
            title="Self-critique"
            accent="critique"
            state={critiqueState}
          >
            {critique && <CritiqueView critique={critique} />}
          </Stage>

          <Stage
            index="03"
            title="Refined PRD"
            accent="refine"
            state={refineState}
            isLast
          >
            {refined && <PrdView prd={refined} />}
          </Stage>
        </div>
      )}

      <footer className="mt-16 border-t border-line pt-6 label text-muted">
        Runs on a local model (Ollama) in dev, or the Claude API in production.
      </footer>
    </main>
  );
}
