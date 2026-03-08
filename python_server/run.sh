#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

.venv/bin/uvicorn python_server.api.main:app \
  --host 0.0.0.0 \
  --port 8000 \
  --reload \
  --reload-dir python_server \
  --reload-dir python_utils
