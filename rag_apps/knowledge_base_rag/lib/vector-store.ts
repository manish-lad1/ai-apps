/**
 * A dependency-free in-memory vector store.
 *
 * At this project's scale — a few hundred to low thousands of chunks — an
 * external vector database is overkill. A plain array plus a cosine-similarity
 * scan is O(n) per query, which at n≈1000 is sub-millisecond and keeps the whole
 * project free of infrastructure. If this ever needed to scale to hundreds of
 * thousands of vectors, *this* is the file you'd swap for a real ANN index; the
 * rest of the app only depends on add()/search()/clear().
 */

import type { Chunk } from "./chunking";

export type StoredItem = Chunk & { vector: number[] };

export type SearchResult = {
  chunk: Chunk;
  score: number;
};

/** Cosine similarity of two equal-length vectors, in [-1, 1]. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector length mismatch (${a.length} vs ${b.length}). This usually means the store and the query were embedded with different providers/models.`
    );
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class VectorStore {
  private items: StoredItem[] = [];

  /** Add pre-embedded items. `vectors[i]` must correspond to `chunks[i]`. */
  add(chunks: Chunk[], vectors: number[][]): void {
    if (chunks.length !== vectors.length) {
      throw new Error(
        `add() got ${chunks.length} chunks but ${vectors.length} vectors.`
      );
    }
    for (let i = 0; i < chunks.length; i++) {
      this.items.push({ ...chunks[i], vector: vectors[i] });
    }
  }

  /**
   * Return the top-k chunks by cosine similarity to `queryVector`, highest
   * first. Results scoring below `minScore` are dropped — this is the guard that
   * lets a caller say "nothing relevant was found" instead of handing the model
   * five weakly-related chunks and inviting a confident-but-ungrounded answer.
   */
  search(queryVector: number[], topK: number, minScore = 0): SearchResult[] {
    const scored = this.items.map((item) => ({
      chunk: { id: item.id, text: item.text, metadata: item.metadata },
      score: cosineSimilarity(queryVector, item.vector),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.filter((r) => r.score >= minScore).slice(0, topK);
  }

  clear(): void {
    this.items = [];
  }

  get size(): number {
    return this.items.length;
  }
}
