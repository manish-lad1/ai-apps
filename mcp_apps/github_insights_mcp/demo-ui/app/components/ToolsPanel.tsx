"use client";

import { useEffect, useRef, useState } from "react";

type ToolInfo = {
  name: string;
  description: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
};

function paramSignature(tool: ToolInfo): string {
  const properties = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  return Object.keys(properties)
    .map((key) => (required.has(key) ? key : `${key}?`))
    .join(", ");
}

/**
 * A button that opens a right-hand drawer listing the MCP server's tools,
 * fetched live from a real running session — not a hardcoded list — so it
 * can't drift from what the server actually exposes. Uses its own session
 * id, independent of the chat session, so opening this before entering a
 * GitHub token can't lock the chat session's subprocess into running
 * without one.
 */
export function ToolsPanel() {
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  if (!sessionIdRef.current) {
    sessionIdRef.current = crypto.randomUUID();
  }

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  async function handleOpen() {
    setOpen(true);
    if (tools !== null || loading) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionIdRef.current }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      setTools(data.tools);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className="shrink-0 rounded-md border border-line-strong bg-paper px-3 py-1.5 text-sm font-medium hover:bg-line/50 transition-colors"
      >
        Tools{tools ? ` (${tools.length})` : ""}
      </button>

      <div
        aria-hidden={!open}
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-40 bg-black/30 transition-opacity duration-300 ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      <aside
        role="dialog"
        aria-label="Available tools"
        aria-hidden={!open}
        className={`fixed top-0 right-0 z-50 flex h-full w-full max-w-sm flex-col border-l border-line bg-card shadow-xl transition-transform duration-300 ease-in-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="label text-muted">Available tools{tools ? ` (${tools.length})` : ""}</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="text-muted hover:text-ink transition-colors"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
          {loading && <p className="text-sm text-muted">Loading tools from a live MCP session…</p>}
          {error && <p className="text-sm text-error">{error}</p>}
          {tools?.map((tool) => (
            <div key={tool.name} className="text-sm">
              <div className="font-mono text-accent">{tool.name}</div>
              <div className="font-mono text-muted text-xs">({paramSignature(tool)})</div>
              <div className="text-ink-soft mt-0.5">{tool.description}</div>
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}
