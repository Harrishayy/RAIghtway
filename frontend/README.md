# Raightway console (frontend)

The operator console for Raightway: review fleet dashcam footage, see every finding at its exact timestamp and on the map, read the report, and dispatch crews.

It talks to **the real backend by default** (FastAPI, `architecture.md` §5) through `RAIGHTWAY_API_URL`. For UI work without a backend, `pnpm dev:mock` runs it on a built-in sample city instead. Switching is configuration only (see [Connect a backend](#connect-a-backend)).

```
frontend/
├─ apps/web/          Next.js 16 app (the console)
└─ packages/core/     contracts, backend adapters, sample data (no React)
```

---

## Quick start

You need **Node 22+** and **pnpm 10** (pnpm comes with Node through corepack).

```bash
cd frontend
corepack enable              # once per machine; provides the pinned pnpm
pnpm install
cp apps/web/.env.example apps/web/.env.local   # then set RAIGHTWAY_API_URL
pnpm dev                     # http://localhost:3000, real backend
pnpm dev:mock                # or: built-in sample data, no backend needed
```

Open <http://localhost:3000>. You should see the **Review** desk with seven Toronto drives.

**Try the sample data:**
- Press **Run** on Review. The sample backend runs a ~14-second pipeline: findings appear live, and two of them merge into issues seen earlier.
- On **Dispatch**, press **Plan routes**.

### Scripts (run from `frontend/`)

| Command | What it does |
|---|---|
| `pnpm dev` | Dev server against the backend (`RAIGHTWAY_API_URL` in `.env.local`) |
| `pnpm dev:mock` | Dev server on built-in sample data |
| `pnpm build` / `pnpm start` | Production build / serve it |
| `pnpm typecheck` | TypeScript, every package |
| `pnpm lint` | ESLint, every package |
| `pnpm test` | Unit tests (vitest) |
| `pnpm check` | All three: run before you push |

---

## Connect a backend

Copy the example env file and edit it:

```bash
cp apps/web/.env.example apps/web/.env.local
```

The usual setup is the FastAPI backend from `architecture.md` §5:

```bash
# apps/web/.env.local
NEXT_PUBLIC_DATA_SOURCE=http
RAIGHTWAY_API_URL=http://localhost:8000      # or the VM, e.g. http://10.0.0.5:8000
```

Next proxies `/api/*` to `RAIGHTWAY_API_URL`, so the browser stays same-origin. You need no CORS on the backend and no secrets in the browser.

**Restart `pnpm dev` after changing env vars.** `NEXT_PUBLIC_*` values and the proxy target are read at startup, and baked in at build time for production.

### Settings for other backends

All of these are optional. Each has a comment in `.env.example`.

| Variable | Use it when |
|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | The browser should call the backend directly instead of through the proxy (the backend then needs CORS) |
| `NEXT_PUBLIC_API_ENDPOINTS` | Paths differ, e.g. `{"issues":"/v2/findings","videoFile":"/api/videos/{id}/file"}` |
| `NEXT_PUBLIC_API_CAPABILITIES` | Switch features on or off: `upload`, `dispatch`, `regenerateReport`, `similar`, `topicSearch`, `frames`. The UI hides what is off |
| `NEXT_PUBLIC_API_TIMEOUT_MS` | Slow endpoints (default 15000) |
| `NEXT_PUBLIC_POLL_LIVE_MS` / `NEXT_PUBLIC_POLL_IDLE_MS` | Polling while a job runs / when idle (defaults 1000 / 10000) |
| `NEXT_PUBLIC_DEPOT` | Where crews start: `lat,lon,label` |
| `NEXT_PUBLIC_BASEMAP` | `tiles` (default: real vector map from CARTO, keyless, falls back to the offline map automatically), `toronto` (offline schematic only) or `none` (plain grid) |
| `NEXT_PUBLIC_DEFAULT_DIRECTION` | Default look: `survey`, `night` or `paint` |

### Anything env vars can't express

Edit **`apps/web/src/config/backend.ts`**, the only file that knows about the backend. It covers:
- **Auth headers:** `headers: () => ({ Authorization: … })`.
- **Renamed fields or an envelope:** `transform: { issues: raw => raw.items }`.
- **A different stage vocabulary:** `stage: raw => …`.
- **A completely different service:** use `source: 'custom'` and return your own object implementing `RaightwayClient` (`packages/core/src/client/types.ts`).

Every response is validated by the zod schemas in `packages/core/src/schema.ts`, and validation is forgiving:
- A number sent as a string is converted.
- A missing optional field gets a default.
- A list item that can't be repaired is dropped, with a console warning, rather than breaking the screen.

The status chip (`layout/BackendStatus.tsx`) is built but not mounted, so check the backend with `curl $RAIGHTWAY_API_URL/api/health` or `pnpm backend:status`.

### What the backend is expected to serve

These are the defaults (`architecture.md` §5). All of them can be overridden as above.

| Endpoint | Used for |
|---|---|
| `GET /api/videos` | Footage list, live progress (polled) |
| `GET /api/videos/{id}` | `{video, issues}` for the open drive |
| `POST /api/run` | Run: analyse new footage live (the Footage pane's button) |
| `POST /api/videos` (multipart `file`) | Upload (the button is not mounted) |
| `GET /api/issues` | Map, Issues, Report, Dispatch |
| `GET /api/issues/{id}/similar` | Similar issues on the issue card |
| `GET /api/frames/{id}` | Frame image (a drawn placeholder is shown if missing) |
| `GET /api/report`, `POST /api/report` | Report (404 means "none yet") |
| `POST /api/dispatch` `{sites, days, min_severity, triage, zones}`, `GET /api/plan` | Dispatch plan; the latest plan |
| `POST /api/dispatch/recommend` | The Recommend card |
| `POST /api/videos/{id}/ask` | The Chat tab |
| `/api/facilities`, `/api/zones`, `/api/geocode`, `/api/hazards`, `POST /api/directions` | Sites, focus areas, road alerts and detours |
| `POST /api/search` `{query}` | Footage search and its timeline lane (only when `topicSearch` is on) |

**Optional extras the UI uses when present:**
- `Video.gps[]` (1 Hz `{t, lat, lon, heading, speed_kmh}`) drives the moving car on the map and the speed lane.
- `Video.video_url` (or `endpoints.videoFile`) enables real video playback. Without it, the player steps through finding frames.
- `Issue.place` shows a street name instead of coordinates.

---

## How the code is organised

```
apps/web/src/
  app/            routes only: (desk)/review, issues, report, dispatch
  features/       one folder per screen; screens never import each other
    review/         FootageList, Player, Timeline, Detections, ReviewDesk
    issues/         IssuesView, IssueCard
    report/  dispatch/  upload/  map/ (MapView, shared)
  domain/         client context, react-query hooks (polling), derive helpers
  layout/         Desk (movable panes), TopNav, BackendStatus
  ui/             presentational pieces: Icon, Dash, marks, Seg, Frame, StageTrack, State, Toaster
  state/          zustand: ui prefs (persisted), playback (shared playhead), toasts
  styles/         tokens.css (3 looks), components.css, app.css
  config/         env.ts (all env vars), backend.ts (the adapter config)
packages/core/src/
  types.ts        the data contract (mirrors backend models)
  schema.ts       zod parsing at the boundary
  client/         RaightwayClient interface + HTTP adapter
  mock/           sample city, live upload simulation, report + route stand-ins
  registry.ts     categories, presets, severity, stages: change these, not components
  derive.ts       counts, workload, baseline crews, plan legs
```

**Import direction:** `app → features → domain/layout → ui → styles`, with `@raightway/core` at the bottom. Features never import each other; shared screen pieces live in `features/map` and `features/issues/IssueCard`.

### Common changes

| I want to… | Do this |
|---|---|
| Add or rename a category | `packages/core/src/registry.ts` (+ its colour in `styles/tokens.css`, glyph in `ui/Icon.tsx`) |
| Add a screen | `app/(desk)/<name>/page.tsx` + `features/<name>/`, then a tab in `layout/TopNav.tsx` |
| Remove a screen | Delete its route folder and tab; nothing else depends on it |
| Add a pane to the desk | A body in `features/review/ReviewDesk.tsx` and an id in `state/ui.ts` |
| Change the look | Tokens in `styles/tokens.css` (one block per direction). Components never use raw colours (lint enforces it) |
| Call a new endpoint | A method on `RaightwayClient` + both adapters (`client/http.ts`, `mock/client.ts`) + a hook in `domain/queries.ts` |

---

## Using the console

| Where | Keys and gestures |
|---|---|
| Review | **K** or **Space** play/pause · **[ ]** previous/next finding · **← →** ±5 s |
| Timeline | Press and drag on any lane to scrub; click a mark to jump to it |
| Desk | Drag a pane's ⋮⋮ grip onto another pane to swap them (or focus the grip and use ← →). Drag a border to resize (or focus it and use ← →). Layout is remembered per browser |
| Top bar | Category preset (All / Graffiti / Roads / Streetscape), look (Survey / Night / Paint), backend status |

The layout adapts to the width each pane actually has, not just the window. Panes keep working from 200 px up and down to phone width.

---

## Maps

Every map goes through `features/map/MapView.tsx`, which has one set of props for every screen.
- **Tile engine (`TileMap.tsx`):** MapLibre GL over CARTO vector tiles, light, dark or Voyager to match the look.
  - Alerts are glyph markers per issue type (pothole, garbage, road block, graffiti, markings, sign) coloured by severity.
  - Pins cluster when zoomed out, and hazards pulse.
  - Hovering a pin shows an alert card; clicking selects it.
- **Fallback engine (`SchematicMap.tsx`):** dependency-free SVG with the same alerts and animations. It is used automatically if WebGL or the tiles are unavailable, and an "Offline map" badge shows.
- **Overlay:** an alert bar (counts per type, plus a button that steps through hazards) and a Key.
- **Dispatch is map-first:**
  - Crews and routes live in a collapsible panel.
  - After planning, a shift clock (08:00–16:00) plays the day: crews move along their routes and stops tick off.
  - Each stop shows its ETA, drive time and time on site.
  - All of it is derived from the backend's `Plan` (`stops`, `eta_min`, `path`) and work-order minutes, so a real cuOpt plan drops straight in.
- **The MapLibre worker** is copied to `apps/web/public/maplibre/` by `scripts/copy-maplibre-worker.mjs`, which runs automatically before `dev` and `build`.

## Design directions

There are three looks, Survey, Night Shift and Fresh Paint, over one component set. The design reference, with every component, the tokens and the build spec, is at `../docs/design/directions/index.html`. Open that file in a browser.

The console ships in Survey; preview another look with `NEXT_PUBLIC_DEFAULT_DIRECTION` (restart dev).

---

## Production

```bash
pnpm build && pnpm start          # port 3000; set PORT to change it
```

- Set `NEXT_PUBLIC_*` and `RAIGHTWAY_API_URL` **before `pnpm build`**: Next bakes them into the build.
- Fonts come from Google Fonts at build time through `next/font`, then are self-hosted. The build machine needs internet access; the browsers do not.
- The app is fully client-rendered behind a thin Next shell, so any Node 22 host works: the VM, a container, or Vercel.

## Troubleshooting

- **Screens show "Couldn't load this".** Check `RAIGHTWAY_API_URL`, and that `curl $RAIGHTWAY_API_URL/api/videos` works from the machine running Next. Restart the dev server after env changes.
- **A screen is empty but the backend has data.** Look in the browser console for `[raightway] dropped a … that does not match the contract`. It lists the fields that failed validation. Fix the backend, or add a `transform` in `config/backend.ts`.
- **Layout looks wrong after a code change to panes.** Clear the saved layout: `localStorage.removeItem('raightway:ui')` in the browser console.
- **`pnpm` not found.** Run `corepack enable`.
