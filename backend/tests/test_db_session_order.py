# =============================================================================
# VELO -- Tests: get_db_session commits BEFORE the response is sent (BE-83)
# =============================================================================
#
# THE HARNESS IS THE POINT. The suite's `client` fixture (httpx
# ASGITransport) builds its Response only after the ASGI app has returned,
# i.e. after every dependency teardown -- under it a commit that runs after
# the response is sent is indistinguishable from one that runs before, and a
# failed commit arrives in the test as a raised exception rather than as the
# 200 a real client would have received. So these tests call the ASGI app
# directly and record each `send` message next to each commit: the order of
# `http.response.start` against the commit is the order on the wire (uvicorn
# writes to the socket on every send; BE-83 step 1 measured that under real
# uvicorn over TCP).
#
# The app under test is a small FastAPI app of its own with the REAL
# get_db_session and real sessions on the suite's database: the property
# lives in the dependency and FastAPI's teardown, not in the product's
# routes or middleware. Rows are audit_logs rows (no FK, no telegram_id),
# marked by event and a per-test target_id, and deleted after each test.
#
# AXES: repeat -- two requests in a row commit independently; emptiness --
# a read-only endpoint is unchanged; shortage -- a failed commit reaches the
# client as a 500, never as a 200.
# =============================================================================

from collections.abc import AsyncGenerator
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import Depends, FastAPI, HTTPException, Request
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import AuditLog
from app.core.database import get_db_session

EVENT = "be83_db_session_order"


@pytest.fixture
def events(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Record every AsyncSession.commit next to the ASGI send messages.

    A session whose info carries "fail_commit" raises instead of committing
    -- the stand-in for a commit the database refuses.
    """
    log: list[str] = []
    real_commit = AsyncSession.commit

    async def recording_commit(self: AsyncSession) -> None:
        log.append(f"commit:{id(self)}")
        if self.info.get("fail_commit"):
            raise RuntimeError("BE-83 test: the commit is refused")
        await real_commit(self)

    monkeypatch.setattr(AsyncSession, "commit", recording_commit)
    return log


@pytest.fixture
async def target(db_session: AsyncSession) -> AsyncGenerator[UUID, None]:
    """A per-test target_id; this test's rows are removed afterwards."""
    target_id = uuid4()
    yield target_id
    await db_session.execute(delete(AuditLog).where(AuditLog.target_id == target_id))
    await db_session.commit()


def _row(target_id: UUID, label: str) -> AuditLog:
    return AuditLog(
        event=EVENT, actor_type="system", target_type=label, target_id=target_id
    )


async def _labels(db_session: AsyncSession, target_id: UUID) -> list[str]:
    rows = await db_session.execute(
        select(AuditLog.target_type).where(AuditLog.target_id == target_id)
    )
    return sorted(rows.scalars())


async def _nested(session: AsyncSession = Depends(get_db_session)) -> AsyncSession:
    """A sub-dependency on the session, the shape of get_current_user_write."""
    return session


def _app(events: list[str]) -> FastAPI:
    app = FastAPI()
    # Every session /write receives, the OBJECT itself: holding it here keeps
    # it alive for as long as the app -- i.e. the whole test -- so two of them
    # can be told apart by identity. See
    # test_two_requests_in_a_row_commit_independently for why id() could not.
    app.state.sessions = []

    @app.post("/write")
    async def write(
        request: Request, session: AsyncSession = Depends(get_db_session)
    ) -> dict[str, Any]:
        target_id = UUID(request.query_params["t"])
        session.add(_row(target_id, request.query_params.get("label", "write")))
        await session.flush()
        app.state.sessions.append(session)
        if request.query_params.get("fail") == "1":
            session.info["fail_commit"] = True
        if request.query_params.get("raise") == "1":
            raise HTTPException(status_code=409, detail="refused after the write")
        return {"ok": True}

    @app.get("/read")
    async def read(
        request: Request, session: AsyncSession = Depends(get_db_session)
    ) -> dict[str, Any]:
        target_id = UUID(request.query_params["t"])
        n = await session.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.target_id == target_id)
        )
        return {"rows": n}

    @app.post("/two")
    async def two(
        request: Request,
        direct: AsyncSession = Depends(get_db_session),
        nested: AsyncSession = Depends(_nested),
    ) -> dict[str, Any]:
        events.append(f"same:{direct is nested}")
        direct.add(_row(UUID(request.query_params["t"]), "two"))
        return {"ok": True}

    return app


