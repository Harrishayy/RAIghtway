"""Synchronous, insert-only VastDB persistence; callers use asyncio.to_thread."""
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import logging

import numpy as np
from pydantic import ValidationError
import urllib3

from app import config
from app.models import IssueRecord, Plan, Report, VideoRecord


urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


class _ElysiumWarningFilter(logging.Filter):
    def filter(self, record):
        return "without elysium enabled" not in record.getMessage()


logging.getLogger("vastdb.errors").addFilter(_ElysiumWarningFilter())
log = logging.getLogger(__name__)
_COLUMNS = {
    "videos": "id filename source drive start_s duration_s explanation track created_at".split(),
    "issues": ("id video_id source t category severity confidence description frame_key "
               "bbox_x bbox_y bbox_w bbox_h lat lon duplicate_of work_order created_at").split(),
    "gps": "drive t lat lon heading speed".split(),
    "reports": "generated_at summary counts crews rationale".split(),
    "plans": "generated_at crews routes unassigned solver solve_ms".split(),
    "frames": ["issue_id", "jpeg"],
    # Severity ratings: insert-only overlay on issues; the newest row per issue_id wins (store.apply_rating_row).
    "ratings": "issue_id severity find_severity reason model verdict observed rated_at".split(),
}


def _arrow():
    try:
        import pyarrow as pa
    except ImportError:
        raise RuntimeError("VastDB requires pyarrow on the workshop VM") from None
    return pa


def _schemas():
    pa = _arrow()
    s, f, i, ts = pa.string(), pa.float64(), pa.int64(), pa.timestamp("us")
    types = {
        "videos": [s, s, s, s, f, f, s, s, ts],
        "issues": [s, s, s, f, s, i, f, s, s, f, f, f, f, f, f, s, s, ts],
        "gps": [s, f, f, f, f, f],
        "reports": [ts, s, s, s, s],
        "plans": [ts, s, s, s, s, i],
        "frames": [s, pa.binary()],
        "ratings": [s, i, i, s, s, s, s, ts],
    }
    schemas = {name: pa.schema(list(zip(_COLUMNS[name], fields)))
               for name, fields in types.items()}
    schemas["issues"] = schemas["issues"].append(pa.field(
        "embedding", pa.list_(pa.field("item", pa.float32(), nullable=False), 256)
    )).append(pa.field("embedding_bin", pa.binary())).append(pa.field("has_embedding", i))
    return schemas


@contextmanager
def _transaction():
    if not config.VASTDB_SCHEMA or config.VASTDB_SCHEMA.lower() == "vss-schema":
        raise RuntimeError("VastDB requires a private CityMaint schema")
    if not all((config.S3_ENDPOINT, config.ACCESS_KEY, config.SECRET_KEY, config.VASTDB_BUCKET)):
        raise RuntimeError("VastDB endpoint, credentials and bucket must be configured")
    try:
        import vastdb
    except ImportError:
        raise RuntimeError("VastDB SDK is unavailable; install VM requirements") from None
    try:
        # Verify on the day: connect, transaction and bucket/schema lookup in SDK 1.x.
        session = vastdb.connect(endpoint=config.S3_ENDPOINT, access=config.ACCESS_KEY,
                                 secret=config.SECRET_KEY, ssl_verify=False)
        with session.transaction() as tx:
            yield tx
    except Exception as exc:
        # SDK errors can contain signed URLs; keep credentials out of caller logs.
        raise RuntimeError(f"VastDB operation failed ({config.redact(exc)})") from None


def _schema(tx):
    return tx.bucket(config.VASTDB_BUCKET).schema(config.VASTDB_SCHEMA)


def ensure_tables() -> None:
    schemas = _schemas()
    with _transaction() as tx:
        bucket = tx.bucket(config.VASTDB_BUCKET)
        # Verify on the day: fail_if_missing=False, create_schema and create_table.
        schema = bucket.schema(config.VASTDB_SCHEMA, fail_if_missing=False)
        if schema is None:
            schema = bucket.create_schema(config.VASTDB_SCHEMA)
        for name, fields in schemas.items():
            if schema.table(name, fail_if_missing=False) is None:
                schema.create_table(name, fields)


