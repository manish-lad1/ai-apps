"""Spike step 4: ask a small model for LensScores 10 times; count clean parses.

Usage: python s3_lens_parse.py <alias> [n=10]

Goes through Agent Framework (Agent + OpenAIChatCompletionClient), not raw
OpenAI, because that is the path the app will use. Temperature 0. No tools.
Lenses rotate so ten calls are not ten copies of one deterministic request.
Records first-try parses and parses after one retry (the retry sends the
validation error back in the same session).
"""

import asyncio
import sys
import time

from agent_framework import Agent, AgentSession
from agent_framework.openai import OpenAIChatCompletionClient

from common import LENSES, LOCAL_API_KEY, LensScores, base_url, lens_prompt, load, parse, resolve, save

alias = sys.argv[1]
n = int(sys.argv[2]) if len(sys.argv) > 2 else 10


async def main() -> None:
    model_id = resolve(alias)
    load_s = load(model_id)
    client = OpenAIChatCompletionClient(model=model_id, base_url=f"{base_url()}/v1", api_key=LOCAL_API_KEY)
    lens_names = list(LENSES)
    rows = []
    t_all = time.perf_counter()
    for i in range(n):
        lens = lens_names[i % len(lens_names)]
        agent = Agent(client, name=f"lens.{lens}", instructions="You return strict JSON only.",
                      default_options={"temperature": 0.0, "max_tokens": 1500})
        session = AgentSession()
        t = time.perf_counter()
        r1 = await agent.run(lens_prompt(lens), session=session)
        obj, err = parse(LensScores, r1.text)
        retried, err2 = False, None
        if obj is None:
            retried = True
            r2 = await agent.run(f"That was not valid. Error: {err}. Reply again with corrected JSON only.",
                                 session=session)
            obj, err2 = parse(LensScores, r2.text)
        dt = time.perf_counter() - t
        rows.append({"i": i, "lens": lens, "first_try_ok": not retried, "ok_after_retry": obj is not None,
                     "error": err, "retry_error": err2, "seconds": round(dt, 1), "raw": r1.text[:600]})
        print(f"{i:2} {lens:14} first={'ok ' if not retried else 'BAD'} final={'ok' if obj else 'BAD'} {dt:5.1f}s"
              + (f"  err={err[0][:90] if err else ''}" if retried else ""))
    total = time.perf_counter() - t_all
    first = sum(r["first_try_ok"] for r in rows)
    final = sum(r["ok_after_retry"] for r in rows)
    print(f"\n{alias}: first-try {first}/{n}, after one retry {final}/{n}, total {total:.0f}s, load {load_s:.1f}s")
    save(f"s3_parse_{alias}", {"model": model_id, "first_try_ok": first, "ok_after_retry": final, "n": n,
                               "total_s": total, "load_s": load_s, "rows": rows})


asyncio.run(main())
