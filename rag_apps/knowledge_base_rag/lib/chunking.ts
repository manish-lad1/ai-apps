/**
 * Heading-aware chunker for Markdown and plain text.
 *
 * The whole point of chunking for RAG is to cut a document into pieces small
 * enough to embed precisely, but large enough that each piece still means
 * something on its own. Two rules drive the design here:
 *
 *   1. Split on Markdown heading boundaries first (## / ###). A heading is the
 *      author telling you where one idea ends and the next begins — respecting
 *      that produces far cleaner chunks than blind fixed-size slicing, and it
 *      lets a citation say *which section* an answer came from.
 *   2. Within a long section, fall back to packing paragraphs (then sentences)
 *      up to a target size, with a little overlap carried between adjacent
 *      chunks so a fact that straddles a boundary isn't lost to either side.
 *
 * Token counts are estimated, not tokenized — at ~4 characters per token this
 * is close enough to size chunks sensibly without pulling in a tokenizer
 * dependency the project otherwise doesn't need.
 */

export type SourceType = "newsletter" | "repo-doc" | "upload" | "url";

export type ChunkMetadata = {
  /** Human-readable document title, used in citations. */
  sourceTitle: string;
  /** URL or file path back to the source, used to make citations clickable. */
  sourceUrl: string;
  sourceType: SourceType;
  /** The heading this chunk fell under, when the document had sections. */
  heading?: string;
};

export type Chunk = {
  id: string;
  text: string;
  metadata: ChunkMetadata;
};

/** ~4 chars per token is the usual rough rule for English text. */
const CHARS_PER_TOKEN = 4;

// Sizing, expressed in characters (see estimateTokens for the token view).
const TARGET_CHARS = 1800; // ~450 tokens — the size we aim each chunk to be
const MAX_CHARS = 2400; // ~600 tokens — a hard ceiling before we force a split
const OVERLAP_CHARS = 200; // ~50 tokens — carried from one chunk into the next

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

type Section = { heading?: string; body: string };

/**
 * Split a document into sections on ATX headings (##, ###, …). The text before
 * the first heading (a preamble, or the whole doc if it has no headings) becomes
 * a leading section with no heading.
 */
function splitIntoSections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let currentHeading: string | undefined;
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body.length > 0 || currentHeading) {
      sections.push({ heading: currentHeading, body });
    }
    buffer = [];
  };

  for (const line of lines) {
    // Match ## through ###### — but not a single # (a document title), which we
    // leave attached to the preamble rather than treating as a section break.
    const headingMatch = /^(#{2,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[2].trim();
    } else {
      buffer.push(line);
    }
  }
  flush();

  return sections;
}

/** Grab the last ~OVERLAP_CHARS of a chunk, snapped to a word boundary. */
function overlapTail(text: string): string {
  if (text.length <= OVERLAP_CHARS) return text;
  const tail = text.slice(text.length - OVERLAP_CHARS);
  const firstSpace = tail.indexOf(" ");
  return firstSpace === -1 ? tail : tail.slice(firstSpace + 1);
}

/** Split an over-long paragraph into target-sized pieces on sentence boundaries. */
function splitLongParagraph(paragraph: string): string[] {
  const sentences = paragraph.split(/(?<=[.!?])\s+/);
  const pieces: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length + 1 > TARGET_CHARS) {
      pieces.push(current.trim());
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

/** Pack a section's paragraphs into overlapping, target-sized chunk bodies. */
function chunkSectionBody(body: string): string[] {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const bodies: string[] = [];
  let current = "";

  const push = () => {
    if (current.trim()) bodies.push(current.trim());
  };

  for (const paragraph of paragraphs) {
    // A single paragraph bigger than the ceiling has to be broken on sentences.
    if (paragraph.length > MAX_CHARS) {
      push();
      current = "";
      for (const piece of splitLongParagraph(paragraph)) bodies.push(piece);
      continue;
    }

    if (current && current.length + paragraph.length + 2 > TARGET_CHARS) {
      push();
      // Start the next chunk with a little tail of the previous one so context
      // that spans the boundary survives on both sides.
      current = `${overlapTail(current)}\n\n${paragraph}`;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  push();

  return bodies;
}

/**
 * Chunk one document. `idPrefix` should be unique per document (e.g. a slug) so
 * chunk ids don't collide across documents in the same store.
 */
export function chunkDocument(
  text: string,
  metadata: Omit<ChunkMetadata, "heading">,
  idPrefix: string
): Chunk[] {
  const sections = splitIntoSections(text);
  const chunks: Chunk[] = [];
  let index = 0;

  for (const section of sections) {
    const bodies = chunkSectionBody(section.body);
    for (const body of bodies) {
      // Prepend the heading into the embedded text too — it's real semantic
      // signal ("Flaw-based scoring" tells the embedder what this chunk is
      // about), not just citation decoration.
      const text = section.heading ? `${section.heading}\n\n${body}` : body;
      chunks.push({
        id: `${idPrefix}-${index}`,
        text,
        metadata: { ...metadata, heading: section.heading },
      });
      index += 1;
    }
  }

  return chunks;
}
