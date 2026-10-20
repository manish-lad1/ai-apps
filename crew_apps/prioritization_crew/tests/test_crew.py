"""Crew: Borda synthesis, disagreements, and the group chat on a fake client."""

import re

import pytest

from config import load_settings
from conftest import FakeChatClient
from patterns.crew import (
    borda,
    build_crew,
    crew_turn_prompt,
    find_agreements,
    find_disagreements,
    round_robin,
    run_crew,
    sharpest_gaps,
)
from readout import CallCounter
from schemas import ReplyError

IDS = ["F1", "F2", "F3", "F4", "F5", "F6"]


# --- Borda and disagreements ------------------------------------------------------

def test_borda_points(backlog):
    positions = {"a": IDS, "b": IDS, "c": IDS[::-1]}
    ranking = borda(positions, backlog)
    # F1: 5+5+0 = 10, F6: 0+0+5 = 5, F2: 4+4+1 = 9 ...
    assert ranking.ranked[0].feature_id == "F1" and ranking.ranked[0].total == 10
    assert {r.feature_id: r.total for r in ranking.ranked}["F6"] == 5


def test_borda_tie_goes_to_lower_effort(backlog):
    # Two opposite rankings: every feature gets 5 points. Effort order: F4 F1 F3 F6 F5 F2.
    ranking = borda({"a": IDS, "b": IDS[::-1]}, backlog)
    assert ranking.order() == ["F4", "F1", "F3", "F6", "F5", "F2"]


def test_borda_note_shows_rank_spread(backlog):
    ranking = borda({"a": IDS, "b": ["F2", "F1", "F3", "F4", "F5", "F6"]}, backlog)
    notes = {r.feature_id: r.note for r in ranking.ranked}
    assert notes["F1"] == "ranked #1-#2" and notes["F3"] == "ranked #3"


def test_disagreement_needs_a_spread_of_two(backlog):
    positions = {
        "rice": ["F1", "F2", "F3", "F4", "F5", "F6"],
        "customer_pain": ["F3", "F1", "F2", "F4", "F6", "F5"],
    }
    found = {d.feature_id: d.positions for d in find_disagreements(positions, backlog)}
    assert found == {"F3": {"rice": 3, "customer_pain": 1}}  # F1, F2, F5, F6 moved by 1 only


def test_agreements_are_the_features_within_one_place(backlog):
    positions = {"rice": IDS, "customer_pain": ["F3", "F1", "F2", "F4", "F6", "F5"]}
    agreements = find_agreements(positions, backlog)
    assert "Smart paste cleanup: every lens ranks it #4" in agreements
    assert not any(a.startswith("Offline conflict fix") for a in agreements)


def test_round_robin_is_plain_code():
    class State:
        participants = {"lens.a": "", "lens.b": "", "lens.c": ""}
        current_round = 4

    assert round_robin(State()) == "lens.b"


def test_sharpest_gaps_one_per_peer_biggest_first():
    own = ["F1", "F2", "F3", "F4", "F5", "F6"]
    peers = {"strategic_fit": ["F2", "F6", "F1", "F3", "F4", "F5"], "rice": ["F1", "F3", "F2", "F4", "F5", "F6"]}
    assert sharpest_gaps(own, peers) == [("strategic_fit", "F6", 2, 6), ("rice", "F3", 2, 3)]


def test_round_two_prompt_names_shape_and_gaps():
    peers = {"lens.strategic_fit": '{"lens": "strategic_fit", "ranking": ["F2","F6","F1","F3","F4","F5"]}'}
    own = '{"lens": "customer_pain", "ranking": ["F3","F1","F4","F5","F6","F2"], "objection": "x"}'
    prompt = crew_turn_prompt("lens.customer_pain", 2, peers, own)
    assert "strategic_fit ranks SSO and audit log (F2) #1; you rank it #6." in prompt
    assert '"responses"' in prompt and "not `objection`" in prompt
    assert '"F1"' not in prompt.split("shape")[-1]  # placeholders only


def test_every_member_sees_the_backlog_whatever_the_opening_message():
    from lenses import LENSES, active_lenses, crew_instructions

    assert "Backlog (JSON)" in crew_instructions(LENSES["rice"], active_lenses())
    assert '"rice_score"' in crew_instructions(LENSES["customer_pain"], active_lenses())


def test_round_one_prompt_asks_for_the_opening_shape():
    prompt = crew_turn_prompt("lens.rice", 1, {}, None)
    assert '"objection"' in prompt and '"responses"' not in prompt


# --- The group chat on a fake model --------------------------------------------

