"""Config parsing, the fixture's designed disagreements, prompts, and run files."""

import json
from datetime import datetime

import pytest

from config import ModelSpec, load_settings
from lenses import LENS_IDS, LENSES, active_lenses, ranker_prompt, rescore_prompt, scorer_prompt
from readout import latest_full_run, run_path

# --- config ------------------------------------------------------------------------

def test_defaults_are_the_spike_recommendation():
    s = load_settings({}, dotenv=False)
    assert str(s.scorer_model) == str(s.agent_model) == "foundry:phi-4-mini"
    assert str(s.critic_model) == str(s.crew_model) == "foundry:mistral-nemo-12b-instruct"
    assert (s.max_critic_rounds, s.max_crew_rounds, s.temperature) == (2, 2, 0)


def test_model_spec_keeps_colons_in_model_id():
    assert ModelSpec.parse("ollama:gemma4:12b") == ModelSpec("ollama", "gemma4:12b")


@pytest.mark.parametrize("raw", ["phi-4-mini", "azure:gpt", "foundry:", "foundry:<small model, e.g. phi-4-mini>"])
def test_bad_model_specs_rejected(raw):
    with pytest.raises(ValueError):
        ModelSpec.parse(raw, role="SCORER_MODEL")


def test_env_example_placeholders_fail_loudly():
    with pytest.raises(ValueError, match="placeholder"):
        load_settings({"CRITIC_MODEL": "foundry:<12b-class model>"}, dotenv=False)


def test_tracing_flag_parsing():
    assert load_settings({"ENABLE_TRACING": "false"}, dotenv=False).enable_tracing is False
    assert load_settings({"ENABLE_TRACING": "TRUE"}, dotenv=False).enable_tracing is True


# --- fixture: the lenses must genuinely disagree --------------------------------------

def by(backlog, key):
    return sorted(backlog["features"], key=lambda f: f[key], reverse=True)


def theme_priority(backlog, feature):
    return {t["name"]: t["priority"] for t in backlog["strategic_themes"]}[feature["strategic_theme"]]


def test_fixture_shape(backlog):
    assert backlog["product"] == "Tandem"
    assert len(backlog["features"]) == 6
    themes = {t["name"] for t in backlog["strategic_themes"]}
    assert len(themes) == 3
    for f in backlog["features"]:
        assert f["strategic_theme"] in themes
        assert len(f["customer_quotes"]) == 2
        assert f["impact"] in (0.25, 0.5, 1, 2, 3)


def test_top_rice_has_weak_strategic_fit(backlog):
    top = by(backlog, "rice_score")[0]
    assert theme_priority(backlog, top) == 3


def test_most_strategic_feature_is_the_most_expensive(backlog):
    expensive = by(backlog, "effort")[0]
    assert theme_priority(backlog, expensive) == 1


def test_intense_pain_has_the_smallest_reach(backlog):
    smallest = min(backlog["features"], key=lambda f: f["reach"])
    assert smallest["impact"] == 3 and smallest["confidence"] >= 90


def test_there_is_a_cheap_middling_feature(backlog):
    cheapest = min(backlog["features"], key=lambda f: f["effort"])
    assert cheapest["effort"] <= 1 and cheapest["impact"] <= 1
    assert theme_priority(backlog, cheapest) == 2


def test_rice_is_precomputed(backlog):
    f1 = next(f for f in backlog["features"] if f["id"] == "F1")
    assert f1["rice_score"] == round(12000 * 1 * 0.9 / 2, 1)
    assert f1["rice_rank"] == 1
    assert sorted(f["rice_rank"] for f in backlog["features"]) == [1, 2, 3, 4, 5, 6]


# --- lenses and prompts ------------------------------------------------------------

def test_four_lenses_with_distinct_agent_names():
    assert LENS_IDS == ("rice", "strategic_fit", "effort_risk", "customer_pain")
    assert {lens.agent_name for lens in LENSES.values()} == {
        "lens.rice", "lens.strategic_fit", "lens.effort_risk", "lens.customer_pain"}


def test_without_removes_exactly_one_lens():
    assert [lens.id for lens in active_lenses("customer_pain")] == ["rice", "strategic_fit", "effort_risk"]
    assert len(active_lenses(None)) == 4
    with pytest.raises(ValueError, match="Unknown lens"):
        active_lenses("vibes")


@pytest.mark.parametrize("prompt", [
    scorer_prompt(LENSES["rice"]),
    rescore_prompt(LENSES["rice"], ["F2"], ["F2 is underrated"]),
    ranker_prompt(active_lenses()),
])
def test_format_examples_use_placeholder_ids(prompt):
    """Spike finding: models copy a concrete example ranking verbatim."""
    example = prompt[prompt.rindex("shape"):]
    assert '"F?"' in example
    for real_id in ("F1", "F2", "F3", "F4", "F5", "F6"):
        assert f'"{real_id}"' not in example


def test_ranker_prompt_drops_a_removed_lens():
    assert "customer_pain" not in ranker_prompt(active_lenses("customer_pain"))


def test_every_prompt_carries_rice_score():
    assert "rice_score" in scorer_prompt(LENSES["customer_pain"])


# --- run files ------------------------------------------------------------------

def test_run_path_naming():
    when = datetime(2026, 10, 24, 9, 30, 0)
    assert run_path("crew", None, when).name == "20261024-093000_crew.json"
    assert run_path("pipeline", "rice", when).name == "20261024-093000_pipeline_without-rice.json"


def test_latest_full_run_ignores_without_runs(tmp_path):
    for name, n in [("20261024-090000_pipeline", 1), ("20261024-100000_pipeline", 2),
                    ("20261024-110000_pipeline_without-rice", 3)]:
        (tmp_path / f"{name}.json").write_text(json.dumps({"n": n}))
    assert latest_full_run("pipeline", tmp_path) == {"n": 2}
    assert latest_full_run("crew", tmp_path) is None
