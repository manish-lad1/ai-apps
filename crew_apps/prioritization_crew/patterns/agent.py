"""Pattern 1, _agent: one model, all lenses in one prompt, one call (plus at most one retry)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agent_framework import Agent

from clients import ask_json, make_agent
from config import Settings
from lenses import active_lenses, feature_ids, ranker_prompt
from readout import CallCounter
from schemas import Ranking

RANKER_NAME = "ranker"
RANKER_INSTRUCTIONS = "You are a careful product prioritization analyst. You reply with strict JSON only."


@dataclass
class AgentResult:
    ranking: Ranking


def build_ranker(client: Any, settings: Settings, counter: CallCounter) -> Agent:
    return make_agent(RANKER_NAME, RANKER_INSTRUCTIONS, client=client, settings=settings, counter=counter)


async def run_agent(client: Any, settings: Settings, counter: CallCounter, *, without: str | None = None) -> AgentResult:
    lenses = active_lenses(without)
    context = {"feature_ids": feature_ids(), "lens_ids": [lens.id for lens in lenses]}
    ranking = await ask_json(build_ranker(client, settings, counter), ranker_prompt(lenses), Ranking, context=context)
    return AgentResult(ranking=ranking)
