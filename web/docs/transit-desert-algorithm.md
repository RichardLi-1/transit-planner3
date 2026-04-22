# Transit Desert Algorithm

**Source:** `web/src/app/_components/map/hooks/useTransitDesert.ts`

## What it does

Assigns every census population cell a **desert severity** score from 0–1.  
- `1.0` = dense population, terrible transit access (true transit desert)  
- `0.0` = either low population, or excellent nearby transit

The map renders these scores as a heatmap (transparent → yellow → orange → red).

---

## Pipeline

### 1. Input data

| Input | Source |
|---|---|
| `popRows` | Fetched from `/api/population` — each row is `{ latitude, longitude, population, area }` from Canadian census data |
| `allRoutes` | `[...ROUTES, ...userRoutes]` — built-in TTC/GO routes from `transit-data.ts` plus any user-drawn routes |

### 2. Flatten routes into stop entries

Every stop on every route is extracted into a flat list with its route's headway and mode weight attached:

```
stopEntries = [
  { coords: [lng, lat], headwayMin, modeWeight, routeId },
  ...
]
```

### 3. Normalize population density

```
density       = population / area          (people per unit area)
logDensity    = log(1 + density)           (log scale — density spans orders of magnitude)
densityNorm   = logDensity / max(logDensity)   (0–1)
```

`log1p` (i.e. `ln(1 + x)`) compresses the range so that an extremely dense urban core
doesn't completely drown out medium-density suburbs.

### 4. Compute access score per population cell

For each population cell, scan all stop entries to find:
- `nearestDist` — km to the closest stop (via Haversine formula)
- `nearestHeadway` — that stop's route headway in minutes
- `nearestModeWeight` — that stop's route mode weight
- `routesNearby` — distinct route IDs with a stop within 800m (the standard transit "walkshed")

Then:

```
distancePenalty   = 1 + nearestDist / 0.4
```
At 400m (comfortable walk baseline) → penalty = 2.0.  
At 1km → penalty = 3.5. Grows linearly; farther = harder to reach.

```
frequencyScore    = min(1,  30 / max(1, nearestHeadway))
```
30-minute headway = 1.0 (adequate service).  
60-minute headway = 0.5. Subway at 2–3min → capped at 1.0.  
> **Why 30, not 10?** Using 10min made every bus route score ~0.33, so almost
> all of Toronto (bus-served) looked like no transit at all. 30min is the
> threshold where a regular bus becomes "reasonable access."

```
connectivityBonus = min(1.5,  1 + (routesNearby.size − 1) × 0.1)
```
Each additional route within 800m adds 10% (up to 1.5×). A cell with 5 crossing
routes is meaningfully harder to strand than one with a single infrequent bus.

```
accessScore = min(1,  (frequencyScore × modeWeight × connectivityBonus) / distancePenalty)
```

#### Mode weights

| Mode | Weight | Rationale |
|---|---|---|
| subway | 1.0 | Fast, frequent, reliable |
| lrt | 1.0 | Same as subway for access purposes |
| go_train | 0.9 | Reliable but infrequent |
| streetcar | 0.9 | Fixed-route, more reliable than bus |
| bus | 0.85 | Still real transit; high weight because desert assessment is about access, not comfort |

> **Why are bus weights so high?** Transit desert assessment asks "do you have
> access to transit?" not "is the transit good?" A bus still dramatically
> reduces how much of a desert an area is. The old value of 0.5 deflated bus
> access scores so severely that bus-served areas looked indistinguishable from
> areas with no transit.

### 5. Desert severity

```
desertSeverity = densityNorm × (1 − accessScore)
```

This is the key formula. It combines two independent signals:
- **density** — we only care about deserts where people actually live
- **poor access** — we only flag an area if transit is genuinely hard to reach

| Scenario | desertSeverity | Why |
|---|---|---|
| Downtown subway corridor (dense, 100m from subway) | ~0.0 | accessScore ≈ 1.0 → zeroed out |
| Scarborough (medium density, 400m from frequent bus) | ~0.3–0.4 | medium density × medium access gap |
| Outer suburb (low density, 1km from rare bus) | ~0.1–0.15 | low density saves it from being priority |
| Dense area with no transit | ~0.9–1.0 | true desert |

---

## What triggers a recompute

The `useEffect` in `useTransitDesert` re-runs whenever any of these change:

```
[showTransitDesert, mapLoaded, popRawData, userRoutes]
```

Crucially, `userRoutes` is live state — **drawing a new route on the map immediately updates the transit desert heatmap**, so you can see in real time whether a proposed line improves access.

The heavy computation (`computeDesertScores`) is deferred with `setTimeout(fn, 0)` so
React can flush the `isComputing = true` re-render first (showing the "Computing…"
pulse in the UI) before the main thread locks up.

---

## Known limitations

- Only the **nearest stop** drives the distance/headway signals. A cell 300m from two routes
  is treated the same as one 300m from one route (except via `connectivityBonus`).
- Headway is pulled from `servicePattern.headwayMinutes` — a single peak-hour number.
  Off-peak or weekend gaps aren't modelled.
- User-drawn routes are assumed 30-minute headway (typical bus default) since they have no
  `servicePattern`.
