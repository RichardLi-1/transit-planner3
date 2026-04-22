import { useEffect, useState, useRef, useCallback } from 'react';
import type { RefObject } from 'react';
import { trackEvent } from "~/lib/analytics";


export function useIsochrone(
  mapRef: RefObject<mapboxgl.Map | null>, mapLoaded: boolean, TOKEN: string) {
    const [isoMode, setIsoMode] = useState<"walking" | "cycling" | "driving">("walking");
    const pickingIsochroneOriginRef = useRef(false);
    const [isochroneOrigin, setIsochroneOrigin] = useState<[number, number] | null>(null); // [lng, lat]
    const [isochroneMinutes, setIsochroneMinutes] = useState(30);
    const [pickingIsochroneOrigin, setPickingIsochroneOrigin] = useState(false);

    useEffect(() => {
        pickingIsochroneOriginRef.current = pickingIsochroneOrigin;
        const canvas = mapRef.current?.getCanvas();
        if (canvas) canvas.style.cursor = pickingIsochroneOrigin ? "crosshair" : "";
    }, [pickingIsochroneOrigin, mapRef]);

    // 📖 Learn: useCallback memoizes this function so it's only recreated when
    // its dependencies change — not on every render. Important if passed as an
    // event handler, since a new reference would attach a duplicate listener.
    const handleIsochroneOriginPicking = useCallback((map: mapboxgl.Map, e: mapboxgl.MapMouseEvent) => {
        if (pickingIsochroneOriginRef.current) {
          pickingIsochroneOriginRef.current = false;
          setPickingIsochroneOrigin(false);
          setIsochroneOrigin([e.lngLat.lng, e.lngLat.lat]);
          map.getCanvas().style.cursor = "";
        }
    }, []);

    // ── isochrone overlay ────────────────────────────────────────────────────────
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapLoaded) return;
        const SRC = "isochrone-source";
        const LAYERS = ["isochrone-fill-60", "isochrone-fill-45", "isochrone-fill-30", "isochrone-fill-15", "isochrone-outline"];
        const cleanup = () => {
            LAYERS.forEach((l) => { if (map.getLayer(l)) map.removeLayer(l); });
            if (map.getSource(SRC)) map.removeSource(SRC);
        };
        cleanup();
        if (!isochroneOrigin || !TOKEN) return;
        const [lng, lat] = isochroneOrigin;
        const mins = [15, 30, 45, 60].filter((m) => m <= isochroneMinutes);
        const url = `https://api.mapbox.com/isochrone/v1/mapbox/${isoMode}/${lng},${lat}?contours_minutes=${mins.join(",")}&polygons=true&access_token=${TOKEN}`;
        trackEvent("Isochrone Requested", {
          mode: isoMode,
          minutes: isochroneMinutes,
          contour_count: mins.length,
          origin_lng: Number(lng.toFixed(5)),
          origin_lat: Number(lat.toFixed(5)),
        });
        fetch(url)
            .then((r) => r.json())
            .then((geojson) => {
            if (!map.getSource(SRC)) {
                map.addSource(SRC, { type: "geojson", data: geojson });
            } else {
                (map.getSource(SRC) as mapboxgl.GeoJSONSource).setData(geojson);
                return;
            }
            const colors: Record<number, string> = { 15: "#10b981", 30: "#f59e0b", 45: "#ef4444", 60: "#7c3aed" };
            const beforeId = map.getLayer("neighbourhood-fill") ? "neighbourhood-fill" : undefined;
            // Draw largest to smallest so they stack correctly
            [...mins].reverse().forEach((m) => {
                map.addLayer({ id: `isochrone-fill-${m}`, type: "fill", source: SRC, filter: ["==", ["get", "contour"], m], paint: { "fill-color": colors[m] ?? "#888", "fill-opacity": 0.12 } }, beforeId);
            });
            map.addLayer({ id: "isochrone-outline", type: "line", source: SRC, paint: { "line-color": ["get", "color"], "line-width": 1.5, "line-opacity": 0.6 } }, beforeId);
            trackEvent("Isochrone Completed", {
              mode: isoMode,
              minutes: isochroneMinutes,
              contour_count: mins.length,
            });
            })
            .catch((e) => {
              trackEvent("Isochrone Failed", {
                mode: isoMode,
                minutes: isochroneMinutes,
                error: e instanceof Error ? e.message : "unknown",
              });
              console.warn("[isochrone] fetch failed", e);
            });
        return cleanup;
    }, [isochroneOrigin, isochroneMinutes, isoMode, mapLoaded]);



    return {
        handleIsochroneOriginPicking,
        isoMode,
        setIsoMode,
        pickingIsochroneOrigin,
        setIsochroneMinutes,
        setIsochroneOrigin,
        isochroneOrigin,
        isochroneMinutes,
        setPickingIsochroneOrigin
    }
  }
