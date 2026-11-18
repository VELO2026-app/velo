# =============================================================================
# VELO Backend -- Application Entry Point (updated Phase 9.1)
# =============================================================================
#
# ENDPOINTS:
#   GET /        -> API name + version
#   GET /health  -> protocol 9.1, always 200 (core/report.py)
#   GET /ready   -> protocol 9.2, 503 when a check fails
#
# B-03: allow_headers now lists headers explicitly instead of ["*"].
#   Fetch spec forbids allow_headers=["*"] with allow_credentials=True.
# =============================================================================

import asyncio
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, suppress

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.requests import Request

from app.core.config import settings
from app.core.database import dispose_engine
from app.core.exceptions import VeloError
from app.core.logging import setup_logging
from app.core.middleware import REQUEST_ID_HEADER, RequestContextMiddleware
from app.core.report import Report
from app.core.redis import close_redis, init_redis
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
from app.modules.schools.router import (                   # Curator P1
    member_router as schools_member_router,
    router as schools_router,
)
from app.modules.masters.reviews_router import (                  # #3
    router as masters_reviews_router,
)
from app.modules.masters.stats_router import (                    # E7
    router as masters_stats_router,
)
from app.modules.users.router import router as users_router
from app.modules.reports.router import router as reports_router
from app.modules.practices.router import public_router as practices_public_router
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
from app.modules.ai.transcription_router import (                  # GT-41
    router as transcription_router,
)
from app.modules.chats.router import router as chats_router  # Phase 6 / T2
from app.modules.comms_proxy.router import router as notifications_router  # Phase 6 / T1
from app.modules.support.router import router as support_router  # B34 / T-38
from app.modules.mcp.router import router as mcp_tokens_router  # BE-138
from app.modules.mcp.server import MCP_PATH, build_mcp_app  # BE-139
from app.modules.mcp.oauth import OAUTH_PATHS, OAuthDoor  # BE-141

# Model imports for Alembic and relationship resolution.
from app.modules.promos.models import Promo  # noqa: F401  # Phase 6.7
from app.modules.diary.models import (  # noqa: F401  # Phase 8.1-8.4 + redesign
    Checkin,
    Feedback,
    DiaryEntry,
    DiaryEvent,
    Reflection,
)
from app.modules.zoom.models import (  # noqa: F401  # E21 + GT-21
    ZoomMeeting,
    ZoomRegistrant,
    ZoomAttendanceSegment,
    ZoomGuestName,
)
# Library module has no active models yet (Phase 9.2 stub).

# Comms outbox relay (Phase 6 / T0; since T1 the ONLY notification
# pipeline -- the old modules/notifications processor is gone, ID-1/ID-8).
from app.core.comms_listener import run_listener  # BE-134
from app.core.events.relay import run_relay  # Phase 6 / T0
from app.core.events.models import OutboxEvent  # noqa: F401  # Phase 6 / T0

# Practice auto-finalizer (Batch 1).
from app.modules.bookings.autofinalize import run_autofinalizer  # Batch 1

# Zoom meeting-creation retry poller (E21 step D).
from app.modules.zoom.retry_poller import run_zoom_retry_poller  # E21

# Zoom report poller -- the attendance decision (E21 step F).
from app.modules.zoom.report_poller import run_zoom_report_poller  # E21

# Support spam bin -- deletes spam tickets past the retention (BE-162 (2)).
from app.modules.support.purge import run_support_spam_purge  # BE-162 (2)


logger = structlog.get_logger()


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

