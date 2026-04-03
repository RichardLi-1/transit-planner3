//This hook is for GTFS live

import { useEffect, useState } from "react";
import type { RefObject } from "react";
import mapboxgl from "mapbox-gl";
import { ROUTES } from "~/app/map/transit-data";

// Convert a compass bearing in degrees (0 = North, clockwise) to a short direction label.
// 📖 Learn: Math.round(deg / 45) % 8 maps 360° into 8 buckets of 45° each.
function bearingToCompass(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8] ?? "N";
}


export function useLiveVehicles(mapRef: RefObject<mapboxgl.Map | null>, mapLoaded: boolean) {
    const [showLiveVehicles, setShowLiveVehicles] = useState(false);
    const [vehiclesUpdatedAt, setVehiclesUpdatedAt] = useState<number | null>(null);
    
    
    // ── live vehicles layer ────────────────────────────────────────────────────
    useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const SRC = "live-vehicles-src", LAYER = "live-vehicles-layer";
    const cleanup = () => {
        if (map.getLayer(LAYER)) map.removeLayer(LAYER);
        if (map.getSource(SRC)) map.removeSource(SRC);
    };
    if (!showLiveVehicles) { cleanup(); return; }

    const emptyFC: GeoJSON.FeatureCollection<GeoJSON.Point> = { type: "FeatureCollection", features: [] };
    map.addSource(SRC, { type: "geojson", data: emptyFC });
    map.addLayer({
        id: LAYER, type: "circle", source: SRC,
        paint: {
        "circle-radius": 6,
        "circle-color": "#ef4444",
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
        "circle-opacity": 0.9,
        },
    });

    map.on("mouseenter", LAYER, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", LAYER, () => { map.getCanvas().style.cursor = ""; });

    let popup: mapboxgl.Popup | null = null;
    const onClick = (e: mapboxgl.MapMouseEvent & { features?: mapboxgl.MapboxGeoJSONFeature[] }) => {
        const f = e.features?.[0];
        if (!f) return;
        const { routeId, label, bearing, tripId } = f.properties as {
          routeId: string; label: string; bearing: number | null; tripId: string;
        };
        const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];

        // Look up the full route name from the static ROUTES data using shortName or id
        // 📖 Learn: TTC GTFS routeId values are numeric strings like "7" matching shortName
        const knownRoute = ROUTES.find((r) => r.shortName === routeId || r.id === routeId);
        const routeName = knownRoute?.name ?? "";
        const compassDir = bearing != null ? bearingToCompass(bearing) : null;
        // Trip IDs are long (e.g. "240403-7-0001") — show just the last segment for readability
        const shortTripId = tripId ? tripId.split("-").slice(-2).join("-") : null;

        popup?.remove();
        popup = new mapboxgl.Popup({ closeButton: true, closeOnClick: true, offset: 10, className: "vehicle-popup" })
        .setLngLat(coords)
        .setHTML(
            `<div style="font-family:sans-serif;font-size:12px;line-height:1.6;padding:2px 4px;min-width:130px">` +
            `<div style="font-weight:700;font-size:13px;margin-bottom:2px">` +
            `Route ${routeId || "—"}${routeName ? ` · ${routeName}` : ""}` +
            `</div>` +
            `<div style="color:#555">Vehicle #${label || "—"}${compassDir ? ` · heading ${compassDir}` : ""}</div>` +
            (shortTripId ? `<div style="color:#aaa;font-size:10px;margin-top:2px">Trip ${shortTripId}</div>` : "") +
            `</div>`
        )
        .addTo(map);
    };
    map.on("click", LAYER, onClick);

    const fetchAndUpdate = async () => {
        try {
        const res = await fetch("/api/vehicles");
        if (!res.ok) return;
        const { vehicles } = await res.json() as {
          vehicles: Array<{ id: string; lat: number; lng: number; routeId?: string; label?: string; bearing?: number; tripId?: string }>
        };
        const fc: GeoJSON.FeatureCollection<GeoJSON.Point> = {
            type: "FeatureCollection",
            features: vehicles.map((v) => ({
            type: "Feature",
            properties: {
              id: v.id,
              routeId: v.routeId ?? "",
              label: v.label ?? "",
              bearing: v.bearing ?? null,
              tripId: v.tripId ?? "",
            },
            geometry: { type: "Point", coordinates: [v.lng, v.lat] },
            })),
        };
        (map.getSource(SRC) as mapboxgl.GeoJSONSource | undefined)?.setData(fc);
        setVehiclesUpdatedAt(Date.now());
        } catch { /* network error — silently skip */ }
    };

    void fetchAndUpdate();
    const interval = setInterval(() => void fetchAndUpdate(), 15_000);
    return () => { clearInterval(interval); popup?.remove(); map.off("click", LAYER, onClick); cleanup(); };
    }, [showLiveVehicles, mapLoaded]);

    
    return {
        vehiclesUpdatedAt,
        showLiveVehicles,
        setShowLiveVehicles
    }
}