"use client";

import { useState, useCallback } from "react";

export type StationSummaryData = {
  stationName: string;
  routeName: string;
  ridership?: number;
  populationServed?: number;
  connections?: string[];
  allStations?: Array<{ name: string; ridership?: number }>;
};

export type StationSummaryResponse = {
  summary: string;
  stationName: string;
  routeName: string;
};

/**
 * React hook for fetching AI-generated station summaries
 */
export function useStationSummary() {
  const [summaries, setSummaries] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const getSummary = useCallback(
    async (data: StationSummaryData): Promise<string> => {
      const key = `${data.stationName}-${data.routeName}`;

      // Return cached summary if available
      if (summaries.has(key)) {
        return summaries.get(key)!;
      }

      // Don't fetch if already loading
      if (loading.has(key)) {
        return "";
      }

      setLoading((prev) => new Set(prev).add(key));
      setError(null);

      try {
        const response = await fetch("/api/ai/station-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = (await response.json()) as StationSummaryResponse;

        setSummaries((prev) => new Map(prev).set(key, result.summary));
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });

        return result.summary;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Failed to fetch summary";
        setError(errorMessage);
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        throw err;
      }
    },
    [summaries, loading],
  );

  const isLoading = useCallback(
    (stationName: string, routeName: string): boolean => {
      return loading.has(`${stationName}-${routeName}`);
    },
    [loading],
  );

  const getCachedSummary = useCallback(
    (stationName: string, routeName: string): string | undefined => {
      return summaries.get(`${stationName}-${routeName}`);
    },
    [summaries],
  );

  const clearCache = useCallback(() => {
    setSummaries(new Map());
    setLoading(new Set());
    setError(null);
  }, []);

  return {
    getSummary,
    isLoading,
    getCachedSummary,
    clearCache,
    error,
  };
}
