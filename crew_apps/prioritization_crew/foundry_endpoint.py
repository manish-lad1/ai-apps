"""Discovery of the local Foundry service: where it is, and what it serves.

Adapted from pipeline_apps/document_triage_pipeline/foundry_endpoint.py.
Two things are never hardcoded:

  1. The port. Foundry Local picks an ephemeral port and changes it on every
     restart. `foundry status --output json` reports the live URL.
  2. The served model id. It is a hardware-specific variant string like
     `Phi-4-mini-instruct-generic-gpu`. The stable name is the alias
     (`phi-4-mini`), which /v1/models exposes as `parent`.

Foundry Local 0.10.3 does not load models lazily: a request to an unloaded
model returns HTTP 400. Callers load explicitly with `ensure_loaded`.
"""

from __future__ import annotations

import json
import subprocess
import time
from functools import lru_cache

from openai import OpenAI

# The local service is unauthenticated, but the OpenAI client insists on a key.
LOCAL_API_KEY = "not-needed-for-local"


class FoundryUnavailable(RuntimeError):
    """The local service could not be found, reached, or understood."""


def _foundry(*args: str, timeout: int) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(["foundry", *args], capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError as exc:
        raise FoundryUnavailable(
            "The `foundry` CLI is not on PATH. Install it: brew tap microsoft/foundrylocal && "
            "brew install foundrylocal"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise FoundryUnavailable(f"`foundry {' '.join(args)}` did not respond within {timeout}s.") from exc


def discover_service_url() -> str:
    result = _foundry("status", "--output", "json", timeout=60)
    if result.returncode != 0:
        raise FoundryUnavailable(f"`foundry status` failed (exit {result.returncode}): {result.stderr.strip()}")
    try:
        service = json.loads(result.stdout).get("service", {})
    except json.JSONDecodeError as exc:
        raise FoundryUnavailable("`foundry status --output json` did not return JSON (expected CLI 0.10.x).") from exc
    if not service.get("ready"):
        raise FoundryUnavailable(
            f"Foundry service is not ready (state: {service.get('state')!r}). Start it with: foundry server start"
        )
    urls = service.get("webUrls") or []
    if not urls:
        raise FoundryUnavailable("Foundry reports ready but published no service URL.")
    return urls[0].rstrip("/")


def resolve_model_id(base_url: str, alias: str) -> str:
    """Map a stable alias (`phi-4-mini`) to the served variant id."""
    client = OpenAI(base_url=f"{base_url}/v1", api_key=LOCAL_API_KEY)
    served = [m.model_dump() for m in client.models.list().data]
    for entry in served:
        if entry.get("parent") == alias or entry.get("id") == alias:
            return entry["id"]
    available = ", ".join(sorted(str(e.get("parent")) for e in served))
    raise FoundryUnavailable(
        f"No Foundry model matches {alias!r}. Download it with `foundry model download {alias}`. "
        f"Cached aliases: {available or '(none)'}"
    )


def ensure_loaded(model_id: str) -> float:
    """Load a model into the daemon (a no-op if resident). Returns seconds taken."""
    started = time.perf_counter()
    result = _foundry("model", "load", model_id, timeout=1200)
    if result.returncode != 0:
        raise FoundryUnavailable(f"Could not load {model_id!r}: {result.stderr.strip() or result.stdout.strip()}")
    return time.perf_counter() - started


def unload(model_id: str) -> None:
    _foundry("model", "unload", model_id, timeout=300)


@lru_cache(maxsize=None)
def connect(alias: str) -> tuple[str, str]:
    """Discover the service and resolve an alias. Returns (base_url, served model id)."""
    base_url = discover_service_url()
    return base_url, resolve_model_id(base_url, alias)
