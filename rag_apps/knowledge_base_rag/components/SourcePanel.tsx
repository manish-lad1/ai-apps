"use client";

import { useRef, useState } from "react";
import type { SessionSource } from "@/lib/types";

type Props = {
  sessionId: string;
  sources: SessionSource[];
  onAdd: (source: SessionSource) => void;
  onClear: () => void;
};

const TYPE_ICON: Record<string, string> = { upload: "📄", url: "🔗" };

export default function SourcePanel({ sessionId, sources, onAdd, onClear }: Props) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<null | "file" | "url" | "clear">(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const totalChunks = sources.reduce((sum, s) => sum + s.chunkCount, 0);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setBusy("file");
    try {
      const form = new FormData();
      form.append("sessionId", sessionId);
      form.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Upload failed.");
      onAdd(data.source);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleUrl() {
    const trimmed = url.trim();
    if (!trimmed || busy) return;
    setError(null);
    setBusy("url");
    try {
      const res = await fetch("/api/ingest-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, url: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Couldn't add that URL.");
      onAdd(data.source);
      setUrl("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that URL.");
    } finally {
      setBusy(null);
    }
  }

  async function handleClear() {
    if (busy) return;
    setBusy("clear");
    try {
      await fetch("/api/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      onClear();
      setError(null);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-2xl border border-line bg-card p-4 sm:p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="label text-muted">Your knowledge base</p>
        {sources.length > 0 && (
          <button
            type="button"
            onClick={handleClear}
            disabled={!!busy}
            className="label text-muted hover:text-danger disabled:opacity-50"
          >
            {busy === "clear" ? "Clearing…" : "Clear all"}
          </button>
        )}
      </div>

      {/* Add controls */}
      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <div className="flex gap-2">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleUrl()}
              placeholder="Paste an article URL…"
              disabled={busy === "url"}
              className="min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-muted/70 outline-none focus:border-line-strong focus:ring-2 focus:ring-accent/10 disabled:opacity-60"
            />
            <button
              type="button"
              onClick={handleUrl}
              disabled={!url.trim() || !!busy}
              className="shrink-0 rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "url" ? "Adding…" : "Add URL"}
            </button>
          </div>
        </div>

        <div className="sm:w-px sm:bg-line" />

        <label
          className={`flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong px-4 py-2 text-sm font-medium text-ink-soft transition-colors hover:border-accent hover:text-accent ${
            busy === "file" ? "pointer-events-none opacity-60" : ""
          }`}
        >
          {busy === "file" ? "Indexing…" : "Upload file"}
          <input
            ref={fileRef}
            type="file"
            accept=".md,.txt,.pdf"
            onChange={handleFile}
            disabled={!!busy}
            className="hidden"
          />
        </label>
      </div>

      <p className="mt-2 text-xs text-muted">
        Accepts .md, .txt, .pdf (max 10MB, 10 files). Held in memory for this
        session only — nothing is stored on the server.
      </p>

      {error && (
        <div className="mt-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {/* Loaded sources */}
      {sources.length > 0 && (
        <div className="mt-4">
          <div className="label mb-2 flex items-center justify-between text-muted">
            <span>
              {sources.length} source{sources.length === 1 ? "" : "s"}
            </span>
            <span>{totalChunks} chunks indexed</span>
          </div>
          <ul className="space-y-1.5">
            {sources.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2 text-sm"
              >
                <span aria-hidden>{TYPE_ICON[s.sourceType] ?? "📄"}</span>
                <span className="min-w-0 flex-1 truncate text-ink" title={s.label}>
                  {s.label}
                </span>
                <span className="label shrink-0 text-muted">
                  {s.chunkCount} chunk{s.chunkCount === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
