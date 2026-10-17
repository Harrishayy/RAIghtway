"""Read-only VSS API client: JWT login, cached search, stream URLs.

The team shares one VSS backend, so calls are deliberately polite: one at a
time (module lock), at least MIN_INTERVAL_S apart, and search results are cached
in memory and on disk so a restart never repeats a query. Everything is sync;
call it from async code with asyncio.to_thread.
"""
import base64
import json
import logging
import re
from pathlib import Path
from threading import RLock
import time
from urllib.parse import urlencode

import httpx

from app import config

log = logging.getLogger(__name__)
MIN_INTERVAL_S = 2.0           # gap between any two VSS requests
TOKEN_TTL_S = 20 * 60          # used when the JWT has no readable exp
CACHE_FILE = "vss_search_cache.json"
_HEADERS = {"User-Agent": "curl/8.5.0", "Accept": "application/json"}

_lock = RLock()               # one VSS request at a time
_cache_lock = RLock()         # the cache alone: a cached answer never waits behind a slow request
_token: str | None = None
_token_expires = 0.0
_last_call = 0.0
_cache: dict[str, dict] | None = None


def _base() -> str:
    if not all((config.INGRESS_URL, config.VSS_USERNAME, config.VSS_PASSWORD)):
        raise RuntimeError("VSS URL and login credentials must be configured")
    return config.INGRESS_URL.rstrip("/")


def _throttle() -> None:
    """Called under _lock: space requests out so we never burst the shared backend."""
    global _last_call
    wait = _last_call + MIN_INTERVAL_S - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    _last_call = time.monotonic()


def _jwt_exp(token: str) -> float | None:
    try:
        payload = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return float(claims["exp"])
    except Exception:
        return None


def _request(method: str, path: str, **kwargs) -> httpx.Response:
    with _lock:
        _throttle()
        with httpx.Client(timeout=30.0, verify=False, headers=_HEADERS) as client:
            response = client.request(method, _base() + path, **kwargs)
        response.raise_for_status()
        return response


def login(force: bool = False) -> str:
    """JWT for the VSS API, cached until a minute before it expires."""
    global _token, _token_expires
    with _lock:
        if _token and not force and time.time() < _token_expires:
            return _token
        try:
            response = _request("POST", "/api/v1/auth/login",
                                json={"username": config.VSS_USERNAME, "password": config.VSS_PASSWORD})
            token = response.json()["access_token"]
        except Exception as exc:
            raise RuntimeError(f"VSS login failed ({config.redact(exc)})") from None
        _token = token
        _token_expires = (_jwt_exp(token) or time.time() + TOKEN_TTL_S) - 60
        return token


def _authed(method: str, path: str, **kwargs) -> httpx.Response:
    for attempt in range(2):
        headers = {"Authorization": f"Bearer {login(force=bool(attempt))}"}
        try:
            return _request(method, path, headers=headers, **kwargs)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 401 or attempt:
                raise
    raise RuntimeError("unreachable")


def _cache_path() -> Path:
    return Path(config.STATE_DIR) / CACHE_FILE


def _cached(key: str) -> dict | None:
    with _cache_lock:
        return _load_cache().get(key)


def _store(key: str, entry: dict) -> None:
    with _cache_lock:
        _load_cache()[key] = entry
        _save_cache()


def _load_cache() -> dict[str, dict]:
    global _cache
    if _cache is None:
        try:
            _cache = json.loads(_cache_path().read_text())
            if not isinstance(_cache, dict):
                _cache = {}
        except (OSError, ValueError):
            _cache = {}
    return _cache


def _save_cache() -> None:
    try:
        path = _cache_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(_cache))
        temporary.replace(path)
    except OSError as exc:
        log.warning("VSS cache write failed (%s)", config.redact(exc))


def metadata_values(field: str, prefix: str = "") -> list:
    """Valid filter values, e.g. metadata_values("camera_id") to confirm "pie_cam-3"."""
    try:
        data = _authed("GET", "/api/v1/metadata/values", params={"field": field, "prefix": prefix}).json()
    except Exception as exc:
        raise RuntimeError(f"VSS metadata values failed ({config.redact(exc)})") from None
    return data.get("values", data) if isinstance(data, dict) else data


