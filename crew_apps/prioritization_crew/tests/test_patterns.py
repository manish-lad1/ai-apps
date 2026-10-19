"""Agent and pipeline patterns on fake clients: aggregation, the critic loop, --without."""

import re

import pytest

from config import load_settings
from conftest import FakeChatClient, lens_scores
from lenses import LENS_IDS
from patterns.agent import run_agent
from patterns.pipeline import aggregate, build_pipeline, run_pipeline
from readout import CallCounter, rice_check
from run import parse_args
from schemas import LensScores

IDS = ["F1", "F2", "F3", "F4", "F5", "F6"]
APPROVE = {"approve": True, "objections": []}


def object_to(lens: str, fid: str, reason: str = "out of RICE order") -> dict:
    return {"approve": False, "objections": [{"lens": lens, "feature_id": fid, "reason": reason}]}


def text_of(messages) -> str:
    return "\n".join(m.text or "" for m in messages)


def scorer(tables: dict[str, dict[str, int]], rescored: dict[str, dict[str, int]] | None = None):
    """Responder for the shared scorer client: reply in character for whichever lens is asking."""
    rescored = rescored or {}

    def respond(messages):
        prompt = text_of(messages)
        lens = next(lens_id for lens_id in LENS_IDS if f'{{"lens": "{lens_id}"' in prompt)
        if "Re-score only" in prompt:
            ids = re.search(r"Re-score only ([F0-9, ]+) under", prompt).group(1).split(", ")
            return lens_scores(lens, {fid: rescored[lens][fid] for fid in ids})
        return lens_scores(lens, tables[lens])

    return respond


FLAT = {lens: {fid: 5 for fid in IDS} for lens in LENS_IDS}


def settings_with(**env):
    return load_settings({k.upper(): str(v) for k, v in env.items()}, dotenv=False)


def scores_obj(table: dict[str, dict[str, int]]) -> dict[str, LensScores]:
    return {lens: LensScores.model_validate(lens_scores(lens, t)) for lens, t in table.items()}


# --- aggregator ------------------------------------------------------------------

def test_aggregate_sums_equal_weights(backlog):
    table = {**FLAT, "customer_pain": {**FLAT["customer_pain"], "F3": 10}}
    ranking = aggregate(scores_obj(table), backlog)
    assert ranking.order()[0] == "F3"
    assert ranking.ranked[0].total == 25
    assert ranking.ranked[0].note == "top: Pain 10"


def test_aggregate_ties_go_to_lower_effort(backlog):
    # All equal: order is by effort F4(1) F1(2) F3(3) F6(5) F5(9) F2(14).
    assert aggregate(scores_obj(FLAT), backlog).order() == ["F4", "F1", "F3", "F6", "F5", "F2"]


def test_aggregate_equal_total_and_effort_falls_back_to_id(backlog):
    same_effort = {**backlog, "features": [{**f, "effort": 3} for f in backlog["features"]]}
    assert aggregate(scores_obj(FLAT), same_effort).order() == IDS


def test_aggregate_with_three_lenses(backlog):
    three = {k: v for k, v in FLAT.items() if k != "rice"}
    ranking = aggregate(scores_obj(three), backlog)
    assert ranking.ranked[0].total == 15


# --- pipeline ----------------------------------------------------------------------

async def pipeline(critic_replies, *, rescored=None, without=None, **env):
    settings = settings_with(**env)
    counter = CallCounter()
    scorer_client = FakeChatClient(responder=scorer(FLAT, rescored))
    critic_client = FakeChatClient(critic_replies)
    workflow = build_pipeline(scorer_client, critic_client, settings, counter, without=without)
    return await run_pipeline(workflow), counter, scorer_client, critic_client


@pytest.mark.asyncio
async def test_pipeline_approved_first_time():
    result, counter, _, _ = await pipeline([APPROVE])
    assert result.approved is True and result.objections == []
    assert counter.total == 5
    assert set(result.scores) == set(LENS_IDS)


