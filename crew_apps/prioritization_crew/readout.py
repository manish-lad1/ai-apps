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

    def mark(self) -> Counter:
        """A snapshot to measure one run against, when agents outlive a run (DevUI)."""
        return Counter(self.by_agent)

    def since(self, mark: Counter) -> CallCounter:
        return CallCounter(Counter({k: v - mark.get(k, 0) for k, v in self.by_agent.items() if v - mark.get(k, 0)}))


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


# --- Text reports (DevUI) ------------------------------------------------------
#
# DevUI shows a workflow's final output in a narrow monospace box with no
# markdown, and breaks long lines mid-word. These build plain text that reads
# well there: tables fit in TEXT_WIDTH, and every other line is wrapped at word
# boundaries. They take plain data, so patterns can call them without an import
# cycle.

TEXT_WIDTH = 52

TEXT_TRACE_SHAPE = {
    "agent": "one agent call",
    "pipeline": "fan-out > aggregate > critic > re-score",
    "crew": "round-robin turns, then Borda",
}


def _finish(lines: list[str]) -> str:
    """Join report lines, wrapping long ones at word boundaries with an indent."""
    import textwrap

    out = []
    for line in lines:
        if len(line) <= TEXT_WIDTH:
            out.append(line)
            continue
        indent = " " * (len(line) - len(line.lstrip()) + 2)
        out += textwrap.wrap(line, TEXT_WIDTH, subsequent_indent=indent, break_long_words=False)
    return "\n".join(out)


def _short_names(backlog: dict) -> dict[str, str]:
    return {f["id"]: f.get("short_name") or f["name"] for f in backlog["features"]}


def _lens_label(lens_id: str) -> str:
    return LENSES[lens_id].short if lens_id in LENSES else lens_id


def text_header(pattern: str, without: str | None, calls: int, wall: float, by_agent: dict) -> list[str]:
    title = pattern.upper() + (f"  without {without}" if without else "")
    agents = ", ".join(f"{name.removeprefix('lens.')} {n}" for name, n in sorted(by_agent.items()))
    return [title, TAXONOMY[pattern], "", f"model calls {calls}   wall time {wall:.1f}s", f"calls: {agents}", ""]


def text_ranking(ranking: Ranking, backlog: dict, columns: dict[str, dict[str, int]] | None = None,
                 *, as_ranks: bool = False, total_label: str = "total") -> list[str]:
    """One row per feature: rank, short name, optional per-lens column, total."""
    names = _short_names(backlog)
    cols = list(columns or {})
    lines = [f"{'#':>2} {'feature':<12}" + "".join(f"{_lens_label(c):>7}" for c in cols) + f"{total_label:>7}"]
    for r in ranking.ranked:
        cells = "".join(f"{('#' if as_ranks else '') + str(columns[c][r.feature_id]):>7}" for c in cols)
        lines.append(f"{r.rank:>2} {names[r.feature_id]:<12}{cells}{r.total:>7g}")
    return lines


def text_rank_delta(full: Ranking, without_ranking: Ranking, lens: str, backlog: dict) -> list[str]:
    names = _short_names(backlog)
    before, after = full.rank_of(), without_ranking.rank_of()
    lines = [f"Removal test: without {lens}", f"{'feature':<12}{'with':>6}{'without':>9}{'change':>8}"]
    for fid in sorted(after, key=after.get):
        delta = before[fid] - after[fid]
        change = "=" if delta == 0 else f"{delta:+d}"
        lines.append(f"{names[fid]:<12}{before[fid]:>6}{after[fid]:>9}{change:>8}")
    return lines


def _delta_block(full_ranking: Ranking | None, ranking: Ranking, without: str | None, backlog: dict,
                 pattern: str) -> list[str]:
    if not without:
        return []
    if full_ranking is None:
        return ["", f"Removal test: run the full {pattern} first,", "then this again, to see the rank change."]
    return ["", *text_rank_delta(full_ranking, ranking, without, backlog)]


def text_rice_line(rice_scores: dict[str, int], backlog: dict, before: dict[str, int] | None = None) -> str:
    wrong, pairs = rice_check(rice_scores, backlog)
    line = f"RICE check: {wrong:g}/{pairs} pairs out of RICE order"
    if before is not None and before != rice_scores:
        line += f" (before critic {rice_check(before, backlog)[0]:g}/{pairs})"
    return line


def agent_text(ranking: Ranking, backlog: dict, *, calls: int, wall: float, by_agent: dict,
               without: str | None, full_ranking: Ranking | None) -> str:
    lines = text_header("agent", without, calls, wall, by_agent)
    lines += text_ranking(ranking, backlog)
    order = [r.feature_id for r in ranking.ranked]
    if order == [f["id"] for f in backlog["features"]]:
        lines += ["", "Note: this is the backlog's own order (F1-F6)."]
    lines += _delta_block(full_ranking, ranking, without, backlog, "agent")
    return _finish(lines)


