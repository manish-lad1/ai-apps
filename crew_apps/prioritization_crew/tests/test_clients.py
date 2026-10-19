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
