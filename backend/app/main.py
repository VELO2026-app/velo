# =============================================================================
# VELO Backend -- Application Entry Point (updated Phase 9.1)
# =============================================================================
#
# ENDPOINTS:
#   GET /        -> API name + version
#   GET /health  -> DB + Redis connectivity check (always 200)
#   GET /ready   -> Readiness probe (503 if degraded)
#
# B-03: allow_headers now lists headers explicitly instead of ["*"].
#   Fetch spec forbids allow_headers=["*"] with allow_credentials=True.
# =============================================================================

import asyncio
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from starlette.requests import Request

from app.core.config import settings
from app.core.database import dispose_engine, get_engine
from app.core.exceptions import VeloError
from app.core.logging import setup_logging
from app.core.middleware import TraceIdMiddleware
from app.core.redis import close_redis, get_redis, init_redis
from app.modules.admin.router import router as admin_router
from app.modules.auth.router import router as auth_router
from app.modules.masters.router import router as masters_router
from app.modules.masters.finance_router import (                  # E2
    router as masters_finance_router,
)
from app.modules.masters.students_router import (                 # E5
    router as masters_students_router,
)
from app.modules.masters.groups_router import (                   # P1
    router as masters_groups_router,
)
from app.modules.masters.reviews_router import (                  # #3
    router as masters_reviews_router,
)
from app.modules.masters.stats_router import (                    # E7
    router as masters_stats_router,
)
from app.modules.users.router import router as users_router
from app.modules.reports.router import router as reports_router
from app.modules.practices.router import router as practices_router
from app.modules.practices.taxonomy_router import router as taxonomy_router  # R5 stage 3a
from app.modules.bookings.router import (
    practices_attendance_router,  # Phase 5.4
    router as bookings_router,
)
from app.modules.waitlist.router import (  # Phase 5.3
    practices_waitlist_router,
    waitlist_router,
)
from app.modules.payments.router import router as payments_router  # Phase 6.3
from app.modules.payments.webhook_router import webhook_router     # Phase 6.3
from app.modules.payments.purchase_router import (                 # Phase 6.4
    router as purchase_router,
    purchases_user_router,                                         # Frontend Backlog
)
from app.modules.withdrawals.router import (                       # Phase 6.6
    router as withdrawals_router,
)
from app.modules.promos.router import router as promos_router      # Phase 6.7
from app.modules.diary.router import (                             # Phase 8.1-8.4
    practices_checkin_router,
    checkins_router,
    practices_feedback_router,
    feedbacks_router,
    diary_router,
    diary_feed_router,                                             # Diary redesign
    practices_insights_router,
)
from app.modules.ai.router import router as ai_router              # Phase 9.1

# Model imports for Alembic and relationship resolution.
from app.modules.promos.models import Promo  # noqa: F401  # Phase 6.7
from app.modules.notifications.models import Notification, NotificationDelivery  # noqa: F401  # Phase 7.1
from app.modules.diary.models import (  # noqa: F401  # Phase 8.1-8.4 + redesign
    Checkin,
    Feedback,
    DiaryEntry,
    DiaryEvent,
)
from app.modules.zoom.models import (  # noqa: F401  # E21
    ZoomMeeting,
    ZoomRegistrant,
    ZoomAttendanceSegment,
)
# Library module has no active models yet (Phase 9.2 stub).

# Notification processor (Phase 7.2).
from app.modules.notifications.processor import run_processor  # Phase 7.2

# Practice auto-finalizer (Batch 1).
from app.modules.bookings.autofinalize import run_autofinalizer  # Batch 1

# Zoom meeting-creation retry poller (E21 step D).
from app.modules.zoom.retry_poller import run_zoom_retry_poller  # E21

# Zoom report poller -- the attendance decision (E21 step F).
from app.modules.zoom.report_poller import run_zoom_report_poller  # E21

# Notification templates (Phase 7.3).
from app.modules.notifications.template_engine import load_templates  # Phase 7.3


