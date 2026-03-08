"use client";

import type { Route } from "~/app/map/mock-data";

export function StationSelectionPanel({
  stations,
  routes,
  onClose,
}: {
  stations: Set<string>;
  routes: Route[];
  onClose: () => void;
}) {
  const items = [...stations].map((key) => {
    const colonIdx = key.lastIndexOf("::");
    const name = key.slice(0, colonIdx);
    const routeId = key.slice(colonIdx + 2);
    const route = routes.find((r) => r.id === routeId);
    return { key, name, route };
  });

  return (
    <div
      className="pointer-events-auto w-72 overflow-hidden rounded-2xl bg-white shadow-sm"
      style={{ border: "0.93px solid #BEB7B4" }}
    >
      <div className="px-5 pt-4 pb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-stone-800">
            {stations.size} station{stations.size !== 1 ? "s" : ""} selected
          </h2>
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-full text-stone-400 hover:text-stone-700 text-sm"
          >
            ✕
          </button>
        </div>
        <ul className="space-y-1.5 max-h-40 overflow-y-auto">
          {items.map(({ key, name, route }) => (
            <li key={key} className="flex items-center gap-2 text-sm">
              {route && (
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: route.color }}
                />
              )}
              <span className="truncate text-stone-700">{name}</span>
              {route && (
                <span className="ml-auto shrink-0 text-stone-400 text-xs">
                  {route.shortName}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
