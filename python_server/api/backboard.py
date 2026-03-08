from __future__ import annotations

import json
import os
from pathlib import Path
from typing import AsyncIterator

import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)

BASE_URL = "https://app.backboard.io/api"
API_KEY = os.environ.get("BACKBOARD_KEY") or os.environ["BACKBOARD_API_KEY"]
HEADERS = {"X-API-Key": API_KEY}

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


async def create_assistant(name: str, system_prompt: str) -> str:
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE_URL}/assistants",
            json={"name": name, "system_prompt": system_prompt},
            headers=HEADERS,
            timeout=30.0,
        )
        resp.raise_for_status()
        return resp.json()["assistant_id"]


async def create_thread(assistant_id: str) -> str:
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE_URL}/assistants/{assistant_id}/threads",
            json={},
            headers=HEADERS,
            timeout=30.0,
        )
        resp.raise_for_status()
        return resp.json()["thread_id"]


async def stream_message(
    thread_id: str,
    content: str,
    model: str = "claude-haiku-4-5-20251001",
    max_tokens: int = 600,
) -> AsyncIterator[str]:
    """Yield raw text chunks from a streaming Backboard message response."""
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
                    # Handle both {content: ...} and {delta: {content: ...}} shapes
                    text = (
                        data.get("content")
                        or (data.get("delta") or {}).get("content")
                        or ""
                    )
                    if text:
                        yield text
                except (json.JSONDecodeError, AttributeError):
                    # Plain text chunk fallback
                    if payload:
                        yield payload
