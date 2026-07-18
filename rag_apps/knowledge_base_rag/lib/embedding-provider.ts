/**
 * A single, provider-agnostic entry point for turning text into embedding
 * vectors. Everything else in the app calls embed() — nothing outside this file
 * knows whether the vectors came from a local Ollama model or Voyage AI.
 *
 * Switch providers with the EMBEDDING_PROVIDER env var: "ollama" | "voyage".
 *
 * The `inputType` argument is not cosmetic. Both providers can embed a document
 * and a search query into deliberately different regions of the vector space
 * when told which is which, and that measurably improves retrieval. It's a
 * one-parameter change at call time, so we always pass it:
 *   - "document" when embedding corpus / uploaded / fetched content
 *   - "query"    when embedding the user's question
 */

export type InputType = "document" | "query";

// Keep model names in one place per the build spec — easy to swap, never
// buried deep in a request body.
const VOYAGE_MODEL = process.env.VOYAGE_MODEL ?? "voyage-3";
const OLLAMA_EMBEDDING_MODEL =
  process.env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text";

const VOYAGE_ENDPOINT = "https://api.voyageai.com/v1/embeddings";

// Both APIs accept batches; cap batch size so a large upload doesn't send one
// giant request that trips a provider-side token/size limit.
// Per-provider batch sizes. Ollama is local, so batch big. Voyage's free tier
// (no payment method on file) caps at 10K tokens/minute and 3 requests/minute,
// so keep each request comfortably under the TPM cap (~32 chunks ≈ a few K
// tokens) and pace requests below — see embed().
const OLLAMA_BATCH_SIZE = 96;
const VOYAGE_BATCH_SIZE = 32;
// Gap between Voyage batches, to stay under the free-tier request/token rate.
// Only applied between batches, so a single-batch call (e.g. a query) is instant.
const VOYAGE_INTER_BATCH_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getEmbeddingProvider(): "ollama" | "voyage" {
  return process.env.EMBEDDING_PROVIDER === "ollama" ? "ollama" : "voyage";
}

/** A short label for the active embedding config, for logs and the ingest summary. */
export function embeddingProviderLabel(): string {
  return getEmbeddingProvider() === "ollama"
    ? `ollama:${OLLAMA_EMBEDDING_MODEL}`
    : `voyage:${VOYAGE_MODEL}`;
}

/**
 * Embed a batch of texts. Returns one vector per input, in input order.
 * Vectors from different providers/models are NOT comparable — a store built
 * with one provider must be queried with the same provider (the built-in
 * corpus records which provider produced it; see scripts/ingest.ts).
 */
export async function embed(
  texts: string[],
  inputType: InputType
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const isOllama = getEmbeddingProvider() === "ollama";
  const call = isOllama ? embedWithOllama : embedWithVoyage;
  const batchSize = isOllama ? OLLAMA_BATCH_SIZE : VOYAGE_BATCH_SIZE;

  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    // Pace Voyage requests (but not before the first, and not for single-batch
    // calls) to stay within the free tier's per-minute limits.
    if (!isOllama && i > 0) await sleep(VOYAGE_INTER_BATCH_MS);
    const batch = texts.slice(i, i + batchSize);
    vectors.push(...(await call(batch, inputType)));
  }
  return vectors;
}

/** Convenience for the common single-string case (e.g. a user query). */
export async function embedOne(
  text: string,
  inputType: InputType
): Promise<number[]> {
  const [vector] = await embed([text], inputType);
  return vector;
}

// ---------------------------------------------------------------------------
// Voyage AI (production)
// ---------------------------------------------------------------------------

async function embedWithVoyage(
  texts: string[],
  inputType: InputType
): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "VOYAGE_API_KEY is not set. Add it to .env.local, or set EMBEDDING_PROVIDER=ollama for local dev."
    );
  }

  // Retry on 429 (rate limit) with backoff. The free tier is easy to trip; a
  // paid account rarely will, but transient 429s happen either way, so this is
  // the right behavior in production too — not just a free-tier workaround.
  const MAX_ATTEMPTS = 5;
  let res: Response | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = await fetch(VOYAGE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: VOYAGE_MODEL,
        input: texts,
        // The one line that makes retrieval measurably better — see file header.
        input_type: inputType,
      }),
    });

    if (res.status !== 429 || attempt === MAX_ATTEMPTS) break;

    // Honor Retry-After if present, else back off (the free tier resets on a
    // rolling ~1-minute window, so waits are in tens of seconds).
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(60_000, 20_000 * attempt);
    console.warn(
      `[embedding-provider] Voyage rate-limited (429). Waiting ${Math.round(waitMs / 1000)}s then retrying (attempt ${attempt}/${MAX_ATTEMPTS - 1})…`
    );
    await sleep(waitMs);
  }

  if (!res || !res.ok) {
    const body = res ? await res.text() : "no response";
    throw new Error(
      `Voyage embedding request failed (${res?.status ?? "?"}). ${body}`
    );
  }

  const data = (await res.json()) as {
    data: { embedding: number[]; index: number }[];
  };
  // Voyage returns an `index` on each item; sort by it so we never rely on the
  // response happening to preserve input order.
  return data.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}

// ---------------------------------------------------------------------------
// Ollama (local dev)
// ---------------------------------------------------------------------------

async function embedWithOllama(
  texts: string[],
  inputType: InputType
): Promise<number[][]> {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

  // nomic-embed-text is trained with task prefixes; using them is that model's
  // equivalent of Voyage's input_type, so we mirror the same document/query
  // distinction here rather than embedding both the same way.
  const prefix =
    inputType === "query" ? "search_query: " : "search_document: ";
  const prefixed = texts.map((t) => `${prefix}${t}`);

  const res = await fetch(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBEDDING_MODEL, input: prefixed }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Ollama embedding request failed (${res.status}). Is "ollama serve" running and has "${OLLAMA_EMBEDDING_MODEL}" been pulled (ollama pull ${OLLAMA_EMBEDDING_MODEL})? ${body}`
    );
  }

  const data = (await res.json()) as { embeddings: number[][] };
  if (!data.embeddings || data.embeddings.length !== texts.length) {
    throw new Error(
      `Ollama returned ${data.embeddings?.length ?? 0} embeddings for ${texts.length} inputs.`
    );
  }
  return data.embeddings;
}
