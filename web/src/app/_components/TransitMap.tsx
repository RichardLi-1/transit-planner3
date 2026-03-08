"use client";

import MapboxDraw from "@mapbox/mapbox-gl-draw";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";
import mapboxgl from "mapbox-gl";
import { useEffect, useMemo, useRef, useState } from "react";

type DrawMode = "normal" | "select" | "boundary";

import {
  GENERATED_ROUTES,
  ROUTES,
  type GeneratedRoute,
  type Route,
} from "~/app/map/mock-data";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";
const TORONTO: [number, number] = [-79.3832, 43.6532];

// ─── geo helpers ──────────────────────────────────────────────────────────────

function pointInRing(px: number, py: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!, yi = ring[i]![1]!;
    const xj = ring[j]![0]!, yj = ring[j]![1]!;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInGeometry(pt: [number, number], geom: GeoJSON.Geometry): boolean {
  if (geom.type === "Polygon") {
    return pointInRing(pt[0], pt[1], (geom.coordinates as number[][][])[0]!);
  }
  if (geom.type === "MultiPolygon") {
    return (geom.coordinates as number[][][][]).some((poly) => pointInRing(pt[0], pt[1], poly[0]!));
  }
  return false;
}

function geomBBox(geom: GeoJSON.Geometry): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function walk(c: unknown) {
    if (Array.isArray(c) && typeof c[0] === "number") {
      if (c[0]! < minX) minX = c[0]!;
      if (c[1]! < minY) minY = c[1]!;
      if (c[0]! > maxX) maxX = c[0]!;
      if (c[1]! > maxY) maxY = c[1]!;
    } else if (Array.isArray(c)) { c.forEach(walk); }
  }
  walk((geom as unknown as { coordinates: unknown }).coordinates);
  return [minX, minY, maxX, maxY];
}

function firstCoord(geom: GeoJSON.Geometry): [number, number] | null {
  let result: [number, number] | null = null;
  function walk(c: unknown): boolean {
    if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") {
      result = [c[0] as number, c[1] as number]; return true;
    }
    if (Array.isArray(c)) { for (const x of c) if (walk(x)) return true; }
    return false;
  }
  walk((geom as unknown as { coordinates: unknown }).coordinates);
  return result;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Catmull-Rom spline interpolation for a single axis */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t
  );
}

/** Insert smooth curve points between each pair of coordinates using Catmull-Rom spline */
function smoothCoords(coords: [number, number][], steps = 12): [number, number][] {
  if (coords.length < 2) return coords;
  const result: [number, number][] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[Math.max(0, i - 1)]!;
    const p1 = coords[i]!;
    const p2 = coords[i + 1]!;
    const p3 = coords[Math.min(coords.length - 1, i + 2)]!;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      result.push([catmullRom(p0[0], p1[0], p2[0], p3[0], t), catmullRom(p0[1], p1[1], p2[1], p3[1], t)]);
    }
  }
  result.push(coords[coords.length - 1]!);
  return result;
}

function routeToGeoJSON(route: Route): GeoJSON.Feature<GeoJSON.LineString> {
  const raw = route.shape ?? route.stops.map((s) => s.coords);
  return {
    type: "Feature",
    properties: { id: route.id },
    geometry: {
      type: "LineString",
      coordinates: smoothCoords(raw),
    },
  };
}

function stopsToGeoJSON(route: Route): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: route.stops.map((s) => ({
      type: "Feature",
      properties: { name: s.name, routeId: route.id, color: route.color },
      geometry: { type: "Point", coordinates: s.coords },
    })),
  };
}


import { haversineKm, computeStationPopulations, type PopRow } from "~/app/map/geo-utils";

// ─── stat bar ─────────────────────────────────────────────────────────────────

function StatBar({ value, max, color }: { value: number; max: number; color: string }) {
  return (
    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-stone-100">
      <div
        className="h-1.5 rounded-full"
        style={{ width: `${(value / max) * 100}%`, background: color }}
      />
    </div>
  );
}

const TYPE_LABEL: Record<Route["type"], string> = {
  subway: "Subway",
  streetcar: "Streetcar",
  bus: "Bus",
};

// ─── neighbourhood panel ──────────────────────────────────────────────────────

const TRAFFIC_COLOR: Record<string, string> = {
  "Low": "#22c55e",
  "Moderate": "#f59e0b",
  "High": "#f97316",
  "Very High": "#ef4444",
};

const TRAFFIC_COLOR_TO_LEVEL: Record<string, string> = {
  "green": "Low",
  "yellow": "Moderate",
  "orange": "High",
  "red": "Very High",
};

