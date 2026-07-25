# =============================================================================
# VELO Backend -- Practice Router (Phase 4.2 + 4.3/4.4, updated Phase 6.5,
#                                  updated Frontend F3 prep)
# =============================================================================
#
# ENDPOINTS:
#   GET    /api/v1/practices                     -- public feed (4.3)
#   POST   /api/v1/practices                     -- create (master only)
#   POST   /api/v1/practices/{id}/zoom/start-ticket -- one-time Zoom start ticket (556)
#   POST   /api/v1/practices/{id}/zoom/retry      -- retry a failed Zoom meeting (A4 V2, 572)
#   GET    /api/v1/practices/zoom/start           -- redeem ticket, redirect to Zoom (556)
#   GET    /api/v1/practices/{id}                 -- get by id (any auth user)
#   PATCH  /api/v1/practices/{id}                 -- update (owner master only)
#   DELETE /api/v1/practices/{id}                 -- soft delete draft (owner only)
#   POST   /api/v1/practices/{id}/cancel          -- cancel + refund all (6.5)
#
# MASTER_NAME (Frontend F3 prep):
#   - list/get endpoints: service returns master_name via JOIN.
#   - create/update/delete/cancel: user object already available from
#     get_current_master dependency, so practice_to_response(p, user.first_name).
#
# AUTH:
#   GET list uses get_current_user (any authenticated user).
#   POST/PATCH/DELETE/CANCEL use get_current_master (verified master).
#   GET by id uses get_current_user (any authenticated user).
#   GET /zoom/start uses NEITHER -- the one-time ticket IS the auth (556).
#
# SESSION:
#   Read endpoints use get_db_reader.
#   Mutating endpoints use get_db_session (write).
#
# ROUTE ORDER (ПРОМТ №557): every LITERAL-segment route in this router must
#   be declared before any PARAMETERISED route it shares a path prefix with,
#   even when (as verified here, see the "/zoom/start" block below) the two
#   don't actually collide -- a reader should never have to reason about
#   Starlette's per-segment match order to know a literal path is reachable.
#   Checked every pair below: GET ""/POST "" (0 segments) vs GET/PATCH/DELETE
#   "/{practice_id}" (1 segment) -- different segment counts, no collision,
#   pre-existing convention. GET "/{practice_id}" (1 segment) vs GET
#   "/zoom/start" (2 literal segments) -- different segment counts, no
#   collision, reordered anyway (556 postmortem). "/{practice_id}/cancel"
#   and "/{practice_id}/zoom/start-ticket" (2-3 segments, dynamic-then-
#   literal) vs "/zoom/start" (2 literal) -- share a segment count with
#   "/cancel" only, but differ in the literal suffix ("cancel"/"start-
#   ticket" vs "start") and, for start-ticket, in HTTP method (POST vs GET)
#   too, so neither can ever match the other's request.
# =============================================================================

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, Query, Response, status
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import AfterValidator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db_reader, get_db_session
from app.core.exceptions import BadRequestError, NotFoundError
from app.modules.auth.dependencies import (
    get_current_master,
    get_current_user,
)
from app.modules.masters.models import MasterProfile
from app.modules.practices.cancel_service import cancel_practice
from app.modules.practices.listing_service import list_public_practices
from app.modules.practices.models import Practice
from app.modules.practices.schemas import (
    CancelPracticeRequest,
    CreatePracticeRequest,
    PaginatedPracticesResponse,
    PracticeResponse,
    UpdatePracticeRequest,
    ZoomStartTicketResponse,
)
from app.modules.practices.service import (
    create_practice,
    delete_practice,
    get_practice_detail,
    group_names_for_practice,
    practice_to_response,
    update_practice,
)
from app.modules.users.models import User
from app.modules.zoom.models import ZoomMeeting, ZoomMeetingStatus

logger = structlog.get_logger()

router = APIRouter(
    prefix="/api/v1/practices", tags=["practices"],
)


