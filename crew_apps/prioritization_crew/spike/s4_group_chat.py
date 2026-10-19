"""Spike step 5: a minimal 2-round group chat between four lens agents.

Usage: python s4_group_chat.py <alias> [ollama]

GroupChatBuilder with a plain-code round-robin selection_func (no model picks
the speaker) and max_rounds = 4 lenses x 2 rounds. The question being tested:
in round 2, do agents rebut each other BY LENS NAME and engage with what that
lens actually said, or just restate their own view?

Scored two ways: mechanically (round-2 JSON parses as CrewPosition; every
`to_lens` names a different, real lens) and by reading the transcript, which
is saved in full to results/.
"""

import asyncio
import json
import sys
import time
from typing import Literal

from pydantic import BaseModel, Field

from agent_framework import Agent, Message, chat_middleware
from agent_framework.orchestrations import GroupChatBuilder

from common import BACKLOG, LENSES, LOCAL_API_KEY, base_url, extract_json, load, resolve, save

alias = sys.argv[1]
provider = sys.argv[2] if len(sys.argv) > 2 else "foundry"
ROUNDS = 2
CALLS = {"n": 0, "seen": []}


@chat_middleware
async def count_calls(context, call_next):
    """Count every chat completion and record what context each call was given."""
    CALLS["n"] += 1
    msgs = list(context.messages)
    CALLS["seen"].append({
        "call": CALLS["n"], "n_messages": len(msgs),
        "authors": [getattr(m, "author_name", None) or str(getattr(m, "role", "")) for m in msgs],
        "has_backlog": any("Backlog (JSON)" in (m.text or "") for m in msgs),
    })
    await call_next()
    CALLS["seen"][-1]["reply"] = getattr(context.result, "text", "") or ""


def peer_view(me: str):
    """Chat middleware: show other lenses' turns to `me` as attributed user turns.

    Without this, every peer turn reaches the model as role=assistant, the
    conversation ends on an assistant turn, and mistral-nemo returns an empty
    reply (measured: 7 of 8 turns empty). Merges same-role runs because the
    Mistral chat template expects strict user/assistant alternation, and ends
    on a user turn naming the speaker and round.
    """

    @chat_middleware
    async def rewrite(context, call_next):
        out: list[tuple[str, str]] = []
        own_turns = 0
        for m in context.messages:
            role, text = str(m.role), m.text or ""
            if role == "system":
                out.append(("system", text))
                continue
            if role == "assistant" and m.author_name not in (None, me):
                role, text = "user", f"[{m.author_name}] said:\n{text}"
            elif role == "assistant":
                own_turns += 1
            if out and out[-1][0] == role:
                out[-1] = (role, out[-1][1] + "\n\n" + text)
            else:
                out.append((role, text))
        nudge = f"Your turn, {me}. This is ROUND {own_turns + 1}. Reply with JSON only."
        if alias.startswith("qwen3"):
            nudge += " /no_think"  # qwen3 soft switch; otherwise <think> eats the token budget
        if out and out[-1][0] == "user":
            out[-1] = ("user", out[-1][1] + "\n\n" + nudge)
        else:
            out.append(("user", nudge))
        context.messages[:] = [Message(r, [t]) for r, t in out]
        await call_next()

    return rewrite


class Response(BaseModel):
    to_lens: str
    stance: Literal["concede", "rebut"]
    reason: str


class CrewPosition(BaseModel):
    lens: str
    ranking: list[str] = Field(min_length=6, max_length=6)
    responses: list[Response] = Field(min_length=1)


def instructions(lens: str) -> str:
    others = ", ".join(n for n in LENSES if n != lens)
    return (
        f"You are the {lens} lens on a four-lens product prioritization panel. The other lenses are: {others}.\n"
        f"Your mandate: {LENSES[lens]}\n"
        "The panel speaks in rounds, one lens at a time.\n"
        "ROUND 1 (the first time you speak): reply with JSON only:\n"
        '{"lens": "' + lens + '", "ranking": ["F?", "F?", "F?", "F?", "F?", "F?"], '
        '"objection": "your strongest objection to the likely consensus, <= 30 words"}\n'
        "The ranking must list all six ids F1-F6 exactly once, best first (replace each F? with a real id).\n"
        "ROUND 2 (the second time you speak): read what the other lenses said. You MUST respond to at least "
        "one other lens BY ITS LENS NAME, conceding or rebutting a specific point it made, with a reason. "
        "Then give your final ranking. Reply with JSON only:\n"
        '{"lens": "' + lens + '", "ranking": ["F?", "F?", "F?", "F?", "F?", "F?"], '
        '"responses": [{"to_lens": "<another lens name>", "stance": "concede" or "rebut", "reason": "<= 30 words"}]}'
    )


