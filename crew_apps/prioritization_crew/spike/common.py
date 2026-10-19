"""Shared helpers for the Phase 0 spike scripts.

Throwaway by design: the real versions of these live in the Phase 1 modules.
Discovery logic is adapted from pipeline_apps/document_triage_pipeline/foundry_endpoint.py.
"""

from __future__ import annotations

import json
import re
import subprocess
import time
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError, field_validator

SPIKE_DIR = Path(__file__).parent
RESULTS_DIR = SPIKE_DIR / "results"
RESULTS_DIR.mkdir(exist_ok=True)

LOCAL_API_KEY = "not-needed-for-local"


# --- Foundry Local discovery -------------------------------------------------

def foundry_status() -> dict:
    out = subprocess.run(["foundry", "status", "--output", "json"], capture_output=True, text=True, timeout=60)
    return json.loads(out.stdout)


def base_url() -> str:
    return foundry_status()["service"]["webUrls"][0].rstrip("/")


def resolve(alias: str) -> str:
    """Alias (phi-4-mini) -> served variant id. Uses /v1/models `parent`."""
    from openai import OpenAI

    client = OpenAI(base_url=f"{base_url()}/v1", api_key=LOCAL_API_KEY)
    served = [m.model_dump() for m in client.models.list().data]
    for m in served:
        if m.get("parent") == alias or m["id"] == alias:
            return m["id"]
    raise RuntimeError(f"{alias} not served; have {[m['id'] for m in served]}")


def load(model_id: str) -> float:
    t = time.perf_counter()
    r = subprocess.run(["foundry", "model", "load", model_id], capture_output=True, text=True, timeout=1200)
    if r.returncode != 0:
        raise RuntimeError(r.stderr or r.stdout)
    return time.perf_counter() - t


def unload(model_id: str) -> None:
    subprocess.run(["foundry", "model", "unload", model_id], capture_output=True, text=True, timeout=300)


def loaded_models() -> str:
    return subprocess.run(["foundry", "service", "ps"], capture_output=True, text=True).stdout


# --- Fictional fixture (spike-only; the real one is fixtures/backlog.json) ---

BACKLOG = [
    {"id": "F1", "name": "Smart templates", "description": "Pre-built note templates for standups and retros.",
     "reach": 9000, "impact": 1, "confidence": 90, "effort": 2, "strategic_theme": "mobile",
     "customer_quotes": ["Saves me five minutes every standup.", "Nice to have, not a must."]},
    {"id": "F2", "name": "SSO and audit log", "description": "SAML single sign-on plus an admin audit trail.",
     "reach": 1200, "impact": 3, "confidence": 70, "effort": 14, "strategic_theme": "enterprise readiness",
     "customer_quotes": ["Security won't approve Tandem without SSO.", "Audit log is a procurement blocker."]},
    {"id": "F3", "name": "Offline sync fix", "description": "Stop notes edited offline from overwriting each other.",
     "reach": 400, "impact": 3, "confidence": 95, "effort": 4, "strategic_theme": "mobile",
     "customer_quotes": ["I lost a whole meeting's notes. Twice.", "I no longer trust the app on flights."]},
    {"id": "F4", "name": "AI summary", "description": "One-click summary of a long note thread.",
     "reach": 5000, "impact": 2, "confidence": 50, "effort": 10, "strategic_theme": "AI-assisted writing",
     "customer_quotes": ["Would be cool.", "Only if it's accurate."]},
    {"id": "F5", "name": "Dark mode", "description": "A dark colour theme across web and mobile.",
     "reach": 6000, "impact": 0.5, "confidence": 100, "effort": 1, "strategic_theme": "mobile",
     "customer_quotes": ["Please, my eyes.", "Small thing, but I'd use it daily."]},
    {"id": "F6", "name": "Writing assistant", "description": "Inline rewrite suggestions while typing.",
     "reach": 3000, "impact": 2, "confidence": 60, "effort": 8, "strategic_theme": "AI-assisted writing",
     "customer_quotes": ["Feels like the future of the product.", "Not sure I'd pay more for it."]},
]
THEMES = ["enterprise readiness", "AI-assisted writing", "mobile"]

LENSES = {
    "rice": "Score by RICE = reach x impact x confidence / effort. Higher RICE, higher score.",
    "strategic_fit": f"Score by fit with company themes {THEMES}. Enterprise readiness is this year's top bet.",
    "effort_risk": "Score cheap, low-risk work high and expensive, uncertain work low.",
    "customer_pain": "Score by intensity of customer pain in the quotes, regardless of how many users.",
}


# --- Schema ------------------------------------------------------------------

class FeatureScore(BaseModel):
    feature_id: str
    score: int = Field(ge=1, le=10)
    rationale: str

    @field_validator("rationale")
    @classmethod
    def short(cls, v: str) -> str:
        if len(v.split()) > 25:
            raise ValueError("rationale over 25 words")
        return v


class LensScores(BaseModel):
    lens: str
    scores: list[FeatureScore]

    @field_validator("scores")
    @classmethod
    def all_six(cls, v: list[FeatureScore]) -> list[FeatureScore]:
        ids = sorted(s.feature_id for s in v)
        if ids != sorted(f["id"] for f in BACKLOG):
            raise ValueError(f"expected all six feature ids, got {ids}")
        return v


_THINK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


def extract_json(text: str) -> str:
    """Strip <think> blocks and markdown fences; return the outermost {...}."""
    text = _THINK.sub("", text or "")
    m = _FENCE.search(text)
    if m:
        text = m.group(1)
    start = text.find("{")
    if start == -1:
        return text
    try:
        # Decode the first complete object and ignore anything after it:
        # qwen3-14b often closes with one brace too many.
        obj, _ = json.JSONDecoder().raw_decode(text[start:])
        return json.dumps(obj)
    except json.JSONDecodeError:
        end = text.rfind("}")
        return text[start : end + 1] if end > start else text


def parse(model_cls: type[BaseModel], text: str):
    try:
        return model_cls.model_validate_json(extract_json(text)), None
    except ValidationError as exc:
        return None, str(exc).splitlines()[0:3]


def lens_prompt(lens: str) -> str:
    return (
        f"You are the {lens} lens on a product prioritization panel.\n"
        f"Mandate: {LENSES[lens]}\n\n"
        f"Backlog (JSON):\n{json.dumps(BACKLOG)}\n\n"
        "Score every one of the six features from 1 to 10 under your lens only. "
        "Reply with JSON only, no prose, in exactly this shape:\n"
        '{"lens": "' + lens + '", "scores": [{"feature_id": "F1", "score": 7, "rationale": "<= 25 words"}, ...]}'
    )


def save(name: str, data: dict) -> Path:
    p = RESULTS_DIR / f"{name}.json"
    p.write_text(json.dumps(data, indent=2, default=str))
    return p
