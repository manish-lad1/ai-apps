"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ToolTrace, type ToolTraceEntry } from "./ToolTrace";

export type ChatEntry = {
  role: "user" | "assistant";
  content: string;
  toolTrace?: ToolTraceEntry[];
};

type ChatPanelProps = {
  entries: ChatEntry[];
  onSend: (text: string) => void;
  loading: boolean;
  disabled?: boolean;
};

export function ChatPanel({ entries, onSend, loading, disabled }: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to the newest message whenever the conversation grows or the
  // "Thinking…" indicator toggles, so the latest content is always visible.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries, loading]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || loading || disabled) return;
    onSend(text);
    setDraft("");
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
        {entries.length === 0 && (
          <p className="text-muted text-sm">
            Ask something about the repo above — e.g. &quot;summarize recent activity&quot; or
            &quot;what are the open issues about?&quot;
          </p>
        )}
        {entries.map((entry, i) => (
          <div key={i} className={entry.role === "user" ? "self-end max-w-[80%]" : "self-start max-w-[85%]"}>
            <div
              className={
                entry.role === "user"
                  ? "rounded-lg bg-accent-bg text-ink px-4 py-2 text-sm"
                  : "rounded-lg bg-card border border-line px-4 py-2 text-sm whitespace-pre-wrap"
              }
            >
              {entry.content}
            </div>
            {entry.role === "assistant" && entry.toolTrace && <ToolTrace entries={entry.toolTrace} />}
          </div>
        ))}
        {loading && <div className="self-start text-muted text-sm">Thinking…</div>}
      </div>
      <form onSubmit={handleSubmit} className="shrink-0 border-t border-line bg-card px-6 py-3 flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={disabled ? "Enter a repo above first" : "Ask about this repo…"}
          disabled={disabled || loading}
          className="flex-1 rounded-md border border-line-strong bg-paper px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={disabled || loading || !draft.trim()}
          className="rounded-md bg-accent text-white px-4 py-2 text-sm font-medium disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}
