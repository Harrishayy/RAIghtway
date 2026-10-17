<div align="center">

# Raightway

**Fleets already film every street, every day. Raightway turns that footage into tomorrow's maintenance plan.**

It watches dashcam video, finds what a city would send a crew to fix, decides how to fix each one,
and routes the right crew to it, with every job linked to the frame that shows it.

[![Next.js 16](https://img.shields.io/badge/Next.js-16-000000.svg?logo=nextdotjs&logoColor=white)](frontend/)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688.svg?logo=fastapi&logoColor=white)](backend/)
[![NVIDIA Cosmos](https://img.shields.io/badge/NVIDIA-Cosmos%20·%20Nemotron%20·%20cuOpt-76B900.svg?logo=nvidia&logoColor=white)](#sponsor-stack)
[![VAST Data](https://img.shields.io/badge/VAST-VastDB%20·%20S3%20·%20VSS-E4002B.svg)](#sponsor-stack)
[![W&B Weave](https://img.shields.io/badge/W%26B-Inference%20·%20Weave-FFBE00.svg?logo=weightsandbiases&logoColor=black)](#sponsor-stack)
[![CoreWeave](https://img.shields.io/badge/CoreWeave-GPUs-2741E7.svg)](#sponsor-stack)

Built at the **VAST Builders Challenge**, London, 17 Oct 2026 · Track: *Real-time video agents*

</div>

---

## See it working

Recordings of the real console on the live backend and real Toronto footage, nothing staged. The strip at
the bottom of each one names the sponsor service answering at that moment; idle waits for the network are cut.

**The whole pipeline, with live numbers.** Six stages from footage to crews, each with the sponsor
service that runs it, and the W&B Weave traces those services left behind.

![Six stages from VAST footage to cuOpt routes, with live counts and W&B Weave trace counts](docs/media/pipeline.gif)

**1. See: Cosmos finds every defect.** A Toronto drive from the VAST index plays back. Every finding is
boxed on the frame Cosmos3-Reason (on CoreWeave GPUs) saw it in, pinned on the map from the drive's GPS,
and re-graded from its close-up with a one-line reason.

![Review: a drive plays with Cosmos boxes on each finding, pins on the map and the severity reason](docs/media/review.gif)

**2. Search and ask: VSS and Nemotron.** A plain-language search runs over the VAST VSS index; Nemotron
on W&B Inference answers from the matches and the issues already logged. Then a question to the drive,
answered from its VSS captions, with times that seek the player.

![Footage search for potholes over VSS, Nemotron's answer, and Ask about a drive with VSS evidence](docs/media/search.gif)

**3. Remember and decide: one issue, end to end.** The worst hazards city-wide; one opens with Cosmos's
box and grade, Nemotron's work order, and similar issues found by vector search inside VastDB.

![Issues: a severity-5 work zone with its frame, Cosmos grade, Nemotron work order and VastDB similar issues](docs/media/issues.gif)

**4. Decide: tomorrow's report.** Nemotron 3 Ultra writes the situation report; every figure in it comes
from code, and its provenance says which model answered each step.

![Report: Nemotron Ultra's summary, the priority list, and the data provenance](docs/media/report.gif)

**5. Act: crews routed by cuOpt.** Nemotron proposes crew scenarios and cuOpt solves each to score them;
cuOpt routes every crew from its own yard around the City's live closures. Play the shift to watch them go.

![Dispatch: cuOpt routes, the Nemotron and cuOpt recommendation, road alerts, and shift playback](docs/media/dispatch.gif)

Full-quality versions sit next to each GIF in [`docs/media/`](docs/media/) as `.mp4`. Re-record them all
with `python3 docs/media/record.py` (see [`docs/media/README.md`](docs/media/README.md)). Live analysis
(**Run**) isn't recorded here: each Run spends 30 s of footage no pass has analysed yet.

---

## The problem

Keeping streets in working order means finding and fixing a long tail of small problems: potholes,
graffiti, faded crossings, unsafe work zones, damaged signs, dumped rubbish. Cities find them in two
ways today, and both are poor:

- **Manual inspection** is slow and expensive, so most streets go months between visits.
- **311 complaints** are reactive and uneven. Issues get reported where people complain most, not
  where the need is greatest, and reports rarely say which crew or equipment the job needs.

Even once an issue is known, a planner still decides by hand **which crew goes where, in what order,
with what kit**, separately for each department.

Meanwhile buses, refuse trucks, delivery vans and autonomous vehicles film those same streets every
day, and that footage sits in storage, unwatched. Raightway needs no new sensors and no new staff:
the streets are already being filmed.

## What it does

| Step | What happens | Model or service |
|---|---|---|
| **See** | Each 5 s piece of footage is checked for six kinds of defect: pavement, graffiti, markings, work zones, signage, waste. Each finding gets a severity from 1 to 5 using a fixed rubric, a confidence and a short description. | NVIDIA **Cosmos3-Reason** |
| **Locate** | The finding is boxed on its keyframe and placed on the map from the vehicle's 1 Hz GPS log. | Cosmos3-Reason, PIE GPS |
| **Remember** | A finding of the same category within 35 m of a known issue becomes a re-sighting of it instead of a new job. Its crop is also embedded, so the issue card can show similar issues across the city. | PIE GPS (dedupe); NVIDIA **Cosmos-Embed1** + **VastDB** vector search (similar issues) |
| **Decide** | Every new issue gets a work order: the repair, the crew type, minutes on site, equipment and urgency. A city-wide report recommends how many crews of each type to send. | **Nemotron** on **W&B Inference** |
| **Act** | Nemotron triages every job into today, later or defer, and proposes crew sizes that cuOpt scores. cuOpt routes each crew type as round trips from its own sites over one to seven days (lunch breaks, severity-5 jobs before noon), on street times and around City road closures. | **Nemotron Ultra**, NVIDIA **cuOpt**, OSRM, City of Toronto road restrictions |
| **Search and ask** | Search all footage in plain language: VSS finds the moments, the console maps them onto drives and timelines, and Nemotron answers from the matches and the issues already logged there. Ask a drive questions, answered from its VSS captions and findings. Every drive gets a grounded summary. | **VAST VSS** index, **Nemotron Lightning** |

On the current corpus (16 drives, about 1.5 hours of footage), Cosmos found **469 issues** in 572 sightings.
Its re-grading pass judged 145 of them not to be defects, which leaves **324 open issues** for the report
and the crews (17 Oct).

---

## Architecture

```mermaid
flowchart TB
  subgraph INGEST["1 · Ingest — VAST AI OS"]
    direction LR
    PIE["Fleet dashcam footage<br/>Toronto PIE, pie_cam-3"] --> S3[("VAST S3<br/>segments")] --> VSS["VSS index<br/>vss-collection"]
    GPS["Vehicle OBD logs<br/>1 Hz GPS"]
  end

  subgraph SEE["2 · See — NVIDIA models on CoreWeave GPUs"]
    direction LR
    FIND["Find defects<br/>Cosmos3-Reason"] --> BOX["Box and grade the keyframe<br/>Cosmos3-Reason"] --> EMBED["Embed the crop<br/>Cosmos-Embed1"] --> PLACE["Place on the map<br/>GPS at that second"]
  end

  subgraph REMEMBER["3 · Remember — VastDB"]
    direction LR
    DEDUPE{"Same category<br/>within 35 m?"}
    SIMILAR["Similar issues<br/>VastDB vector SQL"]
    DEDUPE -- "yes" --> RESIGHT["Re-sighting<br/>of a known issue"]
    DEDUPE -- "no" --> NEW["New issue"]
  end

  subgraph DECIDE["4 · Decide — Nemotron on W&B Inference"]
    direction LR
    ORDER["Work order<br/>Nemotron Lightning"] --> REPORT["City report and crews<br/>Nemotron Ultra"]
    SEARCH["Footage search and Ask<br/>VSS + Nemotron Lightning"]
  end

  subgraph ACT["5 · Act — NVIDIA cuOpt"]
    direction LR
    TRIAGE["Today, later, defer<br/>Nemotron Ultra"] --> PLAN["Crew routes from their bases<br/>cuOpt"]
    ROADS["Street times and closures<br/>OSRM, City of Toronto"] --> PLAN
  end

  DB[("VastDB · system of record<br/>videos, issues, GPS, reports, plans<br/>keyframes in VAST S3")]
  UI["Operator console · Next.js<br/>Review · Issues · Report · Dispatch"]
  WEAVE["W&B Weave<br/>traces and evaluations"]

  VSS -- "5 s pieces" --> FIND
  GPS --> PLACE
  PLACE --> DEDUPE
  NEW --> ORDER
  RESIGHT --> DB
  ORDER --> DB
  REPORT --> DB
  EMBED -.->|vector| SIMILAR
  VSS --> SEARCH
  SEARCH --> UI
  DB --> TRIAGE
  DB -- "REST API" --> UI
  PLAN -- "plan" --> UI
  SEE -.-> WEAVE
  DECIDE -.-> WEAVE

  classDef vast fill:#fde8ec,stroke:#E4002B,color:#3a0a12
  classDef nvidia fill:#eef7dc,stroke:#76B900,color:#1f3300
  classDef wandb fill:#fff6d6,stroke:#C99400,color:#3d2e00
  classDef app fill:#eef1f8,stroke:#4a5a80,color:#141b2d
  classDef ext fill:#f4f4f4,stroke:#999,color:#222
  class S3,VSS,SIMILAR,DB vast
  class FIND,BOX,EMBED,PLAN nvidia
  class ORDER,REPORT,SEARCH,TRIAGE,WEAVE wandb
  class DEDUPE,RESIGHT,NEW,PLACE,UI app
  class PIE,GPS,ROADS ext
  style INGEST fill:#fbfbfc,stroke:#c9ced8
  style SEE fill:#fbfbfc,stroke:#c9ced8
  style REMEMBER fill:#fbfbfc,stroke:#c9ced8
  style DECIDE fill:#fbfbfc,stroke:#c9ced8
  style ACT fill:#fbfbfc,stroke:#c9ced8
```

**How one piece of footage flows.** VSS hands over a 5 s piece and Cosmos3-Reason lists the defects in
it. Each finding is boxed on its keyframe (Nemotron Super-VL steps in if the box fails) and re-graded by
Cosmos from the boxed close-up, its crop is embedded by Cosmos-Embed1, and the GPS log at that second
places it on the map. Dedupe checks the same clip first, then the known issues of the same category
within 35 m. A match becomes a re-sighting; anything else is a new issue, and Nemotron writes its work
order. Dedupe is location-first on purpose: on this footage, crop similarity between drives was 0.1–0.6
even for the same pothole, so the embeddings power *similar issues* (VastDB vector search) rather than
the merge decision. The backend's store keeps a local snapshot and writes to VastDB in the background, so a slow
database never blocks the console.

**Every integration has a fallback, and the console says which path answered.** If cuOpt is down,
dispatch uses a nearest-neighbour plan and the screen says *Fallback routing*. If VastDB search is
unreachable, similar issues come from an in-memory index and are labelled *local index*. A fallback is
never shown as the sponsor service. The full map of what calls what is in
[`backend/CLAUDE.md`](backend/CLAUDE.md#sponsor-integrations-what-calls-what-and-how-to-prove-it-ran).

The data contract is [`architecture.md` §4](architecture.md#4-data-contract) and the API is
[§5](architecture.md#5-api). The backend's pydantic models and the console's zod schemas are kept in step with both.

---

## Sponsor stack

The challenge's stack, layer by layer:

| Layer | Sponsor | What Raightway uses it for |
|---|---|---|
| **Coding agent** | SpaceXAI (Cursor) | Built with coding agents working in parallel from the briefs in [`agents/`](agents/) |
| **Agent runtime and platform** | **VAST Data** | VastDB as the system of record (videos, issues, GPS, reports, plans). VastDB vector SQL over ADBC for similar issues. VAST S3 for keyframes and the footage Run analyses. The VSS index (`vss-collection`) for the segment inventory, plain-language footage search, the captions behind Ask, and clip download |
| **Model services** | **NVIDIA** | Cosmos3-Reason (find, box, severity re-grading)¹, Cosmos-Embed1 (vectors), Nemotron 3.5 Lightning (work orders, drive summaries, search answers, Ask), Nemotron 3 Ultra (report, triage, crew recommendation), Nemotron 3.5 Super-VL (box and grading fallback), cuOpt (crew routing and scoring crew scenarios) |
| | **CoreWeave** | The GPUs serving the Cosmos models, and the infrastructure behind W&B Inference |
| | **Weights & Biases** | W&B Inference serves Nemotron. Weave traces every model call (text only, never media) and runs the evaluations in [`scripts/weave_eval.py`](scripts/weave_eval.py) |

¹ Served on the event endpoint as `nvidia/cosmos3-nano-reasoner`, from the Cosmos3-Reason family.

---

## Inputs and outputs

**In:**
- `pie_cam-3` dashcam segments from the [PIE dataset](https://data.nvision2.eecs.yorku.ca/PIE_dataset/) (Toronto, 1080p), pre-ingested into VSS: 1080 segments over sets `set01`–`set06`.
- The matching vehicle OBD logs (`annotations_vehicle/*_obd.xml`), turned into 1 Hz GPS by `scripts/load_gps.py`.

**Out** (shapes in [`architecture.md` §4](architecture.md#4-data-contract)):

| Output | Shape | Example |
|---|---|---|
| Issue | category, severity 1–5, confidence, description, normalised bbox, lat/lon, sightings, `duplicate_of` | `signage · S4 · 95% · "Stop sign partially obscured by graffiti" · 43.71676, -79.40310` |
| Work order | repair, crew, minutes, equipment, urgency | `Fill pothole with asphalt patch and compact surface · roads · 75 min · routine` |
| Report | summary, counts by category and severity, recommended crews, rationale | `markings 178, pavement 119 … → roads 22, markings 22, inspection 11 …` |
| Plan | per crew: base, ordered stops, ETAs, street path, road warnings, run sheet; `solver: cuopt` or `fallback` | |

---

## Evaluation

| What | Command | Checks |
|---|---|---|
| Work orders | `.venv/bin/python ../scripts/weave_eval.py orders --limit 20` | Nemotron covers every issue, minutes are plausible for the category, equipment is listed. Needs no labels. Results land in the W&B project |
| Issue finding | `.venv/bin/python ../scripts/weave_eval.py find --labels <file.jsonl>` | Cosmos category precision and recall on hand-labelled clips, and whether clean clips stay clean |
| Severity grading | `.venv/bin/python ../scripts/rate_severity.py --eval ../scripts/severity_labels.json` | Cosmos3-Reason's grade and defect/not-a-defect verdict against 27 hand labels from a frame-by-frame review of corpus keyframes |
| Live services | `python -m app.ai.gatecheck`, `python -m app.vast.gatecheck`, `python -m app.planning.cuopt --toy` | Each model endpoint, VastDB tables, ADBC vector search and cuOpt, with timings |
| Backend | `cd backend && python3 -m pytest -q` | Offline (124 tests): dispatch, closures, category routing, triage, recommendations, zones, report, rating, Run, footage search, Ask, summaries, manual issues, sponsor-path reporting, trace redaction |
| Console | `pnpm check` | Typecheck, lint, and unit tests for the contract parsers, HTTP client and sample data |

Every run also records its own provenance: the Report screen lists which model wrote it, which model graded
each issue's severity, and how many work orders fell back to templates.

<!-- Paste the Weave evaluation link and headline scores here once run. -->

---

## Run it

**Without the workshop VM** (no credentials): the console on sample data, and every test.

```bash
corepack enable               # Node 22+, pnpm 10
pnpm install --dir frontend
pnpm dev:mock                 # http://localhost:3000
pnpm check                    # console typecheck, lint and tests
pip install fastapi pydantic numpy httpx pytest
cd backend && python3 -m pytest -q   # backend, offline: models, VAST and cuOpt are stubbed
```

The live pipeline needs the event's GPU endpoints, VastDB, VAST S3 and VSS, which are reachable only from the VM.

**Against the real backend.** The backend runs on the workshop VM, where VastDB, VAST S3, the VSS API and
the GPU endpoints are reachable. Credentials are read from `/config` on the VM and never leave it.

```bash
# on the VM
cd backend && ./run.sh        # uvicorn on :8000

# on your laptop: starts the VM backend if needed, tunnels it to :8001 and runs the console
pnpm dev
```

| Command (repo root) | What it does |
|---|---|
| `pnpm dev` | VM backend + SSH tunnel + console, with a reconnect watchdog |
| `pnpm dev:mock` | Console on built-in sample data |
| `pnpm check` | Typecheck, lint and test the console |
| `pnpm backend:status` · `backend:restart` · `backend:logs` | Manage the uvicorn on the VM |

Populate the corpus once: build the inventory (`scripts/build_inventory.py`) and the GPS
(`scripts/load_gps.py`), then either `POST /api/admin/precompute/start` or import a Cosmos sweep with
`scripts/import_sweep.py`.

---

## API

| Route | Returns |
|---|---|
| `GET /api/videos` · `GET /api/videos/{id}` | Drives with live progress; one drive with all its findings |
| `POST /api/run` | Analyse up to three clips live: footage in the VAST index nobody has analysed, then re-checks |
| `POST /api/search` | Plain-language footage search over VSS, mapped onto drives, with Nemotron's answer |
| `POST /api/videos/{id}/ask` | Ask a drive a question, answered from its VSS captions and findings |
| `POST /api/videos` | Upload a clip; analysis starts |
| `GET /api/issues` | Open issues across the city |
| `GET /api/issues/{id}/similar` | Nearest issues by VastDB vector search, with distance and which index answered |
| `GET /api/frames/{id}` | The keyframe JPEG |
| `GET` · `POST /api/report` | Latest report; regenerate it |
| `POST /api/dispatch` · `GET /api/plan` | Triage and a multi-day crew plan from the given sites; the latest plan |
| `POST /api/dispatch/recommend` | Crew scenarios proposed by Nemotron and scored by cuOpt |
| `GET /api/facilities` · `GET /api/hazards` · `POST /api/directions` | Crew bases, road alerts, a route between two points around closures |
| `GET /api/health` | Up, and whether the store loaded from VastDB |

The full list, with request and response shapes, is [`architecture.md` §5](architecture.md#5-api).

---

## Repo layout

```
.
├── backend/                FastAPI + pipeline (runs on the VM)
│   ├── app/ai/             Cosmos, Cosmos-Embed1, Nemotron clients, prompts, Weave tracing
│   ├── app/vast/           VastDB tables, ADBC vector search, VAST S3 media
│   ├── app/pipeline/       piece → dedupe → live analysis, corpus pre-compute, VSS client
│   ├── app/planning/       dispatch (cuOpt), report, road closures, crew bases
│   ├── app/geo/            GPS, segment inventory, OSRM road times
│   └── tests/              offline pytest
├── frontend/               pnpm workspace
│   ├── apps/web/           Next.js 16 operator console
│   └── packages/core/      contract types, zod schemas, HTTP client, sample city
├── scripts/                inventory, GPS, sweep import, severity rating, Weave evals
├── agents/                 the build-day workstream briefs
├── docs/                   design directions, README media
└── architecture.md         the system, data contract (§4) and API (§5)
```

Notes for coding agents are in [`CLAUDE.md`](CLAUDE.md), [`backend/CLAUDE.md`](backend/CLAUDE.md) and
[`frontend/CLAUDE.md`](frontend/CLAUDE.md).

---

## Limitations

- **One city, one camera.** The corpus is Toronto PIE footage from a single forward camera. Side-of-road
  defects out of frame are missed.
- **Cosmos is conservative.** It is told that most clips have no defect, so it under-reports rather than
  invents. Recall on small defects is the weak point; the `find` evaluation measures it.
- **Dedupe is location-first.** Two different defects of the same category within 35 m merge into one
  issue. Crop similarity didn't separate same from different defects on this footage, so it isn't used.
- **Crew bases are partly assumed.** 20 of the 25 sites come from City of Toronto open data. Five are
  stand-ins (Morningside Yard has no listed address; four street depots are placed by hand), flagged
  `assumed` in [`facilities.json`](backend/app/planning/facilities.json).
- **Routing uses the public OSRM server**, which is rate-limited; plans fall back to straight-line times
  when it is unavailable, and the console says so.

---

## Team

Harrish Ayyanar · Afthab Shiraz
