"""ADBC cosine search with an independently maintained numpy fallback."""
import base64
import logging
import math
from pathlib import Path
import threading
import time

import numpy as np

from app import config


log = logging.getLogger(__name__)
_index: dict[str, tuple[np.ndarray, dict]] = {}
_index_lock = threading.Lock()
_adbc_lock = threading.Lock()
_connection = None
_retry_at = 0.0


def _vector(embedding):
    vector = np.asarray(embedding, dtype=np.float32)
    if vector.shape != (256,) or not np.isfinite(vector).all():
        raise ValueError("Embedding must contain 256 finite floats")
    return vector


def add(issue_id: str, embedding: list[float] | np.ndarray, meta: dict) -> None:
    vector = _vector(embedding).copy()
    with _index_lock:
        _index[issue_id] = (vector, dict(meta))


def _endpoint():
    try:
        import yaml
        data = yaml.safe_load(Path(config.BACKEND_SECRET_FILE).read_text())
        if isinstance(data, dict):
            root = {str(key).lower(): value for key, value in data.items()}
            for name, encoded in (("stringdata", False), ("data", True), (None, False)):
                section = root if name is None else root.get(name, {})
                if not isinstance(section, dict):
                    continue
                for key, value in section.items():
                    if str(key).lower() == "vdb_endpoint" and value:
                        if encoded:
                            value = base64.b64decode(str(value), validate=True).decode()
                        return str(value).strip()
    except (ImportError, OSError, ValueError, TypeError):
        pass
    except Exception:
        log.warning("ADBC endpoint file could not be parsed; using configured fallback")
    if not config.VDB_ENDPOINT:
        raise RuntimeError("ADBC query endpoint is not configured")
    return config.VDB_ENDPOINT


def _literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def _identifier(value):
    return '"' + str(value).replace('"', '""') + '"'


def _bounds(bbox):
    if bbox is None:
        return None
    values = tuple(float(value) for value in bbox)
    if len(values) != 4 or not all(math.isfinite(value) for value in values):
        raise ValueError("bbox must contain four finite coordinates")
    if values[0] > values[1] or values[2] > values[3]:
        raise ValueError("bbox minimum must not exceed maximum")
    return values


def _build_sql(embedding, *, category=None, bbox=None, source="corpus",
               canonical_only=True, exclude_id=None, k=5, table="issues"):
    vector = _vector(embedding)
    bbox = _bounds(bbox)
    if not config.VASTDB_BUCKET or not config.VASTDB_SCHEMA:
        raise RuntimeError("VastDB bucket and schema must be configured for ADBC")
    filters = ["has_embedding = 1"]
    if category is not None:
        filters.append(f"category = {_literal(category)}")
    if source is not None:
        filters.append(f"source = {_literal(source)}")
    if canonical_only:
        filters.append("duplicate_of = ''")
    if bbox is not None:
        a, b, c, d = bbox
        filters += [f"lat BETWEEN {a} AND {b}", f"lon BETWEEN {c} AND {d}"]
    if exclude_id is not None:
        filters.append(f"id <> {_literal(exclude_id)}")
    values = ",".join(repr(float(value)) for value in vector)
    sql = ("SELECT id, lat, lon, "
           f"array_cosine_distance(embedding::FLOAT[256], ARRAY[{values}]::FLOAT[256]) AS d "
           f"FROM {_identifier(config.VASTDB_BUCKET + '/' + config.VASTDB_SCHEMA)}."
           f"{_identifier(table)}")
    if filters:
        sql += " WHERE " + " AND ".join(filters)
    return sql + f" ORDER BY d LIMIT {max(0, int(k))}"


