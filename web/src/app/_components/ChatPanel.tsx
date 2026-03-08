"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ParsedRoute = {
  name: string;
  type: "subway" | "streetcar" | "bus";
  color: string;
  stops: { name: string; coords: [number, number] }[];
  prScore?: number; // /40
};

type AgentState = {
  agent: string;
  role: string;
  color: string;
  text: string;
  done: boolean;
  quote?: string;
  route?: ParsedRoute;
};

type Session = {
  id: string;
  timestamp: Date;
  neighbourhoods: string[];
  stations: string[];
  agentStates: Record<string, AgentState>;
  statusMessages: string[];
  finalRoute?: ParsedRoute;
};

// ── Agent column order ─────────────────────────────────────────────────────────

const AGENT_ORDER = ["Alex Chen", "Jordan Park", "Margaret Thompson", "Planning Commission"];

// ── Helpers ────────────────────────────────────────────────────────────────────

function extractRoute(text: string): ParsedRoute | null {
  const match = /```route\s*([\s\S]*?)```/.exec(text);
  if (!match) return null;
  try { return JSON.parse(match[1]!) as ParsedRoute; } catch { return null; }
}

function stripBlocks(text: string): string {
  return text.replace(/```(?:route|quote)\s*[\s\S]*?```/g, "").trim();
}

async function speakQuote(agent: string, text: string): Promise<void> {
  try {
    const resp = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent, text }),
    });
    if (!resp.ok) return;
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    void audio.play();
  } catch {
    // ignore TTS errors silently
  }
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Single agent card ─────────────────────────────────────────────────────────

