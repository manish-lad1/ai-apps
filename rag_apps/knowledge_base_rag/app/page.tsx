"use client";

import { useEffect, useRef, useState } from "react";
import type {
  Citation,
  ChatResponse,
  CorpusStatus,
  SessionSource,
} from "@/lib/types";
import Citations from "@/components/Citations";
import SourcePanel from "@/components/SourcePanel";

type Mode = "builtin" | "session";

type Message = {
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
  grounded?: boolean;
};

const BUILTIN_EXAMPLES = [
  "What has this author written about evals?",
  "What's the difference between golden-output and flaw-based evals?",
  "What projects are in this repo and what does each do?",
  "How does the PRD critique agent avoid trusting the model's arithmetic?",
];

const SESSION_EXAMPLES = [
  "Summarize the key points across everything I've added.",
  "What does this document say about pricing?",
  "Are there any risks or caveats mentioned?",
];

export default function Home() {
  const [mode, setMode] = useState<Mode>("builtin");
  const [sessionId] = useState(() =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  );

  const [corpus, setCorpus] = useState<CorpusStatus | null>(null);
  const [sources, setSources] = useState<SessionSource[]>([]);

  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/corpus")
      .then((r) => r.json())
      .then(setCorpus)
      .catch(() => setCorpus({ status: "missing", message: "Couldn't reach the corpus." }));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, asking]);

  const sessionEmpty = mode === "session" && sources.length === 0;

  async function ask(q?: string) {
    const question = (q ?? query).trim();
    if (!question || asking) return;
    if (sessionEmpty) {
      setError("Add a file or URL to your knowledge base first.");
      return;
    }
    setError(null);
    setQuery("");
    setMessages((m) => [...m, { role: "user", text: question }]);
    setAsking(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: question, mode, sessionId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Something went wrong.");
      const answer = data as ChatResponse;
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: answer.answer,
          citations: answer.citations,
          grounded: answer.grounded,
        },
      ]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text:
            err instanceof Error
              ? err.message
              : "Something went wrong answering that.",
          grounded: false,
        },
      ]);
    } finally {
      setAsking(false);
    }
  }

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setMessages([]);
    setError(null);
  }

  const examples = mode === "builtin" ? BUILTIN_EXAMPLES : SESSION_EXAMPLES;

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-12 sm:py-16">
      {/* Hero */}
      <header className="max-w-2xl">
        <p className="label text-accent">Knowledge Base · RAG</p>
        <h1 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight text-ink leading-[1.1]">
          Grounded answers, with the receipts.
        </h1>
        <p className="mt-4 text-base text-ink-soft leading-relaxed">
          Ask a question and get an answer built only from retrieved source
          passages — every claim cited back to the article, doc, file, or URL it
          came from. No sources cover it? It says so, instead of guessing.
        </p>
      </header>

      {/* Mode toggle */}
      <div className="mt-8 inline-flex rounded-xl border border-line bg-card p-1 shadow-sm">
        {(
          [
            ["builtin", "Newsletter & portfolio"],
            ["session", "Upload your own"],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => switchMode(m)}
            className={[
              "rounded-lg px-4 py-2 text-sm font-medium transition-colors",
              mode === m
                ? "bg-ink text-white"
                : "text-muted hover:text-ink",
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Mode context */}
      <div className="mt-4">
        {mode === "builtin" ? (
          <BuiltinStatus corpus={corpus} />
        ) : (
          <SourcePanel
            sessionId={sessionId}
            sources={sources}
            onAdd={(s) => setSources((prev) => [...prev, s])}
            onClear={() => setSources([])}
          />
        )}
      </div>

      {/* Conversation */}
      <div className="mt-8 space-y-5">
        {messages.map((msg, i) => (
          <MessageBubble key={i} msg={msg} />
        ))}

        {asking && (
          <div className="fade-in">
            <p className="label mb-1.5 text-accent">Assistant</p>
            <div className="flex items-center gap-1.5 rounded-2xl border border-line bg-card px-4 py-3 text-muted shadow-sm">
              <span className="dot text-lg leading-none">·</span>
              <span className="dot text-lg leading-none">·</span>
              <span className="dot text-lg leading-none">·</span>
              <span className="ml-1 text-sm">retrieving &amp; grounding…</span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Empty-state examples */}
      {messages.length === 0 && !asking && (
        <div className="mt-6">
          <p className="label mb-2 text-muted">Try asking</p>
          <div className="flex flex-wrap gap-2">
            {examples.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => ask(ex)}
                disabled={sessionEmpty}
                className="rounded-full border border-line bg-card px-3 py-1.5 text-sm text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {ex}
              </button>
            ))}
          </div>
          {sessionEmpty && (
            <p className="mt-2 text-xs text-muted">
              Add a source above to enable questions.
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {/* Composer */}
      <div className="sticky bottom-4 mt-6">
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-card p-2 shadow-lg">
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask();
              }
            }}
            placeholder={
              sessionEmpty
                ? "Add a source above, then ask a question…"
                : "Ask a question about the sources…"
            }
            rows={1}
            disabled={asking}
            className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-3 py-2 text-sm text-ink placeholder:text-muted/70 outline-none disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() => ask()}
            disabled={!query.trim() || asking || sessionEmpty}
            className="shrink-0 rounded-xl bg-ink px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {asking ? "…" : "Ask"}
          </button>
        </div>
      </div>

      <footer className="mt-10 border-t border-line pt-6 label text-muted">
        In-memory vector store · Ollama + Voyage embeddings · Ollama or Claude
        generation. Uploaded knowledge bases are session-only and cleared on
        server restart.
      </footer>
    </main>
  );
}

function BuiltinStatus({ corpus }: { corpus: CorpusStatus | null }) {
  if (!corpus) {
    return (
      <div className="rounded-xl border border-line bg-card px-4 py-3 text-sm text-muted shadow-sm">
        Loading corpus…
      </div>
    );
  }
  if (corpus.status !== "ready") {
    return (
      <div className="rounded-xl border border-warn/30 bg-warn/5 px-4 py-3 text-sm text-warn shadow-sm">
        {corpus.message}
      </div>
    );
  }
  const { meta } = corpus;
  return (
    <div className="rounded-xl border border-line bg-card px-4 py-3 shadow-sm">
      <p className="text-sm text-ink-soft">
        Pre-indexed:{" "}
        <span className="font-medium text-ink">{meta.chunkCount} chunks</span>{" "}
        from{" "}
        <span className="font-medium text-ink">{meta.sourceCount} sources</span>{" "}
        — the <em>AI from the Inside</em>{" "}newsletter and this repo&apos;s docs.
      </p>
      <p className="label mt-1 text-muted">
        embeddings: {meta.provider} · {meta.model}
      </p>
    </div>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  if (msg.role === "user") {
    return (
      <div className="fade-in flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-sm text-white">
          {msg.text}
        </div>
      </div>
    );
  }
  return (
    <div className="fade-in">
      <p className="label mb-1.5 text-accent">
        Assistant
        {msg.grounded === false && (
          <span className="ml-2 text-warn">· no grounded sources</span>
        )}
      </p>
      <div className="rounded-2xl rounded-tl-md border border-line bg-card px-4 py-3 shadow-sm">
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
          {msg.text}
        </p>
        {msg.citations && <Citations citations={msg.citations} />}
      </div>
    </div>
  );
}
