from __future__ import annotations

import os
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".." / ".env", override=False)

BASE_URL = "https://app.backboard.io/api"
HEADERS = {"X-API-Key": os.environ["BACKBOARD_API_KEY"]}


def create_assistant(name: str, system_prompt: str) -> str:
    response = requests.post(
        f"{BASE_URL}/assistants",
        json={"name": name, "system_prompt": system_prompt},
        headers=HEADERS,
    )
    response.raise_for_status()
    return response.json()["assistant_id"]


def create_thread(assistant_id: str) -> str:
    response = requests.post(
        f"{BASE_URL}/assistants/{assistant_id}/threads",
        json={},
        headers=HEADERS,
    )
    response.raise_for_status()
    return response.json()["thread_id"]


def send_message(thread_id: str, content: str) -> str:
    response = requests.post(
        f"{BASE_URL}/threads/{thread_id}/messages",
        headers=HEADERS,
        data={"content": content, "stream": "false"},
    )
    response.raise_for_status()
    return response.json().get("content", "")


if __name__ == "__main__":
    assistant_id = create_assistant(
        name="Transit Assistant",
        system_prompt="You are a helpful assistant for a transit planning application.",
    )
    print(f"Created assistant: {assistant_id}")

    thread_id = create_thread(assistant_id)
    print(f"Created thread: {thread_id}")

    while True:
        user_input = input("\nYou: ").strip()
        if user_input.lower() in {"exit", "quit"}:
            break
        reply = send_message(thread_id, user_input)
        print(f"Agent: {reply}")
