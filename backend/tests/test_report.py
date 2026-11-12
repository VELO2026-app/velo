# =============================================================================
# BE-190 -- /health and /ready of protocol 9 (app/core/report.py)
# =============================================================================
#
# What is pinned here:
#   - /health: always 200, exactly the eleven fields with their types and
#     values, and `details` with the options on (BE-182);
#   - checks: the database and Redis only, measured AT ONCE, each under the
#     timeout; raise or time out -> `error`; the revision is read in ONE
#     query, kept when the database falls, null before the first read; no
#     revision -> `db: error`; a failing check is logged once per turn;
#   - /ready: 200 ready / 503 not_ready with the failing names;
#   - neither route is in the API schema;
#   - the values primer.yaml and the code must agree on: the edition table,
#     the body limit, the stack's name; Settings refuses an unknown edition;
#   - requires_satisfied is computed, not a constant.
#
# The database and Redis of the suite are real; "down" and "slow" replace
# the two check functions of the module, the layer /health calls.
# =============================================================================

import asyncio
import os
import time
from pathlib import Path

import pytest
import yaml
from httpx import AsyncClient
from pydantic import ValidationError
from sqlalchemy import event, text
from structlog.testing import capture_logs

from app.core import report
from app.core.config import Settings, settings
from app.core.database import get_engine
from app.core.editions import EDITIONS
from app.core.logging import SERVICE
from app.main import app, report_instance

PRIMER = Path(__file__).resolve().parents[2] / "primer.yaml"

FIELDS = {
    "service",
    "release",
    "commit",
    "edition",
    "modules",
    "alembic_head",
    "uptime_s",
    "status",
    "checks",
    "seams",
    "limits",
    "details",
}


def _report() -> report.Report:
    """The Report the app serves -- its state is what the tests look at."""
    return report_instance


@pytest.fixture(autouse=True)
def fresh_state():
    """Each test starts from a report that has logged no failure."""
    _report()._failed.clear()
    yield
    _report()._failed.clear()


async def _down() -> object:
    raise ConnectionError("down")


async def _slow() -> object:
    await asyncio.sleep(5)
    return True


async def _revision_now() -> str:
    async with get_engine().connect() as conn:
        return (
            await conn.execute(text("SELECT version_num FROM alembic_version"))
        ).scalar_one()


# -- /health ------------------------------------------------------------------


async def test_health_is_the_eleven_fields_and_details(client: AsyncClient) -> None:
    """The document of protocol 9.1, field by field. `seams.provides` was
    `[]` -- right while primer.yaml provided nothing; BE-193 gave comms the
    point of velo-storage (STORAGE_ADDRESS), so it is report.PROVIDES, which
    tests/test_primer_env.py holds equal to primer.yaml's `provides`."""
    resp = await client.get("/health")

    assert resp.status_code == 200
    doc = resp.json()
    assert set(doc) == FIELDS  # the eleven and details, nothing else
    assert doc["service"] == SERVICE == "velo"
    assert doc["release"] == os.environ["PRIMER_RELEASE"] and doc["release"]
    assert doc["commit"] == os.environ["PRIMER_COMMIT"] and doc["commit"]
    assert doc["edition"] == settings.edition
    assert doc["modules"] == list(EDITIONS[settings.edition]) and doc["modules"]
    assert doc["alembic_head"] == await _revision_now()
    assert isinstance(doc["uptime_s"], int) and doc["uptime_s"] >= 0
    assert doc["status"] == "ok"
    assert doc["checks"] == {"db": "ok", "redis": "ok"}
    assert doc["seams"] == {
        "provides": list(report.PROVIDES),
        "requires_satisfied": report.seams().requires_satisfied,
    }
    assert doc["limits"] == {"max_upload_mb": 3}
    # BE-182: the options on, sorted, from the flags (protocol 9.1 details).
    assert doc["details"] == {"options": settings.enabled_options}
    assert doc["details"]["options"]  # the suite runs with options on


async def test_the_database_check_is_one_query(client: AsyncClient) -> None:
    """The check and alembic_head are the same read (protocol 9.5)."""
    statements: list[str] = []

    def seen(conn, cursor, statement, *args) -> None:
        statements.append(statement)

    sync_engine = get_engine().sync_engine
    event.listen(sync_engine, "before_cursor_execute", seen)
    try:
        resp = await client.get("/health")
    finally:
        event.remove(sync_engine, "before_cursor_execute", seen)

    assert resp.json()["checks"]["db"] == "ok"
    assert statements == ["SELECT version_num FROM alembic_version"]


@pytest.mark.parametrize(
    ("db", "redis", "checks"),
    [
        pytest.param(_down, None, {"db": "error", "redis": "ok"}, id="db-down"),
        pytest.param(None, _down, {"db": "ok", "redis": "error"}, id="redis-down"),
        pytest.param(_down, _down, {"db": "error", "redis": "error"}, id="both"),
    ],
)
async def test_a_failing_check_is_degraded_and_still_200(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, db, redis, checks
) -> None:
    if db:
        monkeypatch.setattr(report, "read_revision", db)
    if redis:
        monkeypatch.setattr(report, "ping_redis", redis)

    resp = await client.get("/health")

    assert resp.status_code == 200
    assert resp.json()["status"] == "degraded"
    assert resp.json()["checks"] == checks


