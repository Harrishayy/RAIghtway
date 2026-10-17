# Frontend: notes for agents

The Raightway operator console. pnpm workspace: `apps/web` (Next.js 16, React 19) + `packages/core` (TypeScript, no React). Human setup is in `README.md`; this file is what you need to change code safely.

## Commands (run from `frontend/`)

```bash
pnpm install
pnpm dev                 # :3000 against the backend (RAIGHTWAY_API_URL in apps/web/.env.local)
pnpm dev:mock            # :3000 on built-in sample data (no backend needed)
pnpm check               # typecheck + lint + test, all packages; must pass before you finish
pnpm --filter @raightway/core test       # core unit tests only
```

Real backend is the default; sample data is opt-in. Never draw invented footage on a real backend (Frame `placeholder="blank"`). To configure the backend, see "Connect a backend" in `README.md`. In short: `apps/web/.env.local` with `NEXT_PUBLIC_DATA_SOURCE=http` and `RAIGHTWAY_API_URL=…`, then restart dev.

Next 16 has breaking changes from older versions. `apps/web/AGENTS.md` (written by `next dev`) says to read `apps/web/node_modules/next/dist/docs/` before using an unfamiliar Next API. Do that rather than relying on memory.

## Architecture in one screen

- **The only backend seam is `RaightwayClient`** (`packages/core/src/client/types.ts`).
  - Implementations: `client/http.ts` (REST, configurable) and `mock/client.ts` (sample city plus a live upload simulation).
  - `apps/web/src/config/backend.ts` picks one. UI code never calls `fetch` and never imports from `mock/`.
- **Every payload is parsed by zod** in `packages/core/src/schema.ts`.
  - Parsing is lenient on purpose: values are coerced, defaults are filled in, and bad list items are dropped with a warning.
  - Keep it that way. A backend drifting must degrade the UI, not crash it.
- **Types live in `packages/core/src/types.ts`** and mirror `architecture.md` §4. Fields marked "UI extra" are optional and the backend may omit them.
- **Registries** (`packages/core/src/registry.ts`) define categories, presets, severity, stages and models. Components read them, so never hard-code a category list in a component.
- **Server state** goes through react-query hooks in `apps/web/src/domain/queries.ts`. Polling is fast while any video is `queued`/`analysing` and slow otherwise.
- **Client state** is zustand in `apps/web/src/state/`:
  - `ui.ts` holds persisted preferences: direction, preset, desk order and widths. It has a defensive `merge` and `skipHydration`, and is rehydrated in `app/providers.tsx`.
  - `playback.ts` holds the single shared playhead (`videoId`, `t`, `selectedIssue`) that the player, timeline, map and tables all follow.

```
app/(desk)/<route>/page.tsx   thin, renders one feature
features/<screen>/            screen logic; never import another feature (shared: features/map, features/issues/IssueCard)
domain/                       hooks + pure helpers, no JSX except client.tsx
layout/                       Desk (panes), TopNav, BackendStatus
ui/                           presentational, no data fetching
styles/                       tokens.css → components.css → app.css
```

## Rules

- **No raw colours in components.**
  - Use CSS variables from `styles/tokens.css`. ESLint bans hex literals everywhere except `ui/Footage/scene.ts`, which draws a photographic placeholder.
  - Category colour is `[data-cat=…]` → `--cc`; severity is `[data-sev=…]` → `--sv`.
- **Three looks (`survey`, `night`, `paint`) share every component.**
  - A component must look right in all three. Check by switching "Look" in the top bar.
  - Direction-specific tweaks go in CSS as `[data-dir="night"] .x { … }`, never in TSX.
- **Panes must work at any width from 200 px**, because users drag and swap them.
  - Each `.pane` and `.card` is a CSS container. Adapt with `@container (max-width: …)` rules in CSS, or `useSize()` (`lib/useSize.ts`) when you need to measure, as the timeline ruler and the map do.
  - No fixed widths inside panes. Use `min-width: 0` and ellipsis on text that can be long.
- **Text must never overlap or be cut without an ellipsis.**
  - The map drops colliding labels.
  - The frame keeps the finding tag inside the frame and hides HUD text it would cover.
  - Follow the same pattern for anything new that measures text.
- **Every data view handles loading, error (with Retry) and empty** using `ui/State.tsx`.
- **Hide features the backend can't do**: check `client.capabilities.<name>`.
- **Model text uses `**bold**` markers.** Render it with `ui/RichText.tsx`. Never use `dangerouslySetInnerHTML`.
- **Accessibility**:
  - Interactive things are real `<button>`s or links.
  - Icon-only buttons have `aria-label`.
  - Keyboard paths exist for drag interactions (pane grips and resizers use ← →).
  - Respect `prefers-reduced-motion`; `app.css` already zeroes animations.

## Adding things

| Task | Steps |
|---|---|
| New endpoint | Add a method to `RaightwayClient`. Implement it in `client/http.ts` (with a `DEFAULT_ENDPOINTS` entry and a `transform` hook) and in `mock/client.ts`. Add a hook in `domain/queries.ts` with a key in `keys`. Add a test in `packages/core/test/`. |
| New field from the backend | Add it to `types.ts` (optional if it is UI-only), then to the zod schema in `schema.ts` with a `.catch(...)` default. |
| New screen | Add `app/(desk)/<name>/page.tsx`, `features/<name>/<Name>View.tsx`, and a tab in `layout/TopNav.tsx`. |
| New pane on the desk | Add a `PaneId` in `state/ui.ts` (and fix `DEFAULT_ORDER` plus the `merge` check), then a body in `features/review/ReviewDesk.tsx`. `Desk` currently lays out exactly three panes. |
| New category | Add it to `registry.ts` CATEGORIES (keep the colour-validated order). Add `--c-<id>` in all three token blocks, `[data-cat]` in `components.css`, and a glyph in `ui/Icon.tsx`. |

## Verifying UI changes

1. `pnpm check`.
2. `pnpm dev`, then click through Review → Issues → Report → Dispatch in each look.
3. On Review, drag the pane borders to their extremes and swap panes. Nothing should overlap or spill out.
4. Upload any file to see the live pipeline. Plan routes on Dispatch.

## Gotchas

- `NEXT_PUBLIC_*` env vars are inlined at build/dev start. Restart after changing them.
- `state/ui.ts` uses `skipHydration`. Don't read persisted values during SSR. The first render uses defaults, then `DirectionSync` rehydrates.
- The mock's routes follow the Toronto grid (`packages/core/src/geo/toronto.ts`). Real routes come from cuOpt as `path: [lat, lon][]`.
- **Maps:** `features/map/MapView.tsx` is the only entry point.
  - It picks `TileMap` (MapLibre, real tiles), or `SchematicMap` (SVG) when tiles or WebGL fail.
  - Keep both engines in step when you add a map feature: alerts, stops/ETAs, crew positions, animations.
  - Map colours come from CSS tokens, read at load by `palette()` in TileMap. Never hard-code them.
  - The MapLibre worker is served from `public/maplibre/`, copied by `scripts/copy-maplibre-worker.mjs` on predev and prebuild.