def _insert_rows(name, rows, *, schema_name=None, batch_size=2000):
    if not rows:
        return
    pa = _arrow()
    fields = _schemas()[schema_name or name]
    for start in range(0, len(rows), batch_size):
        batch = pa.Table.from_pylist(rows[start:start + batch_size], schema=fields)
        with _transaction() as tx:
            # Verify on the day: table.insert(pa.Table).
            _schema(tx).table(name).insert(batch)


def _read_rows(name, columns):
    if "embedding" in columns:
        raise ValueError("SDK reads of vector columns are forbidden")
    with _transaction() as tx:
        # Verify on the day: select(columns=[...]).read_all(); no vector predicates.
        return _schema(tx).table(name).select(columns=columns).read_all().to_pylist()


def _utc(value):
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _stored_time(value):
    return _utc(value).replace(tzinfo=None)


def _json(value):
    return json.dumps(value, separators=(",", ":"), allow_nan=False)


def _decode(value, default):
    return default if value is None or value == "" else json.loads(value)


def insert_videos(videos: list[VideoRecord]) -> None:
    rows = []
    for video in videos:
        if video.status != "done":
            continue
        row = video.model_dump(include=set(_COLUMNS["videos"]))
        row.update(track=_json(video.track), created_at=_stored_time(video.created_at))
        rows.append(row)
    _insert_rows("videos", rows)


def _issue_row(issue):
    row = issue.model_dump(include=set(_COLUMNS["issues"]))
    row.update(created_at=_stored_time(issue.created_at), duplicate_of=issue.duplicate_of or "",
               work_order=_json(issue.work_order.model_dump()) if issue.work_order else None)
    for key in "xywh":
        row[f"bbox_{key}"] = getattr(issue.bbox, key) if issue.bbox else None
    if issue.embedding is None:
        vector = np.zeros(256, dtype=np.float32)
        blob = b""
    else:
        vector = np.asarray(issue.embedding, dtype=np.float32)
        if vector.shape != (256,) or not np.isfinite(vector).all():
            raise ValueError("Issue embedding must contain 256 finite floats")
        blob = vector.tobytes()
    row.update(embedding=vector.tolist(), embedding_bin=blob,
               has_embedding=int(issue.embedding is not None))
    return row


def insert_issues(issues: list[IssueRecord]) -> None:
    _insert_rows("issues", [_issue_row(issue) for issue in issues])


def insert_report(report: Report) -> None:
    # The detail sections (stats, sections, hotspots…) stay in the store and snapshot; the row keeps the core.
    row = report.model_dump(include=set(_COLUMNS["reports"]))
    row.update(generated_at=_stored_time(report.generated_at),
               counts=_json(report.counts), crews=_json(report.crews))
    _insert_rows("reports", [row])


def insert_plan(plan: Plan) -> None:
    row = plan.model_dump()
    # Street geometry and crew run sheets exceed VastDB's cell size (TabularValueTooLarge); the full plan
    # stays in the store and snapshot, so the stored row keeps stops and ETAs only.
    routes = [route.model_dump(mode="json") | {"path": [], "brief": None, "maps_urls": []} for route in plan.routes]
    row.update(generated_at=_stored_time(datetime.now(timezone.utc)),
               crews=_json(dict(Counter(route.crew for route in plan.routes))),
               routes=_json(routes), unassigned=_json(plan.unassigned))
    _insert_rows("plans", [row])


def insert_ratings(rows: list[dict]) -> None:
    out = []
    for row in rows:
        out.append({"issue_id": str(row["issue_id"]), "severity": int(row.get("severity") or 0),
                    "find_severity": int(row.get("find_severity") or 0), "reason": row.get("reason") or "",
                    "model": row.get("model") or "", "verdict": row.get("verdict") or "",
                    "observed": row.get("observed") or "", "rated_at": _stored_time(row["rated_at"])})
    _insert_rows("ratings", out)


