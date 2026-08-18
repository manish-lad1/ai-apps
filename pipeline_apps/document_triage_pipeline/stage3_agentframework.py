"""Stage 3, answered through Microsoft Agent Framework — and held in conversation.

The rest of this project deliberately does not use Agent Framework, because its
tool calling does not work against Foundry Local 0.10.3. This module is the
other half of that finding: for generation, which is all Stage 3 needs, the
framework works — and it brings something the raw path does not have.

What it brings is conversation. The raw engine is stateless: every question
builds a fresh message list, so "and what was the VAT on it?" means nothing to
it. This engine keeps an AgentSession, so a follow-up resolves against what was
already asked. That is the difference the demo is built to show.

Two details make multi-turn RAG work, and both were measured rather than
assumed:

  * The retrieval query is conversation-aware. A follow-up embedded on its own
    is a poor search: "and what was the VAT on it?" retrieved VAT-shaped chunks
    from three unrelated invoices. Prepending the previous question lifted the
    right document from 0.339 to 0.591. Retrieval has no memory of its own, so
    it has to be given one.

  * The model is phi-4-mini, the same model the raw engine uses. That is
    deliberate twice over. It keeps the comparison honest — same model on both
    sides means any difference is the framework, not the weights. And it is the
    only one that survives: qwen3-4b answered turn two correctly and then
    collapsed on turn three into "The question is not the question" repeated
    until it hit the token ceiling, 62 seconds in. Agent Framework's
    ContextWindowCompactionStrategy did not rescue it either; that run never
    finished at all.

Latency grows with the conversation, because the history grows: roughly 8s on
the first question and 28s by the fourth. That is visible in the UI on purpose.
"""

from __future__ import annotations

import asyncio
import threading

from agent_framework import Agent, AgentSession
from agent_framework.openai import OpenAIChatCompletionClient

import stage2_index
import stage3_ask
from foundry_endpoint import CHAT_ALIAS, EMBEDDING_ALIAS, connect, ensure_loaded
from model_call import strip_reasoning
from schemas import Index

# The grounding contract is shared with the raw engine on purpose. If the two
# engines used different prompts, a difference in their answers would tell you
# nothing about the engines.
INSTRUCTIONS = stage3_ask.SYSTEM_PROMPT


class AgentFrameworkAnswerer:
    """Agent Framework driving Stage 3, with conversation held across turns."""

    def __init__(self, alias: str = CHAT_ALIAS):
        self.alias = alias
        self._agent: Agent | None = None
        self._session: AgentSession | None = None
        # One event loop, on its own thread, for the lifetime of the agent.
        #
        # Two wrong versions of this preceded the right one. asyncio.run() per
        # question closes the loop when it returns while the framework's HTTP
        # client stays bound to the first loop it saw: turns one and two
        # worked and turn three hung forever. Keeping a loop but calling
        # run_until_complete on it was worse, because the web server answers
        # each request on a different worker thread and an event loop cannot
        # be driven from more than one. A loop pinned to its own thread, fed
        # with run_coroutine_threadsafe, is the version that works.
        self._loop: asyncio.AbstractEventLoop | None = None
        self._loop_thread: threading.Thread | None = None
        self._call_lock = threading.Lock()
        self._embed_client = None
        self._embed_model_id = ""
        self.chat_model_id = ""
        self.turns = 0
        self._previous_question: str | None = None

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
        # /v1/responses, where Foundry Local returns tool calls with their
        # arguments stripped.
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
        self._session = AgentSession()
        self._start_loop()

    def _start_loop(self) -> None:
        """Run an event loop on a dedicated daemon thread."""
        self._loop = asyncio.new_event_loop()
        self._loop_thread = threading.Thread(
            target=self._loop.run_forever, name="agent-framework-loop", daemon=True
        )
        self._loop_thread.start()

    def reset(self) -> None:
        """Start a new conversation, keeping the loaded models and the loop."""
        self._session = AgentSession() if self._agent is not None else None
        self.turns = 0
        self._previous_question = None

    def _retrieval_query(self, question: str) -> str:
        """Give retrieval the memory it does not have of its own."""
        if self._previous_question is None:
            return question
        return f"{self._previous_question} {question}"

    def ask(self, question: str, index: Index, *, top_k: int = stage3_ask.TOP_K):
        """Answer one question in the ongoing conversation."""
        self.open()

        query_vector = self._embed_client.embeddings.create(
            model=self._embed_model_id, input=[self._retrieval_query(question)]
        ).data[0].embedding

        retrieved = stage2_index.search(index, query_vector, top_k)
        if not retrieved:
            return stage3_ask.Answer(question=question, text=stage3_ask.NOT_FOUND)

        context = stage3_ask._build_context(retrieved)
        prompt = f"Context passages:\n\n{context}\n\nQuestion: {question}"

        # Agent.run is async; Stage 3 is called from synchronous code. The
        # coroutine is handed to the agent's own loop thread and waited on
        # here. The lock keeps concurrent questions from interleaving turns
        # of the same conversation.
        with self._call_lock:
            future = asyncio.run_coroutine_threadsafe(
                self._agent.run(prompt, session=self._session), self._loop
            )
            result = future.result(timeout=300)

        self.turns += 1
        self._previous_question = question

        # qwen3 emits reasoning tokens the endpoint does not strip. phi-4-mini
        # does not, but the helper is cheap and keeps the engines comparable.
        text = strip_reasoning(result.text or "")

        return stage3_ask.Answer(
            question=question,
            text=stage3_ask._normalise_refusal(text),
            sources=[chunk.filename for chunk, _ in retrieved],
            scores=[round(score, 3) for _, score in retrieved],
        )
