#!/bin/sh
set -eu

python scripts/validate_production_config.py

# Render Free does not support preDeployCommand. Run migrations at process
# start only when cloud persistence is intentionally configured. Alembic uses
# DATABASE_URL_DIRECT when provided, which avoids pooler migration issues.
if [ -n "${DATABASE_URL:-}" ]; then
  python -m alembic upgrade head
fi

exec python -m uvicorn main:app \
  --host 0.0.0.0 \
  --port "${PORT:-8000}" \
  --workers 1 \
  --log-level "${LOG_LEVEL:-info}" \
  --access-log \
  --ws-ping-interval 20 \
  --ws-ping-timeout 20
