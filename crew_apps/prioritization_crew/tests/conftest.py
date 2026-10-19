"""Shared test fixtures: a fake chat client that returns canned replies.

The fake sits under a real Agent and the real ChatMiddlewareLayer, so the call
counter and the one-retry path are exercised exactly as they run against
Foundry Local, minus the model.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent_framework import BaseChatClient, ChatMiddlewareLayer, ChatResponse, Message  # noqa: E402

from config import load_settings  # noqa: E402
from lenses import LENS_IDS, feature_ids, load_backlog  # noqa: E402


class FakeChatClient(ChatMiddlewareLayer, BaseChatClient):
    """Replies with queued strings in order; records every request it receives."""

    def __init__(self, replies: list[str | dict], *, middleware=None, delay: float = 0.0) -> None:
        super().__init__(middleware=middleware)
        self.replies = [r if isinstance(r, str) else json.dumps(r) for r in replies]
        self.requests: list[list[Message]] = []
        self.options: list[dict] = []
        self.delay = delay
        self.in_flight = 0
        self.max_in_flight = 0

    async def _inner_get_response(self, *, messages, stream, options, **kwargs):
        if stream:
            raise NotImplementedError("FakeChatClient does not stream")
        self.requests.append(list(messages))
        self.options.append(dict(options))
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            await asyncio.sleep(self.delay)
        finally:
            self.in_flight -= 1
        if not self.replies:
            raise AssertionError("FakeChatClient ran out of canned replies")
        return ChatResponse(messages=[Message("assistant", [self.replies.pop(0)])])


@pytest.fixture
def backlog() -> dict:
    return load_backlog()


@pytest.fixture
def ids() -> list[str]:
    return feature_ids()


@pytest.fixture
def ctx(ids) -> dict:
    return {"feature_ids": ids, "lens_ids": list(LENS_IDS)}


@pytest.fixture
def settings():
    return load_settings({}, dotenv=False)


def lens_scores(lens: str, scores: dict[str, int]) -> dict:
    return {"lens": lens, "scores": [{"feature_id": f, "score": s, "rationale": "because"} for f, s in scores.items()]}
