"""Stage 3, answered through Microsoft Agent Framework instead of the raw client.

The rest of this project deliberately does not use Agent Framework, because
its tool calling does not work against Foundry Local 0.10.3. This module is
the other half of that finding: for plain generation, which is all Stage 3
needs, the framework works perfectly well against the same local endpoint.

Retrieval is unchanged — the same embeddings, the same cosine search, the
same top-k context, the same grounding contract. Only the thing that turns
context into an answer differs. That makes the two engines directly
comparable: same question, same passages, two stacks.

Why the framework can drive this stage but not Stage 1:

    Stage 3 asks the model for prose. Stage 1 asks it for a structured tool
    call, and Foundry Local's /v1/responses endpoint returns tool calls with
    their arguments stripped — `{"name": "read_file", "arguments": "{}"}` —
    so Agent Framework invokes the function with nothing in it. There is no
    prompt that fixes an argument that never arrived.

Which model, and why it differs from the raw path:

    Agent Framework is pointed at qwen3-4b rather than phi-4-mini. That is
    not arbitrary. qwen3-4b is a reasoning model and emits a <think> block
    before its answer, which Foundry does not strip, so the framework path
    needs cleaning up that the raw path does not. It is also roughly three
    times slower. Both of those are visible in the UI on purpose.
"""

from __future__ import annotations

import asyncio

from agent_framework import Agent
from agent_framework.openai import OpenAIChatCompletionClient

import stage2_index
import stage3_ask
from foundry_endpoint import (
    CHAT_COMPARISON_ALIAS,
    EMBEDDING_ALIAS,
    connect,
    ensure_loaded,
)
from model_call import strip_reasoning
from schemas import Index

# The grounding contract is shared with the raw engine on purpose. If the two
# engines used different prompts, a difference in their answers would tell you
# nothing about the engines.
INSTRUCTIONS = stage3_ask.SYSTEM_PROMPT


class AgentFrameworkAnswerer:
    """Holds the framework agent and the embedding client between questions."""

    def __init__(self, alias: str = CHAT_COMPARISON_ALIAS):
        self.alias = alias
        self._agent: Agent | None = None
        self._embed_client = None
        self._embed_model_id = ""
        self.chat_model_id = ""

    def open(self) -> None:
        """Resolve both models and build the agent. Safe to call repeatedly."""
        if self._agent is not None:
            return

        _, chat_model_id, base_url = connect(self.alias)
        ensure_loaded(chat_model_id)
        self.chat_model_id = chat_model_id

        embed_client, embed_model_id, _ = connect(EMBEDDING_ALIAS)
        ensure_loaded(embed_model_id)
        self._embed_client = embed_client
        self._embed_model_id = embed_model_id

        # OpenAIChatCompletionClient, not OpenAIChatClient. The latter targets
        # /v1/responses, which Foundry Local implements only partially.
        client = OpenAIChatCompletionClient(
            model=chat_model_id,
            base_url=f"{base_url}/v1",
            api_key="not-needed-for-local",
        )
        self._agent = Agent(
            client=client,
            name="GroundedAnswerer",
            instructions=INSTRUCTIONS,
        )

    def ask(self, question: str, index: Index, *, top_k: int = stage3_ask.TOP_K):
        """Answer one question. Same retrieval, framework-driven generation."""
        self.open()

        query_vector = self._embed_client.embeddings.create(
            model=self._embed_model_id, input=[question]
        ).data[0].embedding

        retrieved = stage2_index.search(index, query_vector, top_k)
        if not retrieved:
            return stage3_ask.Answer(question=question, text=stage3_ask.NOT_FOUND)

        context = stage3_ask._build_context(retrieved)
        prompt = f"Context passages:\n\n{context}\n\nQuestion: {question}"

        # Agent.run is async; Stage 3 is called from synchronous code, so the
        # loop is owned here rather than pushed onto every caller.
        result = asyncio.run(self._agent.run(prompt))

        # qwen3 emits reasoning tokens that the endpoint does not strip. The
        # raw engine has the same helper for the same reason.
        text = strip_reasoning(result.text or "")

        return stage3_ask.Answer(
            question=question,
            text=stage3_ask._normalise_refusal(text),
            sources=[chunk.filename for chunk, _ in retrieved],
            scores=[round(score, 3) for _, score in retrieved],
        )
