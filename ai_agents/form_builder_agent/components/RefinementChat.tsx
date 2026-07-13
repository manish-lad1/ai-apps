"use client";

import { useRef, useState, type FormEvent } from "react";
import type { FormSpec } from "@/lib/schemas";

type HistoryEntry = {
  id: number;
  instruction: string;
  status: "pending" | "ok" | "error";
  response?: string;
  error?: string;
};

export default function RefinementChat({
  spec,
  onSpecChange,
}: {
  spec: FormSpec;
  onSpecChange: (spec: FormSpec) => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(0);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = instruction.trim();
    if (!trimmed || loading) return;

    const id = nextId.current++;
    setHistory((prev) => [...prev, { id, instruction: trimmed, status: "pending" }]);
    setInstruction("");
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec, instruction: trimmed }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error ?? "Refinement failed.");
      }

      const response =
        typeof data?.summary === "string" && data.summary.trim() ? data.summary.trim() : "Form updated.";

      onSpecChange(data.spec as FormSpec);
      setHistory((prev) =>
        prev.map((entry) => (entry.id === id ? { ...entry, status: "ok", response } : entry))
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Refinement failed.";
      setError(message);
      setHistory((prev) =>
        prev.map((entry) => (entry.id === id ? { ...entry, status: "error", error: message } : entry))
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-col gap-1 border-b-2 border-[var(--line)] pb-4">
        <h2 className="font-mono text-xs uppercase tracking-wide text-[var(--muted)]">Refine</h2>
        <p className="text-sm text-[var(--muted)]">
          Describe a change — &ldquo;add a phone field&rdquo;, &ldquo;make email required&rdquo;.
        </p>
      </div>

      <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
        {history.length === 0 && (
          <p className="text-sm text-[var(--muted)]">No instructions sent yet.</p>
        )}
        {history.map((entry) => (
          <div
            key={entry.id}
            className={`border-2 px-3 py-2 text-sm ${
              entry.status === "error" ? "border-[var(--accent)]" : "border-[var(--line-soft)]"
            } text-[var(--ink)]`}
          >
            <p>{entry.instruction}</p>
            {entry.status === "pending" && (
              <p className="mt-1.5 animate-pulse border-t border-[var(--line-soft)] pt-1.5 font-mono text-xs uppercase tracking-wide text-[var(--muted)]">
                Updating…
              </p>
            )}
            {entry.status === "ok" && entry.response && (
              <p className="mt-1.5 border-t border-[var(--line-soft)] pt-1.5 text-xs text-[var(--muted)]">
                <span className="font-mono uppercase tracking-wide text-[var(--accent)]">Done —</span>{" "}
                {entry.response}
              </p>
            )}
            {entry.status === "error" && (
              <p className="mt-1 font-mono text-xs text-[var(--accent)]">{entry.error}</p>
            )}
          </div>
        ))}
      </div>

      {error && (
        <p className="border-2 border-[var(--accent)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--accent)]">
          {error}
        </p>
      )}

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="e.g. add a phone field"
          disabled={loading}
          className="flex-1 border-2 border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--muted)] focus:border-[var(--accent)] disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={loading || !instruction.trim()}
          className="border-2 border-[var(--line)] bg-[var(--accent)] px-4 py-2 font-mono text-xs uppercase tracking-wide text-[var(--accent-ink)] hover:brightness-95 disabled:opacity-50"
        >
          {loading ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}
