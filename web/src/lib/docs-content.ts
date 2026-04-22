const USER_DOCS = `
# Transit Planner — User Documentation

## Overview
The main workspace lives at /map. It combines a Mapbox-based editor, a Lines panel for route
visibility and management, and optional AI-assisted planning tools. All edits are reflected live
on the map. Core features: Map editor, Lines panel, AI council, GTFS round-trip.

## Map Basics
- Pan and zoom like any standard web map.
- Use the top-center toggles to show/hide overlays such as Population Density and Traffic.
- Switch tools in the top-center draw toolbar: Explore mode (browse), Select neighbourhoods, and Boundary drawing.
- Tip: Use scroll-to-zoom on the map canvas. Hold Ctrl/Cmd and drag to rotate or tilt the view.

## Lines Panel
The Lines panel (top-left) groups lines by mode: Subway/LRT, Streetcar, and Bus. Each section can be
collapsed, and each route can be shown or hidden independently. Bus routes start collapsed and hidden by default.
- Collapse a section using its caret. Expand it to see individual routes.
- Show/Hide all routes in a section using the eye icon on the section header.
- Show/Hide a single route using the eye icon that appears when hovering a route row.

## Add Stops to a Line
To add stations to an existing or custom line, select it from the Lines panel using the colored pill button
on the left of the route row. The app will enter "add station" mode and prompt you to click the map.
- Click the line's colored pill button to start adding stations.
- Click anywhere on the map to drop a new station.
- Click "Done" in the banner to exit add-station mode.
- Use Undo/Redo in the bottom toolbar to revert recent edits.
- Note: You can click an existing station to open its detail popup, which shows connections, population served, and AI-generated station analysis.

## Neighbourhood Selection & Boundaries
- Use Select Neighbourhoods mode to click neighbourhood polygons and build context for planning.
- Use Boundary mode to draw a freeform polygon area of interest on the map.
- Selected neighbourhoods and boundaries are used as planning context in the AI council flow.
- Click a neighbourhood to view population density, traffic levels, and employment data.

## Import & Export (GTFS)
Use the Import and Export GTFS buttons (top-right area of the map) to round-trip data between the editor and GTFS format.
- Export GTFS: Generates a GTFS ZIP from your current lines and validates the result before download.
- Import GTFS: Loads a GTFS ZIP (or JSON export) and replaces current custom lines and stop edits.

## AI Planning Council
The council is a structured multi-round discussion between specialized AI agents that propose and critique a route.
It can stream route previews and produce a candidate line that you can further edit.
- Use "Generate Route" to start a new council run when you have enough context selected (neighbourhoods and/or boundary).
- Use "View Council" to reopen the council UI for the current session.
- When a proposed line is created, it appears as a custom line and is fully editable.
- Each AI agent focuses on a different lens: ridership, coverage, equity, transfers, and feasibility.
- Tip: Select a few neighbourhoods before running the council to give the AI agents better spatial context for their proposals.

## Roadmap Items (User Features)
Currently in active development:
- Accessibility analysis inputs — street network, zones, destinations, demographics
- r5-based routing engine integration and open-source accessibility/equity libraries
- Interactive dashboard for travel times, accessibility results, and equity indicators
- Expanded export formats beyond GTFS: maps, datasets, and summary reports
`.trim();

