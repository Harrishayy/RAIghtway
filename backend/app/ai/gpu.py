"""Shared GPU capacity and the cooperative pre-compute pause switch."""
import asyncio
from contextlib import asynccontextmanager

import httpx

from app import config

_semaphore = asyncio.Semaphore(config.GPU_CONCURRENCY)
_running = asyncio.Event()
_running.set()
_client: httpx.AsyncClient | None = None


@asynccontextmanager
async def slot():
    async with _semaphore:
        yield


def pause() -> None:
    _running.clear()


def resume() -> None:
    _running.set()


def is_paused() -> bool:
    return not _running.is_set()


async def wait_if_paused() -> None:
    await _running.wait()


def client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        headers = {}
        if config.GPU_BEARER_TOKEN:
            headers["Authorization"] = f"Bearer {config.GPU_BEARER_TOKEN}"
        _client = httpx.AsyncClient(timeout=90.0, headers=headers)
    return _client
