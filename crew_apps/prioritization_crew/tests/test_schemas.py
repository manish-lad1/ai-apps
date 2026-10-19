"""Schema validation and JSON extraction, including the failure shapes seen in the spike."""

import json

import pytest

from conftest import lens_scores
from schemas import (
    CrewPosition,
    CriticVerdict,
    LensScores,
    Ranking,
    ReplyError,
    extract_json,
    parse_reply,
)

ALL_SIX = {"F1": 9, "F2": 3, "F3": 4, "F4": 7, "F5": 6, "F6": 2}


def dumps(obj) -> str:
    return json.dumps(obj)


# --- LensScores ------------------------------------------------------------------

def test_lens_scores_valid(ctx):
    parsed = parse_reply(LensScores, dumps(lens_scores("rice", ALL_SIX)), ctx)
    assert parsed.lens == "rice"
    assert parsed.by_feature() == ALL_SIX


def test_lens_scores_strips_agent_prefix(ctx):
    assert parse_reply(LensScores, dumps(lens_scores("lens.rice", ALL_SIX)), ctx).lens == "rice"


def test_lens_scores_missing_feature_rejected(ctx):
    five = {k: v for k, v in ALL_SIX.items() if k != "F6"}
    with pytest.raises(ReplyError, match="exactly"):
        parse_reply(LensScores, dumps(lens_scores("rice", five)), ctx)


def test_lens_scores_duplicate_feature_rejected(ctx):
    reply = lens_scores("rice", ALL_SIX)
    reply["scores"][5]["feature_id"] = "F1"
    with pytest.raises(ReplyError, match="duplicate"):
        parse_reply(LensScores, dumps(reply), ctx)


@pytest.mark.parametrize("bad", [0, 11])
def test_lens_scores_out_of_range_rejected(ctx, bad):
    with pytest.raises(ReplyError, match="score"):
        parse_reply(LensScores, dumps(lens_scores("rice", {**ALL_SIX, "F1": bad})), ctx)


def test_fractional_scores_round_half_up(ctx):
    parsed = parse_reply(LensScores, dumps(lens_scores("rice", {**ALL_SIX, "F1": 9.5, "F2": 2.5, "F3": 7.4})), ctx)
    assert parsed.by_feature()["F1"] == 10 and parsed.by_feature()["F2"] == 3 and parsed.by_feature()["F3"] == 7


def test_fractional_score_out_of_range_rejected(ctx):
    with pytest.raises(ReplyError, match="score"):
        parse_reply(LensScores, dumps(lens_scores("rice", {**ALL_SIX, "F6": 0.5})), ctx)


def test_lens_scores_unknown_lens_rejected(ctx):
    with pytest.raises(ReplyError, match="lens must be one of"):
        parse_reply(LensScores, dumps(lens_scores("vibes", ALL_SIX)), ctx)


def test_lens_scores_partial_rescore_uses_context(ctx):
    """The critic loop re-scores only named features; the same model validates the subset."""
    sub = {**ctx, "feature_ids": ["F2", "F5"]}
    parsed = parse_reply(LensScores, dumps(lens_scores("rice", {"F2": 4, "F5": 8})), sub)
    assert parsed.by_feature() == {"F2": 4, "F5": 8}


def test_long_rationale_is_clipped_not_rejected(ctx):
    reply = lens_scores("rice", ALL_SIX)
    reply["scores"][0]["rationale"] = " ".join(["word"] * 40)
    parsed = parse_reply(LensScores, dumps(reply), ctx)
    assert len(parsed.scores[0].rationale.split()) == 25
    assert parsed.scores[0].rationale.endswith("…")


# --- Ranking -----------------------------------------------------------------------

def ranking(order: list[str]) -> dict:
    return {"ranked": [{"feature_id": f, "rank": i, "total": 10 - i, "note": ""} for i, f in enumerate(order, 1)]}


def test_ranking_valid_and_sorted_by_rank(ctx):
    reply = ranking(["F3", "F1", "F2", "F4", "F5", "F6"])
    reply["ranked"].reverse()
    parsed = parse_reply(Ranking, dumps(reply), ctx)
    assert parsed.order() == ["F3", "F1", "F2", "F4", "F5", "F6"]
    assert parsed.rank_of()["F3"] == 1


def test_ranking_tie_rejected(ctx):
    reply = ranking(["F1", "F2", "F3", "F4", "F5", "F6"])
    reply["ranked"][1]["rank"] = 1
    with pytest.raises(ReplyError, match="ranks must be"):
        parse_reply(Ranking, dumps(reply), ctx)


