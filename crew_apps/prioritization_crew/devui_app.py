"""DevUI: the agent, the pipeline workflow and the crew workflow, side by side in a browser.

    python devui_app.py            # http://127.0.0.1:8080
    python devui_app.py --port 8090 --no-open

Entities are registered in memory with `serve(entities=[...])`, which is how
the installed DevUI (agent-framework-devui 1.0.0b261015) discovers them
without an entities directory.

Each entity takes any text as input; the backlog is already in its prompt:
  * agent: the ranker, with the backlog and every lens mandate in its instructions
  * pipeline: start -> four lens scorers -> aggregate -> critic (-> re-score)
  * crew: four lens agents in a round-robin group chat

Tracing goes through telemetry.py (spans only, no prompt content). DevUI's
own `instrumentation_enabled` is left off because it turns on sensitive-data
capture. Auth is off because DevUI only binds to 127.0.0.1 here.
"""

from __future__ import annotations

import argparse

from agent_framework.devui import serve

from clients import build_chat_client, make_agent
from config import load_settings
from lenses import active_lenses, ranker_prompt
from patterns.agent import RANKER_INSTRUCTIONS, RANKER_NAME
from patterns.crew import build_crew
from patterns.pipeline import build_pipeline
from readout import CallCounter, console
from telemetry import setup_tracing


def build_entities() -> list:
    settings = load_settings()
    counter = CallCounter()  # DevUI shows its own per-run detail; the counter just satisfies make_agent
    clients = {spec: build_chat_client(spec, settings) for spec in dict.fromkeys(settings.models().values())}

    ranker = make_agent(
        RANKER_NAME,
        f"{RANKER_INSTRUCTIONS}\n\n{ranker_prompt(active_lenses())}",
        client=clients[settings.agent_model], settings=settings, counter=counter,
    )
    pipeline = build_pipeline(clients[settings.scorer_model], clients[settings.critic_model], settings, counter)
    crew = build_crew(clients[settings.crew_model], settings, counter)
    return [ranker, pipeline, crew]


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
    console.print(f"DevUI on http://127.0.0.1:{args.port}  (agent, pipeline, crew)")
    serve(entities=entities, host="127.0.0.1", port=args.port, auto_open=not args.no_open, auth_enabled=False)


if __name__ == "__main__":
    main()
