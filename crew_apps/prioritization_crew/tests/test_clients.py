"""The one-retry JSON path, call counting, and temperature, through a real Agent."""

import asyncio

import pytest

from agent_framework import Message

from clients import ask_json, concurrency_gate, make_agent, peer_view
from conftest import FakeChatClient, lens_scores
from readout import CallCounter
from schemas import LensScores, ReplyError

ALL_SIX = {"F1": 9, "F2": 3, "F3": 4, "F4": 7, "F5": 6, "F6": 2}


def agent_with(replies, settings, counter=None):
    client = FakeChatClient(replies)
    counter = counter or CallCounter()
    agent = make_agent("lens.rice", "Return JSON only.", client=client, settings=settings, counter=counter)
    return agent, client, counter


@pytest.mark.asyncio
async def test_valid_first_reply_is_one_call(settings, ctx):
    agent, client, counter = agent_with([lens_scores("rice", ALL_SIX)], settings)
    result = await ask_json(agent, "score", LensScores, context=ctx)
    assert result.by_feature() == ALL_SIX
    assert counter.total == 1 and counter.by_agent["lens.rice"] == 1


@pytest.mark.asyncio
async def test_invalid_then_valid_retries_once_and_counts_both(settings, ctx):
    agent, client, counter = agent_with(["not json at all", lens_scores("rice", ALL_SIX)], settings)
    result = await ask_json(agent, "score", LensScores, context=ctx)
    assert result.lens == "rice"
    assert counter.total == 2
    # The retry is sent in the same session: the model sees its bad reply and the problem.
    retry_request = client.requests[1]
    texts = [m.text for m in retry_request]
    assert "not json at all" in texts
    assert "not valid" in texts[-1]


@pytest.mark.asyncio
async def test_invalid_twice_raises_after_exactly_two_calls(settings, ctx):
    five = {k: v for k, v in ALL_SIX.items() if k != "F6"}
    agent, client, counter = agent_with([lens_scores("rice", five), "still wrong"], settings)
    with pytest.raises(ReplyError, match="invalid after one retry"):
        await ask_json(agent, "score", LensScores, context=ctx)
    assert counter.total == 2
    assert client.replies == []


@pytest.mark.asyncio
async def test_temperature_and_max_tokens_reach_the_client(settings, ctx):
    agent, client, _ = agent_with([lens_scores("rice", ALL_SIX)], settings)
    await ask_json(agent, "score", LensScores, context=ctx)
    assert client.options[0]["temperature"] == 0
    assert client.options[0]["max_tokens"] > 0


@pytest.mark.asyncio
async def test_no_tools_are_sent(settings, ctx):
    agent, client, _ = agent_with([lens_scores("rice", ALL_SIX)], settings)
    await ask_json(agent, "score", LensScores, context=ctx)
    assert not client.options[0].get("tools")


@pytest.mark.asyncio
async def test_one_counter_shared_across_agents(settings, ctx):
    counter = CallCounter()
    a, _, _ = agent_with([lens_scores("rice", ALL_SIX)], settings, counter)
    client_b = FakeChatClient([lens_scores("effort_risk", ALL_SIX)])
    b = make_agent("lens.effort_risk", "JSON.", client=client_b, settings=settings, counter=counter)
    await ask_json(a, "x", LensScores, context=ctx)
    await ask_json(b, "x", LensScores, context=ctx)
    assert counter.total == 2
    assert dict(counter.by_agent) == {"lens.rice": 1, "lens.effort_risk": 1}


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", [1, 2])
async def test_concurrency_gate_caps_requests_in_flight(settings, ctx, limit):
    """Four agents fanned out at once reach the client at most `limit` at a time."""
    client = FakeChatClient([lens_scores("rice", ALL_SIX)] * 4, middleware=[concurrency_gate(limit)], delay=0.05)
    counter = CallCounter()
    agents = [make_agent(f"lens.{i}", "JSON.", client=client, settings=settings, counter=counter) for i in range(4)]
    await asyncio.gather(*(ask_json(a, "x", LensScores, context=ctx) for a in agents))
    assert client.max_in_flight == limit
    assert counter.total == 4


@pytest.mark.asyncio
async def test_without_gate_requests_overlap(settings, ctx):
    """Control for the test above: the fake really does run requests concurrently."""
    client = FakeChatClient([lens_scores("rice", ALL_SIX)] * 4, delay=0.05)
    counter = CallCounter()
    agents = [make_agent(f"lens.{i}", "JSON.", client=client, settings=settings, counter=counter) for i in range(4)]
    await asyncio.gather(*(ask_json(a, "x", LensScores, context=ctx) for a in agents))
    assert client.max_in_flight == 4


