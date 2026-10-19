"""Spike step 7: send one trace to the OTLP endpoint and confirm spans arrive.

Run otlp_sink.py first (or have the Foundry Toolkit collector on :4317).
Uses Agent Framework's own configure_otel_providers, sensitive data off,
one parent span carrying the pattern name, one agent named lens.rice.
"""

import asyncio
import time

from opentelemetry import trace

from agent_framework import Agent
from agent_framework.observability import configure_otel_providers, get_tracer
from agent_framework.openai import OpenAIChatCompletionClient

from common import LOCAL_API_KEY, base_url, lens_prompt, load, resolve

configure_otel_providers(
    service_name="prioritization_crew.spike",
    otlp_endpoint="http://localhost:4317",
    otlp_protocol="grpc",
    enable_sensitive_data=False,
)


async def main() -> None:
    model_id = resolve("phi-4-mini")
    load(model_id)
    client = OpenAIChatCompletionClient(model=model_id, base_url=f"{base_url()}/v1", api_key=LOCAL_API_KEY)
    agent = Agent(client, "You return strict JSON only.", name="lens.rice", default_options={"temperature": 0.0})
    t = time.perf_counter()
    with get_tracer().start_as_current_span("pattern.spike", attributes={"pattern": "spike"}):
        await agent.run(lens_prompt("rice"))
    trace.get_tracer_provider().force_flush()
    print(f"agent call + flush in {time.perf_counter() - t:.1f}s")


asyncio.run(main())
