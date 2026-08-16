"""Stage 2 - chunk every document, embed the chunks locally, persist the index.

Reads output/manifest.json so each chunk carries its Stage 1 classification
forward, then writes output/index.json so Stage 3 can run on its own.

Ten documents do not need a vector database. The whole index is a JSON file
and retrieval is a cosine sort in memory — that is the honest engineering
choice at this size, and it keeps the demo dependency-free.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import console
import tools
from foundry_endpoint import EMBEDDING_ALIAS, connect, ensure_loaded
from schemas import Chunk, DocumentType, Index, Manifest

# Chunk sizing. Tokens are approximated as characters/4, which is close enough
# for English prose and avoids pulling in a tokeniser just to split text.
CHARS_PER_TOKEN = 4
TARGET_TOKENS = 400
MAX_TOKENS = 500
OVERLAP_TOKENS = 60

MAX_CHUNK_CHARS = MAX_TOKENS * CHARS_PER_TOKEN
OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN

# The embedding endpoint accepts a list, but a long list on a 0.6b model is
# slower to first output and gives no progress feedback. Small batches keep
# the progress bar moving.
BATCH_SIZE = 4


def split_into_chunks(text: str) -> list[str]:
    """Split on paragraph boundaries into roughly TARGET_TOKENS pieces.

    Paragraphs are never broken mid-way unless a single paragraph is itself
    over the cap, which keeps invoice tables and clause blocks intact.
    """
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    if not paragraphs:
        return []

    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    for paragraph in paragraphs:
        # A single oversized paragraph becomes its own chunk, hard-split.
        if len(paragraph) > MAX_CHUNK_CHARS:
            if current:
                chunks.append("\n\n".join(current))
                current, current_len = [], 0
            for start in range(0, len(paragraph), MAX_CHUNK_CHARS):
                chunks.append(paragraph[start : start + MAX_CHUNK_CHARS])
            continue

        if current_len + len(paragraph) > TARGET_TOKENS * CHARS_PER_TOKEN and current:
            chunks.append("\n\n".join(current))
            # Carry the tail of the finished chunk into the next one so a fact
            # split across the boundary is still retrievable from both sides.
            tail = "\n\n".join(current)[-OVERLAP_CHARS:]
            current = [tail, paragraph]
            current_len = len(tail) + len(paragraph)
        else:
            current.append(paragraph)
            current_len += len(paragraph)

    if current:
        chunks.append("\n\n".join(current))

    return chunks


def embed_batch(client, model_id: str, texts: list[str]) -> list[list[float]]:
    response = client.embeddings.create(model=model_id, input=texts)
    return [item.embedding for item in response.data]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


def run(
    documents_dir: Path,
    manifest_path: Path,
    index_path: Path,
    *,
    quiet: bool = False,
) -> Index:
    """Chunk, embed, and persist. Requires Stage 1 to have run."""
    if not quiet:
        console.stage_header(2, "CHUNK, EMBED, INDEX")

    if not manifest_path.exists():
        raise FileNotFoundError(
            f"{manifest_path} not found. Run stage 1 first: python run_demo.py --stage 1"
        )

    manifest = Manifest.model_validate_json(manifest_path.read_text(encoding="utf-8"))
    by_filename = {record.filename: record for record in manifest.records}

    client, model_id, base_url = connect(EMBEDDING_ALIAS)
    if not quiet:
        console.info(f"Service: {base_url}")
        console.info(f"Model:   {model_id}")
        console.loading_notice(model_id)
    ensure_loaded(model_id)

    # Build every chunk first so the progress bar has a real total.
    pending: list[tuple[str, str]] = []  # (filename, chunk text)
    for filename in tools.list_files(documents_dir):
        text = tools.read_file(documents_dir, filename)
        for piece in split_into_chunks(text):
            pending.append((filename, piece))

    if not quiet:
        console.info(
            f"{len(pending)} chunks from {len(by_filename)} triaged documents"
        )
        console.section("Embedding")

    index = Index(embedding_model_id=model_id, dimensions=0)

    for start in range(0, len(pending), BATCH_SIZE):
        batch = pending[start : start + BATCH_SIZE]
        vectors = embed_batch(client, model_id, [text for _, text in batch])

        for offset, ((filename, text), vector) in enumerate(zip(batch, vectors)):
            record = by_filename.get(filename)
            index.chunks.append(
                Chunk(
                    chunk_id=f"{filename}#{start + offset}",
                    filename=filename,
                    text=text,
                    embedding=vector,
                    # Stage 1's judgement travels with the chunk, so Stage 3
                    # can show the document type alongside an answer.
                    document_type=record.document_type if record else DocumentType.UNKNOWN,
                    contains_pii=record.contains_pii if record else False,
                )
            )

        if not quiet:
            done = min(start + BATCH_SIZE, len(pending))
            console.progress(done, len(pending), batch[-1][0])

    index.dimensions = len(index.chunks[0].embedding) if index.chunks else 0

    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(index.model_dump_json(indent=2), encoding="utf-8")

    if not quiet:
        console.section("Result")
        console.info(f"{len(index.chunks)} chunks at {index.dimensions} dimensions")
        size_kb = index_path.stat().st_size / 1024
        console.info(f"Written to {console.rel(index_path)} ({size_kb:.0f} KB)")

    return index


def load_index(index_path: Path) -> Index:
    if not index_path.exists():
        raise FileNotFoundError(
            f"{index_path} not found. Run stage 2 first: python run_demo.py --stage 2"
        )
    return Index.model_validate_json(index_path.read_text(encoding="utf-8"))


def search(index: Index, query_vector: list[float], top_k: int) -> list[tuple[Chunk, float]]:
    """Rank every chunk by cosine similarity. Linear is fine at this size."""
    scored = [
        (chunk, cosine_similarity(query_vector, chunk.embedding))
        for chunk in index.chunks
    ]
    scored.sort(key=lambda pair: pair[1], reverse=True)
    return scored[:top_k]