def make_client(model_id: str):
    if provider == "ollama":
        from agent_framework.ollama import OllamaChatClient

        return OllamaChatClient(model=model_id)
    from agent_framework.openai import OpenAIChatCompletionClient

    return OpenAIChatCompletionClient(model=model_id, base_url=f"{base_url()}/v1", api_key=LOCAL_API_KEY)


async def main() -> None:
    if provider == "foundry":
        model_id = resolve(alias)
        load(model_id)
    else:
        model_id = alias
    client = make_client(model_id)
    agents = [
        Agent(client, instructions(lens), name=f"lens.{lens}", description=LENSES[lens],
              default_options={"temperature": 0.0, "max_tokens": 800},
              middleware=[count_calls, peer_view(f"lens.{lens}")])
        for lens in LENSES
    ]

    def round_robin(state) -> str:
        names = list(state.participants.keys())
        return names[state.current_round % len(names)]

    workflow = GroupChatBuilder(participants=agents, selection_func=round_robin,
                                max_rounds=len(agents) * ROUNDS).build()
    task = f"Rank this backlog for the next quarter.\nBacklog (JSON):\n{json.dumps(BACKLOG)}"

    t = time.perf_counter()
    result = await workflow.run(task)
    wall = time.perf_counter() - t

    outputs = result.get_outputs()
    # The docstring says list[Message]; 1.3.2 actually yields an AgentResponse.
    last = outputs[-1] if outputs else None
    convo = getattr(last, "messages", last) or []
    turns = [{"author": getattr(m, "author_name", None), "role": str(getattr(m, "role", "")), "text": m.text}
             for m in convo]
    # GroupChat output only carries the orchestrator's closing message, so the
    # lens turns are taken from what the counting middleware saw come back.
    # Round-robin order is fixed, so call i belongs to agent i % 4.
    speaker_turns = [{"author": agents[i % len(agents)].name, "text": c["reply"]}
                     for i, c in enumerate(CALLS["seen"])]

    lens_names = set(LENSES)
    round2 = speaker_turns[len(agents):]
    scored = []
    for turn in round2:
        me = turn["author"].removeprefix("lens.")
        try:
            pos = CrewPosition.model_validate_json(extract_json(turn["text"]))
            named_other = [r.to_lens.removeprefix("lens.") in lens_names - {me} for r in pos.responses]
            scored.append({"lens": me, "parsed": True, "responses": len(pos.responses),
                           "all_name_another_lens": all(named_other),
                           "stances": [r.stance for r in pos.responses],
                           "targets": [r.to_lens for r in pos.responses]})
        except Exception as exc:  # noqa: BLE001 - spike: record and move on
            scored.append({"lens": me, "parsed": False, "error": str(exc)[:200]})

    print(f"\n{alias}: {len(speaker_turns)} lens turns, {CALLS['n']} model calls, {wall:.0f}s wall")
    for turn in speaker_turns:
        print(f"\n--- {turn['author']} ---\n{turn['text'][:900]}")
    print("\nContext per call:")
    for c in CALLS["seen"]:
        print(" ", c["call"], c["n_messages"], c["authors"][-1], "empty" if not c["reply"].strip() else "ok")
    print("\nRound-2 mechanical score:")
    for s in scored:
        print(" ", s)
    save(f"s4_groupchat_{alias.replace(':', '_')}", {
        "model": model_id, "provider": provider, "wall_s": wall, "model_calls": CALLS["n"],
        "lens_turns": len(speaker_turns), "context_per_call": CALLS["seen"], "round2_scores": scored, "transcript": turns,
    })


asyncio.run(main())
