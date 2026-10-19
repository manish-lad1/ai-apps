"""Load every configured model and send each a one-line prompt. Run it an hour before the talk.

    python warmup.py

Prints load time and first-reply time per model, and the memory picture.
On a 24 GB machine with other apps open, the models load but push the system
into swap (Phase 0 spike); quit what you can first.
"""

from __future__ import annotations

import asyncio
import sys
import time

import psutil
from rich.table import Table

from agent_framework import AgentSession

from clients import build_chat_client, make_agent
from config import load_settings
from readout import CallCounter, console


async def warm() -> int:
    settings = load_settings()
    roles_by_model: dict = {}
    for role, spec in settings.models().items():
        roles_by_model.setdefault(spec, []).append(role)

    table = Table(title="warm-up", show_edge=False, header_style="bold")
    for col in ("model", "roles", "load", "first reply", "says"):
        table.add_column(col, justify="right" if col in ("load", "first reply") else "left")

    failed = False
    for spec, roles in roles_by_model.items():
        try:
            started = time.perf_counter()
            client = build_chat_client(spec, settings)
            load_s = time.perf_counter() - started
            agent = make_agent("warmup", "Reply with one word.", client=client, settings=settings,
                               counter=CallCounter(), max_tokens=20)
            started = time.perf_counter()
            reply = await agent.run("Say: ready", session=AgentSession())
            table.add_row(str(spec), ", ".join(roles), f"{load_s:.1f}s", f"{time.perf_counter() - started:.1f}s",
                          (reply.text or "").strip()[:20])
        except Exception as exc:  # noqa: BLE001 - report every model, then fail
            failed = True
            table.add_row(str(spec), ", ".join(roles), "-", "-", f"[red]{type(exc).__name__}: {str(exc)[:60]}[/red]")

    console.print(table)
    vm, swap = psutil.virtual_memory(), psutil.swap_memory()
    console.print(f"[dim]memory available {vm.available / 2**30:.1f} GB of {vm.total / 2**30:.0f} GB · "
                  f"swap used {swap.used / 2**30:.1f} GB[/dim]")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(warm()))
