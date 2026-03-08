"""AI Transit Council — multi-agent, 6-round station-level debate.

Agents:
  Alex Chen       — Ridership & Equity Planner
  Jordan Park     — Infrastructure Cost Analyst
  Margaret T.     — NIMBY Neighbourhood Rep
  Devon Walsh     — PR Director
  Alex & Jordan   — Joint Rebuttal
  Commission      — Final Decision

Each planner turn emits a route_update so the map updates live.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import AsyncIterator

from .backboard import create_assistant, create_thread, stream_message
from .data_tools import build_data_brief

# ── Models ─────────────────────────────────────────────────────────────────────
# Use Haiku for critique-only agents; Sonnet for agents that generate coordinates

_HAIKU = "claude-haiku-4-5-20251001"
_SONNET = "claude-sonnet-4-5-20251101"

# ── Route JSON instruction (appended to planner prompts) ───────────────────────

_QUOTE_BLOCK = """
Also include a ```quote block with a single punchy sentence (max 15 words) summarising your stance — written in first person, as if speaking aloud:

```quote
Your punchy one-liner here.
```
""".strip()

_ROUTE_BLOCK = """
End your message with a ```route block:

```route
{
  "name": "Route Name",
  "type": "subway"|"streetcar"|"bus",
  "color": "#hexcolor",
  "stops": [{"name": "Intersection/Landmark", "coords": [-79.XXXX, 43.XXXX]}]
}
```

Toronto: lon −79.65 to −79.10, lat 43.55 to 43.85. Include 6–10 stops.
CRITICAL: stops must be listed in the order a vehicle travels — each stop must be geographically adjacent to the previous one. No zigzagging. The polyline formed by consecutive stop coordinates must be a smooth, continuous path with no gaps larger than ~800 m.
""".strip()

# ── System prompts (concise) ───────────────────────────────────────────────────

PLANNER_A_SYSTEM = f"""You are Alex Chen, Senior Transit Planner, Toronto. Advocate for ridership, equity, underserved areas.

For each proposed station give: nearest intersection, one-sentence justification (population/destination served).

{_QUOTE_BLOCK}

{_ROUTE_BLOCK}"""

PLANNER_B_SYSTEM = f"""You are Jordan Park, Infrastructure Cost Analyst, TTC. Think in dollars and timelines.

For each station in Alex's proposal, score:
- Cost Risk 1–10 (surface=1, subway=10)
- Ridership ROI 1–10

Challenge the 2 weakest stations. Propose alternatives with coordinates.

{_QUOTE_BLOCK}

{_ROUTE_BLOCK}"""

NIMBY_SYSTEM = f"""You are Margaret Thompson, Residents' Association chair. Passionate and protective of existing residents.

Identify the 2–3 most disruptive stations. For each:
- Exact street corner affected
- Who lives there / what's disrupted
- NIMBY Resistance Score 1–10
- One concrete mitigation

Your quote must be emotional and direct — something like "Don't you dare put a construction site outside my window!" or "This will destroy our neighbourhood!"

{_QUOTE_BLOCK}

Max 150 words. No route JSON."""

PR_SYSTEM = f"""You are Devon Walsh, TTC Communications Director. Protect the project from headlines.

For the top 3 stations rate (0–10 each):
- Displacement risk
- Construction noise (residential area?)
- Gentrification optics
- Environmental justice

Sum = Overall PR Nightmare Score /40. Flag >25 as political liability.
Recommend the single change with highest PR risk reduction. Max 150 words. No route JSON.

{_QUOTE_BLOCK}"""

REBUTTAL_SYSTEM = f"""You are Alex Chen and Jordan Park in joint rebuttal.

Defend strong stations with data. For the 1–2 most contested: concede or replace with alternatives.
State tradeoffs explicitly. Be decisive.

{_QUOTE_BLOCK}

{_ROUTE_BLOCK}"""

COMMISSION_SYSTEM = f"""You are the Toronto Transit Commission Planning Committee.

Rule on each contested station:
1. Confirmed / Modified (new coords) / Rejected
2. One-line mitigation commitment per NIMBY/PR concern raised
3. Revised PR Nightmare Score /40

Then output the binding final route.

{_QUOTE_BLOCK}

