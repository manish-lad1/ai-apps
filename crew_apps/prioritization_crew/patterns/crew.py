"""Pattern 3, _crew: lens agents contest one ranking in a round-robin group chat.

    round 1:  rice → strategic_fit → effort_risk → customer_pain   (each states a ranking + objection)
    round 2:  rice → strategic_fit → effort_risk → customer_pain   (each answers another lens by id)
    synthesis: Borda count over the final rankings, in plain code

Built on the framework's GroupChatBuilder with a plain-code round-robin
selection function: no model picks the speaker, and there is no manager or
moderator model. Adding one would make it a different pattern. Every member
contests the same artifact with the same powers, and the order is fixed
only so runs repeat; any order would do.

Local-model adapter (Phase 0 spike): the group chat hands each member its
peers' turns as assistant messages, and mistral-nemo answers that with an
empty string. clients.peer_view rewrites peers' turns as attributed user
turns. It changes how the conversation is presented, not who speaks or when.

Removal test: --without drops a voice from the chat. Unlike the pipeline,
the remaining members never hear that lens's arguments, so what changes is
the argument itself, not just one column of the sum.
"""

import json
import time
from dataclasses import asdict, dataclass, field
from typing import Any

from agent_framework import Agent, Message, Workflow
from agent_framework.orchestrations import GroupChatBuilder, GroupChatOrchestrator

# Not re-exported by agent-framework-orchestrations 1.3.2, but needed to build an orchestrator.
from agent_framework_orchestrations._base_group_chat_orchestrator import ParticipantRegistry

from clients import make_agent, peer_view, repair_json
from config import Settings
from lenses import (
    LENSES,
    Lens,
    active_lenses,
    crew_instructions,
    crew_opening_shape,
    crew_position_shape,
    crew_task,
    feature_ids,
    load_backlog,
)
from readout import CallCounter, crew_text, latest_full_run, save_run
from schemas import (
    CrewOpening,
    CrewOutcome,
    CrewPosition,
    Disagreement,
    RankedFeature,
    Ranking,
    ReplyError,
    extract_json,
    parse_reply,
)

DISAGREEMENT_SPREAD = 2  # ranks differing by this much or more across lenses


# --- Plain-code synthesis ----------------------------------------------------------

def borda(positions: dict[str, list[str]], backlog: dict | None = None) -> Ranking:
    """Borda count: with n features, 1st place earns n-1 points, last earns 0.

    Ties go to lower effort, then feature id, the same rule as the pipeline.
    """
    backlog = backlog or load_backlog()
    effort = {f["id"]: f["effort"] for f in backlog["features"]}
    ids = [f["id"] for f in backlog["features"]]
    n = len(ids)
    points = {fid: 0 for fid in ids}
    for ranking in positions.values():
        for place, fid in enumerate(ranking):
            points[fid] += n - 1 - place
    order = sorted(ids, key=lambda fid: (-points[fid], effort[fid], fid))
    return Ranking(ranked=[
        RankedFeature(feature_id=fid, rank=i, total=points[fid], note=_spread_note(positions, fid))
        for i, fid in enumerate(order, 1)
    ])


def ranks_by_lens(positions: dict[str, list[str]], fid: str) -> dict[str, int]:
    return {lens: ranking.index(fid) + 1 for lens, ranking in positions.items()}


def _spread_note(positions: dict[str, list[str]], fid: str) -> str:
    ranks = ranks_by_lens(positions, fid)
    lo, hi = min(ranks.values()), max(ranks.values())
    return f"ranked #{lo}" if lo == hi else f"ranked #{lo}-#{hi}"


def find_disagreements(positions: dict[str, list[str]], backlog: dict | None = None) -> list[Disagreement]:
    out = []
    for fid in feature_ids(backlog):
        ranks = ranks_by_lens(positions, fid)
        if max(ranks.values()) - min(ranks.values()) >= DISAGREEMENT_SPREAD:
            out.append(Disagreement(feature_id=fid, positions=ranks))
    return out


def find_agreements(positions: dict[str, list[str]], backlog: dict | None = None) -> list[str]:
    backlog = backlog or load_backlog()
    names = {f["id"]: f["name"] for f in backlog["features"]}
    out = []
    for fid in feature_ids(backlog):
        ranks = ranks_by_lens(positions, fid)
        lo, hi = min(ranks.values()), max(ranks.values())
        if hi - lo < DISAGREEMENT_SPREAD:
            where = f"#{lo}" if lo == hi else f"#{lo}-#{hi}"
            out.append(f"{names[fid]}: every lens ranks it {where}")
    return out


