#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
exec uvicorn app.main:app --host 127.0.0.1 --port 8000
