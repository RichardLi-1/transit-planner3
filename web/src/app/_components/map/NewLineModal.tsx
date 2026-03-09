"use client";

import { useState } from "react";
import type { Route } from "~/app/map/mock-data";

const PRESET_COLORS = ["#6366f1","#ef4444","#f59e0b","#22c55e","#0ea5e9","#ec4899","#8b5cf6","#14b8a6","#f97316","#64748b"];

export function NewLineModal({
  onConfirm,
  onClose,
}: {
  onConfirm: (name: string, color: string, type: Route["type"]) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(PRESET_COLORS[0]!);
  const [type, setType] = useState<Route["type"]>("subway");
  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-72 rounded-2xl bg-white p-5 shadow-xl">
        <h3 className="mb-4 text-base font-semibold text-stone-800">New Line</h3>
        <input
          autoFocus
          className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm outline-none focus:border-stone-400"
          placeholder="Line name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onConfirm(name.trim(), color, type); }}
        />
        <div className="mt-3">
          <p className="mb-1.5 text-xs font-semibold text-stone-500">Color</p>
          <div className="flex flex-wrap gap-2">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`h-6 w-6 rounded-full transition-transform ${color === c ? "scale-125 ring-2 ring-offset-1 ring-stone-400" : "hover:scale-110"}`}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-stone-500 hover:text-stone-700"
          >
            Cancel
          </button>
          <button
            onClick={() => { if (name.trim()) onConfirm(name.trim(), color, type); }}
            className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 bg-black"
            style={{}}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
