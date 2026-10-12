# =============================================================================
# VELO -- Tests: one pooled connection at a time per request (BE-146)
# =============================================================================
#
# THE DEFECT. get_current_user / get_optional_user / get_current_master
# loaded through Depends(get_db_reader), a request-scoped yield dependency
# whose connection stays checked out until after the response is sent. On
# an endpoint that also takes get_db_session the request held the reader's
# connection while acquiring the writer's. Under 30+ concurrent writes per
# worker every pool slot was held by a first connection waiting for a
# second: the pool stood still until pool_timeout (30 s) answered 500.
# 84 endpoints were in that class. Measured with loadtest/04-race.js:
# 456 of 500 bookings answered 500, the data stayed correct.
#
# THE FIX (auth/dependencies.py, module header): those dependencies load in
# a short session of their own, closed before they return.
#
# WHAT IS PINNED HERE, three ways:
#   1. CLASS, statically: no route has get_db_reader and the write session
#      in one dependency tree. Red on 6ba147d (84 routes), green after.
#   2. MECHANISM, per dependency: called directly, each returns with the
#      pool exactly as it found it -- on success and on every refusal --
#      and refusals decided before the database take no connection at all.
#   3. EFFECT, end to end: a request through a class endpoint never has
#      more than one connection checked out at once.
#
# telegram_id band: 89023-89032.
# =============================================================================

from collections.abc import AsyncGenerator, Callable, Iterator
from contextlib import contextmanager
from typing import Any
from uuid import UUID

import pytest
from fastapi.routing import APIRoute, iter_route_contexts
from httpx import AsyncClient
from sqlalchemy import event, inspect
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from app.core.database import _transaction, get_db_reader, get_db_session, get_engine
from app.core.exceptions import ForbiddenError, UnauthorizedError
from app.main import app
from app.modules.auth.dependencies import (
    get_current_admin,
    get_current_master,
    get_current_user,
    get_optional_user,
)
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

BAND_MIN, BAND_MAX = 89023, 89032

STUDENT_TG = BAND_MIN
ADMIN_TG = BAND_MIN + 1
MASTER_TG = BAND_MIN + 2
PENDING_MASTER_TG = BAND_MIN + 3
BARE_MASTER_TG = BAND_MIN + 4
INACTIVE_TG = BAND_MIN + 5


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, BAND_MIN, BAND_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, BAND_MIN, BAND_MAX, delete_users=True)
    await db_session.commit()


# ---------------------------------------------------------------------------
# 1. The class, over the dependency tree
# ---------------------------------------------------------------------------
#
# The routes come from fastapi.routing.iter_route_contexts, NOT app.routes:
# this application includes its routers lazily (FastAPI 0.143
# _IncludedRouter), and app.routes holds 3 API routes out of 209 -- a test
# built on it would scan almost nothing and pass. The scan is therefore
# paired with the OpenAPI document: every documented operation must have
# been scanned, and the walker must have seen readers AND writers, or a
# broken walker would also report "no route mixes them".

_WRITE_SESSION = (get_db_session, _transaction)
_IGNORED_METHODS = {"HEAD", "OPTIONS"}


def _calls(dependant: Any) -> Iterator[Any]:
    """Every dependency callable in the tree, depth first."""
    for sub in dependant.dependencies:
        yield sub.call
        yield from _calls(sub)


def _scanned_routes() -> list[tuple[str, str, list[Any]]]:
    """(method, path, dependency callables) for every API operation."""
    out = []
    for ctx in iter_route_contexts(app.router.routes):
        if not isinstance(ctx.original_route, APIRoute):
            continue
        calls = list(_calls(ctx.dependant))
        for method in sorted(ctx.methods - _IGNORED_METHODS):
            out.append((method, ctx.path, calls))
    return out


