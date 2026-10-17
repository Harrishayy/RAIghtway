"""Synchronous media storage with explicit S3 and VastDB modes."""
from functools import lru_cache

import boto3
from botocore.config import Config
import urllib3

from app import config
from app.vast import db


urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


@lru_cache(maxsize=1)
def _client():
    if not all((config.S3_ENDPOINT, config.ACCESS_KEY, config.SECRET_KEY)):
        raise RuntimeError("S3 endpoint and credentials must be configured")
    return boto3.client("s3", endpoint_url=config.S3_ENDPOINT,
                        aws_access_key_id=config.ACCESS_KEY,
                        aws_secret_access_key=config.SECRET_KEY, verify=False,
                        config=Config(s3={"addressing_style": "path"},
                                      connect_timeout=3, read_timeout=10,
                                      retries={"total_max_attempts": 2}))


def _check_bucket(bucket):
    if bucket == config.S3_CHUNKS_BUCKET:
        raise ValueError("Writes to S3_CHUNKS_BUCKET are forbidden")
    if not bucket:
        raise RuntimeError("S3_SEGMENTS_BUCKET must be configured")


def _put_object(bucket, key, body, content_type):
    _check_bucket(bucket)
    try:
        _client().put_object(Bucket=bucket, Key=key, Body=body, ContentType=content_type)
    except Exception as exc:
        raise RuntimeError(f"S3 media write failed ({config.redact(exc)})") from None


def _mode():
    if config.MEDIA_MODE not in ("s3", "vastdb"):
        raise ValueError("MEDIA_MODE must be s3 or vastdb")
    return config.MEDIA_MODE


def put_frame(issue_id: str, jpeg: bytes) -> str:
    if _mode() == "vastdb":
        db._put_frame(issue_id, jpeg)
        return f"db:{issue_id}"
    key = f"citymaint/frames/{issue_id}.jpg"
    _put_object(config.S3_SEGMENTS_BUCKET, key, jpeg, "image/jpeg")
    return key


def get_frame(issue_id: str, frame_key: str) -> bytes:
    if frame_key.startswith("db:"):
        return db._get_frame(frame_key[3:])
    if not config.S3_SEGMENTS_BUCKET:
        raise RuntimeError("S3_SEGMENTS_BUCKET must be configured")
    try:
        body = _client().get_object(Bucket=config.S3_SEGMENTS_BUCKET, Key=frame_key)["Body"]
        try:
            return body.read()
        finally:
            body.close()
    except Exception as exc:
        raise RuntimeError(f"S3 frame read failed ({config.redact(exc)})") from None


def put_original(video_id: str, path: str) -> str | None:
    if _mode() == "vastdb":
        return None
    _check_bucket(config.S3_SEGMENTS_BUCKET)
    key = f"citymaint/uploads/{video_id}.video"
    with open(path, "rb") as original:
        _put_object(config.S3_SEGMENTS_BUCKET, key, original, "video/mp4")
    return key
