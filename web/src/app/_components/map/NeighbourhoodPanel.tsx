"use client";

import { useState, useEffect, useMemo } from "react";
import { geomBBox, pointInGeometry, firstCoord } from "./geo";
import type { PopRow } from "~/app/map/geo-utils";

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

export function NeighbourhoodPanel({
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
  popRawData: PopRow[];
  trafficFeatures: GeoJSON.Feature[];
  onClose: () => void;
}) {
  // ── Street view image with localStorage cache
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [imgLoading, setImgLoading] = useState(true);
  useEffect(() => {
    setImgSrc(null);
    setImgLoading(true);
    const key = `streetview-neighbourhood-${name}`;
    const cached = localStorage.getItem(key);
    if (cached) { setImgSrc(cached); setImgLoading(false); return; }
    const apiUrl = `/api/streetview?lat=${lat}&lng=${lng}`;
    fetch(apiUrl)
      .then((r) => { if (!r.ok) throw new Error("no imagery"); return r.blob(); })
      .then((blob) => new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      }))
      .then((dataUrl) => {
        try { localStorage.setItem(key, dataUrl); } catch { /* storage full */ }
        setImgSrc(dataUrl);
        setImgLoading(false);
      })
      .catch(() => setImgLoading(false));
  }, [name, lat, lng]);

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
    <div className="pointer-events-auto w-64 overflow-hidden rounded-2xl bg-white shadow-sm" style={{ border: "0.93px solid #BEB7B4" }}>
      {/* Preview image */}
      <div className="relative h-36 bg-stone-200">
        {imgLoading && <div className="absolute inset-0 animate-pulse bg-stone-200" />}
        {imgSrc && (
          <img
            src={imgSrc}
            alt="Neighbourhood view"
            className="h-full w-full object-cover"
            onError={(e) => { (e.currentTarget as HTMLImageElement).src = "/placeholder.png"; }}
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