# BE-139: the /mcp door. One instance per process; its session manager runs
# inside the lifespan below (Starlette would not run a mounted app's own).
mcp_app = build_mcp_app()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Manage application lifecycle: startup and shutdown."""
    # Log lines of protocol 9.4 on every role (BE-190, core/logging.py).
    setup_logging(log_level=settings.log_level)

    relay_task: asyncio.Task | None = None
    listener_task: asyncio.Task | None = None
    autofinalizer_task: asyncio.Task | None = None
    zoom_retry_task: asyncio.Task | None = None
    zoom_report_task: asyncio.Task | None = None
    spam_purge_task: asyncio.Task | None = None
    try:
        await init_redis()

        # Start the comms outbox relay as background task (Phase 6 / T0;
        # since T1 the only notification pipeline -- templates, gating,
        # and delivery live in comms, ID-1). Gated by settings for the
        # same test-race reason as every worker here; additionally
        # requires a configured COMMS_REDIS_URL -- local dev has no
        # comms stack, so an empty url means "no relay".
        if settings.comms_relay_enabled and settings.comms_redis_url:
            relay_task = asyncio.create_task(
                run_relay(), name="comms_outbox_relay",
            )
        else:
            logger.info(
                "comms_outbox_relay_disabled",
                enabled=settings.comms_relay_enabled,
                redis_url_configured=bool(settings.comms_redis_url),
            )

        # Start practice auto-finalizer as background task (Batch 1).
        # Gated by settings for the same reason as the processor above:
        # tests disable it so the background loop doesn't finalize a test
        # practice out from under an assertion via FOR UPDATE SKIP LOCKED.
        # BE-134: the comms push listener -- the other direction of the same
        # pipe, so the same gate plus the API it reads jobs back through.
        # One per worker, one active (core/comms_listener.py).
        if (
            settings.comms_relay_enabled
            and settings.comms_redis_url
            and settings.comms_api_url
        ):
            listener_task = asyncio.create_task(
                run_listener(), name="comms_push_listener",
            )
        else:
            logger.info("comms_push_listener_disabled")

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
        # BE-182: the Zoom pollers run only with the option `zoom` on.
        if settings.zoom_retry_enabled and settings.option_zoom:
            zoom_retry_task = asyncio.create_task(
                run_zoom_retry_poller(), name="zoom_retry_poller",
            )
        else:
            logger.info("zoom_retry_poller_disabled")

        # Start Zoom report poller -- the attendance decision (E21 step F).
        # Gated for the same reason as every worker above: tests disable it
        # so the loop can't race manual test calls via FOR UPDATE SKIP LOCKED.
        if settings.zoom_report_enabled and settings.option_zoom:
            zoom_report_task = asyncio.create_task(
                run_zoom_report_poller(), name="zoom_report_poller",
            )
        else:
            logger.info("zoom_report_poller_disabled")
        # BE-162 delivery 2: the support spam bin (support/purge.py). Gated
        # like every worker here: tests disable it so the loop cannot purge
        # a test's spam ticket out from under an assertion.
        if settings.support_spam_purge_enabled:
            spam_purge_task = asyncio.create_task(
                run_support_spam_purge(), name="support_spam_purge",
            )
        else:
            logger.info("support_spam_purge_disabled")

        logger.info(
            "app_started",
            role=settings.server_role,
            log_level=settings.log_level,
        )
        # BE-139: the MCP SDK's session manager -- stateless, it keeps no MCP
        # session, but it owns the task group each /mcp request runs in. It
        # wraps only the yield: the relay and pollers above start and stop
        # exactly as before.
        async with mcp_app.session_manager.run():
            yield
    finally:
        # Stop comms outbox relay (Phase 6 / T0). suppress() instead of
        # the try/except-pass of the older blocks -- lint-clean (SIM105)
        # without touching the sibling shutdowns.
        if relay_task is not None and not relay_task.done():
            relay_task.cancel()
            with suppress(asyncio.CancelledError):
                await relay_task
        if listener_task is not None and not listener_task.done():
            listener_task.cancel()
            with suppress(asyncio.CancelledError):
                await listener_task

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

        # Stop the support spam bin (BE-162 delivery 2).
        if spam_purge_task is not None and not spam_purge_task.done():
            spam_purge_task.cancel()
            try:
                await spam_purge_task
            except asyncio.CancelledError:
                pass

        await close_redis()
        await dispose_engine()
        logger.info("app_stopped")


# ---------------------------------------------------------------------------
# FastAPI Application
# ---------------------------------------------------------------------------
# BE-114 item 2 (owner decision: no Swagger outside): the schema and its two
# viewers are NOT SERVED -- not /openapi.json, not /docs, not /redoc -- on any
# box, on any role. Unconditional on purpose: a switch keyed on the role, or
# a flag forgotten on one box, would leave that box open. The schema itself
# still exists: app.openapi() builds it in-process whether or not it is
# served, and that is what type generation reads (backend/scripts/
# dump_openapi.py, run inside the app container by `velo update`, `velo
# gen-types` and the installer) and what CI reads.
app = FastAPI(
    title="VELO API",
    description="Platform for wellness practice facilitators",
    version="0.1.0",
    lifespan=lifespan,
    openapi_url=None,
    docs_url=None,
    redoc_url=None,
)

app.include_router(auth_router)
app.include_router(users_router)
app.include_router(masters_router)
app.include_router(masters_finance_router)        # E2
app.include_router(masters_students_router)       # E5
app.include_router(masters_groups_router)         # P1
app.include_router(schools_router)         # Curator GROUPS P1
app.include_router(schools_member_router)  # Curator GROUPS GT-2
app.include_router(masters_reviews_router)        # #3
app.include_router(masters_stats_router)          # E7
app.include_router(admin_router)
app.include_router(reports_router)
app.include_router(practices_router)
# T-35: the /z/{code} link wrapper. Mounted at the ROOT, deliberately outside
# /api/v1 -- nginx proxies "/" on the public host straight here, so the route
# publishes itself, and the link a master pastes into a Telegram channel stays
# short. It is also the ONLY router here serving HTML to an anonymous browser
# rather than JSON to our client.
app.include_router(practices_public_router)       # T-35
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
app.include_router(transcription_router)          # GT-41
app.include_router(notifications_router)          # Phase 6 / T1 (comms proxy)
app.include_router(chats_router)                   # Phase 6 / T2 (chat proxy)
app.include_router(support_router)                 # B34 / T-38 (support proxy)
app.include_router(mcp_tokens_router)              # BE-138 (MCP tokens)
# BE-139: exactly /mcp, every method, no trailing-slash redirect (an MCP
# client's POST may not follow one). An ASGI app as the endpoint, so the
# gate sees the raw scope; not in the OpenAPI schema.
app.router.add_route(MCP_PATH, mcp_app.asgi, include_in_schema=False)
# BE-141: the OAuth paths of /mcp (discovery, registration, authorize, token,
# Telegram sign-in, consent) -- one ASGI door in front of them all, which
# answers the plain 404 while MCP is off. Exact
# paths, every method (the door's own router answers 405); not in OpenAPI.
_oauth_door = OAuthDoor()
for _path in OAUTH_PATHS:
    app.router.add_route(_path, _oauth_door, include_in_schema=False)


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
# The one origin of the instance's frontend (BE-192: https://<domains.frontend>).
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin],
    allow_credentials=True,
    allow_methods=["*"],
    # B-03: Fetch spec forbids allow_headers=["*"] with allow_credentials=True.
    # List headers explicitly. X-Request-ID is the request id (protocol 9.6).
    allow_headers=["Authorization", "Content-Type", REQUEST_ID_HEADER],
    # The frontend is on another origin (domains.frontend) and shows the
    # request id with an error (frontend/src/api/client.ts): a response
    # header it may read only when exposed.
    expose_headers=[REQUEST_ID_HEADER],
)

# ---------------------------------------------------------------------------
# Request context: request id, client address, User-Agent (BE-190)
# ---------------------------------------------------------------------------
# Added AFTER CORSMiddleware so Starlette applies it as the outermost
# layer (LIFO order).
app.add_middleware(RequestContextMiddleware)


# ---------------------------------------------------------------------------
# Root & Health Endpoints
# ---------------------------------------------------------------------------
@app.get("/")
async def root() -> dict:
    """Root endpoint -- API info."""
    return {"name": "VELO API", "version": "0.1.0"}


# GET /health and GET /ready of protocol 9 (core/report.py).
report_instance = Report()
app.include_router(report_instance.router)