function AgentCard({
  state,
  isActive,
}: {
  state: AgentState;
  isActive: boolean;
}) {
  return (
    <div className="flex flex-col min-w-0">
      {/* Agent header */}
      <div className="flex items-center gap-1.5 mb-2">
        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${isActive ? "animate-pulse" : ""}`} style={{ background: state.color }} />
        <span className="text-[11px] font-semibold text-stone-700 truncate">{state.agent}</span>
      </div>
      <div
        className="flex-1 rounded-xl rounded-tl-none bg-stone-50 px-3 py-2.5 text-[12px] leading-relaxed text-stone-600 whitespace-pre-wrap overflow-y-auto"
        style={{ borderLeft: `2px solid ${state.color}50`, minHeight: "80px", maxHeight: "220px" }}
      >
        {state.text
          ? <ReactMarkdown
              components={{
                p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
                strong: ({ children }) => <strong className="font-semibold text-stone-700">{children}</strong>,
                li: ({ children }) => <li className="ml-3 list-disc">{children}</li>,
                ul: ({ children }) => <ul className="mb-1">{children}</ul>,
                h1: ({ children }) => <p className="font-semibold text-stone-700">{children}</p>,
                h2: ({ children }) => <p className="font-semibold text-stone-600">{children}</p>,
                h3: ({ children }) => <p className="font-medium text-stone-600">{children}</p>,
              }}
            >{stripBlocks(state.text)}</ReactMarkdown>
          : <span className="text-stone-300 italic">{isActive ? "thinking…" : "waiting"}</span>
        }
        {isActive && !state.done && (
          <span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-stone-400 align-middle" />
        )}
      </div>
      {/* Quote chip */}
      {state.quote && (
        <div className="mt-1.5 rounded-lg px-2.5 py-1.5 text-[11px] italic leading-snug"
          style={{ background: `${state.color}12`, color: state.color, borderLeft: `2px solid ${state.color}60` }}>
          "{state.quote}"
        </div>
      )}
      {/* Route preview chip */}
      {state.done && state.route && (
        <div className="mt-1.5 flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-[11px]">
          <span className="h-1.5 w-3 rounded-full shrink-0" style={{ background: state.route.color }} />
          <span className="font-medium text-stone-700 truncate">{state.route.name}</span>
          <span className="ml-auto text-stone-400 shrink-0">{state.route.stops.length}s</span>
        </div>
      )}
    </div>
  );
}

// ── History entry renderer ─────────────────────────────────────────────────────

function SessionDetail({
  session,
}: {
  session: Session;
}) {
  const topAgents = AGENT_ORDER.filter(
    (a) => a !== "Planning Commission" && session.agentStates[a]
  );
  const commission = session.agentStates["Planning Commission"];

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Status messages */}
      {session.statusMessages.length > 0 && (
        <div className="px-4 pt-3 pb-1">
          {session.statusMessages.slice(0, 2).map((s, i) => (
            <p key={i} className="text-center text-[11px] text-stone-400 italic">{s}</p>
          ))}
        </div>
      )}
      {/* Agent columns */}
      {topAgents.length > 0 && (
        <div className="grid gap-3 px-4 pt-2" style={{ gridTemplateColumns: `repeat(${topAgents.length}, 1fr)` }}>
          {topAgents.map((name) => {
            const s = session.agentStates[name]!;
            return <AgentCard key={name} state={s} isActive={false} />;
          })}
        </div>
      )}
      {/* Planning Commission + final route */}
      {commission && (
        <div className="px-4 pt-3">
          <div className="flex items-center gap-1.5 mb-2">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: commission.color }} />
            <span className="text-[11px] font-semibold text-stone-700">{commission.agent}</span>
            <span className="text-[10px] text-stone-400">{commission.role}</span>
          </div>
          <div
            className="rounded-xl rounded-tl-none bg-stone-50 px-3 py-2.5 text-[12px] leading-relaxed text-stone-600 whitespace-pre-wrap overflow-y-auto mb-3"
            style={{ borderLeft: `2px solid ${commission.color}50`, maxHeight: "120px" }}
          >
            {commission.text
              ? <ReactMarkdown components={{ p: ({children})=><p className="mb-1 last:mb-0">{children}</p>, strong: ({children})=><strong className="font-semibold">{children}</strong>, li: ({children})=><li className="ml-3 list-disc">{children}</li>, ul: ({children})=><ul className="mb-1">{children}</ul> }}>{stripBlocks(commission.text)}</ReactMarkdown>
              : <span className="text-stone-300 italic">—</span>}
          </div>
        </div>
      )}
      {session.finalRoute && (
        <div className="mx-4 mb-4 rounded-xl border-2 border-stone-900 bg-white p-4">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-stone-400">Final Recommendation</p>
          <div className="flex items-center gap-2 mb-1">
            <span className="h-3 w-6 rounded-full shrink-0" style={{ background: session.finalRoute.color }} />
            <span className="text-sm font-bold text-stone-800">{session.finalRoute.name}</span>
            <span className="ml-auto text-xs capitalize text-stone-400">{session.finalRoute.type}</span>
          </div>
          <p className="text-xs text-stone-400 mb-3">{session.finalRoute.stops.length} stops</p>
          <p className="text-center text-xs text-stone-400 italic">✓ Added to map</p>
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function ChatPanel({
  open,
  onClose,
  startNew,
  neighbourhoodNames,
  stationNames,
  existingLineStops,
  onAddRoute,
  onRoutePreview,
}: {
  open: boolean;
  onClose: () => void;
  startNew: boolean;
  neighbourhoodNames: string[];
  stationNames: string[];
  existingLineStops: { name: string; coords: [number, number]; route: string }[];
  onAddRoute: (route: ParsedRoute) => void;
  onRoutePreview?: (route: ParsedRoute | null) => void;
}) {
  // Live state
  const [agentStates, setAgentStates] = useState<Record<string, AgentState>>({});
  const [statusMessages, setStatusMessages] = useState<string[]>([]);
  const [finalRoute, setFinalRoute] = useState<ParsedRoute | null>(null);
  const [streaming, setStreaming] = useState(false);

  // History
  const [sessions, setSessions] = useState<Session[]>([]);
  const [view, setView] = useState<"live" | "history" | { sessionId: string }>("live");

  const hasStarted = useRef(false);
  const agentStatesRef = useRef<Record<string, AgentState>>({});
  const statusRef = useRef<string[]>([]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { agentStatesRef.current = agentStates; }, [agentStates]);

  // Scroll to bottom as content streams in
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agentStates, statusMessages, finalRoute]);

  // Auto-trigger council when panel opens with startNew=true
  useEffect(() => {
    if (!open) return;
    if (!startNew) { setView("history"); return; }
    if (hasStarted.current) return;
    hasStarted.current = true;
    setView("live");
    void startCouncil();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, startNew]);

  // Reset live state when closed (sessions persist)
  useEffect(() => {
    if (!open) {
      hasStarted.current = false;
      setAgentStates({});
      agentStatesRef.current = {};
      setStatusMessages([]);
      statusRef.current = [];
      setFinalRoute(null);
      setStreaming(false);
      onRoutePreview?.(null);
    }
  }, [open, onRoutePreview]);

  async function startCouncil() {
    setStreaming(true);
    setAgentStates({});
    setStatusMessages([]);
    setFinalRoute(null);
    agentStatesRef.current = {};
    statusRef.current = [];

    try {
      const resp = await fetch("/api/council", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          neighbourhoods: neighbourhoodNames,
          stations: stationNames,
          line_type: null,
          context: null,
          existing_lines: existingLineStops,
        }),
      });

      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          try {
            const evt = JSON.parse(payload) as Record<string, unknown>;
            const evtAgent = evt.agent as string | undefined;

            if (evt.type === "status") {
              const msg = evt.text as string;
              statusRef.current = [...statusRef.current, msg];
              setStatusMessages([...statusRef.current]);

            } else if (evt.type === "agent_start" && evtAgent) {
              const newState: AgentState = {
                agent: evtAgent,
                role: evt.role as string,
                color: evt.color as string,
                text: "",
                done: false,
              };
              agentStatesRef.current = { ...agentStatesRef.current, [evtAgent]: newState };
              setAgentStates({ ...agentStatesRef.current });

            } else if (evt.type === "agent_text" && evtAgent) {
              const prev = agentStatesRef.current[evtAgent];
              if (prev) {
                const updated = { ...prev, text: prev.text + (evt.text as string) };
                agentStatesRef.current = { ...agentStatesRef.current, [evtAgent]: updated };
                setAgentStates({ ...agentStatesRef.current });
              }

            } else if (evt.type === "agent_quote" && evtAgent) {
              const quote = evt.text as string;
              const prev = agentStatesRef.current[evtAgent];
              if (prev) {
                agentStatesRef.current = { ...agentStatesRef.current, [evtAgent]: { ...prev, quote } };
                setAgentStates({ ...agentStatesRef.current });
              }
              void speakQuote(evtAgent, quote);

            } else if (evt.type === "agent_end" && evtAgent) {
              const prev = agentStatesRef.current[evtAgent];
              if (prev) {
                const route = extractRoute(prev.text) ?? undefined;
                const updated = { ...prev, done: true, route };
                agentStatesRef.current = { ...agentStatesRef.current, [evtAgent]: updated };
                setAgentStates({ ...agentStatesRef.current });
              }

            } else if (evt.type === "route_update") {
              // Live route preview on the map
              onRoutePreview?.(evt.route as ParsedRoute);

            } else if (evt.type === "route_final") {
              const route = { ...(evt.route as ParsedRoute), prScore: evt.pr_score as number | undefined };
              setFinalRoute(route);
              onRoutePreview?.(route);
              // Auto-add to map immediately
              onAddRoute(route);

            } else if (evt.type === "done") {
              setStreaming(false);
              onRoutePreview?.(null);
              // Save session to history
              setSessions((prev) => [...prev, {
                id: Date.now().toString(),
                timestamp: new Date(),
                neighbourhoods: neighbourhoodNames,
                stations: stationNames,
                agentStates: agentStatesRef.current,
                statusMessages: statusRef.current,
                finalRoute: (Object.values(agentStatesRef.current).find((a) => a.agent === "Planning Commission") as AgentState | undefined)?.route
                  ?? (agentStatesRef.current["Planning Commission"]?.route),
              }]);
            }
          } catch {
            // ignore malformed chunk
          }
        }
      }
    } catch (err) {
      setStatusMessages((prev) => [...prev, "Something went wrong. Please try again."]);
      console.error("Council error:", err);
    } finally {
      setStreaming(false);
      onRoutePreview?.(null);
    }
  }

  if (!open) return null;

  const topAgents = AGENT_ORDER.filter(
    (a) => a !== "Planning Commission" && agentStates[a]
  );
  const commission = agentStates["Planning Commission"];
  const activeAgent = Object.values(agentStates).find((a) => !a.done)?.agent;

  // ── History list ─────────────────────────────────────────────────────────────
  if (view === "history") {
    return (
      <div className="pointer-events-auto absolute bottom-18 right-9 flex w-155 flex-col overflow-hidden rounded-2xl bg-white shadow-xl" style={{ border: "0.93px solid #BEB7B4", maxHeight: "580px" }}>
        <div className="flex items-center gap-2 border-b border-stone-100 px-4 py-3">
          <button onClick={() => setView("live")} className="text-stone-400 hover:text-stone-700">
            <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 3L5 8l5 5"/></svg>
          </button>
          <p className="text-sm font-semibold text-stone-800">Session History</p>
          <p className="ml-auto text-xs text-stone-400">{sessions.length} session{sessions.length !== 1 ? "s" : ""}</p>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5" style={{ minHeight: 0 }}>
          {sessions.length === 0 && <p className="text-center text-sm text-stone-400 py-8">No past sessions yet</p>}
          {[...sessions].reverse().map((s) => (
            <button key={s.id} onClick={() => setView({ sessionId: s.id })}
              className="w-full text-left rounded-xl border border-stone-100 bg-stone-50 hover:bg-stone-100 px-3.5 py-2.5 transition-colors">
              <div className="flex items-center gap-2 mb-1">
                {s.finalRoute && <span className="h-2 w-4 rounded-full shrink-0" style={{ background: s.finalRoute.color }} />}
                <span className="text-xs font-semibold text-stone-700 truncate">{s.finalRoute?.name ?? "No route generated"}</span>
                <span className="ml-auto text-[10px] text-stone-400 shrink-0">{fmtTime(s.timestamp)}</span>
              </div>
              {s.neighbourhoods.length > 0 && <p className="text-[11px] text-stone-400 truncate">{s.neighbourhoods.join(", ")}</p>}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Past session detail ───────────────────────────────────────────────────────
  if (typeof view === "object") {
    const session = sessions.find((s) => s.id === view.sessionId);
    if (!session) { setView("live"); return null; }
    return (
      <div className="pointer-events-auto absolute bottom-18 right-9 flex w-155 flex-col overflow-hidden rounded-2xl bg-white shadow-xl" style={{ border: "0.93px solid #BEB7B4", maxHeight: "580px" }}>
        <div className="flex items-center gap-2 border-b border-stone-100 px-4 py-3">
          <button onClick={() => setView("history")} className="text-stone-400 hover:text-stone-700">
            <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 3L5 8l5 5"/></svg>
          </button>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-stone-800 truncate">{session.finalRoute?.name ?? "Council Session"}</p>
            <p className="text-xs text-stone-400">{fmtTime(session.timestamp)}</p>
          </div>
          <button onClick={onClose} className="ml-auto text-stone-400 hover:text-stone-600 shrink-0">
            <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M1 1l10 10M11 1L1 11"/></svg>
          </button>
        </div>
        <div className="overflow-y-auto" style={{ minHeight: 0 }}>
          <SessionDetail session={session} />
        </div>
      </div>
    );
  }

  // ── Live view ─────────────────────────────────────────────────────────────────
  return (
    <div className="pointer-events-auto absolute bottom-18 right-9 flex w-155 flex-col overflow-hidden rounded-2xl bg-white shadow-xl" style={{ border: "0.93px solid #BEB7B4", maxHeight: "580px" }}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-stone-100 px-4 py-3 shrink-0">
        <div>
          <p className="text-sm font-semibold text-stone-800">Transit Council</p>
          <p className="text-xs text-stone-400">{streaming ? "Deliberation in progress…" : "Deliberation complete"}</p>
        </div>
        <div className="flex items-center gap-2">
          {sessions.length > 0 && (
            <button onClick={() => setView("history")}
              className="flex items-center gap-1.5 rounded-lg border border-stone-200 px-2 py-1 text-[11px] text-stone-500 hover:bg-stone-50">
              <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 2"/>
              </svg>
              {sessions.length}
            </button>
          )}
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600">
            <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M1 1l10 10M11 1L1 11"/></svg>
          </button>
        </div>
      </div>

      {/* Requirements chips */}
      {(neighbourhoodNames.length > 0 || stationNames.length > 0) && (
        <div className="flex flex-wrap gap-1 border-b border-stone-50 px-4 py-2 shrink-0">
          {neighbourhoodNames.map((n) => <span key={n} className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-600">{n}</span>)}
          {stationNames.map((s) => <span key={s} className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-stone-500">{s}</span>)}
        </div>
      )}

      {/* Status messages */}
      {statusMessages.length > 0 && (
        <div className="px-4 pt-2 shrink-0">
          <p className="text-center text-[11px] text-stone-400 italic">{statusMessages[statusMessages.length - 1]}</p>
        </div>
      )}

      {/* Scrollable content */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
        {/* Agent columns (top 3) */}
        {topAgents.length > 0 && (
          <div className="grid gap-3 px-4 pt-3" style={{ gridTemplateColumns: `repeat(${topAgents.length}, 1fr)` }}>
            {topAgents.map((name) => (
              <AgentCard key={name} state={agentStates[name]!} isActive={activeAgent === name} />
            ))}
          </div>
        )}

        {/* Assembling placeholder */}
        {topAgents.length === 0 && streaming && (
          <div className="flex items-center gap-2 px-4 py-6 justify-center">
            <span className="flex gap-0.5">
              {[0, 1, 2].map((d) => (
                <span key={d} className="h-1.5 w-1.5 rounded-full bg-stone-300 animate-bounce" style={{ animationDelay: `${d * 0.15}s` }} />
              ))}
            </span>
            <span className="text-[11px] text-stone-400">Assembling council…</span>
          </div>
        )}

        {/* Divider before commission */}
        {commission && (
          <div className="mx-4 mt-3 border-t border-stone-100" />
        )}

        {/* Planning Commission — full width */}
        {commission && (
          <div className="px-4 pt-3">
            <div className="flex items-center gap-1.5 mb-2">
              <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${activeAgent === commission.agent ? "animate-pulse" : ""}`} style={{ background: commission.color }} />
              <span className="text-[11px] font-semibold text-stone-700">{commission.agent}</span>
              <span className="text-[10px] text-stone-400 ml-1">{commission.role}</span>
            </div>
            <div
              className="rounded-xl rounded-tl-none bg-stone-50 px-3 py-2.5 text-[12px] leading-relaxed text-stone-600 whitespace-pre-wrap"
              style={{ borderLeft: `2px solid ${commission.color}50` }}
            >
              {commission.text
                ? <ReactMarkdown components={{ p: ({children})=><p className="mb-1 last:mb-0">{children}</p>, strong: ({children})=><strong className="font-semibold">{children}</strong>, li: ({children})=><li className="ml-3 list-disc">{children}</li>, ul: ({children})=><ul className="mb-1">{children}</ul> }}>{stripBlocks(commission.text)}</ReactMarkdown>
                : <span className="text-stone-300 italic">{activeAgent === commission.agent ? "thinking…" : ""}</span>}
              {activeAgent === commission.agent && !commission.done && (
                <span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-stone-400 align-middle" />
              )}
            </div>
          </div>
        )}

        {/* Final route card */}
        {finalRoute && (
          <div className="mx-4 mt-3 mb-4 rounded-xl border-2 border-stone-900 bg-white p-4">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-stone-400">Final Recommendation</p>
            <div className="flex items-center gap-2 mb-1">
              <span className="h-3 w-6 rounded-full shrink-0" style={{ background: finalRoute.color }} />
              <span className="text-sm font-bold text-stone-800">{finalRoute.name}</span>
              <span className="ml-auto text-xs capitalize text-stone-400">{finalRoute.type}</span>
            </div>
            <p className="text-xs text-stone-400 mb-3">{finalRoute.stops.length} stops</p>
            <p className="text-center text-xs text-stone-400 italic">✓ Added to map</p>
          </div>
        )}

        <div className="h-3" />
      </div>
    </div>
  );
}
