import "server-only";

import { createAssistant, createThread, streamMessage } from "./anthropic";

// ── Models ─────────────────────────────────────────────────────────────────────

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";

// ── Shared blocks injected into planner prompts ───────────────────────────────

const QUOTE_BLOCK = `Also include a \`\`\`quote block with a single punchy sentence (max 15 words) summarising your stance — written in first person, as if speaking aloud:

\`\`\`quote
Your punchy one-liner here.
\`\`\``;

const ROUTE_BLOCK = `End your message with a \`\`\`route block:

\`\`\`route
{
  "name": "Route Name",
  "type": "subway",
  "color": "#hexcolor",
  "stops": [{"name": "Intersection/Landmark", "coords": [-79.XXXX, 43.XXXX]}]
}
\`\`\`

Toronto: lon −79.65 to −79.10, lat 43.55 to 43.85. Include 6–10 stops.
CRITICAL: stops must be geographically ordered along the corridor — each stop must be adjacent to the previous one. No zigzagging. No gap larger than ~800 m between consecutive stops.
ALL routes are subways — type must always be "subway".`;

const PLANNING_RULES = `PLANNING RULES (apply to all proposals and critiques):
1. COST: Route length drives cost — every extra kilometre is expensive and adds years to delivery. Prefer compact, direct alignments. Flag any route that seems unnecessarily long.
2. POPULATION: Prioritise high-density corridors and destinations that are currently underserved or where existing stations are overcrowded. Each stop should justify its existence with clear population demand.
3. STATION SPACING: New stops must be at least 800 m from BOTH (a) existing TTC stations and (b) any stops already proposed earlier in this debate — unless the stop is an explicit transfer to that line. Stops too close to either category with no transfer justification must be relocated or cut.
4. SUBWAY ONLY: Every route proposed is a subway line. Do not suggest streetcar or bus alternatives.
5. NO SELF-CONNECTIONS: A stop on the proposed route cannot be labelled as a transfer to another stop on the same proposed route. Transfers are only valid when connecting to a different, pre-existing line.
6. MERIT-BASED SELECTION: Evaluate each candidate stop independently on cost, population served, and spacing. Do not retain a stop simply because of where it falls in the sequence — cut it if it fails on merit.`;

// ── System prompts ─────────────────────────────────────────────────────────────

const PLANNER_A_SYSTEM = `You are Alex Chen, Senior Transit Planner, Toronto. Advocate for ridership, equity, and underserved high-density areas.

For each proposed station give: nearest intersection, one-sentence justification (population served, existing station load relieved, or transfer value).

${PLANNING_RULES}

${QUOTE_BLOCK}

${ROUTE_BLOCK}`;

const PLANNER_B_SYSTEM = `You are Jordan Park, Infrastructure Cost Analyst, TTC. Every dollar and every kilometre must be justified.

For each station in Alex's proposal, score:
- Cost Risk 1–10 (longer tunnel segment = higher score)
- Ridership ROI 1–10 (population density served vs. construction cost)

Flag any stop that is redundant (within 800 m of an existing station without transfer value) or that unnecessarily extends the route length. Challenge the 2 weakest stations and propose shorter or better-spaced alternatives.

${PLANNING_RULES}

${QUOTE_BLOCK}

${ROUTE_BLOCK}`;

const NIMBY_SYSTEM = `You are Margaret Thompson, Residents' Association chair. Passionate and protective of existing residents.

Identify the 2–3 most disruptive stations. For each:
- Exact street corner affected
- Who lives there / what's disrupted
- NIMBY Resistance Score 1–10
- One concrete mitigation

Your quote must be emotional and direct — something like "Don't you dare put a construction site outside my window!" or "This will destroy our neighbourhood!"

${PLANNING_RULES}

${QUOTE_BLOCK}

Max 150 words. No route JSON.`;

const PR_SYSTEM = `You are Devon Walsh, TTC Communications Director. Protect the project from bad headlines.

For the top 3 stations rate (0–10 each):
- Displacement risk
- Construction noise (residential area?)
- Gentrification optics
- Environmental justice

Sum = Overall PR Nightmare Score /40. Flag >25 as political liability.
Also flag if the overall route is excessively long (high cost) or if any stop is too close to an existing station without a transfer benefit — both are easy targets for critics.
Recommend the single change with highest PR risk reduction. Max 150 words. No route JSON.

${PLANNING_RULES}

${QUOTE_BLOCK}`;

