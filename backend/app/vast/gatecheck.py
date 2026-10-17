"""VM checks: python -m app.vast.gatecheck [--gate4] [--gate5] [--stats]."""
import argparse
from datetime import datetime, timezone
import json
import logging
import subprocess
import time
import uuid

import httpx
import numpy as np

from app import config
from app.models import IssueRecord
from app.vast import db, media, vector


def gate4() -> None:
    print("gate4: ensuring tables and inserting into gatecheck_issues only", flush=True)
    db.ensure_tables()
    with db._transaction() as tx:
        schema = db._schema(tx)
        if schema.table("gatecheck_issues", fail_if_missing=False) is None:
            schema.create_table("gatecheck_issues", db._schemas()["issues"])
    embedding = np.random.default_rng().normal(size=256).astype(np.float32)
    issue_id = "gatecheck-" + uuid.uuid4().hex
    issue = IssueRecord(id=issue_id, video_id="gatecheck", source="corpus", t=0,
                        category="pavement", severity=1, confidence=1,
                        description="Isolated gate check", frame_key="", frame_url="",
                        bbox=None, lat=43.65, lon=-79.38,
                        created_at=datetime.now(timezone.utc), embedding=embedding.tolist())
    db._insert_rows("gatecheck_issues", [db._issue_row(issue)], schema_name="issues")
    inserted_at = time.monotonic()
    vector.add(issue_id, embedding, {"category": issue.category, "source": issue.source,
                                   "lat": issue.lat, "lon": issue.lon, "duplicate_of": None})
    fallback = vector._numpy_nearest(embedding, k=1)
    sql = vector._build_sql(embedding, k=1, table="gatecheck_issues")
    print("gate4: polling ADBC visibility for up to 20 seconds", flush=True)
    while time.monotonic() - inserted_at < 20:
        hits = vector._adbc_query(sql)
        if hits and hits[0][0] == issue_id:
            lag = time.monotonic() - inserted_at
            if fallback[0][0] != issue_id or abs(hits[0][1] - fallback[0][1]) > 1e-5:
                raise RuntimeError("ADBC and numpy gate results differ")
            print(f"gate4: PASS top_hit_matches_numpy=True distance={hits[0][1]:.8f} "
                  f"observed_visibility_lag_s={lag:.3f}")
            return
        time.sleep(0.5)
    raise RuntimeError("Gate row was not visible through ADBC within 20 seconds")


def _sample_media():
    # No fixture files: produce a real JPEG and one-frame MP4 on stdout.
    common = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
              "color=c=gray:s=16x16:r=1", "-frames:v", "1"]
    try:
        jpeg = subprocess.run(common + ["-c:v", "mjpeg", "-f", "image2pipe", "pipe:1"],
                              capture_output=True, check=True, timeout=10).stdout
        video = subprocess.run(common + ["-c:v", "libx264", "-movflags",
                                         "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"],
                               capture_output=True, check=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        raise RuntimeError("Gate 5 requires ffmpeg with mjpeg and libx264 encoders") from None
    return jpeg, video


def gate5() -> None:
    media._check_bucket(config.S3_SEGMENTS_BUCKET)
    print("gate5: writing isolated S3 objects (independent of MEDIA_MODE)", flush=True)
    jpeg, original = _sample_media()
    frame_key = "citymaint/gatecheck/frames/test.jpg"
    original_key = "citymaint/gatecheck/uploads/test.video"
    media._put_object(config.S3_SEGMENTS_BUCKET, frame_key, jpeg, "image/jpeg")
    media._put_object(config.S3_SEGMENTS_BUCKET, original_key, original, "video/mp4")
    if media.get_frame("gatecheck", frame_key) != jpeg:
        raise RuntimeError("Gate frame failed byte-for-byte readback")
    print("gate5: PASS S3 writes and frame readback; original suffix=.video")
    print("Verify on the day: compare --stats before/after and inspect VSS Explore after "
          "the ingest delay. If counts change, use MEDIA_MODE=vastdb and notify agents 1/5.")


def _stats_summary(payload):
    summary = {}

    def collect(value, path="", count_group=False):
        if not isinstance(value, dict):
            return
        for key, child in value.items():
            label = str(key).lower()
            child_path = f"{path}.{key}" if path else str(key)
            is_count = (count_group or label.startswith("total") or label.endswith("_count")
                        or label in ("counts", "totals"))
            if isinstance(child, (int, float)) and not isinstance(child, bool):
                if is_count or child_path.endswith("pipeline_alignment.pending_index"):
                    summary[child_path] = child
            elif isinstance(child, dict):
                collect(child, child_path, is_count)

    collect(payload)
    if not any(key.endswith("pipeline_alignment.pending_index") for key in summary):
        summary["pipeline_alignment.pending_index"] = None
    return summary


def stats() -> None:
    if not all((config.INGRESS_URL, config.VSS_USERNAME, config.VSS_PASSWORD)):
        raise RuntimeError("VSS URL and login credentials must be configured")
    try:
        with httpx.Client(timeout=10) as client:
            base = config.INGRESS_URL.rstrip("/")
            response = client.post(base + "/api/v1/auth/login", json={
                "username": config.VSS_USERNAME, "password": config.VSS_PASSWORD})
            response.raise_for_status()
            token = response.json()["access_token"]
            response = client.get(base + "/api/v1/dashboard/stats", params={"scope": "all"},
                                  headers={"Authorization": f"Bearer {token}"})
            response.raise_for_status()
            summary = _stats_summary(response.json())
    except Exception as exc:
        raise RuntimeError(f"VSS stats request failed ({config.redact(exc)})") from None
    print("stats: " + json.dumps(summary, sort_keys=True, separators=(",", ":")))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gate4", action="store_true", help="Isolated SDK/ADBC vector roundtrip")
    parser.add_argument("--gate5", action="store_true", help="S3 write/read check (uses ffmpeg)")
    parser.add_argument("--stats", action="store_true", help="VSS total counts and pending index")
    args = parser.parse_args()
    if not any((args.gate4, args.gate5, args.stats)):
        parser.print_help()
        return 0
    logging.basicConfig(level=logging.WARNING)
    failed = False
    checks = []
    if args.stats:
        checks.append(("stats-before" if args.gate5 else "stats", stats))
    if args.gate4:
        checks.append(("gate4", gate4))
    if args.gate5:
        checks.append(("gate5", gate5))
        if args.stats:
            checks.append(("stats-after-immediate", stats))
    for label, check in checks:
        try:
            check()
        except Exception as exc:
            detail = config.redact(exc)
            print(f"{label}: FAIL {detail}")
            failed = True
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
