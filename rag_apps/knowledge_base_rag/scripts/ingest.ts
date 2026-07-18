/**
 * One-shot (rerunnable) ingestion for the built-in corpus.
 *
 *   1. Read newsletter articles from content/newsletter/*.md (frontmatter →
 *      title/date/url).
 *   2. Walk the parent ai-apps repo's README.md files (root + each project).
 *   3. Chunk each document (heading-aware), embed every chunk with
 *      input_type="document", and write data/embeddings.json.
 *
 * Rerunnable idempotently — it just overwrites data/embeddings.json. Prints a
 * summary (chunk count, token estimate, provider used) at the end.
 *
 * Run with:  npm run ingest         (EMBEDDING_PROVIDER comes from .env.local)
 *   free dev: EMBEDDING_PROVIDER=ollama npm run ingest
 */

import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { chunkDocument, estimateTokens, type Chunk } from "../lib/chunking";
import {
  embed,
  embeddingProviderLabel,
  getEmbeddingProvider,
} from "../lib/embedding-provider";

// Load env from .env.local if present (tsx doesn't do this automatically).
try {
  process.loadEnvFile(path.join(process.cwd(), ".env.local"));
} catch {
  // No .env.local — rely on inline/exported env vars. Fine for the ollama path.
}

const PROJECT_ROOT = process.cwd();
const NEWSLETTER_DIR = path.join(PROJECT_ROOT, "content", "newsletter");
const REPO_ROOT = path.join(PROJECT_ROOT, "..", ".."); // rag_apps/knowledge_base_rag → ai-apps
const OUTPUT_PATH = path.join(PROJECT_ROOT, "data", "embeddings.json");

const IGNORE_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  ".claude",
  "out",
  "build",
  "coverage",
]);

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Minimal YAML-ish frontmatter parser — enough for title/date/url string values. */
function parseFrontmatter(raw: string): {
  data: Record<string, string>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { data: {}, body: raw };
  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { data, body: match[2] };
}

async function ingestNewsletter(): Promise<Chunk[]> {
  let files: string[] = [];
  try {
    files = (await readdir(NEWSLETTER_DIR)).filter((f) => f.endsWith(".md"));
  } catch {
    console.warn(`No ${NEWSLETTER_DIR} directory — skipping newsletter.`);
    return [];
  }

  const chunks: Chunk[] = [];
  for (const file of files) {
    const raw = await readFile(path.join(NEWSLETTER_DIR, file), "utf-8");
    const { data, body } = parseFrontmatter(raw);
    const title = data.title || file.replace(/\.md$/, "");
    const url = data.url || `content/newsletter/${file}`;
    const docChunks = chunkDocument(
      body,
      { sourceTitle: title, sourceUrl: url, sourceType: "newsletter" },
      slugify(file.replace(/\.md$/, ""))
    );
    chunks.push(...docChunks);
    console.log(`  newsletter: "${title}" → ${docChunks.length} chunks`);
  }
  return chunks;
}

/** Recursively collect README.md paths under the repo root, skipping noise dirs. */
async function findReadmes(dir: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      found.push(...(await findReadmes(path.join(dir, entry.name), depth + 1)));
    } else if (entry.name.toLowerCase() === "readme.md") {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

async function ingestRepoDocs(): Promise<Chunk[]> {
  let repoExists = false;
  try {
    repoExists = (await stat(REPO_ROOT)).isDirectory();
  } catch {
    repoExists = false;
  }
  if (!repoExists) {
    console.warn(`No repo root at ${REPO_ROOT} — skipping repo docs.`);
    return [];
  }

  const readmes = await findReadmes(REPO_ROOT);
  const chunks: Chunk[] = [];
  for (const absPath of readmes) {
    const relPath = path.relative(REPO_ROOT, absPath);
    const raw = await readFile(absPath, "utf-8");
    if (raw.trim().length === 0) continue;
    // Prefer the first level-1 heading as the title; fall back to the path.
    const h1 = /^#\s+(.+)$/m.exec(raw);
    const title = h1 ? h1[1].trim() : relPath;
    const docChunks = chunkDocument(
      raw,
      { sourceTitle: title, sourceUrl: relPath, sourceType: "repo-doc" },
      slugify(relPath)
    );
    chunks.push(...docChunks);
    console.log(`  repo-doc: ${relPath} → ${docChunks.length} chunks`);
  }
  return chunks;
}

async function main() {
  const provider = getEmbeddingProvider();
  console.log(`\nIngesting built-in corpus with ${embeddingProviderLabel()}\n`);

  console.log("Reading sources:");
  const newsletterChunks = await ingestNewsletter();
  const repoChunks = await ingestRepoDocs();
  const chunks = [...newsletterChunks, ...repoChunks];

  if (chunks.length === 0) {
    console.error("\nNo content found to ingest. Aborting.");
    process.exit(1);
  }

  const totalTokens = chunks.reduce((sum, c) => sum + estimateTokens(c.text), 0);
  console.log(
    `\nEmbedding ${chunks.length} chunks (~${totalTokens.toLocaleString()} tokens)…`
  );

  const vectors = await embed(
    chunks.map((c) => c.text),
    "document"
  );

  const model =
    provider === "voyage"
      ? process.env.VOYAGE_MODEL ?? "voyage-3"
      : process.env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text";

  const output = {
    provider,
    model,
    generatedAt: new Date().toISOString(),
    chunkCount: chunks.length,
    chunks: chunks.map((c, i) => ({
      id: c.id,
      text: c.text,
      vector: vectors[i],
      metadata: c.metadata,
    })),
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output));

  const dims = vectors[0]?.length ?? 0;
  console.log(`\n✓ Wrote ${OUTPUT_PATH}`);
  console.log(`  provider:   ${provider} (${model})`);
  console.log(`  chunks:     ${chunks.length}`);
  console.log(`  dimensions: ${dims}`);
  console.log(`  ~tokens:    ${totalTokens.toLocaleString()}`);
  console.log(
    `  sources:    ${new Set(chunks.map((c) => c.metadata.sourceUrl)).size}\n`
  );
}

main().catch((err) => {
  console.error("\nIngestion failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
