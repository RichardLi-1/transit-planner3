"use client";

import { useState } from "react";

const CATEGORIES = ["General", "Bug report", "Feature request", "Map data", "Other"];

export function FeedbackModal({ onClose }: { onClose: () => void }) {
  const [category, setCategory] = useState("General");
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function submit() {
    if (!message.trim()) return;
    setStatus("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, category, name }),
      });
      setStatus(res.ok ? "sent" : "error");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={onClose} />

      <div className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-[#D7D7D7] bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-stone-100 px-5 py-3.5">
          <span className="text-sm font-semibold text-stone-800">Give feedback</span>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-stone-100 text-stone-500 hover:bg-stone-200 transition-colors"
          >
            <svg viewBox="0 0 14 14" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M1 1l12 12M13 1L1 13" />
            </svg>
          </button>
        </div>

        {status === "sent" ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50">
              <svg viewBox="0 0 20 20" fill="none" className="h-6 w-6 text-emerald-500" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 10l4.5 4.5L16 6" />
              </svg>
            </div>
            <p className="text-sm font-semibold text-stone-800">Thanks for the feedback!</p>
            <p className="text-xs text-stone-400">We read everything sent here.</p>
            <button
              onClick={onClose}
              className="mt-2 rounded-lg bg-stone-800 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 transition-colors"
            >
              Close
            </button>
          </div>
        ) : (
          <div className="px-5 py-4 space-y-3">
            {/* Category pills */}
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    category === c
                      ? "bg-stone-800 text-white"
                      : "bg-stone-100 text-stone-500 hover:bg-stone-200"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>

            {/* Message */}
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="What's on your mind?"
              rows={4}
              maxLength={2000}
              className="w-full resize-none rounded-xl border border-stone-200 bg-stone-50 px-3 py-2.5 text-sm text-stone-800 placeholder-stone-400 outline-none focus:border-stone-400 focus:bg-white transition-colors"
            />

            {/* Name (optional) */}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name (optional)"
              maxLength={80}
              className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2.5 text-sm text-stone-800 placeholder-stone-400 outline-none focus:border-stone-400 focus:bg-white transition-colors"
            />

            {status === "error" && (
              <p className="text-xs text-red-500">Something went wrong — please try again.</p>
            )}

            <button
              onClick={submit}
              disabled={!message.trim() || status === "sending"}
              className="w-full rounded-xl bg-stone-800 py-2.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-40 transition-colors"
            >
              {status === "sending" ? "Sending…" : "Send feedback"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
