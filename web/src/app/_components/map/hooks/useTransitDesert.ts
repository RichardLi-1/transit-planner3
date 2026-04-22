// Transit Desert Finder hook
// Computes a composite "desert severity" score per population cell and renders
// it as a heatmap. Red = high population with poor transit access. White/transparent = well served.
//
// Design note: user-drawn routes are included as inputs alongside the built-in TTC/GO routes.
// This makes the feature interactive — drawing a new line in an underserved area updates the map.

import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { haversineKm } from "~/app/map/geo-utils";
import type { PopRow } from "~/app/map/geo-utils";
import { ROUTES } from "~/app/map/transit-data";
import type { Route } from "~/app/map/transit-data";
import { trackEvent } from "~/lib/analytics";

// 📖 Learn: mode weight — not all transit is equal. A subway stop at 500m is
// more valuable than a bus stop at 500m because of reliability, speed, capacity.
const MODE_WEIGHT: Record<string, number> = {
  subway: 1.0,
  lrt: 1.0,
  go_train: 0.9,
  streetcar: 0.8,
  bus: 0.5,
};

function computeDesertScores(
  popRows: PopRow[],
  allRoutes: Route[],
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  // Flatten all routes into a list of annotated stop entries.
  // Each stop carries its route's headway and mode weight — the two service quality signals.
  type StopEntry = {
    coords: [number, number];
    headwayMin: number;
    modeWeight: number;
    routeId: string;
  };

  const stopEntries: StopEntry[] = [];
  for (const route of allRoutes) {
    const modeWeight = MODE_WEIGHT[route.type] ?? 0.5;
    // User-drawn routes don't have a servicePattern yet, so we assume 30min headway (typical bus)
    const headwayMin = route.servicePattern?.headwayMinutes ?? 30;
    for (const stop of route.stops) {
      stopEntries.push({ coords: stop.coords, headwayMin, modeWeight, routeId: route.id });
    }
  }

  // Log-normalize population density so sparse rural and dense urban cells
  // are on the same 0–1 scale. Same method as useHeatmap.ts.
  const densities = popRows.map((r) => (r.area > 0 ? r.population / r.area : 0));
  const logDensities = densities.map((d) => (d > 0 ? Math.log1p(d) : 0));
  const maxLog = Math.max(1, ...logDensities);

  const features: GeoJSON.Feature<GeoJSON.Point>[] = popRows.map((row, i) => {
    const pt: [number, number] = [row.longitude, row.latitude];
    const densityNorm = logDensities[i]! / maxLog;

    if (stopEntries.length === 0) {
      // No stops at all — maximum desert severity proportional to density
      return {
        type: "Feature",
        properties: { desert_severity: densityNorm },
        geometry: { type: "Point", coordinates: pt },
      };
    }

    // Scan all stops to find the nearest, and count distinct routes within 800m
    let nearestDist = Infinity;
    let nearestHeadway = 60;
    let nearestModeWeight = 0.5;
    const routesNearby = new Set<string>();

    for (const entry of stopEntries) {
      const d = haversineKm(pt, entry.coords);
      if (d < nearestDist) {
        nearestDist = d;
        nearestHeadway = entry.headwayMin;
        nearestModeWeight = entry.modeWeight;
      }
      // 📖 Learn: 800m is the standard "transit walkshed" — roughly 10 min walk
      if (d <= 0.8) routesNearby.add(entry.routeId);
    }

    // distance_penalty: 400m is the comfortable walking baseline (penalty = 2.0 at 400m).
    // Beyond that it grows linearly — a 1km walk has penalty 3.5, 2km has 6.0.
    const distancePenalty = 1 + nearestDist / 0.4;

    // frequency_score: perfect service at ≤10min headway = 1.0; hourly bus = 0.17
    const frequencyScore = Math.min(1, 10 / Math.max(1, nearestHeadway));

    // connectivity_bonus: each additional route within 800m adds 10% (up to 1.5×).
    // A cell with 5 routes is harder to strand than one with only a single bus.
    const connectivityBonus = Math.min(1.5, 1 + (routesNearby.size - 1) * 0.1);

    // Composite access score — the product of quality signals divided by distance cost
    const accessScore = Math.min(
      1,
      (frequencyScore * nearestModeWeight * connectivityBonus) / distancePenalty,
    );

    // Desert severity = how much population is underserved
    // High density + low access = deep desert; low density or good access = near zero
    const desertSeverity = densityNorm * (1 - accessScore);

    return {
      type: "Feature",
      properties: { desert_severity: desertSeverity },
      geometry: { type: "Point", coordinates: pt },
    };
  });

  return { type: "FeatureCollection", features };
}

export function useTransitDesert(
  mapRef: RefObject<mapboxgl.Map | null>,
  mapLoaded: boolean,
  popRawData: PopRow[],
  userRoutes: Route[],
) {
  const [showTransitDesert, setShowTransitDesert] = useState(false);
  const [isComputing, setIsComputing] = useState(false);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const SRC = "transit-desert-src";
    const LAYER = "transit-desert-layer";

    if (!showTransitDesert) {
      if (map.getLayer(LAYER)) map.removeLayer(LAYER);
      if (map.getSource(SRC)) map.removeSource(SRC);
      return;
    }

    if (popRawData.length === 0) return;

    setIsComputing(true);

    // 📖 Learn: setTimeout(fn, 0) — defers the heavy computation to the next event
    // loop tick. This lets React flush the setIsComputing(true) re-render first,
    // so the UI shows "Computing…" before the main thread becomes busy.
    const timer = setTimeout(() => {
      const allRoutes = [...ROUTES, ...userRoutes];
      const fc = computeDesertScores(popRawData, allRoutes);

      if (map.getLayer(LAYER)) map.removeLayer(LAYER);
      if (map.getSource(SRC)) map.removeSource(SRC);

      // Insert below label layers so street names remain readable
      const firstLabelLayer = map
        .getStyle()
        ?.layers?.find(
          (l) => l.type === "symbol" && (l.layout as Record<string, unknown>)?.["text-field"],
        )?.id;

      map.addSource(SRC, { type: "geojson", data: fc });
      map.addLayer(
        {
          id: LAYER,
          type: "heatmap",
          source: SRC,
          paint: {
            // desert_severity (0–1) drives how "hot" each point is
            "heatmap-weight": ["interpolate", ["linear"], ["get", "desert_severity"], 0, 0, 1, 1],
            "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 10, 0.6, 13, 1.2],
            "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 10, 12, 12, 30, 14, 55],
            // Color scale: transparent → yellow → orange → deep red
            "heatmap-color": [
              "interpolate",
              ["linear"],
              ["heatmap-density"],
              0, "rgba(0,0,0,0)",
              0.15, "rgba(255,255,178,0.3)",
              0.4, "rgba(253,174,97,0.65)",
              0.7, "rgba(227,26,28,0.85)",
              1, "rgba(165,0,38,1)",
            ],
            "heatmap-opacity": 0.85,
          },
        },
        firstLabelLayer,
      );

      trackEvent("Transit Desert Computed", {
        population_points: popRawData.length,
        total_routes_considered: allRoutes.length,
        total_stops_considered: allRoutes.reduce((sum, route) => sum + route.stops.length, 0),
      });

      setIsComputing(false);
    }, 0);

    return () => clearTimeout(timer);
  }, [showTransitDesert, mapLoaded, popRawData, userRoutes]);

  return { showTransitDesert, setShowTransitDesert, isComputing };
}
