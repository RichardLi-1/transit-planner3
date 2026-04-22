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
import math
import re
from typing import Any, AsyncIterator

from .anthropic import create_assistant, create_thread, stream_message, stream_message_with_tools, ToolCallEvent
from .data_tools import build_data_brief, get_stops_near_point, snap_to_nearest_stop, check_transfer_at_location

# ── Models ─────────────────────────────────────────────────────────────────────
# Use Haiku for critique-only agents; Sonnet for agents that generate coordinates

_HAIKU = "claude-haiku-4-5-20251001"
_SONNET = "claude-sonnet-4-5-20251101"

# ── Spatial tools available to route-generating agents ────────────────────────

TRANSIT_TOOLS: list[dict] = [
    {
        "name": "search_stops_near_point",
        "description": (
            "Find real TTC stops near a lat/lon point. Returns up to 20 stops "
            "with ridership data. Use this before placing a station to discover "
            "existing stops and pick high-demand ones."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "lon": {"type": "number", "description": "Longitude, e.g. -79.3832"},
                "lat": {"type": "number", "description": "Latitude, e.g. 43.6532"},
                "radius_m": {"type": "number", "description": "Search radius in metres (default 500)"},
            },
            "required": ["lon", "lat"],
        },
    },
    {
        "name": "snap_to_nearest_stop",
        "description": (
            "Return the single nearest real TTC stop within 300 m of a coordinate. "
            "Use this to anchor each proposed stop to real infrastructure before "
            "adding it to the route block."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "lon": {"type": "number"},
                "lat": {"type": "number"},
            },
            "required": ["lon", "lat"],
        },
    },
    {
        "name": "check_transfer_at_location",
        "description": (
            "Return all existing TTC stops within 400 m of a coordinate. "
            "Use at transfer points to find the exact existing stop name and "
            "coordinates for a Transfer stop."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "lon": {"type": "number"},
                "lat": {"type": "number"},
            },
            "required": ["lon", "lat"],
        },
    },
]

_TOOL_INSTRUCTION = """
SPATIAL TOOLS — you have three tools to ground stops in real infrastructure:
- search_stops_near_point(lon, lat, radius_m): Discover real TTC stops near any point. Call this for each key intersection before deciding stops.
- snap_to_nearest_stop(lon, lat): Get the closest real stop to your proposed coordinate. Use its returned coords and name in the route block.
- check_transfer_at_location(lon, lat): Find existing stops within 400 m to name your transfer stops correctly.

WORKFLOW:
1. For EACH mandatory geographic target: call search_stops_near_point with radius_m=600 to discover real stops.
2. For EACH stop in your route: call snap_to_nearest_stop to anchor it to real infrastructure.
3. For EVERY existing TTC stop in the brief (scan them ALL): call check_transfer_at_location at that stop's listed coordinates. If any real stop is returned within 400 m of your route corridor, add a Transfer stop there.
Use ONLY the coordinates returned by tool calls — never invent coordinates.""".strip()


async def _execute_tool(name: str, input_dict: dict) -> Any:
    """Dispatch a tool call to the appropriate data_tools function."""
    lon = float(input_dict.get("lon", 0))
    lat = float(input_dict.get("lat", 0))
    radius_m = float(input_dict.get("radius_m", 500))
    if name == "snap_to_nearest_stop":
        return await snap_to_nearest_stop(lon, lat)
    if name == "check_transfer_at_location":
        return await check_transfer_at_location(lon, lat)
    return await get_stops_near_point(lon, lat, radius_m)  # search_stops_near_point


# ── Route JSON instruction (appended to planner prompts) ───────────────────────

