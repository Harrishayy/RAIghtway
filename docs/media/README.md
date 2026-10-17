# README media

The root `README.md` shows `review.png`, `issues.png`, `report.png` and `dispatch.png` (1920×1080 screenshots). To
swap in recordings, capture these and point the README at the GIFs. Capture them from the console against the live backend
(`pnpm dev`), in the Survey look, at 1600×1000, and trim idle time. Keep each GIF under about 8 MB so
GitHub renders it inline; put full-quality `.mp4` versions next to them if you have them.

| File | Screen | What to show (10–20 s) |
|---|---|---|
| `review.gif` | Review | Open a drive, play it: boxes appear on findings, the timeline playhead moves, the car moves on the map, click a finding to jump to it |
| `issues.gif` | Issues | Sort by severity, open a high-severity issue: frame with box, work order, sightings, "Similar issues · VastDB vector search" |
| `report.gif` | Report | The summary, counts and recommended crews; press Regenerate |
| `dispatch.gif` | Dispatch | Adjust a crew count, press Plan routes ("cuOpt · … s"), play the shift back, open the Roads tab |
| `live.gif` | Review | Press Run: "Reading VAST index…", then the new drive at the top of Footage moving through its stages, provisional pins landing on the map, re-sightings merging. Each Run consumes up to 30 s of unseen footage, so rehearse with care: the first Run is the held-back demo street |

Optional: `walkthrough.mp4`, a narrated 2-minute cut for the submission.
