from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable

import anthropic
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)

CLAUDE_KEY = (
    os.environ.get("ANTHROPIC_API_KEY", "")
    or os.environ.get("CLAUDE_KEY", "")
    or os.environ.get("CLAUDE_API_KEY", "")
)

SYSTEM_PROMPT = """You are a transit route planning assistant for Toronto.

You help urban planners design new transit lines. When the user describes a route requirement,
respond conversationally and helpfully. If they ask you to generate a specific route, also output
a JSON block at the end of your message in this exact format:

```route
{
  "name": "Route Name",
  "type": "subway" | "streetcar" | "bus",
  "color": "#hexcolor",
  "stops": [
    { "name": "Stop Name", "coords": [-79.3832, 43.6532] }
  ]
}
```

Coordinates are [longitude, latitude] in WGS84. Only include the JSON block when generating
an actual route. Use realistic Toronto coordinates. Keep stop names concise.
"""


@dataclass
class ToolCallEvent:
    name: str
    input: dict
    call_id: str
    result: Any


_assistants: dict[str, str] = {}
_threads: dict[str, dict[str, Any]] = {}


def _require_key() -> None:
    if not CLAUDE_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY is required for the Python AI server")


async def create_assistant(name: str, system_prompt: str) -> str:
    _require_key()
    assistant_id = str(uuid.uuid4())
    _assistants[assistant_id] = system_prompt
    return assistant_id


async def create_thread(assistant_id: str) -> str:
    _require_key()
    thread_id = str(uuid.uuid4())
    _threads[thread_id] = {
        "assistant_id": assistant_id,
        "system_prompt": _assistants.get(assistant_id, ""),
        "messages": [],
    }
    return thread_id


async def stream_message(
    thread_id: str,
    content: str,
    model: str = "claude-haiku-4-5-20251001",
    max_tokens: int = 600,
) -> AsyncIterator[str]:
    _require_key()

    thread = _threads.setdefault(
        thread_id,
        {"assistant_id": None, "system_prompt": "", "messages": []},
    )
    next_messages = list(thread["messages"]) + [{"role": "user", "content": content}]
    client = anthropic.AsyncAnthropic(api_key=CLAUDE_KEY)

    full_response = ""
    async with client.messages.stream(
        model=model,
        max_tokens=max_tokens,
        system=thread["system_prompt"] or None,
        messages=next_messages,
    ) as stream:
        async for text in stream.text_stream:
            full_response += text
            yield text

    thread["messages"] = next_messages + [{"role": "assistant", "content": full_response}]


async def stream_message_with_tools(
    thread_id: str,
    content: str,
    tools: list[dict],
    tool_executor: Callable[[str, dict], Awaitable[Any]],
    model: str = "claude-sonnet-4-5-20251101",
    max_tokens: int = 2000,
    system_prompt: str = "",
) -> AsyncIterator[str | ToolCallEvent]:
    _require_key()

    thread = _threads.get(thread_id)
    if not thread:
        thread = {"system_prompt": system_prompt, "messages": []}
        _threads[thread_id] = thread
    elif system_prompt and not thread.get("system_prompt"):
        thread["system_prompt"] = system_prompt

    messages: list[dict] = list(thread["messages"]) + [{"role": "user", "content": content}]
    client = anthropic.AsyncAnthropic(api_key=CLAUDE_KEY)

    while True:
        resp = await client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=thread["system_prompt"] or None,
            messages=messages,
            tools=tools,  # type: ignore[arg-type]
        )

        text_parts: list[str] = []
        tool_use_blocks: list[Any] = []
        for block in resp.content:
            if block.type == "text":
                text_parts.append(block.text)
            elif block.type == "tool_use":
                tool_use_blocks.append(block)

        if resp.stop_reason == "tool_use":
            for text in text_parts:
                chunk_size = 30
                for i in range(0, len(text), chunk_size):
                    yield text[i : i + chunk_size]

            content_dicts: list[dict] = []
            for block in resp.content:
                if block.type == "text":
                    content_dicts.append({"type": "text", "text": block.text})
                elif block.type == "tool_use":
                    content_dicts.append({
                        "type": "tool_use",
                        "id": block.id,
                        "name": block.name,
                        "input": dict(block.input),
                    })

            tool_results: list[dict] = []
            for block in tool_use_blocks:
                yield ToolCallEvent(
                    name=block.name,
                    input=dict(block.input),
                    call_id=block.id,
                    result=None,
                )
                result = await tool_executor(block.name, dict(block.input))
                yield ToolCallEvent(
                    name=block.name,
                    input=dict(block.input),
                    call_id=block.id,
                    result=result,
                )
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": json.dumps(result, default=str),
                })

            messages.append({"role": "assistant", "content": content_dicts})
            messages.append({"role": "user", "content": tool_results})
        else:
            final_text = "".join(text_parts)
            chunk_size = 30
            for i in range(0, len(final_text), chunk_size):
                yield final_text[i : i + chunk_size]

            thread["messages"].append({"role": "user", "content": content})
            thread["messages"].append({"role": "assistant", "content": final_text})
            break