@pytest.mark.asyncio
async def test_rescore_touches_only_the_named_lens_and_feature():
    result, counter, scorer_client, _ = await pipeline(
        [object_to("rice", "F2"), APPROVE], rescored={"rice": {"F2": 9}}
    )
    assert result.approved is True
    assert counter.by_agent["lens.rice"] == 2
    assert all(counter.by_agent[f"lens.{lens}"] == 1 for lens in LENS_IDS if lens != "rice")
    assert [(r.lens, r.feature_id, r.before, r.after) for r in result.rescores] == [("rice", "F2", 5, 9)]
    assert result.scores["rice"].by_feature()["F2"] == 9
    assert result.scores["rice"].by_feature()["F1"] == 5  # untouched
    # The objection travelled into the re-score prompt.
    rescore_prompt = text_of(scorer_client.requests[-1])
    assert "out of RICE order" in rescore_prompt and "Re-score only F2" in rescore_prompt


@pytest.mark.asyncio
async def test_result_keeps_pre_critic_scores_and_the_reason():
    result, *_ = await pipeline([object_to("rice", "F2", "F2 is rice_rank 5"), APPROVE], rescored={"rice": {"F2": 9}})
    assert result.score_table(first=True)["rice"]["F2"] == 5
    assert result.score_table()["rice"]["F2"] == 9
    assert result.rescores[0].reason == "F2 is rice_rank 5"
    assert [v.approve for v in result.verdicts] == [False, True]


@pytest.mark.asyncio
async def test_rescore_prompt_carries_the_current_score():
    _, _, scorer_client, _ = await pipeline([object_to("rice", "F2"), APPROVE], rescored={"rice": {"F2": 3}})
    assert "Your current scores: F2 = 5." in text_of(scorer_client.requests[-1])


@pytest.mark.asyncio
async def test_invalid_rescore_keeps_the_old_score_and_the_run_continues():
    """Phase 2 live failure: told to go LOWER, phi-4-mini re-scored F2 as 800."""
    result, counter, _, _ = await pipeline([object_to("rice", "F2"), APPROVE], rescored={"rice": {"F2": 800}})
    assert result.approved is True
    assert counter.by_agent["lens.rice"] == 3  # first pass, re-score, its retry
    assert result.scores["rice"].by_feature()["F2"] == 5
    assert result.rescores[0].failed and result.rescores[0].after == 5


@pytest.mark.asyncio
async def test_rescore_changes_the_ranking():
    result, *_ = await pipeline([object_to("rice", "F2"), APPROVE], rescored={"rice": {"F2": 10}})
    assert result.ranking.order()[0] == "F2"


@pytest.mark.asyncio
async def test_critic_loop_stops_at_cap_and_reports_objections():
    always_object = [object_to("customer_pain", "F3", "data loss is the worst pain")] * 2
    result, counter, _, critic_client = await pipeline(
        always_object, rescored={"customer_pain": {"F3": 6}}, max_critic_rounds=2
    )
    assert result.approved is False
    assert result.critic_rounds == 2
    assert counter.by_agent["critic"] == 2
    assert counter.by_agent["lens.customer_pain"] == 2  # one initial score, one re-score, none after the last review
    assert [o.feature_id for o in result.objections] == ["F3"]
    assert critic_client.replies == []


@pytest.mark.asyncio
async def test_cap_of_one_never_rescores():
    result, counter, _, _ = await pipeline([object_to("rice", "F1")], max_critic_rounds=1)
    assert result.approved is False and result.rescores == []
    assert counter.total == 5


@pytest.mark.asyncio
async def test_zero_critic_rounds_skips_the_critic():
    result, counter, _, critic_client = await pipeline([], max_critic_rounds=0)
    assert result.approved is None
    assert counter.total == 4 and "critic" not in counter.by_agent
    assert critic_client.requests == []