def _adbc_query(sql):
    global _connection, _retry_at
    # A second request should use numpy while the shared connection is occupied.
    if not _adbc_lock.acquire(blocking=False):
        raise RuntimeError("ADBC connection is busy")
    try:
        if time.monotonic() < _retry_at:
            raise RuntimeError("ADBC retry cooldown is active")
        try:
            if _connection is None:
                if not Path(config.ADBC_DRIVER_PATH).is_file():
                    raise RuntimeError("ADBC driver is unavailable")
                if not all((config.ACCESS_KEY, config.SECRET_KEY)):
                    raise RuntimeError("ADBC credentials are not configured")
                try:
                    from adbc_driver_manager import dbapi
                except ImportError:
                    raise RuntimeError("ADBC driver manager is unavailable") from None
                # Verify on the day: Linux driver, QE reachability and fresh-row visibility.
                _connection = dbapi.connect(driver=config.ADBC_DRIVER_PATH, db_kwargs={
                    "vast.db.endpoint": _endpoint(), "vast.db.access_key": config.ACCESS_KEY,
                    "vast.db.secret_key": config.SECRET_KEY,
                })
            with _connection.cursor() as cursor:
                cursor.execute(sql)
                rows = cursor.fetchall()
            return [(str(row[0]), float(row[-1])) for row in rows
                    if row[-1] is not None and math.isfinite(float(row[-1]))]
        except Exception as exc:
            _retry_at = time.monotonic() + 60.0
            connection, _connection = _connection, None
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    pass
            reason = config.redact(exc)
            log.warning("ADBC search unavailable; using numpy for 60 seconds (%s)", reason)
            raise RuntimeError(f"ADBC search unavailable ({reason})") from None
    finally:
        _adbc_lock.release()


def _numpy_nearest(embedding, *, category=None, bbox=None, source="corpus",
                   canonical_only=True, exclude_id=None, k=5):
    query = _vector(embedding).astype(np.float64)
    norm = np.linalg.norm(query)
    if norm == 0 or k <= 0:
        return []
    bbox = _bounds(bbox)
    with _index_lock:
        items = list(_index.items())
    ids, vectors = [], []
    for issue_id, (vector, meta) in items:
        if issue_id == exclude_id:
            continue
        if category is not None and meta.get("category") != category:
            continue
        if source is not None and meta.get("source") != source:
            continue
        if canonical_only and meta.get("duplicate_of") not in (None, ""):
            continue
        if bbox is not None:
            lat, lon = meta.get("lat"), meta.get("lon")
            if lat is None or lon is None:
                continue
            if not (bbox[0] <= lat <= bbox[1] and bbox[2] <= lon <= bbox[3]):
                continue
        ids.append(issue_id)
        vectors.append(vector)
    if not vectors:
        return []
    matrix = np.asarray(vectors, dtype=np.float64)
    norms = np.linalg.norm(matrix, axis=1)
    valid = norms > 0
    distances = np.full(len(ids), np.inf)
    distances[valid] = 1 - np.clip((matrix[valid] @ query) / (norms[valid] * norm), -1, 1)
    order = np.argsort(distances, kind="stable")[:k]
    return [(ids[index], float(distances[index])) for index in order
            if np.isfinite(distances[index])]


def nearest(embedding: list[float], *, category: str | None = None,
            bbox: tuple[float, float, float, float] | None = None,
            source: str | None = "corpus", canonical_only: bool = True,
            exclude_id: str | None = None, k: int = 5) -> list[tuple[str, float]]:
    try:
        query = _vector(embedding)
        k = int(k)
        if k <= 0 or not np.any(query):
            log.info("vector.nearest path=empty hits=0")
            return []
        options = dict(category=category, bbox=_bounds(bbox), source=source,
                       canonical_only=canonical_only, exclude_id=exclude_id, k=k)
        try:
            result = _adbc_query(_build_sql(query, **options))
            log.info("vector.nearest path=adbc hits=%d", len(result))
            return result
        except Exception:
            result = _numpy_nearest(query, **options)
            log.info("vector.nearest path=numpy hits=%d", len(result))
            return result
    except Exception:
        log.warning("vector.nearest path=empty search unavailable or input invalid")
        return []
