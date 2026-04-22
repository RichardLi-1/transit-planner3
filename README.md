<div align="center">

# Transit Planner

_Design smarter cities, one route at a time._

![66FE219B-B97C-4352-A529-20B388656D78_1_201_a](https://github.com/user-attachments/assets/88ebaea1-07ac-419e-8425-58b83fd68a3e)

</div>

---

## Overview

Transit Planner is an AI-powered urban transit design tool built for city planners and researchers. Draw proposed subway routes on an interactive map of Toronto, and a council of AI agents — a transit planner, a cost analyst, a NIMBY resident, and a PR director — will debate the merits of your route in real time, drawing on real ridership data, population density, and infrastructure constraints.

No spreadsheets. No guesswork. Just a map, your cursor, and four AIs arguing about your decisions.

## Features

- **Interactive route builder** — draw, edit, and delete subway lines directly on a live Mapbox map of Toronto's transit network
- **AI route generation** — describe what you want and an AI assistant generates a proposed route
- **Multi-agent council deliberation** — four distinct Claude-powered personas debate every proposed route, surfacing trade-offs across cost, ridership, community impact, and public relations
- **Real ridership & population analysis** — stations are evaluated against real TTC boardings and PostGIS-based population heatmaps
- **Neighbourhood context** — click any area to see demographic and traffic data for that zone
- **Streaming responses** — all AI deliberation streams live via Server-Sent Events, so you see the debate unfold in real time
- **Street view integration** — preview proposed stop locations at street level

## Demo

Navigate to `http://localhost:3000/map` after setup to open the interactive planner.

The AI council can be triggered from the route panel once a route is drawn or generated.

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 (App Router), React 19, TypeScript |
| Styling | Tailwind CSS 4 |
| Mapping | Mapbox GL, Mapbox GL Draw |
| 3D | Three.js / React Three Fiber |
| AI Platform | Anthropic Claude (Haiku 4.5 & Sonnet 4.5) |
| Auth | NextAuth.js v5 |
| Database | PostgreSQL (multiple instances), Supabase (PostGIS) |
| Python Backend | FastAPI, SQLAlchemy, Alembic |
| Validation | Zod (TS), Pydantic (Python) |
| Containerization | Docker, Docker Compose |
| Deployment | Vercel (frontend) |

## How It Works

1. A planner draws or generates a new subway route on the map
2. The route — along with station locations, population data, and ridership figures — is passed to the AI council
3. Four Claude personas deliberate in structured turns:
   - **Alex** (Transit Planner) — proposes and defends the route
   - **Jordan** (Cost Analyst) — scrutinizes budget and infrastructure cost
   - **Margaret** (NIMBY Resident) — raises community and construction concerns
   - **Devon** (PR Director) — evaluates public perception and political feasibility
4. The council reaches a verdict with actionable feedback
5. The planner adjusts and re-submits — or proceeds to export

## Local Development

### Prerequisites

- Node.js 20+
- Python 3.12+
- A [Mapbox account](https://account.mapbox.com) (free tier works)
- An [Anthropic API key](https://console.anthropic.com) for AI features
- A [Supabase project](https://supabase.com) with PostGIS enabled (for population/traffic layers)

### Setup

```bash
# Clone and install
git clone https://github.com/evanzyang91/transit-planner.git
cd transit-planner
npm install

# Configure environment
cp .env.example .env
# Fill in the required values (see below)

# Start the Next.js frontend
npm run dev
```

Frontend runs at `http://localhost:3000`.

### Python Backend (for council deliberation & ridership data)

```bash
# From the repo root with a virtual environment active
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt

python -m uvicorn python_server.api.main:app --reload --port 8000
```

Backend runs at `http://localhost:8000`.

### Docker (all services)

```bash
docker-compose up
```

### Available Scripts

```bash
npm run dev            # Start Next.js with Turbopack
npm run build          # Production build
npm run start          # Serve production build
npm run lint           # ESLint
npm run typecheck      # TypeScript checks
npm run format:write   # Auto-format with Prettier
```

## Environment Variables

Create a `.env` file at the repo root from `.env.example`:

```bash
# Mapbox — required for map rendering
NEXT_PUBLIC_MAPBOX_TOKEN=pk.ey...

# Anthropic — required for AI council and route generation
ANTHROPIC_API_KEY=sk-ant-...

# Supabase — required for population heatmap and traffic layers
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your_anon_key

# NextAuth — required for authentication
NEXTAUTH_URL=http://localhost:3000
AUTH_SECRET=                      # generate with: openssl rand -base64 32

# Python backend URL (used by Next.js to proxy ridership requests)
PYTHON_SERVER_URL=http://localhost:8000

# PostgreSQL — multiple instances for service isolation
DATABASE_URL_GO=postgresql://postgres:postgres@localhost:5433/genghis
DATABASE_URL_PYTHON=postgresql://postgres:postgres@localhost:5434/genghis
DATABASE_URL_EXPRESS=postgresql://postgres:postgres@localhost:5435/genghis
DATABASE_URL_WEB=postgresql://postgres:postgres@localhost:5436/genghis
```

**Where to get keys:**
- **Mapbox**: [account.mapbox.com](https://account.mapbox.com) → Tokens
- **Anthropic**: [console.anthropic.com](https://console.anthropic.com) → API Keys
- **Supabase**: [supabase.com](https://supabase.com) → Project Settings → API

## Project Structure

```
transit-planner/
├── web/                        # Next.js app
│   └── src/
│       ├── app/
│       │   ├── map/            # Main map page
│       │   ├── api/            # API routes (AI, auth, data)
│       │   └── _components/    # UI components
│       └── server/             # Server-side clients (Anthropic, Supabase, etc.)
├── python_server/              # FastAPI backend
│   └── api/
│       ├── main.py             # App entrypoint & CORS
│       ├── council.py          # Multi-agent deliberation logic
│       └── ridership.py        # Transit ridership queries
├── python_utils/               # DB migrations (Alembic)
├── docker-compose.yml
├── Dockerfile.web
├── Dockerfile.web-backend
└── .env.example
```

## API Overview

### Next.js Routes

| Route | Purpose |
|---|---|
| `POST /api/ai/chat` | Stream AI assistant responses (SSE) |
| `POST /api/ai/station-summary` | AI summary for a station |
| `POST /api/council` | Trigger multi-agent council deliberation |
| `GET /api/traffic` | Traffic data from Supabase |
| `POST /api/ridership/station` | Station-level boardings |
| `POST /api/ridership/line` | Line-level ridership |
| `GET /api/population` | Population heatmap data |
| `GET /api/streetview` | Street view imagery |

### Python Backend (`:8000`)

| Route | Purpose |
|---|---|
| `GET /health` | Health check |
| `POST /council` | Council deliberation with streaming |
| `POST /ridership/station` | Station boardings query |
| `POST /ridership/line` | Line ridership query |

## Contributing

PRs are welcome. For anything beyond small fixes, open an issue first so we can align on approach.

## License

[MIT](LICENSE).