const TECHNICAL_DOCS = `
# Transit Planner — Technical Documentation

## Overview
Transit Planner is a Next.js (App Router) frontend centered around an interactive Mapbox GL editor.
It includes GTFS import/export utilities and an AI council interface that can stream route proposals.
The application is structured as a single Next.js project under /web. All client-facing logic lives
in src/app and src/lib. Server-side API routes live under src/app/api.

## Technology Stack
- Next.js 15 — App Router framework
- React 19 — UI rendering
- Mapbox GL — Map rendering
- Tailwind CSS 4 — Styling (no component library, all custom)
- Three.js — 3D globe on landing page only
- Auth0 — Authentication
- Supabase (PostgreSQL + PostGIS) — Data persistence
- Anthropic Claude — AI council agents
- ElevenLabs — TTS for agent voice quotes
- Google Sans — Typography

## Primary Modules

### Map Editor
- TransitMap.tsx (src/app/_components/TransitMap.tsx): The main Mapbox GL editor. Manages all map state:
  routes, stops, neighbourhoods, draw modes, overlays, undo/redo, GTFS export/import, and council preview visualization.
  ~4100 lines. Uses 50+ useState hooks and ref-based state for event handlers to avoid stale closures in Mapbox callbacks.
- RoutePanel.tsx (src/app/_components/map/RoutePanel.tsx): Displays route details, stops list, population served, and line controls.
- StationPopup.tsx (src/app/_components/map/StationPopup.tsx): Positioned popup with station info, connections,
  AI-generated station analysis, and estimated ridership.
- NeighbourhoodPanel.tsx (src/app/_components/map/NeighbourhoodPanel.tsx): Shows neighbourhood context:
  population density, traffic level, employment info, street view imagery, and transit lines in the area.

### AI & Chat
- ChatPanel.tsx (src/app/_components/ChatPanel.tsx): Multi-agent chat interface. Hosts five distinct planning agents,
  streams responses, extracts route proposals from markdown, and generates HTML reports.
- council.ts (src/server/council.ts): 6-round multi-agent deliberation orchestrator. Six agents:
  1. Alex Chen — Transit Planner (Sonnet)
  2. Jordan Park — Urban Developer (Haiku)
  3. Margaret Thompson — NIMBY resident (Haiku)
  4. Devon Walsh — Environmental consultant (Haiku)
  5. Rebuttal — synthesizer (Sonnet)
  6. Planning Commission — final verdict + structured route output (Sonnet)

### GTFS Utilities
- gtfs.ts (src/lib/gtfs.ts): Generates core GTFS CSVs and zips them for download. Includes built-in validation.
- gtfs-import.ts (src/lib/gtfs-import.ts): Reads a GTFS ZIP and converts it into Route objects.

### Data
- transit-data.ts (src/app/map/transit-data.ts): Base Toronto TTC/GO routes and stops (~745KB). Starting dataset.
- geo-utils.ts (src/app/map/geo-utils.ts): Geospatial helpers: haversine distance, bounds, coordinate projections.

## Route Data Types
\`\`\`ts
type Route = {
  id: string; name: string; shortName: string;
  color: string; textColor: string;
  type: "subway" | "lrt" | "streetcar" | "bus" | "go_train";
  stops: Stop[];
  shape?: [number, number][];
  portals?: { coords: [number, number] }[];
  _variantId?: string;
}
type Stop = { id?: string; name: string; coords: [number, number] }; // [lng, lat]
\`\`\`

## Runtime & Deployment
- Local development: Run the Next.js dev server (npm run dev from /web) and point it at your own backing services.
- Self-hosted / server: Build and deploy to any Node.js platform (Vercel, Fly.io, AWS, etc.).
- Mapbox dependency: Requires a public Mapbox access token. Map tiles and geocoding run client-side.
- Dev commands: npm run dev (Turbo dev server), npm run build, npm run typecheck, npm run check (lint + typecheck).

## Environment Variables
- NEXT_PUBLIC_MAPBOX_TOKEN (Required): Public Mapbox access token. Exposed to the browser.
- ANTHROPIC_API_KEY (Required for docs chat): Anthropic API key for the docs RAG bot.
- AUTH0_SECRET (Optional): Auth0 session secret for server-side session encryption.
- AUTH0_BASE_URL (Optional): Base URL of your deployment for Auth0 callback URLs.
- AUTH0_ISSUER_BASE_URL (Optional): Your Auth0 tenant domain.
- AUTH0_CLIENT_ID (Optional): Auth0 application client ID.
- AUTH0_CLIENT_SECRET (Optional): Auth0 application client secret. Server-side only.
- NEXT_PUBLIC_SUPABASE_URL (Optional): Supabase project URL.
- NEXT_PUBLIC_SUPABASE_ANON_KEY (Optional): Supabase anonymous public key.
- ANTHROPIC_API_KEY: Anthropic API key for AI council agents.
- ELEVENLABS_KEY: ElevenLabs API key for agent voice TTS.
- DISCORD_WEBHOOK_URL (Optional): For analytics/notifications.

## Roadmap (Technical)
- Accessibility analysis inputs: Upload/retrieve datasets for accessibility analysis.
- r5 routing integration: Integration with r5 routing engine and open-source equity libraries.
- Accessibility dashboard: Dashboard for travel times, accessibility results, and equity indicators.
- Expanded exports: Export formats beyond GTFS — maps, full datasets, and summary reports.
- AI council and chat now run directly on Anthropic.
- AI agent tool calls: query_stops_near(lat, lng, radius_m), get_population_density(bbox), etc.
`.trim();

// 📖 Learn: This function is called at query time (in the API route).
// It builds the full text corpus that gets injected into Claude's system prompt.
// Think of it like the "documents" you'd retrieve from a vector DB, except here
// we retrieve all of them because the total size is small.
export function buildDocsCorpus(): string {
  return `=== USER DOCUMENTATION ===\n\n${USER_DOCS}\n\n=== TECHNICAL DOCUMENTATION ===\n\n${TECHNICAL_DOCS}`;
}
