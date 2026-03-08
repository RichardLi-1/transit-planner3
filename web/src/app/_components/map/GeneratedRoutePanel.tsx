"use client";

import type { GeneratedRoute } from "~/app/map/mock-data";

function StatBar({ value, max, color }: { value: number; max: number; color: string }) {
  return (
    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-stone-100">
      <div
        className="h-1.5 rounded-full"
        style={{ width: `${(value / max) * 100}%`, background: color }}
      />
    </div>
  );
}

export function GeneratedRoutePanel({
  route,
  disabledStops,
  onToggleStop,
  onClose,
}: {
  route: GeneratedRoute;
  disabledStops: Set<string>;
  onToggleStop: (name: string) => void;
  onClose: () => void;
}) {
  const { stats } = route;
  const prColor =
    stats.prNightmareScore < 4
      ? "#22c55e"
      : stats.prNightmareScore < 7
        ? "#f59e0b"
        : "#ef4444";
  const chanceColor =
    stats.percentageChance > 65 ? "#22c55e" : stats.percentageChance > 40 ? "#f59e0b" : "#ef4444";

  return (
    <div className="pointer-events-auto flex h-full w-80 flex-col overflow-hidden rounded-[30px] bg-white" style={{ border: "0.93px solid #BEB7B4" }}>
      {/* Header */}
      <div className="flex items-start justify-between px-5 pt-5 pb-4">
        <div className="flex items-center gap-3">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold"
            style={{ background: route.color, color: route.textColor }}
          >
            {route.shortName}
          </span>
          <div>
            <p className="flex items-center gap-1 text-[11px] font-medium tracking-widest text-stone-400 uppercase">
              <span>✦</span> AI Generated
            </p>
            <h2 className="text-base font-semibold leading-tight text-stone-800">{route.name}</h2>
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

      <div className="mx-5 h-0.5 rounded-full" style={{ background: route.color }} />

      <div className="px-5 pt-3 pb-2">
        <p className="text-sm leading-relaxed text-stone-500">{route.description}</p>
      </div>

      {/* Stats */}
      <div className="border-b border-stone-100 px-5 pb-4">
        <p className="mb-3 text-[11px] font-semibold tracking-widest text-stone-400 uppercase">
          Route Analysis
        </p>
        <div className="space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-stone-500">Cost</span>
            <span className="font-semibold text-stone-800">{stats.cost}</span>
          </div>

          <div>
            <div className="flex justify-between text-sm">
              <span className="text-stone-500">Timeline</span>
              <span className="font-semibold text-stone-800">{stats.timeline}</span>
            </div>
            <div className="flex justify-between text-xs mt-0.5">
              <span className="italic text-stone-400">w/ contingency</span>
              <span className="text-stone-500">{stats.costedTimeline}</span>
            </div>
          </div>

          <div className="flex justify-between text-sm">
            <span className="text-stone-500">Minutes Saved</span>
            <span className="font-semibold text-stone-800">{stats.minutesSaved} min/trip</span>
          </div>

          <div className="flex justify-between text-sm">
            <span className="text-stone-500">Dollars Saved</span>
            <span className="font-semibold text-stone-800">{stats.dollarsSaved}</span>
          </div>

          <div>
            <div className="flex justify-between text-sm">
              <span className="text-stone-500">Approval Chance</span>
              <span className="font-semibold" style={{ color: chanceColor }}>
                {stats.percentageChance}%
              </span>
            </div>
            <StatBar value={stats.percentageChance} max={100} color={chanceColor} />
          </div>

          <div>
            <div className="flex justify-between text-sm">
              <span className="text-stone-500">PR Nightmare Score</span>
              <span className="font-semibold" style={{ color: prColor }}>
                {stats.prNightmareScore}/10
              </span>
            </div>
            <StatBar value={stats.prNightmareScore} max={10} color={prColor} />
          </div>
        </div>
      </div>

      {/* Editable stops */}
      <div className="mt-2 flex-1 overflow-y-auto px-5 pb-3">
        <p className="mb-2 text-[11px] font-semibold tracking-widests text-stone-400 uppercase">
          Stops — click to toggle
        </p>
        <ol className="relative border-l-2" style={{ borderColor: route.color + "44" }}>
          {route.stops.map((stop, i) => {
            const off = disabledStops.has(stop.name);
            return (
              <li
                key={stop.name}
                className="group mb-0 flex cursor-pointer items-center"
                onClick={() => onToggleStop(stop.name)}
              >
                <span
                  className="absolute -left-[5px] h-2.5 w-2.5 rounded-full border-2 bg-white"
                  style={{
                    borderColor: off
                      ? "#d1d5db"
                      : i === 0 || i === route.stops.length - 1
                        ? route.color
                        : route.color + "88",
                  }}
                />
                <span
                  className={`py-1.5 pl-4 text-sm transition-colors ${
                    off
                      ? "text-stone-300 line-through"
                      : "text-stone-700 group-hover:text-stone-900"
                  }`}
                >
                  {stop.name}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

    </div>
  );
}
