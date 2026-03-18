"use client";

import MapboxDraw from "@mapbox/mapbox-gl-draw";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";
import mapboxgl from "mapbox-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { haversineKm, computeStationPopulations, type PopRow } from "~/app/map/geo-utils";
import {
  ROUTES,
  BUS_ROUTES,
  type GeneratedRoute,
  type Route,
} from "~/app/map/mock-data";
import { routeToGeoJSON, stopsToGeoJSON, geomBBox, portalsToGeoJSON, undergroundToGeoJSON, snapToShape } from "./map/geo";
import { NeighbourhoodPanel } from "./map/NeighbourhoodPanel";
import { RoutePanel } from "./map/RoutePanel";
import { GeneratedRoutePanel } from "./map/GeneratedRoutePanel";
import { StationPopup } from "./map/StationPopup";
import { NewLineModal } from "./map/NewLineModal";
import { ChatPanel, type ParsedRoute, type ToolCallEvent } from "./ChatPanel";
import { UserButton } from "./UserButton";

type DrawMode = "normal" | "select" | "boundary";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";
const TORONTO: [number, number] = [-79.3832, 43.6532];

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Returns a darker border colour for a route's outline layer.
 *  Known route colours use exact hardcoded values; anything else
 *  gets a computed darkening based on perceptual luma. */
