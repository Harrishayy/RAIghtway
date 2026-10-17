# Agent 3: Model clients (Cosmos, Embed, Nemotron, Weave)

**Read first:** `agents/README.md` (the `app/ai/` contract), `architecture.md` §3.2, §3.3 (Find prompt, box, embed, severity rubric), §7 (box and Nemotron fallbacks).

## Mission
Thin, reliable async clients for every model call, with prompts that return clean JSON, a shared GPU semaphore, and Weave tracing. Agents 5, 6 and 7 call only these functions.

## You own
`backend/app/ai/gpu.py`, `cosmos.py`, `embed.py`, `nemotron.py`, `prompts.py`, `weave_setup.py`

## Tasks
1. **`gpu.py`:** one global `asyncio.Semaphore(GPU_CONCURRENCY, default 6)` exposed as `slot()`; `pause()`/`resume()` set an event that pre-compute awaits between pieces. Shared `httpx.AsyncClient`, URLs from env, `Authorization: Bearer $GPU_BEARER_TOKEN` only if it's set.
2. **`prompts.py`:** the 6 categories, `CREW_FOR`, and the severity rubric table from §3.3 as text. The Find prompt: only clearly visible issues, ignore vehicles and people, return `{"issues":[{category, severity, description (≤20 words), t, confidence}], "scene"}`.
3. **`cosmos.py`:**
   - `find_issues(piece_path)`: `POST $COSMOS3_REASON_URL/v1/chat/completions` with content `[{type:"text"}, {type:"video_url", video_url:{url:"data:video/mp4;base64,…"}}]`, temperature ≤0.2, max_tokens ~1000. Strip `<think>…</think>`, extract the first JSON object, validate into `FindResult`, drop unknown categories, clamp severity to 1–5. One retry on bad JSON, then return an empty result.
   - `box(frame_path, category, description)`: send the image as `image_url`, ask for one `[x1,y1,x2,y2]`, normalise to `BBox` (x, y, w, h in 0–1). Detect the coordinate space (pixels vs 0–1000) once from gate check 3 and make it a constant. Fallback: `nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B` on W&B, else `None`.
4. **`embed.py`:** `embed_clip(mp4_path)`: `POST $COSMOS_EMBED1_URL/v1/embeddings` with `{input:"data:video/mp4;base64,…", model:"nvidia/cosmos-embed1", request_type:"query", encoding_format:"float"}`. Return the 256 floats; assert the length.
5. **`nemotron.py`:** OpenAI-compatible client at `https://api.inference.wandb.ai/v1`, `project=f"{WANDB_TEAM}/{WANDB_PROJECT}"`.
   - `chat_json(messages, schema, model)` asks for JSON only, validates with Pydantic, and retries once with the validation error appended.
   - Models: `LIGHTNING = "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B"`, `ULTRA = "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B"` (the report uses it only if it answers in <~10 s), `SUPER_VL`.
   - `work_orders_and_explanation(video, new_canonical, all_issues)`: one call per video. The crew is fixed from `CREW_FOR` and the urgency from the rubric (1–2 routine, 3–4 soon, 5 urgent); Nemotron fills in `repair`, `minutes` and `equipment` per issue, plus a 2–4 sentence explanation of the video. On failure, fall back to a template (default minutes per category) so the pipeline never blocks.
6. **`weave_setup.py`:** `weave.init(f"{WANDB_TEAM}/{WANDB_PROJECT}")`. Put `@weave.op` on wrapper functions that take **paths or IDs**, never base64 payloads (Weave logs inputs).

## Gate checks (09:30–10:30), report numbers
- **Gate 3:** Cosmos3-Reason on 5 real segments per category: JSON validity rate, latency, whether image input works, and the box coordinate space (use a frame with an obvious object). Cosmos-Embed1 on a 1 s still crop clip. Note categories that perform badly (§8: final category list).
- **Gate 6:** Nemotron through W&B returns valid JSON and the call shows up in Weave. Time Ultra vs Lightning on a report-sized prompt.

## Done when
- Each function works on a real segment or frame on the VM, with sample output pasted in your report.
- Traces are visible in Weave with per-call latency.

## Out of scope
Segmenting, cropping and still-clip creation (agent 5), dedupe, and the report prompt itself (agent 7 builds it on `chat_json`).
