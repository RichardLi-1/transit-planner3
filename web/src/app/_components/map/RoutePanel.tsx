"use client";

import type { Route } from "~/app/map/mock-data";

export function RoutePanel({
  route,
  selectedStop,
  stationPopulations,
  extraStops,
  isCustomLine,
  onDeleteStop,
  onDeleteLine,
  onClose,
}: {
  route: Route;
  selectedStop: string | null;
  stationPopulations: Map<string, number>;
  extraStops: { name: string; coords: [number, number] }[];
  isCustomLine?: boolean;
  onDeleteStop: (name: string) => void;
  onDeleteLine?: () => void;
  onClose: () => void;
}) {
  const rawPop = selectedStop ? stationPopulations.get(selectedStop) : undefined;
  const popServed = rawPop !== undefined ? Math.max(2314, rawPop) : undefined;
  const allStops = [...route.stops, ...extraStops];
  const extraNames = new Set(extraStops.map((s) => s.name));

  return (
    <div className="pointer-events-auto flex h-full w-80 flex-col overflow-hidden rounded-2xl bg-white" style={{ border: "0.93px solid #BEB7B4" }}>
      <div className="flex items-start justify-between px-5 pt-5 pb-4">
        <div className="flex items-center gap-3">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base font-bold"
            style={{ background: route.color, color: route.textColor }}
          >
            {route.shortName}
          </span>
          <div>
            {selectedStop && <p className="text-xs font-medium text-stone-500">{route.name}</p>}
            <h2 className="text-lg font-bold leading-tight text-stone-800">{selectedStop ?? route.name}</h2>
          </div>
        </div>
        <button
          onClick={onClose}
          className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-stone-400 hover:bg-stone-100 hover:text-stone-700"
          aria-label="Close panel"
        >
          ✕
        </button>
      </div>

      {selectedStop && popServed !== undefined && (
        <div className="mx-5 mt-0 rounded-xl bg-stone-50 px-4 py-3">
          <p className="text-xs font-semibold text-stone-500">Population Served</p>
          <p className="mt-1 text-2xl font-bold text-stone-800">{popServed.toLocaleString()}</p>
          <p className="text-[11px] text-stone-400">Nearest-station assignment, 5 km cutoff</p>
        </div>
      )}

      <div className="px-5 pt-4 pb-0">
        <p className="text-sm leading-relaxed text-stone-500">{route.description}</p>
        <p className="mt-2 text-xs font-medium text-stone-400">
          Frequency: <span className="text-stone-600">{route.frequency}</span>
        </p>
      </div>

      {isCustomLine && onDeleteLine && (
        <div className="mx-5 mt-4">
          <button
            onClick={onDeleteLine}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-red-200 py-2 text-sm text-red-500 hover:bg-red-50 transition-colors"
          >
            <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="currentColor">
              <path fillRule="evenodd" d="M6 1a1.75 1.75 0 0 0-1.736 1.502H2.75a.75.75 0 0 0 0 1.5h.148l.465 6.52A1.75 1.75 0 0 0 5.11 12h3.78a1.75 1.75 0 0 0 1.747-1.478l.465-6.52h.148a.75.75 0 0 0 0-1.5H9.736A1.75 1.75 0 0 0 8 1H6Zm1 1.5a.25.25 0 0 0-.247.215L6.5 2.5h1l-.253-.285A.25.25 0 0 0 7 2.5Zm-1.5 3a.5.5 0 0 1 1 0l-.2 4a.3.3 0 0 1-.6 0l-.2-4Zm2.5 0a.5.5 0 0 1 1 0l-.2 4a.3.3 0 0 1-.6 0l-.2-4Z" clipRule="evenodd"/>
            </svg>
            Delete line
          </button>
        </div>
      )}

      <div className="mt-4 flex-1 overflow-y-auto px-5 pb-5">
        <p className="mb-2 text-xs font-semibold text-stone-500">
          Stops ({allStops.length})
        </p>
        <ol className="relative border-l-2" style={{ borderColor: route.color + "44" }}>
          {allStops.map((stop, i) => {
            const isExtra = extraNames.has(stop.name);
            return (
              <li key={stop.name} className="group mb-0 flex items-center justify-between">
                <div className="flex items-center min-w-0">
                  <span
                    className="absolute -left-[5px] h-2.5 w-2.5 rounded-full border-2 bg-white"
                    style={{
                      borderColor:
                        i === 0 || i === allStops.length - 1
                          ? route.color
                          : isExtra
                            ? route.color + "cc"
                            : route.color + "88",
                    }}
                  />
                  <span className={`py-1.5 pl-4 text-sm ${stop.name === selectedStop ? "font-bold text-stone-900" : isExtra ? "text-stone-600 italic" : "text-stone-700"}`}>
                    {stop.name}
                  </span>
                </div>
                {isExtra && (
                  <button
                    onClick={() => onDeleteStop(stop.name)}
                    className="mr-1 shrink-0 opacity-0 group-hover:opacity-100 rounded p-0.5 text-stone-300 hover:bg-red-50 hover:text-red-400 transition-all"
                    title="Remove stop"
                  >
                    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <path d="M1 1l10 10M11 1L1 11"/>
                    </svg>
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
