/**
 * In-memory registry of per-session knowledge bases for "upload your own" mode.
 *
 * This is deliberately ephemeral. Each browser session gets its own VectorStore
 * held in a Map on the server; there is no database and no disk persistence, so
 * a server restart or redeploy wipes every session's uploaded content. That's a
 * scope decision, not a bug — the README says so out loud. A periodic sweep
 * evicts sessions that have gone idle past the TTL so memory doesn't grow
 * unbounded on a long-running server.
 */

import { VectorStore } from "./vector-store";
import type { SourceType } from "./chunking";

/** One thing the user added to their session KB, for display + provenance. */
export type SessionSource = {
  id: string;
  label: string; // filename or URL
  url: string; // href for citations (file:name for uploads)
  sourceType: SourceType;
  chunkCount: number;
};

type Session = {
  store: VectorStore;
  sources: SessionSource[];
  createdAt: number;
  lastAccess: number;
};

const TTL_MS = 60 * 60 * 1000; // 1 hour of idleness before a session is evicted
const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // sweep at most every 10 minutes

// Next's dev server re-evaluates modules on hot reload, which would otherwise
// drop every session on each edit. Pin the map to globalThis so it survives.
const globalForSessions = globalThis as unknown as {
  __kbSessions?: Map<string, Session>;
  __kbLastSweep?: number;
};

const sessions: Map<string, Session> =
  globalForSessions.__kbSessions ?? (globalForSessions.__kbSessions = new Map());

function sweepIfDue(): void {
  const now = Date.now();
  if (now - (globalForSessions.__kbLastSweep ?? 0) < SWEEP_INTERVAL_MS) return;
  globalForSessions.__kbLastSweep = now;
  for (const [id, session] of sessions) {
    if (now - session.lastAccess > TTL_MS) sessions.delete(id);
  }
}

function touch(session: Session): Session {
  session.lastAccess = Date.now();
  return session;
}

/** Get an existing session, or create an empty one for this id. */
export function getOrCreateSession(sessionId: string): Session {
  sweepIfDue();
  const existing = sessions.get(sessionId);
  if (existing) return touch(existing);
  const created: Session = {
    store: new VectorStore(),
    sources: [],
    createdAt: Date.now(),
    lastAccess: Date.now(),
  };
  sessions.set(sessionId, created);
  return created;
}

/** Get a session only if it already exists (used by the chat route). */
export function getSession(sessionId: string): Session | undefined {
  sweepIfDue();
  const existing = sessions.get(sessionId);
  return existing ? touch(existing) : undefined;
}

/** Drop everything for a session (the UI's "clear knowledge base" button). */
export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
}
