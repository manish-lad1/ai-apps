/**
 * Shared client/server types for the wire format between the API routes and the
 * UI. Kept dependency-free (no server-only imports) so it's safe to import into
 * client components.
 */

export type Citation = {
  sourceTitle: string;
  sourceUrl: string;
  sourceType: string;
  heading?: string;
  snippet: string;
  score: number;
};

export type SessionSource = {
  id: string;
  label: string;
  url: string;
  sourceType: "newsletter" | "repo-doc" | "upload" | "url";
  chunkCount: number;
};

export type ChatResponse = {
  answer: string;
  citations: Citation[];
  grounded: boolean;
};

export type CorpusStatus =
  | {
      status: "ready";
      meta: {
        provider: string;
        model: string;
        generatedAt: string;
        chunkCount: number;
        sourceCount: number;
      };
    }
  | { status: "missing" | "provider-mismatch"; message: string };
