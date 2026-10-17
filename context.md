# Real-Time Video Agents Hack: London (VAST Builders Challenge)

Context compiled 2026-10-16 from the event page, Luma, the official Build Day guide repo, the sponsor docs, and the VAST community forum. Sources are listed at the bottom.

---

## 1. Event at a glance

| | |
|---|---|
| **Name** | Real-Time Video Agents Hack: LDN (part of the **VAST Builders Challenge**, a three-city series: SF Oct 2, NYC Oct 9, **London Oct 17**) |
| **Date** | **Saturday 17 October 2026** |
| **Location** | London. The exact venue appears on Luma only after your registration is approved. |
| **Presented by** | tokens& (tokensand.com) |
| **In collaboration with** | VAST Data, NVIDIA, SpaceXAI (Cursor), CoreWeave, Weights & Biases |
| **Hosts** | tokens&, Alessandro Amenta, Francisco Terpolilli, Jacopo Piazza, Syerra Laurusaitis, Ram Bansal |
| **Speaker** | Brian Verkley, Director, AI Data Platform, VAST Data |
| **Team size** | 2 to 4 people, one project per team. Solo attendees can find a team on Discord or on the day. |
| **Event page** | https://tokensand.com/vastlondon |
| **Submit** | https://tokensand.com/vastlondon/submit |
| **Gallery** | https://tokensand.com/vastlondon/projects |
| **Discord** | https://discord.gg/rPBMhMzRU |
| **Luma** | https://luma.com/vastlondon |

### Schedule (BST)
| Time | |
|---|---|
| 08:30 | Doors open, breakfast |
| 09:00 | Opening keynotes |
| 09:30 | **Build begins** |
| 12:30 | Lunch |
| **16:30** | **Submission deadline**, then demos (the build window is about 7 hours) |
| 18:30 | Closing and awards |

### Prizes
- **1st place:** NVIDIA DGX Spark
- **2nd place:** Hugging Face Microduck
- Also Cursor credits and cash gift cards. Credits and gift cards are split among team members.

### Judges
- Abubakr Karali, Senior Solutions Architect, NVIDIA
- Ram B. (Bansal), Senior Developer Advocate, VAST Data. He answers forum questions and was a host at earlier events.
- Brian Verkley, Director, AI Data Platform, VAST Data
- Junaid Butt, AI Solutions Engineer, Weights & Biases

### Judging criteria (from the event slides, `Builders_Challenge_Slides.pdf`)
1. **Idea**: a compelling use of the provided video search and summary stack.
2. **Design**: a well thought out, intuitive project design and user experience.
3. **Technical implementation**: high-quality software that is easy to follow, reproduce and evaluate, with clear documentation of inputs, outputs and evaluation steps.
4. **Impact**: effective use of at least 3 sponsor tools.
5. **Presentation**: a 2-minute live demo (demos over slides). The top 5 give a 3-minute demo to everyone at 6 pm.

There is a first round of judging with each team, covering what you built and how the day went, followed by demos to the panel. The guide says a winning story follows this pattern: *problem → video archive (one of the packs) → search/filters across cameras → insight or action*.

---

