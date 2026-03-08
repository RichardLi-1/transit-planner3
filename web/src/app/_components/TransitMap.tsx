"use client";

import MapboxDraw from "@mapbox/mapbox-gl-draw";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";
import mapboxgl from "mapbox-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { haversineKm, computeStationPopulations, type PopRow } from "~/app/map/geo-utils";
import {
  ROUTES,
  type GeneratedRoute,
  type Route,
} from "~/app/map/mock-data";
import { routeToGeoJSON, stopsToGeoJSON, geomBBox } from "./map/geo";
import { NeighbourhoodPanel } from "./map/NeighbourhoodPanel";
import { RoutePanel } from "./map/RoutePanel";
import { GeneratedRoutePanel } from "./map/GeneratedRoutePanel";
import { StationPopup } from "./map/StationPopup";
import { NewLineModal } from "./map/NewLineModal";

type DrawMode = "normal" | "select" | "boundary";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";
const TORONTO: [number, number] = [-79.3832, 43.6532];

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

  // ── line-editor state (declared before stationPopulations useMemo)
  const [addStationToLine, setAddStationToLine] = useState<string | null>(null);
  const [routeExtraStops, setRouteExtraStops] = useState<Map<string, { name: string; coords: [number, number] }[]>>(new Map());
  const [customLines, setCustomLines] = useState<Route[]>([]);

  // Voronoi: assign each population point to its nearest station (5 km cutoff)
  const stationPopulations = useMemo(() => {
    if (popRawData.length === 0) return new Map<string, number>();
    const allStops: { name: string; coords: [number, number] }[] = [];
    const seen = new Set<string>();
    const addStop = (stop: { name: string; coords: [number, number] }) => {
      const key = `${stop.name}@${stop.coords[0]},${stop.coords[1]}`;
      if (!seen.has(key)) { seen.add(key); allStops.push(stop); }
    };
    // Existing TTC routes
    for (const route of ROUTES) for (const stop of route.stops) addStop(stop);
    // Custom lines
    for (const route of customLines) for (const stop of route.stops) addStop(stop);
    // Extra stops added to any route (including custom lines)
    for (const stops of routeExtraStops.values()) for (const stop of stops) addStop(stop);
    return computeStationPopulations(popRawData, allStops, 5);
  }, [popRawData, customLines, routeExtraStops]);

  const [hasBoundary, setHasBoundary] = useState(false);
  const [selectedNeighbourhoods, setSelectedNeighbourhoods] = useState<Set<string>>(new Set());
  const [selectedStations, setSelectedStations] = useState<Set<string>>(new Set()); // "name::routeId"
  const [focusedNeighbourhood, setFocusedNeighbourhood] = useState<{ id: string; name: string; lat: number; lng: number; geometry: GeoJSON.Geometry | null } | null>(null);
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
    const allRoutes = [...ROUTES, ...customLinesRef.current];
    for (const key of selectedStationsRef.current) {
      const [stationName, routeId] = key.split("::");
      if (!stationName || !routeId) continue;
      const route = allRoutes.find((r) => r.id === routeId);
      const allStops = [...(route?.stops ?? []), ...(routeExtraStopsRef.current.get(routeId) ?? [])];
      const found = allStops.find((s) => s.name === stationName);
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
      `Total length: ${routeLengthKm.toFixed(1)} km | Stops: ${stops.length}`,
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
      stops,
      stats,
    });
    setIsGenerating(false);
  }

  function snapshotHistory() {
    historyRef.current.push({
      stops: new Map([...routeExtraStopsRef.current].map(([k, v]) => [k, [...v]])),
      counter: stopCounterRef.current,
    });
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

  function handleDeleteCustomLine(routeId: string) {
    const map = mapRef.current;
    if (map) {
      [`route-shadow-${routeId}`, `route-outline-${routeId}`, `route-line-${routeId}`, `stops-ring-${routeId}`, `stops-selected-${routeId}`, `stops-dot-${routeId}`].forEach((id) => {
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
      // Seed with any extra stops already set (e.g. from AI route generation)
      const seededExtra = routeExtraStopsRef.current.get(route.id) ?? [];
      const seededStops = [...route.stops, ...seededExtra];
      map.addSource(`route-${route.id}`, { type: "geojson", data: seededStops.length >= 2 ? routeToGeoJSON({ ...route, stops: seededStops, shape: undefined }) : routeToGeoJSON(route) });
      map.addSource(`stops-${route.id}`, { type: "geojson", data: stopsToGeoJSON({ ...route, stops: seededStops }) });
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
              Normal mode
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

          <div className="mx-1 h-6 w-px bg-stone-200" />

          {/* Polygon boundary */}
          <div className="group relative">
            <button
              onClick={() => handleSetDrawMode("boundary")}
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
            <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-md bg-stone-800 px-2 py-1 text-xs whitespace-nowrap text-white opacity-0 transition-opacity group-hover:opacity-100">
              Draw boundary
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

        {/* Selection badge — absolutely anchored to the right of the toolbar, doesn't shift layout */}
        {(selectedNeighbourhoods.size > 0 || selectedStations.size > 0) && (
          <div className="pointer-events-auto absolute top-0 left-full ml-2 flex h-13 items-center whitespace-nowrap rounded-xl border border-indigo-200 bg-indigo-50 px-4 text-sm font-medium text-indigo-700 shadow-sm">
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

      {/* Generate Route — bottom centre */}
      {hasSelection && (
        <div className="pointer-events-none absolute bottom-16 left-0 right-0 flex justify-center">
          <button
            onClick={() => void handleGenerateRoute()}
            disabled={isGenerating}
            className="pointer-events-auto flex h-13 items-center gap-3 rounded-xl bg-stone-900 px-8 text-base font-medium text-white shadow-lg transition-all hover:bg-stone-800 disabled:cursor-not-allowed"
          >
            {isGenerating ? (
              <>
                <span className="flex gap-[3px] items-center">
                  <span className="h-1.5 w-1.5 rounded-full bg-white animate-bounce [animation-delay:0ms]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-white animate-bounce [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-white animate-bounce [animation-delay:300ms]" />
                </span>
                Generating route…
              </>
            ) : (
              <>
                <span className="text-xl">✦</span>
                Generate Route
              </>
            )}
          </button>
        </div>
      )}

      {/* Station popup */}
      {stationPopup && (
        <StationPopup
          popup={stationPopup}
          allRoutes={[...ROUTES, ...customLines]}
          stationPopulations={stationPopulations}
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