async def test_the_checks_run_at_once_under_the_timeout(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both hang: both are `error`, and the answer takes one timeout, not
    two -- the checks run together."""
    monkeypatch.setattr(report, "CHECK_TIMEOUT_S", 0.3)
    monkeypatch.setattr(report, "read_revision", _slow)
    monkeypatch.setattr(report, "ping_redis", _slow)

    started = time.monotonic()
    resp = await client.get("/health")
    took = time.monotonic() - started

    assert resp.json()["checks"] == {"db": "error", "redis": "error"}
    assert 0.3 <= took < 0.55


async def test_a_fallen_database_keeps_the_last_revision(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    head = (await client.get("/health")).json()["alembic_head"]
    assert head

    monkeypatch.setattr(report, "read_revision", _down)
    doc = (await client.get("/health")).json()

    assert doc["checks"]["db"] == "error"
    assert doc["alembic_head"] == head


async def test_before_any_read_the_revision_is_null(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fresh = report.Report()
    monkeypatch.setattr(report, "read_revision", _down)

    resp = await fresh.health()

    assert resp.status_code == 200
    assert b'"alembic_head":null' in resp.body
    assert b'"db":"error"' in resp.body


async def test_no_revision_in_the_table_is_an_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An empty alembic_version is not a revision: read_revision raises,
    and the check is `error`."""

    class _Result:
        def scalar_one_or_none(self) -> None:
            return None

    class _Conn:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc) -> None:
            return None

        async def execute(self, _stmt) -> _Result:
            return _Result()

    class _Engine:
        def connect(self) -> _Conn:
            return _Conn()

    monkeypatch.setattr(report, "get_engine", lambda: _Engine())

    with pytest.raises(LookupError):
        await report.read_revision()
    assert (await report.Report()._measure())["db"] == "error"


async def test_a_failing_check_is_logged_once_per_turn(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    with capture_logs() as logs:
        monkeypatch.setattr(report, "ping_redis", _down)
        await client.get("/health")
        await client.get("/ready")
        monkeypatch.undo()
        await client.get("/health")  # back to ok
        monkeypatch.setattr(report, "ping_redis", _down)
        await client.get("/health")

    failed = [e for e in logs if e["event"] == "health.check_failed"]
    assert [(e["check"], e["error"]) for e in failed] == [
        ("redis", "ConnectionError"),
        ("redis", "ConnectionError"),
    ]


# -- /ready -------------------------------------------------------------------


async def test_ready_when_every_check_is_ok(client: AsyncClient) -> None:
    resp = await client.get("/ready")

    assert resp.status_code == 200
    assert resp.json() == {"status": "ready", "failing": []}


async def test_not_ready_names_the_failing_checks(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(report, "read_revision", _down)
    monkeypatch.setattr(report, "ping_redis", _down)

    resp = await client.get("/ready")

    assert resp.status_code == 503
    assert resp.json() == {"status": "not_ready", "failing": ["db", "redis"]}


# -- outside the schema ---------------------------------------------------------


def test_neither_route_is_in_the_api_schema() -> None:
    paths = app.openapi()["paths"]
    assert "/health" not in paths and "/ready" not in paths
    assert paths  # the schema itself is built


# -- primer.yaml and the code agree ---------------------------------------------


def _primer() -> dict:
    return yaml.safe_load(PRIMER.read_text(encoding="utf-8"))


def test_the_edition_table_is_primer_yamls() -> None:
    declared = set(_primer()["editions"])
    assert set(EDITIONS) == declared
    assert declared  # the compared sets are real


def test_the_body_limit_is_the_api_routes() -> None:
    assert _primer()["host"]["routes"]["api"]["max_body"] == (
        f"{report.MAX_UPLOAD_MB}M"
    )


def test_the_service_is_the_products_name() -> None:
    assert _primer()["name"] == SERVICE


def test_an_unknown_edition_refuses_the_start() -> None:
    with pytest.raises(ValidationError, match="not an edition of velo"):
        Settings(edition="full")
    assert Settings(edition="ai").edition == "ai"


# -- computed, not constant -----------------------------------------------------


@pytest.mark.parametrize(
    "empty",
    [
        None,
        "comms_api_url",
        "comms_service_token",
        "comms_redis_url",
        "telegram_bot_url",
    ],
)
def test_requires_satisfied_needs_every_comms_seam(
    monkeypatch: pytest.MonkeyPatch, empty: str | None
) -> None:
    for name in ("comms_api_url", "comms_service_token", "comms_redis_url"):
        monkeypatch.setattr(settings, name, "set")
    monkeypatch.setattr(settings, "telegram_bot_url", "https://t.me/velo_bot")
    if empty:
        monkeypatch.setattr(settings, empty, "")

    assert report.seams().requires_satisfied is (empty is None)


@pytest.mark.parametrize("name", ["PRIMER_RELEASE", "PRIMER_COMMIT"])
def test_a_build_without_its_identity_refuses(
    monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    monkeypatch.setenv(name, "")
    with pytest.raises(RuntimeError, match=name):
        report.Report()