# ------------------------------------------------------------------
# Query-parameter validators (NO-LITERALS policy)
# ------------------------------------------------------------------
# The list-feed endpoint historically hardcoded Literal[...] inline for
# practice_type / direction / difficulty. That duplicated the source of
# truth and went out of sync the moment those lists were extended (422 on
# new values). practice_type / difficulty have no catalog table (out of
# T2's scope) and stay membership-validated below against
# settings.practice_allowed_* -- unchanged.
#
# direction / style are NOT membership-validated here (T2 stage 1 follow-up,
# 2026-07-15). This is a sync AfterValidator on a query param -- it cannot
# query the async DB catalog, the exact wall that moved CREATE/UPDATE
# validation into practices/service.py (_validate_taxonomy()). Teaching this
# validator the same trick (query the catalog on a config miss) would add a
# DB round-trip to every feed request that filters by direction/style, for
# no behavioral gain: a filter is a query, not a security boundary. Passing
# a direction/style that matches no stored practice is not an error -- it is
# correctly an EMPTY result, because list_public_practices() filters with a
# plain `.in_()` against Practice.data["taxonomy"] (JSONB) that naturally
# returns zero rows for a value nothing has. Dropping the check here also
# removes a class of bug permanently: it can never again drift out of sync
# with the create/update union (there is nothing left to keep in sync).
# duration_bucket / time_of_day / status_filter / sort_by / sort_order
# stay as inline Literal -- those are closed, by-design vocabularies that
# are not config-driven.


def _validate_practice_types(v: list[str] | None) -> list[str] | None:
    if not v:
        return v
    allowed = settings.practice_allowed_types
    bad = [x for x in v if x not in allowed]
    if bad:
        raise ValueError(
            f"practice_type must be one of {allowed}, got {bad}"
        )
    return v


def _validate_difficulties(v: list[str] | None) -> list[str] | None:
    if not v:
        return v
    allowed = settings.practice_allowed_difficulties
    bad = [x for x in v if x not in allowed]
    if bad:
        raise ValueError(
            f"difficulty must be one of {allowed}, got {bad}"
        )
    return v


# ------------------------------------------------------------------
# GET /api/v1/practices -- public feed (Phase 4.3)
# ------------------------------------------------------------------
@router.get("", response_model=PaginatedPracticesResponse)
async def list_practices_endpoint(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    master_id: UUID | None = Query(default=None),
    practice_type: Annotated[
        list[str] | None, AfterValidator(_validate_practice_types),
    ] = Query(default=None),
    # direction / style: no membership AfterValidator (T2 follow-up,
    # 2026-07-15) -- see the comment block above. Type/shape only.
    direction: list[str] | None = Query(default=None),
    difficulty: Annotated[
        list[str] | None, AfterValidator(_validate_difficulties),
    ] = Query(default=None),
    style: list[str] | None = Query(default=None),
    duration_bucket: Literal["short", "long"] | None = Query(default=None),
    time_of_day: Literal[
        "night", "morning", "day", "evening",
    ] | None = Query(default=None),
    status_filter: Literal[
        "scheduled", "live",
    ] | None = Query(default=None, alias="status"),
    date_from: datetime | None = Query(default=None),
    date_to: datetime | None = Query(default=None),
    sort_by: Literal[
        "scheduled_at", "price_cents",
    ] = Query(default="scheduled_at"),
    sort_order: Literal["asc", "desc"] = Query(
        default="asc",
    ),
) -> PaginatedPracticesResponse:
    """List practices in the public feed.

    Default feed shows only upcoming bookable practices (scheduled/live with
    scheduled_at in the future); started and past practices are excluded.
    Passing an explicit ?status= bypasses the future-only gate.
    Supports Calendar filters (direction / difficulty / style /
    duration_bucket / time_of_day), multi-select type/direction/difficulty,
    sorting, and pagination. Per-user is_booked/is_paid flags are included.
    """
    return await list_public_practices(
        session,
        user=user,
        limit=limit,
        offset=offset,
        master_id=master_id,
        practice_type=practice_type,
        direction=direction,
        difficulty=difficulty,
        style=style,
        duration_bucket=duration_bucket,
        time_of_day=time_of_day,
        status=status_filter,
        date_from=date_from,
        date_to=date_to,
        sort_by=sort_by,
        sort_order=sort_order,
    )


