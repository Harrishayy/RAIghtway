"""Environment config. Values are secrets: never log or print them.

On the VM the variables come from /config/<team>.config. If a key isn't in the
process env (e.g. uvicorn started from a fresh shell), it's read from that file.
"""
import glob
import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
STATE_DIR = Path(os.environ.get("CITYMAINT_STATE_DIR") or BACKEND_DIR / "state")


def _read_env_files(paths) -> dict[str, str]:
    values: dict[str, str] = {}
    for p in paths:
        try:
            for line in Path(p).read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    values.setdefault(k.strip().removeprefix("export ").strip(), v.strip().strip("'\""))
        except OSError:
            pass
    return values


def _team_config() -> dict[str, str]:
    path = os.environ.get("TEAM_CONFIG_FILE")
    # backend/.env, then the repo-root .env (both gitignored), hold our own keys, e.g. NVIDIA_API_KEY;
    # they win over the team file.
    return _read_env_files([BACKEND_DIR / ".env", BACKEND_DIR.parent / ".env",
                            *([path] if path else sorted(glob.glob("/config/team-*.config")))])


def _backend_secret() -> tuple[str | None, dict]:
    """K8s Secret whose stringData/config.yaml holds vdb_endpoint and model hosts (what VSS itself uses)."""
    path = os.environ.get("BACKEND_SECRET_FILE") or next(iter(sorted(glob.glob("/config/*backend-secret.yaml"))), None)
    if not path:
        return None, {}
    try:
        import yaml
        doc = yaml.safe_load(Path(path).read_text()) or {}
        inner = yaml.safe_load((doc.get("stringData") or {}).get("config.yaml") or "") or {}
        return path, inner if isinstance(inner, dict) else {}
    except Exception:
        return path, {}


def _url(prefix: str, scheme_key: str) -> str | None:
    host = _SECRET.get(f"{prefix}_host")
    if not host:
        return None
    host = str(host).rstrip("/")
    if "://" not in host:
        host = f"{_SECRET.get(scheme_key) or 'http'}://{host}"
    port = _SECRET.get(f"{prefix}_port")
    if port and host.count(":") < 2:
        host = f"{host}:{port}"
    return host


_FILE = _team_config()
BACKEND_SECRET_FILE, _SECRET = _backend_secret()


def _get(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name) or _FILE.get(name)
    return value if value else default


# VAST S3 + VastDB
S3_ENDPOINT = _get("S3_ENDPOINT")
ACCESS_KEY = _get("ACCESS_KEY") or _get("AWS_ACCESS_KEY_ID")
SECRET_KEY = _get("SECRET_KEY") or _get("AWS_SECRET_ACCESS_KEY")
S3_SEGMENTS_BUCKET = _get("S3_SEGMENTS_BUCKET")
S3_CHUNKS_BUCKET = _get("S3_CHUNKS_BUCKET")       # never write here (architecture §3.1)
VASTDB_BUCKET = _get("VASTDB_BUCKET")
VASTDB_SCHEMA = _get("CITYMAINT_SCHEMA", "citymaint")
VDB_ENDPOINT = _get("VDB_ENDPOINT") or _SECRET.get("vdb_endpoint")          # ADBC query endpoint
_ADBC_REL = "vss-blueprint/source-code/retrieval/video-backend/libadbc_driver_vastdb.so"
ADBC_DRIVER_PATH = _get("ADBC_DRIVER_PATH") or next(
    (p for p in (f"/{_ADBC_REL}", str(Path.home() / _ADBC_REL)) if Path(p).is_file()), f"/{_ADBC_REL}")
MEDIA_MODE = _get("MEDIA_MODE", "s3")             # "s3" or "vastdb" (frames-table fallback, gate check 5)

# GPU model endpoints (shared CoreWeave GPUs)
COSMOS3_REASON_URL = _get("COSMOS3_REASON_URL") or _url("cosmos", "cosmoshttpscheme")
COSMOS3_REASON_MODEL = _get("COSMOS3_REASON_MODEL") or _SECRET.get("cosmos_model") or "nvidia/cosmos3-reason"
COSMOS_EMBED1_URL = _get("COSMOS_EMBED1_URL") or _url("embedding", "embedding_http_scheme")
COSMOS_EMBED1_MODEL = _get("COSMOS_EMBED1_MODEL", "nvidia/cosmos-embed1")
GPU_BEARER_TOKEN = _get("GPU_BEARER_TOKEN")
GPU_CONCURRENCY = int(_get("GPU_CONCURRENCY", "6"))

# W&B Inference + Weave
WANDB_API_KEY = _get("WANDB_API_KEY")
WANDB_TEAM = _get("WANDB_TEAM")
WANDB_PROJECT = _get("WANDB_PROJECT")

# cuOpt (hosted)
NVIDIA_API_KEY = _get("NVIDIA_API_KEY") or _get("NVIDIA_NIM_API_KEY") or _SECRET.get("nvidia_api_key")

# Road routing (OSRM) and road restrictions (City of Toronto open data). "off" disables either one;
# both are public, keyless and fall back to straight lines / dashcam work zones only.
ROUTING_URL = _get("ROUTING_URL", "https://router.project-osrm.org")
ROUTING_MIN_INTERVAL_S = _get("ROUTING_MIN_INTERVAL_S")   # default: 1 s on the public server, 0 elsewhere
ROAD_RESTRICTIONS_URL = _get("ROAD_RESTRICTIONS_URL",
                             "https://secure.toronto.ca/opendata/cart/road_restrictions/v3?format=json")
RUN_CLIPS = int(_get("RUN_CLIPS", "3"))           # clips one Run press analyses: new footage first, then re-checks
DEMO_CURATION = _get("DEMO_CURATION")             # "1": demo mode on at start (app/curation.py)
FACILITIES_FILE = _get("FACILITIES_FILE")         # JSON list of Facility; defaults to app/planning/facilities.json

# VSS backend API (zsh reserves USERNAME, so VSS_USERNAME takes precedence)
INGRESS_URL = _get("INGRESS_URL")
VSS_USERNAME = _get("VSS_USERNAME") or _FILE.get("USERNAME")
VSS_PASSWORD = _get("VSS_PASSWORD") or _get("PASSWORD")

_SECRETS = [str(s) for s in (ACCESS_KEY, SECRET_KEY, GPU_BEARER_TOKEN, WANDB_API_KEY, NVIDIA_API_KEY, VSS_PASSWORD,
                             *(_SECRET.get(k) for k in ("vdb_access_key", "vdb_secret_key", "s3_access_key",
                                                        "s3_secret_key", "jwt_secret", "cosmos_authorization",
                                                        "embedding_authorization")))
            if s and len(str(s)) >= 4]


def redact(exc: BaseException | str, limit: int = 300) -> str:
    """Loggable error text: secret values masked, length capped."""
    text = f"{type(exc).__name__}: {exc}" if isinstance(exc, BaseException) else str(exc)
    for secret in _SECRETS:
        text = text.replace(secret, "***")
    return text if len(text) <= limit else text[:limit] + "…"
