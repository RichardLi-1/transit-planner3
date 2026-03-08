/** Shared geographic / population utility functions */

export type PopRow = {
  latitude: number;
  longitude: number;
  population: number;
  area: number;
};

/** Haversine distance in km between two [lng, lat] points */
export function haversineKm(
  [lng1, lat1]: [number, number],
  [lng2, lat2]: [number, number],
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Voronoi + cutoff: assign each population point to its single nearest station.
 * Points farther than `maxKm` from every station are excluded.
 *
 * @returns Map from station name → total population assigned to it
 */
export function computeStationPopulations(
  rows: PopRow[],
  stations: { name: string; coords: [number, number] }[],
  maxKm: number,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const s of stations) result.set(s.name, 0);

  for (const row of rows) {
    const pt: [number, number] = [row.longitude, row.latitude];
    let bestDist = Infinity;
    let bestStation: string | null = null;
    for (const s of stations) {
      const d = haversineKm(pt, s.coords);
      if (d < bestDist) {
        bestDist = d;
        bestStation = s.name;
      }
    }
    if (bestStation && bestDist <= maxKm) {
      result.set(bestStation, (result.get(bestStation) ?? 0) + row.population);
    }
  }
  return result;
}
