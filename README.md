# Transit Planner

> **🏆 Winner — Hack Canada 2026**

Transit Planner is an AI-powered urban transit planning tool that simulates a city council deliberation to design, debate, and approve new transit routes. Built for Toronto, it combines multi-agent AI, real-time geospatial visualization, and voice narration to make transit planning accessible, transparent, and engaging.

---

## Features

### AI Planning Council
A structured 6-round deliberation where specialized AI agents debate a proposed transit route — each with distinct values, priorities, and personalities:

| Agent | Role | Model |
|---|---|---|
| **Alex Chen** | Ridership Planner — proposes routes for equity and underserved areas | Claude Sonnet |
| **Jordan Park** | Infrastructure Analyst — critiques costs, ROI, and feasibility | Claude Sonnet |
| **Margaret Thompson** | NIMBY Resident — raises neighborhood disruption concerns | Claude Haiku |
| **Devon Walsh** | PR Director — flags gentrification and displacement risks | Claude Haiku |
| **Alex & Jordan** | Joint Rebuttal — defend or revise the proposal | Claude Sonnet |
| **Planning Commission** | Final Decision — issues a binding verdict with mitigations | Claude Sonnet |

Each round streams in real-time. Routes update live on the map as agents propose alternatives.

### Interactive Map
- Draw custom routes or boundaries directly on the map
- Select neighborhoods and existing TTC stations as context
- See population density, traffic levels, and employment overlays
- View generated routes rendered in real-time as the council deliberates

### 3D Globe Landing Page
Animated Three.js globe with orbiting transit lines and trains, giving the app a cinematic entry point.

### Voice Narration
ElevenLabs text-to-speech narrates key quotes from each agent, with distinct voice IDs per character.

### Session History
All council sessions are persisted and replayable — review past deliberations and route outcomes.

---

## Tech Stack

**Frontend**
- Next.js 15 (App Router, React 19)
- TypeScript
- Mapbox GL + MapboxDraw — interactive map and route drawing
- Three.js + React Three Fiber — 3D globe visualization
- Tailwind CSS 4
- tRPC + React Query — type-safe API layer

**Backend**
- FastAPI (Python) — core AI orchestration engine
- Backboard.io — LLM API wrapper with thread-based conversations
- Anthropic Claude (Haiku 4.5 + Sonnet 4.5)
- ElevenLabs — text-to-speech per agent voice
- PostgreSQL + PostGIS — geospatial transit data
- Supabase — hosted database
- Go — routing management API

**Infrastructure**
- Monorepo with npm workspaces
- Docker
- GitHub Actions (CI/CD)

---

## Architecture

transit-planner/

├── web/                    # Next.js frontend
│   └── src/app/
│       ├── page.tsx        # Landing page (3D globe)
│       ├── map/page.tsx    # Main planning interface
│       └── api/
│           ├── council/    # Proxies to Python AI backend (SSE)
│           ├── tts/        # ElevenLabs text-to-speech
│           ├── traffic/    # Traffic data
│           └── population/ # Population density data
│
├── python_server/          # FastAPI — AI council engine
│   └── api/
│       ├── council.py      # 6-round multi-agent orchestration

│       ├── backboard.py    # LLM API wrapper (Claude via Backboard.io)

│       └── data_tools.py   # PostGIS queries, neighborhood GeoJSON

│
├── go_server/              # Routing management API

├── express_server/         # Express backend (optional services)

├── web_db/                 # Prisma schema

└── python_utils/           # Shared DB models (SQLAlchemy + PostGIS)






**Data flow:**
1. User selects neighborhoods/stations and submits a planning request
2. Next.js `/api/council` proxies the request to the Python FastAPI backend
3. Python fetches relevant transit data from PostgreSQL/PostGIS
4. The council orchestrator opens 6 sequential LLM threads via Backboard.io
5. Each agent streams their response back via Server-Sent Events
6. Frontend parses SSE events, updates the chat panel and map in real-time
7. Final approved route is rendered on the Mapbox map

---

## Getting Started

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env

# Start the frontend
cd web && npm run dev

# Start the Python backend
cd python_server && uvicorn api.main:app --reload
Requires: Node.js 20+, Python 3.11+, PostgreSQL with PostGIS, Mapbox API key, Anthropic API key (via Backboard.io), ElevenLabs API key.
```
Built At
Hack Canada 2026 — Top 10 Google - Build with AI Track


