# =============================================================================
# VELO Backend -- what the stack shows the deploy machine (protocol 9, BE-190)
# =============================================================================
#
# GET /health -- always 200, the full document of protocol 9.1, from a
#   healthy and from a degraded stack alike; status is `ok` only when every
#   check is.
# GET /ready  -- 200 {status: ready, failing: []} when every check is ok,
#   else 503 {status: not_ready, failing: [names]} (protocol 9.2). The
#   compose healthcheck of `app` reads it.
# Neither is in the API schema, and nginx of the machine keeps both off
# the public routes (protocol 9.3).
#
# The model is primer-blank's primer_report/health.py; this is its shape
# on velo's engine, Redis and structlog:
#   - every request measures anew; the checks run AT ONCE, each under
#     CHECK_TIMEOUT_S, and one that raises or does not answer in time is
#     `error` while the other is still measured (protocol 9.5);
#   - `checks` holds what velo cannot work without -- the database and
#     Redis; comms, Zoom and the rest are not checks (protocol 4.3);
#   - the database check IS the read of its revision: one query, whose
#     answer is also `alembic_head`. No revision read -> `db: error`;
#   - the last revision read is kept between requests: a database that
#     falls after it was measured reports `db: error` with that revision;
#     before the first read alembic_head is null;
#   - a check that turns to `error` is logged once (health.check_failed),
#     and again only after it was `ok` in between;
#   - no `details`: velo has nothing it must report beyond the fields.
# =============================================================================

import asyncio
import os
import time
from collections.abc import Awaitable, Callable
from typing import Literal

import structlog
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text

from app.core.config import settings
from app.core.database import get_engine
from app.core.editions import EDITIONS
from app.core.logging import SERVICE
from app.core.redis import get_redis

logger = structlog.get_logger()

CheckState = Literal["ok", "error"]

DB = "db"
REDIS = "redis"

CHECK_TIMEOUT_S = 2.0
"""How long one check may take before it is `error` (protocol 9.5: 1-2 s)."""

MAX_UPLOAD_MB = 3
"""The largest request body velo takes, in MB. The backend holds no limit
of its own: the machine's nginx does, by `max_body` of the API route in
primer.yaml, and compares it with this value in /health (protocol 9.1).
The two are kept equal by tests/test_report.py."""


class _Closed(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Seams(_Closed):
    """What velo provides to other stacks and whether its seams are met."""

    provides: list[str]
    requires_satisfied: bool


class Limits(_Closed):
    """Limits the machine compares with its host settings."""

    max_upload_mb: int = Field(ge=0)


class Health(_Closed):
    """The /health document of protocol 9.1 (no `details`)."""

    service: str = Field(min_length=1)
    release: str = Field(min_length=1)
    commit: str = Field(min_length=1)
    edition: str = Field(min_length=1)
    modules: list[str]
    alembic_head: str | None
    uptime_s: int = Field(ge=0, strict=True)
    status: Literal["ok", "degraded"]
    checks: dict[str, CheckState] = Field(min_length=1)
    seams: Seams
    limits: Limits


class Ready(_Closed):
    """The /ready document: ready, or the names of the failing checks."""

    status: Literal["ready", "not_ready"]
    failing: list[str]


def _build(name: str) -> str:
    """PRIMER_RELEASE / PRIMER_COMMIT, which the image carries."""
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"{name} is not set: /health names the build")
    return value


def seams() -> Seams:
    """`provides`: primer.yaml declares nothing velo gives another stack.
    `requires_satisfied`: every seam of comms velo reads is set. On the
    machine compose refuses to start without them (`${VAR:?}`); empty is
    reachable where they are not passed -- the test suite, a local run."""
    required = (
        settings.comms_api_url,
        settings.comms_service_token,
        settings.comms_redis_url,
        settings.telegram_bot_url,
    )
    return Seams(provides=[], requires_satisfied=all(v.strip() for v in required))


async def read_revision() -> str:
    """The database check: its revision, in one query; raises when there is
    none to read."""
    async with get_engine().connect() as conn:
        revision = (
            await conn.execute(text("SELECT version_num FROM alembic_version"))
        ).scalar_one_or_none()
    if not revision:
        raise LookupError("alembic_version holds no revision")
    return str(revision)


async def ping_redis() -> bool:
    """The Redis check."""
    return bool(await get_redis().ping())


async def _within[T](call: Callable[[], Awaitable[T]]) -> T | Exception:
    """The result of `call`, or what stopped it -- a timeout is one."""
    try:
        return await asyncio.wait_for(call(), CHECK_TIMEOUT_S)
    except Exception as error:  # every failure of a check is its `error`
        return error


class Report:
    """The two routes and the little state they keep."""

    def __init__(self) -> None:
        self._fixed = {
            "service": SERVICE,
            "release": _build("PRIMER_RELEASE"),
            "commit": _build("PRIMER_COMMIT"),
            "edition": settings.edition,
            "modules": list(EDITIONS[settings.edition]),
            "limits": Limits(max_upload_mb=MAX_UPLOAD_MB),
        }
        self._last_head: str | None = None
        self._failed: set[str] = set()
        self._started = time.monotonic()
        self.router = APIRouter()
        self.router.add_api_route(
            "/health", self.health, methods=["GET"], include_in_schema=False
        )
        self.router.add_api_route(
            "/ready", self.ready, methods=["GET"], include_in_schema=False
        )

    async def _measure(self) -> dict[str, CheckState]:
        """Both checks once, at the same time; the revision read is kept."""
        revision, redis = await asyncio.gather(
            _within(read_revision), _within(ping_redis)
        )
        if isinstance(revision, str):
            self._last_head = revision
        return {
            DB: self._state(DB, isinstance(revision, str), revision),
            REDIS: self._state(REDIS, redis is True, redis),
        }

    def _state(self, name: str, ok: bool, outcome: object) -> CheckState:
        """`ok`, or `error` -- logged on the turn only."""
        if ok:
            self._failed.discard(name)
            return "ok"
        if name not in self._failed:
            self._failed.add(name)
            logger.warning(
                "health.check_failed",
                check=name,
                error=type(outcome).__name__
                if isinstance(outcome, Exception)
                else None,
            )
        return "error"

    async def health(self) -> JSONResponse:
        """The full document; 200 whatever the state."""
        checks = await self._measure()
        document = Health(
            **self._fixed,
            alembic_head=self._last_head,
            uptime_s=int(time.monotonic() - self._started),
            status="ok" if all(s == "ok" for s in checks.values()) else "degraded",
            checks=checks,
            seams=seams(),
        )
        return JSONResponse(document.model_dump())

    async def ready(self) -> JSONResponse:
        """200 when every check passes, else 503 with the failing names."""
        checks = await self._measure()
        failing = sorted(name for name, state in checks.items() if state != "ok")
        body = Ready(status="not_ready" if failing else "ready", failing=failing)
        return JSONResponse(body.model_dump(), status_code=503 if failing else 200)
