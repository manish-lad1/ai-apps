"use client";

import { useState } from "react";
import { MIN_APPROVED_QUESTIONS, type Question } from "@/lib/types";

function categoryLabel(category: string): string {
  return category.replace(/_/g, " ");
}

/**
 * The human approval gate. Nothing in Stage 2 fires until this passes.
 *
 * This is the one place a person is in the loop, so it is fully editable:
 * rewrite a question, drop one, or add your own. The generated set is a
 * starting point, not a verdict — and a question you rewrote is one the
 * research agents will actually work.
 */
export default function QuestionList({
  questions,
  approvedIds,
  disabled,
  onToggle,
  onEdit,
  onDelete,
  onAdd,
}: {
  questions: Question[];
  approvedIds: Set<string>;
  disabled: boolean;
  onToggle: (id: string) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onAdd: (text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const approvedCount = questions.filter((q) => approvedIds.has(q.id)).length;
  const shortfall = MIN_APPROVED_QUESTIONS - approvedCount;

  async function submitCustom() {
    const text = draft.trim();
    if (!text || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      await onAdd(text);
      setDraft("");
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Couldn't add that question.");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div>
      <ul className="flex flex-col gap-2">
        {questions.map((q) => {
          const approved = approvedIds.has(q.id);
          return (
            <li
              key={q.id}
              className={[
                "rounded-lg border bg-card p-3 transition-opacity",
                approved ? "border-line" : "border-line opacity-50",
              ].join(" ")}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={approved}
                  disabled={disabled}
                  onChange={() => onToggle(q.id)}
                  aria-label={`Include: ${q.question}`}
                  className="mt-1 h-4 w-4 shrink-0 accent-[var(--ask)]"
                />

                <div className="min-w-0 flex-1">
                  <textarea
                    value={q.question}
                    disabled={disabled}
                    rows={2}
                    onChange={(e) => onEdit(q.id, e.target.value)}
                    aria-label="Question text"
                    className="w-full resize-y rounded border border-transparent bg-transparent px-1 py-0.5 text-sm text-ink outline-none hover:border-line focus:border-line-strong focus:bg-paper disabled:opacity-70"
                  />
                  <span className="label mt-1 inline-block rounded bg-ask-bg px-1.5 py-0.5 text-ask">
                    {categoryLabel(q.category)}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => onDelete(q.id)}
                  disabled={disabled}
                  aria-label={`Delete question: ${q.question}`}
                  className="shrink-0 rounded px-2 py-1 text-muted transition-colors hover:bg-conf-low-bg hover:text-conf-low disabled:opacity-40"
                >
                  ✕
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {/* add your own */}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={draft}
          disabled={disabled || adding}
          placeholder="Add your own research question…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submitCustom();
            }
          }}
          className="flex-1 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-muted/70 outline-none focus:border-line-strong disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => void submitCustom()}
          disabled={disabled || adding || !draft.trim()}
          className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-ask-bg disabled:cursor-not-allowed disabled:opacity-40"
        >
          {adding ? "Categorising…" : "Add"}
        </button>
      </div>
      <p className="label mt-1.5 text-muted">
        The app assigns the category, using the same logic as stage 01.
      </p>
      {addError && (
        <p className="mt-1.5 text-sm text-conf-low">{addError}</p>
      )}

      {/* the gate */}
      {shortfall > 0 && (
        <p
          role="status"
          className="mt-4 rounded-lg border border-conf-medium/30 bg-conf-medium-bg px-3 py-2 text-sm text-conf-medium"
        >
          {approvedCount === 0
            ? `Approve at least ${MIN_APPROVED_QUESTIONS} questions to run research.`
            : `${approvedCount} approved — ${shortfall} more needed before research can run.`}
        </p>
      )}
    </div>
  );
}
