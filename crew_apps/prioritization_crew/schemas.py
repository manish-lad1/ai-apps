"""Pydantic models for every structured reply, and the JSON extraction in front of them.

No model in this app is ever asked to call a tool. Structured output is JSON
in the reply text, validated here. Validators that depend on the run (which
feature ids, which lenses are in play) read them from the validation context,
so `--without <lens>` and partial re-scores use the same models.

Pass a context like {"feature_ids": [...], "lens_ids": [...]} to `parse_reply`.
"""

from __future__ import annotations

import json
import re
from typing import Literal

from pydantic import BaseModel, Field, ValidationError, ValidationInfo, field_validator, model_validator

RATIONALE_WORDS = 25
NOTE_WORDS = 20


def _clip(text: str, words: int) -> str:
    """Trim to a word budget rather than fail the reply over length.

    A 27-word rationale is not worth a retry (and a second model call) in a
    live demo. Trimming is visible: the clipped text ends with an ellipsis.
    """
    parts = text.split()
    return text if len(parts) <= words else " ".join(parts[:words]) + "…"


def _ctx(info: ValidationInfo, key: str) -> list[str] | None:
    return (info.context or {}).get(key)


# --- Lens scores (pipeline fan-out) -------------------------------------------

class FeatureScore(BaseModel):
    feature_id: str
    score: int = Field(ge=1, le=10)
    rationale: str

    @field_validator("rationale")
    @classmethod
    def _short(cls, v: str) -> str:
        return _clip(v, RATIONALE_WORDS)


class LensScores(BaseModel):
    lens: str
    scores: list[FeatureScore]

    @field_validator("lens")
    @classmethod
    def _known_lens(cls, v: str, info: ValidationInfo) -> str:
        v = v.removeprefix("lens.")
        lens_ids = _ctx(info, "lens_ids")
        if lens_ids is not None and v not in lens_ids:
            raise ValueError(f"lens must be one of {lens_ids}, got {v!r}")
        return v

    @field_validator("scores")
    @classmethod
    def _every_feature_once(cls, v: list[FeatureScore], info: ValidationInfo) -> list[FeatureScore]:
        got = [s.feature_id for s in v]
        if len(got) != len(set(got)):
            raise ValueError(f"duplicate feature ids in scores: {got}")
        expected = _ctx(info, "feature_ids")
        if expected is not None and sorted(got) != sorted(expected):
            raise ValueError(f"scores must cover exactly {sorted(expected)}, got {sorted(got)}")
        return v

    def by_feature(self) -> dict[str, int]:
        return {s.feature_id: s.score for s in self.scores}


# --- Ranking (agent output, pipeline aggregate, crew synthesis) ----------------

class RankedFeature(BaseModel):
    feature_id: str
    rank: int = Field(ge=1)
    total: float
    note: str = ""

    @field_validator("note")
    @classmethod
    def _short(cls, v: str) -> str:
        return _clip(v, NOTE_WORDS)


class Ranking(BaseModel):
    ranked: list[RankedFeature]

    @field_validator("ranked")
    @classmethod
    def _complete(cls, v: list[RankedFeature], info: ValidationInfo) -> list[RankedFeature]:
        ids = [r.feature_id for r in v]
        if len(ids) != len(set(ids)):
            raise ValueError(f"duplicate feature ids in ranking: {ids}")
        expected = _ctx(info, "feature_ids")
        if expected is not None and sorted(ids) != sorted(expected):
            raise ValueError(f"ranking must cover exactly {sorted(expected)}, got {sorted(ids)}")
        if sorted(r.rank for r in v) != list(range(1, len(v) + 1)):
            raise ValueError(f"ranks must be 1..{len(v)} with no gaps or ties")
        return sorted(v, key=lambda r: r.rank)

    def order(self) -> list[str]:
        return [r.feature_id for r in self.ranked]

    def rank_of(self) -> dict[str, int]:
        return {r.feature_id: r.rank for r in self.ranked}


# --- Critic (pipeline) ---------------------------------------------------------

