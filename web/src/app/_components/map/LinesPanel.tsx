"use client";

import type { Route } from "~/app/map/transit-data";
import { BUS_ROUTES } from "~/app/map/transit-data";
import type { GeneratedRoute } from "~/app/map/transit-data";

// 📖 Learn: "React.Dispatch<React.SetStateAction<T>>" is the type of the setter
// returned by useState — it accepts either a new value T or an updater function (prev: T) => T.
// We use it here so LinesPanel can call setHiddenRoutes((prev) => new Set(prev)) just like
// TransitMap does, without TransitMap needing to wrap every setter in a callback.
type DrawMode = "normal" | "select" | "boundary";

type LinesPanelProps = {
  routes: Route[];
  hiddenRoutes: Set<string>;
  generatedRoute: GeneratedRoute | null;
  collapsedSections: Record<string, boolean>;
  addStationToLine: string | null;
  experimentalFeatures: boolean;
  linesHeight: number;
  onSetHiddenRoutes: React.Dispatch<React.SetStateAction<Set<string>>>;
  onSetCollapsedSections: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onSetAddStationToLine: (id: string | null) => void;
  // Called when clicking a route that isn't in `routes` state yet (bus routes are lazy-loaded)
  onActivateRoute: (routeId: string) => void;
  onSetDrawMode: (mode: DrawMode) => void;
  onSnapshotHistory: () => void;
  onNewLine: () => void;
  onSelectGeneratedRoute: () => void;
};