def load_ratings() -> list[dict]:
    rows = _read_rows("ratings", _COLUMNS["ratings"])
    for row in rows:
        row["rated_at"] = _utc(row["rated_at"]).isoformat()
    return rows


def insert_gps(rows: list[dict]) -> None:
    _insert_rows("gps", rows, batch_size=2000)


def load_all() -> dict[str, list]:
    result = {}
    for name in ("videos", "issues", "reports", "plans"):
        rows = _read_rows(name, _COLUMNS[name])
        time_column = "created_at" if name in ("videos", "issues") else "generated_at"
        records = []
        skipped, first_error = 0, None
        for row in rows:
            try:
                row[time_column] = _utc(row[time_column])
                if name == "videos":
                    row.update(track=_decode(row["track"], []), status="done", progress=1.0,
                               issue_ids=[])
                    record = VideoRecord(**row)
                elif name == "issues":
                    box = {key: row.pop(f"bbox_{key}") for key in "xywh"}
                    row.update(bbox=box if all(v is not None for v in box.values()) else None,
                               duplicate_of=row["duplicate_of"] or None, embedding=None,
                               frame_url=f"/api/frames/{row['id']}", sightings=1,
                               work_order=_decode(row["work_order"], None))
                    record = IssueRecord(**row)
                elif name == "reports":
                    row.update(counts=_decode(row["counts"], {}), crews=_decode(row["crews"], {}))
                    record = Report(**row)
                else:
                    record = Plan(routes=_decode(row["routes"], []),
                                  unassigned=_decode(row["unassigned"], []),
                                  solver=row["solver"], solve_ms=row["solve_ms"])
                records.append((row[time_column], record))
            except Exception as exc:
                skipped += 1
                if first_error is None:
                    if isinstance(exc, ValidationError):
                        # Validation errors must not include stored input payloads.
                        exc = ValidationError.from_exception_data(
                            exc.title, exc.errors(include_input=False), hide_input=True)
                    first_error = config.redact(exc)
        if skipped:
            log.warning("VastDB load_all table=%s skipped=%d first_error=%s",
                        name, skipped, first_error)
        result[name] = [record for _, record in sorted(records, key=lambda item: item[0])]
    return result


def load_embeddings() -> dict[str, np.ndarray]:
    result = {}
    skipped, first_error = 0, None
    for row in _read_rows("issues", ["id", "embedding_bin"]):
        try:
            blob = row["embedding_bin"]
            if not blob:
                continue
            if len(blob) != 256 * np.dtype(np.float32).itemsize:
                raise ValueError("Stored issue embedding has an invalid byte length")
            vector = np.frombuffer(blob, dtype=np.float32).copy()
            if not np.isfinite(vector).all():
                raise ValueError("Stored issue embedding contains non-finite values")
            result[row["id"]] = vector
        except Exception as exc:
            skipped += 1
            if first_error is None:
                first_error = config.redact(exc)
    if skipped:
        log.warning("VastDB load_embeddings table=issues skipped=%d first_error=%s",
                    skipped, first_error)
    return result


def _put_frame(issue_id: str, jpeg: bytes) -> None:
    _insert_rows("frames", [{"issue_id": issue_id, "jpeg": jpeg}])


def _get_frame(issue_id: str) -> bytes:
    with _transaction() as tx:
        table = _schema(tx).table("frames")
        # Verify on the day: ibis predicate support and legacy SDK fallback.
        try:
            from ibis import _
            reader = table.select(columns=["issue_id", "jpeg"], predicate=(_.issue_id == issue_id))
        except (ImportError, TypeError, AttributeError):
            reader = table.select(columns=["issue_id", "jpeg"],
                                  predicate=table["issue_id"] == issue_id)
        rows = reader.read_all().to_pylist()
    if not rows:
        raise FileNotFoundError("Frame not found in VastDB")
    return bytes(rows[-1]["jpeg"])