@pytest.mark.asyncio
async def test_peer_view_turns_peers_into_attributed_user_turns(settings):
    """Spike fix: peers arrive as assistant turns; local models then reply with nothing."""
    client = FakeChatClient(["{}"])
    agent = make_agent("lens.rice", "JSON.", client=client, settings=settings, counter=CallCounter(),
                       middleware=[peer_view("lens.rice")])
    await agent.run([
        Message("user", ["Rank the backlog."]),
        Message("assistant", ["my round 1"], author_name="lens.rice"),
        Message("assistant", ["fit says F2"], author_name="lens.strategic_fit"),
        Message("assistant", ["pain says F3"], author_name="lens.customer_pain"),
    ])
    sent = [(str(m.role), m.text) for m in client.requests[0] if str(m.role) != "system"]
    assert [role for role, _ in sent] == ["user", "assistant", "user"]
    assert sent[1][1] == "my round 1"
    assert "[lens.strategic_fit] said:" in sent[2][1] and "[lens.customer_pain] said:" in sent[2][1]
    assert sent[2][1].endswith("Your turn, lens.rice. This is ROUND 2. Reply with JSON only.")


@pytest.mark.asyncio
async def test_peer_view_first_turn_ends_on_user(settings):
    client = FakeChatClient(["{}"])
    agent = make_agent("lens.fit", "JSON.", client=client, settings=settings, counter=CallCounter(),
                       middleware=[peer_view("lens.fit")])
    await agent.run([Message("user", ["Rank."]), Message("assistant", ["rice first"], author_name="lens.rice")])
    sent = [(str(m.role), m.text) for m in client.requests[0] if str(m.role) != "system"]
    assert [role for role, _ in sent] == ["user"]
    assert "ROUND 1" in sent[0][1]


# --- Streaming: Foundry's per-chunk usage (seen in DevUI) -----------------------------

from agent_framework import BaseChatClient, ChatMiddlewareLayer, ChatResponse, ChatResponseUpdate, Content  # noqa: E402
from agent_framework import ResponseStream  # noqa: E402

from clients import single_stream_usage  # noqa: E402


class FoundryLikeStream(ChatMiddlewareLayer, BaseChatClient):
    """Streams the way Foundry Local 0.10.3 does: cumulative usage before the text in every chunk."""

    def __init__(self, words: list[str], *, middleware=None) -> None:
        super().__init__(middleware=middleware)
        self.words = words

    def _inner_get_response(self, *, messages, stream, options, **kwargs):
        async def updates():
            for i, word in enumerate(self.words, 1):
                usage = Content.from_usage(usage_details={"input_token_count": 10, "output_token_count": i,
                                                          "total_token_count": 10 + i})
                yield ChatResponseUpdate(role="assistant", contents=[usage, Content.from_text(word)],
                                         response_id="chat.id.1", message_id="chat.id.1")
            final = Content.from_usage(usage_details={"input_token_count": 10, "output_token_count": len(self.words),
                                                      "total_token_count": 10 + len(self.words)})
            yield ChatResponseUpdate(role="assistant", contents=[final], finish_reason="stop",
                                     response_id="chat.id.1", message_id="chat.id.1")

        return ResponseStream(updates(), finalizer=ChatResponse.from_updates)


async def stream_through(client):
    stream = client.get_response([Message("user", ["hi"])], stream=True)
    chunks = [u async for u in stream]
    return chunks, await stream.get_final_response()


@pytest.mark.asyncio
async def test_streamed_usage_appears_once_on_the_closing_chunk():
    chunks, final = await stream_through(FoundryLikeStream(["Hello", ",", " world"], middleware=[single_stream_usage]))
    usage_chunks = [c for c in chunks if any(x.type == "usage" for x in c.contents)]
    assert len(usage_chunks) == 1 and usage_chunks[0].finish_reason == "stop"
    # Text chunks carry only text, so DevUI keeps them in one content part.
    assert all([x.type for x in c.contents] == ["text"] for c in chunks if c.finish_reason is None)
    assert final.text == "Hello, world"
    assert final.usage_details["output_token_count"] == 3 and final.usage_details["input_token_count"] == 10


@pytest.mark.asyncio
async def test_control_without_the_middleware_every_chunk_carries_usage():
    chunks, _ = await stream_through(FoundryLikeStream(["Hello", ",", " world"]))
    assert sum(any(x.type == "usage" for x in c.contents) for c in chunks) == 4
