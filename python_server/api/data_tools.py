"""Data-access helpers for the transit council.

All public functions are async-safe: synchronous DB calls are run in a
thread pool so they don't block the event loop.
"""

from __future__ import annotations

import asyncio
import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from sqlalchemy import text

from python_utils.python_utils.db.session import engine

# ── Neighbourhood GeoJSON ──────────────────────────────────────────────────────

GEOJSON_PATH = (
    Path(__file__).resolve().parents[2] / "web" / "public" / "Neighbourhoods - 4326.geojson"
)


@lru_cache(maxsize=1)
def _load_neighbourhoods_sync() -> dict:
    with open(GEOJSON_PATH, encoding="utf-8") as f:
        return json.load(f)


async def load_neighbourhoods() -> dict:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _load_neighbourhoods_sync)


async def find_neighbourhood(name: str) -> dict | None:
    """Return the GeoJSON feature whose AREA_NAME matches (case-insensitive)."""
    data = await load_neighbourhoods()
    name_lower = name.lower()
    for feature in data["features"]:
        if (feature.get("properties") or {}).get("AREA_NAME", "").lower() == name_lower:
            return feature
    return None


async def list_neighbourhood_names() -> list[str]:
    data = await load_neighbourhoods()
    return [
        f["properties"]["AREA_NAME"]
        for f in data["features"]
        if f.get("properties") and f["properties"].get("AREA_NAME")
    ]


# ── PostGIS queries ────────────────────────────────────────────────────────────

def _run_stops_near_point(lon: float, lat: float, radius_m: float) -> list[dict[str, Any]]:
    """Sync: stops within radius_m metres of (lon, lat), with total demand."""
    sql = text("""
        SELECT
            s.stop_name,
            s.stop_id,
            ST_X(s.geom) AS lon,
            ST_Y(s.geom) AS lat,
            COALESCE(SUM(d.boardings), 0)  AS total_boardings,
            COALESCE(SUM(d.alightings), 0) AS total_alightings
        FROM stops s
        LEFT JOIN stop_demand_summary d ON d.stop_pk = s.stop_pk
        WHERE ST_DWithin(
            s.geom::geography,
            ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography,
            :radius_m
        )
        GROUP BY s.stop_name, s.stop_id, s.geom
        ORDER BY total_boardings DESC
        LIMIT 20
    """)
    try:
        with engine.connect() as conn:
            rows = conn.execute(sql, {"lon": lon, "lat": lat, "radius_m": radius_m}).mappings().all()
        return [dict(r) for r in rows]
    except Exception:
        return []


def _run_stops_in_bbox(
    min_lon: float, min_lat: float, max_lon: float, max_lat: float
) -> list[dict[str, Any]]:
    """Sync: stops inside a bounding box with total demand."""
    sql = text("""
        SELECT
            s.stop_name,
            s.stop_id,
            ST_X(s.geom) AS lon,
            ST_Y(s.geom) AS lat,
            COALESCE(SUM(d.boardings), 0)  AS total_boardings,
            COALESCE(SUM(d.alightings), 0) AS total_alightings
        FROM stops s
        LEFT JOIN stop_demand_summary d ON d.stop_pk = s.stop_pk
        WHERE s.geom && ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326)
        GROUP BY s.stop_name, s.stop_id, s.geom
        ORDER BY total_boardings DESC
        LIMIT 30
    """)
    try:
        with engine.connect() as conn:
            rows = conn.execute(
                sql,
                {"min_lon": min_lon, "min_lat": min_lat, "max_lon": max_lon, "max_lat": max_lat},
            ).mappings().all()
        return [dict(r) for r in rows]
    except Exception:
        return []


async def get_stops_near_point(
    lon: float, lat: float, radius_m: float = 500
) -> list[dict[str, Any]]:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _run_stops_near_point, lon, lat, radius_m)


async def get_stops_in_neighbourhood(neighbourhood_name: str) -> list[dict[str, Any]]:
    """Return stops inside the bounding box of a named neighbourhood."""
    feature = await find_neighbourhood(neighbourhood_name)
    if not feature:
        return []

    coords_flat: list[tuple[float, float]] = []

    def _collect(geom: dict) -> None:
        t = geom["type"]
        if t == "Polygon":
            for ring in geom["coordinates"]:
                coords_flat.extend(ring)
        elif t == "MultiPolygon":
            for poly in geom["coordinates"]:
                for ring in poly:
                    coords_flat.extend(ring)

    _collect(feature["geometry"])
    if not coords_flat:
        return []

    lons = [c[0] for c in coords_flat]
    lats = [c[1] for c in coords_flat]
    bbox = (min(lons), min(lats), max(lons), max(lats))

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _run_stops_in_bbox, *bbox)


# ── Formatting helpers ─────────────────────────────────────────────────────────

def format_stops_summary(stops: list[dict[str, Any]], max_show: int = 8) -> str:
    """Human-readable stop list for agent context."""
    if not stops:
        return "No stops found."
    lines = []
    for s in stops[:max_show]:
        name = s["stop_name"] or s["stop_id"]
        board = int(s["total_boardings"] or 0)
        alight = int(s["total_alightings"] or 0)
        lines.append(
            f"  • {name} ({s['lon']:.4f}, {s['lat']:.4f})"
            + (f" — {board:,} boardings/day" if board else "")
        )
    if len(stops) > max_show:
        lines.append(f"  … and {len(stops) - max_show} more stops")
    return "\n".join(lines)


async def build_data_brief(
    neighbourhoods: list[str],
    station_names: list[str],
) -> tuple[str, list[dict]]:
    """
    Fetch context data for all required neighbourhoods and named stations.
    Returns (formatted_brief_text, list_of_all_stops_with_coords).
    """
    sections: list[str] = []
    all_stops: list[dict] = []

    for name in neighbourhoods:
        stops = await get_stops_in_neighbourhood(name)
        all_stops.extend(stops)
        section = f"**{name}**\n"
        section += format_stops_summary(stops)
        sections.append(section)

    # For named stations (existing stops), search by name near Toronto centre
    # We do a broad bbox search and filter by name
    if station_names:
        station_brief_lines: list[str] = []
        loop = asyncio.get_event_loop()
        all_known = await loop.run_in_executor(
            None,
            _run_stops_in_bbox,
            -79.65, 43.55, -79.10, 43.85,
        )
        for sname in station_names:
            matched = [
                s for s in all_known
                if s["stop_name"] and sname.lower() in s["stop_name"].lower()
            ]
            if matched:
                s = matched[0]
                all_stops.append(s)
                board = int(s["total_boardings"] or 0)
                station_brief_lines.append(
                    f"  • {s['stop_name']} ({s['lon']:.4f}, {s['lat']:.4f})"
                    + (f" — {board:,} boardings/day" if board else "")
                )
            else:
                station_brief_lines.append(f"  • {sname} (not found in DB)")
        sections.append("**Required connection stations**\n" + "\n".join(station_brief_lines))

    brief = "\n\n".join(sections) if sections else "No specific location data available."
    return brief, all_stops
