# Agent 2: VAST data layer

**Read first:** `agents/README.md` (the `app/vast/` contract), `architecture.md` §3.1, §3.5 (storage), §7 (the "Any step" row). Use the guide repo's vastdb-write and vastdb-read skills and the `vss-blueprint` retrieval backend as references.

## Mission
Make VAST the system of record: VastDB tables in our own schema `citymaint`, media in VAST S3, and Level 2 vector search through ADBC SQL, with a fallback for every piece.

## You own
`backend/app/vast/db.py`, `media.py`, `vector.py` (+ `backend/app/vast/__init__.py`)

## Tasks
1. **`db.py`, tables (insert-only)** in `VASTDB_BUCKET` / schema `citymaint` through the `vastdb` SDK on `S3_ENDPOINT`:
   - `videos`, `issues`, `gps`, `reports`, `plans`, `frames` with the columns in §3.1. JSON-ish fields (track, counts, crews, routes, work order) are stored as JSON strings.
   - `issues.embedding` is `pa.list_(pa.field("item", pa.float32(), nullable=False), 256)`; `issues.embedding_bin` holds the same vector as bytes (`np.float32.tobytes()`).
   - `ensure_tables()` is idempotent. `insert_*` takes contract models. `insert_gps(rows)` handles ~30k rows in batches.
   - `load_all()` reads **explicit non-vector columns only**, loads whole tables and filters in memory. Never read vector columns through the SDK (§3.1 SDK rules).
   - `load_embeddings()` reads `id` + `embedding_bin` → `dict[id, np.ndarray]`.
2. **`media.py`, S3** (boto3 against `S3_ENDPOINT`):
   - `put_frame` → `S3_SEGMENTS_BUCKET` at `citymaint/frames/{issue_id}.jpg`; returns the key.
   - `put_original` → `citymaint/uploads/{video_id}.video`, `ContentType: video/mp4`. **No `.mp4` suffix** (§3.1).
   - **Never** write to `S3_CHUNKS_BUCKET`.
   - Fallback mode (set by a config flag or chosen automatically after gate check 5): `put_frame` writes to the `frames` table and returns `db:{issue_id}`; `put_original` becomes a no-op (the original stays on disk).
   - `get_frame` reads from whichever store the key points at.
3. **`vector.py`, Level 2 search:**
   - ADBC: driver `/vss-blueprint/source-code/retrieval/video-backend/libadbc_driver_vastdb.so`, `pip install adbc-driver-manager==1.0.0`, endpoint `vdb_endpoint` from `/config/backend-secret.yaml`.
   - Build the SQL in §3.1: `array_cosine_distance(embedding::FLOAT[256], ARRAY[...]::FLOAT[256])`, optional `category`, `source`, `duplicate_of = ''` and lat/lon `BETWEEN` filters, `id <> exclude_id`, `ORDER BY d LIMIT k`. Use `OR`, not `IN (...)`.
   - **Fallback:** numpy cosine over an in-memory matrix from `load_embeddings()`, with the same filters applied using the store's issue metadata. Use it automatically when ADBC fails to connect or errors. Keep the in-memory matrix updated as issues are inserted (expose `vector.add(id, embedding, meta)`).
   - Log which path answered each query (useful for the W&B/VAST story).

## Gate checks (09:30–10:30), report results
- **Gate 4:** create `citymaint.issues` with the vector column, insert one row, read it back through ADBC with a cosine query. Check that fresh inserts are visible and note the lag.
- **Gate 5:** write one test object of each kind (`frames/…jpg`, `uploads/…video`) into the segments bucket, then confirm that VSS Explore and `dashboard/stats` don't change. If they do, switch to the fallback and tell agents 1 and 5.

## Done when
- A row round-trips: SDK insert → `load_all()` → ADBC `nearest()` → numpy `nearest()` returns the same top hit.
- `put_frame`/`get_frame` work in both the S3 and fallback modes.

## Out of scope
The in-memory store (agent 1), dedupe rules (agent 5), and reading `vss-collection` for the segment inventory (agent 4, read-only).