@pytest.mark.asyncio
async def test_invalid_verdict_gets_one_retry():
    result, counter, _, _ = await pipeline(['{"approve": true, "objections": [{"lens": "rice"}]}', APPROVE])
    assert result.approved is True
    assert counter.by_agent["critic"] == 2


@pytest.mark.asyncio
async def test_without_drops_one_scorer_and_one_column():
    result, counter, _, critic_client = await pipeline([APPROVE], without="customer_pain")
    assert set(result.score_table()) == {"rice", "strategic_fit", "effort_risk"}
    assert "lens.customer_pain" not in counter.by_agent
    assert counter.total == 4
    assert len(result.ranking.ranked) == 6
    assert result.ranking.ranked[0].total == 15
    assert "customer_pain" not in text_of(critic_client.requests[0]).split("`lens` must be one of:")[1]


@pytest.mark.asyncio
async def test_without_critic_may_not_object_on_behalf_of_the_removed_lens():
    removed_lens_objection = object_to("customer_pain", "F3")
    result, counter, _, _ = await pipeline([removed_lens_objection, APPROVE], without="customer_pain")
    assert result.approved is True
    assert counter.by_agent["critic"] == 2  # first verdict rejected by validation, one retry


@pytest.mark.asyncio
async def test_same_workflow_runs_twice_without_leaking_state():
    settings = settings_with(max_critic_rounds=2)
    counter = CallCounter()
    workflow = build_pipeline(FakeChatClient(responder=scorer(FLAT, {"rice": {"F2": 9}})),
                              FakeChatClient([object_to("rice", "F2"), APPROVE, APPROVE]), settings, counter)
    first = await run_pipeline(workflow)
    second = await run_pipeline(workflow)
    assert len(first.rescores) == 1 and second.rescores == []
    assert second.scores["rice"].by_feature()["F2"] == 5


# --- agent ---------------------------------------------------------------------------

def agent_reply() -> dict:
    return {"ranked": [{"feature_id": f, "rank": i, "total": 30 - i, "note": "x"} for i, f in enumerate(IDS, 1)]}


@pytest.mark.asyncio
async def test_agent_is_one_call():
    client = FakeChatClient([agent_reply()])
    counter = CallCounter()
    result = await run_agent(client, settings_with(), counter)
    assert result.ranking.order() == IDS
    assert counter.total == 1 and dict(counter.by_agent) == {"ranker": 1}


@pytest.mark.asyncio
async def test_agent_without_removes_the_lens_from_the_prompt():
    client = FakeChatClient([agent_reply()])
    await run_agent(client, settings_with(), CallCounter(), without="rice")
    prompt = text_of(client.requests[0])
    assert "- rice (RICE)" not in prompt and "- customer_pain" in prompt


# --- RICE check and CLI ---------------------------------------------------------------

def test_rice_check_perfect_order(backlog):
    by_rice = sorted(backlog["features"], key=lambda f: f["rice_score"])
    perfect = {f["id"]: i for i, f in enumerate(by_rice, 1)}
    assert rice_check(perfect, backlog) == (0, 15)


def test_rice_check_counts_inversions_and_half_ties(backlog):
    # Observed phi-4-mini output from the Phase 1 smoke test.
    observed = {"F1": 9, "F2": 2, "F3": 7, "F4": 5, "F5": 2, "F6": 1}
    wrong, pairs = rice_check(observed, backlog)
    assert pairs == 15
    # RICE order F1 > F4 > F5 > F3 > F2 > F6. Wrong: F3 scored above F4 (1) and above F5 (1);
    # F5 and F2 tied at 2 (0.5). Every other pair is in order.
    assert wrong == 2.5


def test_cli_rejects_unknown_lens():
    with pytest.raises(SystemExit):
        parse_args(["--pattern", "pipeline", "--without", "vibes"])


def test_cli_compare_excludes_pattern():
    with pytest.raises(SystemExit):
        parse_args(["--compare", "--pattern", "crew"])