logger = structlog.get_logger()


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Manage application lifecycle: startup and shutdown."""
    setup_logging(
        log_level=settings.log_level,
        json_logs=settings.app_env == "production",
    )

    # W6 fix: WARNING-5 (core/config.py) documents this guard as living here
    # because config.py is imported by Alembic before app startup -- it was
    # never actually added. Without it, STRIPE_SECRET_KEY="TEST" left over in
    # a production .env silently free-credits every topup (stub mode skips
    # Stripe and instantly succeeds) with no warning anywhere.
    #
    # W6 hotfix: the first version of this guard used
    # `app_env != "development"`, which took down TEST -- the TEST server's
    # own .env sets APP_ENV=production, so the env name can't distinguish
    # TEST (where the stub is intentional) from real prod. The gate is now
    # the explicit ALLOW_STRIPE_STUB flag (settings.is_stripe_stub_blocked
    # -- see core/config.py, three conditions: not dev, is_stripe_stub, NOT
    # allow_stripe_stub), set on TEST only.
    #
    # ПРОМТ №509 (owner-measured, 2026-07-17): prod is NOT currently running
    # a real Stripe key -- it has STRIPE_SECRET_KEY=TEST and no
    # ALLOW_STRIPE_STUB set, i.e. it is in exactly the state this guard
    # exists to refuse. It only still runs because the currently-deployed
    # prod build predates this guard; the next prod release with this code
    # WILL raise the RuntimeError below and refuse to start unless prod's
    # env is fixed first (real key, or an explicit ALLOW_STRIPE_STUB=true if
    # the stub is genuinely intended there). Do not release this to prod
    # without checking that first.
    if settings.is_stripe_stub_blocked:
        raise RuntimeError(
            "STRIPE_SECRET_KEY='TEST' (stub mode) is not allowed here -- "
            "set a real Stripe secret key, or set ALLOW_STRIPE_STUB=true "
            "if this is genuinely a test server."
        )

    processor_task: asyncio.Task | None = None
    autofinalizer_task: asyncio.Task | None = None
    zoom_retry_task: asyncio.Task | None = None
    zoom_report_task: asyncio.Task | None = None
    try:
        await init_redis()

        # Phase 7.3: Load notification templates from YAML files.
        template_count = load_templates()
        logger.info("notification_templates_loaded", count=template_count)

        # Start notification processor as background task (Phase 7.2).
        # Gated by settings so tests can disable it -- the background loop
        # otherwise races the manual _stage_* calls in test_notifications.py
        # via FOR UPDATE SKIP LOCKED, causing flaky delivery skips.
        if settings.notification_processor_enabled:
            processor_task = asyncio.create_task(
                run_processor(), name="notification_processor",
            )
        else:
            logger.info("notification_processor_disabled")

        # Start practice auto-finalizer as background task (Batch 1).
        # Gated by settings for the same reason as the processor above:
        # tests disable it so the background loop doesn't finalize a test
        # practice out from under an assertion via FOR UPDATE SKIP LOCKED.
        if settings.practice_autofinalize_enabled:
            autofinalizer_task = asyncio.create_task(
                run_autofinalizer(), name="practice_autofinalizer",
            )
        else:
            logger.info("practice_autofinalizer_disabled")

        # Start Zoom meeting-creation retry poller as background task (E21).
        # Gated by settings for the same reason as the two workers above:
        # tests disable it so the loop can't race manual test calls via
        # FOR UPDATE SKIP LOCKED.
        if settings.zoom_retry_enabled:
            zoom_retry_task = asyncio.create_task(
                run_zoom_retry_poller(), name="zoom_retry_poller",
            )
        else:
            logger.info("zoom_retry_poller_disabled")

        # Start Zoom report poller -- the attendance decision (E21 step F).
        # Gated for the same reason as every worker above: tests disable it
        # so the loop can't race manual test calls via FOR UPDATE SKIP LOCKED.
        if settings.zoom_report_enabled:
            zoom_report_task = asyncio.create_task(
                run_zoom_report_poller(), name="zoom_report_poller",
            )
        else:
            logger.info("zoom_report_poller_disabled")

        logger.info(
            "app_started",
            env=settings.app_env,
            log_level=settings.log_level,
        )
        yield
    finally:
        # Stop notification processor.
        if processor_task is not None and not processor_task.done():
            processor_task.cancel()
            try:
                await processor_task
            except asyncio.CancelledError:
                pass

        # Stop practice auto-finalizer (Batch 1).
        if autofinalizer_task is not None and not autofinalizer_task.done():
            autofinalizer_task.cancel()
            try:
                await autofinalizer_task
            except asyncio.CancelledError:
                pass

        # Stop Zoom retry poller (E21).
        if zoom_retry_task is not None and not zoom_retry_task.done():
            zoom_retry_task.cancel()
            try:
                await zoom_retry_task
            except asyncio.CancelledError:
                pass

        # Stop Zoom report poller (E21 step F).
        if zoom_report_task is not None and not zoom_report_task.done():
            zoom_report_task.cancel()
            try:
                await zoom_report_task
            except asyncio.CancelledError:
                pass

        await close_redis()
        await dispose_engine()
        logger.info("app_stopped")


# ---------------------------------------------------------------------------
# FastAPI Application
# ---------------------------------------------------------------------------
app = FastAPI(
    title="VELO API",
    description="Platform for wellness practice facilitators",
    version="0.1.0",
    lifespan=lifespan,
)

app.include_router(auth_router)
app.include_router(users_router)
app.include_router(masters_router)
app.include_router(masters_finance_router)        # E2
app.include_router(masters_students_router)       # E5
app.include_router(masters_groups_router)         # P1
app.include_router(masters_reviews_router)        # #3
app.include_router(masters_stats_router)          # E7
app.include_router(admin_router)
app.include_router(reports_router)
app.include_router(practices_router)
app.include_router(taxonomy_router)               # R5 stage 3a
app.include_router(bookings_router)
app.include_router(practices_waitlist_router)    # Phase 5.3
app.include_router(waitlist_router)               # Phase 5.3
app.include_router(practices_attendance_router)   # Phase 5.4
app.include_router(payments_router)               # Phase 6.3
app.include_router(webhook_router)                # Phase 6.3
app.include_router(purchase_router)               # Phase 6.4
app.include_router(purchases_user_router)         # Frontend Backlog
app.include_router(withdrawals_router)            # Phase 6.6
app.include_router(promos_router)                 # Phase 6.7
app.include_router(practices_checkin_router)      # Phase 8.1
app.include_router(checkins_router)               # Phase 8.1
app.include_router(practices_feedback_router)     # Phase 8.2
app.include_router(feedbacks_router)              # Phase 8.2
# Diary redesign: feed router MUST be included before diary_router so the
# static "/api/v1/diary/feed" path is matched ahead of diary_router's
# dynamic "/api/v1/diary/{entry_id}" (FastAPI matches in include order).
app.include_router(diary_feed_router)             # Diary redesign
app.include_router(diary_router)                  # Phase 8.3
app.include_router(practices_insights_router)     # Phase 8.4
app.include_router(ai_router)                     # Phase 9.1


# ---------------------------------------------------------------------------
# Exception Handlers (TD-007)
# ---------------------------------------------------------------------------
@app.exception_handler(VeloError)
async def velo_error_handler(request: Request, exc: VeloError) -> JSONResponse:
    """Convert VeloError exceptions into proper HTTP responses."""
    if exc.status_code >= 500:
        logger.error(
            "unhandled_velo_error",
            status_code=exc.status_code,
            code=exc.code,
            message=exc.message,
            path=request.url.path,
            exc_info=exc,
        )
    else:
        logger.warning(
            "velo_error",
            status_code=exc.status_code,
            code=exc.code,
            message=exc.message,
            path=request.url.path,
        )

    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.code, "message": exc.message},
    )


# L-06: global handler for unexpected (non-VeloError) exceptions.
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Catch-all for unexpected exceptions -- return generic 500 JSON."""
    logger.error(
        "unhandled_exception",
        exc_type=type(exc).__name__,
        exc_message=str(exc),
        path=request.url.path,
        method=request.method,
        exc_info=exc,
    )
    return JSONResponse(
        status_code=500,
        content={"error": "internal_error", "message": "Internal server error"},
    )


# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------
_cors_origins = [o.strip() for o in settings.cors_origins.split(",")]
_allow_all = _cors_origins == ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=not _allow_all,
    allow_methods=["*"],
    # B-03: Fetch spec forbids allow_headers=["*"] with allow_credentials=True.
    # List headers explicitly. X-Trace-ID is our custom tracing header.
    allow_headers=["Authorization", "Content-Type", "X-Trace-ID"],
)

# ---------------------------------------------------------------------------
# Trace ID (Pre-6.1)
# ---------------------------------------------------------------------------
# Added AFTER CORSMiddleware so Starlette applies it as the outermost
# layer (LIFO order).
app.add_middleware(TraceIdMiddleware)


# ---------------------------------------------------------------------------
# Root & Health Endpoints
# ---------------------------------------------------------------------------
@app.get("/")
async def root() -> dict:
    """Root endpoint -- API info."""
    return {"name": "VELO API", "version": "0.1.0"}


@app.get("/health")
async def health() -> dict:
    """Health check -- DB and Redis connectivity."""
    result = {"status": "ok", "db": "ok", "redis": "ok"}

    # Check DB.
    try:
        engine = get_engine()
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception:
        result["db"] = "error"
        result["status"] = "degraded"

    # Check Redis.
    try:
        redis = get_redis()
        await asyncio.wait_for(redis.ping(), timeout=2.0)
    except Exception:
        result["redis"] = "error"
        result["status"] = "degraded"

    return result


@app.get("/ready")
async def readiness() -> JSONResponse:
    """Readiness probe -- returns 503 if degraded (TD-003)."""
    check = await health()
    if check["status"] != "ok":
        return JSONResponse(status_code=503, content=check)
    return JSONResponse(status_code=200, content=check)
