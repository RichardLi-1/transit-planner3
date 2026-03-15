from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Awaitable

import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)

BASE_URL = "https://app.backboard.io/api"
BACKBOARD_KEY = os.environ.get("BACKBOARD_KEY", "")
CLAUDE_KEY = (
    os.environ.get("CLAUDE_KEY", "")
    or os.environ.get("ANTHROPIC_API_KEY", "")
    or os.environ.get("CLAUDE_API_KEY", "")
)

HEADERS = {"X-API-Key": BACKBOARD_KEY} if BACKBOARD_KEY else {}

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
    """Emitted by stream_message_with_tools for each tool invocation."""
    name: str
    input: dict
    call_id: str
    result: Any  # None = pending (about to execute), anything else = completed


# ── In-memory state for Claude fallback ────────────────────────────────────────
# Maps fake IDs to stored prompts/histories so council.py sees the same interface.

_fallback_assistants: dict[str, str] = {}          # assistant_id → system_prompt
_fallback_threads: dict[str, dict] = {}             # thread_id → {system_prompt, messages}


# ── Backboard helpers ──────────────────────────────────────────────────────────

async def create_assistant(name: str, system_prompt: str) -> str:
    if not BACKBOARD_KEY:
        return _fallback_create_assistant(system_prompt)
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{BASE_URL}/assistants",
                json={"name": name, "system_prompt": system_prompt},
                headers=HEADERS,
                timeout=30.0,
            )
            resp.raise_for_status()
            return resp.json()["assistant_id"]
    except Exception:
        return _fallback_create_assistant(system_prompt)


async def create_thread(assistant_id: str) -> str:
    if not BACKBOARD_KEY:
        return _fallback_create_thread(assistant_id)
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{BASE_URL}/assistants/{assistant_id}/threads",
                json={},
                headers=HEADERS,
                timeout=30.0,
            )
            resp.raise_for_status()
            return resp.json()["thread_id"]
    except Exception:
        return _fallback_create_thread(assistant_id)


async def stream_message(
    thread_id: str,
    content: str,
    model: str = "claude-haiku-4-5-20251001",
    max_tokens: int = 600,
) -> AsyncIterator[str]:
    """Yield raw text chunks. Tries Backboard, falls back to Anthropic SDK."""
    if not BACKBOARD_KEY or thread_id in _fallback_threads:
        async for chunk in _claude_stream(thread_id, content, model, max_tokens):
            yield chunk
        return

    try:
        async for chunk in _backboard_stream(thread_id, content, model, max_tokens):
            yield chunk
    except Exception:
        # Migrate thread to fallback state and retry via Claude
        if thread_id not in _fallback_threads:
            _fallback_threads[thread_id] = {"system_prompt": "", "messages": []}
        async for chunk in _claude_stream(thread_id, content, model, max_tokens):
            yield chunk


# ── Backboard streaming ────────────────────────────────────────────────────────

async def _backboard_stream(
    thread_id: str,
    content: str,
    model: str,
    max_tokens: int,
) -> AsyncIterator[str]:
    async with httpx.AsyncClient() as client:
        async with client.stream(
            "POST",
            f"{BASE_URL}/threads/{thread_id}/messages",
            headers=HEADERS,
            data={"content": content, "stream": "true", "model": model, "max_tokens": str(max_tokens)},
            timeout=httpx.Timeout(120.0, connect=10.0),
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line or not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    data = json.loads(payload)
                    text = (
                        data.get("content")
                        or (data.get("delta") or {}).get("content")
                        or ""
                    )
                    if text:
                        yield text
                except (json.JSONDecodeError, AttributeError):
                    if payload:
                        yield payload


# ── Claude fallback ────────────────────────────────────────────────────────────

def _fallback_create_assistant(system_prompt: str) -> str:
    aid = str(uuid.uuid4())
    _fallback_assistants[aid] = system_prompt
    return aid


def _fallback_create_thread(assistant_id: str) -> str:
    tid = str(uuid.uuid4())
    system_prompt = _fallback_assistants.get(assistant_id, "")
    _fallback_threads[tid] = {"system_prompt": system_prompt, "messages": []}
    return tid


async def _claude_stream(
    thread_id: str,
    content: str,
    model: str,
    max_tokens: int,
) -> AsyncIterator[str]:
    import anthropic  # lazy import — only needed if fallback is used

    thread = _fallback_threads.get(thread_id)
    if not thread:
        # Thread was created via Backboard but request failed mid-way
        thread = {"system_prompt": "", "messages": []}
        _fallback_threads[thread_id] = thread

    thread["messages"].append({"role": "user", "content": content})

    client = anthropic.AsyncAnthropic(api_key=CLAUDE_KEY)
    full_response = ""

    async with client.messages.stream(
        model=model,
        max_tokens=max_tokens,
        system=thread["system_prompt"] or None,
        messages=thread["messages"],
    ) as stream:
        async for text in stream.text_stream:
            full_response += text
            yield text

    # Append assistant reply to history so subsequent turns have context
    thread["messages"].append({"role": "assistant", "content": full_response})


# ── Tool-calling agent stream ───────────────────────────────────────────────────

async def stream_message_with_tools(
    thread_id: str,
    content: str,
    tools: list[dict],
    tool_executor: Callable[[str, dict], Awaitable[Any]],
    model: str = "claude-sonnet-4-5-20251101",
    max_tokens: int = 2000,
    system_prompt: str = "",
) -> AsyncIterator[str | ToolCallEvent]:
    """Agentic tool-use loop. Yields str text chunks and ToolCallEvent objects.

    Always uses the Anthropic SDK directly (bypasses Backboard) since Backboard
    does not natively handle multi-turn tool-use message structures.
    The system_prompt parameter is used when the thread_id was created by Backboard
    (not present in _fallback_threads), ensuring the agent's persona is preserved.
    """
    import anthropic

    thread = _fallback_threads.get(thread_id)
    if not thread:
        # Thread was created via Backboard — seed with the passed system_prompt
        thread = {"system_prompt": system_prompt, "messages": []}
        _fallback_threads[thread_id] = thread
    elif system_prompt and not thread.get("system_prompt"):
        # Backfill system_prompt if it was set empty on first creation
        thread["system_prompt"] = system_prompt

    # Build message list from thread history
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
            # Yield any reasoning text that arrived alongside the tool calls
            for text in text_parts:
                chunk_size = 30
                for i in range(0, len(text), chunk_size):
                    yield text[i:i + chunk_size]

            # Build assistant content block list for history
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
                # Emit pending event (animation starts immediately)
                yield ToolCallEvent(
                    name=block.name,
                    input=dict(block.input),
                    call_id=block.id,
                    result=None,
                )
                # Execute the tool
                result = await tool_executor(block.name, dict(block.input))
                # Emit completed event (animation updates with real data)
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

        else:  # end_turn — yield final text in chunks to simulate streaming
            final_text = "".join(text_parts)
            chunk_size = 30
            for i in range(0, len(final_text), chunk_size):
                yield final_text[i:i + chunk_size]

            # Save exchange to thread history (text only — tools are transient)
            thread["messages"].append({"role": "user", "content": content})
            thread["messages"].append({"role": "assistant", "content": final_text})
            break
