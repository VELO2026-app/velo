#!/bin/sh
# =============================================================================
# VELO -- bring up the e2e stack's backend (FE-161)
# =============================================================================
#
# Postgres and Redis must already run (CI: job services; locally: brew). This
# script, from the repo root:
#   1. alembic upgrade head
#   2. seed the `e2e` profile (frontend/e2e/stack/seed/e2e.json,
#      via the seed_e2e.py wrapper -- backend/** stays untouched)
#   3. make the sweep's admin (607031) an admin -- the profile has no admin role
#   4. start the comms stub (:8899) and uvicorn (:8000) in the background
#   5. wait for /ready
# Idempotent: the seed and the role flip are no-ops on a second run.
#
# Environment: everything backend/app/core/config.py reads -- the required
# keys come from backend/ci.env (set -a; . backend/ci.env; set +a), the
# place's own: DATABASE_URL, REDIS_URL, STORAGE_ENDPOINT, STORAGE_SECRET_KEY,
# TELEGRAM_BOT_TOKEN, COMMS_API_URL, COMMS_SERVICE_TOKEN, ... -- plus
#   PYTHON        the backend's interpreter (default: python)
#   E2E_LOG_DIR   where the two servers log (default: /tmp/velo-e2e)
#
# The velo-dev stand (~/work/velo-dev) does not need this: there it is
#   python frontend/e2e/stack/seed_e2e.py && velo setrole 607031 A --yes
# (`velo seed` cannot see the profile: it lives in frontend/e2e/stack/seed/)
# =============================================================================
set -eu

PYTHON=${PYTHON:-python}
LOG_DIR=${E2E_LOG_DIR:-/tmp/velo-e2e}
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$LOG_DIR"

cd "$ROOT/backend"
export PYTHONPATH="$ROOT/backend${PYTHONPATH:+:$PYTHONPATH}"

"$PYTHON" -m alembic upgrade head
"$PYTHON" "$ROOT/frontend/e2e/stack/seed_e2e.py"
"$PYTHON" scripts/set_role.py 607031 A --yes

# A server already on a port would answer /ready with ITS code while the new
# one dies on bind -- refuse instead of testing a stale stack.
for port in 8000 8899; do
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$port/"; then
    echo "e2e stack: port $port is taken -- stop the old server first" >&2
    exit 1
  fi
done

nohup "$PYTHON" "$ROOT/frontend/e2e/stack/comms-stub.py" --port 8899 \
  >"$LOG_DIR/comms-stub.log" 2>&1 &
nohup "$PYTHON" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 \
  >"$LOG_DIR/uvicorn.log" 2>&1 &

i=0
until curl -sf http://127.0.0.1:8000/ready >/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "e2e stack: the backend is not ready after 60 s" >&2
    tail -n 40 "$LOG_DIR/uvicorn.log" >&2
    exit 1
  fi
  sleep 1
done
echo "e2e stack: backend ready on :8000, comms stub on :8899 (logs: $LOG_DIR)"
