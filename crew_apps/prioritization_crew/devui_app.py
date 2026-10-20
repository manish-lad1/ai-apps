"""DevUI: every demo step in the browser, nothing on the terminal.

    python devui_app.py            # http://127.0.0.1:8080
    python devui_app.py --port 8090 --no-open

Six entries, each run with Configure & Run (any input text works; the backlog
is already in every prompt). Each ends on a plain-text report as its final
output, and every run is saved to runs/ so the compare and removal tables
have something to read:

  1. agent                          one model, all lenses, one call
  2. pipeline                       four lens scorers > aggregate > critic loop
  3. crew                           four lens agents, round-robin, then Borda
  4. pipeline without <lens>        removal test; shows the rank change against the
  5. crew without <lens>            latest full run of that pattern
  6. compare                        latest full agent / pipeline / crew runs side by side
                                    (reads runs/, no model calls)

<lens> is DEVUI_WITHOUT (default customer_pain).

Entities are registered in memory with `serve(entities=[...])`, which is how
the installed DevUI (agent-framework-devui 1.0.0b261015) discovers them.
Tracing goes through telemetry.py (spans only, no prompt content); DevUI's
own `instrumentation_enabled` is off because it captures sensitive data.
Auth is off because DevUI binds to 127.0.0.1 only.
"""

from __future__ import annotations

import argparse

from typing_extensions import Never

from agent_framework import Executor, Workflow, WorkflowBuilder, WorkflowContext, handler
from agent_framework.devui import serve

from clients import build_chat_client
from config import load_settings
from lenses import load_backlog
from patterns.agent import build_agent_workflow
from patterns.crew import build_crew
from patterns.pipeline import build_pipeline
from readout import CallCounter, compare_text, console, latest_full_run
from telemetry import setup_tracing


class CompareRuns(Executor):
    """Reads the latest full run of each pattern from runs/ and lays them side by side."""

    def __init__(self) -> None:
        super().__init__(id="compare")

    @handler
    async def compare(self, prompt: str, ctx: WorkflowContext[Never, str]) -> None:
        runs = {pattern: latest_full_run(pattern) for pattern in ("agent", "pipeline", "crew")}
        await ctx.yield_output(compare_text(runs, load_backlog()))


def build_compare() -> Workflow:
    return WorkflowBuilder(start_executor=CompareRuns(), name="compare",
                           description="Latest agent, pipeline and crew runs side by side").build()


def build_entities() -> list:
    settings = load_settings()
    counter = CallCounter()  # shared; each run reports only its own calls (CallCounter.since)
    clients = {spec: build_chat_client(spec, settings) for spec in dict.fromkeys(settings.models().values())}
    scorer, critic, crew_client = (clients[settings.scorer_model], clients[settings.critic_model],
                                   clients[settings.crew_model])
    without = settings.devui_without
    return [
        build_agent_workflow(clients[settings.agent_model], settings, counter),
        build_pipeline(scorer, critic, settings, counter, ui=True),
        build_crew(crew_client, settings, counter, ui=True),
        build_pipeline(scorer, critic, settings, counter, without=without, ui=True),
        build_crew(crew_client, settings, counter, without=without, ui=True),
        build_compare(),
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--no-open", action="store_true", help="do not open a browser tab")
    parser.add_argument("--no-trace", action="store_true")
    args = parser.parse_args()

    settings = load_settings()
    console.print(f"[dim]{setup_tracing(settings, enabled=settings.enable_tracing and not args.no_trace)}[/dim]")
    console.print("[dim]loading models...[/dim]")
    entities = build_entities()
    console.print(f"DevUI on http://127.0.0.1:{args.port}")
    serve(entities=entities, host="127.0.0.1", port=args.port, auto_open=not args.no_open, auth_enabled=False)


if __name__ == "__main__":
    main()