export default function LinesPanel({
  routes,
  hiddenRoutes,
  generatedRoute,
  collapsedSections,
  addStationToLine,
  experimentalFeatures,
  linesHeight,
  onSetHiddenRoutes,
  onSetCollapsedSections,
  onSetAddStationToLine,
  onActivateRoute,
  onSetDrawMode,
  onSnapshotHistory,
  onNewLine,
  onSelectGeneratedRoute,
}: LinesPanelProps) {
  const sections = [
    { key: "subway",    label: "Subway / LRT", types: ["subway", "lrt"] as Route["type"][] },
    { key: "go_train",  label: "GO Train",     types: ["go_train"] as Route["type"][] },
    { key: "streetcar", label: "Streetcars",   types: ["streetcar"] as Route["type"][] },
    { key: "bus",       label: "Bus",          types: ["bus"] as Route["type"][] },
  ];

  return (
    <div
      className="rounded-xl border border-[#D7D7D7] bg-white shadow-sm w-64 flex flex-col overflow-hidden shrink-0"
      style={experimentalFeatures ? { height: linesHeight } : { maxHeight: "calc(100vh - 96px)" }}
    >
      {/* sticky header */}
      <div className="px-4 pt-4 pb-2 shrink-0">
        <p className="text-lg font-bold text-stone-800">Lines</p>
      </div>

      {/* scrollable content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
        {sections.map(({ key, label, types }) => {
          // 📖 Learn: BUS_ROUTES acts as the "canonical" list of pre-existing routes.
          // For each section we first pick any pre-existing routes of this type (using
          // the live `routes` state for updates like renames), then append any custom
          // routes the user created that aren't pre-existing.
          const sectionRoutes = [
            ...BUS_ROUTES.filter((r) => types.includes(r.type)).map(
              (r) => routes.find((er) => er.id === r.id) ?? r
            ),
            ...routes.filter(
              (r) => types.includes(r.type) && !BUS_ROUTES.some((br) => br.id === r.id)
            ),
          ];
          if (sectionRoutes.length === 0) return null;

          const allHidden = sectionRoutes.every((r) => hiddenRoutes.has(r.id));
          const collapsed = collapsedSections[key] ?? false;

          return (
            <div key={key} className="mb-2">
              <div className="flex items-center gap-1 mb-1">
                <button
                  onClick={() => onSetCollapsedSections((prev) => ({ ...prev, [key]: !collapsed }))}
                  className="flex items-center gap-1 flex-1 text-left"
                >
                  <svg viewBox="0 0 10 10" fill="currentColor" className={`h-2.5 w-2.5 text-stone-400 transition-transform shrink-0 ${collapsed ? "-rotate-90" : ""}`}>
                    <path d="M2 3l3 4 3-4H2z"/>
                  </svg>
                  <span className="text-xs font-semibold text-stone-500 uppercase tracking-wide">{label}</span>
                </button>
                <button
                  title={allHidden ? "Show all" : "Hide all"}
                  onClick={() => onSetHiddenRoutes((prev) => {
                    const next = new Set(prev);
                    if (allHidden) sectionRoutes.forEach((r) => next.delete(r.id));
                    else sectionRoutes.forEach((r) => next.add(r.id));
                    return next;
                  })}
                  className="p-0.5 text-stone-400 hover:text-stone-700 transition-colors"
                >
                  {allHidden ? (
                    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 2l12 12M6.5 6.6A3 3 0 0 0 9.4 9.5"/><path d="M4.2 4.3C2.9 5.2 1.8 6.5 1 8c1.5 3 4 5 7 5a8 8 0 0 0 3.5-.8M6 2.3A8 8 0 0 1 8 2c3 0 5.5 2 7 5-0.5 1-1.2 2-2 2.7"/>
                    </svg>
                  ) : (
                    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 8c1.5-3 4-5 7-5s5.5 2 7 5c-1.5 3-4 5-7 5S2.5 11 1 8z"/><circle cx="8" cy="8" r="2.5"/>
                    </svg>
                  )}
                </button>
              </div>

              {!collapsed && (
                <ul className="space-y-0.5 pl-4">
                  {sectionRoutes.map((r) => {
                    const isActive = addStationToLine === r.id;
                    const isHidden = hiddenRoutes.has(r.id);
                    const inRoutesState = routes.some((route) => route.id === r.id);

                    function handleSelect() {
                      if (!isActive) {
                        onSetDrawMode("normal");
                        onSnapshotHistory();
                        if (isHidden) onSetHiddenRoutes((prev) => { const next = new Set(prev); next.delete(r.id); return next; });
                        if (!inRoutesState) onActivateRoute(r.id);
                      }
                      onSetAddStationToLine(isActive ? null : r.id);
                    }

                    return (
                      <li key={r.id} className="group">
                        <div className="flex items-center gap-2">
                          <button
                            title={isActive ? "Deselect line" : "Select to add stations"}
                            onClick={handleSelect}
                            className={`flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 transition-all ${isActive ? "ring-2 ring-offset-1" : isHidden ? "opacity-30" : "opacity-60 hover:opacity-100"}`}
                            style={{ background: r.color, ...(isActive ? { outline: `2px solid ${r.color}`, outlineOffset: "2px" } : {}) }}
                          >
                            <span className="text-[11px] font-bold leading-none whitespace-nowrap" style={{ color: r.textColor ?? "#ffffff" }}>{r.shortName}</span>
                          </button>
                          <button
                            className={`flex-1 truncate text-left text-sm transition-colors ${isActive ? "font-semibold text-stone-900 dark:text-stone-100" : isHidden ? "text-stone-300 dark:text-stone-600" : "text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"}`}
                            onClick={handleSelect}
                          >{r.name}</button>
                          <div className={`flex items-center overflow-hidden transition-[max-width] duration-150 ${isActive ? "max-w-16" : "max-w-0 group-hover:max-w-16"}`}>
                            <button
                              title={isActive ? "Stop editing" : "Edit line"}
                              onClick={handleSelect}
                              className={`p-0.5 transition-opacity ${isActive ? "opacity-100 text-stone-700" : "opacity-0 group-hover:opacity-100 text-stone-300 hover:text-stone-600"}`}
                            >
                              <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M8.5 1.5l2 2L4 10H2v-2L8.5 1.5z"/></svg>
                            </button>
                            <button
                              title={isHidden ? "Show" : "Hide"}
                              onClick={() => onSetHiddenRoutes((prev) => { const next = new Set(prev); isHidden ? next.delete(r.id) : next.add(r.id); return next; })}
                              className="opacity-0 group-hover:opacity-100 p-0.5 text-stone-300 hover:text-stone-600 transition-opacity"
                            >
                              {isHidden ? (
                                <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M1 1l10 10M5 5.2A2 2 0 0 0 6.8 7M3.2 3.3C2.2 4 1.4 4.9 1 6c1 2 3 3.5 5 3.5a6 6 0 0 0 2.4-.5M4.5 1.7A6 6 0 0 1 6 1.5c2 0 4 1.5 5 3.5-.4.8-.9 1.4-1.5 2"/></svg>
                              ) : (
                                <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M1 6c1-2 3-3.5 5-3.5S10 4 11 6c-1 2-3 3.5-5 3.5S2 8 1 6z"/><circle cx="6" cy="6" r="1.8"/></svg>
                              )}
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}

        {generatedRoute && (
          <div className="mt-1 border-t border-stone-100 pt-2">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">Council Proposal</p>
            <div
              className="flex cursor-pointer items-center gap-2 text-sm text-stone-600 hover:text-stone-900"
              onClick={onSelectGeneratedRoute}
            >
              <span className="h-2 w-4 shrink-0 rounded-full" style={{ background: generatedRoute.color }} />
              <span className="truncate">{generatedRoute.name}</span>
            </div>
          </div>
        )}
      </div>

      {/* sticky footer */}
      <div className="shrink-0 px-4 pb-4 pt-2 border-t border-stone-100 space-y-1.5">
        <button
          onClick={onNewLine}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-stone-900 py-2 text-sm font-semibold text-white hover:bg-stone-700 transition-colors"
        >
          <span className="text-base leading-none">+</span>
          New Line
        </button>
      </div>
    </div>
  );
}