# Per-agent quote instructions with distinct voices
_QUOTE_ALEX = 'End with a ```quote block — one punchy sentence (max 12 words) from Alex\'s equity/ridership POV:\n```quote\n...\n```'
_QUOTE_JORDAN = 'End with a ```quote block — one blunt sentence (max 12 words) from Jordan\'s cost/ROI POV:\n```quote\n...\n```'
_QUOTE_MARGARET = 'End with a ```quote block — one EMOTIONAL fearful sentence (max 12 words) from a worried resident\'s POV:\n```quote\n...\n```'
_QUOTE_DEVON = 'End with a ```quote block — one dry PR-speak sentence (max 12 words) about optics/headlines:\n```quote\n...\n```'
_QUOTE_REBUTTAL = 'End with a ```quote block — one decisive joint-position sentence (max 12 words):\n```quote\n...\n```'
_QUOTE_COMMISSION = 'End with a ```quote block — one authoritative ruling sentence (max 12 words):\n```quote\n...\n```'

_ROUTE_BLOCK = """
End your message with a ```route block containing valid JSON:

```route
{
  "name": "Route Name",
  "type": "subway"|"streetcar"|"bus",
  "color": "#hexcolor",
  "stops": [{"name": "Intersection or Landmark", "coords": [-79.XXXX, 43.XXXX]}]
}
```

MANDATORY GEOMETRY RULES — violating any rule makes the route invalid:

1. MODE: This is a subway-only planning exercise. All routes MUST use type "subway". No streetcar, no bus.

2. ONE DIRECTION ONLY: Pick start and end termini on opposite ends of the city. Travel in a single corridor. NO loops, NO U-turns, NO doubling back.

3. GENERAL DIRECTION: The route should travel from one end of the city to the other without doubling back. Stops must generally progress toward the destination — do not backtrack more than one stop in a row. Gentle curves to reach mandatory targets are allowed and expected.

4. NO SHARP TURNS: Avoid jarring direction reversals. Turns greater than 90° between consecutive segments are forbidden. Smooth curves and gradual direction changes (e.g. curving northwest then north) are fine and often necessary to serve the required neighbourhoods.

5. SPACING: Consecutive stops must be 350–650 m apart. Never cluster stops within 300 m. Never leave a gap over 700 m.

6. TRANSFERS — MANDATORY SCAN: Go through EVERY existing stop listed in the brief ONE BY ONE. For each: compute whether your route corridor passes within 400 m. If yes, call check_transfer_at_location at that stop's coordinates, then include a stop named "<ExistingStation> Transfer" using the EXACT coordinates returned. Missing any transfer point is a disqualifying error. Scan ALL stops, not just the ones near your termini.

7. BOUNDS: lon −79.65 to −79.10, lat 43.638 to 43.85. Minimum 7 stops, maximum 12 stops.

8. WATER BOUNDARY: lat < 43.638 is Lake Ontario. Any stop below 43.638 is invalid — absolute rule.

9. REAL INFRASTRUCTURE: Subways follow Yonge, Bloor, Eglinton, Sheppard, Finch, or equivalent arterials. Streetcars follow King, Queen, Dundas, College, Spadina. Buses follow any arterial. Never cut diagonally through blocks or parks.

10. DENSITY FIRST: Use boardings data. Prioritize high-demand intersections and underserved dense neighbourhoods. Avoid low-density stops.

11. PROSE ONLY: Do NOT write raw coordinates anywhere in analysis text. Use intersection names only. Coordinates go in the route block only.
""".strip()

# ── System prompts ─────────────────────────────────────────────────────────────

PLANNER_A_SYSTEM = f"""You are Alex Chen, Senior Transit Planner at the City of Toronto. You champion ridership, equity, and underserved communities. You believe transit should reach people who need it most — low-income riders, seniors, areas without good service. You are optimistic and people-focused.

Use the boardings data in the brief to identify the busiest stops and most underserved corridors. Gravitate toward population-dense areas and intersections with high demand. Follow major roads or rail corridors. Gentle curves to reach mandatory geographic targets are expected — the route does not need to be a perfectly straight line.

{_TOOL_INSTRUCTION}

For each proposed station: nearest intersection name + one sentence on who benefits (density, destinations, equity). Do NOT include coordinates in your prose.

{_QUOTE_ALEX}

{_ROUTE_BLOCK}"""