def pipeline_text(result, backlog: dict, *, calls: int, wall: float, by_agent: dict, without: str | None,
                  max_rounds: int, full_ranking: Ranking | None) -> str:
    """`result` is a patterns.pipeline.PipelineResult."""
    names = _short_names(backlog)
    scores = result.score_table()
    lines = text_header("pipeline", without, calls, wall, by_agent)
    lines += ["Lens scores (1-10) and their sum", *text_ranking(result.ranking, backlog, scores)]
    if "rice" in scores:
        lines += ["", text_rice_line(scores["rice"], backlog, result.score_table(first=True)["rice"])]
    if result.approved is None:
        lines += ["", "No critic (MAX_CRITIC_ROUNDS=0)."]
    else:
        verdict = "approved" if result.approved else "NOT approved"
        lines += ["", f"Critic: {result.critic_rounds} of {max_rounds} reviews, {verdict}"]
        if result.rescores:
            lines.append("Re-scored after critic:")
            for r in result.rescores:
                outcome = f"invalid, kept {r.before}" if r.failed else f"{r.before} -> {r.after}"
                lines.append(f"  {_lens_label(r.lens)} {names[r.feature_id]}: {outcome}")
        if result.objections:
            lines.append("Outstanding objections:")
            for o in result.objections:
                lines.append(f"  {_lens_label(o.lens)} on {names[o.feature_id]}: {o.reason}")
    lines += _delta_block(full_ranking, result.ranking, without, backlog, "pipeline")
    return _finish(lines)


def crew_text(result, backlog: dict, *, calls: int, wall: float, by_agent: dict, without: str | None,
              full_ranking: Ranking | None) -> str:
    """`result` is a patterns.crew.CrewResult."""
    names = _short_names(backlog)
    finals = result.final_rankings()
    ranks = {lens: {fid: order.index(fid) + 1 for fid in order} for lens, order in finals.items()}
    lines = text_header("crew", without, calls, wall, by_agent)
    lines += ["Each lens's final rank, Borda points", *text_ranking(result.ranking, backlog, ranks, as_ranks=True,
                                                                    total_label="Borda")]
    if "rice" in ranks:
        lines += ["", text_rice_line({fid: len(ranks["rice"]) + 1 - r for fid, r in ranks["rice"].items()}, backlog)]
    moved = result.moved()
    lines += ["", f"Changed ranking after round 1: {len(moved)} of {len(result.finals)}"
              + (f" ({', '.join(moved)})" if moved else "")]
    if result.outcome.disagreements:
        lines.append("Disagreements (ranks 2+ apart):")
        for d in result.outcome.disagreements:
            spread = " ".join(f"{_lens_label(lens)} #{rank}" for lens, rank in d.positions.items())
            lines.append(f"  {names[d.feature_id]}: {spread}")
    if result.outcome.agreements:
        lines.append("Agreements:")
        lines += [f"  {a}" for a in result.outcome.agreements]
    if result.exchanges:
        lines.append("Exchanges:")
        for e in result.exchanges:
            lines.append(f"  {e.lens} > {e.to_lens} {e.stance}: {e.reason}")
    else:
        lines.append("Exchanges: none (no lens answered another)")
    if result.repaired:
        lines.append(f"Needed the JSON retry: {', '.join(result.repaired)}")
    if result.fallbacks:
        lines.append(f"No valid final position, used round 1: {', '.join(result.fallbacks)}")
    lines += _delta_block(full_ranking, result.ranking, without, backlog, "crew")
    return _finish(lines)


def compare_text(runs: dict[str, dict | None], backlog: dict) -> str:
    """Side by side from saved run files: {pattern: run dict or None}."""
    names = _short_names(backlog)
    have = {p: r for p, r in runs.items() if r}
    missing = [p for p, r in runs.items() if not r]
    lines = ["COMPARE  latest full run of each pattern", ""]
    if not have:
        return _finish(lines + ["No runs yet. Run agent, pipeline and crew", "first, then compare."])
    pats = list(have)
    head = {"agent": "agent", "pipeline": "pipe", "crew": "crew"}
    lines.append(f"{'feature':<12}" + "".join(f"{head.get(p, p):>8}" for p in pats))
    ranks = {p: {r["feature_id"]: r["rank"] for r in have[p]["ranking"]["ranked"]} for p in pats}
    for fid in [f["id"] for f in backlog["features"]]:
        lines.append(f"{names[fid]:<12}" + "".join(f"{'#' + str(ranks[p][fid]):>8}" for p in pats))
    lines.append("")
    lines.append(f"{'model calls':<12}" + "".join(f"{have[p]['model_calls']:>8}" for p in pats))
    lines.append(f"{'wall time':<12}" + "".join(f"{have[p]['wall_seconds']:>7.0f}s" for p in pats))
    lines.append("")
    lines += [f"{p}: {TEXT_TRACE_SHAPE.get(p, '')}" for p in pats]
    if missing:
        lines += ["", f"Not run yet: {', '.join(missing)}"]
    return _finish(lines)