def test_no_route_holds_the_reader_and_the_writer() -> None:
    routes = _scanned_routes()

    # Pair 1: the scan covers every documented operation.
    documented = {
        (method.upper(), path)
        for path, ops in app.openapi()["paths"].items()
        for method in ops
    }
    scanned = {(method, path) for method, path, _ in routes}
    assert documented, "the OpenAPI document lists no operation"
    missing = sorted(documented - scanned)
    assert not missing, f"operations the scan never saw: {missing}"

    # Pair 2: the walker sees both sides, AND sees below the first level.
    # Every offender of BE-146 had its reader one or two levels down (under
    # get_current_user / get_current_master), so a walker that stopped at
    # the endpoint's own parameters would report a clean tree. _transaction
    # is the depth probe: no endpoint declares it, it only ever sits under
    # get_db_session -- every writer must show it.
    readers = [r for r in routes if get_db_reader in r[2]]
    writers = [r for r in routes if get_db_session in r[2]]
    assert readers, "no route takes get_db_reader -- the walker is blind"
    assert writers, "no route takes get_db_session -- the walker is blind"
    shallow = sorted(f"{m} {p}" for m, p, calls in writers if _transaction not in calls)
    assert not shallow, f"the walker does not descend below get_db_session: {shallow}"

    offenders = sorted(
        f"{method} {path}"
        for method, path, calls in routes
        if get_db_reader in calls and any(c in calls for c in _WRITE_SESSION)
    )
    assert offenders == [], (
        f"{len(offenders)} route(s) hold a reader connection while taking "
        f"the write session (BE-146): {offenders}"
    )


# ---------------------------------------------------------------------------
# Pool bookkeeping
# ---------------------------------------------------------------------------


class _PoolWatch:
    """Checkouts and the peak of concurrently checked-out connections."""

    def __init__(self) -> None:
        self.pool = get_engine().sync_engine.pool
        self.baseline = self.pool.checkedout()
        self.current = self.baseline
        self.peak = self.baseline
        self.checkouts = 0

    def on_checkout(self, *_args: Any) -> None:
        self.checkouts += 1
        self.current += 1
        self.peak = max(self.peak, self.current)

    def on_checkin(self, *_args: Any) -> None:
        self.current -= 1

    @property
    def held_after(self) -> int:
        """Connections still checked out beyond the starting point."""
        return self.pool.checkedout() - self.baseline

    @property
    def peak_extra(self) -> int:
        """Most connections held at once beyond the starting point."""
        return self.peak - self.baseline


@contextmanager
def _watch_pool() -> Iterator[_PoolWatch]:
    watch = _PoolWatch()
    event.listen(watch.pool, "checkout", watch.on_checkout)
    event.listen(watch.pool, "checkin", watch.on_checkin)
    try:
        yield watch
    finally:
        event.remove(watch.pool, "checkout", watch.on_checkout)
        event.remove(watch.pool, "checkin", watch.on_checkin)


def _request(token: str | None) -> Request:
    headers = [] if token is None else [(b"authorization", f"Bearer {token}".encode())]
    return Request({"type": "http", "method": "GET", "path": "/", "headers": headers})


async def _login(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    *,
    role: UserRole = UserRole.USER,
    profile_status: str | None = None,
    active: bool = True,
) -> tuple[UUID, str]:
    """A committed user (and profile, when a status is given) + its token."""
    auth = await login_user(client, telegram_id=telegram_id, first_name="BE146")
    user_id = UUID(auth["user"]["id"])
    user = await db_session.get(User, user_id)
    user.role = role
    user.is_active = active
    if profile_status is not None:
        db_session.add(
            MasterProfile(
                user_id=user_id,
                data={"account": {"status": profile_status}, "profile": {"bio": "b"}},
            )
        )
    await db_session.commit()
    return user_id, auth["session_token"]


def _assert_detached(obj: Any) -> None:
    state = inspect(obj)
    assert state.detached, f"{obj!r} is still attached to a session"


# ---------------------------------------------------------------------------
# 2. The mechanism: each dependency returns with the pool as it found it
# ---------------------------------------------------------------------------


