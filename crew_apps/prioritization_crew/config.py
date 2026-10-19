"""Environment -> settings: a model per role, round caps, temperature, tracing.

Every value has a default, so the app runs with no .env at all. The model
defaults are the Phase 0 spike's recommendation (see SPIKE_REPORT.md).
A model is written `<provider>:<model id>`, provider = foundry | ollama.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

APP_DIR = Path(__file__).parent
PROVIDERS = ("foundry", "ollama")

DEFAULT_SMALL = "foundry:phi-4-mini"
DEFAULT_LARGE = "foundry:mistral-nemo-12b-instruct"


@dataclass(frozen=True)
class ModelSpec:
    provider: str
    model: str

    @classmethod
    def parse(cls, raw: str, *, role: str = "model") -> ModelSpec:
        provider, sep, model = raw.strip().partition(":")
        if not sep or not model:
            raise ValueError(f"{role}={raw!r}: expected '<provider>:<model id>', e.g. {DEFAULT_SMALL!r}")
        if provider not in PROVIDERS:
            raise ValueError(f"{role}={raw!r}: provider must be one of {PROVIDERS}")
        if model.startswith("<"):
            raise ValueError(f"{role}={raw!r} is still the .env.example placeholder; set a real model id")
        return cls(provider, model)

    def __str__(self) -> str:
        return f"{self.provider}:{self.model}"


@dataclass(frozen=True)
class Settings:
    scorer_model: ModelSpec
    agent_model: ModelSpec
    critic_model: ModelSpec
    crew_model: ModelSpec
    max_critic_rounds: int
    max_crew_rounds: int
    temperature: float
    foundry_max_concurrency: int
    enable_tracing: bool
    otlp_endpoint: str
    otlp_protocol: str

    def models(self) -> dict[str, ModelSpec]:
        return {"scorer": self.scorer_model, "agent": self.agent_model,
                "critic": self.critic_model, "crew": self.crew_model}


def _bool(raw: str) -> bool:
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _int(env: dict, key: str, default: int, minimum: int) -> int:
    value = int(env.get(key, default))
    if value < minimum:
        raise ValueError(f"{key} must be >= {minimum}, got {value}")
    return value


def load_settings(env: dict | None = None, *, dotenv: bool = True) -> Settings:
    """Read settings from `env` (default: os.environ after loading ./.env)."""
    if env is None:
        if dotenv:
            load_dotenv(APP_DIR / ".env", override=False)
        env = dict(os.environ)

    def model(key: str, default: str) -> ModelSpec:
        return ModelSpec.parse(env.get(key) or default, role=key)

    return Settings(
        scorer_model=model("SCORER_MODEL", DEFAULT_SMALL),
        agent_model=model("AGENT_MODEL", DEFAULT_SMALL),
        critic_model=model("CRITIC_MODEL", DEFAULT_LARGE),
        crew_model=model("CREW_MODEL", DEFAULT_LARGE),
        max_critic_rounds=_int(env, "MAX_CRITIC_ROUNDS", 2, minimum=0),
        max_crew_rounds=_int(env, "MAX_CREW_ROUNDS", 2, minimum=1),
        temperature=float(env.get("TEMPERATURE", 0)),
        # Foundry Local 0.10.3 segfaults in its WebGPU backend under concurrent
        # requests (2 of 5 runs in Phase 1), and serializes them anyway. Keep 1.
        foundry_max_concurrency=_int(env, "FOUNDRY_MAX_CONCURRENCY", 1, minimum=1),
        enable_tracing=_bool(env.get("ENABLE_TRACING", "true")),
        otlp_endpoint=env.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317"),
        otlp_protocol=env.get("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc"),
    )
