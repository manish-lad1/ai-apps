"""DevUI final outputs: every pattern ends on a readable report, runs are saved, compare reads them."""

import pytest

import readout
from agent_framework import AgentResponse
from config import load_settings
from conftest import FakeChatClient
from lenses import load_backlog
from patterns.agent import build_agent_workflow
from patterns.crew import CrewResult, build_crew
from patterns.pipeline import PipelineResult, build_pipeline  # noqa: F401  (CLI build check below)
from readout import CallCounter, compare_text, latest_full_run
from test_crew import crew_responder
from test_patterns import APPROVE, FLAT, agent_reply, scorer

from readout import TEXT_WIDTH  # noqa: E402


@pytest.fixture(autouse=True)
def tmp_runs(tmp_path, monkeypatch):
    monkeypatch.setattr(readout, "RUNS_DIR", tmp_path)
    return tmp_path


def settings():
    return load_settings({}, dotenv=False)


async def outputs_of(workflow, prompt="Rank it.") -> list:
    return (await workflow.run(prompt)).get_outputs()


def text_in(outputs) -> str:
    texts = [o for o in outputs if isinstance(o, str)]
    assert len(texts) == 1, f"expected one text report, got {len(texts)}"
    return texts[0]


async def run_pipeline_ui(critic_replies, without=None):
    counter = CallCounter()
    workflow = build_pipeline(FakeChatClient(responder=scorer(FLAT, {"rice": {"F2": 2}})),
                              FakeChatClient(critic_replies), settings(), counter, without=without, ui=True)
    return await outputs_of(workflow), counter


# --- pipeline -------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_pipeline_ends_on_result_then_report(tmp_runs):
    outputs, _ = await run_pipeline_ui([{"approve": False, "objections": [
        {"lens": "rice", "feature_id": "F2", "reason": "should be LOWER"}]}, APPROVE])
    assert [type(o) for o in outputs] == [str]  # the report is the only final output in DevUI
    report = text_in(outputs)
    for expected in ("PIPELINE", "model calls 7", "RICE check", "Critic: 2 of 2 reviews, approved",
                     "RICE SSO + audit: 5 -> 2"):
        assert expected in report, expected
    assert len(list(tmp_runs.glob("*_pipeline.json"))) == 1


@pytest.mark.asyncio
async def test_pipeline_cli_build_yields_no_text_and_saves_nothing(tmp_runs):
    workflow = build_pipeline(FakeChatClient(responder=scorer(FLAT)), FakeChatClient([APPROVE]), settings(),
                              CallCounter())
    outputs = await outputs_of(workflow)
    assert [type(o) for o in outputs] == [PipelineResult]
    assert list(tmp_runs.iterdir()) == []


@pytest.mark.asyncio
async def test_pipeline_without_asks_for_a_full_run_first():
    outputs, _ = await run_pipeline_ui([APPROVE], without="customer_pain")
    assert "run the full pipeline first" in text_in(outputs)


@pytest.mark.asyncio
async def test_pipeline_without_shows_rank_change_after_a_full_run():
    await run_pipeline_ui([APPROVE])
    outputs, _ = await run_pipeline_ui([APPROVE], without="customer_pain")
    report = text_in(outputs)
    assert "Removal test: without customer_pain" in report
    assert "Pain" not in report.split("Lens scores")[1].splitlines()[1]  # the column is gone


@pytest.mark.asyncio
async def test_each_run_reports_only_its_own_calls():
    counter = CallCounter()
    workflow = build_pipeline(FakeChatClient(responder=scorer(FLAT)), FakeChatClient([APPROVE, APPROVE]),
                              settings(), counter, ui=True)
    first = text_in(await outputs_of(workflow))
    second = text_in(await outputs_of(workflow))
    assert "model calls 5" in first and "model calls 5" in second
    assert counter.total == 10


# --- crew -----------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_crew_ends_on_borda_result_not_the_max_rounds_message(tmp_runs):
    client = FakeChatClient(responder=crew_responder())
    outputs = await outputs_of(build_crew(client, settings(), CallCounter(), ui=True))
    assert [type(o) for o in outputs] == [str]  # member turns are intermediate; no stock max-rounds message
    report = text_in(outputs)
    for expected in ("CREW", "model calls 8", "Borda", "Changed ranking after round 1: 0 of 4", "Exchanges:"):
        assert expected in report, expected
    assert len(list(tmp_runs.glob("*_crew.json"))) == 1


@pytest.mark.asyncio
async def test_crew_member_turns_still_show_as_intermediate_events():
    client = FakeChatClient(responder=crew_responder())
    events = await build_crew(client, settings(), CallCounter(), ui=True).run("Rank it.")
    turns = [e for e in events if e.type == "intermediate" and isinstance(e.data, AgentResponse)]
    assert len(turns) == 8


