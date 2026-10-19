"""Pattern 2, _pipeline: lens scorers fan out, plain code aggregates, a critic loops.

    start ──fan-out──> lens.rice ─────────┐
                       lens.strategic_fit ├──fan-in──> aggregate ──> critic ──> done
                       lens.effort_risk   │                ^            │
                       lens.customer_pain ┘                └── rescore <┘ (objections, under the cap)

The artifact only moves forward: scorers never see each other, the aggregator
is arithmetic, and the critic judges but never scores. When it objects, only
the lens scorers it names re-score only the features it names, with the
objection in their prompt. The loop is asymmetric (critic judges, scorers
revise), so this is still a pipeline, not a crew.

Why a graph and not ConcurrentBuilder: ConcurrentBuilder ends at its
aggregator and re-runs every participant each time. The critic loop needs to
go back to a subset of scorers and round again. So this uses the same
primitives ConcurrentBuilder is built from (fan-out and fan-in edges) plus
two more edges for the loop.

Executors keep no state between messages; everything a step needs travels in
the message. One built workflow can therefore run any number of times, which
DevUI relies on.

Cap: the critic reviews at most MAX_CRITIC_ROUNDS times. If it still objects
after its last review, the ranking is output with the objections listed.
It is never silently approved. MAX_CRITIC_ROUNDS=0 skips the critic.
"""

import asyncio
from dataclasses import dataclass, field
from typing import Any

from typing_extensions import Never

from agent_framework import Agent, Executor, Workflow, WorkflowBuilder, WorkflowContext, handler

from clients import ask_json, make_agent
from config import Settings
from lenses import LENSES, Lens, active_lenses, critic_prompt, feature_ids, load_backlog, rescore_prompt, scorer_prompt
from readout import CallCounter
from schemas import CriticVerdict, LensScores, Objection, RankedFeature, Ranking, ReplyError

CRITIC_NAME = "critic"
SCORER_INSTRUCTIONS = "You are one lens on a product prioritization panel. You reply with strict JSON only."
CRITIC_INSTRUCTIONS = "You are a strict but fair reviewer of lens scores. You reply with strict JSON only."


# --- Messages ------------------------------------------------------------------

@dataclass
class ScoreRequest:
    """Kick-off for the fan-out: every scorer scores every feature."""


@dataclass
class Rescore:
    lens: str
    feature_id: str
    before: int
    after: int
    round: int
    reason: str  # the critic's objection that triggered it
    failed: bool = False  # the re-score reply was invalid even after its retry; `before` was kept


@dataclass
class PipelineState:
    scores: dict[str, LensScores]
    ranking: Ranking
    first_scores: dict[str, LensScores]  # before any critic round, to show what the loop changed
    critic_rounds: int = 0
    verdicts: list[CriticVerdict] = field(default_factory=list)
    rescores: list[Rescore] = field(default_factory=list)


@dataclass
class PipelineResult:
    ranking: Ranking
    scores: dict[str, LensScores]
    first_scores: dict[str, LensScores]
    approved: bool | None  # None = no critic configured
    objections: list[Objection]
    critic_rounds: int
    rescores: list[Rescore]
    verdicts: list[CriticVerdict]

    def score_table(self, first: bool = False) -> dict[str, dict[str, int]]:
        return {lens_id: s.by_feature() for lens_id, s in (self.first_scores if first else self.scores).items()}


# --- Plain-code aggregation ------------------------------------------------------

def aggregate(scores: dict[str, LensScores], backlog: dict | None = None) -> Ranking:
    """Equal weights: sum the lens scores. Ties go to lower effort, then to feature id."""
    backlog = backlog or load_backlog()
    effort = {f["id"]: f["effort"] for f in backlog["features"]}
    ids = [f["id"] for f in backlog["features"]]
    by_lens = {lens_id: s.by_feature() for lens_id, s in scores.items()}
    totals = {fid: sum(table[fid] for table in by_lens.values()) for fid in ids}
    order = sorted(ids, key=lambda fid: (-totals[fid], effort[fid], fid))

    def note(fid: str) -> str:
        lens_id, best = max(((lens_id, table[fid]) for lens_id, table in by_lens.items()), key=lambda p: p[1])
        return f"top: {LENSES[lens_id].short} {best}"

    return Ranking(ranked=[
        RankedFeature(feature_id=fid, rank=i, total=totals[fid], note=note(fid)) for i, fid in enumerate(order, 1)
    ])


def ranking_lines(ranking: Ranking, backlog: dict | None = None) -> str:
    names = {f["id"]: f["name"] for f in (backlog or load_backlog())["features"]}
    return "\n".join(f"{r.rank}. {r.feature_id} {names[r.feature_id]} (total {r.total:g})" for r in ranking.ranked)


def score_lines(scores: dict[str, LensScores]) -> str:
    return "\n".join(
        f"{lens_id}: " + "; ".join(f"{s.feature_id}={s.score} ({s.rationale})" for s in ls.scores)
        for lens_id, ls in scores.items()
    )


# --- Executors -------------------------------------------------------------------

class Start(Executor):
    @handler
    async def start(self, prompt: str, ctx: WorkflowContext[ScoreRequest]) -> None:
        await ctx.send_message(ScoreRequest())


class LensScorer(Executor):
    def __init__(self, lens: Lens, agent: Agent, context: dict) -> None:
        super().__init__(id=lens.agent_name)
        self.lens, self.agent, self.context = lens, agent, context

    @handler
    async def score(self, request: ScoreRequest, ctx: WorkflowContext[LensScores]) -> None:
        await ctx.send_message(await ask_json(self.agent, scorer_prompt(self.lens), LensScores, context=self.context))


