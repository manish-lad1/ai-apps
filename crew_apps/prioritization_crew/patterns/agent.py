"""Pattern 1, _agent: one model, all lenses in one prompt, one call (plus at most one retry).

`run_agent` is what run.py calls. `build_agent_workflow` wraps the same call in
a one-step workflow so DevUI can run it like the other two patterns (Configure
& Run) and end on a readable report. The workflow adds no model and no step:
its single executor is the ranker.
"""

import time
from dataclasses import dataclass
from typing import Any

from typing_extensions import Never

from agent_framework import Agent, Executor, Workflow, WorkflowBuilder, WorkflowContext, handler

from clients import ask_json, make_agent
from config import Settings
from lenses import active_lenses, feature_ids, load_backlog, ranker_prompt
from readout import CallCounter, agent_text, latest_full_run, save_run
from schemas import Ranking

RANKER_NAME = "ranker"
RANKER_INSTRUCTIONS = "You are a careful product prioritization analyst. You reply with strict JSON only."


@dataclass
class AgentResult:
    ranking: Ranking


def build_ranker(client: Any, settings: Settings, counter: CallCounter) -> Agent:
    return make_agent(RANKER_NAME, RANKER_INSTRUCTIONS, client=client, settings=settings, counter=counter)


async def rank_once(agent: Agent, without: str | None = None) -> AgentResult:
    lenses = active_lenses(without)
    context = {"feature_ids": feature_ids(), "lens_ids": [lens.id for lens in lenses]}
    return AgentResult(ranking=await ask_json(agent, ranker_prompt(lenses), Ranking, context=context))


async def run_agent(client: Any, settings: Settings, counter: CallCounter, *, without: str | None = None) -> AgentResult:
    return await rank_once(build_ranker(client, settings, counter), without)


class RankerStep(Executor):
    """The whole agent pattern as one workflow step: one agent, one call, then the report."""

    def __init__(self, agent: Agent, counter: CallCounter, settings: Settings, without: str | None) -> None:
        super().__init__(id=RANKER_NAME)
        self.agent, self.counter, self.settings, self.without = agent, counter, settings, without

    @handler
    async def rank(self, prompt: str, ctx: WorkflowContext[Never, str]) -> None:
        # DevUI stacks every output in one box, so the text report is the only one.
        started, mark = time.perf_counter(), self.counter.mark()
        result = await rank_once(self.agent, self.without)
        wall, run_calls = time.perf_counter() - started, self.counter.since(mark)
        full = latest_full_run("agent") if self.without else None
        save_run("agent", without=self.without, ranking=result.ranking, counter=run_calls, wall_seconds=wall,
                 models={"agent": str(self.settings.agent_model)})
        await ctx.yield_output(agent_text(
            result.ranking, load_backlog(), calls=run_calls.total, wall=wall, by_agent=dict(run_calls.by_agent),
            without=self.without, full_ranking=Ranking.model_validate(full["ranking"]) if full else None,
        ))


def build_agent_workflow(client: Any, settings: Settings, counter: CallCounter, *,
                         without: str | None = None) -> Workflow:
    step = RankerStep(build_ranker(client, settings, counter), counter, settings, without)
    name = "agent" + (f" without {without}" if without else "")
    return WorkflowBuilder(start_executor=step, name=name, description="One model, all lenses, one call").build()
