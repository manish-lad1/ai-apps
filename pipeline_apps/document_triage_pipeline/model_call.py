"""One place where every request to the local model is made.

Two hard-won details are encoded here and nowhere else:

  * Requests are never streamed. Foundry Local 0.10.3 parses the model's
    tool-call tokens into structured `tool_calls` on the non-streaming
    /v1/chat/completions path only. Streamed, the same request returns the
    raw `<tool_call>{...}</tool_call>` text as ordinary content.

  * `tool_choice` always names the function we want. Phi-4-mini never
    volunteers a call under "auto"; named, it is reliable.
"""

from __future__ import annotations

import re

from openai import OpenAI
from openai.types.chat import ChatCompletionMessageToolCall

# qwen3-4b is a reasoning model: it emits a <think> block before anything
# useful. 200 tokens was not enough to reach the tool call, so the budget is
# generous for every model rather than special-cased per model.
DEFAULT_MAX_TOKENS = 1024

_THINK_BLOCK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_STRAY_OPEN_THINK = re.compile(r"<think>.*", re.DOTALL | re.IGNORECASE)


def strip_reasoning(text: str) -> str:
    """Remove qwen3's <think> preamble, which the endpoint does not strip."""
    cleaned = _THINK_BLOCK.sub("", text or "")
    cleaned = _STRAY_OPEN_THINK.sub("", cleaned)
    return cleaned.strip()


def call_tool(
    client: OpenAI,
    model_id: str,
    messages: list[dict],
    tools: list[dict],
    tool_name: str,
    *,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> ChatCompletionMessageToolCall | None:
    """Ask the model for one specific tool call. Returns None if it refused."""
    response = client.chat.completions.create(
        model=model_id,
        messages=messages,
        tools=tools,
        tool_choice={"type": "function", "function": {"name": tool_name}},
        temperature=0.0,
        max_tokens=max_tokens,
    )
    calls = response.choices[0].message.tool_calls or []
    return calls[0] if calls else None


def ask_text(
    client: OpenAI,
    model_id: str,
    messages: list[dict],
    *,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> str:
    """Plain completion with reasoning tokens stripped."""
    response = client.chat.completions.create(
        model=model_id,
        messages=messages,
        temperature=0.0,
        max_tokens=max_tokens,
    )
    return strip_reasoning(response.choices[0].message.content or "")


def assistant_tool_call_message(call: ChatCompletionMessageToolCall) -> dict:
    """Rebuild the assistant turn so the tool result can be attached to it."""
    return {
        "role": "assistant",
        "tool_calls": [
            {
                "id": call.id,
                "type": "function",
                "function": {
                    "name": call.function.name,
                    "arguments": call.function.arguments,
                },
            }
        ],
    }


def tool_result_message(call: ChatCompletionMessageToolCall, content: str) -> dict:
    return {"role": "tool", "tool_call_id": call.id, "content": content}
