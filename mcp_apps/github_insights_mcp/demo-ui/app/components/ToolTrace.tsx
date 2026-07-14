"use client";

import { useState } from "react";

export type ToolTraceEntry = {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  isError: boolean;
};

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
}

function ToolCallCard({ entry }: { entry: ToolTraceEntry }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-md border border-tool-border bg-tool-bg text-tool-ink overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="flex items-center gap-2 font-mono text-xs min-w-0">
          <span className={entry.isError ? "text-error" : "text-accent"}>●</span>
          <span className="shrink-0">{entry.name}</span>
          <span className="text-tool-muted truncate">({formatArgs(entry.args)})</span>
        </span>
        <span className="text-tool-muted text-xs shrink-0">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <pre className="px-3 pb-3 text-xs overflow-x-auto whitespace-pre-wrap break-words text-tool-ink/90 font-mono">
          {JSON.stringify(entry.result, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function ToolTrace({ entries }: { entries: ToolTraceEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <span className="label text-muted">Tool calls ({entries.length})</span>
      {entries.map((entry, i) => (
        <ToolCallCard key={i} entry={entry} />
      ))}
    </div>
  );
}
