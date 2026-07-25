# =============================================================================
# VELO Backend — Test Fixtures
# =============================================================================
#
# Solves three problems that broke tests before:
#   1. Event loop — single loop for all tests (no "Future attached to different loop")
#   2. Lifespan — init_redis() and engine are ready before tests run
#   3. Migrations — tables exist before tests run (alembic upgrade head)
#
# 7.1 fix: db_session rolls back before closing.
#   If a test crashes mid-operation and leaves uncommitted state in the
#   session (e.g. flushed but not committed), the rollback ensures that
#   state is discarded and does not bleed into the next test.
#   Tests that need data to persist use explicit session.commit() calls,
#   which are unaffected by the rollback (only uncommitted state is cleared).
#
# WARNING-4 / CRITICAL-4 fix: flush_auth_redis_keys runs before every test.
#   check_init_data_replay() writes init_data_used:{hash} with TTL=300s.
#   check_auth_rate_limit() writes auth_rate:{telegram_id} with TTL=60s.
#   Tests that call login_user() share telegram_ids and would collide:
#   the second login within the TTL window gets 400 "already used".
#   Deleting those key prefixes before each test prevents the cascade.
# =============================================================================

import subprocess
from collections.abc import AsyncGenerator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import dispose_engine, get_session_factory
from app.core.redis import close_redis, get_redis, init_redis
from app.main import app


@pytest.fixture(scope="session", autouse=True)
async def setup_infrastructure():
    """Initialize Redis, run migrations, and clean up after all tests.

    Runs ONCE before any test. Alembic is called as subprocess because
    its env.py uses asyncio.run() which can't nest inside pytest's loop.
    """
    # Disable the background workers for the entire suite.
    # The app lifespan (started lazily by the ASGI client on first request,
    # which is always after this session-scoped fixture) reads these flags and
    # skips create_task(run_processor) / create_task(run_autofinalizer). Tests
    # drive the notification stages (_stage_resolve/_stage_deliver/_stage_rollup)
    # and auto_start_practice / auto_finalize_practice manually; a live background
    # loop would race them via FOR UPDATE SKIP LOCKED and cause flaky results
    # (e.g. a notification stuck at processing, or a test practice finalized out
    # from under an assertion).
    settings.notification_processor_enabled = False
    settings.practice_autofinalize_enabled = False
    settings.zoom_retry_enabled = False
    settings.zoom_report_enabled = False
    # ПРОМТ №543: pin Zoom to stub mode for the whole suite. Until now every
    # test server happened to have no real Zoom credentials, so
    # settings.is_zoom_stub was True by ambient accident -- several tests
    # asserted on that accident instead of pinning it (see the four tests
    # named in the ПРОМТ №543 postmortem). The day the deploy container
    # gained real credentials (owner connected them), is_zoom_stub flipped
    # to False mid-suite and those tests took the opposite branch. Setting
    # the secret to the "TEST" sentinel is_zoom_stub already checks for
    # mirrors the existing is_stripe_stub convention (config.py) and reads
    # honestly: this is a deliberate stub marker, not a blanked-out real
    # value that could be misread as "never configured". A test that
    # explicitly wants non-stub Zoom (e.g.
    # test_zoom_attendance_decision.py's
    # test_zoom_tracked_practice_defers_instead_of_deciding_immediately)
    # monkeypatches all three credential fields itself and is unaffected --
    # monkeypatch snapshots and restores whatever was here before it ran.
    settings.zoom_client_secret = "TEST"

    # Run Alembic migrations (ensures tables exist).
    result = subprocess.run(
        ["python", "-m", "alembic", "upgrade", "head"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Alembic migration failed:\n{result.stderr}\n{result.stdout}"
        )

    # Initialize Redis client.
    await init_redis()

    yield

    # Cleanup.
    await close_redis()
    await dispose_engine()


@pytest.fixture(scope="session", autouse=True)
def _stub_notification_formatter():
    """Force StubFormatter for all notification deliveries in the test suite.

    After backend/.env got a real @veloappbot token (handoff §6 migration,
    2026-05-27), the lazy-initialised TelegramFormatter in
    app/modules/notifications/formatters.py started instantiating an aiogram
    Bot in tests. Tests then created users with fake telegram_ids (e.g. 83050)
    and called _stage_deliver()/_stage_rollup() — the formatter sent real HTTP
    requests to Telegram, which replied "Bad Request: chat not found", and
    notification tests went red.

    This fixture pre-populates the module-level singletons so
    get_formatter('telegram') short-circuits to the existing StubFormatter
    without ever calling _init_telegram_formatter() — no real Bot, no HTTP,
    fully deterministic.

    Tests that intentionally patch get_formatter (e.g. via mock.patch in
    TestStageDeliver.test_failed_delivery_retries) still work — they patch
    'app.modules.notifications.processor.get_formatter' at the call site.
    """
    from app.modules.notifications import formatters
    formatters._telegram_formatter = formatters._stub
    formatters._telegram_init_attempted = True
    yield
    formatters._telegram_formatter = None
    formatters._telegram_init_attempted = False


@pytest.fixture(autouse=True)
async def flush_auth_redis_keys() -> AsyncGenerator[None, None]:
    """Delete anti-replay and rate-limit Redis keys before each test.

    WARNING-4: check_init_data_replay() stores init_data_used:{hash} TTL=300s.
    CRITICAL-4: check_auth_rate_limit() stores auth_rate:{id} TTL=60s.

    Tests that call login_user() with the same telegram_id would get
    400 "already used" on the second call within the TTL window.
    Deleting these keys before each test eliminates the collision.
    """
    redis = get_redis()
    for pattern in ("init_data_used:*", "auth_rate:*"):
        keys = await redis.keys(pattern)
        if keys:
            await redis.delete(*keys)
    yield


@pytest.fixture
async def client() -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client — requests go directly to FastAPI in memory."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture
async def db_session() -> AsyncGenerator[AsyncSession, None]:
    """Direct database session for test setup/assertions.

    7.1 fix: rolls back before closing to discard any uncommitted state
    left behind by a failing test. Prevents state from bleeding into
    subsequent tests that share the same DB connection pool.

    Tests that need data to persist must call session.commit() explicitly —
    those commits are permanent and unaffected by this rollback.
    """
    factory = get_session_factory()
    session = factory()
    try:
        yield session
    finally:
        await session.rollback()  # discard any uncommitted state (7.1)
        await session.close()