async def test_current_user_returns_detached_and_gives_the_connection_back(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    user_id, token = await _login(client, db_session, STUDENT_TG)
    with _watch_pool() as pool:
        user = await get_current_user(_request(token))
    assert user.id == user_id
    assert user.role == UserRole.USER  # a loaded column, read with no session
    _assert_detached(user)
    assert pool.checkouts >= 1, "the user was not loaded from the database"
    assert pool.held_after == 0


async def test_optional_user_returns_detached_and_gives_the_connection_back(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    user_id, token = await _login(client, db_session, STUDENT_TG)
    with _watch_pool() as pool:
        user = await get_optional_user(_request(token))
    assert user is not None and user.id == user_id
    _assert_detached(user)
    assert pool.checkouts >= 1
    assert pool.held_after == 0


async def test_admin_returns_detached_and_gives_the_connection_back(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    _, token = await _login(client, db_session, ADMIN_TG, role=UserRole.ADMIN)
    with _watch_pool() as pool:
        admin = await get_current_admin(await get_current_user(_request(token)))
    assert admin.role == UserRole.ADMIN
    _assert_detached(admin)
    assert pool.held_after == 0


async def test_master_returns_both_detached_and_gives_the_connections_back(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    user_id, token = await _login(
        client, db_session, MASTER_TG, role=UserRole.MASTER, profile_status="verified",
    )
    with _watch_pool() as pool:
        # The same chain FastAPI resolves: get_current_user, then the master
        # check on its result (cached per request -- loaded once, ПОВТОР).
        caller = await get_current_user(_request(token))
        user, profile = await get_current_master(caller)
    assert user.id == user_id and profile.user_id == user_id
    assert profile.data["account"]["status"] == "verified"
    _assert_detached(user)
    _assert_detached(profile)
    assert pool.checkouts >= 2, "user and profile were not both loaded"
    assert pool.peak_extra == 1, "two connections were held at once"
    assert pool.held_after == 0


# -- Refusals ---------------------------------------------------------------
#
# Decided before the database (no header, unknown token): no connection is
# taken at all. Decided after the load (deleted, deactivated, wrong role,
# no or unverified profile): the connection is back before the raise
# reaches the caller.


@pytest.mark.parametrize("token", [None, "", "no-such-session-token"])
async def test_refusal_before_the_database_takes_no_connection(
    token: str | None,
) -> None:
    with _watch_pool() as pool:
        with pytest.raises(UnauthorizedError):
            await get_current_user(_request(token))
        assert await get_optional_user(_request(token)) is None
    assert pool.checkouts == 0


async def test_deleted_user_refused_with_the_connection_back(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    _, token = await _login(client, db_session, STUDENT_TG)
    await full_cleanup_range(db_session, STUDENT_TG, STUDENT_TG, delete_users=True)
    await db_session.commit()
    with _watch_pool() as pool:
        with pytest.raises(UnauthorizedError):
            await get_current_user(_request(token))
        assert await get_optional_user(_request(token)) is None
    assert pool.checkouts >= 2
    assert pool.held_after == 0


async def test_inactive_user_refused_with_the_connection_back(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    _, token = await _login(client, db_session, INACTIVE_TG, active=False)
    with _watch_pool() as pool:
        with pytest.raises(ForbiddenError):
            await get_current_user(_request(token))
        assert await get_optional_user(_request(token)) is None
    assert pool.checkouts >= 2
    assert pool.held_after == 0


@pytest.mark.parametrize(
    ("telegram_id", "role", "profile_status", "code"),
    [
        (STUDENT_TG, UserRole.USER, None, None),
        (BARE_MASTER_TG, UserRole.MASTER, None, "master_profile_not_found"),
        (PENDING_MASTER_TG, UserRole.MASTER, "pending", "master_profile_not_verified"),
    ],
)
async def test_master_refusals_give_the_connection_back(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    role: UserRole,
    profile_status: str | None,
    code: str | None,
) -> None:
    _, token = await _login(
        client, db_session, telegram_id, role=role, profile_status=profile_status,
    )
    with _watch_pool() as pool:
        user = await get_current_user(_request(token))
        with pytest.raises(ForbiddenError) as refused:
            await get_current_master(user)
    if code is not None:
        assert refused.value.code == code
    assert pool.held_after == 0


# ---------------------------------------------------------------------------
# 3. The effect: a class endpoint holds one connection at a time
# ---------------------------------------------------------------------------
#
# One endpoint per auth dependency that put routes into the class: a
# student write over get_current_user, a master write over
# get_current_master. Before the fix each held two connections at its peak.


async def _peak_during(call: Callable[[], Any]) -> tuple[int, Any]:
    with _watch_pool() as pool:
        response = await call()
    assert pool.held_after == 0
    return pool.peak_extra, response


async def test_student_write_holds_one_connection_at_a_time(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    _, token = await _login(client, db_session, STUDENT_TG)
    peak, response = await _peak_during(
        lambda: client.post(
            "/api/v1/diary", json={"content": "BE-146"}, headers=auth_headers(token),
        )
    )
    assert response.status_code == 201, response.text
    assert peak == 1


async def test_master_write_holds_one_connection_at_a_time(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    _, token = await _login(
        client, db_session, MASTER_TG, role=UserRole.MASTER, profile_status="verified",
    )
    peak, response = await _peak_during(
        lambda: client.patch(
            "/api/v1/masters/me/languages",
            json={"languages": ["ru"]},
            headers=auth_headers(token),
        )
    )
    assert response.status_code == 200, response.text
    assert peak == 1
