"use client";

import { useState } from "react";
import { RepoSelector } from "./components/RepoSelector";
import { ChatPanel, type ChatEntry } from "./components/ChatPanel";
import { ToolsPanel } from "./components/ToolsPanel";

export default function Home() {
  const [repoInput, setRepoInput] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string>(() => crypto.randomUUID());

  const [ownerRaw, repoRaw] = repoInput.trim().split("/");
  const owner = ownerRaw?.trim() ?? "";
  const repo = repoRaw?.trim() ?? "";
  const repoReady = Boolean(owner && repo);

  async function handleSend(text: string) {
    if (!repoReady) return;
    setError(null);
    const nextEntries: ChatEntry[] = [...entries, { role: "user", content: text }];
    setEntries(nextEntries);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          owner,
          repo,
          githubToken: githubToken || undefined,
          messages: nextEntries.map(({ role, content }) => ({ role, content })),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }

      setEntries((prev) => [...prev, { role: "assistant", content: data.reply, toolTrace: data.toolTrace }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function handleReset() {
    if (loading) return;
    const oldSessionId = sessionId;
    setEntries([]);
    setError(null);
    setRepoInput("");
    setSessionId(crypto.randomUUID());

    // Best-effort cleanup of the old subprocess — a failure here shouldn't
    // block resetting the UI, the idle sweep would reap it eventually anyway.
    fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: oldSessionId }),
    }).catch(() => {});
  }

  return (
    <main className="flex flex-col h-screen overflow-hidden">
      <header className="shrink-0 border-b border-line bg-card px-6 py-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">GitHub Insights</h1>
          <p className="text-sm text-muted">
            Ask questions about a GitHub repo — an LLM decides which read-only MCP tools to call, and
            every call is visible below the answer.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleReset}
            disabled={loading}
            className="shrink-0 rounded-md border border-line-strong bg-paper px-3 py-1.5 text-sm font-medium hover:bg-line/50 transition-colors disabled:opacity-40"
          >
            New chat
          </button>
          <ToolsPanel />
        </div>
      </header>

      <RepoSelector
        repoInput={repoInput}
        onRepoInputChange={setRepoInput}
        githubToken={githubToken}
        onGithubTokenChange={setGithubToken}
        disabled={loading}
      />

      {error && (
        <div className="shrink-0 bg-error-bg text-error text-sm px-6 py-2 border-b border-line">{error}</div>
      )}

      <ChatPanel key={sessionId} entries={entries} onSend={handleSend} loading={loading} disabled={!repoReady} />
    </main>
  );
}