@pytest.mark.asyncio
async def test_crew_cli_build_yields_result_without_text(tmp_runs):
    client = FakeChatClient(responder=crew_responder())
    outputs = await outputs_of(build_crew(client, settings(), CallCounter()))
    assert isinstance(outputs[-1], CrewResult) and not any(isinstance(o, str) for o in outputs)
    assert list(tmp_runs.iterdir()) == []


# --- agent ----------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_agent_workflow_is_one_step_with_a_report(tmp_runs):
    workflow = build_agent_workflow(FakeChatClient([agent_reply()]), settings(), CallCounter())
    outputs = await outputs_of(workflow)
    assert [type(o) for o in outputs] == [str]
    report = text_in(outputs)
    assert "AGENT" in report and "model calls 1" in report
    assert "backlog's own order" in report  # the fake ranks F1..F6, as phi-4-mini did
    assert len(list(tmp_runs.glob("*_agent.json"))) == 1


# --- compare --------------------------------------------------------------------------

def test_compare_with_no_runs():
    assert "No runs yet" in compare_text({"agent": None, "pipeline": None, "crew": None}, load_backlog())


@pytest.mark.asyncio
async def test_compare_reads_saved_runs():
    await outputs_of(build_agent_workflow(FakeChatClient([agent_reply()]), settings(), CallCounter()))
    await run_pipeline_ui([APPROVE])
    runs = {p: latest_full_run(p) for p in ("agent", "pipeline", "crew")}
    report = compare_text(runs, load_backlog())
    assert "SSO + audit" in report and "model calls" in report
    assert "Not run yet: crew" in report


# --- shape of the text ------------------------------------------------------------------

@pytest.mark.asyncio
async def test_tables_fit_the_devui_box():
    outputs, _ = await run_pipeline_ui([APPROVE])
    table = text_in(outputs).split("Lens scores")[1].splitlines()[1:8]
    assert all(len(line) <= TEXT_WIDTH for line in table), table


@pytest.mark.asyncio
async def test_every_report_line_fits_and_long_lines_wrap_at_words():
    long_reason = "should be LOWER because " + "its rice_rank is 5 of 6 and the score is far too high " * 3
    outputs, _ = await run_pipeline_ui([{"approve": False, "objections": [
        {"lens": "rice", "feature_id": "F2", "reason": long_reason}]}] * 2)
    lines = text_in(outputs).splitlines()
    assert all(len(line) <= TEXT_WIDTH for line in lines), [l for l in lines if len(l) > TEXT_WIDTH]
    assert any(line.startswith("    ") for line in lines)  # a wrapped continuation, indented


def test_devui_without_must_be_a_lens():
    assert load_settings({}, dotenv=False).devui_without == "customer_pain"
    with pytest.raises(ValueError, match="DEVUI_WITHOUT"):
        load_settings({"DEVUI_WITHOUT": "vibes"}, dotenv=False)


def test_counter_since_measures_one_run():
    counter = CallCounter()
    counter.by_agent["critic"] += 2
    mark = counter.mark()
    counter.by_agent["critic"] += 1
    counter.by_agent["lens.rice"] += 1
    assert dict(counter.since(mark).by_agent) == {"critic": 1, "lens.rice": 1}


def test_crew_takes_plain_text_in_devui():
    """DevUI shows a six-field Message form when the start executor offers Message."""
    from agent_framework import Message

    start = build_crew(FakeChatClient(["{}"]), settings(), CallCounter(), ui=True).get_start_executor()
    assert str in start.input_types
    assert Message not in start.input_types and list[Message] not in start.input_types


@pytest.mark.asyncio
async def test_crew_opens_with_the_same_task_whatever_is_typed():
    from lenses import crew_task

    client = FakeChatClient(responder=crew_responder())
    await outputs_of(build_crew(client, settings(), CallCounter(), ui=True), prompt="anything at all")
    first_request = " ".join(m.text or "" for m in client.requests[0])
    assert crew_task() in first_request and "anything at all" not in first_request


@pytest.mark.asyncio
async def test_same_crew_workflow_runs_twice_as_two_full_runs():
    """DevUI bug: the second run started at the round limit and re-reported the first run."""
    client = FakeChatClient(responder=crew_responder())
    workflow = build_crew(client, settings(), CallCounter(), ui=True)
    first = text_in(await outputs_of(workflow))
    requests_after_first = len(client.requests)
    second = text_in(await outputs_of(workflow))
    assert "model calls 8" in first and "model calls 8" in second
    assert len(client.requests) - requests_after_first == 8
    # Each member starts the second run with no memory of the first: its first turn is ROUND 1 again.
    second_run_first_request = " ".join(m.text or "" for m in client.requests[requests_after_first])
    assert "This is ROUND 1" in second_run_first_request
    assert sum("[lens." in (m.text or "") for m in client.requests[requests_after_first]) == 0