async def _call(
    app: FastAPI, events: list[str], method: str, path: str, query: str
) -> list[int]:
    """Run one request through the raw ASGI interface.

    Returns the status of every http.response.start (normally exactly one)
    and appends "start:<status>" to `events` at the moment it is sent. An
    exception the app re-raises after its error response (Starlette's
    ServerErrorMiddleware does that) is recorded, not propagated.
    """
    statuses: list[int] = []

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        if message["type"] == "http.response.start":
            statuses.append(message["status"])
            events.append(f"start:{message['status']}")

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": query.encode(),
        "headers": [(b"host", b"test")],
        "client": ("127.0.0.1", 1),
        "server": ("test", 80),
        "root_path": "",
    }
    try:
        await app(scope, receive, send)
    except Exception as exc:
        events.append(f"raised:{type(exc).__name__}")
    return statuses


def _commits(events: list[str]) -> list[str]:
    return [e for e in events if e.startswith("commit:")]


async def test_the_commit_runs_before_the_first_byte(
    events: list[str], target: UUID, db_session: AsyncSession
) -> None:
    """THE CARD: the commit precedes http.response.start. Pair: there is
    exactly one start, it is a 200, and the row is committed."""
    statuses = await _call(_app(events), events, "POST", "/write", f"t={target}")

    assert statuses == [200]
    assert len(_commits(events)) == 1
    assert events.index(_commits(events)[0]) < events.index("start:200")
    assert await _labels(db_session, target) == ["write"]


async def test_a_failed_commit_reaches_the_client_as_a_500_not_a_200(
    events: list[str], target: UUID, db_session: AsyncSession
) -> None:
    """SHORTAGE: the commit is refused -> the client's only status is 500
    and nothing was written. Before BE-83 the client had a complete 200
    while the commit failed after it. Pair: the commit was attempted."""
    statuses = await _call(_app(events), events, "POST", "/write", f"t={target}&fail=1")

    assert statuses == [500]
    assert "start:200" not in events
    assert len(_commits(events)) == 1
    assert await _labels(db_session, target) == []


async def test_an_exception_after_the_first_mutation_rolls_it_back(
    events: list[str], target: UUID, db_session: AsyncSession
) -> None:
    """P-01 on the HTTP level: a row is written and flushed, then the
    endpoint refuses -> 409 and the row is gone; nothing was committed.
    Pair: the same endpoint without the refusal keeps its row."""
    app = _app(events)

    refused = await _call(
        app, events, "POST", "/write", f"t={target}&label=refused&raise=1"
    )
    kept = await _call(app, events, "POST", "/write", f"t={target}&label=kept")

    assert refused == [409]
    assert kept == [200]
    assert await _labels(db_session, target) == ["kept"]


async def test_two_requests_in_a_row_commit_independently(
    events: list[str], target: UUID, db_session: AsyncSession
) -> None:
    """REPEAT: two requests -> two sessions, two commits, two rows.

    The sessions used to be told apart by the string "session:<id()>". That
    was right in intent -- two requests must not share one session -- and
    it held on most runs, but id() is an address that is unique only among
    objects alive AT THE SAME TIME, and the first request's session is
    already gone when the second begins (checked with a weak reference). The
    allocator may then hand the second session the same address: on the
    stand the two ids came out equal once in two runs on the same head,
    with no code change between them. The test's colour was the
    allocator's, not get_db_session's.

    Now both session objects are held by the app until the test ends and
    compared by identity. While both are alive their addresses cannot
    coincide, so `is not` says exactly "two distinct sessions" and nothing
    about memory reuse."""
    app = _app(events)

    first = await _call(app, events, "POST", "/write", f"t={target}&label=a")
    second = await _call(app, events, "POST", "/write", f"t={target}&label=b")

    assert first == second == [200]
    sessions = app.state.sessions
    assert len(sessions) == 2
    assert sessions[0] is not sessions[1]
    assert len(_commits(events)) == 2
    assert await _labels(db_session, target) == ["a", "b"]


async def test_a_read_only_endpoint_is_unchanged(
    events: list[str], target: UUID, db_session: AsyncSession
) -> None:
    """EMPTINESS: an endpoint that only reads -> 200, its (empty) commit
    still precedes the response, and nothing is written."""
    db_session.add(_row(target, "seed"))
    await db_session.commit()
    events.clear()  # the seed's own commit is not the request's

    statuses = await _call(_app(events), events, "GET", "/read", f"t={target}")

    assert statuses == [200]
    assert len(_commits(events)) == 1
    assert events.index(_commits(events)[0]) < events.index("start:200")
    assert await _labels(db_session, target) == ["seed"]


async def test_every_declaration_in_a_request_shares_one_session(
    events: list[str], target: UUID, db_session: AsyncSession
) -> None:
    """One cache key: a direct Depends(get_db_session) and one reached
    through a sub-dependency are the same session, committed once."""
    statuses = await _call(_app(events), events, "POST", "/two", f"t={target}")

    assert statuses == [200]
    assert "same:True" in events
    assert len(_commits(events)) == 1
    assert await _labels(db_session, target) == ["two"]