class Objection(BaseModel):
    lens: str
    feature_id: str
    reason: str

    @field_validator("lens")
    @classmethod
    def _known_lens(cls, v: str, info: ValidationInfo) -> str:
        v = v.removeprefix("lens.")
        lens_ids = _ctx(info, "lens_ids")
        if lens_ids is not None and v not in lens_ids:
            raise ValueError(f"objection lens must be one of {lens_ids}, got {v!r}")
        return v

    @field_validator("feature_id")
    @classmethod
    def _known_feature(cls, v: str, info: ValidationInfo) -> str:
        ids = _ctx(info, "feature_ids")
        if ids is not None and v not in ids:
            raise ValueError(f"objection feature_id must be one of {ids}, got {v!r}")
        return v


class CriticVerdict(BaseModel):
    approve: bool
    objections: list[Objection] = []

    @model_validator(mode="after")
    def _consistent(self) -> CriticVerdict:
        # An approval with objections, or a rejection with none, is ambiguous.
        # Treat it as invalid so it gets one retry instead of a silent guess.
        if self.approve and self.objections:
            raise ValueError("approve is true but objections were listed")
        if not self.approve and not self.objections:
            raise ValueError("approve is false but no objections were listed")
        return self


# --- Crew ------------------------------------------------------------------------

class CrewResponse(BaseModel):
    to_lens: str
    stance: Literal["concede", "rebut"]
    reason: str

    @field_validator("to_lens")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.removeprefix("lens.")


class CrewPosition(BaseModel):
    lens: str
    ranking: list[str]
    responses: list[CrewResponse] = Field(min_length=1)

    @field_validator("lens")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.removeprefix("lens.")

    @field_validator("ranking")
    @classmethod
    def _full_ranking(cls, v: list[str], info: ValidationInfo) -> list[str]:
        if len(v) != len(set(v)):
            raise ValueError(f"duplicate ids in ranking: {v}")
        expected = _ctx(info, "feature_ids")
        if expected is not None and sorted(v) != sorted(expected):
            raise ValueError(f"ranking must list exactly {sorted(expected)}, got {v}")
        return v

    @model_validator(mode="after")
    def _answers_a_peer(self, info: ValidationInfo) -> CrewPosition:
        lens_ids = _ctx(info, "lens_ids")
        for r in self.responses:
            if r.to_lens == self.lens:
                raise ValueError("a response must address another lens, not yourself")
            if lens_ids is not None and r.to_lens not in lens_ids:
                raise ValueError(f"to_lens must be one of {lens_ids}, got {r.to_lens!r}")
        return self


class Disagreement(BaseModel):
    feature_id: str
    positions: dict[str, int]  # lens id -> rank that lens gave


class CrewOutcome(BaseModel):
    ranking: Ranking
    agreements: list[str]
    disagreements: list[Disagreement]


# --- Extraction ------------------------------------------------------------------

_THINK_BLOCK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_STRAY_OPEN_THINK = re.compile(r"<think>.*", re.DOTALL | re.IGNORECASE)
_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


def strip_reasoning(text: str) -> str:
    """Remove <think> blocks, which Foundry does not strip from qwen3-family output."""
    text = _THINK_BLOCK.sub("", text or "")
    return _STRAY_OPEN_THINK.sub("", text).strip()


def extract_json(text: str) -> str:
    """Pull the first complete JSON object out of a model reply.

    Handles <think> blocks, markdown fences, leading prose, and trailing
    junk after the object (qwen3-14b often closes with one brace too many).
    """
    text = strip_reasoning(text)
    fenced = _FENCE.search(text)
    if fenced:
        text = fenced.group(1)
    start = text.find("{")
    if start == -1:
        return text.strip()
    try:
        obj, _ = json.JSONDecoder().raw_decode(text[start:])
        return json.dumps(obj)
    except json.JSONDecodeError:
        return text[start:].strip()


class ReplyError(ValueError):
    """A model reply that did not validate, with a short message fit to send back to the model."""


def parse_reply[M: BaseModel](model: type[M], text: str, context: dict | None = None) -> M:
    try:
        return model.model_validate_json(extract_json(text), context=context)
    except ValidationError as exc:
        problems = "; ".join(
            f"{'.'.join(str(p) for p in e['loc']) or 'reply'}: {e['msg']}" for e in exc.errors()[:4]
        )
        raise ReplyError(problems) from exc
