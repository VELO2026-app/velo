# =============================================================================
# Test: normalize_master_methods.py starts standalone (T21-6 chain, ПРОМТ №552)
# =============================================================================
#
# ПРОМТ №552 production crash: `python scripts/normalize_master_methods.py
# --dry-run` died before touching anything --
#   InvalidRequestError: When initializing mapper Mapper[MasterProfile
#   (master_profiles)], expression 'User' failed to locate a name ('User')
#
# CAUSE: masters/models.py's `user: Mapped["User"] = relationship(...)` is a
# STRING forward reference (carries its own lint-suppression comment for
# F821, admitting the name isn't statically resolvable). SQLAlchemy resolves
# that name against whichever classes have been mapped ANYWHERE in the
# running process by the time mapper configuration runs -- a single GLOBAL
# pass across every mapped class, not scoped to the query that triggers it.
# Inside the full app this is always satisfied (app.main imports the whole
# model graph); a standalone script only registers what IT imports, and
# normalize_master_methods.py imported MasterProfile but never User.
# scripts/normalize_master_methods.py now imports User explicitly (see that
# module's own comment for the full explanation) -- this file is the check
# that the fix actually holds, and stays honest about what it can prove.
#
# WHY THIS CANNOT BE A PLAIN IN-PROCESS TEST:
# test_normalize_master_methods.py's three tests for this same script all
# PASSED at the deploy gate that shipped this bug -- they could not have
# caught it, IN PRINCIPLE, not by bad luck. conftest.py does `from app.main
# import app` at MODULE SCOPE (before any fixture, before any test), which
# imports the ENTIRE model graph -- User included -- before a single test in
# this whole suite runs. Any test in backend/tests/ that did
# `import scripts.normalize_master_methods; configure_mappers()` in-process
# would ALWAYS pass regardless of whether the script imports User itself:
# conftest already did that job first. That would be a test that passes for
# the wrong reason -- worse than no test at all, and exactly the class of
# mistake flagged twice already in this project's history.
#
# THE ACTUAL CHECK: spawn a genuinely SEPARATE Python process, cwd=backend/,
# that imports ONLY what the script itself imports and then explicitly calls
# sqlalchemy.orm.configure_mappers() -- the same global pass a real run's
# first query triggers lazily, forced here eagerly so no DB connection or
# live query is needed to reproduce the exact failure mode. This is the one
# process-boundary difference that made the bug invisible to its own
# passing unit tests, deliberately reproduced here.
#
# HONEST LIMITS, stated plainly rather than implied by a passing green dot:
#   - Proves the module CAN be imported and its mappers configured standalone.
#     Does NOT run the script's actual normalize/rollback logic (that is
#     test_normalize_master_methods.py's job).
#   - Needs a working Settings()/.env in whatever process runs it, same as
#     every other backend test in this suite -- this is not a NEW
#     limitation, it is the existing "local pytest is blocked" caveat that
#     already applies to the whole backend suite, restated honestly rather
#     than glossed over for this one file.
#   - Only catches THIS class of bug (a mapped class imported without a
#     relationship target it needs) for THIS script. It is not a general
#     linter and does not sweep every script automatically -- see the ПРОМТ
#     №552 report for the manual sweep of the other scripts.
# =============================================================================

import subprocess
import sys
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parent.parent


def test_normalize_master_methods_configures_mappers_in_a_standalone_process() -> None:
    """Spawns a fresh `python -c` process (NOT this test process) that
    imports scripts.normalize_master_methods and calls configure_mappers()
    explicitly. Would have failed with the exact ПРОМТ №552
    InvalidRequestError if scripts/normalize_master_methods.py did not
    import User -- revert that import to reproduce the failure locally in a
    container with valid settings."""
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import scripts.normalize_master_methods; "
            "from sqlalchemy.orm import configure_mappers; "
            "configure_mappers()",
        ],
        cwd=_BACKEND_DIR,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, (
        "scripts.normalize_master_methods failed to import and configure "
        f"its mappers standalone:\n--- stderr ---\n{result.stderr}"
    )