def test_ranking_missing_feature_rejected(ctx):
    with pytest.raises(ReplyError, match="exactly"):
        parse_reply(Ranking, dumps(ranking(["F1", "F2", "F3", "F4", "F5"])), ctx)


# --- CriticVerdict ---------------------------------------------------------------

def test_critic_approve_without_objections(ctx):
    assert parse_reply(CriticVerdict, '{"approve": true, "objections": []}', ctx).approve


def test_critic_objection_valid(ctx):
    v = parse_reply(CriticVerdict, dumps({"approve": False, "objections": [
        {"lens": "customer_pain", "feature_id": "F3", "reason": "Data loss outranks dark mode."}]}), ctx)
    assert v.objections[0].lens == "customer_pain"


@pytest.mark.parametrize("reply", [
    {"approve": True, "objections": [{"lens": "rice", "feature_id": "F1", "reason": "x"}]},
    {"approve": False, "objections": []},
])
def test_critic_inconsistent_verdict_rejected(ctx, reply):
    """Never let an ambiguous verdict count as approval."""
    with pytest.raises(ReplyError):
        parse_reply(CriticVerdict, dumps(reply), ctx)


def test_critic_objection_to_unknown_feature_rejected(ctx):
    with pytest.raises(ReplyError, match="feature_id"):
        parse_reply(CriticVerdict, dumps({"approve": False, "objections": [
            {"lens": "rice", "feature_id": "F9", "reason": "x"}]}), ctx)


# --- CrewPosition ---------------------------------------------------------------

def position(lens: str, to_lens: str, order=None) -> dict:
    return {"lens": lens, "ranking": order or ["F1", "F2", "F3", "F4", "F5", "F6"],
            "responses": [{"to_lens": to_lens, "stance": "rebut", "reason": "because"}]}


def test_crew_position_valid(ctx):
    p = parse_reply(CrewPosition, dumps(position("lens.rice", "lens.customer_pain")), ctx)
    assert (p.lens, p.responses[0].to_lens) == ("rice", "customer_pain")


def test_crew_position_responding_to_self_rejected(ctx):
    with pytest.raises(ReplyError, match="another lens"):
        parse_reply(CrewPosition, dumps(position("rice", "rice")), ctx)


def test_crew_position_needs_a_response(ctx):
    reply = position("rice", "strategic_fit")
    reply["responses"] = []
    with pytest.raises(ReplyError):
        parse_reply(CrewPosition, dumps(reply), ctx)


def test_crew_position_removed_lens_is_not_a_valid_target(ctx):
    """With --without customer_pain, nobody can answer customer_pain."""
    without = {**ctx, "lens_ids": ["rice", "strategic_fit", "effort_risk"]}
    with pytest.raises(ReplyError, match="to_lens"):
        parse_reply(CrewPosition, dumps(position("rice", "customer_pain")), without)


def test_crew_position_five_item_ranking_rejected(ctx):
    """qwen3-14b's spike failure: a ranking missing one feature."""
    with pytest.raises(ReplyError, match="ranking"):
        parse_reply(CrewPosition, dumps(position("rice", "effort_risk", ["F1", "F2", "F3", "F4", "F5"])), ctx)


# --- Extraction (shapes observed in the Phase 0 spike) ---------------------------

def test_extract_strips_think_block():
    assert json.loads(extract_json('<think>\nlet me reason\n</think>\n{"a": 1}')) == {"a": 1}


def test_extract_empty_think_block_from_no_think():
    assert json.loads(extract_json('<think>\n\n</think>\n\n{"a": 1}')) == {"a": 1}


def test_extract_markdown_fence_and_prose():
    assert json.loads(extract_json('**ROUND 1:**\n```json\n{"a": 1}\n```\nHope this helps')) == {"a": 1}


def test_extract_ignores_trailing_extra_brace():
    assert json.loads(extract_json('{"a": {"b": 2}}}')) == {"a": {"b": 2}}


def test_unclosed_think_is_reported_not_crashed(ctx):
    with pytest.raises(ReplyError):
        parse_reply(LensScores, "<think>\nOkay, I need to score each of the six features using RICE", ctx)


def test_reply_error_message_is_short_and_names_the_field(ctx):
    with pytest.raises(ReplyError) as err:
        parse_reply(LensScores, dumps(lens_scores("rice", {**ALL_SIX, "F1": 42})), ctx)
    assert "scores.0.score" in str(err.value)
    assert len(str(err.value)) < 300