function darkenColor(hex: string): string {
  // Exact matches for the built-in lines
  const known: Record<string, string> = {
    "#FFCD00": "#E3A007", // Line 1 – yellow → amber
    "#00A650": "#005C2E", // Line 2 – green  → forest green
    "#B100CD": "#5B006B", // Line 3 – purple → deep purple
  };
  const match = known[hex.toUpperCase()];
  if (match) return match;

  // Fallback: compute a perceptually-weighted lightness reduction
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  // High-luma colours darken less; low-luma colours darken more
  // (calibrated so the three known pairs map almost exactly)
  const factor = 0.51 + 1.05 * Math.pow(luma, 3.6);

  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (delta > 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    if (max === rn)      h = (((gn - bn) / delta) % 6 + 6) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else                 h = (rn - gn) / delta + 4;
    h *= 60;
  }
  const newL = l * factor;
  const c = (1 - Math.abs(2 * newL - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = newL - c / 2;
  let r2 = 0, g2 = 0, b2 = 0;
  if      (h < 60)  { r2 = c; g2 = x; }
  else if (h < 120) { r2 = x; g2 = c; }
  else if (h < 180) {          g2 = c; b2 = x; }
  else if (h < 240) {          g2 = x; b2 = c; }
  else if (h < 300) { r2 = x;          b2 = c; }
  else              { r2 = c;          b2 = x; }
  const toHex = (v: number) =>
    Math.round(Math.max(0, Math.min(255, (v + m) * 255))).toString(16).padStart(2, "0");
  return `#${toHex(r2)}${toHex(g2)}${toHex(b2)}`;
}

// ─── main map component ──────────────────────────────────────────────────────

export function TransitMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const drawRef = useRef<MapboxDraw | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<Route | null>(null);
  const [selectedStop, setSelectedStop] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedRoute, setGeneratedRoute] = useState<GeneratedRoute | null>(null);
  const [selectedGeneratedStop, setSelectedGeneratedStop] = useState<string | null>(null);
  const [disabledStops, setDisabledStops] = useState<Set<string>>(new Set());
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [isBirdsEye, setIsBirdsEye] = useState(false);
  const [showTraffic, setShowTraffic] = useState(false);
  const [trafficLoading, setTrafficLoading] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [populationGeoJSON, setPopulationGeoJSON] = useState<GeoJSON.FeatureCollection | null>(null);
  const [trafficGeoJSON, setTrafficGeoJSON] = useState<GeoJSON.FeatureCollection | null>(null);
  const [popRawData, setPopRawData] = useState<PopRow[]>([]);
  const [drawMode, setDrawMode] = useState<DrawMode>("normal");
  const [councilOpen, setCouncilOpen] = useState(false);
  const [councilHasRun, setCouncilHasRun] = useState(false);
  const [councilStartNew, setCouncilStartNew] = useState(false);
  const [councilPreview, setCouncilPreview] = useState<Array<{ color: string; stops: { name: string; coords: [number, number] }[] }> | null>(null);

  // ── line-editor state (declared before stationPopulations useMemo)
  const [addStationToLine, setAddStationToLine] = useState<string | null>(null);
  const [addPortalToLine, setAddPortalToLine] = useState<string | null>(null);
  const [routes, setRoutes] = useState<Route[]>(() => [
    ...ROUTES.filter((r) => r.type === "streetcar"),
    ...ROUTES.filter((r) => r.type !== "bus" && r.type !== "streetcar"),
  ]);
  const [importError, setImportError] = useState<string | null>(null);
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [showIEDropdown, setShowIEDropdown] = useState(false);
  const ieDropdownRef = useRef<HTMLDivElement>(null);
  const [validationResult, setValidationResult] = useState<{
    result: import("~/lib/gtfs-validate").ValidationResult;
    context: "export" | "import";
  } | null>(null);

  // Voronoi: assign each population point to its nearest station
  // Cutoff: 5 km for subway/LRT, 1 km for streetcar/bus
  const stationPopulations = useMemo(() => {
    if (popRawData.length === 0) return new Map<string, number>();
    const allStops: { name: string; coords: [number, number]; maxKm: number }[] = [];
    const seen = new Set<string>();
    const cutoff = (type: Route["type"]) => (type === "streetcar" || type === "bus" ? 1 : 5);
    const addStop = (stop: { name: string; coords: [number, number] }, type: Route["type"]) => {
      const key = `${stop.name}@${stop.coords[0]},${stop.coords[1]}`;
      if (!seen.has(key)) { seen.add(key); allStops.push({ ...stop, maxKm: cutoff(type) }); }
    };
    for (const route of routes) for (const stop of route.stops) addStop(stop, route.type);
    return computeStationPopulations(popRawData, allStops);
  }, [popRawData, routes]);

  const [hasBoundary, setHasBoundary] = useState(false);
  const [selectedNeighbourhoods, setSelectedNeighbourhoods] = useState<Set<string>>(new Set());
  const [selectedStations, setSelectedStations] = useState<Set<string>>(new Set()); // "name::routeId"
  const [focusedNeighbourhood, setFocusedNeighbourhood] = useState<{ id: string; name: string; lat: number; lng: number; geometry: GeoJSON.Geometry | null } | null>(null);
  const [stationPopup, setStationPopup] = useState<{ name: string; routeId: string; x: number; y: number; coords: [number, number] } | null>(null);
  const [showNewLineModal, setShowNewLineModal] = useState(false);
  const [snapProgress, setSnapProgress] = useState<{ routeId: string; pct: number } | null>(null);
  const snapDebounceRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const shimmerAnimRef = useRef(new Map<string, number>());
  const startShimmerRef = useRef<(routeId: string) => void>(() => {});
  const stopCounterRef = useRef(1);
  const customLineCounterRef = useRef(1);
  const historyRef = useRef<{ routes: Route[]; counter: number }[]>([]);
  const redoStackRef = useRef<{ routes: Route[]; counter: number }[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // ── Lines panel: collapsible sections + per-route visibility + timetable expand
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({ bus: true });
  const [hiddenRoutes, setHiddenRoutes] = useState<Set<string>>(
    new Set(BUS_ROUTES.map((r) => r.id)),
  );


  // Tracks the previous hiddenRoutes snapshot so the visibility effect only
  // calls setLayoutProperty for routes whose state actually changed.
  const prevHiddenRef = useRef<Set<string>>(new Set(BUS_ROUTES.map((r) => r.id)));

  // Refs for use inside map event callbacks (avoid stale closure)
  const drawModeRef = useRef<DrawMode>("normal");
  const selectedNeighbourhoodsRef = useRef<Set<string>>(new Set());
  const selectedStationsRef = useRef<Set<string>>(new Set());
  const addStationToLineRef = useRef<string | null>(null);
  const addPortalToLineRef = useRef<string | null>(null);
  const triggerAutoSnapRef = useRef<(routeId: string) => void>(() => {});
  const routesRef = useRef<Route[]>([]);
  // Precomputed stop-dot layer IDs for click-hit-testing — avoids scanning
  // getStyle().layers (1000+ entries) on every map click. Updated when custom
  // lines are added/removed.
  const stopDotLayerIdsRef = useRef<string[]>(["bus-stops-dot"]);
  // Blocks neighbourhood clicks for one tick after a polygon is completed,
  // preventing the closing double-click from immediately selecting a neighbourhood.
  const justCompletedBoundaryRef = useRef(false);
  // Cache for the full neighbourhood GeoJSON (needed for geometry lookups on click)
  const neighbourhoodsGeoJSONRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const didDragStopRef = useRef(false); // suppresses click after a drag
  const stationPopupRef = useRef<typeof stationPopup>(null);
  const shimmerRafRef = useRef<number | null>(null);
  const toolAnimRafsRef = useRef<Map<string, number>>(new Map());
  const toolAnimTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const toolAnimFeaturesRef = useRef<GeoJSON.Feature[]>([]);
  // Direct callback ref — called synchronously on each SSE event, bypassing React batching
  const onToolCallRef = useRef<(evt: ToolCallEvent) => void>(() => { /* set below */ });
  const councilHasRunRef = useRef(false);

  useEffect(() => {
    councilHasRunRef.current = councilHasRun;
  }, [councilHasRun]);

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
    routesRef.current.forEach((route) => {
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
    addPortalToLineRef.current = addPortalToLine;
  }, [addPortalToLine]);

  useEffect(() => {
    routesRef.current = routes;
    stopDotLayerIdsRef.current = [
      "bus-stops-dot",
      ...routes.map((r) => `stops-dot-${r.id}`),
    ];
    // Update map sources for any routes whose stops changed
    const map = mapRef.current;
    if (map) {
      for (const route of routes) {
        if (map.getSource(`route-${route.id}`)) {
          const allStops = route.stops;
          (map.getSource(`route-${route.id}`) as mapboxgl.GeoJSONSource).setData(
            allStops.length >= 2 ? routeToGeoJSON(route) : { type: "FeatureCollection", features: [] }
          );
          (map.getSource(`stops-${route.id}`) as mapboxgl.GeoJSONSource).setData(stopsToGeoJSON({ ...route, stops: allStops }));
          if (map.getSource(`portals-${route.id}`)) {
            (map.getSource(`portals-${route.id}`) as mapboxgl.GeoJSONSource).setData(portalsToGeoJSON(route));
          }
          if (map.getSource(`underground-${route.id}`)) {
            (map.getSource(`underground-${route.id}`) as mapboxgl.GeoJSONSource).setData(undergroundToGeoJSON(route));
          }
        }
      }
    }
  }, [routes]);

  useEffect(() => {
    stationPopupRef.current = stationPopup;
  }, [stationPopup]);

  // ── Unsaved-changes guard ─────────────────────────────────────────────────
  const DEFAULT_ROUTE_IDS = new Set(ROUTES.map((r) => r.id));
  const hasUnsaved = routes.some((r) => !DEFAULT_ROUTE_IDS.has(r.id));

  // Native browser dialog on tab close / refresh
  useEffect(() => {
    if (!hasUnsaved) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsaved]);

  // Close the I/E dropdown when clicking outside it
  useEffect(() => {
    if (!showIEDropdown) return;
    function onOutsideClick(e: MouseEvent) {
      if (ieDropdownRef.current && !ieDropdownRef.current.contains(e.target as Node)) {
        setShowIEDropdown(false);
      }
    }
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [showIEDropdown]);

  async function handleGenerateRoute() {
    if (isGenerating) return;
    setIsGenerating(true);
    setGeneratedRoute(null);
    setDisabledStops(new Set());

    const stops: { name: string; coords: [number, number] }[] = [];

    // One stop per selected neighbourhood at its bbox centroid
    const geoJSON = neighbourhoodsGeoJSONRef.current;
    if (geoJSON) {
      for (const id of selectedNeighbourhoodsRef.current) {
        const feat = geoJSON.features.find((f) => f.properties?.AREA_SHORT_CODE === id);
        if (!feat?.geometry) continue;
        const [minX, minY, maxX, maxY] = geomBBox(feat.geometry);
        const name = (feat.properties?.AREA_NAME as string | undefined) ?? id;
        stops.push({ name, coords: [(minX + maxX) / 2, (minY + maxY) / 2] });
      }
    }

    // One stop per selected station (use existing coords)
    for (const key of selectedStationsRef.current) {
      const [stationName, routeId] = key.split("::");
      if (!stationName || !routeId) continue;
      const route = routesRef.current.find((r) => r.id === routeId);
      const found = route?.stops.find((s) => s.name === stationName);
      if (found) stops.push({ name: found.name, coords: found.coords });
    }

    // If a boundary was drawn, add its centroid as a waypoint stop
    const draw = drawRef.current;
    if (draw && hasBoundary) {
      const features = draw.getAll().features;
      const poly = features[0];
      if (poly?.geometry) {
        const [minX, minY, maxX, maxY] = geomBBox(poly.geometry as GeoJSON.Geometry);
        stops.push({ name: "Selected Area", coords: [(minX + maxX) / 2, (minY + maxY) / 2] });
      }
    }

    if (stops.length < 2) { setIsGenerating(false); return; }

    // Order west → east by longitude so the line flows sensibly
    stops.sort((a, b) => a.coords[0] - b.coords[0]);

    // Population within 2 km of each generated stop (from loaded census data)
    const stopPopulations = stops.map((stop) => ({
      name: stop.name,
      pop: popRawData.reduce((sum, row) =>
        haversineKm(stop.coords, [row.longitude, row.latitude]) <= 2 ? sum + row.population : sum, 0),
    }));

    // Total route length in km
    const routeLengthKm = stops.slice(1).reduce(
      (sum, s, i) => sum + haversineKm(stops[i]!.coords, s.coords), 0
    );

    // Neighbourhood names for context
    const neighbourhoodNames = [...selectedNeighbourhoodsRef.current].map((id) => {
      const feat = neighbourhoodsGeoJSONRef.current?.features.find(
        (f) => f.properties?.AREA_SHORT_CODE === id
      );
      return (feat?.properties?.AREA_NAME as string | undefined) ?? id;
    });

    const stopList = stops.map((s) => s.name).join(" → ");
    const popLines = stopPopulations
      .map((s) => `  - ${s.name}: ~${(Math.round(s.pop / 100) * 100).toLocaleString()} residents`)
      .join("\n");

    const message = [
      `Analyze this proposed Toronto subway route and produce realistic planning estimates.`,
      `Route: ${stopList}`,
      `Total length: ${routeLengthKm.toFixed(1)} km | Stations: ${stops.length}`,
      neighbourhoodNames.length > 0 ? `Neighbourhoods served: ${neighbourhoodNames.join(", ")}` : null,
      `Population within 2 km of each stop:\n${popLines}`,
      `\nReturn ONLY this JSON (no markdown, no extra text):\n{"description":"<2 sentences about route purpose>","cost":"<e.g. $2.1B>","timeline":"<e.g. 8 years>","costedTimeline":"<e.g. 2034>","minutesSaved":<number>,"dollarsSaved":"<e.g. $4.2M/yr>","percentageChance":<0-100>,"prNightmareScore":<0-10>}`,
    ].filter(Boolean).join("\n");

    // Defaults in case Backboard call fails
    let description = `Connects ${stopList}`;
    let stats: GeneratedRoute["stats"] = {
      cost: "$1.8B", timeline: "7 years", costedTimeline: "2033",
      minutesSaved: 12, dollarsSaved: "$3.1M/yr", percentageChance: 72, prNightmareScore: 4,
    };

    try {
      const res = await fetch("/api/backboard/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          systemPrompt: "You are a Toronto transit planning analyst. Respond with ONLY valid JSON, no markdown, no extra text.",
          maxTokens: 500,
        }),
      });
      if (res.ok) {
        const data = await res.json() as { response: string };
        const raw = data.response.trim().replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim();
        const ai = JSON.parse(raw) as Partial<GeneratedRoute["stats"] & { description: string }>;
        if (ai.description) description = ai.description;
        stats = {
          cost:             ai.cost             ?? stats.cost,
          timeline:         ai.timeline         ?? stats.timeline,
          costedTimeline:   ai.costedTimeline   ?? stats.costedTimeline,
          minutesSaved:     ai.minutesSaved      ?? stats.minutesSaved,
          dollarsSaved:     ai.dollarsSaved      ?? stats.dollarsSaved,
          percentageChance: ai.percentageChance  ?? stats.percentageChance,
          prNightmareScore: ai.prNightmareScore  ?? stats.prNightmareScore,
        };
      }
    } catch { /* fall back to defaults */ }

    setGeneratedRoute({
      id: `generated-${Date.now()}`,
      name: "Optimized Route",
      shortName: "OPT",
      color: "#e63946",
      textColor: "#ffffff",
      type: "subway",
      description,
      frequency: "Every 5 min",
      servicePattern: { headwayMinutes: 5, startHour: 6, endHour: 23, days: ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] },
      stops,
      stats,
    });
    setIsGenerating(false);
    handleClearAll();
  }

  function distToSegmentKm(p: [number, number], a: [number, number], b: [number, number]): number {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return haversineKm(p, a);
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    return haversineKm(p, [a[0] + t * dx, a[1] + t * dy] as [number, number]);
  }

  function bestInsertIndex(coords: [number, number], stops: { name: string; coords: [number, number] }[]): number {
    if (stops.length === 0) return 0;
    if (stops.length === 1) return 1; // just append for a single existing stop
    // Default: append after last
    let bestIdx = stops.length;
    let bestDist = haversineKm(coords, stops[stops.length - 1]!.coords);
    // Prepend before first
    const dFirst = haversineKm(coords, stops[0]!.coords);
    if (dFirst < bestDist) { bestDist = dFirst; bestIdx = 0; }
    // Insert between segments
    for (let i = 0; i < stops.length - 1; i++) {
      const d = distToSegmentKm(coords, stops[i]!.coords, stops[i + 1]!.coords);
      if (d < bestDist) { bestDist = d; bestIdx = i + 1; }
    }
    return bestIdx;
  }

  async function reverseGeocodeStation(lng: number, lat: number): Promise<string | null> {
    if (!TOKEN) return null;
    try {
      const resp = await fetch(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?types=address,poi&limit=1&language=en&access_token=${TOKEN}`
      );
      if (!resp.ok) return null;
      const data = await resp.json() as { features: Array<{ text: string; place_name: string }> };
      const feature = data.features[0];
      if (!feature) return null;
      const street = (feature.place_name.split(",")[0] ?? feature.text).trim().replace(/^\d+\s+/, "");
      return street || null;
    } catch { return null; }
  }

  function captureCurrentState() {
    return {
      routes: [...routesRef.current],
      counter: stopCounterRef.current,
    };
  }

  function applyHistoryState(state: { routes: Route[]; counter: number }) {
    stopCounterRef.current = state.counter;
    routesRef.current = state.routes;
    setRoutes(state.routes);
  }

  function handleUndo() {
    const prev = historyRef.current.pop();
    if (prev === undefined) return;
    redoStackRef.current.push(captureCurrentState());
    applyHistoryState(prev);
    setCanUndo(historyRef.current.length > 0);
    setCanRedo(true);
  }

  function handleRedo() {
    const next = redoStackRef.current.pop();
    if (next === undefined) return;
    historyRef.current.push(captureCurrentState());
    applyHistoryState(next);
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);
  }

  function snapshotHistory() {
    historyRef.current.push({
      routes: [...routesRef.current],
      counter: stopCounterRef.current,
    });
    redoStackRef.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }


  function handleGenerate() {
    setCouncilStartNew(true);
    setCouncilHasRun(true);
    setCouncilOpen(true);
  }

  function handleViewCouncil() {
    setCouncilStartNew(false);
    setCouncilOpen(true);
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
      if (map && mapLoaded) {
        selectedNeighbourhoodsRef.current.forEach((id) => {
          map.setFeatureState({ source: "neighbourhoods", id }, { selected: false });
        });
      }
      setSelectedNeighbourhoods(new Set());
      selectedNeighbourhoodsRef.current = new Set();
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

  async function handleSnapToRoads(route: Route) {
    const { snapToRoads } = await import("~/lib/road-snap");
    const shape = await snapToRoads(route.stops, TOKEN);
    setRoutes((prev) =>
      prev.map((r) => r.id === route.id ? { ...r, shape } : r),
    );
  }

  function startShimmer(routeId: string) {
    const existing = shimmerAnimRef.current.get(routeId);
    if (existing !== undefined) cancelAnimationFrame(existing);
    const map = mapRef.current;
    if (!map?.getLayer(`route-line-${routeId}`)) return;
    const loop = (now: number) => {
      const opacity = 0.2 + 0.5 * ((Math.sin((now / 700) * Math.PI * 2) + 1) / 2);
      if (map.getLayer(`route-line-${routeId}`)) {
        map.setPaintProperty(`route-line-${routeId}`, "line-opacity", opacity);
      }
      shimmerAnimRef.current.set(routeId, requestAnimationFrame(loop));
    };
    shimmerAnimRef.current.set(routeId, requestAnimationFrame(loop));
  }

  function stopShimmer(routeId: string) {
    const raf = shimmerAnimRef.current.get(routeId);
    if (raf !== undefined) { cancelAnimationFrame(raf); shimmerAnimRef.current.delete(routeId); }
    const map = mapRef.current;
    const route = routesRef.current.find((r) => r.id === routeId);
    if (!map || !route || !map.getLayer(`route-line-${routeId}`)) return;
    const bus = route.type === "bus", sc = route.type === "streetcar";
    map.setPaintProperty(`route-line-${routeId}`, "line-opacity", bus ? 0.7 : sc ? 0.85 : 1);
  }

  startShimmerRef.current = startShimmer;

  function triggerAutoSnap(routeId: string) {
    const existing = snapDebounceRef.current.get(routeId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      snapDebounceRef.current.delete(routeId);
      const route = routesRef.current.find((r) => r.id === routeId);
      if (!route || (route.type !== "bus" && route.type !== "streetcar") || route.stops.length < 2) {
        stopShimmer(routeId);
        return;
      }
      // Snapshot the stop positions at snap-start time; discard result if stops changed
      const stopsKey = route.stops.map((s) => s.coords.join(",")).join("|");
      setSnapProgress({ routeId, pct: 5 });
      const progressTimer = setTimeout(
        () => setSnapProgress((p) => p?.routeId === routeId ? { routeId, pct: 75 } : p),
        150,
      );
      void (async () => {
        try {
          const { snapToRoads } = await import("~/lib/road-snap");
          const shape = await snapToRoads(route.stops, TOKEN, (pct) => {
            if (pct === 100) return; // handled below
            setSnapProgress((p) => p?.routeId === routeId ? { routeId, pct: Math.max(pct, 5) } : p);
          });
          clearTimeout(progressTimer);
          // Check against routesRef (current stops) before applying — discard stale snaps
          const currentKey = routesRef.current.find((r) => r.id === routeId)?.stops.map((s) => s.coords.join(",")).join("|");
          const isStale = currentKey !== stopsKey;
          if (!isStale) {
            setSnapProgress({ routeId, pct: 100 });
            // isFirstSnap = route had no shape before → winding animation
            // isFirstSnap = false → re-snap, old shape was visible → instant update
            const isFirstSnap = !route.shape;
            stopShimmer(routeId);
            const map = mapRef.current;
            const lineSrc = map?.getSource(`route-${routeId}`) as mapboxgl.GeoJSONSource | undefined;
            if (isFirstSnap && lineSrc) {
              const finalGeoJSON = routeToGeoJSON({ ...route, shape });
              const allCoords = finalGeoJSON.geometry.coordinates as [number, number][];
              const duration = Math.min(700, Math.max(300, allCoords.length * 2));
              const startTime = performance.now();
              const animateWind = (now: number) => {
                const progress = Math.min((now - startTime) / duration, 1);
                const eased = 1 - Math.pow(1 - progress, 2);
                const showCount = Math.max(2, Math.round(eased * allCoords.length));
                lineSrc.setData({
                  type: "Feature",
                  properties: { id: routeId },
                  geometry: { type: "LineString", coordinates: allCoords.slice(0, showCount) },
                });
                if (progress < 1) {
                  requestAnimationFrame(animateWind);
                } else {
                  setRoutes((prev) => prev.map((r) => r.id === routeId ? { ...r, shape } : r));
                  setTimeout(() => setSnapProgress((p) => p?.routeId === routeId ? null : p), 600);
                }
              };
              requestAnimationFrame(animateWind);
            } else {
              // Re-snap: old shape was visible, just swap in the new one
              setRoutes((prev) => prev.map((r) => r.id === routeId ? { ...r, shape } : r));
              setTimeout(() => setSnapProgress((p) => p?.routeId === routeId ? null : p), 600);
            }
          }
          // stale: stopShimmer not called here — the pending new snap will handle it
        } catch {
          clearTimeout(progressTimer);
          stopShimmer(routeId);
          setSnapProgress((p) => p?.routeId === routeId ? null : p);
          // Snap failed — restore the fallback line directly so it doesn't stay blank
          const map = mapRef.current;
          const src = map?.getSource(`route-${routeId}`) as mapboxgl.GeoJSONSource | undefined;
          if (src) {
            const failedRoute = routesRef.current.find((r) => r.id === routeId);
            src.setData(failedRoute && failedRoute.stops.length >= 2
              ? routeToGeoJSON(failedRoute)
              : { type: "FeatureCollection", features: [] });
          }
        }
      })();
    }, 500);
    snapDebounceRef.current.set(routeId, timer);
  }
  triggerAutoSnapRef.current = triggerAutoSnap;

  function handleDeleteCustomLine(routeId: string) {
    snapshotHistory();
    const map = mapRef.current;
    if (map) {
      [`route-shadow-${routeId}`, `route-outline-${routeId}`, `route-line-${routeId}`, `stops-ring-${routeId}`, `stops-selected-${routeId}`, `stops-dot-${routeId}`, `underground-line-${routeId}`, `portals-dot-${routeId}`].forEach((id) => {
        if (map.getLayer(id)) map.removeLayer(id);
      });
      [`route-${routeId}`, `stops-${routeId}`, `underground-${routeId}`, `portals-${routeId}`].forEach((id) => {
        if (map.getSource(id)) map.removeSource(id);
      });
    }
    setRoutes((prev) => prev.filter((r) => r.id !== routeId));
    if (addStationToLine === routeId) setAddStationToLine(null);
    if (addPortalToLine === routeId) setAddPortalToLine(null);
    setSelectedRoute(null);
    setSelectedStop(null);
  }

  function handleDeleteStop(stopName: string, routeId: string) {
    snapshotHistory();
    setRoutes((prev) =>
      prev.map((r) => r.id === routeId ? { ...r, shape: undefined, stops: r.stops.filter((s) => s.name !== stopName) } : r)
    );
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
        console.log("[traffic] API payload", {
          type: fc?.type,
          featureCount: fc?.features?.length ?? 0,
          firstFeature: fc?.features?.[0] ?? null,
        });
        setTrafficGeoJSON(fc);
        const map = mapRef.current;
        if (map && map.isStyleLoaded()) {
          const src = map.getSource("traffic") as mapboxgl.GeoJSONSource | undefined;
          if (src) {
            src.setData(fc);
            console.log("[traffic] setData from fetch", {
              hasSource: true,
              featureCount: fc?.features?.length ?? 0,
              layerExists: !!map.getLayer("traffic-lines"),
              layerVisibility: map.getLayer("traffic-lines")
                ? map.getLayoutProperty("traffic-lines", "visibility")
                : "missing",
            });
          } else {
            console.log("[traffic] source missing during fetch setData");
          }
        } else {
          console.log("[traffic] map/style not ready during fetch setData", {
            hasMap: !!map,
            styleLoaded: map ? map.isStyleLoaded() : false,
          });
        }
      })
      .catch((err) => {
        console.error("Failed to fetch traffic data:", err);
      })
      .finally(() => {
        if (!cancelled) setTrafficLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // ── init map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    mapboxgl.accessToken = TOKEN;
    console.log(TOKEN, "my token")

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
    console.log(mapRef.current)

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
        if (councilHasRunRef.current) return; // locked after Generate Route
        // Station dots sit on top of neighbourhoods — let the station handler take priority
        if (map.queryRenderedFeatures(e.point, { layers: stopDotLayerIdsRef.current }).length > 0) return;
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

      // Population heatmap — initialize with empty data, then sync via effect
      map.addSource("population", {
        type: "geojson",
        data: { type: "FeatureCollection" as const, features: [] },
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
          minzoom: 12,
          paint: {
            "circle-radius": [
              "interpolate", ["linear"], ["zoom"],
              15, 2,
              17, 4,
              19, 8,
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
            "circle-opacity": ["interpolate", ["linear"], ["zoom"], 15, 0, 17, 0.75],
            "circle-stroke-width": 0.5,
            "circle-stroke-color": "rgba(255,255,255,0.5)",
          },
        },
        firstLabelLayer,
      );

      // Traffic lines — initialize with empty data, then sync via effect
      map.addSource("traffic", {
        type: "geojson",
        data: { type: "FeatureCollection" as const, features: [] },
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

      // ── Shared bus layers (2 GeoJSON sources, 4 layers — replaces per-route bus layers)
      const visibleBusRouteIds = new Set(
        BUS_ROUTES.filter((r) => !hiddenRoutes.has(r.id)).map((r) => r.id),
      );
      const busLinesFeatures: GeoJSON.Feature<GeoJSON.LineString>[] = BUS_ROUTES.map((r, idx) => ({
        type: "Feature" as const,
        id: idx,
        properties: { routeId: r.id, color: r.color },
        geometry: {
          type: "LineString" as const,
          coordinates: (r.shape ?? r.stops.map((s) => s.coords)),
        },
      }));
      const busStopsFeatures: GeoJSON.Feature<GeoJSON.Point>[] = BUS_ROUTES.flatMap((r) =>
        r.stops.map((s) => ({
          type: "Feature" as const,
          properties: { routeId: r.id, color: r.color, name: s.name },
          geometry: { type: "Point" as const, coordinates: s.coords },
        })),
      );
      const hiddenBusIds = BUS_ROUTES.map((r) => r.id).filter((id) => !visibleBusRouteIds.has(id));
      const busFilter: mapboxgl.FilterSpecification =
        hiddenBusIds.length > 0
          ? ["!", ["in", ["get", "routeId"], ["literal", hiddenBusIds]]]
          : ["literal", true];

      map.addSource("bus-lines-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: busLinesFeatures },
      });
      map.addSource("bus-stops-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: busStopsFeatures },
      });

      map.addLayer({
        id: "bus-line-shadow",
        type: "line",
        source: "bus-lines-source",
        filter: busFilter,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ["get", "color"] as unknown as string,
          "line-opacity": 0.08,
          "line-width": 5,
          "line-blur": 3,
        },
      });

      map.addLayer({
        id: "bus-line-layer",
        type: "line",
        source: "bus-lines-source",
        filter: busFilter,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ["get", "color"] as unknown as string,
          "line-opacity": ["case", ["boolean", ["feature-state", "hovered"], false], 1.0, 0.7] as unknown as number,
          "line-width": ["case", ["boolean", ["feature-state", "hovered"], false], 4, 2] as unknown as number,
        },
      });

      map.addLayer({
        id: "bus-stops-ring",
        type: "circle",
        source: "bus-stops-source",
        filter: busFilter,
        minzoom: 14,
        paint: {
          "circle-color": ["get", "color"] as unknown as string,
          "circle-opacity": 0.5,
          "circle-radius": 2.5,
        },
      });

      map.addLayer({
        id: "bus-stops-dot",
        type: "circle",
        source: "bus-stops-source",
        filter: busFilter,
        minzoom: 14,
        paint: {
          "circle-color": "#ffffff",
          "circle-stroke-color": ["get", "color"] as unknown as string,
          "circle-radius": 1.5,
          "circle-stroke-width": 1,
        },
      });

      // Click handler on shared bus stop dot layer
      map.on("click", "bus-stops-dot", (e) => {
        if (didDragStopRef.current) { didDragStopRef.current = false; return; }
        const props = e.features?.[0]?.properties as { name?: string; routeId?: string } | undefined;
        const name = props?.name;
        const routeId = props?.routeId;
        if (!name || !routeId) return;
        if (!addStationToLineRef.current) e.originalEvent.stopPropagation();
        if (drawModeRef.current === "select") {
          const key = `${name}::${routeId}`;
          const next = new Set(selectedStationsRef.current);
          if (next.has(key)) next.delete(key); else next.add(key);
          selectedStationsRef.current = next;
          setSelectedStations(new Set(next));
          return;
        }
        const busRoute = BUS_ROUTES.find((r) => r.id === routeId);
        if (!busRoute) return;
        const { x, y } = e.point;
        setStationPopup({ name, routeId, x, y, coords: [e.lngLat.lng, e.lngLat.lat] });
        setSelectedRoute(busRoute);
        setSelectedStop(name);
      });

      map.on("mouseenter", "bus-stops-dot", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "bus-stops-dot", () => { map.getCanvas().style.cursor = ""; });

      map.on("click", "bus-line-layer", (e) => {
        const routeId = e.features?.[0]?.properties?.routeId as string | undefined;
        const busRoute = BUS_ROUTES.find((r) => r.id === routeId);
        if (busRoute) { setSelectedRoute(busRoute); setSelectedStop(null); }
      });

      let hoveredBusFeatureId: number | string | null = null;

      map.on("mousemove", "bus-line-layer", (e) => {
        const featureId = e.features?.[0]?.id;
        if (featureId === undefined || featureId === null) return;
        map.getCanvas().style.cursor = "pointer";
        if (featureId !== hoveredBusFeatureId) {
          if (hoveredBusFeatureId !== null) {
            map.setFeatureState({ source: "bus-lines-source", id: hoveredBusFeatureId }, { hovered: false });
          }
          hoveredBusFeatureId = featureId;
          map.setFeatureState({ source: "bus-lines-source", id: featureId }, { hovered: true });
        }
      });

      map.on("mouseleave", "bus-line-layer", () => {
        map.getCanvas().style.cursor = "";
        if (hoveredBusFeatureId !== null) {
          map.setFeatureState({ source: "bus-lines-source", id: hoveredBusFeatureId }, { hovered: false });
          hoveredBusFeatureId = null;
        }
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
          const currentCounter = stopCounterRef.current;
          const tempName = `Station ${currentCounter}`;
          snapshotHistory();
          stopCounterRef.current = currentCounter + 1;
          setRoutes((prev) => prev.map((r) => {
            if (r.id !== lineId) return r;
            const newStop = { name: tempName, coords };
            if (r.stops.length === 0) return { ...r, shape: undefined, stops: [newStop] };
            const insertIdx = bestInsertIndex(coords, r.stops);
            const newStops = [...r.stops.slice(0, insertIdx), newStop, ...r.stops.slice(insertIdx)];
            return { ...r, stops: newStops }; // keep existing shape visible during re-snap
          }));
          // Auto-snap bus and streetcar routes to roads after each stop placement
          const routeBeforeAdd = routesRef.current.find((r) => r.id === lineId);
          if ((routeBeforeAdd?.type === "bus" || routeBeforeAdd?.type === "streetcar") && routeBeforeAdd.stops.length >= 1) {
            startShimmerRef.current(lineId);
            triggerAutoSnapRef.current(lineId);
          }
          // Geocode asynchronously and rename from temp name
          void reverseGeocodeStation(coords[0], coords[1]).then((geoName) => {
            if (!geoName) return;
            setRoutes((prev) => prev.map((r) =>
              r.id === lineId ? { ...r, stops: r.stops.map(s => s.name === tempName ? { ...s, name: geoName } : s) } : r
            ));
          });
          return;
        }

        // Portal placement mode
        const portalLineId = addPortalToLineRef.current;
        if (portalLineId) {
          const coords: [number, number] = [e.lngLat.lng, e.lngLat.lat];
          snapshotHistory();
          setRoutes((prev) => prev.map((r) => {
            if (r.id !== portalLineId) return r;
            // Snap portal coord to route shape
            const shape = r.shape ?? r.stops.map((s) => s.coords);
            const snapped = shape.length >= 2 ? snapToShape(coords, shape) : coords;
            return { ...r, portals: [...(r.portals ?? []), { coords: snapped }] };
          }));
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
        if (!routesRef.current.some((r) => r.id === popup.routeId)) return;
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
          redoStackRef.current.push({
            routes: [...routesRef.current],
            counter: stopCounterRef.current,
          });
          stopCounterRef.current = prev.counter;
          routesRef.current = prev.routes;
          setRoutes(prev.routes);
          setCanUndo(historyRef.current.length > 0);
          setCanRedo(true);
        }
      } else if (e.key === "z" && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        const next = redoStackRef.current.pop();
        if (next !== undefined) {
          historyRef.current.push({
            routes: [...routesRef.current],
            counter: stopCounterRef.current,
          });
          stopCounterRef.current = next.counter;
          routesRef.current = next.routes;
          setRoutes(next.routes);
          setCanUndo(true);
          setCanRedo(redoStackRef.current.length > 0);
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

  // ── keep population source in sync when data arrives after map load
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || !populationGeoJSON) return;
    const src = map.getSource("population") as mapboxgl.GeoJSONSource | undefined;
    if (src) src.setData(populationGeoJSON);
  }, [populationGeoJSON, mapLoaded]);

  // ── keep traffic source in sync when data arrives after map load
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || !trafficGeoJSON) return;
    const src = map.getSource("traffic") as mapboxgl.GeoJSONSource | undefined;
    if (src) {
      src.setData(trafficGeoJSON);
      console.log("[traffic] sync effect setData", {
        featureCount: trafficGeoJSON.features.length,
        sourceExists: true,
        layerExists: !!map.getLayer("traffic-lines"),
        layerVisibility: map.getLayer("traffic-lines")
          ? map.getLayoutProperty("traffic-lines", "visibility")
          : "missing",
      });
    } else {
      console.log("[traffic] sync effect source missing");
    }
  }, [trafficGeoJSON, mapLoaded]);

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
      console.log("[traffic] toggle visibility", {
        showTraffic,
        appliedVisibility: map.getLayoutProperty("traffic-lines", "visibility"),
        hasSource: !!map.getSource("traffic"),
        sourceFeatureCount: trafficGeoJSON?.features?.length ?? 0,
      });
    } else {
      console.log("[traffic] toggle attempted but layer missing", { showTraffic });
    }
  }, [showTraffic, mapLoaded, trafficGeoJSON]);

  // ── per-route visibility toggle
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const prev = prevHiddenRef.current;

    // Bus routes: use a single setFilter on the shared bus layers
    // Exclude both hidden routes AND routes that have been promoted to the editable routes state
    const excludedBusIds = BUS_ROUTES.map((r) => r.id).filter((id) => hiddenRoutes.has(id) || routesRef.current.some((r) => r.id === id));
    const busFilter: mapboxgl.FilterSpecification =
      excludedBusIds.length > 0
        ? ["!", ["in", ["get", "routeId"], ["literal", excludedBusIds]]]
        : ["literal", true];
    for (const layerId of ["bus-line-shadow", "bus-line-layer", "bus-stops-ring", "bus-stops-dot"]) {
      if (map.getLayer(layerId)) map.setFilter(layerId, busFilter);
    }

    // Non-bus routes: cover all routes in the unified model
    for (const route of routesRef.current) {
      const wasHidden = prev.has(route.id);
      const isHidden  = hiddenRoutes.has(route.id);
      if (wasHidden === isHidden) continue;
      const vis = isHidden ? "none" : "visible";
      for (const layerId of [`route-shadow-${route.id}`, `route-outline-${route.id}`, `route-line-${route.id}`, `stops-ring-${route.id}`, `stops-selected-${route.id}`, `stops-dot-${route.id}`]) {
        if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", vis);
      }
    }

    prevHiddenRef.current = new Set(hiddenRoutes);
  }, [hiddenRoutes, routes, mapLoaded]);

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
          properties: { name: s.name, disabled: disabledStops.has(s.name) },
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

    map.on("click", "generated-stops-dot", (e) => {
      const name = e.features?.[0]?.properties?.name as string | undefined;
      if (!name) return;
      setSelectedGeneratedStop((prev) => (prev === name ? null : name));
      map.flyTo({ center: e.lngLat, zoom: Math.max(map.getZoom(), 13), duration: 400 });
    });

    map.on("mouseenter", "generated-stops-dot", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "generated-stops-dot", () => { map.getCanvas().style.cursor = ""; });

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



  // ── Council preview: render animated multi-route layer ────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const SRC_LINE = "council-preview-line";
    const SRC_DOTS = "council-preview-dots";
    const LYR_SHADOW = "council-preview-shadow";
    const LYR_LINE = "council-preview-lyr";
    const LYR_SHIMMER = "council-preview-shimmer";
    const LYR_DOTS = "council-preview-lyr-dots";

    if (shimmerRafRef.current !== null) {
      cancelAnimationFrame(shimmerRafRef.current);
      shimmerRafRef.current = null;
    }

    const validRoutes = (councilPreview ?? []).filter((r) => r.stops.length >= 2);
    if (validRoutes.length === 0) {
      for (const id of [LYR_SHADOW, LYR_SHIMMER, LYR_LINE, LYR_DOTS]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      for (const id of [SRC_LINE, SRC_DOTS]) {
        if (map.getSource(id)) map.removeSource(id);
      }
      return;
    }

    const lineGeoJSON: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: validRoutes.map((r) => ({
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates: r.stops.map((s) => s.coords) },
        properties: { color: r.color },
      })),
    };
    const dotsGeoJSON: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: validRoutes.flatMap((r) =>
        r.stops.map((s) => ({
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: s.coords },
          properties: { name: s.name, color: r.color },
        }))
      ),
    };

    if (map.getSource(SRC_LINE)) {
      (map.getSource(SRC_LINE) as mapboxgl.GeoJSONSource).setData(lineGeoJSON);
      (map.getSource(SRC_DOTS) as mapboxgl.GeoJSONSource).setData(dotsGeoJSON);
    } else {
      map.addSource(SRC_LINE, { type: "geojson", data: lineGeoJSON });
      map.addSource(SRC_DOTS, { type: "geojson", data: dotsGeoJSON });
      map.addLayer({ id: LYR_SHADOW, type: "line", source: SRC_LINE, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": ["get", "color"] as unknown as string, "line-width": 14, "line-opacity": 0.12, "line-blur": 6 } });
      map.addLayer({ id: LYR_LINE, type: "line", source: SRC_LINE, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": ["get", "color"] as unknown as string, "line-width": 5, "line-opacity": 0.75 } });
      map.addLayer({ id: LYR_SHIMMER, type: "line", source: SRC_LINE, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": 5, "line-opacity": 0, "line-dasharray": [3, 30] } });
      map.addLayer({ id: LYR_DOTS, type: "circle", source: SRC_DOTS, minzoom: 10, paint: { "circle-radius": 5, "circle-color": "#fff", "circle-stroke-color": ["get", "color"] as unknown as string, "circle-stroke-width": 2.5, "circle-opacity": 0.9 } });
    }

    const animMap = map;
    const PERIOD = 1800;
    const DASH = 3;
    const GAP = 30;
    const TOTAL = DASH + GAP;
    let start: number | null = null;
    function animate(ts: number) {
      if (!start) start = ts;
      const t = ((ts - start) % PERIOD) / PERIOD;
      const offset = t * TOTAL;
      const pre = offset % TOTAL;
      const pattern = pre < DASH
        ? [0, pre, DASH - pre, GAP]
        : [0, pre, DASH, GAP - (pre - DASH)];
      if (animMap.getLayer(LYR_SHIMMER)) {
        animMap.setPaintProperty(LYR_SHIMMER, "line-dasharray", pattern);
        animMap.setPaintProperty(LYR_SHIMMER, "line-opacity", 0.55 + 0.2 * Math.sin(t * Math.PI * 2));
      }
      shimmerRafRef.current = requestAnimationFrame(animate);
    }
    shimmerRafRef.current = requestAnimationFrame(animate);

    return () => {
      if (shimmerRafRef.current !== null) cancelAnimationFrame(shimmerRafRef.current);
    };
  }, [councilPreview, mapLoaded]);

  // ── tool-call map animations — callback ref (bypasses React batching) ─────
  useEffect(() => {
    // Keep the callback ref updated whenever map readiness changes
    onToolCallRef.current = (evt: ToolCallEvent) => {
      const map = mapRef.current;
      if (!map || !mapLoaded) return;
      const { call_id: id, tool, input, result } = evt;

      const SRC = "tool-anim-src";
      if (!map.getSource(SRC)) {
        map.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({ id: "tool-search-pulse", type: "circle", source: SRC, filter: ["==", ["get", "kind"], "search-center"], paint: { "circle-radius": 0, "circle-color": "transparent", "circle-stroke-color": "#ef4444", "circle-stroke-width": 2.5, "circle-stroke-opacity": 0.85 } });
        map.addLayer({ id: "tool-search-stops", type: "circle", source: SRC, filter: ["==", ["get", "kind"], "search-stop"], paint: { "circle-radius": 5, "circle-color": "#ef4444", "circle-opacity": 0, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
        map.addLayer({ id: "tool-snap-line", type: "line", source: SRC, filter: ["==", ["get", "kind"], "snap-line"], paint: { "line-color": "#f59e0b", "line-width": 2, "line-opacity": 0.9, "line-dasharray": [4, 4] } });
        map.addLayer({ id: "tool-snap-from", type: "circle", source: SRC, filter: ["==", ["get", "kind"], "snap-from"], paint: { "circle-radius": 6, "circle-color": "transparent", "circle-stroke-color": "#f59e0b", "circle-stroke-width": 2.5 } });
        map.addLayer({ id: "tool-snap-to", type: "circle", source: SRC, filter: ["==", ["get", "kind"], "snap-to"], paint: { "circle-radius": 7, "circle-color": "#f59e0b", "circle-opacity": 0, "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
        map.addLayer({ id: "tool-transfer-pulse", type: "circle", source: SRC, filter: ["==", ["get", "kind"], "transfer"], paint: { "circle-radius": 14, "circle-color": "transparent", "circle-stroke-color": "#7c3aed", "circle-stroke-width": 2.5, "circle-stroke-opacity": 0 } });
      }

      const getFeats = () => toolAnimFeaturesRef.current;
      const setFeats = (f: GeoJSON.Feature[]) => {
        toolAnimFeaturesRef.current = f;
        (map.getSource(SRC) as mapboxgl.GeoJSONSource)?.setData({ type: "FeatureCollection", features: f });
      };
      const removeById = (cid: string) => setFeats(getFeats().filter(f => f.properties?.call_id !== cid));

      const existingRaf = toolAnimRafsRef.current.get(id);
      if (existingRaf !== undefined) cancelAnimationFrame(existingRaf);
      const existingTimeout = toolAnimTimeoutsRef.current.get(id);
      if (existingTimeout !== undefined) clearTimeout(existingTimeout);

      if (tool === "search_stops_near_point") {
        if (result === null) {
          setFeats([...getFeats().filter(f => f.properties?.call_id !== id), { type: "Feature", geometry: { type: "Point", coordinates: [input.lon, input.lat] }, properties: { kind: "search-center", call_id: id } }]);
          let start: number | null = null;
          const animate = (ts: number) => {
            if (!start) start = ts;
            const prog = Math.min((ts - start) / 700, 1);
            const ease = 1 - Math.pow(1 - prog, 3);
            if (map.getLayer("tool-search-pulse")) { map.setPaintProperty("tool-search-pulse", "circle-radius", ease * 55); map.setPaintProperty("tool-search-pulse", "circle-stroke-opacity", (1 - ease) * 0.85); }
            if (prog < 1) toolAnimRafsRef.current.set(id, requestAnimationFrame(animate));
          };
          toolAnimRafsRef.current.set(id, requestAnimationFrame(animate));
        } else {
          const stops = (result as { lon: number; lat: number; stop_name?: string }[] | null) ?? [];
          setFeats([...getFeats().filter(f => f.properties?.call_id !== id), ...stops.slice(0, 8).map(s => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] }, properties: { kind: "search-stop", call_id: id } }))]);
          let start: number | null = null;
          const animate = (ts: number) => { if (!start) start = ts; const p = Math.min((ts - start) / 400, 1); if (map.getLayer("tool-search-stops")) map.setPaintProperty("tool-search-stops", "circle-opacity", p * 0.85); if (p < 1) toolAnimRafsRef.current.set(id, requestAnimationFrame(animate)); };
          toolAnimRafsRef.current.set(id, requestAnimationFrame(animate));
          toolAnimTimeoutsRef.current.set(id, setTimeout(() => { if (map.getLayer("tool-search-pulse")) map.setPaintProperty("tool-search-pulse", "circle-radius", 0); if (map.getLayer("tool-search-stops")) map.setPaintProperty("tool-search-stops", "circle-opacity", 0); removeById(id); }, 2500));
        }
      } else if (tool === "snap_to_nearest_stop") {
        if (result === null) {
          setFeats([...getFeats().filter(f => f.properties?.call_id !== id), { type: "Feature", geometry: { type: "Point", coordinates: [input.lon, input.lat] }, properties: { kind: "snap-from", call_id: id } }]);
        } else {
          const snap = result as { lon: number; lat: number } | null;
          if (!snap) { removeById(id); return; }
          setFeats([...getFeats().filter(f => f.properties?.call_id !== id), { type: "Feature", geometry: { type: "LineString", coordinates: [[input.lon, input.lat], [snap.lon, snap.lat]] }, properties: { kind: "snap-line", call_id: id } }, { type: "Feature", geometry: { type: "Point", coordinates: [input.lon, input.lat] }, properties: { kind: "snap-from", call_id: id } }, { type: "Feature", geometry: { type: "Point", coordinates: [snap.lon, snap.lat] }, properties: { kind: "snap-to", call_id: id } }]);
          let start: number | null = null;
          const animate = (ts: number) => { if (!start) start = ts; const t = ((ts - start) % 900) / 900; const offset = t * 8; const pre = offset % 8; const pattern = pre < 4 ? [0, pre, 4 - pre, 4] : [0, pre, 4, 4 - (pre - 4)]; if (map.getLayer("tool-snap-line")) map.setPaintProperty("tool-snap-line", "line-dasharray", pattern); if (map.getLayer("tool-snap-to")) map.setPaintProperty("tool-snap-to", "circle-opacity", 0.5 + 0.4 * Math.sin(t * Math.PI * 2)); toolAnimRafsRef.current.set(id, requestAnimationFrame(animate)); };
          toolAnimRafsRef.current.set(id, requestAnimationFrame(animate));
          toolAnimTimeoutsRef.current.set(id, setTimeout(() => { const raf = toolAnimRafsRef.current.get(id); if (raf !== undefined) { cancelAnimationFrame(raf); toolAnimRafsRef.current.delete(id); } if (map.getLayer("tool-snap-line")) { map.setPaintProperty("tool-snap-line", "line-opacity", 0); setTimeout(() => { if (map.getLayer("tool-snap-line")) map.setPaintProperty("tool-snap-line", "line-opacity", 0.9); }, 50); } if (map.getLayer("tool-snap-to")) map.setPaintProperty("tool-snap-to", "circle-opacity", 0); removeById(id); }, 1800));
        }
      } else if (tool === "check_transfer_at_location") {
        const stops = (result as { lon: number; lat: number }[] | null) ?? [];
        if (stops.length === 0) return;
        const feats: GeoJSON.Feature[] = stops.slice(0, 5).map((s, i) => ({ type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] }, properties: { kind: "transfer", call_id: `${id}-${i}` } }));
        setFeats([...getFeats().filter(f => !(f.properties?.call_id as string)?.startsWith(id)), ...feats]);
        let start: number | null = null;
        const animate = (ts: number) => { if (!start) start = ts; const pulse = Math.abs(Math.sin(((ts - start) % 1000) / 1000 * Math.PI)); if (map.getLayer("tool-transfer-pulse")) { map.setPaintProperty("tool-transfer-pulse", "circle-radius", 8 + pulse * 14); map.setPaintProperty("tool-transfer-pulse", "circle-stroke-opacity", pulse * 0.85); } toolAnimRafsRef.current.set(id, requestAnimationFrame(animate)); };
        toolAnimRafsRef.current.set(id, requestAnimationFrame(animate));
        toolAnimTimeoutsRef.current.set(id, setTimeout(() => { const raf = toolAnimRafsRef.current.get(id); if (raf !== undefined) { cancelAnimationFrame(raf); toolAnimRafsRef.current.delete(id); } if (map.getLayer("tool-transfer-pulse")) map.setPaintProperty("tool-transfer-pulse", "circle-stroke-opacity", 0); setFeats(getFeats().filter(f => !(f.properties?.call_id as string)?.startsWith(id))); }, 2000));
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapLoaded]);

  // ── clean up tool animations when council closes ───────────────────────────
  useEffect(() => {
    if (!councilOpen) {
      toolAnimRafsRef.current.forEach((raf) => cancelAnimationFrame(raf));
      toolAnimRafsRef.current.clear();
      toolAnimTimeoutsRef.current.forEach((t) => clearTimeout(t));
      toolAnimTimeoutsRef.current.clear();
      toolAnimFeaturesRef.current = [];
      const map = mapRef.current;
      if (map) {
        for (const lyr of ["tool-search-pulse","tool-search-stops","tool-snap-line","tool-snap-from","tool-snap-to","tool-transfer-pulse"]) {
          if (map.getLayer(lyr)) map.removeLayer(lyr);
        }
        if (map.getSource("tool-anim-src")) map.removeSource("tool-anim-src");
      }
    }
  }, [councilOpen]);

  // ── add map layers for newly created custom lines
	  useEffect(() => {
	    const map = mapRef.current;
	    if (!map || !mapLoaded) return;
	    routes.forEach((route) => {
      if (map.getSource(`route-${route.id}`)) return; // already added
      map.addSource(`route-${route.id}`, { type: "geojson", data: route.stops.length >= 2 ? routeToGeoJSON(route) : routeToGeoJSON(route) });
      map.addSource(`stops-${route.id}`, { type: "geojson", data: stopsToGeoJSON(route) });
	      const sc = route.type === "streetcar";
	      const bus = route.type === "bus";
	      map.addLayer({ id: `route-shadow-${route.id}`, type: "line", source: `route-${route.id}`, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": route.color, "line-width": bus ? 2 : sc ? 5 : 10, "line-opacity": bus ? 0.05 : sc ? 0.08 : 0.12, "line-blur": bus ? 2 : sc ? 3 : 4 } });
	      if (!bus && !sc) map.addLayer({ id: `route-outline-${route.id}`, type: "line", source: `route-${route.id}`, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": darkenColor(route.color), "line-width": 11, "line-opacity": 0.9 } });
	      map.addLayer({ id: `route-line-${route.id}`, type: "line", source: `route-${route.id}`, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": route.color, "line-width": bus ? 1.5 : sc ? 3 : 7, "line-opacity": bus ? 0.7 : sc ? 0.85 : 1 } });
	      map.addLayer({ id: `stops-ring-${route.id}`, type: "circle", source: `stops-${route.id}`, minzoom: sc ? 12 : 11, paint: { "circle-radius": bus ? 2 : sc ? 3.5 : 6, "circle-color": route.color, "circle-opacity": 0.25, "circle-stroke-width": 0 } });
	      map.addLayer({ id: `stops-selected-${route.id}`, type: "circle", source: `stops-${route.id}`, minzoom: 9, filter: ["==", ["get", "name"], "__none__"], paint: { "circle-radius": bus ? 3.5 : sc ? 5 : 9, "circle-color": route.color, "circle-opacity": 0.5, "circle-stroke-width": bus ? 1 : sc ? 1.5 : 2, "circle-stroke-color": "#ffffff" } });
	      map.addLayer({ id: `stops-dot-${route.id}`, type: "circle", source: `stops-${route.id}`, minzoom: sc ? 12 : 11, paint: { "circle-radius": bus ? 1.5 : sc ? 2 : 3.5, "circle-color": "#ffffff", "circle-stroke-color": route.color, "circle-stroke-width": bus ? 1 : sc ? 1.5 : 2 } });
      // Underground tunnel overlay
      map.addSource(`underground-${route.id}`, { type: "geojson", data: undergroundToGeoJSON(route) });
      map.addLayer({ id: `underground-line-${route.id}`, type: "line", source: `underground-${route.id}`, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#1e1e2e", "line-width": bus ? 1.5 : sc ? 3 : 7, "line-opacity": 0.55, "line-dasharray": [2, 2] } });
      // Portal markers
      map.addSource(`portals-${route.id}`, { type: "geojson", data: portalsToGeoJSON(route) });
      map.addLayer({ id: `portals-dot-${route.id}`, type: "circle", source: `portals-${route.id}`, paint: { "circle-radius": 5, "circle-color": "#1e1e2e", "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5, "circle-opacity": 0.8 } });
	      map.on("click", `route-line-${route.id}`, () => { const cur = routesRef.current.find(r => r.id === route.id) ?? route; setSelectedRoute(cur); setSelectedStop(null); });
	      map.on("mouseenter", `route-line-${route.id}`, () => { map.getCanvas().style.cursor = "pointer"; map.setPaintProperty(`route-line-${route.id}`, "line-width", bus ? 3 : sc ? 5 : 10); });
	      map.on("mouseleave", `route-line-${route.id}`, () => { map.getCanvas().style.cursor = ""; map.setPaintProperty(`route-line-${route.id}`, "line-width", bus ? 1.5 : sc ? 3 : 7); });
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
        setSelectedRoute(routesRef.current.find(r => r.id === route.id) ?? route);
        setSelectedStop(name);
      });
      map.on("mouseenter", `stops-dot-${route.id}`, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", `stops-dot-${route.id}`, () => { map.getCanvas().style.cursor = ""; });
    });
  }, [routes, mapLoaded]);

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
      // Allow dragging any stop (all routes are now editable)
      const route = routesRef.current.find((r) => r.id === lineId);
      if (!route) return;
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
      const route = routesRef.current.find((r) => r.id === lineId);
      if (!route) return;
      const allStops = route.stops.map((s) => s.name === dragging!.name ? { ...s, coords: newCoords } : s);
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
      setRoutes((prev) =>
        prev.map((r) => r.id === lineId ? { ...r, shape: undefined, stops: r.stops.map((s) => s.name === name ? { ...s, coords } : s) } : r)
      );
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

  function handleExport() {
    void (async () => {
      setExportProgress(0);
      try {
        const JSZip = (await import("jszip")).default;
        const { generateGTFS } = await import("~/lib/gtfs");
        const { validateGTFS } = await import("~/lib/gtfs-validate");
        const files = generateGTFS(routes);
        const result = validateGTFS(files);
        const zip = new JSZip();
        for (const [name, content] of Object.entries(files)) {
          zip.file(name, content);
        }
        const blob = await zip.generateAsync(
          { type: "blob", compression: "DEFLATE" },
          ({ percent }) => setExportProgress(Math.round(percent)),
        );
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "transit-plan-gtfs.zip";
        a.click();
        URL.revokeObjectURL(url);
        setValidationResult({ result, context: "export" });
      } finally {
        setExportProgress(null);
      }
    })();
  }

  function handleImport() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,.json,application/zip,application/json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      setPendingImportFile(file);
    };
    input.click();
  }

  function removeCustomLineFromMap(routeId: string) {
    const map = mapRef.current;
    if (!map) return;
    [`route-shadow-${routeId}`, `route-outline-${routeId}`, `route-line-${routeId}`, `stops-ring-${routeId}`, `stops-selected-${routeId}`, `stops-dot-${routeId}`, `underground-line-${routeId}`, `portals-dot-${routeId}`].forEach((id) => {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    [`route-${routeId}`, `stops-${routeId}`, `underground-${routeId}`, `portals-${routeId}`].forEach((id) => {
      if (map.getSource(id)) map.removeSource(id);
    });
  }

  function confirmImport(file: File) {
    setPendingImportFile(null);
    // Remove all existing custom line layers/sources from the map before replacing state
    for (const route of routes) removeCustomLineFromMap(route.id);
    if (file.name.endsWith(".zip")) {
      void (async () => {
        try {
          const JSZip = (await import("jszip")).default;
          const { importGTFS } = await import("~/lib/gtfs-import");
          const { validateGTFS } = await import("~/lib/gtfs-validate");
          const zip = await JSZip.loadAsync(file).catch(() => {
            throw new Error("Could not read ZIP file. Make sure the file is a valid .zip archive.");
          });

          // Extract raw file strings for validation
          const gtfsFileNames = [
            "agency.txt", "routes.txt", "trips.txt", "stop_times.txt",
            "stops.txt", "shapes.txt", "calendar.txt", "calendar_dates.txt",
          ];
          const gtfsFiles: Record<string, string> = {};
          for (const name of gtfsFileNames) {
            const entry = zip.file(name);
            if (entry) gtfsFiles[name] = await entry.async("string");
          }
          const validation = validateGTFS(gtfsFiles);

          if (!validation.valid) {
            // Block import, show validation errors
            setValidationResult({ result: validation, context: "import" });
            return;
          }

          const importedRoutes = await importGTFS(zip);
          setRoutes(importedRoutes);

          // Show warnings (if any) after successful import
          if (validation.issues.length > 0) {
            setValidationResult({ result: validation, context: "import" });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error while importing GTFS.";
          setImportError(msg);
        }
      })();
    } else {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const parsed = JSON.parse(e.target?.result as string) as {
            customLines?: Route[];
            routes?: Route[];
          };
          setRoutes(parsed.routes ?? parsed.customLines ?? []);
        } catch {
          setImportError("Could not parse the JSON file. Make sure it was exported from this app.");
        }
      };
      reader.readAsText(file);
    }
  }

  return (
    <div className="relative h-full w-full">
	      <div ref={containerRef} className="h-full w-full" />

	      {/* TTC Lines legend + neighbourhood panel — top left */}
	      <div className="absolute top-6 left-6 flex flex-col gap-4 pointer-events-auto" style={{ maxHeight: "calc(100vh - 48px)" }}>
	        <div className="rounded-xl border border-[#D7D7D7] bg-white shadow-sm w-64 flex flex-col overflow-hidden" style={{ maxHeight: "calc(100vh - 96px)" }}>
	          {/* sticky header */}
	          <div className="px-4 pt-4 pb-2 shrink-0">
	            <p className="text-lg font-bold text-stone-800">Lines</p>
	          </div>
	          {/* scrollable content */}
	          <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
	            {/* ── Lines sections: grouped by type, custom lines merged in */}
	            {(
	              [
	                { key: "subway",    label: "Subway / LRT", types: ["subway", "lrt"] as Route["type"][] },
	                { key: "streetcar", label: "Streetcars",   types: ["streetcar"] as Route["type"][] },
	                { key: "bus",       label: "Bus",          types: ["bus"] as Route["type"][] },
	              ]
	            ).map(({ key, label, types }) => {
	              const sectionRoutes = [
	                ...BUS_ROUTES.filter((r) => types.includes(r.type)).map((r) => routes.find((er) => er.id === r.id) ?? r),
	                ...routes.filter((r) => types.includes(r.type) && !BUS_ROUTES.some((br) => br.id === r.id)),
	              ];
	              if (sectionRoutes.length === 0) return null;
	              const allHidden = sectionRoutes.every((r) => hiddenRoutes.has(r.id));
	              const collapsed = collapsedSections[key] ?? false;
	              return (
	                <div key={key} className="mb-2">
	                  <div className="flex items-center gap-1 mb-1">
	                    <button
	                      onClick={() => setCollapsedSections((prev) => ({ ...prev, [key]: !collapsed }))}
	                      className="flex items-center gap-1 flex-1 text-left"
	                    >
	                      <svg viewBox="0 0 10 10" fill="currentColor" className={`h-2.5 w-2.5 text-stone-400 transition-transform shrink-0 ${collapsed ? "-rotate-90" : ""}`}>
	                        <path d="M2 3l3 4 3-4H2z"/>
	                      </svg>
	                      <span className="text-xs font-semibold text-stone-500 uppercase tracking-wide">{label}</span>
	                    </button>
	                    <button
	                      title={allHidden ? "Show all" : "Hide all"}
	                      onClick={() => setHiddenRoutes((prev) => {
	                        const next = new Set(prev);
	                        if (allHidden) sectionRoutes.forEach((r) => next.delete(r.id));
	                        else sectionRoutes.forEach((r) => next.add(r.id));
	                        return next;
	                      })}
	                      className="p-0.5 text-stone-400 hover:text-stone-700 transition-colors"
	                    >
	                      {allHidden ? (
	                        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
	                          <path d="M2 2l12 12M6.5 6.6A3 3 0 0 0 9.4 9.5"/><path d="M4.2 4.3C2.9 5.2 1.8 6.5 1 8c1.5 3 4 5 7 5a8 8 0 0 0 3.5-.8M6 2.3A8 8 0 0 1 8 2c3 0 5.5 2 7 5-0.5 1-1.2 2-2 2.7"/>
	                        </svg>
	                      ) : (
	                        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
	                          <path d="M1 8c1.5-3 4-5 7-5s5.5 2 7 5c-1.5 3-4 5-7 5S2.5 11 1 8z"/><circle cx="8" cy="8" r="2.5"/>
	                        </svg>
	                      )}
	                    </button>
	                  </div>
	                  {!collapsed && (
	                    <ul className="space-y-0.5 pl-4">
	                      {sectionRoutes.map((r) => {
	                        const isActive = addStationToLine === r.id;
	                        const isHidden = hiddenRoutes.has(r.id);
	                        const inRoutesState = routes.some((route) => route.id === r.id);
	                        const promoteIfNeeded = () => {
	                          if (!inRoutesState) {
	                            const busRoute = BUS_ROUTES.find((br) => br.id === r.id);
	                            if (busRoute) setRoutes((prev) => [...prev, { ...busRoute }]);
	                          }
	                        };
	                        return (
	                          <li key={r.id} className="group">
	                            <div className="flex items-center gap-2">
	                              <button
	                                title={isActive ? "Deselect line" : "Select to add stations"}
	                                onClick={() => {
	                                  if (!isActive) {
	                                    handleSetDrawMode("normal");
	                                    snapshotHistory();
	                                    // Auto-show the route if it's hidden
	                                    if (isHidden) setHiddenRoutes((prev) => { const next = new Set(prev); next.delete(r.id); return next; });
	                                    promoteIfNeeded();
	                                  }
	                                  setAddStationToLine(isActive ? null : r.id);
	                                }}
	                                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded transition-all ${isActive ? "ring-2 ring-offset-1" : isHidden ? "opacity-30" : "opacity-60 hover:opacity-100"}`}
	                                style={isActive ? { outline: `2px solid ${r.color}`, outlineOffset: "2px" } : {}}
	                              >
	                                <span className="h-2 w-4 rounded-full" style={{ background: r.color }} />
	                              </button>
	                              <button
	                                className={`flex-1 truncate text-left text-sm transition-colors ${isActive ? "font-semibold text-stone-900" : isHidden ? "text-stone-300" : "text-stone-600 hover:text-stone-900"}`}
	                                onClick={() => setSelectedRoute(r)}
	                              >{r.name}</button>
	                              <div className={`flex items-center overflow-hidden transition-[max-width] duration-150 ${isActive ? "max-w-16" : "max-w-0 group-hover:max-w-16"}`}>
	                                <button
	                                  title={isActive ? "Stop editing" : "Edit line"}
	                                  onClick={() => {
	                                    if (!isActive) {
	                                      handleSetDrawMode("normal");
	                                      snapshotHistory();
	                                      if (isHidden) setHiddenRoutes((prev) => { const next = new Set(prev); next.delete(r.id); return next; });
	                                      promoteIfNeeded();
	                                    }
	                                    setAddStationToLine(isActive ? null : r.id);
	                                  }}
	                                  className={`p-0.5 transition-opacity ${isActive ? "opacity-100 text-stone-700" : "opacity-0 group-hover:opacity-100 text-stone-300 hover:text-stone-600"}`}
	                                >
	                                  <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M8.5 1.5l2 2L4 10H2v-2L8.5 1.5z"/></svg>
	                                </button>
	                                <button
	                                  title={isHidden ? "Show" : "Hide"}
	                                  onClick={() => setHiddenRoutes((prev) => { const next = new Set(prev); isHidden ? next.delete(r.id) : next.add(r.id); return next; })}
	                                  className="opacity-0 group-hover:opacity-100 p-0.5 text-stone-300 hover:text-stone-600 transition-opacity"
	                                >
	                                  {isHidden ? (
	                                    <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M1 1l10 10M5 5.2A2 2 0 0 0 6.8 7M3.2 3.3C2.2 4 1.4 4.9 1 6c1 2 3 3.5 5 3.5a6 6 0 0 0 2.4-.5M4.5 1.7A6 6 0 0 1 6 1.5c2 0 4 1.5 5 3.5-.4.8-.9 1.4-1.5 2"/></svg>
	                                  ) : (
	                                    <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M1 6c1-2 3-3.5 5-3.5S10 4 11 6c-1 2-3 3.5-5 3.5S2 8 1 6z"/><circle cx="6" cy="6" r="1.8"/></svg>
	                                  )}
	                                </button>
	                              </div>
	                            </div>
	                          </li>
	                        );
	                      })}
	                    </ul>
	                  )}
	                </div>
	              );
	            })}

	            {generatedRoute && (
	              <div className="mt-1 border-t border-stone-100 pt-2">
	                <li
	                  className="flex cursor-pointer items-center gap-2 text-sm text-stone-600 hover:text-stone-900 list-none"
	                  onClick={() => setSelectedRoute(null)}
	                >
	                  <span className="h-2 w-4 shrink-0 rounded-full" style={{ background: generatedRoute.color }} />
	                  <span className="truncate">{generatedRoute.name}</span>
	                </li>
	              </div>
	            )}
	          </div>
	          {/* sticky footer — always visible */}
	          <div className="shrink-0 px-4 pb-4 pt-2 border-t border-stone-100">
	            <button
	              onClick={() => setShowNewLineModal(true)}
	              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-stone-900 py-2 text-sm font-semibold text-white hover:bg-stone-700 transition-colors"
	            >
	              <span className="text-base leading-none">+</span>
	              New Line
	            </button>
	          </div>
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
          <div className="pointer-events-auto flex flex-col overflow-hidden rounded-xl border border-indigo-200 bg-indigo-50 shadow-sm">
            <div className="flex items-center gap-3 px-4 py-2.5 text-sm text-indigo-700">
              <span>{snapProgress?.routeId === addStationToLine ? "Placing…" : "Click map to add station"}</span>
              <span className="h-4 w-px bg-indigo-200" />
              <button
                onClick={() => setAddStationToLine(null)}
                className="font-semibold hover:text-indigo-900 transition-colors"
              >
                Done
              </button>
            </div>
            {snapProgress?.routeId === addStationToLine && (
              <div className="h-0.5 bg-indigo-100">
                <div
                  className="h-full bg-indigo-400 transition-[width] duration-500 ease-out"
                  style={{ width: `${snapProgress.pct}%` }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add-portal notification — below top-center toolbar */}
      {addPortalToLine && (
        <div className="pointer-events-none absolute top-[85px] left-0 right-0 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-stone-300 bg-stone-800 px-4 py-2.5 text-sm text-white shadow-sm">
            <span>Click route to place portal marker</span>
            <span className="h-4 w-px bg-stone-600" />
            <button
              onClick={() => setAddPortalToLine(null)}
              className="font-semibold hover:text-stone-300 transition-colors"
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
          className={`pointer-events-auto flex h-13 items-center gap-3 rounded-xl border border-[#D7D7D7] bg-white px-6 text-base font-normal shadow-sm transition-all ${
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
          className={`pointer-events-auto flex h-13 items-center gap-3 rounded-xl border border-[#D7D7D7] bg-white px-6 text-base font-normal shadow-sm transition-all disabled:cursor-wait ${
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
        <div className="pointer-events-auto flex h-13 items-center gap-1 rounded-xl border border-[#D7D7D7] bg-white px-2 shadow-sm">
          {/* Normal (default/view — no active tool) */}
          <div className="group relative">
            <button
              onClick={() => handleSetDrawMode("normal")}
              className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
                drawMode === "normal" ? "bg-stone-100 text-stone-900" : "text-stone-400 hover:bg-stone-50 hover:text-stone-700"
              }`}
            >
              {/* Arrow cursor */}
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4.5 w-4.5">
                <path d="M4 1.5 L4 17 L8 13 L11 19 L13 18 L10 12 L16 12 Z" />
              </svg>
            </button>
            <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-md bg-stone-800 px-2 py-1 text-xs whitespace-nowrap text-white opacity-0 transition-opacity group-hover:opacity-100">
              Explore mode
              <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-stone-800" />
            </div>
          </div>

          <div className="mx-1 h-6 w-px bg-stone-200" />

          {/* Select neighbourhoods */}
          <div className="group relative">
            <button
              onClick={() => handleSetDrawMode("select")}
              className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
                drawMode === "select" ? "bg-indigo-50 text-indigo-600" : "text-stone-400 hover:bg-stone-50 hover:text-stone-700"
              }`}
            >
              {/* Cursor + dashed selection box — indicates click-to-select-region */}
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4.5 w-4.5">
                <path d="M2.5 1.5 L2.5 12.5 L5.5 9.5 L7.5 14 L9 13.3 L7 8.8 L11 8.8 Z" />
                <rect x="11.5" y="11" width="7" height="7" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 1.2" />
              </svg>
            </button>
            <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-md bg-stone-800 px-2 py-1 text-xs whitespace-nowrap text-white opacity-0 transition-opacity group-hover:opacity-100">
              Select neighbourhoods
              <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-stone-800" />
            </div>
          </div>

          {/* Polygon boundary (temporarily hidden) */}
          {/*
          <div className="mx-1 h-6 w-px bg-stone-200" />

          
           <div className="group relative">
            <button
              onClick={() => handleSetDrawMode("boundary")}
              className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
                drawMode === "boundary" ? "bg-indigo-50 text-indigo-600" : "text-stone-400 hover:bg-stone-50 hover:text-stone-700"
              }`}
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" className="h-4 w-4">
                <polygon points="10,2 17,6.5 14.5,16 5.5,16 3,6.5" strokeWidth="1.6" strokeLinejoin="round" strokeDasharray="2.5 1.5" />
                <circle cx="10" cy="2" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="17" cy="6.5" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="14.5" cy="16" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="5.5" cy="16" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="3" cy="6.5" r="1.4" fill="currentColor" stroke="none" />
              </svg>
            </button>
            <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-md bg-stone-800 px-2 py-1 text-xs whitespace-nowrap text-white opacity-0 transition-opacity group-hover:opacity-100">
              Draw boundary
              <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-stone-800" />
            </div>
          </div> */}

          {/* Undo / Redo */}
          <div className="mx-1 h-6 w-px bg-stone-200" />
          <div className="group relative">
            <button
              onClick={handleUndo}
              disabled={!canUndo}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-stone-400 transition-all hover:bg-stone-50 hover:text-stone-700 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <path d="M3 9a6 6 0 1 1 1.5 4" />
                <polyline points="3 4 3 9 8 9" />
              </svg>
            </button>
            <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-md bg-stone-800 px-2 py-1 text-xs whitespace-nowrap text-white opacity-0 transition-opacity group-hover:opacity-100">
              Undo <span className="opacity-60">⌘Z</span>
              <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-stone-800" />
            </div>
          </div>
          <div className="group relative">
            <button
              onClick={handleRedo}
              disabled={!canRedo}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-stone-400 transition-all hover:bg-stone-50 hover:text-stone-700 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <path d="M17 9a6 6 0 1 0-1.5 4" />
                <polyline points="17 4 17 9 12 9" />
              </svg>
            </button>
            <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-md bg-stone-800 px-2 py-1 text-xs whitespace-nowrap text-white opacity-0 transition-opacity group-hover:opacity-100">
              Redo <span className="opacity-60">⌘⇧Z</span>
              <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-stone-800" />
            </div>
          </div>

          {/* Clear button — visible when there's a drawn boundary or selected neighbourhoods */}
          {hasSelection && (
            <>
              <div className="mx-1 h-6 w-px bg-stone-200" />
              <div className="group relative">
                <button
                  onClick={handleClearAll}
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-stone-400 transition-all hover:bg-red-50 hover:text-red-500"
                >
                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                    <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193v-.443A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z" clipRule="evenodd" />
                  </svg>
                </button>
                <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-md bg-stone-800 px-2 py-1 text-xs whitespace-nowrap text-white opacity-0 transition-opacity group-hover:opacity-100">
                  Clear selection
                  <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-stone-800" />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Drawing hint — shown while actively drawing a polygon */}
        {drawMode === "boundary" && (
          <div className="pointer-events-auto absolute top-0 left-full ml-2 flex h-13 items-center gap-3 whitespace-nowrap rounded-xl border border-stone-200 bg-white px-4 text-sm text-stone-500 shadow-sm">
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

        </div>
      </div>

      {(selectedNeighbourhoods.size > 0 || selectedStations.size > 0) && !addStationToLine && (
        <div className="pointer-events-none absolute top-[85px] left-0 right-0 flex justify-center">
          <div className="pointer-events-auto flex items-center rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm text-indigo-700 shadow-sm">
            {selectedNeighbourhoods.size} neighbourhood{selectedNeighbourhoods.size !== 1 ? "s" : ""}, {selectedStations.size} station{selectedStations.size !== 1 ? "s" : ""} selected
          </div>
        </div>
      )}

      {/* Side panel — only one shown at a time to prevent overlap */}
      <div
        className={`pointer-events-none absolute right-6 bottom-6 flex items-stretch transition-all duration-300 ease-in-out ${
          selectedRoute || showGeneratedPanel ? "translate-x-0" : "translate-x-[calc(100%+2.25rem)]"
        }`}
        style={{ top: "80px" }}
      >
        {selectedRoute ? (
          <RoutePanel
            route={selectedRoute}
            selectedStop={selectedStop}
            stationPopulations={stationPopulations}
            onDeleteStop={(name) => handleDeleteStop(name, selectedRoute.id)}
            onDeleteLine={() => handleDeleteCustomLine(selectedRoute.id)}
            onSnapToRoads={routes.some((r) => r.id === selectedRoute.id)
              ? () => handleSnapToRoads(selectedRoute)
              : undefined}
            onAddPortal={routes.some((r) => r.id === selectedRoute.id)
              ? () => { setAddPortalToLine(selectedRoute.id); addPortalToLineRef.current = selectedRoute.id; }
              : undefined}
            onClose={() => { setSelectedRoute(null); setSelectedStop(null); }}
          />
        ) : showGeneratedPanel ? (
          <GeneratedRoutePanel
            route={generatedRoute!}
            disabledStops={disabledStops}
            selectedStop={selectedGeneratedStop}
            onToggleStop={handleToggleStop}
            onSelectStop={setSelectedGeneratedStop}
            onRename={(name: string) => setGeneratedRoute((r) => r ? { ...r, name } : r)}
            onDelete={() => setGeneratedRoute(null)}
            onClose={() => setGeneratedRoute(null)}
          />
        ) : null}
      </div>

      {/* Custom map controls — bottom right */}
      <div
        className="pointer-events-none absolute bottom-6 flex flex-col gap-1 transition-[right] duration-300 ease-in-out"
        style={{ right: selectedRoute || showGeneratedPanel ? "354px" : "24px" }}
      >
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
          className={`pointer-events-auto flex h-[38px] w-[38px] items-center justify-center rounded-xl shadow transition-all ${
            isBirdsEye ? "bg-stone-800 text-white" : "bg-white text-stone-600 hover:bg-stone-50"
          }`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
        {/* Zoom controls */}
        <div className="pointer-events-auto flex flex-col overflow-hidden rounded-xl shadow">
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

      {/* Generate Route / View Council — bottom centre */}
      {(hasSelection || councilHasRun) && (
        <div className="pointer-events-none absolute bottom-16 left-0 right-0 flex flex-col items-center gap-2">
          {hasSelection && !councilOpen && (
            <p className="text-[11px] text-stone-500 bg-white/80 rounded-full px-3 py-0.5 shadow-sm">Experimental feature</p>
          )}
          <div className="flex gap-3">
          {hasSelection && !councilOpen && (
            <button
              onClick={handleGenerate}
              className="pointer-events-auto flex h-13 items-center gap-3 rounded-xl bg-stone-900 px-8 text-base font-medium text-white shadow-lg transition-all hover:bg-stone-800"
            >
              <span className="text-xl">✦</span>
              Generate Route
            </button>
          )}
          {councilHasRun && !councilOpen && (
            <button
              onClick={handleViewCouncil}
              className="pointer-events-auto flex h-13 items-center gap-3 rounded-xl border border-stone-300 bg-white px-6 text-base font-medium text-stone-700 shadow-lg transition-all hover:bg-stone-50"
            >
              <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 2"/>
              </svg>
              View Council
            </button>
          )}
          </div>
        </div>
      )}


      {/* Station popup */}
      {stationPopup && (
        <StationPopup
          popup={stationPopup}
          allRoutes={routes}
          stationPopulations={stationPopulations}
          isDeletable={true}
          connectedRoutes={
            routes.filter((r) =>
              r.id !== stationPopup.routeId &&
              r.stops.some((s) => s.name === stationPopup.name)
            )
          }
          onRemoveTransfer={(targetRouteId) => {
            handleDeleteStop(stationPopup.name, targetRouteId);
          }}
          onClose={() => setStationPopup(null)}
          onDelete={() => { handleDeleteStop(stationPopup.name, stationPopup.routeId); setStationPopup(null); }}
          onAddTransfer={(targetRouteId) => {
            const { name, coords } = stationPopup;
            // Add this station to the target route's stops (terminus-aware)
            snapshotHistory();
            setRoutes((prev) => prev.map((r) => {
              if (r.id !== targetRouteId) return r;
              // Skip if already present
              if (r.stops.some((s) => s.name === name)) return r;
              const newStop = { name, coords };
              if (r.stops.length === 0) return { ...r, stops: [newStop] };
              const first = r.stops[0]!;
              const last = r.stops[r.stops.length - 1]!;
              const dFirst = haversineKm(coords, first.coords);
              const dLast  = haversineKm(coords, last.coords);
              return { ...r, stops: dFirst < dLast ? [newStop, ...r.stops] : [...r.stops, newStop] };
            }));
            setStationPopup(null);
          }}
        />
      )}


      {/* Chat panel — bottom right, above zoom controls */}
      <ChatPanel
        open={councilOpen}
        onClose={() => setCouncilOpen(false)}
        startNew={councilStartNew}
        neighbourhoodNames={
          [...selectedNeighbourhoods].map(
            (code) => neighbourhoodsGeoJSONRef.current?.features.find(
              (f) => f.properties?.AREA_SHORT_CODE === code
            )?.properties?.AREA_NAME ?? code
          )
        }
        stationNames={[...selectedStations].map((s) => s.split("::")[0]!)}
        existingLineStops={routes.flatMap((r) =>
          r.stops.map((s) => ({ name: s.name, coords: s.coords, route: r.name }))
        )}
        routePanelOpen={generatedRoute !== null}
        onRoutePreview={(routes) => setCouncilPreview(routes)}
        onToolCall={(evt) => onToolCallRef.current(evt)}
        onAddRoute={(parsed: ParsedRoute) => {
          const id = `custom-${customLineCounterRef.current++}`;
          const stops = parsed.stops;
          let totalKm = 0;
          for (let i = 1; i < stops.length; i++) {
            totalKm += haversineKm(stops[i - 1]!.coords, stops[i]!.coords);
          }
          const costPerKm = parsed.type === "subway" ? 500 : (parsed.type === "streetcar" || parsed.type === "lrt") ? 80 : 4;
          const costM = Math.round(totalKm * costPerKm);
          const costStr = costM >= 1000 ? `$${(costM / 1000).toFixed(1)}B` : `$${costM}M`;
          const buildYears = parsed.type === "subway" ? Math.ceil(totalKm * 1.2 + 3) : (parsed.type === "streetcar" || parsed.type === "lrt") ? Math.ceil(totalKm * 0.6 + 2) : Math.ceil(totalKm * 0.1 + 1);
          const prRaw = parsed.prScore ?? 20;
          const prNorm = Math.round((prRaw / 40) * 10);
          const approvalChance = Math.max(15, Math.min(92, 85 - prRaw * 1.5));
          const minutesSaved = Math.round(totalKm * (parsed.type === "subway" ? 3.5 : 2));
          const dollarsSaved = `$${(minutesSaved * 0.3).toFixed(1)}/trip`;
          const newCustomLine: Route = {
            id,
            name: parsed.name,
            shortName: parsed.name.slice(0, 2).toUpperCase(),
            color: parsed.color,
            textColor: "#ffffff",
            type: parsed.type,
            description: `${costStr} · ${buildYears}yr build · Approval ${Math.round(approvalChance)}% · PR ${prNorm}/10`,
            frequency: `−${minutesSaved}min commute`,
            stops: parsed.stops,
          };
          setRoutes((prev) => [...prev, newCustomLine]);
          // Also set generatedRoute for the stats panel
          setGeneratedRoute({
            id,
            name: parsed.name,
            shortName: parsed.name.slice(0, 2).toUpperCase(),
            textColor: "#ffffff",
            description: `${costStr} · ${buildYears}yr build`,
            frequency: `−${minutesSaved}min commute`,
            color: parsed.color,
            type: parsed.type,
            stops: parsed.stops,
            stats: {
              cost: costStr,
              timeline: `${buildYears} yrs`,
              costedTimeline: `${Math.ceil(buildYears * 1.3)} yrs w/ contingency`,
              minutesSaved,
              dollarsSaved,
              percentageChance: Math.round(approvalChance),
              prNightmareScore: prNorm,
            },
          });
          setCouncilHasRun(true);
        }}
      />

      {/* Import / Export — top right */}
      <div className="pointer-events-none absolute top-5 right-6 z-10 flex items-start gap-2">

        {/* ── Wide screens: two full-width buttons ── */}
        <button
          onClick={handleImport}
          className="pointer-events-auto hidden lg:flex h-13 items-center gap-2 rounded-xl border border-[#D7D7D7] bg-white px-4 text-base font-normal text-stone-500 shadow-sm hover:text-stone-800 transition-colors"
        >
          <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2v8M5 7l3 3 3-3"/><rect x="2" y="11" width="12" height="3" rx="1" fill="none"/>
          </svg>
          Import
        </button>
        <div className="pointer-events-auto hidden lg:flex flex-col gap-1.5">
          <button
            onClick={handleExport}
            disabled={exportProgress !== null}
            className="flex h-13 items-center gap-2 rounded-xl border border-[#D7D7D7] bg-white px-4 text-base font-normal text-stone-500 shadow-sm hover:text-stone-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 10V2M5 5l3-3 3 3"/><rect x="2" y="11" width="12" height="3" rx="1" fill="none"/>
            </svg>
            Export
            {hasUnsaved && (
              <span className="ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title="Unsaved changes" />
            )}
          </button>
          {exportProgress !== null && (
            <div className="h-1 w-full overflow-hidden rounded-full bg-stone-200">
              <div
                className="h-full rounded-full bg-stone-700 transition-all duration-150"
                style={{ width: `${exportProgress}%` }}
              />
            </div>
          )}
        </div>

        {/* ── Narrow screens: single icon button → dropdown ── */}
        <div ref={ieDropdownRef} className="pointer-events-auto relative lg:hidden">
          <button
            onClick={() => setShowIEDropdown((v) => !v)}
            className="flex h-13 w-13 items-center justify-center rounded-xl border border-[#D7D7D7] bg-white text-stone-500 shadow-sm hover:text-stone-800 transition-colors"
            aria-label="Import / Export"
          >
            {/* Upload/download stacked arrows */}
            <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 6l3-3 3 3M11 10l-3 3-3-3"/>
            </svg>
            {hasUnsaved && (
              <span className="absolute top-2 right-2 h-1.5 w-1.5 rounded-full bg-amber-400" />
            )}
          </button>

          {showIEDropdown && (
            <div className="absolute right-0 top-full mt-1.5 w-44 overflow-hidden rounded-xl border border-[#D7D7D7] bg-white shadow-lg">
              <button
                onClick={() => { setShowIEDropdown(false); handleImport(); }}
                className="flex w-full items-center gap-3 px-4 py-3 text-sm text-stone-500 hover:bg-stone-50 hover:text-stone-800 transition-colors"
              >
                <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 2v8M5 7l3 3 3-3"/><rect x="2" y="11" width="12" height="3" rx="1" fill="none"/>
                </svg>
                Import
              </button>
              <div className="mx-3 h-px bg-stone-100" />
              <button
                onClick={() => { setShowIEDropdown(false); handleExport(); }}
                disabled={exportProgress !== null}
                className="flex w-full items-center gap-3 px-4 py-3 text-sm text-stone-500 hover:bg-stone-50 hover:text-stone-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 10V2M5 5l3-3 3 3"/><rect x="2" y="11" width="12" height="3" rx="1" fill="none"/>
                </svg>
                Export
                {hasUnsaved && (
                  <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                )}
              </button>
              {exportProgress !== null && (
                <div className="mx-3 mb-2 h-1 overflow-hidden rounded-full bg-stone-200">
                  <div
                    className="h-full rounded-full bg-stone-700 transition-all duration-150"
                    style={{ width: `${exportProgress}%` }}
                  />
                </div>
              )}
            </div>
          )}
        </div>

      </div>


      {/* Import confirmation modal */}
      {pendingImportFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="mx-6 w-full max-w-md rounded-2xl border border-[#D7D7D7] bg-white p-8 shadow-2xl">
            <div className="mb-4 flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100">
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5 text-amber-600">
                  <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd"/>
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-stone-800">Replace current data?</p>
                <p className="mt-1 text-sm leading-relaxed text-stone-500">
                  Importing <span className="font-medium text-stone-700">{pendingImportFile.name}</span> will remove all custom lines and stop edits. This cannot be undone.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingImportFile(null)}
                className="rounded-xl border border-[#D7D7D7] px-5 py-2 text-sm font-medium text-stone-600 hover:text-stone-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => confirmImport(pendingImportFile)}
                className="rounded-xl bg-stone-800 px-5 py-2 text-sm font-medium text-white hover:bg-stone-700 transition-colors"
              >
                Replace & import
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import error modal */}
      {importError && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="mx-6 w-full max-w-md rounded-2xl border border-[#D7D7D7] bg-white p-8 shadow-2xl">
            <div className="mb-4 flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-100">
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5 text-red-600">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm-.75-10.5a.75.75 0 011.5 0v4a.75.75 0 01-1.5 0v-4zm.75 7a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd"/>
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-stone-800">Import failed</p>
                <p className="mt-1 text-sm leading-relaxed text-stone-500">{importError}</p>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => setImportError(null)}
                className="rounded-xl bg-stone-800 px-5 py-2 text-sm font-medium text-white hover:bg-stone-700 transition-colors"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* GTFS Validation modal */}
      {/* GTFS validation — success toast (near export button) */}
      {validationResult?.result.valid && (
        <div className="pointer-events-auto absolute top-20 right-6 z-50 w-72 rounded-xl border border-[#D7D7D7] bg-white p-4 shadow-lg">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-green-100">
              <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 text-green-600" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2.5,8.5 6,12 13.5,4" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-stone-800">
                {validationResult.context === "export" ? "Exported" : "Imported"} successfully
              </p>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-stone-500">
                <span>{validationResult.result.stats.routes} routes</span>
                <span>{validationResult.result.stats.trips} trips</span>
                <span>{validationResult.result.stats.stops} stops</span>
                {validationResult.result.stats.shapes > 0 && (
                  <span>{validationResult.result.stats.shapes} shape pts</span>
                )}
              </div>
            </div>
            <button
              onClick={() => setValidationResult(null)}
              className="ml-1 shrink-0 text-stone-400 hover:text-stone-700 transition-colors"
              aria-label="Dismiss"
            >
              <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* GTFS validation — error/warning full modal */}
      {validationResult && !validationResult.result.valid && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="mx-6 w-full max-w-lg rounded-2xl border border-[#D7D7D7] bg-white p-8 shadow-2xl">
            <div className="mb-5 flex items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-100">
                <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4 text-red-600" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="8" cy="8" r="6" />
                  <line x1="8" y1="5" x2="8" y2="8.5" />
                  <circle cx="8" cy="11" r="0.5" fill="currentColor" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-base font-semibold text-stone-800">
                  GTFS Validation — {validationResult.context === "export" ? "Export" : "Import"}
                  {validationResult.context === "import" && " blocked"}
                </p>
                {/* Stats row */}
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-stone-500">
                  <span>{validationResult.result.stats.routes} routes</span>
                  <span>{validationResult.result.stats.trips} trips</span>
                  <span>{validationResult.result.stats.stops} stops</span>
                  <span>{validationResult.result.stats.stopTimes.toLocaleString()} stop-times</span>
                  {validationResult.result.stats.shapes > 0 && (
                    <span>{validationResult.result.stats.shapes} shape pts</span>
                  )}
                </div>
                {/* Issue counts */}
                <div className="mt-2 flex gap-3 text-sm">
                  {(() => {
                    const errors   = validationResult.result.issues.filter((i) => i.severity === "error").length;
                    const warnings = validationResult.result.issues.filter((i) => i.severity === "warning").length;
                    return (
                      <>
                        {errors > 0   && <span className="font-medium text-red-600">{errors} error{errors !== 1 ? "s" : ""}</span>}
                        {warnings > 0 && <span className="font-medium text-amber-600">{warnings} warning{warnings !== 1 ? "s" : ""}</span>}
                      </>
                    );
                  })()}
                </div>
              </div>
            </div>

            {/* Issue list */}
            {validationResult.result.issues.length > 0 && (
              <ul className="mb-5 max-h-56 overflow-y-auto space-y-1.5 rounded-xl bg-stone-50 p-3">
                {validationResult.result.issues.map((issue, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className={`mt-px shrink-0 font-mono font-semibold ${issue.severity === "error" ? "text-red-500" : "text-amber-500"}`}>
                      {issue.code}
                    </span>
                    <span className="text-stone-600 leading-relaxed">{issue.message}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex justify-end">
              <button
                onClick={() => setValidationResult(null)}
                className="rounded-xl bg-stone-800 px-5 py-2 text-sm font-medium text-white hover:bg-stone-700 transition-colors"
              >
                {validationResult.context === "import" ? "Cancel import" : "Dismiss"}
              </button>
            </div>
          </div>
        </div>
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
            setRoutes((prev) => [...prev, newRoute]);
            handleSetDrawMode("normal");
            setAddStationToLine(id);
            setShowNewLineModal(false);
          }}
        />
      )}
    </div>
  );
}
