#!/usr/bin/env python3
# =============================================================================
# VELO Backend -- OpenAPI schema to stdout, without HTTP (BE-114 item 2)
# =============================================================================
#
# Usage, from the host, through the running app container:
#   docker compose exec -T app python scripts/dump_openapi.py > openapi.json
#
# WHY NOT `curl http://127.0.0.1:8000/openapi.json`. That was how `velo
# update`, `velo gen-types` and the installer got the schema, and it needed
# the schema to be served over HTTP -- which made it public on every box the
# API is reachable from. The schema is built in-process here instead, the
# way CI already builds it (.github/workflows/ci.yml): the app no longer
# serves the schema at all (BE-114 item 2, app/main.py), and the type
# generation does not lose its input.
#
# STDOUT CARRIES THE SCHEMA AND NOTHING ELSE. The caller redirects stdout
# into the file the generator parses, so one stray line breaks the deploy.
# Importing app.main runs module-level code (the MCP app is built there),
# and structlog prints to stdout until the app's lifespan configures it --
# which never runs here. So stdout is pointed at stderr BEFORE that import,
# and the schema is written to the real stdout kept aside. Anything the
# import prints lands on stderr, where the operator still sees it.
#
# No lifespan, no database, no Redis: app.openapi() reads the routes and the
# schemas, nothing else. It does not depend on the app SERVING the schema --
# FastAPI builds it whether or not openapi_url is set.
# =============================================================================

import json
import sys
from pathlib import Path

# -- sys.path bootstrap (same as backfill_comms_sync.py) ---------------------
# The image sets PYTHONPATH=/app; a run from a checkout does not.
_BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))


def main() -> int:
    """Write the app's OpenAPI document to stdout as JSON; 0 on success."""
    schema_out = sys.stdout
    sys.stdout = sys.stderr
    try:
        from app.main import app

        schema = app.openapi()
    finally:
        sys.stdout = schema_out

    json.dump(schema, schema_out, ensure_ascii=False)
    schema_out.write("\n")
    schema_out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
