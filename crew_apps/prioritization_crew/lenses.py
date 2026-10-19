"""The four lenses, the backlog they judge, and the prompts every pattern shares.

One source of prompts keeps the comparison fair: the agent, the pipeline
scorers and the crew members all read the same mandate for a lens. If the
patterns used different wording, a difference in their rankings would say
nothing about the patterns.

Two spike findings are baked in here:

  * RICE is precomputed. Neither phi-4-mini nor the 12b models did the
    arithmetic reliably (phi-4-mini scored 285 and 4050 the same), so the
    backlog shown to every model carries `rice_score` and `rice_rank`.
    Even so, phi-4-mini only partly follows rice_rank (Phase 1 smoke test).
  * Format examples use placeholder ids ("F?"). Given a concrete example
    ranking, both 12b models returned it verbatim as their answer.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

FIXTURE = Path(__file__).parent / "fixtures" / "backlog.json"


@dataclass(frozen=True)
class Lens:
    id: str
    name: str
    short: str  # column header on a projector
    mandate: str

    @property
    def agent_name(self) -> str:
        return f"lens.{self.id}"


LENSES: dict[str, Lens] = {
    lens.id: lens
    for lens in (
        Lens("rice", "RICE", "RICE",
             "Score by rice_rank alone (1 = best RICE): rice_rank 1 scores 10, rice_rank 6 scores 1, in order between."),
        Lens("strategic_fit", "Strategic fit", "Fit",
             "Favour features in higher-priority strategic themes; enterprise readiness is this year's top bet."),
        Lens("effort_risk", "Effort and risk", "Effort",
             "Favour cheap, certain work; penalise high effort and low confidence."),
        Lens("customer_pain", "Customer pain", "Pain",
             "Favour the most intense pain in the customer quotes, however few users feel it."),
    )
}
LENS_IDS: tuple[str, ...] = tuple(LENSES)


def active_lenses(without: str | None = None) -> list[Lens]:
    """The lenses in play, optionally minus one (the --without flag)."""
    if without is not None and without not in LENSES:
        raise ValueError(f"Unknown lens {without!r}. Choose from: {', '.join(LENS_IDS)}")
    return [lens for lens in LENSES.values() if lens.id != without]


# --- Backlog -----------------------------------------------------------------

def rice_score(feature: dict) -> float:
    return round(feature["reach"] * feature["impact"] * (feature["confidence"] / 100) / feature["effort"], 1)


@lru_cache(maxsize=1)
def load_backlog(path: Path = FIXTURE) -> dict:
    data = json.loads(Path(path).read_text())
    for feature in data["features"]:
        feature["rice_score"] = rice_score(feature)
    by_rice = sorted(data["features"], key=lambda f: f["rice_score"], reverse=True)
    for rank, feature in enumerate(by_rice, 1):
        feature["rice_rank"] = rank
    return data


def feature_ids(backlog: dict | None = None) -> list[str]:
    return [f["id"] for f in (backlog or load_backlog())["features"]]


def backlog_block(backlog: dict | None = None) -> str:
    """The backlog as every model sees it: themes plus features, compact JSON."""
    backlog = backlog or load_backlog()
    return json.dumps({"strategic_themes": backlog["strategic_themes"], "features": backlog["features"]})


# --- Prompts -------------------------------------------------------------------

SCORE_SCALE = "Score each feature with a whole number from 1 to 10: 10 = strongest under your lens, 1 = weakest."


def _placeholder_scores(ids: list[str]) -> str:
    items = ", ".join('{"feature_id": "F?", "score": 0, "rationale": "<= 25 words"}' for _ in ids)
    return "[" + items + "]"


def scorer_prompt(lens: Lens, backlog: dict | None = None) -> str:
    """Pipeline fan-out: one lens scores every feature."""
    ids = feature_ids(backlog)
    return (
        f"You are the {lens.name} lens on a product prioritization panel.\n"
        f"Mandate: {lens.mandate}\n{SCORE_SCALE}\n\n"
        f"Backlog (JSON):\n{backlog_block(backlog)}\n\n"
        f"Score all {len(ids)} features ({', '.join(ids)}) under your lens only.\n"
        "Reply with JSON only, no prose, in this shape (replace each F? with a real id):\n"
        f'{{"lens": "{lens.id}", "scores": {_placeholder_scores(ids)}}}'
    )


def rescore_prompt(
    lens: Lens, current: dict[str, int], objections: list[str], backlog: dict | None = None
) -> str:
    """Pipeline critic loop: one lens re-scores only the features a critic objected to.

    The current scores are in the prompt: without them phi-4-mini, told to go
    "LOWER", answered with a RICE-sized 800 (Phase 2).
    """
    ids = list(current)
    joined = "\n".join(f"- {o}" for o in objections)
    now = ", ".join(f"{fid} = {score}" for fid, score in current.items())
    return (
        f"You are the {lens.name} lens on a product prioritization panel.\n"
        f"Mandate: {lens.mandate}\n{SCORE_SCALE}\n\n"
        f"Backlog (JSON):\n{backlog_block(backlog)}\n\n"
        f"Your current scores: {now}.\n"
        f"A critic objected:\n{joined}\n\n"
        f"Re-score only {', '.join(ids)} under your lens, each a whole number from 1 to 10. "
        "Keep a score if you still stand by it.\n"
        "Reply with JSON only, in this shape (replace each F? with a real id):\n"
        f'{{"lens": "{lens.id}", "scores": {_placeholder_scores(ids)}}}'
    )


def lens_brief(lenses: list[Lens]) -> str:
    return "\n".join(f"- {lens.id} ({lens.name}): {lens.mandate}" for lens in lenses)


def ranker_prompt(lenses: list[Lens], backlog: dict | None = None) -> str:
    """Agent pattern: one model weighs every lens at once."""
    ids = feature_ids(backlog)
    slots = ", ".join(f'{{"feature_id": "F?", "rank": {i}, "total": 0, "note": "<= 20 words"}}'
                      for i in range(1, len(ids) + 1))
    return (
        "You are a product prioritization analyst. Weigh these lenses equally:\n"
        f"{lens_brief(lenses)}\n\n"
        f"Backlog (JSON):\n{backlog_block(backlog)}\n\n"
        f"Score each feature 1-10 under every lens, add the scores into `total`, and rank all {len(ids)} "
        "features best first (rank 1 = do first). `note` names the lens that decided it.\n"
        "Reply with JSON only, in this shape (replace each F? with a real id):\n"
        f'{{"ranked": [{slots}]}}'
    )


def critic_prompt(lenses: list[Lens], ranking_lines: str, score_lines: str, backlog: dict | None = None) -> str:
    """Pipeline critic: judge the ranking against the lens scores. It never re-scores itself."""
    lens_ids = ", ".join(lens.id for lens in lenses)
    return (
        "You are the critic on a product prioritization pipeline. Lens scorers each scored "
        "every feature 1-10; plain code summed the scores into a ranking.\n"
        f"Lens mandates:\n{lens_brief(lenses)}\n\n"
        f"Backlog (JSON):\n{backlog_block(backlog)}\n\n"
        f"Lens scores (feature: score, rationale):\n{score_lines}\n\n"
        f"Ranking:\n{ranking_lines}\n\n"
        "Check each lens's scores against its OWN mandate only. Reach and impact matter only to the rice lens; "
        "strategic_fit cares only about themes, effort_risk only about effort and confidence, customer_pain only "
        "about the quotes. Object only where a score clearly contradicts its own lens's mandate (for example, "
        "rice scores out of rice_rank order). Each reason must say whether the score should be HIGHER or LOWER "
        "and why. At most 3 objections. If nothing clearly contradicts a mandate, approve.\n"
        f"`lens` must be one of: {lens_ids}.\n"
        "Reply with JSON only, in one of these shapes (replace F? with a real id):\n"
        '{"approve": true, "objections": []}\n'
        '{"approve": false, "objections": [{"lens": "<lens id>", "feature_id": "F?", "reason": "should be LOWER/HIGHER because ..."}]}'
    )