def search(query: str, top_k: int = 100, camera_id: str = "pie_cam-3",
           hybrid_text_weight: float = 0.2, min_similarity: float = 0.15) -> list[dict]:
    """Segment hits (`results[]`) for a query; cached by request so it runs once."""
    return search_full(query, top_k, camera_id, hybrid_text_weight, min_similarity)["results"]


def _synthesis(value) -> str:
    """The **Answer** part of VSS's `llm_synthesis` ({"response": markdown}); its "Notable moments" use clip-relative times."""
    text = value.get("response") if isinstance(value, dict) else value
    if not isinstance(text, str):
        return ""
    text = re.split(r"\*\*\s*Notable moments", text, maxsplit=1, flags=re.IGNORECASE)[0]
    text = re.sub(r"^\s*\*\*\s*Answer\s*\*\*\s*", "", text, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", text.replace("**", "")).strip()


def search_full(query: str, top_k: int = 100, camera_id: str = "pie_cam-3",
                hybrid_text_weight: float = 0.2, min_similarity: float = 0.15, llm_top_n: int = 1) -> dict:
    """{"results": segment hits, "synthesis": VSS's LLM answer or "", "cached": bool}, cached like search()."""
    body = {"query": query, "top_k": min(top_k, 100), "llm_top_n": max(1, llm_top_n),   # the API rejects 0
            "min_similarity": min_similarity, "hybrid_text_weight": hybrid_text_weight,
            "time_filter": "all", "metadata_filters": {"camera_id": camera_id}}
    key = json.dumps(body, sort_keys=True)
    hit = _cached(key)
    if hit is None:
        with _lock:
            hit = _cached(key)            # another caller may have fetched it while this one queued
            if hit is None:
                try:
                    data = _authed("POST", "/api/v1/search", json=body).json()
                except Exception as exc:
                    raise RuntimeError(f"VSS search failed ({config.redact(exc)})") from None
                results = [r for r in data.get("results", []) if isinstance(r, dict)]
                synthesis = _synthesis(data.get("llm_synthesis"))
                _store(key, {"results": results, "synthesis": synthesis, "at": time.time()})
                log.info("VSS search %r: %d hits", query, len(results))
                return {"results": results, "synthesis": synthesis, "cached": False}
    return {"results": hit["results"], "synthesis": hit.get("synthesis", ""), "cached": True}


def segment_caption(source: str) -> str:
    """VSS's caption (reasoning_content) for one segment, cached like searches. "" when VSS has none."""
    key = "segment:" + source
    hit = _cached(key)
    if hit is None:
        with _lock:
            hit = _cached(key)
            if hit is None:
                try:
                    data = _authed("GET", "/api/v1/videos/metadata", params={"source": source}).json()
                except Exception as exc:
                    raise RuntimeError(f"VSS segment metadata failed ({config.redact(exc)})") from None
                caption = data.get("reasoning_content") if isinstance(data, dict) else None
                hit = {"caption": caption if isinstance(caption, str) else "", "at": time.time()}
                _store(key, hit)
    return hit.get("caption", "")


def stream_url(source: str) -> str:
    """Seekable proxy URL for a segment's s3:// source (playback takes the token as a param)."""
    return f"{_base()}/api/v1/videos/stream?" + urlencode({"source": source, "token": login()})


def download(source: str, dest: str) -> None:
    """Fetch a segment through the stream proxy (the boto3 AccessDenied fallback)."""
    url = stream_url(source)
    with _lock:
        _throttle()
        try:
            with httpx.Client(timeout=120.0, verify=False, headers=_HEADERS) as client:
                with client.stream("GET", url) as response:
                    response.raise_for_status()
                    with open(dest, "wb") as out:
                        for chunk in response.iter_bytes(1 << 16):
                            out.write(chunk)
        except Exception as exc:
            # The URL carries the token: never let it reach a log.
            raise RuntimeError(f"VSS stream download failed ({config.redact(str(exc).replace(_token or '', '***'))})") from None