# ------------------------------------------------------------------
# POST /api/v1/practices -- create (Phase 4.2)
# ------------------------------------------------------------------
@router.post(
    "",
    response_model=PracticeResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_practice_endpoint(
    body: CreatePracticeRequest,
    master_tuple: tuple[User, MasterProfile] = Depends(
        get_current_master,
    ),
    session: AsyncSession = Depends(get_db_session),
) -> PracticeResponse:
    """Create a new practice (verified master only)."""
    user, _profile = master_tuple
    # A4 V6 (ПРОМТ №572): deduplicated is True when create_practice returned
    # an EXISTING practice (the window-scoped dedup check, or the TOCTOU
    # race-lost path, A4 V7) instead of creating a new one -- see that
    # function's own docstring.
    practice, deduplicated = await create_practice(user, body, session)
    await session.flush()
    await session.refresh(practice)
    # F1 (№263): this endpoint is owner-only (master guard + ownership check),
    # so the response returns the caller's OWN zoom_link — consistent with the
    # owner-always-sees rule on the detail (M-3) and the master list (Z-6).
    # T21-1: same owner-only posture for the host's own join_url. A freshly
    # created practice has no ZoomMeeting yet (that happens on publish, not
    # here) -- get_host_join_url returns None until then, which is correct.
    from app.modules.zoom.service import get_host_join_url, get_zoom_meeting_status
    host_join_url = await get_host_join_url(practice.id, session)
    # A4 V2 (ПРОМТ №572): None here too, same reasoning as host_join_url --
    # fetched anyway for consistency with the other three owner-only sites
    # (this is also the endpoint V6's deduplicated-practice response flows
    # through, where the returned practice IS already published and DOES
    # have a real status).
    zoom_meeting_status = await get_zoom_meeting_status(practice.id, session)
    audience_group_names = await group_names_for_practice(practice, session)
    return practice_to_response(
        practice, user.first_name,
        zoom_link_visible=True, zoom_host_join_url=host_join_url,
        zoom_meeting_status=zoom_meeting_status,
        deduplicated=deduplicated,
        audience_group_names=audience_group_names,
    )


# ------------------------------------------------------------------
# Zoom "Начать" (ПРОМТ №556, OWNER-1 option В) -- the master starts their
# own meeting as host. See zoom/service.py's ticket-issuance docstring for
# the full rationale (start_url never stored, never in a JSON body).
#
# ПРОМТ №557: GET "/zoom/start" is declared here, BEFORE GET "/{practice_id}"
# below, on the SAME convention already documented at the top of this file
# for GET "" vs GET "/{practice_id}" -- a literal-segment route must be
# declared ahead of any parameterised route it could be confused with, so a
# reader never has to reason about match order to know a literal path is
# reachable. (Measured with Starlette's own Route.matches() against the
# real, imported app.router: a 1-segment "/{practice_id}" pattern does NOT
# in fact match a 2-segment path like "/zoom/start" -- its regex is
# per-segment-anchored, so this reordering does not change behavior. It is
# moved anyway, for the same zero-cost, doubt-removing reason the pre-
# existing GET ""-before-GET "/{practice_id}" convention exists.)
# ------------------------------------------------------------------
@router.post(
    "/{practice_id}/zoom/start-ticket",
    response_model=ZoomStartTicketResponse,
)
async def create_zoom_start_ticket_endpoint(
    practice_id: UUID,
    master_tuple: tuple[User, MasterProfile] = Depends(
        get_current_master,
    ),
    session: AsyncSession = Depends(get_db_reader),
) -> ZoomStartTicketResponse:
    """Issue a one-time, 30s ticket authorizing a single start_url fetch.

    Ownership check is the SAME P-08 pattern (404, not 403) as
    update/delete/cancel_practice above -- deliberately not a new notion of
    "owns this practice". No admin carve-out: none of those three
    owner-only Zoom call sites has one either, and start_url is a strictly
    more sensitive credential than the join_url they gate, so this endpoint
    does not introduce a wider audience than the existing pattern already
    allows.
    """
    user, _profile = master_tuple
    stmt = select(Practice).where(Practice.id == practice_id)
    result = await session.execute(stmt)
    practice = result.scalar_one_or_none()
    if not practice or practice.master_id != user.id:
        raise NotFoundError("Practice not found")

    from app.modules.zoom.service import (
        create_start_ticket,
        get_active_meeting_for_practice,
    )
    meeting = await get_active_meeting_for_practice(practice_id, session)
    if meeting is None:
        raise BadRequestError(
            "No active Zoom meeting for this practice",
            code="zoom_meeting_not_active",
        )

    ticket = await create_start_ticket(meeting.id)
    return ZoomStartTicketResponse(ticket=ticket)


# ------------------------------------------------------------------
# A4 V2 (ПРОМТ №572): master-triggered retry for a permanently-failed
# meeting creation. RECON (before this endpoint existed): the background
# retry poller (zoom/retry_poller.py) already re-attempts create_failed
# rows automatically, so re-enqueueing was cheap -- attempt_zoom_meeting_
# create (renamed from the poller's own private _attempt_create) is
# reused DIRECTLY here, called synchronously instead of waiting for the
# poller's next cycle (which can be zoom_retry_max_backoff_seconds -- up
# to 10 minutes -- away if the poller has backed off from idling). No new
# locking was needed: this endpoint takes the SAME row-level FOR UPDATE
# the poller's own claim query relies on, so the two can never double-
# process the same row (Postgres serializes them; the poller's SKIP
# LOCKED just skips a row this endpoint is mid-handling that cycle).
# ------------------------------------------------------------------
@router.post(
    "/{practice_id}/zoom/retry",
    response_model=PracticeResponse,
)
async def retry_zoom_meeting_endpoint(
    practice_id: UUID,
    master_tuple: tuple[User, MasterProfile] = Depends(
        get_current_master,
    ),
    session: AsyncSession = Depends(get_db_session),
) -> PracticeResponse:
    """The "Повторить" button on a create_failed Zoom meeting.

    Ownership check is the SAME P-08 pattern (404, not 403) as the other
    owner-only Zoom endpoints above.

    404 if there is no ZoomMeeting row at all for this practice (nothing to
    retry -- publish never ran, or this is pre-E21 data). 400
    zoom_meeting_not_failed if a row exists but is not currently
    create_failed: pending_creation is already queued for the poller
    (nothing for a manual retry to add), and active has nothing to retry.

    retry_count is still incremented by attempt_zoom_meeting_create (so
    last_sync_error keeps an honest attempt count), but this action is NOT
    gated by settings.zoom_meeting_create_max_retries -- that cap only
    stops the POLLER's own automatic re-claiming
    (_claim_retryable_ids), not this explicit, one-at-a-time action a
    master chose to take. A master can therefore retry again even after
    the poller has visibly given up.
    """
    user, _profile = master_tuple
    practice = (
        await session.execute(select(Practice).where(Practice.id == practice_id))
    ).scalar_one_or_none()
    if not practice or practice.master_id != user.id:
        raise NotFoundError("Practice not found")

    meeting = (
        await session.execute(
            select(ZoomMeeting)
            .where(ZoomMeeting.practice_id == practice_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if meeting is None:
        raise NotFoundError("No Zoom meeting for this practice")
    if meeting.status != ZoomMeetingStatus.CREATE_FAILED.value:
        raise BadRequestError(
            "Zoom meeting is not in a failed state",
            code="zoom_meeting_not_failed",
        )

    from app.modules.zoom.retry_poller import attempt_zoom_meeting_create
    from app.modules.zoom.service import get_host_join_url

    await attempt_zoom_meeting_create(meeting, practice, session)
    await session.flush()
    await session.refresh(meeting)

    host_join_url = await get_host_join_url(practice.id, session)
    return practice_to_response(
        practice, user.first_name,
        zoom_link_visible=True,
        zoom_host_join_url=host_join_url,
        zoom_meeting_status=meeting.status,
    )


@router.get("/zoom/start")
async def zoom_start_redirect_endpoint(
    ticket: str,
    session: AsyncSession = Depends(get_db_reader),
) -> Response:
    """Redeem a start-ticket and 302 the browser straight to Zoom's
    start_url. Reached by a PLAIN browser navigation (Telegram
    WebApp.openLink), never by our authenticated fetch client -- there is no
    Authorization header here, the ticket IS the authentication (see
    create_zoom_start_ticket_endpoint above and zoom/service.py).

    Every failure path returns a small Russian-language HTML page, never a
    raw exception body -- a plain navigation has no toast/error-handling
    layer to catch a JSON error the way an authenticated fetch call does.
    start_url itself is never logged on any path below.
    """
    from app.modules.zoom.service import (
        get_meeting_start_url,
        redeem_start_ticket,
    )
    from app.modules.zoom.zoom_client import ZoomAPIError

    zoom_meeting_id = await redeem_start_ticket(ticket)
    if zoom_meeting_id is None:
        return _zoom_start_error_page(
            "Ссылка устарела. Вернитесь в приложение и нажмите «Начать» ещё раз.",
        )

    meeting = await session.get(ZoomMeeting, zoom_meeting_id)
    if meeting is None or meeting.status != ZoomMeetingStatus.ACTIVE.value:
        return _zoom_start_error_page(
            "Встреча Zoom для этой практики недоступна.",
        )

    try:
        start_url = await get_meeting_start_url(meeting.zoom_meeting_id)
    except ZoomAPIError:
        logger.warning(
            "zoom_start_url_fetch_failed", practice_id=str(meeting.practice_id),
        )
        return _zoom_start_error_page(
            "Не удалось связаться с Zoom. Попробуйте ещё раз через минуту.",
        )

    if start_url is None:
        logger.warning(
            "zoom_start_url_missing", practice_id=str(meeting.practice_id),
        )
        return _zoom_start_error_page(
            "Zoom не вернул ссылку для начала встречи. Попробуйте ещё раз.",
        )

    return RedirectResponse(
        url=start_url,
        status_code=status.HTTP_307_TEMPORARY_REDIRECT,
        # A4 V10: without this, the browser's Referer header on the hop to
        # Zoom carries this endpoint's full URL (including the now-consumed
        # ticket query param) to zoom.us. The ticket is already dead by this
        # point (redeem_start_ticket already GETDEL'd it above), so this is
        # not a replay risk -- but there is no reason to hand a third party
        # our internal route shape either.
        headers={"Referrer-Policy": "no-referrer"},
    )


def _zoom_start_error_page(message: str) -> HTMLResponse:
    """Honest, Russian-facing failure page for zoom_start_redirect_endpoint
    -- a plain navigation has no frontend toast to route a JSON error into,
    so this IS the error UI. Never includes any Zoom-provided text
    (status/body) -- those are English and API-shaped, exactly the failure
    mode this must not repeat."""
    return HTMLResponse(
        content=(
            "<!doctype html><html lang='ru'><meta charset='utf-8'>"
            "<body style='font-family:sans-serif;text-align:center;padding:40px 20px'>"
            f"<p>{message}</p></body></html>"
        ),
        status_code=status.HTTP_400_BAD_REQUEST,
    )


# ------------------------------------------------------------------
# GET /api/v1/practices/{id} -- get by id (Phase 4.2)
# ------------------------------------------------------------------
@router.get(
    "/{practice_id}",
    response_model=PracticeResponse,
)
async def get_practice_endpoint(
    practice_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> PracticeResponse:
    """Get a practice by id.

    Draft/deleted practices are visible only to the owner master.
    """
    return await get_practice_detail(practice_id, user, session)


# ------------------------------------------------------------------
# PATCH /api/v1/practices/{id} -- update (Phase 4.2)
# ------------------------------------------------------------------
@router.patch(
    "/{practice_id}",
    response_model=PracticeResponse,
)
async def update_practice_endpoint(
    practice_id: UUID,
    body: UpdatePracticeRequest,
    master_tuple: tuple[User, MasterProfile] = Depends(
        get_current_master,
    ),
    session: AsyncSession = Depends(get_db_session),
) -> PracticeResponse:
    """Update a practice (owner master only)."""
    user, _profile = master_tuple
    practice = await update_practice(
        practice_id, user, body, session,
    )
    await session.flush()
    await session.refresh(practice)
    # F1 (№263): this endpoint is owner-only (master guard + ownership check),
    # so the response returns the caller's OWN zoom_link — consistent with the
    # owner-always-sees rule on the detail (M-3) and the master list (Z-6).
    # T21-1: same owner-only posture for the host's own join_url (may become
    # non-None here if this update is the draft->scheduled publish).
    from app.modules.zoom.service import get_host_join_url, get_zoom_meeting_status
    host_join_url = await get_host_join_url(practice.id, session)
    # A4 V2 (ПРОМТ №572): so a master publishing a draft (creating the Zoom
    # meeting) sees "готовится" immediately instead of a stale None.
    zoom_meeting_status = await get_zoom_meeting_status(practice.id, session)
    audience_group_names = await group_names_for_practice(practice, session)
    return practice_to_response(
        practice, user.first_name,
        zoom_link_visible=True, zoom_host_join_url=host_join_url,
        zoom_meeting_status=zoom_meeting_status,
        audience_group_names=audience_group_names,
    )


# ------------------------------------------------------------------
# DELETE /api/v1/practices/{id} -- soft delete (Phase 4.2)
# ------------------------------------------------------------------
@router.delete(
    "/{practice_id}",
    response_model=PracticeResponse,
)
async def delete_practice_endpoint(
    practice_id: UUID,
    master_tuple: tuple[User, MasterProfile] = Depends(
        get_current_master,
    ),
    session: AsyncSession = Depends(get_db_session),
) -> PracticeResponse:
    """Soft-delete a draft practice (owner master only).

    Sets status=deleted. Only works on drafts. Published practices
    must be cancelled via POST /{id}/cancel (Phase 6.5).
    """
    user, _profile = master_tuple
    practice = await delete_practice(practice_id, user, session)
    await session.flush()
    await session.refresh(practice)
    # F1 (№263): this endpoint is owner-only (master guard + ownership check),
    # so the response returns the caller's OWN zoom_link — consistent with the
    # owner-always-sees rule on the detail (M-3) and the master list (Z-6).
    # T21-1: soft-deleted drafts never had a meeting created (E21 fires on
    # publish only), so this is always None here -- fetched anyway for
    # consistency with the other three owner-only sites.
    from app.modules.zoom.service import get_host_join_url, get_zoom_meeting_status
    host_join_url = await get_host_join_url(practice.id, session)
    zoom_meeting_status = await get_zoom_meeting_status(practice.id, session)
    return practice_to_response(
        practice, user.first_name,
        zoom_link_visible=True, zoom_host_join_url=host_join_url,
        zoom_meeting_status=zoom_meeting_status,
    )


# ------------------------------------------------------------------
# POST /api/v1/practices/{id}/cancel -- cancel + refund (Phase 6.5)
# ------------------------------------------------------------------
@router.post(
    "/{practice_id}/cancel",
    response_model=PracticeResponse,
)
async def cancel_practice_endpoint(
    practice_id: UUID,
    body: CancelPracticeRequest | None = None,
    master_tuple: tuple[User, MasterProfile] = Depends(
        get_current_master,
    ),
    session: AsyncSession = Depends(get_db_session),
) -> PracticeResponse:
    """Cancel a practice and refund all participants (owner master only).

    100% refund to every active booking. Waitlist entries cleared. Only works
    on scheduled/live practices. This is the only way to reach cancelled status.

    Optional body {scope}: "this" (the default, or no body) cancels only this
    occurrence; "this_and_future" also cancels every later occurrence of the
    same series (a non-series practice behaves like "this").
    """
    user, _profile = master_tuple
    scope = (body or CancelPracticeRequest()).scope
    practice = await cancel_practice(
        practice_id, user, session, scope=scope,
    )
    await session.flush()
    await session.refresh(practice)
    # F1 (№263): this endpoint is owner-only (master guard + ownership check),
    # so the response returns the caller's OWN zoom_link — consistent with the
    # owner-always-sees rule on the detail (M-3) and the master list (Z-6).
    # T21-1: cancel_practice deletes the Zoom meeting (zoom/service.py
    # delete_meeting_for_practice) -- get_host_join_url returns None once that
    # row's status flips, which is correct (nothing to join anymore).
    from app.modules.zoom.service import get_host_join_url, get_zoom_meeting_status
    host_join_url = await get_host_join_url(practice.id, session)
    # A4 V2 (ПРОМТ №572): will read 'deleted' after the cancel above --
    # correctly distinct from create_failed/pending_creation.
    zoom_meeting_status = await get_zoom_meeting_status(practice.id, session)
    return practice_to_response(
        practice, user.first_name,
        zoom_link_visible=True, zoom_host_join_url=host_join_url,
        zoom_meeting_status=zoom_meeting_status,
    )