def crew_responder(final: dict[str, list[str]] | None = None, broken: set[tuple[str, int]] = frozenset(),
                   repair_ok: bool = True, rice_target: str = "customer_pain"):
    """Reply in character for whichever lens's turn it is, or repair a reply."""
    final = final or {}

    def respond(messages):
        text = "\n".join(m.text or "" for m in messages)
        if "was not valid" in text:
            lens = re.search(r'"lens": "(\w+)"', text.split("Reply:")[1]).group(1)
            if not repair_ok:
                return "still not json"
            return {"lens": lens, "ranking": final.get(lens, IDS),
                    "responses": [{"to_lens": "rice" if lens != "rice" else "effort_risk", "stance": "concede",
                                   "reason": "fair"}]}
        turn = re.findall(r"Your turn, lens\.(\w+)\. This is ROUND (\d)", text)[-1]
        lens, rnd = turn[0], int(turn[1])
        if (lens, rnd) in broken:
            return '{"lens": "' + lens + '", "ranking": ["F1"'  # truncated JSON
        if rnd == 1:
            return {"lens": lens, "ranking": IDS, "objection": f"{lens} objects"}
        target = rice_target if lens == "rice" else "rice"
        return {"lens": lens, "ranking": final.get(lens, IDS),
                "responses": [{"to_lens": target, "stance": "rebut", "reason": f"{lens} answers {target}"}]}

    return respond


async def crew(responder, *, without=None, **env):
    settings = load_settings({k.upper(): str(v) for k, v in env.items()}, dotenv=False)
    client = FakeChatClient(responder=responder)
    counter = CallCounter()
    result = await run_crew(build_crew(client, settings, counter, without=without))
    return result, counter, client


@pytest.mark.asyncio
async def test_two_rounds_four_voices_eight_calls():
    pain_first = ["F3", "F2", "F1", "F4", "F5", "F6"]
    result, counter, _ = await crew(crew_responder(final={"customer_pain": pain_first}))
    assert counter.total == 8
    assert all(n == 2 for n in counter.by_agent.values())
    assert [(t["round"], t["author"]) for t in result.turns][:4] == [
        (1, "lens.rice"), (1, "lens.strategic_fit"), (1, "lens.effort_risk"), (1, "lens.customer_pain")]
    assert result.moved() == ["customer_pain"]
    assert len(result.exchanges) == 4 and {e.to_lens for e in result.exchanges} == {"rice", "customer_pain"}
    assert result.ranking.order()[0] == "F1"
    # customer_pain moved F3 from #3 to #1 and pushed F1 from #1 to #3: both spread by 2.
    assert {d.feature_id for d in result.outcome.disagreements} == {"F1", "F3"}


@pytest.mark.asyncio
async def test_every_turn_ends_on_a_user_message_naming_the_speaker():
    """The peer-view adapter: without it nemo answered peers' assistant turns with nothing."""
    _, _, client = await crew(crew_responder())
    for request in client.requests:
        last = request[-1]
        assert str(last.role) == "user" and "Your turn, lens." in last.text


@pytest.mark.asyncio
async def test_three_rounds():
    result, counter, _ = await crew(crew_responder(), max_crew_rounds=3)
    assert counter.total == 12
    assert {t["round"] for t in result.turns} == {1, 2, 3}


@pytest.mark.asyncio
async def test_without_removes_a_voice_from_the_chat():
    result, counter, client = await crew(crew_responder(rice_target="effort_risk"), without="customer_pain")
    assert counter.total == 6
    assert "lens.customer_pain" not in counter.by_agent
    assert set(result.finals) == {"rice", "strategic_fit", "effort_risk"}
    # Nobody is even told customer_pain exists.
    assert all("customer_pain" not in (m.text or "") for request in client.requests for m in request)


@pytest.mark.asyncio
async def test_without_rejects_answers_to_the_removed_lens():
    """rice answers customer_pain in the fake; with customer_pain removed that is invalid, so rice is repaired."""
    result, counter, _ = await crew(crew_responder(), without="customer_pain")
    assert result.repaired == ["lens.rice round 2"]
    assert counter.by_agent["lens.rice"] == 3


@pytest.mark.asyncio
async def test_broken_final_turn_gets_one_repair_call():
    result, counter, _ = await crew(crew_responder(broken={("effort_risk", 2)}))
    assert result.repaired == ["lens.effort_risk round 2"]
    assert counter.by_agent["lens.effort_risk"] == 3 and counter.total == 9
    assert "effort_risk" in result.finals and result.fallbacks == []


@pytest.mark.asyncio
async def test_unrepairable_final_turn_falls_back_to_round_one():
    result, _, _ = await crew(crew_responder(broken={("effort_risk", 2)}, repair_ok=False))
    assert result.fallbacks == ["effort_risk"]
    assert result.final_rankings()["effort_risk"] == IDS


@pytest.mark.asyncio
async def test_lens_with_no_valid_turn_at_all_fails_loudly():
    with pytest.raises(ReplyError, match="no valid position"):
        await crew(crew_responder(broken={("effort_risk", 1), ("effort_risk", 2)}, repair_ok=False))