const REBUTTAL_SYSTEM = `You are Alex Chen and Jordan Park in joint rebuttal.

Defend strong stations with data (population served, distance from nearest existing station). For the 1–2 most contested stations: concede or replace with alternatives that better satisfy cost, population, and spacing constraints.
State tradeoffs explicitly. Be decisive.

${PLANNING_RULES}

${QUOTE_BLOCK}

${ROUTE_BLOCK}`;

const COMMISSION_SYSTEM = `You are the Toronto Transit Commission Planning Committee.

Rule on each contested station:
1. Confirmed / Modified (new coords) / Rejected
2. One-line mitigation commitment per NIMBY/PR concern raised
3. Revised PR Nightmare Score /40

Ensure the final route is a subway, is as compact as possible while serving the target population, and has no stops within 800 m of an existing station unless they are explicit transfers. Then output the binding final route.

${PLANNING_RULES}

${QUOTE_BLOCK}

${ROUTE_BLOCK}`;

// ── Agent registry ─────────────────────────────────────────────────────────────

interface Agent {
  key: string;
  name: string;
  role: string;
  color: string;
  system: string;
  model: string;
  maxTokens: number;
}

const AGENTS: Agent[] = [
  { key: "planner_a",  name: "Alex Chen",          role: "Ridership Planner",      color: "#2563eb", system: PLANNER_A_SYSTEM,  model: SONNET, maxTokens: 700 },
  { key: "planner_b",  name: "Jordan Park",         role: "Infrastructure Analyst", color: "#16a34a", system: PLANNER_B_SYSTEM,  model: SONNET, maxTokens: 700 },
  { key: "nimby",      name: "Margaret Thompson",   role: "Neighbourhood Rep",      color: "#dc2626", system: NIMBY_SYSTEM,      model: HAIKU,  maxTokens: 300 },
  { key: "pr",         name: "Devon Walsh",         role: "PR Director",            color: "#d97706", system: PR_SYSTEM,         model: HAIKU,  maxTokens: 300 },
  { key: "rebuttal",   name: "Alex & Jordan",       role: "Joint Rebuttal",         color: "#7c3aed", system: REBUTTAL_SYSTEM,   model: SONNET, maxTokens: 700 },
  { key: "commission", name: "Planning Commission", role: "Final Decision",         color: "#0f172a", system: COMMISSION_SYSTEM, model: SONNET, maxTokens: 800 },
];

// ── SSE / extraction helpers ───────────────────────────────────────────────────

function sse(payload: Record<string, unknown>): string {
  return "data: " + JSON.stringify(payload) + "\n\n";
}

function extractRoute(text: string): Record<string, unknown> | null {
  const m = /```route\s*(.*?)```/s.exec(text);
  if (!m) return null;
  try { return JSON.parse(m[1]!.trim()) as Record<string, unknown>; } catch { return null; }
}

function extractQuote(text: string): string | null {
  const m = /```quote\s*(.*?)```/s.exec(text);
  return m ? m[1]!.trim() : null;
}

function stopsLabel(route: Record<string, unknown> | null): string {
  if (!route) return "(none)";
  const stops = route.stops as Array<{ name: string; coords: [number, number] }> | undefined;
  if (!stops?.length) return "(none)";
  return stops.map((s) => `${s.name} (${s.coords[0].toFixed(4)}, ${s.coords[1].toFixed(4)})`).join("; ");
}

// ── Single agent turn ──────────────────────────────────────────────────────────

async function* turn(
  agent: Agent,
  threadId: string,
  prompt: string,
): AsyncGenerator<{ chunk: string; full: string }> {
  yield { chunk: sse({ type: "agent_start", agent: agent.name, role: agent.role, color: agent.color }), full: "" };
  let full = "";
  for await (const text of streamMessage(threadId, prompt, agent.model, agent.maxTokens)) {
    full += text;
    yield { chunk: sse({ type: "agent_text", agent: agent.name, text }), full };
  }
  const quote = extractQuote(full);
  if (quote) yield { chunk: sse({ type: "agent_quote", agent: agent.name, text: quote }), full };
  yield { chunk: sse({ type: "agent_end", agent: agent.name }), full };
}

