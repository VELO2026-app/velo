#!/usr/bin/env python3
"""Seed the `e2e` profile from the frontend tree (FE-161).

The frontend does not change `backend/**`, and the e2e profile belongs to the
e2e contour, so the profile lives in ./seed/e2e.json. backend/scripts/seed.py
looks profiles up in its module-level PROFILES_DIR on every call; this wrapper
points that at ./seed and runs the stock `main()` with `--profile e2e`.

Usage (same environment as the backend: DATABASE_URL, VELO_ROLE=test, ...):
    python frontend/e2e/stack/seed_e2e.py [--reset] [--dry-run] ...
Extra arguments pass through to seed.py.

If seed.py renames PROFILES_DIR or main(), this fails loudly instead of
seeding nothing.
"""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[2] / "backend"

for p in (BACKEND / "scripts", BACKEND):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import seed  # noqa: E402

for attr in ("PROFILES_DIR", "main"):
    if not hasattr(seed, attr):
        raise SystemExit(
            f"seed_e2e.py: backend/scripts/seed.py has no `{attr}` any more; "
            "update frontend/e2e/stack/seed_e2e.py to match."
        )

seed.PROFILES_DIR = HERE / "seed"
sys.argv = [sys.argv[0], "--profile", "e2e", *sys.argv[1:]]
sys.exit(seed.main())
