"""Stage 3 - answer questions across the indexed collection, or refuse.

Two things are non-negotiable here and both get demonstrated live:

  * The answer must come from retrieved context. If the context does not
    contain it, the reply is exactly NOT FOUND.
  * Every answer prints the source filename beside it, so the audience can
    check the answer against the document themselves.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import console
import stage2_index
from foundry_endpoint import CHAT_ALIAS, EMBEDDING_ALIAS, connect, ensure_loaded
from model_call import ask_text
from schemas import Index

TOP_K = 4

NOT_FOUND = "NOT FOUND"

SYSTEM_PROMPT = f"""You answer questions about a collection of documents.

You may use ONLY the numbered context passages provided in the user message.
Do not use any other knowledge. Do not guess, infer beyond what is written,
or fill gaps from what is typical.

Check that the passage you are answering from is about the exact subject the
question names. Retrieval returns passages that are merely similar, so the
context will often contain the right KIND of fact about the WRONG person,
organisation, or document. A home address belonging to a different person is
not this person's address. If no passage states the fact for the subject
actually asked about, that fact is not in the context.

If the passages do not contain the answer, reply with exactly:
{NOT_FOUND}

Nothing else — no apology, no explanation, no suggestion of where to look.

If the passages do contain the answer, give it in one short sentence. Quote
figures, dates, and references exactly as they appear."""


@dataclass
class Answer:
    question: str
    text: str
    sources: list[str] = field(default_factory=list)
    scores: list[float] = field(default_factory=list)

    @property
    def refused(self) -> bool:
        return self.text.strip().upper().startswith(NOT_FOUND)


def _build_context(retrieved) -> str:
    """Number each passage and label it with its filename.

    The filename is inside the context on purpose: it lets the model attribute
    an answer, and it is what makes a cross-document question answerable.
    """
    blocks = []
    for position, (chunk, _score) in enumerate(retrieved, start=1):
        blocks.append(f"[{position}] Source: {chunk.filename}\n{chunk.text}")
    return "\n\n".join(blocks)


def _normalise_refusal(text: str) -> str:
    """Collapse near-misses onto the exact refusal string.

    Small models like to write "NOT FOUND." or wrap it in a sentence. The
    guarantee the demo makes is about the contract, not the punctuation.
    """
    stripped = text.strip()
    if NOT_FOUND in stripped.upper() and len(stripped) < 80:
        return NOT_FOUND
    return stripped


def ask(
    question: str,
    index: Index,
    chat_client,
    chat_model_id: str,
    embed_client,
    embed_model_id: str,
    *,
    top_k: int = TOP_K,
) -> Answer:
    """Retrieve, then answer strictly from what was retrieved."""
    query_vector = embed_client.embeddings.create(
        model=embed_model_id, input=[question]
    ).data[0].embedding

    retrieved = stage2_index.search(index, query_vector, top_k)
    if not retrieved:
        return Answer(question=question, text=NOT_FOUND)

    context = _build_context(retrieved)
    reply = ask_text(
        chat_client,
        chat_model_id,
        [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"Context passages:\n\n{context}\n\nQuestion: {question}",
            },
        ],
        max_tokens=400,
    )

    answer = Answer(
        question=question,
        text=_normalise_refusal(reply),
        sources=[chunk.filename for chunk, _ in retrieved],
        scores=[round(score, 3) for _, score in retrieved],
    )
    return answer


def print_answer(answer: Answer) -> None:
    """Question, answer, and the sources it came from."""
    print()
    console.info(f"Q: {answer.question}")
    console.info(f"A: {answer.text}")
    if answer.refused:
        console.info("   (nothing in the retrieved context supports an answer)")
    else:
        # Deduplicate while preserving rank order.
        seen: list[str] = []
        for name in answer.sources:
            if name not in seen:
                seen.append(name)
        console.info(f"   Sources: {', '.join(seen)}")


def open_clients(alias: str = CHAT_ALIAS, *, quiet: bool = False):
    """Bring up both models Stage 3 needs: one to embed, one to answer."""
    chat_client, chat_model_id, base_url = connect(alias)
    embed_client, embed_model_id, _ = connect(EMBEDDING_ALIAS)

    if not quiet:
        console.info(f"Service: {base_url}")
        console.info(f"Chat:    {chat_model_id}")
        console.info(f"Embed:   {embed_model_id}")
        console.loading_notice(f"{chat_model_id} + {embed_model_id}")

    ensure_loaded(chat_model_id)
    ensure_loaded(embed_model_id)
    return chat_client, chat_model_id, embed_client, embed_model_id


def run(
    index_path: Path,
    questions: list[str],
    *,
    alias: str = CHAT_ALIAS,
    quiet: bool = False,
) -> list[Answer]:
    """Answer a list of questions against the persisted index."""
    if not quiet:
        console.stage_header(3, "ASK")

    index = stage2_index.load_index(index_path)
    chat_client, chat_model_id, embed_client, embed_model_id = open_clients(
        alias, quiet=quiet
    )

    if not quiet:
        console.info(f"Index:   {len(index.chunks)} chunks, top-{TOP_K} retrieval")
        console.section("Questions")

    answers = []
    for question in questions:
        answer = ask(
            question, index, chat_client, chat_model_id, embed_client, embed_model_id
        )
        answers.append(answer)
        if not quiet:
            print_answer(answer)

    return answers