// ── Data brief (no DB required — agents have Toronto knowledge) ────────────────

function buildDataBrief(neighbourhoods: string[], stationNames: string[]): string {
  const parts: string[] = [];
  if (neighbourhoods.length > 0)
    parts.push(`Target neighbourhoods: ${neighbourhoods.join(", ")}.`);
  if (stationNames.length > 0)
    parts.push(`Stations to connect: ${stationNames.join(", ")}.`);
  return parts.length > 0 ? parts.join("\n") : "No specific location data provided.";
}

// ── Public types ───────────────────────────────────────────────────────────────

export interface ExistingStop {
  name: string;
  coords: [number, number];
  route: string;
}

export interface CouncilInput {
  neighbourhoods: string[];
  stations: string[];
  lineType?: string | null;
  extraContext?: string | null;
  existingLines?: ExistingStop[];
}

// ── Council orchestration ──────────────────────────────────────────────────────

export async function* runCouncil(input: CouncilInput): AsyncGenerator<string> {
  const { neighbourhoods, stations, lineType, extraContext, existingLines = [] } = input;

  yield sse({ type: "status", text: "Assembling transit data…" });
  const dataBrief = buildDataBrief(neighbourhoods, stations);

  yield sse({ type: "status", text: "Creating council sessions…" });

  // Create one assistant+thread per agent, in parallel
  let sessions: Record<string, string>;
  try {
    const results = await Promise.all(
      AGENTS.map(async (ag) => {
        const aid = await createAssistant(ag.name, ag.system);
        const tid = await createThread(aid);
        return [ag.key, tid] as const;
      }),
    );
    sessions = Object.fromEntries(results);
  } catch (err) {
    yield sse({ type: "status", text: `Council setup failed: ${String(err)}` });
    yield sse({ type: "done" });
    return;
  }

  yield sse({ type: "status", text: "Council ready — deliberation begins." });

  // Shared brief
  const typeStr = lineType ? `Mode preference: ${lineType}. ` : "";
  let brief =
    `# Planning Brief\n` +
    `Serve: ${neighbourhoods.join(", ") || "Toronto"}. ` +
    `Connect: ${stations.join(", ") || "None specified"}. ` +
    `${typeStr}\n\n` +
    `## Stop demand data\n${dataBrief}`;

  if (existingLines.length > 0) {
    const byRoute: Record<string, string[]> = {};
    for (const s of existingLines) {
      (byRoute[s.route] ??= []).push(`${s.name} (${s.coords[0].toFixed(4)}, ${s.coords[1].toFixed(4)})`);
    }
    const linesText = Object.entries(byRoute)
      .map(([route, stops]) => `  ${route}: ${stops.join(", ")}`)
      .join("\n");
    brief +=
      `\n\n## Existing TTC lines & stops\n${linesText}\n` +
      `TRANSFER RULE: wherever your proposed route crosses or comes within 150 m of an existing stop, ` +
      `place a stop at that exact location named '<ExistingStation> Transfer'.`;
  }

  if (extraContext) brief += `\n\nExtra context: ${extraContext}`;

  const ag = (key: string) => AGENTS.find((a) => a.key === key)!;

  try {
    // ── R1: Planner A initial proposal ────────────────────────────────────────
    let fullA = "";
    for await (const { chunk, full } of turn(
      ag("planner_a"), sessions["planner_a"]!,
      brief + "\n\nPropose 6–20 stations. For each, justify on merit: population density served, " +
      "distance from nearest existing station, and cost contribution to total route length. " +
      "Do not retain a stop because of where it falls in sequence — every stop must earn its place. Output route block.",
    )) { yield chunk; fullA = full; }
    const routeA = extractRoute(fullA);
    if (routeA) yield sse({ type: "route_update", route: routeA, round: 1 });

    // ── R2: Planner B cost review ──────────────────────────────────────────────
    const proposedA = stopsLabel(routeA);
    let fullB = "";
    for await (const { chunk, full } of turn(
      ag("planner_b"), sessions["planner_b"]!,
      brief + `\n\n## Alex's Proposal\n${fullA}\n\n` +
      `## Already-proposed stops (treat as occupied — 800 m exclusion zone for any NEW stop):\n${proposedA}\n\n` +
      "Score each station for Cost Risk + Ridership ROI. Flag stops that are too close to existing TTC stations " +
      "or to other stops already proposed. Challenge the 2 weakest on merit and propose better alternatives " +
      "(must be >800 m from all occupied locations). Output revised route block.",
    )) { yield chunk; fullB = full; }
    const routeB = extractRoute(fullB);
    if (routeB) yield sse({ type: "route_update", route: routeB, round: 2 });
    const current = routeB ?? routeA;

    // ── R3: NIMBY ─────────────────────────────────────────────────────────────
    let fullN = "";
    for await (const { chunk, full } of turn(
      ag("nimby"), sessions["nimby"]!,
      `Proposed route:\n${current ? JSON.stringify(current, null, 2) : "(none)"}\n\n` +
      `Affected areas: ${neighbourhoods.join(", ") || "Toronto"}.\n\n` +
      "Identify 2–3 most disruptive stations on merit (disruption caused, not route order). NIMBY scores + mitigations.",
    )) { yield chunk; fullN = full; }

    // ── R4: PR assessment ──────────────────────────────────────────────────────
    let fullPr = "";
    for await (const { chunk, full } of turn(
      ag("pr"), sessions["pr"]!,
      `Full debate:\n**Alex:** ${fullA.slice(0, 400)}…\n**Jordan:** ${fullB.slice(0, 400)}…\n**Margaret:** ${fullN}\n\n` +
      "Score top 3 stations on Displacement/Noise/Gentrification/EnvJustice. Overall PR score /40. " +
      "Also flag any stop that appears redundant with an existing or already-proposed station (<800 m, no transfer value). " +
      "One highest-impact recommendation.",
    )) { yield chunk; fullPr = full; }

    // ── R5: Joint rebuttal ────────────────────────────────────────────────────
    const allProposed = stopsLabel(current);
    let fullReb = "";
    for await (const { chunk, full } of turn(
      ag("rebuttal"), sessions["rebuttal"]!,
      brief + `\n\n**Alex:** ${fullA}\n**Jordan:** ${fullB}\n**Margaret:** ${fullN}\n**Devon:** ${fullPr}\n\n` +
      `## All stops proposed so far (occupied locations — 800 m exclusion zone for replacements):\n${allProposed}\n\n` +
      "Issue joint rebuttal. Defend or replace the 1–2 most contested stations on merit. " +
      "Any replacement stop must be >800 m from all existing TTC stations AND all already-proposed stops above. " +
      "No stop may be a transfer to another stop on this same proposed line. Output compromise route block.",
    )) { yield chunk; fullReb = full; }
    const routeReb = extractRoute(fullReb);
    if (routeReb) yield sse({ type: "route_update", route: routeReb, round: 5 });

    // ── R6: Commission final ───────────────────────────────────────────────────
    const finalOccupied = stopsLabel(routeReb ?? current);
    let fullCom = "";
    for await (const { chunk, full } of turn(
      ag("commission"), sessions["commission"]!,
      brief + `\n\n**Alex:** ${fullA}\n**Jordan:** ${fullB}\n**Margaret:** ${fullN}\n` +
      `**Devon:** ${fullPr}\n**Rebuttal:** ${fullReb}\n\n` +
      `## All stops proposed across all rounds (occupied — 800 m exclusion zone):\n${finalOccupied}\n\n` +
      "Rule on each contested station on merit. Commit to mitigations. Revised PR score. " +
      "Any modified stop must be >800 m from existing TTC stations AND all other proposed stops listed above. " +
      "No stop may be a transfer to another stop on this same line. Output final route block.",
    )) { yield chunk; fullCom = full; }

    const routeFinal = extractRoute(fullCom) ?? routeReb ?? current;
    if (routeFinal) {
      let prScore: number | undefined;
      for (const src of [fullCom, fullPr]) {
        const m = /(?:PR Nightmare Score|score)[^\d]*(\d+)\s*\/\s*40/i.exec(src);
        if (m) { prScore = parseInt(m[1]!, 10); break; }
      }
      const payload: Record<string, unknown> = { type: "route_final", route: routeFinal };
      if (prScore !== undefined) payload.pr_score = prScore;
      yield sse(payload);
    }
  } catch (err) {
    yield sse({ type: "status", text: `Council error: ${String(err)}` });
  }

  yield sse({ type: "done" });
}