PLANNER_B_SYSTEM = f"""You are Jordan Park, Infrastructure Cost Analyst at the TTC. Skeptical, numbers-driven, allergic to cost overruns. You think Alex is a dreamer who ignores budget reality.

CRITICAL CONSTRAINT — your route MUST be on a PERPENDICULAR AXIS to Alex's:
- If Alex's route trends East–West (longitude changes more than latitude): YOUR route MUST trend North–South.
- If Alex's route trends North–South (latitude changes more than longitude): YOUR route MUST trend East–West.
- Your termini must be in DIFFERENT parts of the city than Alex's termini.
- Do NOT reuse any of Alex's station names or coordinates.

Justify every station with cost-per-rider math. Dismiss any stop that doesn't pencil out.

{_TOOL_INSTRUCTION}

After your proposal, give Alex's route a Cost Risk score (1–10) and ROI score (1–10) with one-sentence justification each. Use intersection names only in prose — no coordinates.

{_QUOTE_JORDAN}

{_ROUTE_BLOCK}"""

NIMBY_SYSTEM = f"""You are Margaret Thompson, chair of the local Residents' Association. Fiercely protective, emotional, but not stupid.

YOU MUST USE THIS EXACT FORMAT — no intro, no paragraphs, no deviation:

**[Street] & [Street]**: [who is hurt and how, ≤12 words]. Resistance: X/10. Fix: [specific ask, ≤8 words].
**[Street] & [Street]**: [who is hurt and how, ≤12 words]. Resistance: X/10. Fix: [specific ask, ≤8 words].
**[Street] & [Street]**: [who is hurt and how, ≤12 words]. Resistance: X/10. Fix: [specific ask, ≤8 words].

{_QUOTE_MARGARET}

Exactly 3 entries. No prose before or after. No route JSON."""

PR_SYSTEM = f"""You are Devon Walsh, TTC Director of Communications. Calculating, cynical, allergic to bad headlines.

YOU MUST USE THIS EXACT FORMAT — no prose paragraphs, no deviation:

| Station | Displacement | Noise | Gentrif. | Env.J. | Total |
|---------|-------------|-------|----------|--------|-------|
| [name]  | X           | X     | X        | X      | XX    |
| [name]  | X           | X     | X        | X      | XX    |
| [name]  | X           | X     | X        | X      | XX    |

PR Score: XX/40. Liability: [YES/NO].
Fix: [single station swap in ≤12 words].

{_QUOTE_DEVON}

No route JSON."""

REBUTTAL_SYSTEM = f"""You are Alex Chen and Jordan Park issuing a joint rebuttal. You disagree on many things, but you've found a genuine compromise. Alex conceded on one expensive station; Jordan conceded on one equity-critical stop. The result is a route you can both defend.

Defend strong stations with data. For contested stations: explicitly state concede-or-hold and why. State the tradeoffs directly.

{_TOOL_INSTRUCTION}

{_QUOTE_REBUTTAL}

{_ROUTE_BLOCK}"""

COMMISSION_SYSTEM = f"""You are the Toronto Transit Commission Planning Committee.

Rule on each contested station (Confirmed / Modified / Rejected), state one mitigation per concern, give revised PR Score /40.

Then output the binding final route. The final route must be geometrically correct: linear path, no loops, stops 350–650 m apart, transfer stops where the route crosses existing lines. The route must follow real Toronto road or rail corridors and not place any stop in Lake Ontario (lat < 43.638 is forbidden). Prioritize high-ridership corridors supported by the demand data.

{_QUOTE_COMMISSION}

{_ROUTE_BLOCK}"""

# ── Agent registry ─────────────────────────────────────────────────────────────

