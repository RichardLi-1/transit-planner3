import "server-only";
import { supabase } from "./supabase";

type TrafficMapRow = {
  id: number;
  geom: GeoJSON.Geometry | string | null;
  avg_traffic: number | null;
  traffic_color: string | null;
};

async function fetchAllPages<T>(table: string, select: string): Promise<T[]> {
  const PAGE_SIZE = 1000;
  const rows: T[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`Failed to fetch ${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as T[]));
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

function isValidPosition(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  );
}

function isValidLineStringCoordinates(value: unknown): value is [number, number][] {
  return Array.isArray(value) && value.length >= 2 && value.every(isValidPosition);
}

function normalizeTrafficGeometry(raw: TrafficMapRow["geom"]): GeoJSON.LineString | null {
  if (!raw) return null;

  const parsed: unknown =
    typeof raw === "string"
      ? (() => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })()
      : raw;

  if (!parsed || typeof parsed !== "object") return null;

  const geom = parsed as { type?: unknown; coordinates?: unknown };
  if (geom.type !== "LineString") return null;
  if (!isValidLineStringCoordinates(geom.coordinates)) return null;

  return {
    type: "LineString",
    coordinates: geom.coordinates,
  };
}

export async function fetchTrafficData(): Promise<GeoJSON.FeatureCollection> {
  const rows = await fetchAllPages<TrafficMapRow>(
    "traffic_map",
    "id, geom, avg_traffic, traffic_color",
  );

  const features: GeoJSON.Feature[] = rows
    .map((r) => {
      const geometry = normalizeTrafficGeometry(r.geom);
      if (!geometry) return null;

      return {
        type: "Feature",
        properties: {
          id: r.id,
          avg_traffic: r.avg_traffic,
          traffic_color: r.traffic_color,
        },
        geometry,
      } satisfies GeoJSON.Feature<GeoJSON.LineString>;
    })
    .filter((f): f is GeoJSON.Feature<GeoJSON.LineString> => f !== null);

  return { type: "FeatureCollection", features };
}