def synthesize(positions: dict[str, list[str]], backlog: dict | None = None) -> CrewOutcome:
    return CrewOutcome(
        ranking=borda(positions, backlog),
        agreements=find_agreements(positions, backlog),
        disagreements=find_disagreements(positions, backlog),
    )


# --- Result ------------------------------------------------------------------------

@dataclass
class Exchange:
    round: int
    lens: str
    to_lens: str
    stance: str
    reason: str


@dataclass
class CrewResult:
    outcome: CrewOutcome
    openings: dict[str, CrewOpening]
    finals: dict[str, CrewPosition]
    exchanges: list[Exchange]
    repaired: list[str] = field(default_factory=list)  # "lens.x round n" turns that needed the one retry
    fallbacks: list[str] = field(default_factory=list)  # lenses whose final position stayed invalid
    turns: list[dict] = field(default_factory=list)  # raw transcript, for the run file

    @property
    def ranking(self) -> Ranking:
        return self.outcome.ranking

    def moved(self) -> list[str]:
        """Lenses whose final ranking differs from their round-1 ranking."""
        return [lens for lens, final in self.finals.items()
                if lens in self.openings and final.ranking != self.openings[lens].ranking]

    def final_rankings(self) -> dict[str, list[str]]:
        rankings = {lens: p.ranking for lens, p in self.finals.items()}
        rankings.update({lens: self.openings[lens].ranking for lens in self.fallbacks})
        return rankings


# --- Turn prompts ------------------------------------------------------------------

def _ranking_in(text: str | None) -> list[str] | None:
    try:
        ranking = json.loads(extract_json(text or "")).get("ranking")
    except (json.JSONDecodeError, AttributeError):
        return None
    return ranking if isinstance(ranking, list) else None


def sharpest_gaps(own: list[str], peers: dict[str, list[str]], limit: int = 2) -> list[tuple[str, str, int, int]]:
    """(peer, feature, peer's rank, my rank) for the biggest rank gaps, at most one per peer."""
    gaps = []
    for peer, ranking in peers.items():
        best = max(((fid, ranking.index(fid) + 1, own.index(fid) + 1) for fid in ranking if fid in own),
                   key=lambda g: abs(g[1] - g[2]), default=None)
        if best and best[1] != best[2]:
            gaps.append((peer, *best))
    return sorted(gaps, key=lambda g: -abs(g[2] - g[3]))[:limit]


def crew_turn_prompt(me: str, round_: int, peers: dict[str, str], own: str | None) -> str:
    """The user turn that ends every member's context (via peer_view).

    Round 1 just names the speaker. Later rounds name the required shape and
    the speaker's sharpest disagreements, computed in code from the peers'
    rankings. Without this, nemo's last speaker repeated its round-1 reply
    verbatim (Phase 3, 3 of 3 runs). The digest is the same kind of
    information for every member, so the crew stays symmetric; it picks no
    speaker and decides nothing.
    """
    lens = LENSES[me.removeprefix("lens.")]
    if round_ == 1:
        return f"Your turn, {me}. This is ROUND 1. Reply with JSON only:\n{crew_opening_shape(lens)}"
    names = {f["id"]: f["name"] for f in load_backlog()["features"]}
    own_ranking = _ranking_in(own)
    peer_rankings = {p.removeprefix("lens."): r for p, t in peers.items() if (r := _ranking_in(t))}
    lines = [
        f"- {peer} ranks {names.get(fid, fid)} ({fid}) #{theirs}; you rank it #{mine}."
        for peer, fid, theirs, mine in (sharpest_gaps(own_ranking, peer_rankings) if own_ranking else [])
    ]
    digest = ("Your sharpest disagreements:\n" + "\n".join(lines) + "\n") if lines else ""
    return (
        f"Your turn, {me}. This is ROUND {round_}.\n{digest}"
        "Answer at least one other lens by its id about a specific disagreement: concede or rebut, with a "
        "reason. Then give your final ranking, changed if you were convinced. Use this shape (it has "
        f"`responses`, not `objection`). Reply with JSON only:\n{crew_position_shape(lens)}"
    )


# --- Assembly ----------------------------------------------------------------------

def round_robin(state) -> str:
    """Plain code picks the next speaker: participants in fixed order, forever."""
    names = list(state.participants)
    return names[state.current_round % len(names)]


