"""What the audience sees after a run, and what gets saved to runs/.

Readable from the back of a room: short lines, one table per idea, no walls
of text. Every chat completion is counted (retries included) by a chat
middleware attached to each agent, so "model calls" is measured, not assumed.
"""

from __future__ import annotations

import json
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from rich.console import Console
from rich.table import Table

from agent_framework import chat_middleware

from lenses import LENSES
from schemas import Disagreement, Objection, Ranking

RUNS_DIR = Path(__file__).parent / "runs"

# The taxonomy this app demonstrates. Do not reword without updating the README.
TAXONOMY = {
    "agent": "_agent: one model looping with itself",
    "pipeline": "_pipeline: separately prompted agents; the artifact moves forward only",
    "crew": "_crew: peer agents contest the same artifact symmetrically",
    "relay": "_pipeline (on the group chat API): order matters, nobody contests",
}

# What each pattern's trace looks like, for the --compare table.
TRACE_SHAPE = {
    "agent": "1 agent call",
    "pipeline": "fan-out → aggregate → critic ⟲ re-score",
    "crew": "round-robin turns, each lens once per round",
}

console = Console()


# --- Measuring -----------------------------------------------------------------

@dataclass
class CallCounter:
    """Counts chat completions per agent. Attach `middleware(name)` to each agent."""

    by_agent: Counter = field(default_factory=Counter)

    @property
    def total(self) -> int:
        return sum(self.by_agent.values())

    def middleware(self, agent_name: str):
        @chat_middleware
        async def count(context, call_next):
            self.by_agent[agent_name] += 1
            await call_next()

        return count


class Timer:
    def __enter__(self) -> Timer:
        self.started = time.perf_counter()
        self.seconds = 0.0
        return self

    def __exit__(self, *exc) -> None:
        self.seconds = time.perf_counter() - self.started


# --- Printing ------------------------------------------------------------------

def _names(backlog: dict) -> dict[str, str]:
    return {f["id"]: f["name"] for f in backlog["features"]}


def print_header(pattern: str, without: str | None = None) -> None:
    title = f"[bold]{pattern.upper()}[/bold]" + (f"  [yellow]without {without}[/yellow]" if without else "")
    console.rule(title)
    console.print(f"[dim]{TAXONOMY[pattern]}[/dim]")


def print_stats(model_calls: int, wall_seconds: float, by_agent: Counter | None = None) -> None:
    console.print(f"[bold]model calls[/bold] {model_calls}    [bold]wall time[/bold] {wall_seconds:.1f}s")
    if by_agent:
        console.print("[dim]" + "  ".join(f"{name} {n}" for name, n in sorted(by_agent.items())) + "[/dim]")


def print_ranking(ranking: Ranking, backlog: dict, lens_scores: dict[str, dict[str, int]] | None = None) -> None:
    """The final ranking. With lens_scores, one column per lens (so --without visibly drops one)."""
    names = _names(backlog)
    table = Table(show_edge=False, header_style="bold")
    table.add_column("#", justify="right")
    table.add_column("feature", no_wrap=True)
    for lens_id in lens_scores or {}:
        table.add_column(LENSES[lens_id].short if lens_id in LENSES else lens_id, justify="right")
    table.add_column("total", justify="right")
    table.add_column("note", style="dim", no_wrap=True)
    for r in ranking.ranked:
        cells = [str(lens_scores[lens_id].get(r.feature_id, "")) for lens_id in lens_scores or {}]
        table.add_row(str(r.rank), names.get(r.feature_id, r.feature_id), *cells, f"{r.total:g}", r.note)
    console.print(table)


def print_objections(objections: list[Objection], backlog: dict) -> None:
    if not objections:
        console.print("[green]critic approved[/green]")
        return
    names = _names(backlog)
    console.print(f"[yellow]outstanding objections ({len(objections)})[/yellow]")
    for o in objections:
        console.print(f"  {o.lens} on {names.get(o.feature_id, o.feature_id)}: {o.reason}")


def print_crew_notes(agreements: list[str], disagreements: list[Disagreement], backlog: dict) -> None:
    names = _names(backlog)
    if agreements:
        console.print("[green]agreements[/green]")
        for a in agreements:
            console.print(f"  {a}")
    if disagreements:
        console.print("[yellow]disagreements (ranks differ by 2+)[/yellow]")
        for d in disagreements:
            spread = "  ".join(f"{LENSES[lens].short if lens in LENSES else lens} #{rank}"
                               for lens, rank in d.positions.items())
            console.print(f"  {names.get(d.feature_id, d.feature_id)}: {spread}")


def print_exchanges(exchanges) -> None:
    """Who answered whom in the crew, one short line each."""
    if not exchanges:
        console.print("[red]no lens answered another lens[/red]")
        return
    console.print("[bold]exchanges[/bold]")
    for e in exchanges:
        colour = "green" if e.stance == "concede" else "magenta"
        console.print(f"  {e.lens} → {e.to_lens} [{colour}]{e.stance}[/{colour}]: [dim]{e.reason}[/dim]")


