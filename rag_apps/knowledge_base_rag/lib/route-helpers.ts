/**
 * Shared server-side helpers for the API routes: session-KB ingestion and
 * limits, plus a uniform error-to-message helper. Keeping the chunk → embed →
 * store sequence in one place means upload and URL ingestion can't drift apart.
 */

import { randomUUID } from "node:crypto";
import { chunkDocument, type SourceType } from "./chunking";
import { embed } from "./embedding-provider";
import { getOrCreateSession, type SessionSource } from "./session-store";

// Enforced by the upload route.
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB per file
export const MAX_FILES = 10; // files per session

export type IngestInput = {
  text: string;
  title: string;
  url: string; // href for citations (for uploads, a "file:<name>" marker)
  sourceType: SourceType;
};

/**
 * Chunk a document, embed its chunks as "document" content, add them to the
 * session's vector store, and record the source for the UI. Returns the source
 * entry (with its chunk count).
 */
export async function ingestIntoSession(
  sessionId: string,
  input: IngestInput
): Promise<SessionSource> {
  const session = getOrCreateSession(sessionId);
  const sourceId = randomUUID();

  const chunks = chunkDocument(
    input.text,
    {
      sourceTitle: input.title,
      sourceUrl: input.url,
      sourceType: input.sourceType,
    },
    sourceId
  );

  if (chunks.length === 0) {
    throw new Error("That document had no extractable text to index.");
  }

  const vectors = await embed(
    chunks.map((c) => c.text),
    "document"
  );
  session.store.add(chunks, vectors);

  const source: SessionSource = {
    id: sourceId,
    label: input.title,
    url: input.url,
    sourceType: input.sourceType,
    chunkCount: chunks.length,
  };
  session.sources.push(source);
  return source;
}

/** Count how many of a session's sources are uploaded files (for the file cap). */
export function countUploadedFiles(sessionId: string): number {
  return getOrCreateSession(sessionId).sources.filter(
    (s) => s.sourceType === "upload"
  ).length;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected error.";
}
