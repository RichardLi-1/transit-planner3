"use client";

import { useEffect, useState } from "react";

export default function VercelRedirectModal() {
  const [newUrl, setNewUrl] = useState<string | null>(null);

  useEffect(() => {
    // Check if we're on a Vercel preview/root domain (e.g. foo.vercel.app)
    if (window.location.hostname.endsWith(".vercel.app")) {
      // 📖 Learn: window.location.pathname gives the path (/map, /docs, etc.)
      // and window.location.search gives the query string (?foo=bar).
      // We preserve both so the link lands on the same page at the new domain.
      const path = window.location.pathname + window.location.search;
      setNewUrl("https://www.transitplanner.app" + path);
    }
  }, []);

  if (!newUrl) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="mx-6 max-w-sm rounded-2xl bg-white p-6 text-center shadow-2xl dark:bg-zinc-900">
        {/* Move icon */}
        <div className="mb-4 flex justify-center">
          <svg
            className="h-12 w-12 text-blue-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3"
            />
          </svg>
        </div>

        <h2 className="mb-2 text-lg font-bold text-zinc-900 dark:text-white">
          We&apos;ve moved!
        </h2>
        <p className="mb-1 text-sm text-zinc-600 dark:text-zinc-400">
          Transit Planner now lives at:
        </p>
        <a
          href={newUrl}
          className="mb-6 inline-block break-all text-sm font-semibold text-blue-500 hover:underline"
        >
          {newUrl}
        </a>

        <div className="flex flex-col gap-2">
          <a
            href={newUrl}
            className="w-full rounded-xl bg-blue-500 py-2.5 text-sm font-semibold text-white hover:bg-blue-600 active:bg-blue-700"
          >
            Go to new site
          </a>
          <button
            onClick={() => setNewUrl(null)}
            className="w-full rounded-xl py-2.5 text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