{_ROUTE_BLOCK}"""

# ── Agent registry ─────────────────────────────────────────────────────────────

AGENTS = [
    {"key": "planner_a",  "name": "Alex Chen",          "role": "Ridership Planner",      "color": "#2563eb", "system": PLANNER_A_SYSTEM,  "model": _SONNET, "max_tokens": 700},
    {"key": "planner_b",  "name": "Jordan Park",         "role": "Infrastructure Analyst", "color": "#16a34a", "system": PLANNER_B_SYSTEM,  "model": _SONNET, "max_tokens": 700},
    {"key": "nimby",      "name": "Margaret Thompson",   "role": "Neighbourhood Rep",      "color": "#dc2626", "system": NIMBY_SYSTEM,      "model": _HAIKU,  "max_tokens": 300},
    {"key": "pr",         "name": "Devon Walsh",         "role": "PR Director",            "color": "#d97706", "system": PR_SYSTEM,         "model": _HAIKU,  "max_tokens": 300},
    {"key": "rebuttal",   "name": "Alex & Jordan",       "role": "Joint Rebuttal",         "color": "#7c3aed", "system": REBUTTAL_SYSTEM,   "model": _SONNET, "max_tokens": 700},
    {"key": "commission", "name": "Planning Commission", "role": "Final Decision",         "color": "#0f172a", "system": COMMISSION_SYSTEM, "model": _SONNET, "max_tokens": 800},
]

# ── SSE helper ─────────────────────────────────────────────────────────────────

def _sse(payload: dict) -> str:
    return "data: " + json.dumps(payload) + "\n\n"


def _extract_route(text: str) -> dict | None:
    m = re.search(r"```route\s*(.*?)```", text, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(1).strip())
    except json.JSONDecodeError:
        return None


def _extract_quote(text: str) -> str | None:
    m = re.search(r"```quote\s*(.*?)```", text, re.DOTALL)
    return m.group(1).strip() if m else None


def _strip_blocks(text: str) -> str:
    """Remove route and quote code blocks from display text."""
    return re.sub(r"```(?:route|quote)\s*.*?```", "", text, flags=re.DOTALL).strip()


# ── Stream one agent turn — yields (sse_chunk, accumulated_text) in real time ──

async def _turn(agent: dict, thread_id: str, prompt: str):
    yield _sse({"type": "agent_start", "agent": agent["name"], "role": agent["role"], "color": agent["color"]}), ""
    full = ""
    async for chunk in stream_message(thread_id, prompt, model=agent["model"], max_tokens=agent["max_tokens"]):
        full += chunk
        yield _sse({"type": "agent_text", "agent": agent["name"], "text": chunk}), full
    quote = _extract_quote(full)
    if quote:
        yield _sse({"type": "agent_quote", "agent": agent["name"], "text": quote}), full
    yield _sse({"type": "agent_end", "agent": agent["name"]}), full


# ── Council orchestration ──────────────────────────────────────────────────────

async def run_council(
    neighbourhoods: list[str],
    stations: list[str],
    line_type: str | None,
    extra_context: str | None,
    existing_lines: list[dict] | None = None,
) -> AsyncIterator[str]:

    yield _sse({"type": "status", "text": "Fetching transit data…"})
    try:
        data_brief, stops = await build_data_brief(neighbourhoods, stations)
    except Exception as exc:
        yield _sse({"type": "status", "text": f"Data fetch failed: {exc}. Continuing without transit data."})
        data_brief, stops = "No transit data available.", []

    yield _sse({"type": "status", "text": f"{len(stops)} stops found. Assembling council…"})

    # Create sessions (in parallel for speed)
    try:
        async def _make_session(ag: dict) -> tuple[str, str]:
            aid = await create_assistant(ag["name"], ag["system"])
            tid = await create_thread(aid)
            return ag["key"], tid

        results = await asyncio.gather(*[_make_session(ag) for ag in AGENTS])
        sessions: dict[str, str] = dict(results)
    except Exception as exc:
        yield _sse({"type": "status", "text": f"Council setup failed: {exc}"})
        yield _sse({"type": "done"})
        return

    yield _sse({"type": "status", "text": "Council ready — deliberation begins."})

    # Shared brief (concise)
    type_str = f"Mode preference: {line_type}. " if line_type else ""
    brief = (
        f"# Planning Brief\n"
        f"Serve: {', '.join(neighbourhoods) or 'Toronto'}. "
        f"Connect: {', '.join(stations) or 'None specified'}. "
        f"{type_str}\n\n"
        f"## Stop demand data\n{data_brief}"
    )
    if existing_lines:
        by_route: dict[str, list[str]] = {}
        for s in existing_lines:
            by_route.setdefault(s["route"], []).append(
                f"{s['name']} ({s['coords'][0]:.4f}, {s['coords'][1]:.4f})"
            )
        lines_text = "\n".join(
            f"  {route}: {', '.join(stops)}" for route, stops in by_route.items()
        )
        brief += (
            f"\n\n## Existing TTC lines & stops\n{lines_text}\n"
            "TRANSFER RULE: wherever your proposed route crosses or comes within 150 m of an existing stop, "
            "place a stop at that exact location named '<ExistingStation> Transfer'."
        )
    if extra_context:
        brief += f"\n\nExtra context: {extra_context}"

    def ag(key: str) -> dict:
        return next(a for a in AGENTS if a["key"] == key)

    try:
        # ── R1: Planner A initial proposal ────────────────────────────────────
        full_a = ""
        async for sse_chunk, full_a in _turn(ag("planner_a"), sessions["planner_a"],
            brief + "\n\nPropose 6–10 stations. Name each by nearest intersection, one sentence justification each. Output route block."):
            yield sse_chunk
        route_a = _extract_route(full_a)
        if route_a: yield _sse({"type": "route_update", "route": route_a, "round": 1})

        # ── R2: Planner B cost review ──────────────────────────────────────────
        full_b = ""
        async for sse_chunk, full_b in _turn(ag("planner_b"), sessions["planner_b"],
            brief + f"\n\n## Alex's Proposal\n{full_a}\n\n"
            "Score each station for Cost Risk + Ridership ROI. Challenge the 2 weakest with alternatives. Output revised route block."):
            yield sse_chunk
        route_b = _extract_route(full_b)
        if route_b: yield _sse({"type": "route_update", "route": route_b, "round": 2})
        current = route_b or route_a

        # ── R3: NIMBY ─────────────────────────────────────────────────────────
        full_n = ""
        async for sse_chunk, full_n in _turn(ag("nimby"), sessions["nimby"],
            f"Proposed route:\n{json.dumps(current, indent=2) if current else '(none)'}\n\n"
            f"Affected areas: {', '.join(neighbourhoods) or 'Toronto'}.\n\n"
            "Identify 2–3 most disruptive stations. NIMBY scores + mitigations."):
            yield sse_chunk

        # ── R4: PR assessment ──────────────────────────────────────────────────
        full_pr = ""
        async for sse_chunk, full_pr in _turn(ag("pr"), sessions["pr"],
            f"Full debate:\n**Alex:** {full_a[:400]}…\n**Jordan:** {full_b[:400]}…\n**Margaret:** {full_n}\n\n"
            "Score top 3 stations on Displacement/Noise/Gentrification/EnvJustice. Overall PR score /40. "
            "One highest-impact recommendation."):
            yield sse_chunk

        # ── R5: Joint rebuttal ─────────────────────────────────────────────────
        full_reb = ""
        async for sse_chunk, full_reb in _turn(ag("rebuttal"), sessions["rebuttal"],
            brief + f"\n\n**Alex:** {full_a}\n**Jordan:** {full_b}\n**Margaret:** {full_n}\n**Devon:** {full_pr}\n\n"
            "Issue joint rebuttal. Defend or replace the 1–2 most contested stations. Output compromise route block."):
            yield sse_chunk
        route_reb = _extract_route(full_reb)
        if route_reb: yield _sse({"type": "route_update", "route": route_reb, "round": 5})

        # ── R6: Commission final ───────────────────────────────────────────────
        full_com = ""
        async for sse_chunk, full_com in _turn(ag("commission"), sessions["commission"],
            brief + f"\n\n**Alex:** {full_a}\n**Jordan:** {full_b}\n**Margaret:** {full_n}\n"
            f"**Devon:** {full_pr}\n**Rebuttal:** {full_reb}\n\n"
            "Rule on each contested station. Commit to mitigations. Revised PR score. Output final route block."):
            yield sse_chunk

        route_final = _extract_route(full_com) or route_reb or current
        if route_final:
            # Extract PR score /40 from PR agent or commission text
            pr_score: int | None = None
            for src in (full_com, full_pr):
                m = re.search(r"(?:PR Nightmare Score|score)[^\d]*(\d+)\s*/\s*40", src, re.IGNORECASE)
                if m:
                    pr_score = int(m.group(1))
                    break
            payload: dict = {"type": "route_final", "route": route_final}
            if pr_score is not None:
                payload["pr_score"] = pr_score
            yield _sse(payload)

    except Exception as exc:
        yield _sse({"type": "status", "text": f"Council error: {exc}"})

    yield _sse({"type": "done"})
