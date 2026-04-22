// This hook manages the custom overlay layer on the map, allowing users to import KML/KMZ/SHP files and display them as GeoJSON layers. It also provides a function to trigger the file import dialog.

import { useEffect, useState } from "react";
// "import type" would be enough for type annotations, but we need the runtime
// LngLatBounds constructor, so we import the real module here.
import mapboxgl from "mapbox-gl";
import type { RefObject } from "react";
import { trackEvent } from "~/lib/analytics";

// 📖 Learn: LngLatBounds — Mapbox's helper for tracking a lat/lng bounding box.
// .extend() expands the box to include a new point; .isEmpty() checks if any points were added.
function getBoundsFromGeoJSON(geojson: GeoJSON.FeatureCollection): mapboxgl.LngLatBounds | null {
  const bounds = new mapboxgl.LngLatBounds();

  // Recursively walk any coordinate array — GeoJSON nests them differently per geometry type:
  // Point: [lng, lat], LineString: [[lng,lat],...], Polygon: [[[lng,lat],...]], etc.
  function extendFromCoords(coords: unknown): void {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number") {
      // Leaf node: this is an actual [lng, lat] pair
      bounds.extend([coords[0], coords[1]] as [number, number]);
    } else {
      coords.forEach(extendFromCoords);
    }
  }

  for (const feature of geojson.features) {
    const geom = feature.geometry as { coordinates?: unknown } | null;
    if (geom?.coordinates) extendFromCoords(geom.coordinates);
  }

  return bounds.isEmpty() ? null : bounds;
}

export function useOverlay(mapRef: RefObject<mapboxgl.Map | null>, mapLoaded: boolean) {
  const [customOverlay, setCustomOverlay] = useState<GeoJSON.FeatureCollection | null>(null);
  const [customOverlayName, setCustomOverlayName] = useState<string>("");
  // ── custom file overlay (KML / KMZ / SHP)
  useEffect(() => {

    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const SRC = "custom-overlay";
    const LAYERS = ["custom-overlay-fill", "custom-overlay-line", "custom-overlay-circle"] as const;
    for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SRC)) map.removeSource(SRC);
    if (!customOverlay) return;
    map.addSource(SRC, { type: "geojson", data: customOverlay });
    map.addLayer({
      id: "custom-overlay-fill",
      type: "fill",
      source: SRC,
      filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
      paint: { "fill-color": "#FF6B35", "fill-opacity": 0.2 },
    });
    map.addLayer({
      id: "custom-overlay-line",
      type: "line",
      source: SRC,
      filter: ["match", ["geometry-type"], ["LineString", "MultiLineString", "Polygon", "MultiPolygon"], true, false],
      paint: { "line-color": "#FF6B35", "line-width": 2, "line-opacity": 0.8 },
    });
    map.addLayer({
      id: "custom-overlay-circle",
      type: "circle",
      source: SRC,
      filter: ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
      paint: { "circle-color": "#FF6B35", "circle-radius": 5, "circle-opacity": 0.8 },
    });

    // Zoom the map to fit all the imported geometry.
    // maxZoom: 16 prevents zooming in absurdly close on a single point.
    const bounds = getBoundsFromGeoJSON(customOverlay);
    if (bounds) map.fitBounds(bounds, { padding: 50, maxZoom: 16 });
  }, [customOverlay, mapLoaded]);

  function handleOverlayImport() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".kml,.kmz,.shp";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      void (async () => {
        try {
          const ext = file.name.split(".").pop()?.toLowerCase();
          let geojson: GeoJSON.FeatureCollection;
          if (ext === "kml") {
            const text = await file.text();
            const { kml } = await import("@tmcw/togeojson");
            const dom = new DOMParser().parseFromString(text, "text/xml");
            geojson = kml(dom) as GeoJSON.FeatureCollection;
          } else if (ext === "kmz") {
            const JSZip = (await import("jszip")).default;
            const zip = await JSZip.loadAsync(file);
            const kmlEntry = Object.values(zip.files).find(
              (f) => !f.dir && f.name.toLowerCase().endsWith(".kml"),
            );
            if (!kmlEntry) throw new Error("No KML file found in KMZ archive");
            const text = await kmlEntry.async("string");
            const { kml } = await import("@tmcw/togeojson");
            const dom = new DOMParser().parseFromString(text, "text/xml");
            geojson = kml(dom) as GeoJSON.FeatureCollection;
          } else if (ext === "shp") {
            const shapefile = (await import("shapefile")).default;
            const buffer = await file.arrayBuffer();
            geojson = (await shapefile.read(buffer)) as GeoJSON.FeatureCollection;
          } else {
            throw new Error("Unsupported file type. Use .kml, .kmz, or .shp");
          }
          setCustomOverlay(geojson);
          setCustomOverlayName(file.name);
          trackEvent("Overlay Imported", {
            file_name: file.name,
            file_type: ext,
            feature_count: geojson.features.length,
          });
        } catch (err) {
          console.error("[overlay] parse error", err);
          alert(`Could not load overlay: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
      })();
    };
    input.click();
  }

  return {
    customOverlay,
    customOverlayName,
    handleOverlayImport,
    clearOverlay: () => {
      trackEvent("Overlay Cleared", {
        overlay_name: customOverlayName || null,
        had_overlay: Boolean(customOverlay),
      });
      setCustomOverlay(null);
      setCustomOverlayName("");
    }
  }

}