## 2. Before you arrive: checklist
- [ ] Join the **Cosmos Community** (VAST's Discourse forum). It is the gateway to the build infrastructure: https://community.vastdata.com?utm_campaign=event26-builders-challenge
- [ ] Create a **Cursor** account with the **same personal email you registered with**. Credits are attached to that email; without an account you get no credits. Check credits at https://cursor.com/dashboard/usage (requests should show as `Free`). Request credits or a top-up at https://forms.gle/AVta9RRTmfdeUNX26
- [ ] Create a **Weights & Biases** account (https://wandb.ai). Serverless inference access is provided at the start, and W&B tops up credits by account email.
- [ ] Use a **personal laptop if possible**, because work VPN or IT restrictions can block SSH. Bring a charger.
- [ ] Have an SSH key ready for Cursor Remote-SSH (see §4).
- [ ] Come with a **specific** use case, but stay flexible about it. "Flag someone missing a hard hat" is buildable; "watch for safety issues" is too vague.
- [ ] Note that the event is photographed and filmed.

---

## 3. What you're building

**A video agent:** an app that understands video and does something useful with it. It can search hours of footage in plain language, answer what happened, spot events, or trigger an action. Build one idea, get it working, and ship it by the end of the day.

- **Already built and running for you:** ingest → understand → index → search/ask. This runs on VAST S3, DataEngine, and DataBase, with models on CoreWeave GPUs.
- **What you build:** the app or agent layer, in Cursor, using the provided skills and the VSS REST API. W&B Serverless Inference handles your own LLM reasoning.
- **Deliverable:** a web app, CLI, or script. Native desktop or mobile apps can't be demoed from the VM. Deploy it on the team's K8s namespace at `/app` (§7).

### Rules
- **Do not ingest internet videos** such as YouTube. The provided corpus was chosen for licensing reasons.
- Projects must be built during the event.
- Use only your team's credentials, buckets, and namespace.
- Don't rebuild or redeploy the DataEngine pipeline or the VSS stack. It's already running.
- **Bulk re-ingest is limited to 1 or 2 designated people per team.** Others may re-ingest a few videos to experiment.
- Never print, log, or commit secrets. Credentials are environment variables on the VM.

### Submission requirements (due 16:30 BST)
- An accessible **GitHub repo**
- A short **demo video**, as a shareable link
- A **description** of what you built and the tools you used
- Team member **names and contact emails**
- Optional: a live website URL and a screenshot

---

## 4. Access and environment (build day)

1. Join Cosmos, then go to the Workshop category: https://community.vastdata.com/t/about-the-workshop-category-and-access/1969
2. The lab portal is **https://workshop.thecosmoslabs.com** (behind Cloudflare Access login). It has your lab page, the **Video Search & Summary** UI, and an **App** button for your deployed app.
3. Read the Infra Onboarding PDF: `docs/BUILDERS-CHALLENGE-INFRA-ONBOARDING.pdf` in the guide repo.
4. **Cursor runs on your laptop and connects to the workshop VM over Remote-SSH.** The repo, skills, and credentials live on the VM.
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_cursor -C "cursor-vm"
   pbcopy < ~/.ssh/id_ed25519_cursor.pub   # paste under "Option 1 - Key" in the Cursor SSH setup
   ```
   In Cursor: **Connect via SSH** → choose host `bc-<username>` (shown on your lab page) → open the `vast-builders-challenge` folder.
5. **Select your team number** (e.g. `team-1`). You can do this **only once**, so agree as a team first. The team shares one ingestion pipeline, one index, and one set of credentials, so anything a teammate ingests appears in everyone's searches.
6. Set the Cursor agent model to **Auto** to save tokens.
7. A passcode (if asked) is shown on a slide during the event.
8. To get going: `/build-day-quickstart` gives a guided walkthrough. If something breaks, type "run a git pull", then "check that everything is working". For help, `/ask-cosmos` drafts a support note; post it yourself in the Cosmos Workshop category as a new topic, not as a reply.

### Environment variables on the VM (from `/config/<team>.config`; see `config.example`)
```
USERNAME=team-x            PASSWORD=...
S3_ENDPOINT  ACCESS_KEY  SECRET_KEY
S3_CHUNKS_BUCKET=team-x-vss-chunks
S3_SEGMENTS_BUCKET=team-x-vss-chunks-segments
VDB_ENDPOINT               VASTDB_BUCKET=team-x-vss-db
VDB_SCHEMA=vss-schema      VDB_COLLECTION=vss-collection   VDB_PROMPTS_COLLECTION=vss-prompts-events
PIPELINE=team-x-vss        INGRESS_URL=<VSS backend API base URL>
WANDB_API_KEY  WANDB_TEAM  WANDB_PROJECT
COSMOS3_REASON_URL  YOLO_URL  COSMOS_EMBED1_URL  CANARY_1B_URL   (+ GPU_BEARER_TOKEN in some skills)
COSMOS3_REASON_MODEL=nvidia/cosmos3-reason   COSMOS_EMBED1_MODEL=nvidia/cosmos-embed1
```
Other files in `/config` include the kubeconfig `<team>-k8s.yaml`, `backend-secret.yaml`, and `vss-cli-secret.yaml`.
- List variable names only with `env | cut -d= -f1 | sort`. Never run bare `env` or `printenv`, which print secret values.
- On zsh, `USERNAME` is reserved. Parse the config with `grep '^KEY=' file | cut -d= -f2-` instead of `source`.
- Always read model endpoints from the environment variables. Some skills hardcode hosts and ports from earlier cities, and the docs disagree on ports and whether a GPU auth token is needed.

---

## 5. The stack

### Models (shared GPU endpoints on CoreWeave; you don't deploy them)
| Model | Role | Env var | API |
|---|---|---|---|
| **NVIDIA Cosmos3-Reason** (`nvidia/cosmos3-reason`) | VLM. Writes a searchable description (`reasoning_content`, ≤1024 chars) of each ~5 s segment | `$COSMOS3_REASON_URL` | OpenAI-style `/v1/chat/completions`, `/v1/models`, `/v1/health/ready` |
| **YOLO11** (`yolo11s`, Ultralytics) | Object detection: classes, peak per-class counts, bbox sidecars | `$YOLO_URL` | `POST /v1/infer` `{video_base64, filename, include_frames}`; health at `GET /healthz` (no `/v1/models`) |
| **NVIDIA Cosmos-Embed1** (`nvidia/cosmos-embed1`) | **256-dim** text and visual embeddings for hybrid search | `$COSMOS_EMBED1_URL` | `POST /v1/embeddings` `{input, model, request_type:"query", encoding_format:"float"}` |
| **NVIDIA Canary-1B** (`nvidia/canary-1b`) | ASR and speech translation. **Not wired into the pipeline**, so adding it is a differentiation opportunity (spoken-word search, transcripts) | `$CANARY_1B_URL` | `POST /v1/audio/transcriptions` (multipart `file`, `model`); health at `/v1/health/ready` and `/live` only |

### Ingest pipeline (VAST DataEngine serverless functions, from the VSS Blueprint)
```
S3 chunks bucket → Segmenter → S3 segments bucket → Detector (YOLO11) → Reasoner (Cosmos3-Reason)
   → Embedder (Cosmos-Embed1, text + visual) → VastDB writer (vss-collection)
Scheduled: prompt-suggester → vss-prompts-events (search chips + key events)
```
- The corpus is **pre-ingested** (the Segmenter already ran). Your live path is **re-ingest**: Detector → Reasoner → Embedder → Writer. Re-ingest atomically replaces each `(original_video, segment_number)` row and does not create duplicates.
- **The key insight: the ingestion prompt decides what gets indexed.** Anything Cosmos wasn't asked to describe is never written down, so it can't be found later. If a search comes back empty, the search isn't broken; the prompt didn't ask about that thing. Fix it by re-ingesting with a custom prompt.
- Scenario presets: `surveillance`, `traffic`, `live_driving`, `retail`, `warehouse`, `egocentric`, `sports`, `nhl`, `general`. Get the live list from `GET /api/v1/metadata/ingest-config`.
- A **custom prompt** has a max of **800 chars** and overrides the scenario.
- Re-ingest takes **a few minutes**. Start with a few clips, read the captions, then scale up.
- **Watch out:** at NYC, several teams had re-ingest jobs stuck at `pending_index>0` for over 40 minutes after pod restarts, and staff advised: "Use what videos you have with context for now." **Start any re-ingest you need early (in the morning) and don't let your demo depend on it.** A 404 from the job-status endpoint after a backend restart only means the progress record was lost; processing may still be running. Check the dashboard instead.

### VastDB
- Database = bucket `team-<N>-vss-db`, schema `vss-schema`, tables `vss-collection` (segments + vectors) and `vss-prompts-events`.
- Notable columns: `pk`, `source` (segment S3 URI), `original_video` (parent chunk S3 URI), `reasoning_content`, `perception_json`, `vectors` (256-d), `vectors_visual`, `tags`, `is_public`, `camera_id`, `capture_type`, `location`, timestamps, `object_classes`/counts.
- Python: `pip install vastdb pyarrow pyyaml`, then `vastdb.connect(endpoint=S3_ENDPOINT, access=ACCESS_KEY, secret=SECRET_KEY, ssl_verify=False)`. **Never `select()` all columns on `vss-collection`**, because the vector columns can crash the SDK. Don't name a file `select.py`.

### Video corpus (already indexed)
| Pack | Source | `camera_id` | location | Scenario | Content |
|---|---|---|---|---|---|
| **A: Highway Traffic** ⭐ | I-24 multi-cam | `i24_cam-1` | nashville | `traffic` | ~51 multi-camera highway clips (`scene*_p*c*`) |
| **B: Live Driving** | PIE dashcam drives | `pie_cam-3` | toronto | `live_driving` | 6 long drive sets (`set01`–`set06`) |
| **C: Warehouse Safety** ⭐ | SDG warehouse RGB (synthetic) | `sdg_warehouse_cam-2` | warehouse3 | `warehouse` | ~178 ceiling and aisle clips, including forklifts |
| **D: Neighborhood** | Private neighborhood cam | `neighborhood_cam-1` | neighborhood | `surveillance` | 2 day-long merges (2026-09-01, 2026-09-02) |
| **E: SF Streets** | SF fixed street cams | `sf_streets_cam-1`…`4` | san_francisco | `surveillance` | 4 cameras (marked "ingesting soon") |
| **F: Indoor Smart Spaces** | Facility cams | `smartspace_cam-1` | indoor | `surveillance` | ~102 indoor clips: occupancy, people flow |

⭐ The guide recommends starting with Pack A or Pack C because they give the clearest search results. London may have different or additional footage; one example filename in the skills is `london-luxury-walk_chunk_0000.mp4`. Check what's actually indexed on the day with "what's in the index?" or the Explore tab.

Filters available in search: `camera_id`, `capture_type`, `location`, detected object class, time, and tags.

The headline cross-camera demo query is *"person close to a moving vehicle"*, which returns hits from highway, driving, neighborhood, SF, and warehouse footage.

---

## 6. VSS backend REST API (base URL `$INGRESS_URL`)

Authenticate first:
```bash
TOKEN=$(curl -s -X POST "$INGRESS_URL/api/v1/auth/login" -H "Content-Type: application/json" \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
# Use header: Authorization: Bearer $TOKEN   (playback endpoints take ?token=$TOKEN instead)
```

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/auth/login`, `GET /api/v1/auth/me` | JWT auth |
| `POST /api/v1/search` | Hybrid search. Body: `query`, `top_k` (15, max 100), `llm_top_n` (3), `min_similarity` (use 0.3–0.5), `tags[]`, `time_filter` (`5m`/`15m`/`1h`/`24h`/`7d`/`all`/`custom` + `custom_start_date`/`custom_end_date`), `metadata_filters{location,camera_id,capture_type}`, `include_public`, `hybrid_text_weight` (0–1), `system_prompt`. Returns `results[]` (segments), `chunk_results[]` (grouped by video with `best_match_start_sec`/`end_sec`), `llm_synthesis`, `sql_query` |
| `POST /api/v1/agent/ask` | Grounded Q&A. `{question, original_video?, top_k}` → `{answer, tool_used, evidence}` |
| `POST /api/v1/agent/search-and-answer` | Same body as search; returns an answer plus chunk evidence |
| `POST /api/v1/tools/search`, `GET tools/segments?original_video=`, `GET tools/segment?source=`, `GET tools/detections?source=`, `GET tools/explore`, `POST tools/synthesize` | Building blocks for your own agent tools |
| `GET /api/v1/videos/explore?scope=all&limit=48&offset=0[&date=&location=]` | List fully indexed videos |
| `GET /api/v1/videos/stream?source=<s3uri>&token=` | Seekable video proxy, usable as `<video src>` |
| `GET /api/v1/videos/playback-url?source=&token=&expires_in=3600` | Presigned S3 URL |
| `GET /api/v1/videos/metadata?source=` | Segment row: reasoning, tags, timing |
| `GET /api/v1/videos/detections?source=` | YOLO bbox sidecar JSON (404 = no detections) |
| `POST /api/v1/videos/synthesize` | Whole-video summary or report. `{original_video, question, max_segments, system_prompt?}` |
| `POST /api/v1/videos/upload` | Multipart upload of a new file (`file`, `is_public`, `tags`, `scenario` / `custom_prompt`, `camera_id`, `capture_type`, `location`). **Don't upload internet videos.** |
| `GET /api/v1/dashboard/stats?scope=all\|mine\|public` | Counts, ingest quality, object classes, metadata distributions, `pipeline_alignment.pending_index` |
| `POST /api/v1/dashboard/reingest` | `{original_video, chunk_count:1}` or `{stream_id, chunk_count:N}`, plus optional `scenario` / `custom_prompt` / `camera_id` / `capture_type` / `location` → `job_id` |
| `GET /api/v1/dashboard/reingest/{job_id}` | Re-ingest progress |
| `GET /api/v1/metadata/schema`, `GET /api/v1/metadata/values?field=&prefix=` | Valid search filter fields and values |
| `GET /api/v1/metadata/ingest-config` (no auth) | Scenario presets, capture types, custom prompt max length |
| `GET /api/v1/suggestions` | Auto-generated query chips and key events |
| `GET /api/v1/config` | Backend config, including `max_upload_size_mb` |
| `DELETE /api/v1/videos` | Delete an upload |

### Cursor skills (`.cursor/skills/`, standard SKILL.md format usable by other agent frameworks)
- `retrieval/`: `login`, `search`, `agent-qa`, `videos`, `dashboard`, `list-metadata`, `suggest-prompts`
- `ingest/`: `reingest-videos`, `reingest-chunk`, `upload-video`
- `vast-database/`: `vastdb-read` (`list_catalog.py`, `query.py`), `vastdb-write` (`insert.py`)
- `gpu/`: `model-health`, `model-smoke-test`
- `deployment/`: `deploy-app-no-registry`, `deploy`, `build-yamls`, `health`
- Slash commands: `/build-day-quickstart`, `/ask-cosmos`, `/deploy-app-no-registry`
- Example requests: "re-ingest the warehouse video with a prompt about safety gear", "find people near the entrance after 6pm", "summarize what happens in the warehouse video", "is it done yet?"

---

## 7. Deploying your app (`/deploy-app-no-registry`)
- The VM has no Docker or registry access. The app runs on **K8s in your team namespace** using a public image (`python:3.12-slim` or `node:22-slim`), with code mounted from a **ConfigMap** (keep it under ~1 MiB, so no videos, models, or `node_modules`) and VSS credentials from a **Secret** (`VSS_URL`, `VSS_USERNAME`, `VSS_PASSWORD`).
- Ingress host: `video-lab-team-<N>.cosmos.vastdata.com`, **path `/app`**. The nginx rewrite strips `/app`, so serve your routes at `/` and expose `/health` for the readiness probe. Listen on `0.0.0.0:$PORT` (8080).
- `KUBECONFIG=/config/team-<N>-k8s.yaml`
- After a code change, re-create the ConfigMap and run `kubectl -n $NS rollout restart deploy/$APP_NAME`.
- **View it at https://workshop.thecosmoslabs.com → App button.** Don't use `$INGRESS_URL`, which is the internal API.
- Because the app has to reach the VSS backend from the cluster, the demo should be the deployed app. Also record a backup demo video early.

---

## 8. Weights & Biases / CoreWeave (your app's LLM reasoning)
Search and Q&A come from VSS. Anything your app decides on top of that (classifying hits, drafting reports, choosing actions, agent loops) uses **W&B Serverless Inference**, which is OpenAI-compatible.
```python
import os, openai
client = openai.OpenAI(
    base_url="https://api.inference.wandb.ai/v1",
    api_key=os.environ["WANDB_API_KEY"],
    project=f"{os.environ['WANDB_TEAM']}/{os.environ['WANDB_PROJECT']}",
)
r = client.chat.completions.create(model="meta-llama/Llama-3.1-8B-Instruct",
                                   messages=[{"role": "user", "content": "..."}])
```
Models in the catalog at time of writing (check the live list at https://docs.coreweave.com/products/inference/serverless/models):
- **Vision-capable:** `nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B`, `Qwen/Qwen3.6-35B-A3B`, `Qwen/Qwen3.8-27B`, `google/gemma-4-31B-it`, `google/gemma-4-26B-A4B-it` (also function calling), `moonshotai/Kimi-K2.6`, `MiniMaxAI/MiniMax-M3`, `zai-org/GLM-5.3-Flash`, `deepseek-ai/DeepSeek-V4.1-Flash`
- **Text:** `deepseek-ai/DeepSeek-V4-Pro-0813`, `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `meta-llama/Llama-3.3-70B-Instruct`, `meta-llama/Llama-3.1-8B-Instruct`, `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B`, `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B`, `ibm-granite/granite-4.2-8b` (tool calling), `zai-org/GLM-5.2`

Other W&B tools:
- **Weave:** tracing, evals, scorers, guardrails. `pip install weave`, then `weave.init("<team>/<project>")` and decorate functions with `@weave.op`. https://wandb.ai/site/weave/
- **ARIA:** W&B research agent. https://wandb.ai/site/agent/
- Using these sponsor tools visibly (e.g. Weave traces of your agent) likely helps with the "technical implementation" criterion. That's an inference, not a stated rule.

---

## 9. Inspiration: what earlier cities built
**NYC (41 projects):** AisleGuard (worker–forklift proximity), Vision Zero Agent, PharOS, CloseCall (near-miss early warning and evidence), StreetCast (cited 311 reports), Exhibit A and Witness (claim-checking against video with prosecution and judge agents), watcher (multi-camera vehicle and person tracking), CarWitness (bilingual incident reports, used Weave), Spatial Video Agent (distances in meters), Occlusive Logic (user-defined spatial rules over detections), Drive Recap (teen driver scorecard), StreetAudit (road-marking repainting).

**SF (45 projects):** Warehouse Safety Monitor and Warehouse Sentinel, Near-Miss Board, Perjury (fact-checks claims about traffic video), Evidence Atlas (geolocates dashcam footage from signs read by Cosmos plus OpenStreetMap), Grabbit, Harvest, and VASTCAM (edge-case and training-dataset mining), momentOS (driving risk score for insurers), CityPulse (narrated 30-second answer videos), Vastly Unspoken (Cosmos-labelled data used to distill a small CPU model), Praxis (find my car), stayin-alive-cpr (crosswalk blocking with voice warnings).

**Saturated themes:** warehouse forklift near-misses, traffic near-miss boards, and "witness" or claim-checking. A differentiated angle helps with creativity, for example:
- Canary-1B audio, which no pipeline uses yet
- Cross-camera re-identification
- Turning search hits into a concrete **action**: alerts, filed reports, tickets
- A data or dataset product
- An unusual custom ingestion prompt that unlocks a new kind of query

---

## 10. Suggested day plan
1. **09:30–10:15:** SSH in, select the team, run the health check, open the VSS UI, and try `"what's in the index?"` and the suggestion chips.
2. **10:15–11:00:** Pick the use case and pack. Search for what the idea needs. If the captions don't cover it, have **one person** start a small re-ingest with a custom prompt (≤800 chars) **right away**.
3. **11:00–15:30:** Build the thin app (search, agent-qa, videos/stream, detections, W&B LLM reasoning, Weave tracing). Deploy to `/app` early and redeploy often.
4. **15:30–16:15:** Polish, record the demo video, write the README and description, and push to GitHub.
5. **By 16:30:** Submit at https://tokensand.com/vastlondon/submit.

---

## 11. Key links
- Build Day guide repo: https://github.com/vast-data/vast-builders-challenge (README, BEFORE_YOU_BUILD.md, ARCHITECTURE_REFERENCE.md, config.example, `.cursor/skills/`)
- VSS Blueprint source (VAST): https://github.com/vast-data/vss-blueprint (also cloned on the VM at `/vss-blueprint`)
- VAST video search architecture blog: https://www.vastdata.com/blog/unlock-video-intelligence-build-real-time-video-search-and-ai-summary
- Video search overview video: https://drive.google.com/file/d/1qUrT0QaBGS6mXxHTEG2vnLM2pT1KY4RD/view
- VAST Builders Challenge blog: https://www.vastdata.com/blog/lets-build-introducing-the-vast-builders-challenge
- Cosmos Community Workshop category (help): https://community.vastdata.com/c/workshop/27
- Lab portal: https://workshop.thecosmoslabs.com
- NVIDIA VSS docs: https://docs.nvidia.com/vss/latest/
- NVIDIA Cosmos: https://www.nvidia.com/en-us/ai/cosmos/ (Cookbook: https://nvidia-cosmos.github.io/cosmos-cookbook/)
- YOLO11: https://docs.ultralytics.com/models/yolo11
- W&B / CoreWeave inference: https://docs.coreweave.com/inference (playground: https://forge.coreweave.com/inference)
- Weave: https://wandb.ai/site/weave/ (docs: https://docs.wandb.ai/weave)
- VAST AI OS: https://www.vastdata.com/platform/ai-os
- Cursor: https://cursor.com
- tokens&: https://tokensand.ai · X: https://x.com/tokensandai