def print_comparison(summaries, backlog: dict, without: str | None = None) -> None:
    """--compare: the same backlog, three patterns, side by side."""
    names = _names(backlog)
    title = "same task, three patterns" + (f" (without {without})" if without else "")
    table = Table(title=title, show_edge=False, header_style="bold")
    table.add_column("feature", no_wrap=True)
    for s in summaries:
        table.add_column(s.pattern, justify="right")
    for fid in [f["id"] for f in backlog["features"]]:
        table.add_row(names[fid], *[f"#{s.ranking.rank_of()[fid]}" for s in summaries])
    table.add_section()
    table.add_row("model calls", *[str(s.model_calls) for s in summaries])
    table.add_row("wall time", *[f"{s.wall_seconds:.0f}s" for s in summaries])
    console.print(table)
    for s in summaries:
        console.print(f"[dim]{s.pattern} trace: {TRACE_SHAPE[s.pattern]}[/dim]")


def print_rank_delta(with_all: Ranking, without: Ranking, lens: str, backlog: dict) -> None:
    """Rank with every lens vs rank without one: the removal test, as a table."""
    names = _names(backlog)
    before, after = with_all.rank_of(), without.rank_of()
    table = Table(title=f"removing {lens}", show_edge=False, header_style="bold")
    for col in ("feature", "with", "without", "change"):
        table.add_column(col, justify="left" if col == "feature" else "right")
    for fid in sorted(after, key=after.get):
        delta = before.get(fid, 0) - after[fid]
        change = "=" if delta == 0 else (f"[green]+{delta}[/green]" if delta > 0 else f"[red]{delta}[/red]")
        table.add_row(names.get(fid, fid), str(before.get(fid, "-")), str(after[fid]), change)
    console.print(table)


def rice_check(rice_lens_scores: dict[str, int], backlog: dict) -> tuple[float, int]:
    """How far the RICE lens strays from the computed RICE order.

    Counts feature pairs that the lens scored in the opposite order to their
    rice_score (ties in the lens's scores count as half). Returns
    (out_of_order, total_pairs). 0 means the lens followed the arithmetic.
    """
    rice = {f["id"]: f["rice_score"] for f in backlog["features"]}
    ids = [fid for fid in rice if fid in rice_lens_scores]
    wrong, pairs = 0.0, 0
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            if rice[a] == rice[b]:
                continue
            pairs += 1
            hi, lo = (a, b) if rice[a] > rice[b] else (b, a)
            if rice_lens_scores[hi] < rice_lens_scores[lo]:
                wrong += 1
            elif rice_lens_scores[hi] == rice_lens_scores[lo]:
                wrong += 0.5
    return wrong, pairs


def print_rice_check(rice_lens_scores: dict[str, int], backlog: dict, model: str,
                     before: dict[str, int] | None = None) -> None:
    """One line: how many feature pairs the RICE lens put out of computed RICE order."""
    wrong, pairs = rice_check(rice_lens_scores, backlog)
    style = "green" if wrong == 0 else "yellow"
    line = f"[{style}]RICE lens check[/{style}] {model}: {wrong:g}/{pairs} pairs out of order"
    if before is not None and before != rice_lens_scores:
        line += f" [dim](before critic: {rice_check(before, backlog)[0]:g}/{pairs})[/dim]"
    console.print(line)


# --- Run files -----------------------------------------------------------------

def run_path(pattern: str, without: str | None, when: datetime | None = None) -> Path:
    stamp = (when or datetime.now()).strftime("%Y%m%d-%H%M%S")
    return RUNS_DIR / (f"{stamp}_{pattern}" + (f"_without-{without}" if without else "") + ".json")


def save_run(
    pattern: str,
    *,
    without: str | None,
    ranking: Ranking,
    counter: CallCounter,
    wall_seconds: float,
    models: dict[str, str],
    extra: dict[str, Any] | None = None,
) -> Path:
    RUNS_DIR.mkdir(exist_ok=True)
    path = run_path(pattern, without)
    payload = {
        "pattern": pattern,
        "taxonomy": TAXONOMY[pattern],
        "without": without,
        "models": models,
        "model_calls": counter.total,
        "calls_by_agent": dict(counter.by_agent),
        "wall_seconds": round(wall_seconds, 2),
        "ranking": ranking.model_dump(),
        **(extra or {}),
    }
    path.write_text(json.dumps(payload, indent=2, default=lambda o: o.model_dump() if hasattr(o, "model_dump") else str(o)))
    return path


def latest_full_run(pattern: str, runs_dir: Path | None = None) -> dict | None:
    """The newest saved run of `pattern` with every lens, for the rank-delta table."""
    runs_dir = runs_dir or RUNS_DIR
    candidates = sorted(runs_dir.glob(f"*_{pattern}.json")) if runs_dir.exists() else []
    return json.loads(candidates[-1].read_text()) if candidates else None
