"""Discovery of the local Foundry service: where it is, and what it serves.

Two things must never be hardcoded in this project:

  1. The port. Foundry Local picks an ephemeral port and changes it whenever
     the service restarts. `foundry status --output json` reports the live URL.
  2. The model ID. The served ID is a hardware-specific variant string like
     `Phi-4-mini-instruct-generic-gpu`. The stable name is the alias
     (`phi-4-mini`), which the /v1/models response exposes as `parent`.

Every entry point in the pipeline goes through this module, so a service
restart mid-demo costs nothing but a re-run.
"""

from __future__ import annotations

import json
import subprocess

from openai import OpenAI

# The local service is unauthenticated, but the OpenAI client requires some
# key to be present. This value is never sent anywhere off-machine.
LOCAL_API_KEY = "not-needed-for-local"

# Model aliases this pipeline uses. Resolved to served IDs at runtime.
CHAT_ALIAS = "phi-4-mini"
CHAT_COMPARISON_ALIAS = "qwen3-4b"
EMBEDDING_ALIAS = "qwen3-embedding-0.6b"


class FoundryUnavailable(RuntimeError):
    """The local service could not be found, reached, or understood."""


def discover_service_url() -> str:
    """Return the base URL of the running Foundry Local service.

    Raises FoundryUnavailable with an actionable message rather than letting a
    connection error surface three layers deeper during a live demo.
    """
    try:
        result = subprocess.run(
            ["foundry", "status", "--output", "json"],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except FileNotFoundError as exc:
        raise FoundryUnavailable(
            "The `foundry` CLI is not on PATH. Install Foundry Local first."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise FoundryUnavailable("`foundry status` did not respond within 30s.") from exc

    if result.returncode != 0:
        raise FoundryUnavailable(
            f"`foundry status` failed (exit {result.returncode}): {result.stderr.strip()}"
        )

    try:
        status = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise FoundryUnavailable(
            "`foundry status --output json` did not return JSON. "
            "Check the CLI version — this project expects 0.10.x."
        ) from exc

    service = status.get("service", {})
    if not service.get("ready"):
        raise FoundryUnavailable(
            f"Foundry service is not ready (state: {service.get('state')!r}). "
            "Start it with: foundry server start"
        )

    urls = service.get("webUrls") or []
    if not urls:
        raise FoundryUnavailable("Foundry reports ready but published no service URL.")

    return urls[0].rstrip("/")


def make_client(base_url: str) -> OpenAI:
    """Build an OpenAI-compatible client pointed at the local service."""
    return OpenAI(base_url=f"{base_url}/v1", api_key=LOCAL_API_KEY)


def list_served_models(client: OpenAI) -> list[dict]:
    """Return the raw model entries the service is currently serving."""
    # The `parent` field carries the alias and is not part of the OpenAI schema,
    # so read the underlying JSON rather than the typed model object.
    response = client.models.list()
    return [entry.model_dump() for entry in response.data]


def resolve_model_id(client: OpenAI, alias: str) -> str:
    """Map a stable alias (`phi-4-mini`) to the served variant ID.

    Falls back to an exact ID match so a caller passing an already-resolved ID
    still works.
    """
    served = list_served_models(client)

    for entry in served:
        if entry.get("parent") == alias:
            return entry["id"]

    for entry in served:
        if entry.get("id") == alias:
            return entry["id"]

    available = ", ".join(sorted(f"{e.get('parent')} -> {e['id']}" for e in served))
    raise FoundryUnavailable(
        f"No served model matches alias {alias!r}. Available: {available or '(none)'}"
    )


def ensure_loaded(model_id: str) -> bool:
    """Load a model into the daemon if it is not already resident.

    Foundry Local 0.10.3 does not lazily load on first request — both
    /v1/chat/completions and /v1/embeddings return HTTP 400 for an unloaded
    model. Every stage calls this before its first request.

    Returns True if a load actually happened (i.e. the caller just paid the
    cold-start cost), so the console can explain the pause.
    """
    result = subprocess.run(
        ["foundry", "model", "load", model_id],
        capture_output=True,
        text=True,
        timeout=900,
    )
    if result.returncode != 0:
        raise FoundryUnavailable(
            f"Could not load model {model_id!r}: {result.stderr.strip() or result.stdout.strip()}"
        )
    return "success" in result.stdout.lower()


def unload(model_id: str) -> None:
    """Free a model from memory.

    Used by the eval harness between model runs — this machine cannot hold
    both chat models at once.
    """
    subprocess.run(
        ["foundry", "model", "unload", model_id],
        capture_output=True,
        text=True,
        timeout=300,
    )


def connect(alias: str, *, load: bool = False) -> tuple[OpenAI, str, str]:
    """Discover the service, build a client, and resolve one model alias.

    Returns (client, resolved_model_id, base_url) — the three things every
    entry point in this pipeline needs before it can do anything. Pass
    load=True to also guarantee the model is resident in memory.
    """
    base_url = discover_service_url()
    client = make_client(base_url)
    model_id = resolve_model_id(client, alias)
    if load:
        ensure_loaded(model_id)
    return client, model_id, base_url