def _repair_agent(lens: Lens, lenses: list[Lens], client: Any, settings: Settings, counter: CallCounter) -> Agent:
    # Same name and instructions, no peer_view: the repair is not a turn in the chat.
    return make_agent(lens.agent_name, crew_instructions(lens, lenses), client=client, settings=settings,
                      counter=counter, max_tokens=800)


def turns_from(conversation: list, order: list[str], rounds: int) -> list[dict]:
    """The members' turns, in order, each tagged with its round (a member's nth turn is round n)."""
    seen: dict[str, int] = {}
    turns = []
    for message in conversation:
        author = getattr(message, "author_name", None)
        if author not in order:
            continue
        seen[author] = seen.get(author, 0) + 1
        if seen[author] <= rounds:
            turns.append({"round": seen[author], "author": author, "text": message.text or ""})
    return turns


async def analyse_turns(turns: list[dict], lenses: list[Lens], client: Any, settings: Settings,
                        counter: CallCounter) -> CrewResult:
    """Validate every turn (one repair each), then Borda the final positions. Plain code throughout."""
    context = {"feature_ids": feature_ids(), "lens_ids": [lens.id for lens in lenses]}
    by_name = {lens.agent_name: lens for lens in lenses}
    openings: dict[str, CrewOpening] = {}
    finals: dict[str, CrewPosition] = {}
    exchanges: list[Exchange] = []
    repaired: list[str] = []
    fallbacks: list[str] = []

    for turn in turns:
        lens = by_name[turn["author"]]
        model = CrewOpening if turn["round"] == 1 else CrewPosition
        try:
            parsed = parse_reply(model, turn["text"], context)
        except ReplyError:
            repaired.append(f"{lens.agent_name} round {turn['round']}")
            try:
                shape = crew_opening_shape(lens) if model is CrewOpening else crew_position_shape(lens)
                parsed = await repair_json(_repair_agent(lens, lenses, client, settings, counter), turn["text"],
                                           model, context=context, shape=shape)
            except ReplyError:
                if turn["round"] == settings.max_crew_rounds:
                    fallbacks.append(lens.id)
                continue
        if isinstance(parsed, CrewOpening):
            openings[lens.id] = parsed
        else:
            finals[lens.id] = parsed
            exchanges += [Exchange(turn["round"], lens.id, r.to_lens, r.stance, r.reason) for r in parsed.responses]

    # A lens with no valid final position falls back to its opening ranking, and says so.
    for lens in lenses:
        if lens.id not in finals and lens.id in openings and lens.id not in fallbacks:
            fallbacks.append(lens.id)
    missing = [lens.id for lens in lenses if lens.id not in finals and lens.id not in openings]
    if missing:
        raise ReplyError(f"crew: no valid position at all from {', '.join(missing)}")

    final_rankings = {lens: p.ranking for lens, p in finals.items()}
    final_rankings.update({lens: openings[lens].ranking for lens in fallbacks})
    return CrewResult(synthesize(final_rankings), openings, finals, exchanges, repaired, fallbacks, turns)


def run_extra(result: CrewResult) -> dict:
    """What a saved crew run records beyond the ranking (run.py and DevUI share it)."""
    return {
        "final_rankings": result.final_rankings(),
        "opening_rankings": {lens: o.ranking for lens, o in result.openings.items()},
        "agreements": result.outcome.agreements,
        "disagreements": [d.model_dump() for d in result.outcome.disagreements],
        "exchanges": [asdict(e) for e in result.exchanges],
        "moved": result.moved(),
        "repaired": result.repaired,
        "fallbacks": result.fallbacks,
        "transcript": result.turns,
    }


