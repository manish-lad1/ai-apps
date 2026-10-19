"""CLI: run one pattern on the Tandem backlog and print the readout.

    python run.py --pattern agent|pipeline|crew [--without <lens>] [--no-trace]
    python run.py --compare [--without <lens>] [--no-trace]

Model loading happens before the clock starts, so wall time is the pattern
itself, not Foundry warming up.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from dataclasses import asdict, dataclass

from clients import build_chat_client
from config import ModelSpec, Settings, load_settings
from foundry_endpoint import FoundryUnavailable
from lenses import LENS_IDS, load_backlog
from patterns.agent import run_agent
from patterns.crew import build_crew, run_crew
from patterns.pipeline import build_pipeline, run_pipeline
from readout import (
    TAXONOMY,
    CallCounter,
    Timer,
    console,
    latest_full_run,
    print_comparison,
    print_crew_notes,
    print_exchanges,
    print_header,
    print_objections,
    print_rank_delta,
    print_ranking,
    print_rice_check,
    print_stats,
    rice_check,
    save_run,
)
from schemas import Ranking, ReplyError
from telemetry import flush, run_span, setup_tracing

PATTERNS = ("agent", "pipeline", "crew")


@dataclass
class RunSummary:
    pattern: str
    ranking: Ranking
    model_calls: int
    wall_seconds: float


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Agent, pipeline or crew: rank the Tandem backlog.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--pattern", choices=PATTERNS)
    group.add_argument("--compare", action="store_true", help="run all three back to back")
    parser.add_argument("--without", choices=LENS_IDS, help="remove one lens")
    parser.add_argument("--no-trace", action="store_true", help="do not export OpenTelemetry spans")
    return parser.parse_args(argv)


def models_for(pattern: str, settings: Settings) -> dict[str, ModelSpec]:
    if pattern == "agent":
        return {"agent": settings.agent_model}
    if pattern == "crew":
        return {"crew": settings.crew_model}
    roles = {"scorer": settings.scorer_model}
    if settings.max_critic_rounds:
        roles["critic"] = settings.critic_model
    return roles


def load_clients(specs, settings: Settings) -> dict:
    """Build (and for Foundry, load) each distinct model once, printing load time."""
    clients = {}
    for spec in dict.fromkeys(specs):
        started = time.perf_counter()
        clients[spec] = build_chat_client(spec, settings)
        console.print(f"[dim]ready {spec} ({time.perf_counter() - started:.1f}s)[/dim]")
    return clients


async def run_once(pattern: str, without: str | None) -> RunSummary:
    settings = load_settings()
    backlog = load_backlog()
    counter = CallCounter()
    roles = models_for(pattern, settings)
    clients = load_clients(roles.values(), settings)
    extra: dict = {}
    columns = None

    with run_span(pattern, without, TAXONOMY[pattern]), Timer() as timer:
        if pattern == "agent":
            ranking = (await run_agent(clients[settings.agent_model], settings, counter, without=without)).ranking
        elif pattern == "pipeline":
            workflow = build_pipeline(clients[settings.scorer_model], clients.get(settings.critic_model), settings,
                                      counter, without=without)
            pipe = await run_pipeline(workflow)
            ranking, columns = pipe.ranking, pipe.score_table()
            extra = {
                "lens_scores": columns,
                "lens_scores_before_critic": pipe.score_table(first=True),
                "approved": pipe.approved,
                "critic_rounds": pipe.critic_rounds,
                "objections": [o.model_dump() for o in pipe.objections],
                "rescores": [asdict(r) for r in pipe.rescores],
                "verdicts": [v.model_dump() for v in pipe.verdicts],
            }
            if "rice" in columns:
                wrong, pairs = rice_check(columns["rice"], backlog)
                before, _ = rice_check(pipe.score_table(first=True)["rice"], backlog)
                extra["rice_check"] = {"out_of_order_pairs": wrong, "before_critic": before, "pairs": pairs}
        else:
            client = clients[settings.crew_model]
            crew = await run_crew(build_crew(client, settings, counter, without=without), client, settings, counter,
                                  without=without)
            ranking = crew.ranking
            finals = crew.final_rankings()
            columns = {lens: {fid: order.index(fid) + 1 for fid in order} for lens, order in finals.items()}
            extra = {
                "final_rankings": finals,
                "opening_rankings": {lens: o.ranking for lens, o in crew.openings.items()},
                "agreements": crew.outcome.agreements,
                "disagreements": [d.model_dump() for d in crew.outcome.disagreements],
                "exchanges": [asdict(e) for e in crew.exchanges],
                "moved": crew.moved(),
                "repaired": crew.repaired,
                "fallbacks": crew.fallbacks,
                "transcript": crew.turns,
            }
    flush()

    print_header(pattern, without)
    print_stats(counter.total, timer.seconds, counter.by_agent)
    if pattern == "crew":
        console.print("[dim]lens columns: each lens's final rank; total: Borda points[/dim]")
    print_ranking(ranking, backlog, columns)

    if pattern == "pipeline":
        if "rice" in columns:
            print_rice_check(columns["rice"], backlog, str(roles["scorer"]), pipe.score_table(first=True)["rice"])
        if pipe.approved is None:
            console.print("[dim]no critic (MAX_CRITIC_ROUNDS=0)[/dim]")
        else:
            console.print(f"[dim]critic reviews: {pipe.critic_rounds} of max {settings.max_critic_rounds}[/dim]")
            for r in pipe.rescores:
                outcome = f"[red]re-score invalid, kept {r.before}[/red]" if r.failed else f"{r.before} -> {r.after}"
                console.print(f"re-scored {r.lens} {r.feature_id}: {outcome}  [dim]critic: {r.reason}[/dim]")
            print_objections(pipe.objections, backlog)
    elif pattern == "crew":
        if "rice" in columns:
            # Ranks as scores (rank 1 = highest) so the same pairwise check applies.
            ranks = columns["rice"]
            print_rice_check({fid: len(ranks) + 1 - r for fid, r in ranks.items()}, backlog, str(roles["crew"]))
        print_crew_notes(crew.outcome.agreements, crew.outcome.disagreements, backlog)
        print_exchanges(crew.exchanges)
        moved = crew.moved()
        console.print(f"[dim]rankings changed after round 1: {len(moved)} of {len(crew.finals)}"
                      + (f" ({', '.join(moved)})" if moved else "") + "[/dim]")
        if crew.repaired:
            console.print(f"[dim]needed the JSON retry: {', '.join(crew.repaired)}[/dim]")
        if crew.fallbacks:
            console.print(f"[red]no valid final position, used round 1: {', '.join(crew.fallbacks)}[/red]")

    path = save_run(pattern, without=without, ranking=ranking, counter=counter, wall_seconds=timer.seconds,
                    models={role: str(spec) for role, spec in roles.items()}, extra=extra)
    console.print(f"[dim]saved {path.relative_to(path.parent.parent)}[/dim]")

    if without:
        full = latest_full_run(pattern)
        if full:
            print_rank_delta(Ranking.model_validate(full["ranking"]), ranking, without, backlog)
        else:
            console.print(f"[dim]no full {pattern} run in runs/ yet; run without --without for a rank-delta table[/dim]")

    return RunSummary(pattern, ranking, counter.total, timer.seconds)


async def compare(without: str | None) -> None:
    summaries = [await run_once(pattern, without) for pattern in PATTERNS]
    print_comparison(summaries, load_backlog(), without)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    console.print(f"[dim]{setup_tracing(load_settings(), enabled=not args.no_trace)}[/dim]")
    try:
        asyncio.run(compare(args.without) if args.compare else run_once(args.pattern, args.without))
    except (FoundryUnavailable, ReplyError) as exc:
        console.print(f"[red]{type(exc).__name__}:[/red] {exc}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
