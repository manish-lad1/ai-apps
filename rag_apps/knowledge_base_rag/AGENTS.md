# Agent guide — Knowledge Base RAG

Project-specific context for AI coding agents. Humans should start with the [README](./README.md) — this is about *how to work on the code*.

## What this project is

A two-mode RAG app: a built-in corpus (newsletter + repo docs, pre-embedded to `data/embeddings.json`) and a session-scoped "upload your own" mode (in-memory, ephemeral). Both share one pipeline — chunk → embed → retrieve → generate — and only differ in which vector store the query hits. Don't fork the pipeline per mode; keep them sharing `chunking.ts`, `embedding-provider.ts`, `vector-store.ts`, and `prompts.ts`.

## Two abstraction seams — respect both

Everything funnels through two provider-agnostic entry points. Nothing else in the app should branch on a provider:

```
lib/llm-provider.ts       → generateText({ systemPrompt, userPrompt })   Ollama | Claude
lib/embedding-provider.ts → embed(texts, inputType)                      Ollama | Voyage
```

If you find yourself checking `LLM_PROVIDER` or `EMBEDDING_PROVIDER` anywhere outside these two files, push the logic back in. `embed()` **requires** an `inputType` ("document" for corpus/uploads, "query" for the user's question) — it's not optional and measurably affects retrieval.

## Architecture map

```
lib/
  vector-store.ts    in-memory cosine store. search(topK, minScore). THE swap point
                      if this ever needs a real ANN index — nothing else changes.
  chunking.ts        heading-aware splitter. Owns the Chunk / ChunkMetadata types.
  corpus-store.ts    loads data/embeddings.json once (cached on globalThis). Refuses
                      to use a corpus embedded with a different provider than the
                      server is running — vectors aren't comparable across models.
  session-store.ts   Map<sessionId, VectorStore> pinned to globalThis (survives dev
                      hot reload), with a TTL sweep. Ephemeral by design.
  url-fetcher.ts     SSRF guard + fetch + Readability. See "Security" below.
  prompts.ts         TOP_K, MIN_SCORE, and the grounded-answer prompt. Tune here.
scripts/ingest.ts    rerunnable; reads content/ + ../../ repo READMEs → embeddings.json
```

## Commands

```bash
npm run ingest       # (re)build data/embeddings.json — RERUN after changing content
                     # OR after switching EMBEDDING_PROVIDER
npm run dev
npm run build        # the bar before calling a change done
npx tsc --noEmit
```

## Known failure modes — check these first

1. **Empty answers from a local model.** Reasoning-capable Ollama models (gemma4) can spend the whole `num_predict` budget on hidden thinking and return empty content on longer contexts. `think: false` is set in `llm-provider.ts` for exactly this — don't remove it.
2. **Provider mismatch = silent-garbage scores.** If retrieval quality collapses after an env change, check `EMBEDDING_PROVIDER` matches what `data/embeddings.json` was built with. `corpus-store.ts` guards the built-in path; a session store built mid-session then queried after an env flip would not.
3. **Everything scores "relevant".** Embedding models have a high similarity floor, so `MIN_SCORE` rarely triggers the no-results path on its own. The prompt is the real anti-hallucination guard. Don't crank `MIN_SCORE` up to compensate without measuring — you'll drop real matches.

## Security — the SSRF guard is not optional

`url-fetcher.ts` fetches user-supplied URLs server-side. It resolves the host, rejects private/reserved IP ranges and non-HTTP(S) schemes, and **re-validates every redirect hop** (a public URL can 302 to an internal one). If you touch this file, keep all three properties. The verification pass includes pointing it at `http://localhost` and `http://169.254.169.254` and confirming both are rejected.

## Conventions

- Self-contained: `llm-provider.ts` is a local copy of the pattern from `prd_critique_agent`, deliberately **not** imported across project folders.
- Keep model names in the one config constant per provider file — don't hardcode them in request bodies.
- Don't add dependencies for what `fetch` / `JSON.parse` / native APIs already do. Current deps: Next, Tailwind, the Anthropic SDK, `@mozilla/readability` + `jsdom`, `pdf-parse`.
- `pdf-parse` is marked `serverExternalPackages` in `next.config.ts` and imported dynamically — it pulls in pdfjs and won't survive bundling otherwise.

## Verification (no automated test suite, by design)

The free path (Ollama + Ollama) covers: built-in chat with citations, the ungrounded-refusal path, URL ingest of a public article, the SSRF rejections above, and upload of md/txt/pdf. The **production path (Voyage embeddings + Claude generation) needs real API keys** — verify it end-to-end before considering a provider-affecting change done.
