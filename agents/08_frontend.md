# Agent 8: Frontend

**Read first:** `ui_spec.md` (all of it, especially the design principles), `architecture.md` §1 (demo flow), §3.9, §4 (data contract), §5 (API), and `agents/README.md`.

## Mission
The operations dashboard judges see for one minute: populated map → drop a clip and watch it analyse → click an issue for the frame with its box → report → dispatch with routes on the map. It should feel like a real city-operations product, not a template.

## You own
`frontend/` (React + Vite + Tailwind, TypeScript)

## Tasks
1. **Scaffold:** Vite + React + TS + Tailwind. `vite.config.ts` proxies `/api` → `http://localhost:8000` (one forwarded port, no CORS).
2. **Types + mocks:** mirror §4 as TS types in `src/api/types.ts`. Build against `src/mocks/*.json` (≥30 corpus issues around Toronto, 5 videos with one mid-analysis, a report and a plan) behind a `VITE_MOCK=1` switch, so you never wait on the backend.
3. **Data layer:** poll `GET /api/videos` and `GET /api/issues` every ~1 s while any video is `queued`/`analysing`, otherwise every ~10 s.
4. **Features** (all must-have, from the `ui_spec.md` table):
   - **Drop zone:** multi-file. The UI loops `POST /api/videos` one file at a time; each video shows a progress bar + stage text (`segmenting`, `checking 3/6`, `checking history`, `planning repairs`).
   - **Video directory + video page:** explanation; metadata (drive/clip ID, not dates, since PIE has no wall clock; duration; issue count by type and severity); its track on a mini-map; the issue list (re-sightings included).
   - **Toggleable map:** Leaflet / `react-leaflet` with a keyless basemap. Pins coloured by severity 1–5 with a legend showing the rubric meanings; "seen N times" on merged pins; provisional pins appear as pieces finish.
   - **Issue panel:** `<img src="/api/frames/{id}">` with an absolutely positioned box from the normalised `bbox` (nothing drawn server-side); category, severity, description, work order, "seen N times", and 3–5 similar-issue thumbnails from `GET /api/issues/{id}/similar`, each clickable.
   - **Report:** summary, counts, recommended crews with rationale, "updating…" while it regenerates.
   - **Dispatch:** a crew form pre-filled from the report's crews and editable → `POST /api/dispatch` → one colour per crew route drawn on the map, ETAs per stop, "3 of 4 crews needed", the unassigned list, and a "fallback routing" label when `solver === "fallback"`.
5. **Design, following `ui_spec.md`:** a clean dashboard, no "map left / panel right" layout, the map as one toggleable part, nothing on screen without a purpose. Restrained palette; severity colours that work for colour-blind viewers. Small replay/"fallback" notes stay honest but understated.

## Gate check
- The node part of gate 7: `node -v` on the VM. If it's missing, use nvm, or run Vite on a laptop with `/api` proxied to the forwarded backend port.

## Milestones
- **~11:30:** shell on mock data: drop zone, directory, map, frame + box.
- **~14:00:** wired to the real backend: live progress, provisional pins, video pages, similar issues.
- **~15:00:** report + dispatch + routes. Feature freeze.

## Done when
- The full one-minute demo flow works against the real backend through the single forwarded port.
- It looks right at a projector resolution (1920×1080) and on a laptop screen.

## Out of scope
Any backend code. If the API shape needs to change, ask agent 1 rather than working around it.
