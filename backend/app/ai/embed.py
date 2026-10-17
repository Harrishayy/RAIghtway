"""Cosmos-Embed1 video embeddings; failures are catchable by the pipeline."""
import asyncio
import base64
import math
from pathlib import Path

from app import config
from app.ai import gpu
from app.ai.weave_setup import op


@op
async def embed_clip(mp4_path: str) -> list[float]:
    if not config.COSMOS_EMBED1_URL:
        raise RuntimeError("COSMOS_EMBED1_URL is not configured")
    data = await asyncio.to_thread(Path(mp4_path).read_bytes)
    payload = {"input": "data:video/mp4;base64," + base64.b64encode(data).decode("ascii"),
               "model": config.COSMOS_EMBED1_MODEL, "request_type": "query", "encoding_format": "float"}
    async with gpu.slot():
        response = await gpu.client().post(config.COSMOS_EMBED1_URL.rstrip("/") + "/v1/embeddings",
                                           json=payload)
        response.raise_for_status()
    try:
        values = response.json()["data"][0]["embedding"]
        if not isinstance(values, list) or len(values) != 256:
            raise ValueError("Cosmos-Embed1 must return exactly 256 values")
        embedding = [float(value) for value in values]
        if not all(math.isfinite(value) for value in embedding):
            raise ValueError("Cosmos-Embed1 returned non-finite values")
        return embedding
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise ValueError("Invalid Cosmos-Embed1 response: expected 256 finite floats") from exc
