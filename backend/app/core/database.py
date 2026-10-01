# =============================================================================
# VELO Backend — Database Connection
# =============================================================================
#
# LAZY ENGINE:
#   Engine is NOT created at import time. It's created on first call to
#   get_engine(). This prevents "Future attached to a different loop"
#   errors in pytest, where the event loop is created after module imports.
#
# LAZY SESSION FACTORY:
#   Session factory is cached alongside the engine (L-02).
#   Reset together in dispose_engine().
#
# DEPENDENCY INJECTION:
#   get_db_session()  — read-write: commits on success, rollback on error.
#                       The commit runs when the endpoint returns, BEFORE the
#                       response is sent (BE-83); see its docstring.
#   get_db_reader()   — read-only: always rolls back (TD-008).
# =============================================================================

from collections.abc import AsyncGenerator

from fastapi import Depends
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings


class Base(DeclarativeBase):
    """Base class for all SQLAlchemy ORM models."""


# ---------------------------------------------------------------------------
# Lazy engine + session factory — created on first access, not at import time
# ---------------------------------------------------------------------------
# Fix 2.6: global mutable state is safe here because:
#   - asyncio runs on a single event loop (single thread) -- no data race.
#   - Engine is created once at startup (lifespan) before any concurrent
#     requests arrive, so the None→engine transition is never concurrent.
#   - Uvicorn workers are separate processes, each with their own engine
#     instance (no shared memory between processes).
#   - asyncio.to_thread (used for Stripe calls) runs in a thread pool but
#     never touches _engine/_session_factory directly.
_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    """Get or create the async engine (singleton)."""
    global _engine
    if _engine is None:
        _engine = create_async_engine(
            settings.database_url,
            echo=False,
            pool_size=10,
            max_overflow=20,
            pool_pre_ping=True,
            pool_recycle=1800,
        )
    return _engine


async def dispose_engine() -> None:
    """Dispose the engine and reset singletons. Used in shutdown/tests."""
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
        _engine = None
    # L-02: reset factory so it rebinds to the new engine on next call.
    _session_factory = None


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    """Get or create a session factory bound to the current engine (singleton).

    L-02 fix: cached to avoid recreating async_sessionmaker on every
    request. Reset in dispose_engine() alongside the engine.
    """
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(
            bind=get_engine(),
            class_=AsyncSession,
            expire_on_commit=False,
        )
    return _session_factory


async def _transaction() -> AsyncGenerator[AsyncSession, None]:
    """The request's write transaction: commit on success, rollback on error.

    Consumed only through get_db_session, which declares it with
    scope="function" -- never Depends() on this directly: a second
    declaration with another scope is another cache key, i.e. a second
    session and a second transaction in the same request.
    """
    factory = get_session_factory()
    session = factory()
    try:
        yield session
        await session.commit()
    except Exception:
        await session.rollback()
        raise
    finally:
        await session.close()


async def get_db_session(
    session: AsyncSession = Depends(_transaction, scope="function"),
) -> AsyncSession:
    """Transactional session for write operations (auto-commit/rollback).

    WHEN THE COMMIT RUNS (BE-83): when the endpoint returns -- after the
    response object is built and serialized, BEFORE its first byte is sent.
    A failed commit therefore reaches the client as an error response, not
    as a 200 whose writes were rolled back. A request-scoped yield
    dependency (FastAPI's default for yield) would commit only after the
    response was sent, which is why the transaction sits behind the
    scope="function" edge above and this wrapper is a plain coroutine.

    One place: every Depends(get_db_session) in the tree resolves to the
    same cache key, so a request has one session however many endpoint
    parameters and sub-dependencies ask for it.

    Rollback on exception (P-01): an exception raised by the endpoint
    passes through _transaction, which rolls back before any exception
    handler builds the error response.

    Contract for dependencies built on top of this session: the session is
    committed and closed when the endpoint returns. A yield dependency that
    takes it must not use it after its own yield -- by then the session is
    closed, and anything written there is never committed. The same holds
    for BackgroundTasks and for a streaming response body: both run after
    the endpoint returns.
    """
    return session


async def get_db_reader() -> AsyncGenerator[AsyncSession, None]:
    """Read-only session — always rolls back (TD-008)."""
    factory = get_session_factory()
    session = factory()
    try:
        yield session
    finally:
        await session.rollback()
        await session.close()
