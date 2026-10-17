# README media

The root `README.md` shows the GIFs here; each has a full-quality `.mp4` beside it.

| File | What it shows | Sponsor services on screen |
|---|---|---|
| `pipeline.gif` | The six stages with live numbers, and W&B Weave trace counts (`pipeline.html`) | VAST, NVIDIA, CoreWeave, W&B, City of Toronto |
| `review.gif` | A drive playing with Cosmos boxes, map pins, the severity reason | Cosmos3-Reason on CoreWeave, VAST S3, PIE GPS |
| `search.gif` | Footage search for "pothole", Nemotron's answer, Ask with VSS evidence | VAST VSS, Nemotron on W&B Inference |
| `issues.gif` | A severity-5 issue: frame, grade, work order, similar issues | Cosmos3-Reason, Nemotron, Cosmos-Embed1 + VastDB vector search |
| `report.gif` | The situation report, priority list, data provenance | Nemotron 3 Ultra on W&B Inference |
| `dispatch.gif` | Routes, the crew recommendation, road alerts, shift playback | cuOpt, Nemotron, City of Toronto closures |

## Re-recording

```bash
pnpm dev                                   # the console on the live backend, from the repo root
python3 docs/media/record.py               # all scenes, or name some: review search ...
```

Needs `pip install playwright`, Google Chrome (Playwright's own Chromium can't play the H.264 footage),
`ffmpeg`, and optionally `gifsicle`. Each scene reads the screen before captioning it: Dispatch says cuOpt
only when the plan says cuOpt, mentions Nemotron triage only when the plan was triaged by Nemotron, and
Ask's caption counts the VSS captions the answer actually used. A scene fails if the page reloads mid-take.

The scenes never press Run or Plan, and the search and Ask questions are ones the VSS cache already holds.
The numbers in `pipeline.html` are a snapshot (17 Oct): update them from `GET /api/report`,
`GET /api/plan`, `GET /api/hazards` and the Weave project before re-recording it.