AGENTS = [
    {"key": "planner_a",  "name": "Alex Chen",          "role": "Ridership Planner",      "color": "#2563eb", "system": PLANNER_A_SYSTEM,  "model": _SONNET, "max_tokens": 2000, "use_tools": True},
    {"key": "planner_b",  "name": "Jordan Park",         "role": "Infrastructure Analyst", "color": "#16a34a", "system": PLANNER_B_SYSTEM,  "model": _SONNET, "max_tokens": 2000, "use_tools": True},
    {"key": "nimby",      "name": "Margaret Thompson",   "role": "Neighbourhood Rep",      "color": "#dc2626", "system": NIMBY_SYSTEM,      "model": _HAIKU,  "max_tokens": 160,  "use_tools": False},
    {"key": "pr",         "name": "Devon Walsh",         "role": "PR Director",            "color": "#d97706", "system": PR_SYSTEM,         "model": _HAIKU,  "max_tokens": 250,  "use_tools": False},
    {"key": "rebuttal",   "name": "Alex & Jordan",       "role": "Joint Rebuttal",         "color": "#7c3aed", "system": REBUTTAL_SYSTEM,   "model": _SONNET, "max_tokens": 2000, "use_tools": True},
    {"key": "commission", "name": "Planning Commission", "role": "Final Decision",         "color": "#0f172a", "system": COMMISSION_SYSTEM, "model": _SONNET, "max_tokens": 1500, "use_tools": False},
]

# ── SSE helper ─────────────────────────────────────────────────────────────────

def _sse(payload: dict) -> str:
    return "data: " + json.dumps(payload) + "\n\n"


def _bearing(a: list[float], b: list[float]) -> float:
    """Compass bearing in degrees (0–360) from point a to point b."""
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    dlon = lon2 - lon1
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def _turn_angle(a: list[float], b: list[float], c: list[float]) -> float:
    """Angle of the turn at point b, between segment a→b and b→c (0–180°)."""
    b1 = _bearing(a, b)
    b2 = _bearing(b, c)
    diff = abs(b2 - b1) % 360
    return diff if diff <= 180 else 360 - diff


def _dist_sq(a: list[float], b: list[float]) -> float:
    """Squared Euclidean distance (degrees²) — for comparisons only."""
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2


