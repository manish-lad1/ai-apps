"""Chat clients per role, agents with call counting, and the one-retry JSON call.

Foundry Local goes through OpenAIChatCompletionClient (/v1/chat/completions).
Not OpenAIChatClient: that one targets /v1/responses, which the triage project
found unreliable against Foundry Local. Ollama goes through OllamaChatClient,
and is only a fallback for 12b-class roles.

No agent here is given tools. Structured output is JSON in the reply text,
validated by schemas.parse_reply, with exactly one retry on a bad reply.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from typing import Any

from pydantic import BaseModel

from agent_framework import Agent, AgentSession, Message, chat_middleware

from config import ModelSpec, Settings
from foundry_endpoint import LOCAL_API_KEY, connect, ensure_loaded
from readout import CallCounter
from schemas import ReplyError, parse_reply

DEFAULT_MAX_TOKENS = 1500

_clients: dict[ModelSpec, Any] = {}


def concurrency_gate(limit: int):
    """Chat middleware: at most `limit` requests in flight across every client sharing it.

    Measured in Phase 1: four concurrent requests crashed the Foundry Local
    0.10.3 daemon (SIGSEGV in ONNX Runtime's WebGPU backend) in 2 of 5 runs,
    and gave no speed-up over sequential (25.0s vs 25.3s). The pipeline still
    fans out with the framework's concurrent orchestration; the gate only
    queues the HTTP calls. One semaphore per event loop, so tests that each
    run their own loop do not share a semaphore bound to a dead loop.
    """
    semaphores: dict[int, asyncio.Semaphore] = {}

    @chat_middleware
    async def gate(context, call_next):
        loop_id = id(asyncio.get_running_loop())
        semaphore = semaphores.setdefault(loop_id, asyncio.Semaphore(limit))
        async with semaphore:
            await call_next()

    return gate


_foundry_gate = None


def peer_view(me: str, turn_prompt: str = "Your turn, {me}. This is ROUND {round}. Reply with JSON only."):
    """Chat middleware for group chat members: show peers' turns as attributed user turns.

    Measured in the Phase 0 spike: the group chat hands each agent its peers'
    turns as role=assistant, so the conversation ends on an assistant turn
    and mistral-nemo replied with an empty string on 7 of 8 turns. This
    rewrites peer turns as `[lens.x] said: ...` user messages, merges runs of
    one role (the Mistral template expects user/assistant alternation), and
    ends on a user turn naming the speaker and round. The agent's own earlier
    turns stay as assistant turns, which is how the round number is counted.
    """

    @chat_middleware
    async def rewrite(context, call_next):
        turns: list[tuple[str, str]] = []
        own_turns = 0
        for m in context.messages:
            role, text = str(m.role), m.text or ""
            if role == "assistant" and m.author_name not in (None, me):
                role, text = "user", f"[{m.author_name}] said:\n{text}"
            elif role == "assistant":
                own_turns += 1
            if turns and turns[-1][0] == role and role != "system":
                turns[-1] = (role, f"{turns[-1][1]}\n\n{text}")
            else:
                turns.append((role, text))
        nudge = turn_prompt.format(me=me, round=own_turns + 1)
        if turns and turns[-1][0] == "user":
            turns[-1] = ("user", f"{turns[-1][1]}\n\n{nudge}")
        else:
            turns.append(("user", nudge))
        context.messages[:] = [Message(role, [text]) for role, text in turns]
        await call_next()

    return rewrite


def build_chat_client(spec: ModelSpec, settings: Settings, *, load: bool = True) -> Any:
    """One chat client per model spec, reused across agents. Loads Foundry models on first use."""
    global _foundry_gate
    if spec in _clients:
        return _clients[spec]
    if spec.provider == "foundry":
        from agent_framework.openai import OpenAIChatCompletionClient

        base_url, model_id = connect(spec.model)
        if load:
            ensure_loaded(model_id)
        # One gate for every Foundry model: the daemon is one process.
        _foundry_gate = _foundry_gate or concurrency_gate(settings.foundry_max_concurrency)
        client = OpenAIChatCompletionClient(
            model=model_id, base_url=f"{base_url}/v1", api_key=LOCAL_API_KEY, middleware=[_foundry_gate]
        )
    elif spec.provider == "ollama":
        from agent_framework.ollama import OllamaChatClient

        client = OllamaChatClient(model=spec.model)
    else:  # config.ModelSpec.parse already rejects this; kept for direct callers
        raise ValueError(f"Unknown provider {spec.provider!r}")
    _clients[spec] = client
    return client


def make_agent(
    name: str,
    instructions: str,
    *,
    client: Any,
    settings: Settings,
    counter: CallCounter,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    middleware: Sequence[Any] = (),
) -> Agent:
    """An agent with temperature from settings and every chat completion counted."""
    return Agent(
        client,
        instructions,
        name=name,
        default_options={"temperature": settings.temperature, "max_tokens": max_tokens},
        middleware=[counter.middleware(name), *middleware],
    )


async def ask_json[M: BaseModel](
    agent: Agent,
    prompt: str,
    model: type[M],
    *,
    context: dict | None = None,
    session: AgentSession | None = None,
) -> M:
    """Run the agent and validate its reply as `model`, retrying once on an invalid reply.

    The retry goes into the same session, so the model sees its own bad reply
    and the validation problems. A second failure raises ReplyError with both
    problems; callers decide how to surface it rather than guessing a value.
    """
    session = session or AgentSession()
    first = await agent.run(prompt, session=session)
    try:
        return parse_reply(model, first.text, context)
    except ReplyError as problem:
        retry = (
            f"Your reply was not valid: {problem}. "
            "Reply again with corrected JSON only, in the same shape."
        )
        second = await agent.run(retry, session=session)
        try:
            return parse_reply(model, second.text, context)
        except ReplyError as again:
            excerpt = " ".join((second.text or "").split())[:160]
            raise ReplyError(
                f"{agent.name}: invalid after one retry. First: {problem}. Retry: {again}. Reply was: {excerpt!r}"
            ) from again
