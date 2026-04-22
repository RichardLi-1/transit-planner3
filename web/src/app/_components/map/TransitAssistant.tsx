"use client";

import { useRef, useState, useEffect } from "react";
import { useAnthropic } from "~/app/_components/useAnthropic";
import type { Route } from "~/app/map/transit-data";

function buildSystemPrompt(routes: Route[]): string {
  const totalStops = routes.reduce((s, r) => s + r.stops.length, 0);
  const byType: Record<string, number> = {};
  for (const r of routes) byType[r.type] = (byType[r.type] ?? 0) + 1;
  const routeList = routes
    .slice(0, 20)
    .map((r) => `- ${r.name} (${r.type}, ${r.stops.length} stops)`)
    .join("\n");

  return `You are a transit planning assistant helping a user design and analyse a transit network.

Current network summary:
- ${routes.length} routes · ${totalStops} stops
- By type: ${Object.entries(byType).map(([t, c]) => `${c} ${t}`).join(", ")}

Routes (up to 20 shown):
${routeList}

Answer questions about the transit network, suggest improvements, explain transit concepts, or help analyse specific routes. Be concise and practical. Use markdown for formatting.`;
}

interface Props {
  routes: Route[];
}

export function TransitAssistant({ routes }: Props) {
  const systemPrompt = buildSystemPrompt(routes);
  const { messages, isLoading, error, sendMessageStreaming } = useAnthropic(systemPrompt);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    const msg = input.trim();
    if (!msg || isLoading) return;
    setInput("");
    await sendMessageStreaming(msg, { maxTokens: 400 });
  };

  const SUGGESTIONS = [
    "What routes need more frequency?",
    "Where are the network gaps?",
    "How can I improve connectivity?",
    "Which stations are transfer hubs?",
  ];

  return (
    <div className="flex flex-col h-full">
      {/* chat thread */}
      <div className="flex-1 overflow-y-auto space-y-2 min-h-0 max-h-64">
        {messages.length === 0 ? (
          <div className="space-y-1.5">
            <p className="text-[10px] text-stone-400 text-center py-1">Ask anything about your network</p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => { setInput(s); inputRef.current?.focus(); }}
                className="w-full text-left rounded-lg bg-stone-50 border border-stone-100 px-2.5 py-1.5 text-[11px] text-stone-600 hover:bg-white hover:border-stone-200 transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        ) : (
          messages.map((m: { role: string; content: string }, i: number) => (
            <div key={i} className={`rounded-lg px-2.5 py-2 text-xs leading-relaxed ${m.role === "user" ? "bg-stone-900 text-white ml-6" : "bg-stone-50 border border-stone-100 text-stone-700 mr-6"}`}>
              <p className={`text-[9px] font-semibold mb-0.5 ${m.role === "user" ? "text-stone-400" : "text-violet-500"}`}>
                {m.role === "user" ? "You" : "Assistant"}
              </p>
              <p className="whitespace-pre-wrap">{m.content}</p>
            </div>
          ))
        )}
        {isLoading && (
          <div className="bg-stone-50 border border-stone-100 rounded-lg px-2.5 py-2 mr-6">
            <p className="text-[9px] font-semibold text-violet-500 mb-0.5">Assistant</p>
            <div className="flex gap-1 items-center h-4">
              <span className="h-1.5 w-1.5 rounded-full bg-stone-300 animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="h-1.5 w-1.5 rounded-full bg-stone-300 animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="h-1.5 w-1.5 rounded-full bg-stone-300 animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
          </div>
        )}
        {error && (
          <div className="rounded-lg bg-rose-50 border border-rose-200 px-2.5 py-2 text-xs text-rose-700">{error}</div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* input */}
      <div className="mt-2 flex gap-1.5 shrink-0">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="Ask about your transit network…"
          rows={2}
          className="flex-1 resize-none rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs text-stone-700 outline-none focus:border-stone-400 placeholder:text-stone-300"
        />
        <button
          onClick={() => void send()}
          disabled={!input.trim() || isLoading}
          className="self-end rounded-lg bg-stone-900 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-stone-700 disabled:opacity-40 transition-colors shrink-0"
        >
          Send
        </button>
      </div>
    </div>
  );
}