function NeighbourhoodPanel({
  name,
  lat,
  lng,
  geometry,
  popRawData,
  trafficFeatures,
  onClose,
}: {
  name: string;
  lat: number;
  lng: number;
  geometry: GeoJSON.Geometry | null;
  popRawData: import("~/app/map/geo-utils").PopRow[];
  trafficFeatures: GeoJSON.Feature[];
  onClose: () => void;
}) {
  // ── Street view image with localStorage cache
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  useEffect(() => {
    const key = `streetview-${lat.toFixed(5)}-${lng.toFixed(5)}`;
    const cached = localStorage.getItem(key);
    if (cached) { setImgSrc(cached); return; }
    const apiUrl = `/api/streetview?lat=${lat}&lng=${lng}`;
    fetch(apiUrl)
      .then((r) => r.blob())
      .then((blob) => new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      }))
      .then((dataUrl) => {
        try { localStorage.setItem(key, dataUrl); } catch { /* storage full */ }
        setImgSrc(dataUrl);
      })
      .catch(() => setImgSrc(apiUrl));
  }, [lat, lng]);

  // ── Compute population + traffic from real data
  const { totalPop, trafficLevel } = useMemo(() => {
    if (!geometry) return { totalPop: null, trafficLevel: null };
    const bbox = geomBBox(geometry);

    let totalPop = 0;
    for (const row of popRawData) {
      const { longitude: lng, latitude: lat, population } = row;
      if (lng < bbox[0] || lng > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;
      if (pointInGeometry([lng, lat], geometry)) totalPop += population;
    }

    const levelCounts: Record<string, number> = { Low: 0, Moderate: 0, High: 0, "Very High": 0 };
    for (const feat of trafficFeatures) {
      const color = feat.properties?.traffic_color as string | null;
      if (!color) continue;
      const pt = firstCoord(feat.geometry);
      if (!pt) continue;
      if (pt[0] < bbox[0] || pt[0] > bbox[2] || pt[1] < bbox[1] || pt[1] > bbox[3]) continue;
      if (!pointInGeometry(pt, geometry)) continue;
      const level = TRAFFIC_COLOR_TO_LEVEL[color];
      if (level) levelCounts[level]!++;
    }
    const total = Object.values(levelCounts).reduce((a, b) => a + b, 0);
    const trafficLevel = total > 0
      ? (Object.entries(levelCounts).reduce((a, b) => a[1] >= b[1] ? a : b)[0] as string)
      : null;

    return { totalPop: totalPop > 0 ? totalPop : null, trafficLevel };
  }, [geometry, popRawData, trafficFeatures]);

  return (
    <div className="pointer-events-auto w-72 overflow-hidden rounded-2xl bg-white shadow-sm" style={{ border: "0.93px solid #BEB7B4" }}>
      {/* Preview image */}
      <div className="relative h-36 bg-stone-200">
        {!imgSrc && <div className="absolute inset-0 animate-pulse bg-stone-200" />}
        {imgSrc && (
          <img
            src={imgSrc}
            alt="Neighbourhood view"
            className="h-full w-full object-cover"
          />
        )}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 flex h-7 w-7 items-center justify-center rounded-full bg-white/80 text-stone-500 hover:bg-white hover:text-stone-800"
        >
          ✕
        </button>
      </div>

      <div className="px-5 pt-4 pb-5 space-y-4">
        <h2 className="text-lg font-semibold text-stone-800">{name}</h2>

        <div className="space-y-2.5">
          {trafficLevel && (
            <div className="flex justify-between text-sm">
              <span className="text-stone-500">Traffic level</span>
              <span className="font-semibold" style={{ color: TRAFFIC_COLOR[trafficLevel] }}>
                {trafficLevel}
              </span>
            </div>
          )}
          {totalPop !== null && (
            <div className="flex justify-between text-sm">
              <span className="text-stone-500">Total population</span>
              <span className="font-semibold text-stone-800">{totalPop.toLocaleString()}</span>
            </div>
          )}
          {!trafficLevel && totalPop === null && (
            <p className="text-sm text-stone-400">No data available</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── existing route panel ────────────────────────────────────────────────────

function RoutePanel({
  route,
  selectedStop,
  stationPopulations,
  extraStops,
  isCustomLine,
  onDeleteStop,
  onDeleteLine,
  onClose,
}: {
  route: Route;
  selectedStop: string | null;
  stationPopulations: Map<string, number>;
  extraStops: { name: string; coords: [number, number] }[];
  isCustomLine?: boolean;
  onDeleteStop: (name: string) => void;
  onDeleteLine?: () => void;
  onClose: () => void;
}) {
  const rawPop = selectedStop ? stationPopulations.get(selectedStop) : undefined;
  const popServed = rawPop !== undefined ? Math.max(2314, rawPop) : undefined;
  const allStops = [...route.stops, ...extraStops];
  const extraNames = new Set(extraStops.map((s) => s.name));

  return (
    <div className="pointer-events-auto flex h-full w-80 flex-col overflow-hidden rounded-[30px] bg-white" style={{ border: "0.93px solid #BEB7B4" }}>
      <div className="flex items-start justify-between px-5 pt-5 pb-4">
        <div className="flex items-center gap-3">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold"
            style={{ background: route.color, color: route.textColor }}
          >
            {route.shortName}
          </span>
          <div>
            <p className="text-[11px] font-medium tracking-widest text-stone-400 uppercase">
              {selectedStop ? route.name :[route.type]}
            </p>
            <h2 className="text-base font-semibold leading-tight text-stone-800">{selectedStop ?? route.name}</h2>
          </div>
        </div>
        <button
          onClick={onClose}
          className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-stone-400 hover:bg-stone-100 hover:text-stone-700"
          aria-label="Close panel"
        >
          ✕
        </button>
      </div>

      <div className="mx-5 h-0.5 rounded-full" style={{ background: route.color }} />

      {selectedStop && popServed !== undefined && (
        <div className="mx-5 mt-3 rounded-xl bg-stone-50 px-4 py-3">
          <p className="text-[11px] font-semibold tracking-widest text-stone-400 uppercase">Population Served</p>
          <p className="mt-1 text-2xl font-bold text-stone-800">{popServed.toLocaleString()}</p>
          <p className="text-[11px] text-stone-400">Nearest-station assignment, 5 km cutoff</p>
        </div>
      )}

      <div className="px-5 pt-3 pb-2">
        <p className="text-sm leading-relaxed text-stone-500">{route.description}</p>
        <p className="mt-2 text-xs font-medium text-stone-400">
          Frequency: <span className="text-stone-600">{route.frequency}</span>
        </p>
      </div>

      {isCustomLine && onDeleteLine && (
        <div className="mx-5 mb-3">
          <button
            onClick={onDeleteLine}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-red-200 py-2 text-sm text-red-500 hover:bg-red-50 transition-colors"
          >
            <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="currentColor">
              <path fillRule="evenodd" d="M6 1a1.75 1.75 0 0 0-1.736 1.502H2.75a.75.75 0 0 0 0 1.5h.148l.465 6.52A1.75 1.75 0 0 0 5.11 12h3.78a1.75 1.75 0 0 0 1.747-1.478l.465-6.52h.148a.75.75 0 0 0 0-1.5H9.736A1.75 1.75 0 0 0 8 1H6Zm1 1.5a.25.25 0 0 0-.247.215L6.5 2.5h1l-.253-.285A.25.25 0 0 0 7 2.5Zm-1.5 3a.5.5 0 0 1 1 0l-.2 4a.3.3 0 0 1-.6 0l-.2-4Zm2.5 0a.5.5 0 0 1 1 0l-.2 4a.3.3 0 0 1-.6 0l-.2-4Z" clipRule="evenodd"/>
            </svg>
            Delete line
          </button>
        </div>
      )}

      <div className="mt-2 flex-1 overflow-y-auto px-5 pb-5">
        <p className="mb-2 text-[11px] font-semibold tracking-widest text-stone-400 uppercase">
          Stops ({allStops.length})
        </p>
        <ol className="relative border-l-2" style={{ borderColor: route.color + "44" }}>
          {allStops.map((stop, i) => {
            const isExtra = extraNames.has(stop.name);
            return (
              <li key={stop.name} className="group mb-0 flex items-center justify-between">
                <div className="flex items-center min-w-0">
                  <span
                    className="absolute -left-[5px] h-2.5 w-2.5 rounded-full border-2 bg-white"
                    style={{
                      borderColor:
                        i === 0 || i === allStops.length - 1
                          ? route.color
                          : isExtra
                            ? route.color + "cc"
                            : route.color + "88",
                    }}
                  />
                  <span className={`py-1.5 pl-4 text-sm ${stop.name === selectedStop ? "font-bold text-stone-900" : isExtra ? "text-stone-600 italic" : "text-stone-700"}`}>
                    {stop.name}
                  </span>
                </div>
                {isExtra && (
                  <button
                    onClick={() => onDeleteStop(stop.name)}
                    className="mr-1 shrink-0 opacity-0 group-hover:opacity-100 rounded p-0.5 text-stone-300 hover:bg-red-50 hover:text-red-400 transition-all"
                    title="Remove stop"
                  >
                    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <path d="M1 1l10 10M11 1L1 11"/>
                    </svg>
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

// ─── generated route stats panel ─────────────────────────────────────────────

function GeneratedRoutePanel({
  route,
  disabledStops,
  isGenerating,
  onToggleStop,
  onClose,
  onRegenerate,
}: {
  route: GeneratedRoute;
  disabledStops: Set<string>;
  isGenerating: boolean;
  onToggleStop: (name: string) => void;
  onClose: () => void;
  onRegenerate: () => void;
}) {
  const { stats } = route;
  const prColor =
    stats.prNightmareScore < 4
      ? "#22c55e"
      : stats.prNightmareScore < 7
        ? "#f59e0b"
        : "#ef4444";
  const chanceColor =
    stats.percentageChance > 65 ? "#22c55e" : stats.percentageChance > 40 ? "#f59e0b" : "#ef4444";

  return (
    <div className="pointer-events-auto flex h-full w-80 flex-col overflow-hidden rounded-[30px] bg-white" style={{ border: "0.93px solid #BEB7B4" }}>
      {/* Header */}
      <div className="flex items-start justify-between px-5 pt-5 pb-4">
        <div className="flex items-center gap-3">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold"
            style={{ background: route.color, color: route.textColor }}
          >
            {route.shortName}
          </span>
          <div>
            <p className="flex items-center gap-1 text-[11px] font-medium tracking-widest text-stone-400 uppercase">
              <span>✦</span> AI Generated
            </p>
            <h2 className="text-base font-semibold leading-tight text-stone-800">{route.name}</h2>
          </div>
        </div>
        <button
          onClick={onClose}
          className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-stone-400 hover:bg-stone-100 hover:text-stone-700"
          aria-label="Close panel"
        >
          ✕
        </button>
      </div>

      <div className="mx-5 h-0.5 rounded-full" style={{ background: route.color }} />

      <div className="px-5 pt-3 pb-2">
        <p className="text-sm leading-relaxed text-stone-500">{route.description}</p>
      </div>

      {/* Stats */}
      <div className="border-b border-stone-100 px-5 pb-4">
        <p className="mb-3 text-[11px] font-semibold tracking-widest text-stone-400 uppercase">
          Route Analysis
        </p>
        <div className="space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-stone-500">Cost</span>
            <span className="font-semibold text-stone-800">{stats.cost}</span>
          </div>

          <div>
            <div className="flex justify-between text-sm">
              <span className="text-stone-500">Timeline</span>
              <span className="font-semibold text-stone-800">{stats.timeline}</span>
            </div>
            <div className="flex justify-between text-xs mt-0.5">
              <span className="italic text-stone-400">w/ contingency</span>
              <span className="text-stone-500">{stats.costedTimeline}</span>
            </div>
          </div>

          <div className="flex justify-between text-sm">
            <span className="text-stone-500">Minutes Saved</span>
            <span className="font-semibold text-stone-800">{stats.minutesSaved} min/trip</span>
          </div>

          <div className="flex justify-between text-sm">
            <span className="text-stone-500">Dollars Saved</span>
            <span className="font-semibold text-stone-800">{stats.dollarsSaved}</span>
          </div>

          <div>
            <div className="flex justify-between text-sm">
              <span className="text-stone-500">Approval Chance</span>
              <span className="font-semibold" style={{ color: chanceColor }}>
                {stats.percentageChance}%
              </span>
            </div>
            <StatBar value={stats.percentageChance} max={100} color={chanceColor} />
          </div>

          <div>
            <div className="flex justify-between text-sm">
              <span className="text-stone-500">PR Nightmare Score</span>
              <span className="font-semibold" style={{ color: prColor }}>
                {stats.prNightmareScore}/10
              </span>
            </div>
            <StatBar value={stats.prNightmareScore} max={10} color={prColor} />
          </div>
        </div>
      </div>

      {/* Editable stops */}
      <div className="mt-2 flex-1 overflow-y-auto px-5 pb-3">
        <p className="mb-2 text-[11px] font-semibold tracking-widest text-stone-400 uppercase">
          Stops — click to toggle
        </p>
        <ol className="relative border-l-2" style={{ borderColor: route.color + "44" }}>
          {route.stops.map((stop, i) => {
            const off = disabledStops.has(stop.name);
            return (
              <li
                key={stop.name}
                className="group mb-0 flex cursor-pointer items-center"
                onClick={() => onToggleStop(stop.name)}
              >
                <span
                  className="absolute -left-[5px] h-2.5 w-2.5 rounded-full border-2 bg-white"
                  style={{
                    borderColor: off
                      ? "#d1d5db"
                      : i === 0 || i === route.stops.length - 1
                        ? route.color
                        : route.color + "88",
                  }}
                />
                <span
                  className={`py-1.5 pl-4 text-sm transition-colors ${
                    off
                      ? "text-stone-300 line-through"
                      : "text-stone-700 group-hover:text-stone-900"
                  }`}
                >
                  {stop.name}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {/* Regenerate */}
      <div className="border-t border-stone-100 px-5 py-3">
        <button
          onClick={onRegenerate}
          disabled={isGenerating}
          className="flex w-full items-center justify-center gap-2 rounded-lg py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 active:opacity-80 disabled:opacity-50"
          style={{ background: route.color }}
        >
          {isGenerating ? (
            <>
              <span className="inline-block animate-spin">⟳</span> Generating…
            </>
          ) : (
            <>✦ Regenerate</>
          )}
        </button>
      </div>
    </div>
  );
}

// ─── station popup ────────────────────────────────────────────────────────────

const PRESET_COLORS = ["#6366f1","#ef4444","#f59e0b","#22c55e","#0ea5e9","#ec4899","#8b5cf6","#14b8a6","#f97316","#64748b"];

function StationPopup({
  popup,
  allRoutes,
  isDeletable,
  connectedRoutes,
  onClose,
  onDelete,
  onAddTransfer,
  onRemoveTransfer,
}: {
  popup: { name: string; routeId: string; x: number; y: number };
  allRoutes: Route[];
  isDeletable: boolean;
  connectedRoutes: Route[];
  onClose: () => void;
  onDelete: () => void;
  onAddTransfer: (targetRouteId: string) => void;
  onRemoveTransfer: (targetRouteId: string) => void;
}) {
  const currentRoute = allRoutes.find((r) => r.id === popup.routeId);
  const connectedIds = new Set(connectedRoutes.map((r) => r.id));
  const transferableRoutes = allRoutes.filter((r) => r.id !== popup.routeId && !connectedIds.has(r.id));
  return (
    <div
      className="pointer-events-auto absolute z-20 w-52 rounded-xl border border-stone-200 bg-white p-3 shadow-lg"
      style={{ left: popup.x, top: popup.y, transform: "translate(-50%, calc(-100% - 12px))" }}
    >
      {/* Arrow */}
      <div
        className="absolute left-1/2 -bottom-[6px] -translate-x-1/2 border-l-[6px] border-r-[6px] border-t-[6px] border-l-transparent border-r-transparent"
        style={{ borderTopColor: "#e7e5e4" }}
      />
      <div
        className="absolute left-1/2 -bottom-[5px] -translate-x-1/2 border-l-[5px] border-r-[5px] border-t-[5px] border-l-transparent border-r-transparent"
        style={{ borderTopColor: "#ffffff" }}
      />
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="h-2.5 w-5 shrink-0 rounded-full"
            style={{ background: currentRoute?.color ?? "#94a3b8" }}
          />
          <span className="truncate text-sm font-semibold text-stone-800">{popup.name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isDeletable && (
            <button
              onClick={onDelete}
              title="Remove stop"
              className="rounded p-0.5 text-stone-300 hover:bg-red-50 hover:text-red-400 transition-colors"
            >
              <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="currentColor">
                <path fillRule="evenodd" d="M6 1a1.75 1.75 0 0 0-1.736 1.502H2.75a.75.75 0 0 0 0 1.5h.148l.465 6.52A1.75 1.75 0 0 0 5.11 12h3.78a1.75 1.75 0 0 0 1.747-1.478l.465-6.52h.148a.75.75 0 0 0 0-1.5H9.736A1.75 1.75 0 0 0 8 1H6Zm1 1.5a.25.25 0 0 0-.247.215L6.5 2.5h1l-.253-.285A.25.25 0 0 0 7 2.5Zm-1.5 3a.5.5 0 0 1 1 0l-.2 4a.3.3 0 0 1-.6 0l-.2-4Zm2.5 0a.5.5 0 0 1 1 0l-.2 4a.3.3 0 0 1-.6 0l-.2-4Z" clipRule="evenodd"/>
              </svg>
            </button>
          )}
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600">
            <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M1 1l10 10M11 1L1 11"/>
            </svg>
          </button>
        </div>
      </div>
      {connectedRoutes.length > 0 && (
        <div className="mb-2">
          <p className="mb-1.5 text-[10px] font-semibold tracking-widest text-stone-400 uppercase">
            Connections
          </p>
          <div className="flex flex-wrap gap-1.5">
            {connectedRoutes.map((r) => (
              <button
                key={r.id}
                onClick={() => onRemoveTransfer(r.id)}
                title={`Remove connection to ${r.name}`}
                className="group flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold transition-opacity hover:opacity-70"
                style={{ background: r.color, color: r.textColor }}
              >
                <span>{r.shortName}</span>
                <span className="opacity-60 group-hover:opacity-100">×</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {transferableRoutes.length > 0 && (
        <div>
          <p className="mb-1.5 text-[10px] font-semibold tracking-widest text-stone-400 uppercase">
            Add transfer to
          </p>
          <div className="flex flex-wrap gap-1.5">
            {transferableRoutes.map((r) => (
              <button
                key={r.id}
                onClick={() => onAddTransfer(r.id)}
                className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
                style={{ background: r.color, color: r.textColor }}
              >
                <span>{r.shortName}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── new line modal ───────────────────────────────────────────────────────────

function NewLineModal({
  onConfirm,
  onClose,
}: {
  onConfirm: (name: string, color: string, type: Route["type"]) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(PRESET_COLORS[0]!);
  const [type, setType] = useState<Route["type"]>("subway");
  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-72 rounded-2xl bg-white p-5 shadow-xl">
        <h3 className="mb-4 text-base font-semibold text-stone-800">New Line</h3>
        <input
          autoFocus
          className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm outline-none focus:border-stone-400"
          placeholder="Line name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onConfirm(name.trim(), color, type); }}
        />
        <div className="mt-3">
          <p className="mb-1.5 text-[10px] font-semibold tracking-widest text-stone-400 uppercase">Color</p>
          <div className="flex flex-wrap gap-2">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`h-6 w-6 rounded-full transition-transform ${color === c ? "scale-125 ring-2 ring-offset-1 ring-stone-400" : "hover:scale-110"}`}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-stone-500 hover:text-stone-700"
          >
            Cancel
          </button>
          <button
            onClick={() => { if (name.trim()) onConfirm(name.trim(), color, type); }}
            className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            style={{ background: color }}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── main map component ──────────────────────────────────────────────────────

export function TransitMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const drawRef = useRef<MapboxDraw | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<Route | null>(null);
  const [selectedStop, setSelectedStop] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [generatedRoute, setGeneratedRoute] = useState<GeneratedRoute | null>(null);
  const [disabledStops, setDisabledStops] = useState<Set<string>>(new Set());
  const [isGenerating, setIsGenerating] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [isBirdsEye, setIsBirdsEye] = useState(false);
  const [showTraffic, setShowTraffic] = useState(false);
  const [trafficLoading, setTrafficLoading] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [populationGeoJSON, setPopulationGeoJSON] = useState<GeoJSON.FeatureCollection | null>(null);
  const [trafficGeoJSON, setTrafficGeoJSON] = useState<GeoJSON.FeatureCollection | null>(null);
  const [popRawData, setPopRawData] = useState<PopRow[]>([]);
  const [drawMode, setDrawMode] = useState<DrawMode>("normal");

  // Voronoi: assign each population point to its nearest station (5 km cutoff)
  const stationPopulations = useMemo(() => {
    if (popRawData.length === 0) return new Map<string, number>();
    // Collect all unique stations across all routes
    const allStops: { name: string; coords: [number, number] }[] = [];
    const seen = new Set<string>();
    for (const route of ROUTES) {
      for (const stop of route.stops) {
        const key = `${stop.name}@${stop.coords[0]},${stop.coords[1]}`;
        if (!seen.has(key)) {
          seen.add(key);
          allStops.push(stop);
        }
      }
    }
    return computeStationPopulations(popRawData, allStops, 5);
  }, [popRawData]);
  const [hasBoundary, setHasBoundary] = useState(false);
  const [selectedNeighbourhoods, setSelectedNeighbourhoods] = useState<Set<string>>(new Set());
  const [selectedStations, setSelectedStations] = useState<Set<string>>(new Set()); // "name::routeId"
  const [focusedNeighbourhood, setFocusedNeighbourhood] = useState<{ id: string; name: string; lat: number; lng: number; geometry: GeoJSON.Geometry | null } | null>(null);
  const genIdxRef = useRef(0);

  // ── line-editor state
  const [addStationToLine, setAddStationToLine] = useState<string | null>(null);
  const [routeExtraStops, setRouteExtraStops] = useState<Map<string, { name: string; coords: [number, number] }[]>>(new Map());
  const [customLines, setCustomLines] = useState<Route[]>([]);
  const [stationPopup, setStationPopup] = useState<{ name: string; routeId: string; x: number; y: number; coords: [number, number] } | null>(null);
  const [showNewLineModal, setShowNewLineModal] = useState(false);
  const stopCounterRef = useRef(1);
  const customLineCounterRef = useRef(1);
  const historyRef = useRef<{ stops: Map<string, { name: string; coords: [number, number] }[]>; counter: number }[]>([]);

  // Refs for use inside map event callbacks (avoid stale closure)
  const drawModeRef = useRef<DrawMode>("normal");
  const selectedNeighbourhoodsRef = useRef<Set<string>>(new Set());
  const selectedStationsRef = useRef<Set<string>>(new Set());
  const addStationToLineRef = useRef<string | null>(null);
  const customLinesRef = useRef<Route[]>([]);
  const routeExtraStopsRef = useRef<Map<string, { name: string; coords: [number, number] }[]>>(new Map());
  // Blocks neighbourhood clicks for one tick after a polygon is completed,
  // preventing the closing double-click from immediately selecting a neighbourhood.
  const justCompletedBoundaryRef = useRef(false);
  // Cache for the full neighbourhood GeoJSON (needed for geometry lookups on click)
  const neighbourhoodsGeoJSONRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const didDragStopRef = useRef(false); // suppresses click after a drag
  const stationPopupRef = useRef<typeof stationPopup>(null);

  useEffect(() => {
    drawModeRef.current = drawMode;
  }, [drawMode]);

  useEffect(() => {
    selectedNeighbourhoodsRef.current = selectedNeighbourhoods;
  }, [selectedNeighbourhoods]);

  useEffect(() => {
    selectedStationsRef.current = selectedStations;
  }, [selectedStations]);

  // Update map highlight layers whenever selectedStations changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    [...ROUTES, ...customLinesRef.current].forEach((route) => {
      const layerId = `stops-selected-${route.id}`;
      if (!map.getLayer(layerId)) return;
      const names = [...selectedStations]
        .filter((k) => k.endsWith(`::${route.id}`))
        .map((k) => k.split("::")[0]!);
      map.setFilter(
        layerId,
        names.length > 0
          ? ["in", ["get", "name"], ["literal", names]]
          : ["==", ["get", "name"], "__none__"],
      );
    });
  }, [selectedStations, mapLoaded]);

  useEffect(() => {
    addStationToLineRef.current = addStationToLine;
  }, [addStationToLine]);

  useEffect(() => {
    customLinesRef.current = customLines;
  }, [customLines]);

  useEffect(() => {
    routeExtraStopsRef.current = routeExtraStops;
  }, [routeExtraStops]);

  useEffect(() => {
    stationPopupRef.current = stationPopup;
  }, [stationPopup]);

  function snapshotHistory() {
    historyRef.current.push({
      stops: new Map([...routeExtraStopsRef.current].map(([k, v]) => [k, [...v]])),
      counter: stopCounterRef.current,
    });
  }


  function handleGenerate() {
    if (isGenerating) return;
    setIsGenerating(true);
    setSelectedRoute(null);
    setTimeout(() => {
      const route = GENERATED_ROUTES[genIdxRef.current % GENERATED_ROUTES.length]!;
      genIdxRef.current += 1;
      setGeneratedRoute(route);
      setDisabledStops(new Set());
      setIsGenerating(false);
    }, 1200);
  }

  function handleSetDrawMode(mode: DrawMode) {
    const draw = drawRef.current;
    const map = mapRef.current;
    if (!draw) return;
    if (mode === drawMode) return; // clicking the active mode button does nothing
    setDrawMode(mode);
    drawModeRef.current = mode;
    if (mode === "boundary") {
      // Clear neighbourhood selection when entering draw mode
      if (map && mapLoaded) {
        selectedNeighbourhoodsRef.current.forEach((id) => {
          map.setFeatureState({ source: "neighbourhoods", id }, { selected: false });
        });
      }
      setSelectedNeighbourhoods(new Set());
      selectedNeighbourhoodsRef.current = new Set();
      draw.changeMode("draw_polygon");
    } else if (mode === "select") {
      // Exit line-edit mode when entering neighbourhood-select mode
      setAddStationToLine(null);
      addStationToLineRef.current = null;
      // Clear any drawn boundary when entering neighbourhood-select mode
      draw.deleteAll();
      setHasBoundary(false);
      draw.changeMode("simple_select");
    } else {
      // "normal" — cancel any in-progress draw and return to view mode
      draw.changeMode("simple_select");
      setSelectedStations(new Set());
      selectedStationsRef.current = new Set();
    }
  }

  function handleClearAll() {
    const draw = drawRef.current;
    const map = mapRef.current;
    if (draw) {
      draw.deleteAll();
      setHasBoundary(false);
      draw.changeMode("simple_select");
    }
    if (map && mapLoaded) {
      selectedNeighbourhoodsRef.current.forEach((id) => {
        map.setFeatureState({ source: "neighbourhoods", id }, { selected: false });
      });
    }
    setSelectedNeighbourhoods(new Set());
    setSelectedStations(new Set());
    selectedStationsRef.current = new Set();
    setDrawMode("normal");
    drawModeRef.current = "normal";
  }

  function handleDeleteCustomLine(routeId: string) {
    const map = mapRef.current;
    if (map) {
      [`route-shadow-${routeId}`, `route-outline-${routeId}`, `route-line-${routeId}`, `stops-ring-${routeId}`, `stops-dot-${routeId}`].forEach((id) => {
        if (map.getLayer(id)) map.removeLayer(id);
      });
      [`route-${routeId}`, `stops-${routeId}`].forEach((id) => {
        if (map.getSource(id)) map.removeSource(id);
      });
    }
    setCustomLines((prev) => prev.filter((r) => r.id !== routeId));
    setRouteExtraStops((prev) => { const next = new Map(prev); next.delete(routeId); return next; });
    if (addStationToLine === routeId) setAddStationToLine(null);
    setSelectedRoute(null);
    setSelectedStop(null);
  }

  function handleDeleteStop(stopName: string, routeId: string) {
    snapshotHistory();
    setRouteExtraStops((prev) => {
      const next = new Map(prev);
      const existing = next.get(routeId) ?? [];
      next.set(routeId, existing.filter((s) => s.name !== stopName));
      return next;
    });
  }

  function handleToggleStop(name: string) {
    setDisabledStops((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  // ── fetch and cache neighbourhoods GeoJSON for geometry lookups
  useEffect(() => {
    fetch("/Neighbourhoods - 4326.geojson")
      .then((r) => r.json())
      .then((data: GeoJSON.FeatureCollection) => { neighbourhoodsGeoJSONRef.current = data; })
      .catch(console.error);
  }, []);

  // ── fetch population data from Supabase via API
  useEffect(() => {
    let cancelled = false;
    fetch("/api/population")
      .then((res) => res.json())
      .then((rows: { latitude: number; longitude: number; population: number; area: number }[]) => {
        if (cancelled) return;
        // Compute population density (pop/area), then log-normalize to 0–1
        // Log scale is essential because density spans several orders of magnitude
        const densities = rows.map((r) => (r.area > 0 ? r.population / r.area : 0));
        const logDensities = densities.map((d) => (d > 0 ? Math.log1p(d) : 0));
        const maxLog = Math.max(1, ...logDensities);

        const features: GeoJSON.Feature<GeoJSON.Point>[] = rows.map((r, i) => ({
          type: "Feature",
          properties: {
            weight: logDensities[i]! / maxLog,
            density: densities[i]!,
          },
          geometry: { type: "Point", coordinates: [r.longitude, r.latitude] },
        }));

        const fc: GeoJSON.FeatureCollection = { type: "FeatureCollection", features };
        setPopulationGeoJSON(fc);
        setPopRawData(rows);

        // Update the map source if it already exists
        const map = mapRef.current;
        if (map) {
          const src = map.getSource("population") as mapboxgl.GeoJSONSource | undefined;
          if (src) src.setData(fc);
        }
      })
      .catch((err) => console.error("Failed to fetch population data:", err));
    return () => { cancelled = true; };
  }, []);

  // ── fetch traffic data from Supabase via API
  useEffect(() => {
    let cancelled = false;
    setTrafficLoading(true);
    fetch("/api/traffic")
      .then((res) => res.json())
      .then((fc: GeoJSON.FeatureCollection) => {
        if (cancelled) return;
        setTrafficGeoJSON(fc);
        setTrafficLoading(false);
        const map = mapRef.current;
        if (map) {
          const src = map.getSource("traffic") as mapboxgl.GeoJSONSource | undefined;
          if (src) src.setData(fc);
        }
      })
      .catch((err) => {
        console.error("Failed to fetch traffic data:", err);
        if (!cancelled) setTrafficLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // ── init map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    mapboxgl.accessToken = TOKEN;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: TORONTO,
      zoom: 11.5,
      pitch: 40,
      bearing: -10,
      antialias: true,
    });

    mapRef.current = map;

    const draw = new MapboxDraw({
      displayControlsDefault: false,
      styles: [
        {
          id: "gl-draw-polygon-fill",
          type: "fill",
          filter: ["all", ["==", "$type", "Polygon"], ["!=", "mode", "static"]],
          paint: { "fill-color": "#6366f1", "fill-opacity": 0.1 },
        },
        {
          id: "gl-draw-polygon-stroke",
          type: "line",
          filter: ["all", ["==", "$type", "Polygon"], ["!=", "mode", "static"]],
          paint: { "line-color": "#6366f1", "line-width": 2, "line-dasharray": [3, 2] },
        },
        {
          id: "gl-draw-point-outer",
          type: "circle",
          filter: ["all", ["==", "$type", "Point"], ["==", "meta", "vertex"]],
          paint: { "circle-radius": 5, "circle-color": "#fff", "circle-stroke-color": "#6366f1", "circle-stroke-width": 2 },
        },
        {
          id: "gl-draw-point-midpoint",
          type: "circle",
          filter: ["all", ["==", "$type", "Point"], ["==", "meta", "midpoint"]],
          paint: { "circle-radius": 3, "circle-color": "#6366f1" },
        },
      ],
    });
    drawRef.current = draw;
    map.addControl(draw as unknown as mapboxgl.IControl);

    map.on("draw.create", (e: { features: GeoJSON.Feature[] }) => {
      const feature = e.features[0];
      if (feature?.geometry.type === "Polygon") setHasBoundary(true);
      // Do NOT call draw.changeMode() here — MapboxDraw already transitions
      // internally. Calling it again can re-trigger draw mode.
      setDrawMode("normal");
      drawModeRef.current = "normal";
      justCompletedBoundaryRef.current = true;
      setTimeout(() => { justCompletedBoundaryRef.current = false; }, 300);
    });

    map.on("draw.delete", () => {
      const all = draw.getAll();
      setHasBoundary(all.features.some((f) => f.geometry.type === "Polygon"));
    });

    // NavigationControl replaced by custom React panel below
    map.addControl(new mapboxgl.ScaleControl({ unit: "metric" }), "bottom-left");

    map.on("load", () => {
      const firstLabelLayer = map
        .getStyle()
        ?.layers?.find(
          (l) => l.type === "symbol" && (l.layout as Record<string, unknown>)?.["text-field"],
        )?.id;

      // ── Neighbourhood fill/border layers (below routes)
      map.addSource("neighbourhoods", {
        type: "geojson",
        data: "/Neighbourhoods - 4326.geojson",
        promoteId: "AREA_SHORT_CODE",
      });

      map.addLayer(
        {
          id: "neighbourhood-fill",
          type: "fill",
          source: "neighbourhoods",
          paint: {
            "fill-color": [
              "case",
              ["boolean", ["feature-state", "selected"], false],
              "#6366f1",
              "#94a3b8",
            ],
            "fill-opacity": [
              "case",
              ["boolean", ["feature-state", "selected"], false],
              0.3,
              ["boolean", ["feature-state", "hovered"], false],
              0.08,
              0.02,
            ],
          },
        },
        firstLabelLayer,
      );

      map.addLayer(
        {
          id: "neighbourhood-border",
          type: "line",
          source: "neighbourhoods",
          paint: {
            "line-color": [
              "case",
              ["boolean", ["feature-state", "selected"], false],
              "#6366f1",
              "#94a3b8",
            ],
            "line-width": [
              "case",
              ["boolean", ["feature-state", "selected"], false],
              3,
              0.5,
            ],
            "line-opacity": [
              "case",
              ["boolean", ["feature-state", "selected"], false],
              1,
              0.3,
            ],
          },
        },
        firstLabelLayer,
      );

      // Neighbourhood click handler — only active in "select" mode
      let hoveredNeighbourhoodId: string | null = null;

      map.on("mousemove", "neighbourhood-fill", (e) => {
        if (drawModeRef.current !== "select") return;
        map.getCanvas().style.cursor = "pointer";
        const id = e.features?.[0]?.properties?.AREA_SHORT_CODE as string | undefined;
        if (!id) return;
        if (hoveredNeighbourhoodId && hoveredNeighbourhoodId !== id) {
          map.setFeatureState(
            { source: "neighbourhoods", id: hoveredNeighbourhoodId },
            { hovered: false },
          );
        }
        hoveredNeighbourhoodId = id;
        map.setFeatureState({ source: "neighbourhoods", id }, { hovered: true });
      });

      map.on("mouseleave", "neighbourhood-fill", () => {
        map.getCanvas().style.cursor = "";
        if (hoveredNeighbourhoodId) {
          map.setFeatureState(
            { source: "neighbourhoods", id: hoveredNeighbourhoodId },
            { hovered: false },
          );
          hoveredNeighbourhoodId = null;
        }
      });

      map.on("click", "neighbourhood-fill", (e) => {
        if (drawModeRef.current !== "select") return; // "normal" and "boundary" don't select
        if (justCompletedBoundaryRef.current) return;
        // Station dots sit on top of neighbourhoods — let the station handler take priority
        const stopLayers = (map.getStyle()?.layers ?? []).filter((l) => l.id.startsWith("stops-dot-")).map((l) => l.id);
        if (stopLayers.length > 0 && map.queryRenderedFeatures(e.point, { layers: stopLayers }).length > 0) return;
        const id = e.features?.[0]?.properties?.AREA_SHORT_CODE as string | undefined;
        if (!id) return;
        const name = e.features?.[0]?.properties?.AREA_NAME as string | undefined;

        const current = selectedNeighbourhoodsRef.current;

        if (current.has(id)) {
          // Deselect this neighbourhood — clear the panel
          setFocusedNeighbourhood(null);
          map.setFeatureState({ source: "neighbourhoods", id }, { selected: false });
          setSelectedNeighbourhoods((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        } else {
          // Select — show panel for clicked neighbourhood
          const feat = neighbourhoodsGeoJSONRef.current?.features.find(
            (f) => f.properties?.AREA_SHORT_CODE === id
          );
          setFocusedNeighbourhood({ id, name: name ?? id, lat: e.lngLat.lat, lng: e.lngLat.lng, geometry: feat?.geometry ?? null });
          map.setFeatureState({ source: "neighbourhoods", id }, { selected: true });
          setSelectedNeighbourhoods((prev) => new Set([...prev, id]));
        }

        // Stop propagation so route line clicks don't fire
        e.preventDefault();
      });

      // 3D buildings
      map.addLayer(
        {
          id: "3d-buildings",
          source: "composite",
          "source-layer": "building",
          filter: ["==", "extrude", "true"],
          type: "fill-extrusion",
          minzoom: 12,
          paint: {
            "fill-extrusion-color": "#e8e0d4",
            "fill-extrusion-height": [
              "interpolate",
              ["linear"],
              ["zoom"],
              12,
              0,
              12.05,
              ["get", "height"],
            ],
            "fill-extrusion-base": [
              "interpolate",
              ["linear"],
              ["zoom"],
              12,
              0,
              12.05,
              ["get", "min_height"],
            ],
            "fill-extrusion-opacity": 0.7,
          },
        },
        firstLabelLayer,
      );

      // Population heatmap — data may arrive before or after map load
      map.addSource("population", {
        type: "geojson",
        data: populationGeoJSON ?? { type: "FeatureCollection" as const, features: [] },
      });

      // Population heatmap — fades out as you zoom in
      map.addLayer(
        {
          id: "population-heatmap",
          type: "heatmap",
          source: "population",
          paint: {
            "heatmap-weight": ["interpolate", ["linear"], ["get", "weight"], 0, 0, 1, 1],
            "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 10, 0.4, 13, 0.8],
            "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 10, 10, 12, 28, 13, 50],
            "heatmap-color": [
              "interpolate", ["linear"], ["heatmap-density"],
              0,    "rgba(0,0,0,0)",
              0.2,  "rgba(0,104,55,0.15)",
              0.4,  "rgba(102,189,99,0.5)",
              0.6,  "rgba(255,255,51,0.8)",
              0.8,  "rgba(253,141,60,0.9)",
              1,    "rgba(215,25,28,1)",
            ],
            "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 9, 0, 10, 0.75, 13, 0.3, 15, 0],
          },
        },
        firstLabelLayer,
      );

      // Population circle points — fade in as you zoom in past the heatmap
      map.addLayer(
        {
          id: "population-points",
          type: "circle",
          source: "population",
          paint: {
            "circle-radius": [
              "interpolate", ["linear"], ["zoom"],
              11, 2,
              13, 4,
              16, 8,
            ],
            "circle-color": [
              "interpolate", ["linear"], ["get", "weight"],
              0,    "rgb(0,104,55)",
              0.3,  "rgb(102,189,99)",
              0.5,  "rgb(255,255,51)",
              0.7,  "rgb(253,141,60)",
              0.85, "rgb(253,141,60)",
              1,    "rgb(215,25,28)",
            ],
            "circle-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 16, 0.75],
            "circle-stroke-width": 0.5,
            "circle-stroke-color": "rgba(255,255,255,0.5)",
          },
        },
        firstLabelLayer,
      );

      // Traffic lines — colored by avg_speed
      map.addSource("traffic", {
        type: "geojson",
        data: trafficGeoJSON ?? { type: "FeatureCollection" as const, features: [] },
      });

      map.addLayer(
        {
          id: "traffic-lines",
          type: "line",
          source: "traffic",
          layout: { "line-join": "round", "line-cap": "round", visibility: "none" },
          paint: {
            "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.5, 14, 4],
            "line-color": [
              "case",
              ["!=", ["get", "avg_traffic"], null],
              [
                "match",
                ["get", "traffic_color"],
                "green",
                "#22c55e",
                "yellow",
                "#f59e0b",
                "red",
                "#ef4444",
                "#22c55e"
              ],
              "#22c55e"
            ],

            "line-opacity": 0.5,
          },
        },
        firstLabelLayer,
      );

      // Route lines + stops
      ROUTES.forEach((route) => {
        map.addSource(`route-${route.id}`, {
          type: "geojson",
          data: routeToGeoJSON(route),
        });

        map.addSource(`stops-${route.id}`, {
          type: "geojson",
          data: stopsToGeoJSON(route),
        });

        map.addLayer({
          id: `route-shadow-${route.id}`,
          type: "line",
          source: `route-${route.id}`,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": route.color,
            "line-width": 10,
            "line-opacity": 0.12,
            "line-blur": 4,
          },
        });

        map.addLayer({
          id: `route-outline-${route.id}`,
          type: "line",
          source: `route-${route.id}`,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": route.color === "#FFCD00" ? "#E3A007" : route.color === "#00A650" ? "#005C2E" : route.color === "#B100CD" ? "#5B006B" : "#ffffff", "line-width": 11, "line-opacity": 0.9 },
        });

        map.addLayer({
          id: `route-line-${route.id}`,
          type: "line",
          source: `route-${route.id}`,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": route.color, "line-width": 7, "line-opacity": 1 },
        });

        map.addLayer({
          id: `stops-ring-${route.id}`,
          type: "circle",
          source: `stops-${route.id}`,
          minzoom: 11,
          paint: {
            "circle-radius": 6,
            "circle-color": route.color,
            "circle-opacity": 0.25,
            "circle-stroke-width": 0,
          },
        });

        map.addLayer({
          id: `stops-selected-${route.id}`,
          type: "circle",
          source: `stops-${route.id}`,
          minzoom: 11,
          filter: ["==", ["get", "name"], "__none__"],
          paint: {
            "circle-radius": 9,
            "circle-color": route.color,
            "circle-opacity": 0.5,
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
          },
        });

        map.addLayer({
          id: `stops-dot-${route.id}`,
          type: "circle",
          source: `stops-${route.id}`,
          minzoom: 11,
          paint: {
            "circle-radius": 3.5,
            "circle-color": "#ffffff",
            "circle-stroke-color": route.color,
            "circle-stroke-width": 2,
          },
        });

        map.on("click", `route-line-${route.id}`, () => { setSelectedRoute(route); setSelectedStop(null); });

        map.on("mouseenter", `route-line-${route.id}`, () => {
          map.getCanvas().style.cursor = "pointer";
          map.setPaintProperty(`route-line-${route.id}`, "line-width", 10);
          setHoveredId(route.id);
        });

        map.on("mouseleave", `route-line-${route.id}`, () => {
          map.getCanvas().style.cursor = "";
          map.setPaintProperty(`route-line-${route.id}`, "line-width", 7);
          setHoveredId(null);
        });

        // Station dot click — toggle selection in select mode, else open sidebar
        map.on("click", `stops-dot-${route.id}`, (e) => {
          if (didDragStopRef.current) { didDragStopRef.current = false; return; }
          const name = e.features?.[0]?.properties?.name as string | undefined;
          if (!name) return;
          e.originalEvent.stopPropagation();
          if (drawModeRef.current === "select") {
            const key = `${name}::${route.id}`;
            const next = new Set(selectedStationsRef.current);
            if (next.has(key)) next.delete(key); else next.add(key);
            selectedStationsRef.current = next;
            setSelectedStations(new Set(next));
            return;
          }
          const { x, y } = e.point;
          setStationPopup({ name, routeId: route.id, x, y, coords: [e.lngLat.lng, e.lngLat.lat] });
          setSelectedRoute(route);
          setSelectedStop(name);
        });

        map.on("mouseenter", `stops-dot-${route.id}`, () => {
          map.getCanvas().style.cursor = "pointer";
        });

        map.on("mouseleave", `stops-dot-${route.id}`, () => {
          map.getCanvas().style.cursor = "";
        });
      });

      // Map-level click: add station to selected line, or close popup
      map.on("click", (e) => {
        const stopLayers = (map.getStyle()?.layers ?? [])
          .filter((l) => l.id.startsWith("stops-dot-"))
          .map((l) => l.id);
        const hitStop = stopLayers.length > 0 && map.queryRenderedFeatures(e.point, { layers: stopLayers }).length > 0;

        if (!hitStop) setStationPopup(null);

        const lineId = addStationToLineRef.current;
        if (lineId && !hitStop) {
          const coords: [number, number] = [e.lngLat.lng, e.lngLat.lat];
          const name = `Stop ${stopCounterRef.current++}`;
          snapshotHistory();
          setRouteExtraStops((prev) => {
            const next = new Map(prev);
            const route = [...ROUTES, ...customLinesRef.current].find((r) => r.id === lineId);
            const baseStops = route?.stops ?? [];
            const extraStops = next.get(lineId) ?? [];
            const allCurrent = [...baseStops, ...extraStops];
            const newStop = { name, coords };
            if (allCurrent.length === 0) {
              next.set(lineId, [newStop]);
            } else {
              const first = allCurrent[0]!;
              const last = allCurrent[allCurrent.length - 1]!;
              const dFirst = haversineKm(coords, first.coords);
              const dLast  = haversineKm(coords, last.coords);
              // Prepend if closer to the first terminus, else append
              next.set(lineId, dFirst < dLast ? [newStop, ...extraStops] : [...extraStops, newStop]);
            }
            return next;
          });
        }
      });

      // Close popup when map moves
      map.on("move", () => setStationPopup(null));

      // Double-click exits add-station mode
      map.on("dblclick", (e) => {
        if (addStationToLineRef.current) {
          e.preventDefault();
          setAddStationToLine(null);
        }
      });

      setMapLoaded(true);
    });

    // Escape cancels an in-progress boundary draw
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" && addStationToLineRef.current) {
        setAddStationToLine(null);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        const popup = stationPopupRef.current;
        if (!popup) return;
        const extraStops = routeExtraStopsRef.current.get(popup.routeId) ?? [];
        const isCustomLine = customLinesRef.current.some((r) => r.id === popup.routeId);
        const isDeletable = isCustomLine || extraStops.some((s) => s.name === popup.name);
        if (!isDeletable) return;
        e.preventDefault();
        handleDeleteStop(popup.name, popup.routeId);
        setStationPopup(null);
        return;
      }
      if (e.key === "Escape" && drawModeRef.current === "boundary") {
        draw.deleteAll();
        draw.changeMode("simple_select");
        setHasBoundary(false);
        setDrawMode("normal");
        drawModeRef.current = "normal";
      } else if (e.key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        const prev = historyRef.current.pop();
        if (prev !== undefined) {
          stopCounterRef.current = prev.counter;
          setRouteExtraStops(prev.stops);
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ── population visibility toggle (heatmap + points)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const vis = showHeatmap ? "visible" : "none";
    if (map.getLayer("population-heatmap")) {
      map.setLayoutProperty("population-heatmap", "visibility", vis);
    }
    if (map.getLayer("population-points")) {
      map.setLayoutProperty("population-points", "visibility", vis);
    }
  }, [showHeatmap, mapLoaded]);

  // ── traffic lines visibility toggle
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    if (map.getLayer("traffic-lines")) {
      map.setLayoutProperty("traffic-lines", "visibility", showTraffic ? "visible" : "none");
    }
  }, [showTraffic, mapLoaded]);

  // ── generated route layer (re-renders when route or stops change)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    for (const id of ["generated-route-glow", "generated-route-outline", "generated-route-line", "generated-stops-dot"]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    for (const id of ["generated-route", "generated-stops"]) {
      if (map.getSource(id)) map.removeSource(id);
    }

    if (!generatedRoute) return;

    const activeStops = generatedRoute.stops.filter((s) => !disabledStops.has(s.name));
    if (activeStops.length < 2) return;

    map.addSource("generated-route", {
      type: "geojson",
      data: {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: activeStops.map((s) => s.coords) },
      } as GeoJSON.Feature<GeoJSON.LineString>,
    });

    map.addSource("generated-stops", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: generatedRoute.stops.map((s) => ({
          type: "Feature",
          properties: { disabled: disabledStops.has(s.name) },
          geometry: { type: "Point", coordinates: s.coords },
        })),
      } as GeoJSON.FeatureCollection<GeoJSON.Point>,
    });

    map.addLayer({
      id: "generated-route-glow",
      type: "line",
      source: "generated-route",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": generatedRoute.color,
        "line-width": 14,
        "line-opacity": 0.18,
        "line-blur": 8,
      },
    });

    map.addLayer({
      id: "generated-route-outline",
      type: "line",
      source: "generated-route",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.9 },
    });

    map.addLayer({
      id: "generated-route-line",
      type: "line",
      source: "generated-route",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": generatedRoute.color,
        "line-width": 5,
        "line-dasharray": [3, 2],
        "line-opacity": 1,
      },
    });

    map.addLayer({
      id: "generated-stops-dot",
      type: "circle",
      source: "generated-stops",
      minzoom: 10,
      paint: {
        "circle-radius": 5,
        "circle-color": ["case", ["==", ["get", "disabled"], true], "#22c55e", "#ffffff"],
        "circle-stroke-color": [
          "case",
          ["==", ["get", "disabled"], true],
          "#9ca3af",
          generatedRoute.color,
        ],
        "circle-stroke-width": 2.5,
        "circle-opacity": ["case", ["==", ["get", "disabled"], true], 0.4, 1],
      },
    });

    map.on("click", "generated-route-line", () => setSelectedRoute(null));

    map.on("mouseenter", "generated-route-line", () => {
      map.getCanvas().style.cursor = "pointer";
      map.setPaintProperty("generated-route-line", "line-width", 8);
    });

    map.on("mouseleave", "generated-route-line", () => {
      map.getCanvas().style.cursor = "";
      map.setPaintProperty("generated-route-line", "line-width", 5);
    });
  }, [generatedRoute, disabledStops, mapLoaded]);

  // consume hoveredId to avoid lint warning
  useEffect(() => {
    void hoveredId;
  }, [hoveredId]);

  // ── update stop sources when extra stops are added
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    routeExtraStops.forEach((extraStops, routeId) => {
      const route = [...ROUTES, ...customLinesRef.current].find((r) => r.id === routeId);
      if (!route) return;
      const allStops = [...route.stops, ...extraStops];
      const stopSrc = map.getSource(`stops-${routeId}`) as mapboxgl.GeoJSONSource | undefined;
      if (stopSrc) stopSrc.setData(stopsToGeoJSON({ ...route, stops: allStops }));
      // Always update the route line geometry to include extra stops
      const lineSrc = map.getSource(`route-${routeId}`) as mapboxgl.GeoJSONSource | undefined;
      if (lineSrc) {
        if (allStops.length >= 2) {
          lineSrc.setData(routeToGeoJSON({ ...route, stops: allStops, shape: undefined }));
        } else if (extraStops.length === 0 && (route.shape || route.stops.length >= 2)) {
          // No extra stops left — restore original geometry
          lineSrc.setData(routeToGeoJSON(route));
        } else {
          // Fewer than 2 stops total, clear the line
          lineSrc.setData({ type: "FeatureCollection", features: [] });
        }
      }
    });
  }, [routeExtraStops, mapLoaded]);

  // ── add map layers for newly created custom lines
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    customLines.forEach((route) => {
      if (map.getSource(`route-${route.id}`)) return; // already added
      map.addSource(`route-${route.id}`, { type: "geojson", data: routeToGeoJSON(route) });
      map.addSource(`stops-${route.id}`, { type: "geojson", data: stopsToGeoJSON(route) });
      map.addLayer({ id: `route-shadow-${route.id}`, type: "line", source: `route-${route.id}`, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": route.color, "line-width": 10, "line-opacity": 0.12, "line-blur": 4 } });
      map.addLayer({ id: `route-outline-${route.id}`, type: "line", source: `route-${route.id}`, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": 11, "line-opacity": 0.9 } });
      map.addLayer({ id: `route-line-${route.id}`, type: "line", source: `route-${route.id}`, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": route.color, "line-width": 7, "line-opacity": 1 } });
      map.addLayer({ id: `stops-ring-${route.id}`, type: "circle", source: `stops-${route.id}`, minzoom: 11, paint: { "circle-radius": 6, "circle-color": route.color, "circle-opacity": 0.25, "circle-stroke-width": 0 } });
      map.addLayer({ id: `stops-selected-${route.id}`, type: "circle", source: `stops-${route.id}`, minzoom: 11, filter: ["==", ["get", "name"], "__none__"], paint: { "circle-radius": 9, "circle-color": route.color, "circle-opacity": 0.5, "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" } });
      map.addLayer({ id: `stops-dot-${route.id}`, type: "circle", source: `stops-${route.id}`, minzoom: 11, paint: { "circle-radius": 3.5, "circle-color": "#ffffff", "circle-stroke-color": route.color, "circle-stroke-width": 2 } });
      map.on("click", `route-line-${route.id}`, () => { setSelectedRoute(route); setSelectedStop(null); });
      map.on("mouseenter", `route-line-${route.id}`, () => { map.getCanvas().style.cursor = "pointer"; map.setPaintProperty(`route-line-${route.id}`, "line-width", 10); });
      map.on("mouseleave", `route-line-${route.id}`, () => { map.getCanvas().style.cursor = ""; map.setPaintProperty(`route-line-${route.id}`, "line-width", 7); });
      map.on("click", `stops-dot-${route.id}`, (e) => {
        if (didDragStopRef.current) { didDragStopRef.current = false; return; }
        const name = e.features?.[0]?.properties?.name as string | undefined;
        if (!name) return;
        e.originalEvent.stopPropagation();
        if (drawModeRef.current === "select") {
          const key = `${name}::${route.id}`;
          const next = new Set(selectedStationsRef.current);
          if (next.has(key)) next.delete(key); else next.add(key);
          selectedStationsRef.current = next;
          setSelectedStations(new Set(next));
          return;
        }
        setStationPopup({ name, routeId: route.id, x: e.point.x, y: e.point.y, coords: [e.lngLat.lng, e.lngLat.lat] });
        setSelectedRoute(route);
        setSelectedStop(name);
      });
      map.on("mouseenter", `stops-dot-${route.id}`, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", `stops-dot-${route.id}`, () => { map.getCanvas().style.cursor = ""; });
    });
  }, [customLines, mapLoaded]);

  // ── drag-to-reposition stops while in edit mode
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || !addStationToLine) return;

    const lineId = addStationToLine;
    const layerId = `stops-dot-${lineId}`;
    if (!map.getLayer(layerId)) return;

    let dragging: { name: string; coords: [number, number] } | null = null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onMouseDown = (e: mapboxgl.MapMouseEvent & { features?: any[] }) => {
      const name = e.features?.[0]?.properties?.name as string | undefined;
      if (!name) return;
      // Only drag stops that belong to extraStops (or all stops on a custom line)
      const extraStops = routeExtraStopsRef.current.get(lineId) ?? [];
      const isCustomLine = customLinesRef.current.some((r) => r.id === lineId);
      if (!isCustomLine && !extraStops.some((s) => s.name === name)) return;
      e.preventDefault();
      dragging = { name, coords: [e.lngLat.lng, e.lngLat.lat] };
      map.dragPan.disable();
      map.getCanvas().style.cursor = "grabbing";
    };

    const onMouseMove = (e: mapboxgl.MapMouseEvent) => {
      if (!dragging) return;
      const newCoords: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      dragging.coords = newCoords;
      // Update map sources directly — no React re-render for smooth dragging
      const route = [...ROUTES, ...customLinesRef.current].find((r) => r.id === lineId);
      if (!route) return;
      const baseStops = route.stops ?? [];
      const extraStops = routeExtraStopsRef.current.get(lineId) ?? [];
      const updatedExtra = extraStops.map((s) => s.name === dragging!.name ? { ...s, coords: newCoords } : s);
      const allStops = [...baseStops, ...updatedExtra];
      const stopSrc = map.getSource(`stops-${lineId}`) as mapboxgl.GeoJSONSource | undefined;
      if (stopSrc) stopSrc.setData(stopsToGeoJSON({ ...route, stops: allStops }));
      const lineSrc = map.getSource(`route-${lineId}`) as mapboxgl.GeoJSONSource | undefined;
      if (lineSrc && allStops.length >= 2) lineSrc.setData(routeToGeoJSON({ ...route, stops: allStops, shape: undefined }));
      map.getCanvas().style.cursor = "grabbing";
    };

    const onMouseUp = () => {
      if (!dragging) return;
      const { name, coords } = dragging;
      dragging = null;
      map.dragPan.enable();
      map.getCanvas().style.cursor = "";
      didDragStopRef.current = true;
      snapshotHistory();
      setRouteExtraStops((prev) => {
        const next = new Map(prev);
        const extraStops = next.get(lineId) ?? [];
        next.set(lineId, extraStops.map((s) => s.name === name ? { ...s, coords } : s));
        return next;
      });
    };

    const onEnter = () => { if (!dragging) map.getCanvas().style.cursor = "grab"; };
    const onLeave = () => { if (!dragging) map.getCanvas().style.cursor = ""; };

    map.on("mousedown", layerId, onMouseDown);
    map.on("mousemove", onMouseMove);
    map.on("mouseup", onMouseUp);
    map.on("mouseenter", layerId, onEnter);
    map.on("mouseleave", layerId, onLeave);

    return () => {
      map.off("mousedown", layerId, onMouseDown);
      map.off("mousemove", onMouseMove);
      map.off("mouseup", onMouseUp);
      map.off("mouseenter", layerId, onEnter);
      map.off("mouseleave", layerId, onLeave);
      map.dragPan.enable();
    };
  }, [addStationToLine, mapLoaded]);

  if (!TOKEN) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-stone-100">
        <p className="text-center">
          <span className="block text-base font-semibold text-red-500">Mapbox token missing</span>
          <span className="mt-1 block text-sm text-stone-500">
            Set{" "}
            <code className="rounded bg-stone-200 px-1 text-stone-700">
              NEXT_PUBLIC_MAPBOX_TOKEN
            </code>{" "}
            in <code className="rounded bg-stone-200 px-1 text-stone-700">.env</code>
          </span>
        </p>
      </div>
    );
  }

  const showGeneratedPanel = !!generatedRoute && !selectedRoute;
  const hasSelection = hasBoundary || selectedNeighbourhoods.size > 0 || selectedStations.size > 0;

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />

      {/* TTC Lines legend + neighbourhood panel — top left */}
      <div className="absolute top-5 left-5 flex flex-col gap-4 pointer-events-auto">
        <div className="rounded-xl border border-[#D7D7D7] bg-white px-5 py-4 shadow-sm w-56">
          <div className="mb-3">
            <p className="text-lg font-bold text-stone-800">Lines</p>
          </div>
          <ul className="space-y-1">
            {[...ROUTES, ...customLines].map((r) => {
              const isActive = addStationToLine === r.id;
              return (
                <li key={r.id} className="group flex items-center gap-2">
                  <button
                    title={isActive ? "Deselect line" : "Select to add stations"}
                    onClick={() => {
                      if (!isActive) {
                        handleSetDrawMode("normal");
                      }
                      setAddStationToLine(isActive ? null : r.id);
                    }}
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded transition-all ${
                      isActive
                        ? "ring-2 ring-offset-1"
                        : "opacity-60 hover:opacity-100"
                    }`}
                    style={isActive ? { outline: `2px solid ${r.color}`, outlineOffset: "2px" } : {}}
                  >
                    <span
                      className="h-2.5 w-5 rounded-full"
                      style={{ background: r.color }}
                    />
                  </button>
                  <button
                    className={`flex-1 truncate text-left text-sm transition-colors ${
                      isActive ? "font-semibold text-stone-900" : "text-stone-600 hover:text-stone-900"
                    }`}
                    onClick={() => setSelectedRoute(r)}
                  >
                    {r.name}
                  </button>
                </li>
              );
            })}
            {generatedRoute && (
              <>
                <li className="border-t border-stone-100 pt-1.5" />
                <li
                  className="flex cursor-pointer items-center gap-2 text-sm text-stone-600 hover:text-stone-900"
                  onClick={() => setSelectedRoute(null)}
                >
                  <span
                    className="h-2.5 w-5 shrink-0 rounded-full border-2"
                    style={{ borderColor: generatedRoute.color, borderStyle: "dashed", background: "transparent" }}
                  />
                  <span className="truncate">{generatedRoute.name}</span>
                </li>
              </>
            )}
          </ul>
          <button
            onClick={() => setShowNewLineModal(true)}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-stone-900 py-2 text-sm font-semibold text-white hover:bg-stone-700 transition-colors"
          >
            <span className="text-base leading-none">+</span>
            New Line
          </button>
        </div>

        {focusedNeighbourhood && (
          <NeighbourhoodPanel
            name={focusedNeighbourhood.name}
            lat={focusedNeighbourhood.lat}
            lng={focusedNeighbourhood.lng}
            geometry={focusedNeighbourhood.geometry}
            popRawData={popRawData}
            trafficFeatures={trafficGeoJSON?.features ?? []}
            onClose={() => setFocusedNeighbourhood(null)}
          />
        )}
      </div>

      {/* Add-station notification — below top-center toolbar */}
      {addStationToLine && (
        <div className="pointer-events-none absolute top-[85px] left-0 right-0 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm text-indigo-700 shadow-sm">
            <span>Click map to add station</span>
            <span className="h-4 w-px bg-indigo-200" />
            <button
              onClick={() => setAddStationToLine(null)}
              className="font-semibold hover:text-indigo-900 transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* Top-center toolbar */}
      <div className="pointer-events-none absolute top-5 left-0 right-0 flex justify-center gap-2">
        {/* Heatmap toggle */}
        <button
          onClick={() => setShowHeatmap((v) => !v)}
          className={`pointer-events-auto flex h-[52px] items-center gap-3 rounded-xl border border-[#D7D7D7] bg-white px-6 text-base font-normal shadow-sm transition-all ${
            showHeatmap ? "text-stone-700" : "text-stone-400"
          }`}
        >
          <span
            className="h-3 w-3 shrink-0 rounded-full"
            style={{ background: showHeatmap ? "#ef4444" : "#d1d5db" }}
          />
          Population Density
        </button>

        {/* Traffic toggle */}
        <button
          onClick={() => setShowTraffic((v) => !v)}
          disabled={trafficLoading}
          className={`pointer-events-auto flex h-[52px] items-center gap-3 rounded-xl border border-[#D7D7D7] bg-white px-6 text-base font-normal shadow-sm transition-all disabled:cursor-wait ${
            showTraffic ? "text-stone-700" : "text-stone-400"
          }`}
        >
          {trafficLoading ? (
            <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-stone-300 border-t-stone-500" />
          ) : (
            <span
              className="h-3 w-3 shrink-0 rounded-full"
              style={{ background: showTraffic ? "#f59e0b" : "#d1d5db" }}
            />
          )}
          Traffic
        </button>

        {/* Draw toolbar — wrapped in relative so the badge can anchor to it */}
        <div className="relative">
        <div className="pointer-events-auto flex h-[52px] items-center gap-1 rounded-xl border border-[#D7D7D7] bg-white px-2 shadow-sm">
          {/* Normal (default/view — no active tool) */}
          <button
            onClick={() => handleSetDrawMode("normal")}
            title="Normal"
            className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
              drawMode === "normal" ? "bg-stone-100 text-stone-900" : "text-stone-400 hover:bg-stone-50 hover:text-stone-700"
            }`}
          >
            {/* Arrow cursor */}
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-[18px] w-[18px]">
              <path d="M4 1.5 L4 17 L8 13 L11 19 L13 18 L10 12 L16 12 Z" />
            </svg>
          </button>

          <div className="mx-1 h-6 w-px bg-stone-200" />

          {/* Select neighbourhoods */}
          <button
            onClick={() => handleSetDrawMode("select")}
            title="Select neighbourhoods"
            className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
              drawMode === "select" ? "bg-indigo-50 text-indigo-600" : "text-stone-400 hover:bg-stone-50 hover:text-stone-700"
            }`}
          >
            {/* Cursor + dashed selection box — indicates click-to-select-region */}
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-[18px] w-[18px]">
              <path d="M2.5 1.5 L2.5 12.5 L5.5 9.5 L7.5 14 L9 13.3 L7 8.8 L11 8.8 Z" />
              <rect x="11.5" y="11" width="7" height="7" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 1.2" />
            </svg>
          </button>

          <div className="mx-1 h-6 w-px bg-stone-200" />

          {/* Polygon boundary */}
          <button
            onClick={() => handleSetDrawMode("boundary")}
            title="Draw boundary"
            className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
              drawMode === "boundary" ? "bg-indigo-50 text-indigo-600" : "text-stone-400 hover:bg-stone-50 hover:text-stone-700"
            }`}
          >
            {/* Dashed polygon with vertex dots */}
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" className="h-4 w-4">
              <polygon points="10,2 17,6.5 14.5,16 5.5,16 3,6.5" strokeWidth="1.6" strokeLinejoin="round" strokeDasharray="2.5 1.5" />
              <circle cx="10" cy="2" r="1.4" fill="currentColor" stroke="none" />
              <circle cx="17" cy="6.5" r="1.4" fill="currentColor" stroke="none" />
              <circle cx="14.5" cy="16" r="1.4" fill="currentColor" stroke="none" />
              <circle cx="5.5" cy="16" r="1.4" fill="currentColor" stroke="none" />
              <circle cx="3" cy="6.5" r="1.4" fill="currentColor" stroke="none" />
            </svg>
          </button>

          {/* Clear button — visible when there's a drawn boundary or selected neighbourhoods */}
          {hasSelection && (
            <>
              <div className="mx-1 h-6 w-px bg-stone-200" />
              <button
                onClick={handleClearAll}
                title="Clear selection"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-stone-400 transition-all hover:bg-red-50 hover:text-red-500"
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                  <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193v-.443A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z" clipRule="evenodd" />
                </svg>
              </button>
            </>
          )}
        </div>

        {/* Drawing hint — shown while actively drawing a polygon */}
        {drawMode === "boundary" && (
          <div className="pointer-events-auto absolute top-0 left-full ml-2 flex h-[52px] items-center gap-3 whitespace-nowrap rounded-xl border border-stone-200 bg-white px-4 text-sm text-stone-500 shadow-sm">
            <span>Double-click to finish</span>
            <span className="h-4 w-px bg-stone-200" />
            <button
              onClick={() => handleSetDrawMode("normal")}
              className="font-medium text-stone-700 hover:text-red-500 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Selection badge — absolutely anchored to the right of the toolbar, doesn't shift layout */}
        {(selectedNeighbourhoods.size > 0 || selectedStations.size > 0) && (
          <div className="pointer-events-auto absolute top-0 left-full ml-2 flex h-[52px] items-center whitespace-nowrap rounded-xl border border-indigo-200 bg-indigo-50 px-4 text-sm font-medium text-indigo-700 shadow-sm">
            SELECTED: {selectedNeighbourhoods.size} neighbourhood{selectedNeighbourhoods.size !== 1 ? "s" : ""}, {selectedStations.size} stop{selectedStations.size !== 1 ? "s" : ""}
          </div>
        )}
        </div>
      </div>

      {/* Side panel — only one shown at a time to prevent overlap */}
      <div
        className={`pointer-events-none absolute right-9 bottom-10 flex items-stretch transition-all duration-300 ease-in-out ${hasSelection ? "top-20" : "top-10"} ${
          selectedRoute || showGeneratedPanel ? "translate-x-0" : "translate-x-[calc(100%+2.25rem)]"
        }`}
      >
        {selectedRoute ? (
          <RoutePanel
            route={selectedRoute}
            selectedStop={selectedStop}
            stationPopulations={stationPopulations}
            extraStops={routeExtraStops.get(selectedRoute.id) ?? []}
            isCustomLine={customLines.some((r) => r.id === selectedRoute.id)}
            onDeleteStop={(name) => handleDeleteStop(name, selectedRoute.id)}
            onDeleteLine={() => handleDeleteCustomLine(selectedRoute.id)}
            onClose={() => { setSelectedRoute(null); setSelectedStop(null); }}
          />
        ) : showGeneratedPanel ? (
          <GeneratedRoutePanel
            route={generatedRoute}
            disabledStops={disabledStops}
            isGenerating={isGenerating}
            onToggleStop={handleToggleStop}
            onClose={() => setGeneratedRoute(null)}
            onRegenerate={handleGenerate}
          />
        ) : null}
      </div>

      {/* Custom map controls — bottom right */}
      <div className="pointer-events-none absolute right-[10px] bottom-[30px] flex flex-col gap-1">
        {/* Bird's eye toggle */}
        <button
          onClick={() => {
            const map = mapRef.current;
            if (!map) return;
            const next = !isBirdsEye;
            setIsBirdsEye(next);
            map.easeTo({ pitch: next ? 0 : 40, bearing: next ? 0 : -10, duration: 600 });
          }}
          title="Bird's eye view"
          className={`pointer-events-auto flex h-[38px] w-[38px] items-center justify-center rounded-md shadow transition-all ${
            isBirdsEye ? "bg-stone-800 text-white" : "bg-white text-stone-600 hover:bg-stone-50"
          }`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
        {/* Zoom controls */}
        <div className="pointer-events-auto flex flex-col overflow-hidden rounded-md shadow">
          <button
            onClick={() => mapRef.current?.zoomIn()}
            title="Zoom in"
            className="flex h-[38px] w-[38px] items-center justify-center bg-white text-stone-600 text-lg font-light hover:bg-stone-50 border-b border-stone-200"
          >+</button>
          <button
            onClick={() => mapRef.current?.zoomOut()}
            title="Zoom out"
            className="flex h-[38px] w-[38px] items-center justify-center bg-white text-stone-600 text-lg font-light hover:bg-stone-50"
          >−</button>
        </div>
      </div>

      {/* Generate Route — bottom centre, only visible when an area is selected */}
      {hasSelection && (
        <div className="pointer-events-none absolute bottom-16 left-0 right-0 flex justify-center">
          <button
            onClick={handleGenerate}
            disabled={isGenerating}
            className="pointer-events-auto flex h-[52px] items-center gap-3 rounded-xl bg-stone-900 px-8 text-base font-medium text-white shadow-lg transition-all hover:bg-stone-800 disabled:opacity-50"
          >
            <span className={`text-xl ${isGenerating ? "inline-block animate-spin" : ""}`}>✦</span>
            {isGenerating ? "Generating…" : "Generate Route"}
          </button>
        </div>
      )}

      {/* Station popup */}
      {stationPopup && (
        <StationPopup
          popup={stationPopup}
          allRoutes={[...ROUTES, ...customLines]}
          isDeletable={
            customLines.some((r) => r.id === stationPopup.routeId) ||
            (routeExtraStops.get(stationPopup.routeId) ?? []).some((s) => s.name === stationPopup.name)
          }
          connectedRoutes={
            [...ROUTES, ...customLines].filter((r) =>
              r.id !== stationPopup.routeId &&
              (routeExtraStops.get(r.id) ?? []).some((s) => s.name === stationPopup.name)
            )
          }
          onRemoveTransfer={(targetRouteId) => {
            handleDeleteStop(stationPopup.name, targetRouteId);
          }}
          onClose={() => setStationPopup(null)}
          onDelete={() => { handleDeleteStop(stationPopup.name, stationPopup.routeId); setStationPopup(null); }}
          onAddTransfer={(targetRouteId) => {
            const { name, coords } = stationPopup;
            // Add this station to the target line's extra stops (terminus-aware)
            snapshotHistory();
            setRouteExtraStops((prev) => {
              const next = new Map(prev);
              const route = [...ROUTES, ...customLinesRef.current].find((r) => r.id === targetRouteId);
              const baseStops = route?.stops ?? [];
              const extraStops = next.get(targetRouteId) ?? [];
              // Skip if already present
              const alreadyExists = [...baseStops, ...extraStops].some((s) => s.name === name);
              if (alreadyExists) return prev;
              const allCurrent = [...baseStops, ...extraStops];
              const newStop = { name, coords };
              if (allCurrent.length === 0) {
                next.set(targetRouteId, [newStop]);
              } else {
                const first = allCurrent[0]!;
                const last = allCurrent[allCurrent.length - 1]!;
                const dFirst = haversineKm(coords, first.coords);
                const dLast  = haversineKm(coords, last.coords);
                next.set(targetRouteId, dFirst < dLast ? [newStop, ...extraStops] : [...extraStops, newStop]);
              }
              return next;
            });
            setStationPopup(null);
          }}
        />
      )}

      {/* New line modal */}
      {showNewLineModal && (
        <NewLineModal
          onClose={() => setShowNewLineModal(false)}
          onConfirm={(name, color, type) => {
            const id = `custom-${customLineCounterRef.current++}`;
            const shortName = name.slice(0, 2).toUpperCase();
            const newRoute: Route = {
              id,
              name,
              shortName,
              color,
              textColor: "#ffffff",
              type,
              description: "Custom line",
              frequency: "—",
              stops: [],
            };
            setCustomLines((prev) => [...prev, newRoute]);
            handleSetDrawMode("normal");
            setAddStationToLine(id);
            setShowNewLineModal(false);
          }}
        />
      )}
    </div>
  );
}
