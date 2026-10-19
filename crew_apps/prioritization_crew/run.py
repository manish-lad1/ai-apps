"""CLI: run one pattern on the Tandem backlog and print the readout.

    python run.py --pattern agent|pipeline|crew [--without <lens>] [--no-trace]
    python run.py --compare

Model loading happens before the clock starts, so wall time is the pattern
itself, not Foundry warming up.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from dataclasses import asdict

from clients import build_chat_client
from config import load_settings
from foundry_endpoint import FoundryUnavailable
from lenses import LENS_IDS, load_backlog
from patterns.agent import run_agent
from patterns.pipeline import build_pipeline, run_pipeline
from readout import (
    TAXONOMY,
    CallCounter,
    Timer,
    console,
    latest_full_run,
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

BUILT = ("agent", "pipeline")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Agent, pipeline or crew: rank the Tandem backlog.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--pattern", choices=("agent", "pipeline", "crew"))
    group.add_argument("--compare", action="store_true", help="run all three back to back")
    parser.add_argument("--without", choices=LENS_IDS, help="remove one lens")
    parser.add_argument("--no-trace", action="store_true", help="do not export OpenTelemetry spans")
    return parser.parse_args(argv)


def load_clients(specs, settings) -> dict:
    """Build (and for Foundry, load) each distinct model once, printing load time."""
    clients = {}
    for spec in dict.fromkeys(specs):
        started = time.perf_counter()
        clients[spec] = build_chat_client(spec, settings)
        console.print(f"[dim]ready {spec} ({time.perf_counter() - started:.1f}s)[/dim]")
    return clients


async def run_once(pattern: str, without: str | None) -> None:
    settings = load_settings()
    backlog = load_backlog()
    counter = CallCounter()
    extra: dict = {}
    lens_scores = None

    if pattern == "agent":
        models = {"agent": str(settings.agent_model)}
        clients = load_clients([settings.agent_model], settings)
    else:
        models = {"scorer": str(settings.scorer_model)}
        if settings.max_critic_rounds:
            models["critic"] = str(settings.critic_model)
        clients = load_clients(
            [settings.scorer_model] + ([settings.critic_model] if settings.max_critic_rounds else []), settings
        )

    with run_span(pattern, without, TAXONOMY[pattern]), Timer() as timer:
        if pattern == "agent":
            ranking = (await run_agent(clients[settings.agent_model], settings, counter, without=without)).ranking
        else:
            workflow = build_pipeline(clients[settings.scorer_model], clients.get(settings.critic_model), settings,
                                      counter, without=without)
            result = await run_pipeline(workflow)
            ranking, lens_scores = result.ranking, result.score_table()
            extra = {
                "lens_scores": lens_scores,
                "approved": result.approved,
                "critic_rounds": result.critic_rounds,
                "objections": [o.model_dump() for o in result.objections],
                "rescores": [asdict(r) for r in result.rescores],
                "verdicts": [v.model_dump() for v in result.verdicts],
                "lens_scores_before_critic": result.score_table(first=True),
            }
            if "rice" in lens_scores:
                wrong, pairs = rice_check(lens_scores["rice"], backlog)
                before, _ = rice_check(result.score_table(first=True)["rice"], backlog)
                extra["rice_check"] = {"out_of_order_pairs": wrong, "before_critic": before, "pairs": pairs}
    flush()

    print_header(pattern, without)
    print_stats(counter.total, timer.seconds, counter.by_agent)
    print_ranking(ranking, backlog, lens_scores)
    if pattern == "pipeline":
        if "rice" in lens_scores:
            print_rice_check(lens_scores["rice"], backlog, models["scorer"], result.score_table(first=True)["rice"])
        if result.approved is None:
            console.print("[dim]no critic (MAX_CRITIC_ROUNDS=0)[/dim]")
        else:
            console.print(f"[dim]critic reviews: {result.critic_rounds} of max {settings.max_critic_rounds}[/dim]")
            for r in result.rescores:
                outcome = f"[red]re-score invalid, kept {r.before}[/red]" if r.failed else f"{r.before} -> {r.after}"
                console.print(f"re-scored {r.lens} {r.feature_id}: {outcome}  [dim]critic: {r.reason}[/dim]")
            print_objections(result.objections, backlog)

    path = save_run(pattern, without=without, ranking=ranking, counter=counter, wall_seconds=timer.seconds,
                    models=models, extra=extra)
    console.print(f"[dim]saved {path.relative_to(path.parent.parent)}[/dim]")

    if without:
        full = latest_full_run(pattern)
        if full:
            print_rank_delta(Ranking.model_validate(full["ranking"]), ranking, without, backlog)
        else:
            console.print(f"[dim]no full {pattern} run in runs/ yet; run without --without for a rank-delta table[/dim]")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.compare or args.pattern not in BUILT:
        console.print("[yellow]crew and --compare arrive in Phase 3[/yellow]")
        return 2
    console.print(f"[dim]{setup_tracing(load_settings(), enabled=not args.no_trace)}[/dim]")
    try:
        asyncio.run(run_once(args.pattern, args.without))
    except (FoundryUnavailable, ReplyError) as exc:
        console.print(f"[red]{type(exc).__name__}:[/red] {exc}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