class Aggregate(Executor):
    def __init__(self, max_critic_rounds: int) -> None:
        super().__init__(id="aggregate")
        self.max_critic_rounds = max_critic_rounds

    @handler
    async def first_pass(
        self, results: list[LensScores], ctx: WorkflowContext[PipelineState, PipelineResult]
    ) -> None:
        scores = {r.lens: r for r in results}
        state = PipelineState(scores=scores, ranking=aggregate(scores), first_scores=dict(scores))
        if self.max_critic_rounds == 0:
            await ctx.yield_output(PipelineResult(state.ranking, scores, state.first_scores, None, [], 0, [], []))
        else:
            await ctx.send_message(state)

    @handler
    async def after_rescore(self, state: PipelineState, ctx: WorkflowContext[PipelineState]) -> None:
        state.ranking = aggregate(state.scores)
        await ctx.send_message(state)


class Critic(Executor):
    def __init__(self, agent: Agent, lenses: list[Lens], max_rounds: int, context: dict) -> None:
        super().__init__(id=CRITIC_NAME)
        self.agent, self.lenses, self.max_rounds, self.context = agent, lenses, max_rounds, context

    @handler
    async def review(self, state: PipelineState, ctx: WorkflowContext[PipelineState, PipelineResult]) -> None:
        prompt = critic_prompt(self.lenses, ranking_lines(state.ranking), score_lines(state.scores))
        verdict = await ask_json(self.agent, prompt, CriticVerdict, context=self.context)
        state.critic_rounds += 1
        state.verdicts.append(verdict)
        if verdict.approve or state.critic_rounds >= self.max_rounds:
            await ctx.yield_output(PipelineResult(
                ranking=state.ranking, scores=state.scores, first_scores=state.first_scores,
                approved=verdict.approve, objections=verdict.objections, critic_rounds=state.critic_rounds,
                rescores=state.rescores, verdicts=state.verdicts,
            ))
        else:
            await ctx.send_message(state)


class RescoreNamed(Executor):
    """Only the lenses the critic named re-score only the features it named."""

    def __init__(self, scorers: dict[str, LensScorer], context: dict) -> None:
        super().__init__(id="rescore")
        self.scorers, self.context = scorers, context

    @handler
    async def rescore(self, state: PipelineState, ctx: WorkflowContext[PipelineState]) -> None:
        objections = state.verdicts[-1].objections
        by_lens: dict[str, list[Objection]] = {}
        for o in objections:
            by_lens.setdefault(o.lens, []).append(o)

        reasons_by = {(o.lens, o.feature_id): o.reason for o in objections}

        async def one(lens_id: str, items: list[Objection]) -> tuple[str, list[str], LensScores | None]:
            scorer = self.scorers[lens_id]
            ids = list(dict.fromkeys(o.feature_id for o in items))
            now = state.scores[lens_id].by_feature()
            prompt = rescore_prompt(scorer.lens, {fid: now[fid] for fid in ids},
                                    [f"{o.feature_id}: {o.reason}" for o in items])
            try:
                revised = await ask_json(scorer.agent, prompt, LensScores, context={**self.context, "feature_ids": ids})
            except ReplyError:
                # A bad re-score should not sink the run: keep the score, say so in the readout.
                return lens_id, ids, None
            return lens_id, ids, revised

        for lens_id, ids, revised in await asyncio.gather(*(one(k, v) for k, v in by_lens.items())):
            current = {s.feature_id: s for s in state.scores[lens_id].scores}
            if revised is None:
                for fid in ids:
                    state.rescores.append(Rescore(lens_id, fid, current[fid].score, current[fid].score,
                                                  state.critic_rounds, reasons_by[(lens_id, fid)], failed=True))
                continue
            for s in revised.scores:
                state.rescores.append(Rescore(lens_id, s.feature_id, current[s.feature_id].score, s.score,
                                              state.critic_rounds, reasons_by[(lens_id, s.feature_id)]))
                current[s.feature_id] = s
            state.scores[lens_id] = LensScores(lens=lens_id, scores=list(current.values()))
        await ctx.send_message(state)


# --- Assembly --------------------------------------------------------------------

def build_pipeline(
    scorer_client: Any,
    critic_client: Any,
    settings: Settings,
    counter: CallCounter,
    *,
    without: str | None = None,
) -> Workflow:
    lenses = active_lenses(without)
    context = {"feature_ids": feature_ids(), "lens_ids": [lens.id for lens in lenses]}
    scorers = {
        lens.id: LensScorer(
            lens,
            make_agent(lens.agent_name, SCORER_INSTRUCTIONS, client=scorer_client, settings=settings, counter=counter),
            context,
        )
        for lens in lenses
    }
    critic_agent = make_agent(CRITIC_NAME, CRITIC_INSTRUCTIONS, client=critic_client, settings=settings,
                              counter=counter)
    start = Start(id="start")
    agg = Aggregate(settings.max_critic_rounds)
    critic = Critic(critic_agent, lenses, settings.max_critic_rounds, context)
    rescore = RescoreNamed(scorers, context)

    name = "pipeline" + (f" without {without}" if without else "")
    return (
        WorkflowBuilder(start_executor=start, name=name, description="Lens fan-out, plain-code aggregate, critic loop")
        .add_fan_out_edges(start, list(scorers.values()))
        .add_fan_in_edges(list(scorers.values()), agg)
        .add_edge(agg, critic)
        .add_edge(critic, rescore)
        .add_edge(rescore, agg)
        .build()
    )


async def run_pipeline(workflow: Workflow) -> PipelineResult:
    result = await workflow.run("Rank the Tandem backlog.")
    outputs = [o for o in result.get_outputs() if isinstance(o, PipelineResult)]
    if not outputs:
        raise RuntimeError(f"pipeline finished without a result (state: {result.get_final_state()})")
    return outputs[-1]
