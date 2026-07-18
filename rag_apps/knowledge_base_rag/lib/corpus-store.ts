/**
 * Loads the pre-computed built-in corpus (data/embeddings.json) into an
 * in-memory VectorStore once, and caches it for the life of the process.
 *
 * The embeddings file records which embedding provider/model produced it.
 * Vectors are only comparable within the same provider, so if the file was
 * built with one provider and the server is now running another, we refuse to
 * use it and say why — rather than returning silently-garbage similarity scores.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { VectorStore } from "./vector-store";
import type { Chunk } from "./chunking";
import { embeddingProviderLabel, getEmbeddingProvider } from "./embedding-provider";

export type CorpusFile = {
  provider: "ollama" | "voyage";
  model: string;
  generatedAt: string;
  chunkCount: number;
  chunks: (Chunk & { vector: number[] })[];
};

export type CorpusState =
  | { status: "ready"; store: VectorStore; meta: CorpusMeta }
  | { status: "missing"; message: string }
  | { status: "provider-mismatch"; message: string };

export type CorpusMeta = {
  provider: string;
  model: string;
  generatedAt: string;
  chunkCount: number;
  sourceCount: number;
};

const EMBEDDINGS_PATH = path.join(process.cwd(), "data", "embeddings.json");

// Cache the resolved state on globalThis so hot reload in dev doesn't re-read
// and re-parse a multi-MB JSON file on every request.
const globalForCorpus = globalThis as unknown as {
  __kbCorpus?: Promise<CorpusState>;
};

export function loadCorpus(): Promise<CorpusState> {
  if (!globalForCorpus.__kbCorpus) {
    globalForCorpus.__kbCorpus = resolveCorpus();
  }
  return globalForCorpus.__kbCorpus;
}

/** Force a reload (used after re-running ingestion during dev, if ever needed). */
export function invalidateCorpus(): void {
  globalForCorpus.__kbCorpus = undefined;
}

async function resolveCorpus(): Promise<CorpusState> {
  let raw: string;
  try {
    raw = await readFile(EMBEDDINGS_PATH, "utf-8");
  } catch {
    return {
      status: "missing",
      message:
        "The built-in corpus hasn't been built yet. Run `npm run ingest` to generate data/embeddings.json, then restart the server.",
    };
  }

  let file: CorpusFile;
  try {
    file = JSON.parse(raw) as CorpusFile;
  } catch {
    return {
      status: "missing",
      message:
        "data/embeddings.json is present but couldn't be parsed. Re-run `npm run ingest` to regenerate it.",
    };
  }

  const current = getEmbeddingProvider();
  if (file.provider !== current) {
    return {
      status: "provider-mismatch",
      message: `The built-in corpus was embedded with "${file.provider}" but the server is configured for "${embeddingProviderLabel()}". Re-run \`npm run ingest\` with EMBEDDING_PROVIDER=${current}, or switch the server back to ${file.provider}.`,
    };
  }

  const store = new VectorStore();
  const chunks: Chunk[] = file.chunks.map((c) => ({
    id: c.id,
    text: c.text,
    metadata: c.metadata,
  }));
  store.add(
    chunks,
    file.chunks.map((c) => c.vector)
  );

  const sourceCount = new Set(file.chunks.map((c) => c.metadata.sourceUrl)).size;

  return {
    status: "ready",
    store,
    meta: {
      provider: file.provider,
      model: file.model,
      generatedAt: file.generatedAt,
      chunkCount: file.chunkCount,
      sourceCount,
    },
  };
}
