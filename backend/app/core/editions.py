# =============================================================================
# VELO Backend -- the edition -> modules table (BE-190, BE-182)
# =============================================================================
#
# An edition is the set of velo's modules an instance runs (protocol
# 5.2.3); the instance's edition comes from its passport (EDITION ->
# Settings.edition) and its modules are reported in /health (protocol
# 9.1). Owner ruling 5.11: one edition, `ai`, with the one module `ai`;
# payments, schools, mcp, zoom, telegram and llm are instance OPTIONS
# (Settings.option_*), not modules of an edition.
#
# ONE TABLE FOR THE REPOSITORY (BE-182): editions.json at the repository
# root, in the schema the frontend reads too (FE-130):
#   {"schema": 1, "editions": {"<name>": {"modules": [...]}}}
# This module reads it once, at import. In the image backend/Dockerfile
# copies it to /editions.json -- where parents[3] of this file lands from
# /app/app/core, as the repository root does from backend/app/core.
#
# Its keys are primer.yaml's `editions` exactly (tests/test_report.py): the
# machine refuses a passport whose edition primer.yaml does not declare,
# and Settings refuses one this table does not know.
# =============================================================================

import json
from pathlib import Path

EDITIONS_FILE = Path(__file__).resolve().parents[3] / "editions.json"

_SCHEMA = 1


def _load(path: Path) -> dict[str, tuple[str, ...]]:
    """The table, checked: schema 1, at least one edition, each a list of
    module names. A malformed file stops the import -- velo does not start
    on a table it cannot read."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    if raw.get("schema") != _SCHEMA:
        raise ValueError(f"{path}: schema must be {_SCHEMA}")
    editions = raw.get("editions")
    if not isinstance(editions, dict) or not editions:
        raise ValueError(f"{path}: `editions` must be a non-empty object")
    table: dict[str, tuple[str, ...]] = {}
    for name, edition in editions.items():
        modules = edition.get("modules") if isinstance(edition, dict) else None
        if not isinstance(modules, list) or not all(
            isinstance(m, str) and m for m in modules
        ):
            raise ValueError(f"{path}: edition {name!r} needs a list of modules")
        table[name] = tuple(modules)
    return table


EDITIONS: dict[str, tuple[str, ...]] = _load(EDITIONS_FILE)