def _haversine_m(a: list[float], b: list[float]) -> float:
    """Great-circle distance in metres between two [lon, lat] points."""
    R = 6_371_000
    lat1, lat2 = math.radians(a[1]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = math.radians(b[0] - a[0])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def _sort_stops_along_axis(stops: list[dict]) -> list[dict]:
    """Reorder stops by projection onto the axis of maximum spread.

    Fixes the case where the LLM outputs stops in arbitrary order, causing
    the rendered line to zigzag back and forth.
    """
    if len(stops) <= 2:
        return stops

    # Find the most distant pair to define the principal axis
    max_d = 0.0
    p0, p1 = stops[0]["coords"], stops[-1]["coords"]
    for i in range(len(stops)):
        for j in range(i + 1, len(stops)):
            d = _dist_sq(stops[i]["coords"], stops[j]["coords"])
            if d > max_d:
                max_d = d
                p0 = stops[i]["coords"]
                p1 = stops[j]["coords"]

    dx = p1[0] - p0[0]
    dy = p1[1] - p0[1]
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return stops

    def proj(c: list[float]) -> float:
        return ((c[0] - p0[0]) * dx + (c[1] - p0[1]) * dy) / length_sq

    return sorted(stops, key=lambda s: proj(s["coords"]))


def _fix_route_geometry(route: dict) -> dict:
    """Fix route geometry:
    1. Sort stops along the principal axis (fixes arbitrary LLM ordering)
    2. Remove stops that cause turns > 75° (zig-zag elimination)
    3. Remove duplicate stops closer than 200 m
    Terminal stops are never removed in step 2.
    """
    stops = list(route.get("stops", []))
    if len(stops) < 2:
        return route

    # Step 1: sort along principal axis to fix arbitrary ordering
    stops = _sort_stops_along_axis(stops)

    # Step 2: remove stops causing turns > 75°
    if len(stops) >= 3:
        changed = True
        while changed:
            changed = False
            i = 1
            while i < len(stops) - 1:
                angle = _turn_angle(
                    stops[i - 1]["coords"],
                    stops[i]["coords"],
                    stops[i + 1]["coords"],
                )
                if angle > 75:
                    stops.pop(i)
                    changed = True
                else:
                    i += 1

    # Step 3: remove duplicates closer than 200 m
    if stops:
        deduped = [stops[0]]
        for s in stops[1:]:
            if _haversine_m(deduped[-1]["coords"], s["coords"]) > 200:
                deduped.append(s)
        stops = deduped

    return {**route, "stops": stops}


async def _densify_route(route: dict, min_gap_m: float = 600.0, max_stops: int = 18) -> dict:
    """Fill gaps > min_gap_m metres by querying for real TTC stops near midpoints.

    Runs up to 4 passes until no gap exceeds min_gap_m or max_stops is reached.
    Stops are sorted along the axis after each pass to maintain linear order.
    """
    from .data_tools import get_stops_near_point

    stops = list(route.get("stops", []))

    for _pass in range(4):
        if len(stops) >= max_stops:
            break
        new_stops = [stops[0]]
        inserted = False
        for i in range(1, len(stops)):
            prev = new_stops[-1]
            curr = stops[i]
            gap_m = _haversine_m(prev["coords"], curr["coords"])
            if gap_m > min_gap_m and len(new_stops) < max_stops:
                mid_lon = (prev["coords"][0] + curr["coords"][0]) / 2
                mid_lat = (prev["coords"][1] + curr["coords"][1]) / 2
                try:
                    nearby = await get_stops_near_point(mid_lon, mid_lat, 400)
                except Exception:
                    nearby = []
                if nearby:
                    existing_names = {s["name"] for s in stops}
                    candidates = [s for s in nearby if s["name"] not in existing_names]
                    if candidates:
                        best = candidates[0]  # highest ridership first
                        new_stops.append({"name": best["name"], "coords": best["coords"]})
                        inserted = True
            new_stops.append(curr)
        stops = new_stops
        if not inserted:
            break

    # Re-sort after insertions to maintain linear order
    stops = _sort_stops_along_axis(stops)
    return {**route, "stops": stops}


def _extract_route(text: str) -> dict | None:
    m = re.search(r"```route\s*(.*?)```", text, re.DOTALL)
    if not m:
        return None
    try:
        route = json.loads(m.group(1).strip())
        return _fix_route_geometry(route)
    except json.JSONDecodeError:
        return None


def _extract_quote(text: str) -> str | None:
    m = re.search(r"```quote\s*(.*?)```", text, re.DOTALL)
    if not m:
        return None
    raw = m.group(1).strip()
    # Truncate to first sentence — quotes must be one punchy line
    for punct in ("!", ".", "?"):
        idx = raw.find(punct)
        if 0 < idx < len(raw) - 1:
            raw = raw[: idx + 1]
            break
    return raw.strip()


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


async def _turn_with_tools(agent: dict, thread_id: str, prompt: str):
    """Like _turn but uses tool-calling; falls back to plain stream on any error."""
    yield _sse({"type": "agent_start", "agent": agent["name"], "role": agent["role"], "color": agent["color"]}), ""
    full = ""
    tool_failed = False

    try:
        async for item in stream_message_with_tools(
            thread_id,
            prompt,
            tools=TRANSIT_TOOLS,
            tool_executor=_execute_tool,
            model=agent["model"],
            max_tokens=agent["max_tokens"],
            system_prompt=agent["system"],  # preserve the agent persona for the Anthropic thread
        ):
            if isinstance(item, ToolCallEvent):
                yield _sse({
                    "type": "tool_call",
                    "tool": item.name,
                    "agent": agent["name"],
                    "call_id": item.call_id,
                    "input": item.input,
                    "result": item.result,
                }), full
            else:
                full += item
                yield _sse({"type": "agent_text", "agent": agent["name"], "text": item}), full
    except Exception:
        tool_failed = True

    if tool_failed or not full.strip():
        # Fall back to regular (non-tool) stream
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
        data_brief, stops, neighbourhood_centroids = await build_data_brief(neighbourhoods, stations)
    except Exception as exc:
        yield _sse({"type": "status", "text": f"Data fetch failed: {exc}. Continuing without transit data."})
        data_brief, stops, neighbourhood_centroids = "No transit data available.", [], {}

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
    type_str = f"REQUIRED MODE: {line_type}. " if line_type else "REQUIRED MODE: subway. All routes must use type \"subway\". "

    # Build hard geographic targets: neighbourhood centroids give agents precise coordinates
    if neighbourhood_centroids:
        geo_lines = "\n".join(
            f"  - {name}: lon {lon:.4f}, lat {lat:.4f}"
            for name, (lon, lat) in neighbourhood_centroids.items()
        )
        geo_constraint = (
            f"\n\n## MANDATORY GEOGRAPHIC TARGETS\n"
            f"The route MUST pass through or directly serve each of these locations. "
            f"Place at least one stop within 500 m of each centroid coordinate:\n"
            f"{geo_lines}"
        )
    else:
        geo_constraint = ""

    brief = (
        f"# Planning Brief\n"
        f"Serve: {', '.join(neighbourhoods) or 'Toronto'}. "
        f"Connect: {', '.join(stations) or 'None specified'}. "
        f"{type_str}"
        f"{geo_constraint}\n\n"
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
            f"\n\n## Existing TTC lines & stops (coords shown for transfer detection)\n{lines_text}\n"
            "\nMANDATORY TRANSFER RULE: Go through EVERY existing stop listed above one by one. "
            "If any existing stop's coordinates place it within ~400 m of your route corridor, "
            "you MUST include a stop named '<ExistingStation> Transfer' at that exact location. "
            "400 m ≈ 0.004 degrees of latitude or longitude. "
            "Missing an obvious transfer is a critical planning error."
        )
    if extra_context:
        brief += f"\n\nExtra context: {extra_context}"

    def ag(key: str) -> dict:
        return next(a for a in AGENTS if a["key"] == key)

    try:
        # ── R1: Planner A initial proposal ────────────────────────────────────
        full_a = ""
        async for sse_chunk, full_a in _turn_with_tools(ag("planner_a"), sessions["planner_a"],
            brief + "\n\nPropose 6–20 stations. Use your spatial tools to find real stops near the MANDATORY GEOGRAPHIC TARGETS. "
            "Call search_stops_near_point around each target centroid, then snap_to_nearest_stop for each final stop. "
            "Name each station by nearest intersection, one sentence justification each. Output route block with real coordinates from tool results."):
            yield sse_chunk
        route_a = _extract_route(full_a)
        if route_a: yield _sse({"type": "route_update", "route": route_a, "round": 1})

        # ── R2: Planner B — independent alternative route ─────────────────────
        # Determine Alex's axis so Jordan can be forced perpendicular
        alex_prose = _strip_blocks(full_a)
        if route_a and len(route_a.get("stops", [])) >= 2:
            a_stops = route_a["stops"]
            lon_span = abs(a_stops[-1]["coords"][0] - a_stops[0]["coords"][0])
            lat_span = abs(a_stops[-1]["coords"][1] - a_stops[0]["coords"][1])
            if lon_span > lat_span:
                alex_axis = "East–West"
                jordan_axis = "North–South (your route must run roughly perpendicular, changing latitude far more than longitude)"
            else:
                alex_axis = "North–South"
                jordan_axis = "East–West (your route must run roughly perpendicular, changing longitude far more than latitude)"
        else:
            alex_axis = "unknown"
            jordan_axis = "the opposite axis — choose the direction Alex did NOT take"

        full_b = ""
        async for sse_chunk, full_b in _turn_with_tools(ag("planner_b"), sessions["planner_b"],
            brief + f"\n\n## Alex's Analysis (prose only — do NOT copy Alex's stops or corridors)\n{alex_prose}\n\n"
            f"Alex's route runs {alex_axis}. YOUR route MUST run {jordan_axis}. "
            "Pick termini that Alex did NOT use — opposite ends of the city on your axis. "
            "Use your spatial tools to discover real stops along your chosen corridor. "
            "Do not reuse any of Alex's station names or coordinates. "
            "Output YOUR route block with real coordinates from tool results."):
            yield sse_chunk
        route_b = _extract_route(full_b)
        if route_b: yield _sse({"type": "route_update", "route": route_b, "round": 2})
        current = route_b or route_a

        # ── R3 + R4 in parallel ────────────────────────────────────────────────
        full_n = ""
        full_pr = ""
        para_queue: asyncio.Queue[str | None] = asyncio.Queue()

        async def _run_nimby() -> None:
            nonlocal full_n
            alex_stops = [s["name"] for s in (route_a or {}).get("stops", [])]
            jordan_stops = [s["name"] for s in (route_b or {}).get("stops", [])]
            async for sse_chunk, full_n in _turn(
                ag("nimby"), sessions["nimby"],
                f"Two competing subway proposals are on the table:\n"
                f"**Alex's route** ({alex_axis} corridor): {', '.join(alex_stops) or '(none)'}\n"
                f"**Jordan's route** ({jordan_axis.split('(')[0].strip()} corridor): {', '.join(jordan_stops) or '(none)'}\n"
                f"Affected neighbourhoods: {', '.join(neighbourhoods) or 'Toronto'}.\n\n"
                "Use your format exactly. Pick 3 disruptive stations (one from each proposal, one shared if possible). "
                "One bullet per station. End with your quote block."
            ):
                await para_queue.put(sse_chunk)
            await para_queue.put(None)

        async def _run_pr() -> None:
            nonlocal full_pr
            alex_summary = _strip_blocks(full_a)[:500]
            jordan_summary = _strip_blocks(full_b)[:500]
            async for sse_chunk, full_pr in _turn(
                ag("pr"), sessions["pr"],
                f"Two proposals:\n"
                f"**Alex ({alex_axis}):** {alex_summary}…\n\n"
                f"**Jordan ({jordan_axis.split('(')[0].strip()}):** {jordan_summary}…\n\n"
                "Score 3 SPECIFIC stations from DIFFERENT proposals (not all from the same route) on Displacement/Noise/Gentrification/EnvJustice. "
                "Give each proposal its own PR assessment. Overall PR score /40. Highest-impact swap recommendation."
            ):
                await para_queue.put(sse_chunk)
            await para_queue.put(None)

        tasks = [asyncio.create_task(_run_nimby()), asyncio.create_task(_run_pr())]
        pending = 2
        while pending > 0:
            item = await para_queue.get()
            if item is None:
                pending -= 1
            else:
                yield item
        await asyncio.gather(*tasks)

        # ── R5: Joint rebuttal ─────────────────────────────────────────────────
        full_reb = ""
        async for sse_chunk, full_reb in _turn_with_tools(ag("rebuttal"), sessions["rebuttal"],
            brief + f"\n\n**Alex:** {full_a}\n**Jordan:** {full_b}\n**Margaret:** {full_n}\n**Devon:** {full_pr}\n\n"
            "Issue joint rebuttal. Defend or replace the 1–2 most contested stations. "
            "Use spatial tools to verify any replacement stop coordinates. "
            "The final route MUST still pass through the MANDATORY GEOGRAPHIC TARGETS in the brief. Output compromise route block with real coordinates."):
            yield sse_chunk
        route_reb = _extract_route(full_reb)
        if route_reb: yield _sse({"type": "route_update", "route": route_reb, "round": 5})

        # ── R6: Commission final ───────────────────────────────────────────────
        full_com = ""
        async for sse_chunk, full_com in _turn(ag("commission"), sessions["commission"],
            brief + f"\n\n**Alex:** {full_a}\n**Jordan:** {full_b}\n**Margaret:** {full_n}\n"
            f"**Devon:** {full_pr}\n**Rebuttal:** {full_reb}\n\n"
            "Rule on each contested station. Commit to mitigations. Revised PR score. "
            "The final route MUST pass through the MANDATORY GEOGRAPHIC TARGETS in the brief. Output final route block."):
            yield sse_chunk

        route_final = _extract_route(full_com) or route_reb or current
        if route_final:
            # Densify: fill gaps > 600 m with real TTC stops
            try:
                route_final = await _densify_route(route_final)
            except Exception:
                pass  # keep unfilled route on error

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
