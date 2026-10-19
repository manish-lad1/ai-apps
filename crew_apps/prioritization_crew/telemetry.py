"""OpenTelemetry for the demo: traces only, to the local OTLP collector.

The collector is the one in the Foundry Toolkit for VS Code (OTLP/gRPC on
:4317 by default). Sensitive data (prompts and replies) is never captured.

Only spans are exported. Agent Framework would also build metric and log
exporters from the OTEL_EXPORTER_OTLP_* variables, and a collector without
a metrics endpoint answers those with an error line per export, on a
projector, mid-demo. So the variables are hidden while the framework is
configured, and one span exporter is passed explicitly.

If nothing is listening on the endpoint, tracing is skipped with one quiet
line instead of a stream of export failures.
"""

from __future__ import annotations

import os
import socket
from contextlib import contextmanager
from urllib.parse import urlparse

from config import Settings

SERVICE_NAME = "prioritization_crew"
_configured = False


def collector_reachable(endpoint: str, timeout: float = 0.5) -> bool:
    url = urlparse(endpoint if "://" in endpoint else f"http://{endpoint}")
    try:
        with socket.create_connection((url.hostname or "localhost", url.port or 4317), timeout=timeout):
            return True
    except OSError:
        return False


def setup_tracing(settings: Settings, *, enabled: bool) -> str:
    """Configure span export once. Returns a short status line for the console."""
    global _configured
    if not enabled:
        return "tracing off"
    if settings.otlp_protocol != "grpc":
        return f"tracing off: OTEL_EXPORTER_OTLP_PROTOCOL={settings.otlp_protocol!r} unsupported (use grpc)"
    if not collector_reachable(settings.otlp_endpoint):
        return f"tracing off: no collector at {settings.otlp_endpoint}"
    if _configured:
        return f"tracing to {settings.otlp_endpoint}"

    from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

    from agent_framework.observability import configure_otel_providers

    hidden = {k: os.environ.pop(k) for k in list(os.environ) if k.startswith("OTEL_EXPORTER_OTLP")}
    try:
        configure_otel_providers(
            service_name=SERVICE_NAME,
            enable_sensitive_data=False,
            exporters=[OTLPSpanExporter(endpoint=settings.otlp_endpoint, insecure=True)],
        )
    finally:
        os.environ.update(hidden)
    _configured = True
    return f"tracing to {settings.otlp_endpoint}"


@contextmanager
def run_span(pattern: str, without: str | None, taxonomy: str):
    """The parent span for one run, named for the pattern so traces read on a projector."""
    if not _configured:
        yield
        return
    from agent_framework.observability import get_tracer

    attributes = {"pattern": pattern, "taxonomy": taxonomy, "without": without or ""}
    with get_tracer().start_as_current_span(f"run {pattern}", attributes=attributes):
        yield


def flush() -> None:
    if _configured:
        from opentelemetry import trace

        trace.get_tracer_provider().force_flush()