class CrewOrchestrator(GroupChatOrchestrator):
    """The framework's round-robin group chat orchestrator, ending in plain-code synthesis.

    It picks speakers exactly as GroupChatOrchestrator does (with round_robin).
    The only change is what happens when the last round ends: instead of the
    stock "reached the maximum number of rounds" message, it validates every
    turn, runs the Borda count, and yields the crew's answer as the workflow's
    final output: the CrewResult for run.py, or a text report for DevUI. No model is
    involved in that step, so there is still no manager or moderator model.
    """

    def __init__(self, *, participant_registry, lenses: list[Lens], client: Any, settings: Settings,
                 counter: CallCounter, without: str | None, ui: bool) -> None:
        super().__init__(
            id=GroupChatBuilder.DEFAULT_ORCHESTRATOR_ID,
            participant_registry=participant_registry,
            selection_func=round_robin,
            name="round_robin",
            max_rounds=len(lenses) * settings.max_crew_rounds,
        )
        self.lenses, self.client, self.settings, self.counter = lenses, client, settings, counter
        self.without, self.ui = without, ui
        self._started, self._calls_mark = time.perf_counter(), counter.mark()

    @property
    def input_types(self):
        """Advertise plain text as the crew's input, not Message.

        DevUI builds its input form from the start executor's input types and
        prefers Message when offered, which gives a six-field form (role,
        contents, author_name, ...). Leaving Message and list[Message] out makes
        it a single text box, like the other patterns. The handlers are
        unchanged; member replies still type-check on their edges.
        """
        return [t for t in super().input_types if t not in (Message, list[Message])]

    async def _handle_messages(self, messages, ctx) -> None:
        # A new run starts here; one built workflow can run many times (DevUI).
        self._started, self._calls_mark = time.perf_counter(), self.counter.mark()
        # Always open with the same task, whatever was typed. The agent and the
        # pipeline ignore their input too, and the crew's members are sensitive
        # to wording: "Rank the backlog." gave a different crew ranking.
        await super()._handle_messages([Message("user", [crew_task()])], ctx)

    async def _check_round_limit_and_yield(self, ctx) -> bool:
        if not self._check_round_limit():
            return False
        order = [lens.agent_name for lens in self.lenses]
        turns = turns_from(self._get_conversation(), order, self.settings.max_crew_rounds)
        result = await analyse_turns(turns, self.lenses, self.client, self.settings, self.counter)
        if not self.ui:
            await ctx.yield_output(result)
        else:
            # DevUI stacks every output in one box, so the text report is the only one.
            wall = time.perf_counter() - self._started
            run_calls = self.counter.since(self._calls_mark)
            backlog = load_backlog()
            full = latest_full_run("crew") if self.without else None
            save_run("crew", without=self.without, ranking=result.ranking, counter=run_calls, wall_seconds=wall,
                     models={"crew": str(self.settings.crew_model)}, extra=run_extra(result))
            await ctx.yield_output(crew_text(
                result, backlog, calls=run_calls.total, wall=wall, by_agent=dict(run_calls.by_agent),
                without=self.without, full_ranking=Ranking.model_validate(full["ranking"]) if full else None,
            ))
        return True


class CrewBuilder(GroupChatBuilder):
    """GroupChatBuilder that installs CrewOrchestrator.

    The builder only accepts a ready-made orchestrator, and an orchestrator
    needs the participant registry the builder creates, so the one place to
    hook in is _resolve_orchestrator.
    """

    def __init__(self, *, crew_orchestrator_kwargs: dict, **kwargs) -> None:
        super().__init__(**kwargs)
        self._crew_kwargs = crew_orchestrator_kwargs

    def _resolve_orchestrator(self, participants):
        return CrewOrchestrator(participant_registry=ParticipantRegistry(participants), **self._crew_kwargs)


def build_crew(client: Any, settings: Settings, counter: CallCounter, *, without: str | None = None,
               ui: bool = False) -> Workflow:
    """`ui=True` (DevUI) adds a saved run file and a plain-text report as the final output."""
    lenses = active_lenses(without)
    members = [
        make_agent(lens.agent_name, crew_instructions(lens, lenses), client=client, settings=settings,
                   counter=counter, max_tokens=800, middleware=[peer_view(lens.agent_name, crew_turn_prompt)])
        for lens in lenses
    ]
    return CrewBuilder(
        name="crew" + (f" without {without}" if without else ""),
        participants=members,
        selection_func=round_robin,  # what CrewOrchestrator uses; set here too so the builder validates
        # DevUI: member turns are intermediate (visible in the timeline), so the final
        # output box holds only the crew's report.
        **({"intermediate_output_from": "all"} if ui else {"output_from": "all"}),
        crew_orchestrator_kwargs={"lenses": lenses, "client": client, "settings": settings, "counter": counter,
                                  "without": without, "ui": ui},
    ).build()


async def run_crew(workflow: Workflow) -> CrewResult:
    result = await workflow.run(crew_task())
    outputs = [o for o in result.get_outputs() if isinstance(o, CrewResult)]
    if not outputs:
        raise RuntimeError(f"crew finished without a result (state: {result.get_final_state()})")
    return outputs[-1]
