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
#   GET    /api/v1/practices/{id}/zoom/resolve    -- how THIS user enters (T-35)
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
#   GET /{id}/zoom/resolve uses get_current_user: it is the AUTHENTICATED
#     half of the T-35 wrapper, and knowing who is asking is the entire
#     reason it can answer with a personal link at all.
#
# PUBLIC ROUTER (T-35): this file also declares `public_router`, mounted at
#   the ROOT (no /api/v1 prefix) -- see its own block at the bottom.
#
# SESSION:
#   Read endpoints use get_db_reader.
#   Mutating endpoints use get_db_session (write).
#
# ROUTE ORDER (PROMPT №557): every LITERAL-segment route in this router must
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

import html
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

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
from app.modules.masters.service import get_master_display_name
from app.modules.practices.cancel_service import cancel_practice
from app.modules.practices.listing_service import list_public_practices
from app.modules.practices.models import Practice
from app.modules.practices.schemas import (
    AudiencePreviewRequest,
    AudiencePreviewResponse,
    CancelPracticeRequest,
    CreatePracticeRequest,
    PaginatedPracticesResponse,
    PracticeResponse,
    UpdatePracticeRequest,
    ZoomEntryResolveResponse,
    ZoomStartTicketResponse,
)
from app.modules.practices.service import (
    create_practice,
    delete_practice,
    get_practice_detail,
    group_names_for_practice,
    practice_to_response,
    preview_audience_change,
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
    # A4 V6 (PROMPT №572): deduplicated is True when create_practice returned
    # an EXISTING practice (the window-scoped dedup check, or the TOCTOU
    # race-lost path, A4 V7) instead of creating a new one -- see that
    # function's own docstring.
    practice, deduplicated = await create_practice(user, body, session)
    await session.flush()
    await session.refresh(practice)
    # F1 (№263): this endpoint is owner-only (master guard + ownership check),
    # so the response carries the caller's OWN owner-only Zoom fields —
    # consistent with the owner-always-sees rule on the detail and the
    # master list (Z-6).
    # T21-1: same owner-only posture for the host's own join_url. A freshly
    # created practice has no ZoomMeeting yet (that happens on publish, not
    # here) -- get_host_join_url returns None until then, which is correct.
    from app.modules.zoom.service import (
        get_host_join_url,
        get_zoom_meeting_status,
    )
    host_join_url = await get_host_join_url(practice.id, session)
    # A4 V2 (PROMPT №572): None here too, same reasoning as host_join_url --
    # fetched anyway for consistency with the other three owner-only sites
    # (this is also the endpoint V6's deduplicated-practice response flows
    # through, where the returned practice IS already published and DOES
    # have a real status).
    zoom_meeting_status = await get_zoom_meeting_status(practice.id, session)
    audience_group_names = await group_names_for_practice(practice, session)
    return practice_to_response(
        practice, user.first_name,
        zoom_host_join_url=host_join_url,
        zoom_public_link_visible=True,
        zoom_meeting_status=zoom_meeting_status,
        deduplicated=deduplicated,
        audience_group_names=audience_group_names,
    )


# ------------------------------------------------------------------
# Zoom "Начать" (PROMPT №556, OWNER-1 option В) -- the master starts their
# own meeting as host. See zoom/service.py's ticket-issuance docstring for
# the full rationale (start_url never stored, never in a JSON body).
#
# PROMPT №557: GET "/zoom/start" is declared here, BEFORE GET "/{practice_id}"
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
# A4 V2 (PROMPT №572): master-triggered retry for a permanently-failed
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
        zoom_host_join_url=host_join_url,
        zoom_public_link_visible=True,
        zoom_meeting_status=meeting.status,
    )


# ------------------------------------------------------------------
# T-35: the authenticated half of the link wrapper.
#
# Keyed by practice_id, NOT by the public code, and that is deliberate:
# practice-live is opened both by the deep link (which carries a code) and by
# an ordinary tap from a dashboard (which does not). Keying this by the code
# would force that screen to ENCODE a uuid it already holds, just so this
# endpoint could immediately decode it back -- a third home for the codec, and
# the first one with no reason to exist.
#
# The LADDER lives in zoom/service.py's resolve_zoom_entry, not here and not
# on the client. It used to live in frontend/src/utils/zoomLink.ts, where it
# was a rule each of four entry points had to remember -- and a rule cannot be
# enforced by construction, which is the second defect this feature closes.
# ------------------------------------------------------------------
@router.get(
    "/{practice_id}/zoom/resolve",
    response_model=ZoomEntryResolveResponse,
)
async def resolve_zoom_entry_endpoint(
    practice_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
) -> ZoomEntryResolveResponse:
    """How does THIS caller enter THIS practice right now.

    404 (not a `kind`) for a practice that does not exist or is draft/
    deleted -- the same P-08 shape every other endpoint in this router uses,
    so a client that mistypes a code gets the module's normal answer rather
    than a special one. A deep link built from a well-formed code naming a
    deleted practice lands here: the client cannot tell that case apart
    locally (it has no database), so this 404 is what it renders an honest
    error from.
    """
    from app.modules.zoom.service import is_publicly_resolvable, resolve_zoom_entry

    practice = (
        await session.execute(select(Practice).where(Practice.id == practice_id))
    ).scalar_one_or_none()
    if practice is None or not is_publicly_resolvable(practice):
        raise NotFoundError("Practice not found")

    resolution = await resolve_zoom_entry(practice, user, session)
    return ZoomEntryResolveResponse(
        kind=resolution.kind.value, url=resolution.url,
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
    # so the response carries the caller's OWN owner-only Zoom fields —
    # consistent with the owner-always-sees rule on the detail and the
    # master list (Z-6).
    # T21-1: same owner-only posture for the host's own join_url (may become
    # non-None here if this update is the draft->scheduled publish).
    from app.modules.zoom.service import (
        get_host_join_url,
        get_zoom_meeting_status,
    )
    host_join_url = await get_host_join_url(practice.id, session)
    # T24-38 (PROMPT №642): same reasoning as host_join_url -- becomes
    # non-None here too if this update is the draft->scheduled publish.
    # A4 V2 (PROMPT №572): so a master publishing a draft (creating the Zoom
    # meeting) sees "готовится" immediately instead of a stale None.
    zoom_meeting_status = await get_zoom_meeting_status(practice.id, session)
    audience_group_names = await group_names_for_practice(practice, session)
    return practice_to_response(
        practice, user.first_name,
        zoom_host_join_url=host_join_url,
        zoom_public_link_visible=True,
        zoom_meeting_status=zoom_meeting_status,
        audience_group_names=audience_group_names,
    )


# ------------------------------------------------------------------
# POST /api/v1/practices/{id}/audience-preview -- dry-run (owner Q15, PROMPT №613)
# ------------------------------------------------------------------
@router.post(
    "/{practice_id}/audience-preview",
    response_model=AudiencePreviewResponse,
)
async def preview_audience_change_endpoint(
    practice_id: UUID,
    body: AudiencePreviewRequest,
    master_tuple: tuple[User, MasterProfile] = Depends(
        get_current_master,
    ),
    session: AsyncSession = Depends(get_db_reader),
) -> AudiencePreviewResponse:
    """How many of this practice's ACTIVE bookers would fall outside a
    PROPOSED audience -- read-only, never saves anything. Called by
    EditPracticeView before an audience-narrowing save, so the master can
    be warned with a real count instead of finding out from upset students
    at check-in time (owner-ruled)."""
    user, _profile = master_tuple
    stranded_count = await preview_audience_change(
        practice_id,
        user,
        body.audience_kind.value,
        body.group_ids,
        session,
        curator_group_ids=body.curator_group_ids,
    )
    return AudiencePreviewResponse(stranded_count=stranded_count)


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
    # so the response carries the caller's OWN owner-only Zoom fields —
    # consistent with the owner-always-sees rule on the detail and the
    # master list (Z-6).
    # T21-1: soft-deleted drafts never had a meeting created (E21 fires on
    # publish only), so this is always None here -- fetched anyway for
    # consistency with the other three owner-only sites.
    from app.modules.zoom.service import (
        get_host_join_url,
        get_zoom_meeting_status,
    )
    host_join_url = await get_host_join_url(practice.id, session)
    # T24-38 (PROMPT №642): soft-deleted drafts never had a meeting created
    # either -- always None here, fetched anyway for consistency.
    zoom_meeting_status = await get_zoom_meeting_status(practice.id, session)
    return practice_to_response(
        practice, user.first_name,
        zoom_host_join_url=host_join_url,
        zoom_public_link_visible=True,
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
    # so the response carries the caller's OWN owner-only Zoom fields —
    # consistent with the owner-always-sees rule on the detail and the
    # master list (Z-6).
    # T21-1: cancel_practice deletes the Zoom meeting (zoom/service.py
    # delete_meeting_for_practice) -- get_host_join_url returns None once that
    # row's status flips, which is correct (nothing to join anymore).
    from app.modules.zoom.service import (
        get_host_join_url,
        get_zoom_meeting_status,
    )
    host_join_url = await get_host_join_url(practice.id, session)
    # T24-38 (PROMPT №642): cancel_practice deletes the Zoom meeting too --
    # None once that row's status flips, same as host_join_url.
    # A4 V2 (PROMPT №572): will read 'deleted' after the cancel above --
    # correctly distinct from create_failed/pending_creation.
    zoom_meeting_status = await get_zoom_meeting_status(practice.id, session)
    return practice_to_response(
        practice, user.first_name,
        zoom_host_join_url=host_join_url,
        zoom_public_link_visible=True,
        zoom_meeting_status=zoom_meeting_status,
    )


# ==================================================================
# T-35: PUBLIC ROUTER -- the wrapper every Zoom link now goes through.
# ==================================================================
#
# Mounted at the ROOT, outside /api/v1 (main.py). That is not a style choice:
# nginx proxies `location /` on the public host straight to this backend, so a
# root route publishes itself, and the whole point of the exercise is a SHORT
# link a master can paste into a Telegram channel -- ~49 characters, of which
# 22 are the code.
#
# WHY A SERVER-RENDERED PAGE AND NOT A REDIRECT INTO THE SPA: OpenGraph.
# Telegram draws its card from og:title / og:description in the HTML it
# fetches, and an SPA returns an empty shell -- there would be no preview at
# all. A card carrying the practice title and its time beats any amount of
# further URL shortening. The page is also instant, with no bundle to load,
# which matters for someone clicking a minute before the practice starts.
#
# The markup below is lifted from frontend/src/views/auth/StandaloneStubView.
# vue. TWO COPIES EXIST AND THAT IS ACCEPTED (owner ruling): this page changes
# about once a year, and polishing the landing belongs to the frontend team,
# who will reconcile them. Note what "lifted" really means, though -- the stub
# is not self-contained: its design tokens come from
# frontend/src/styles/variables.css and CANNOT be referenced from this host,
# so they are RESOLVED TO LITERALS here (--velo-primary #627a9c,
# --velo-text-primary #4c6589, --velo-text-secondary rgba(76,101,137,.7),
# --velo-text-muted rgba(76,101,137,.5), --space-5 24px, --text-2xl 50px,
# --text-base 18px, --text-sm 15px, --velo-content-width 336px,
# --velo-size-50 50px, --velo-shadow-glow, --radius-full). A change to
# variables.css will NOT reach this page and will not complain.
#
# The mandala ring is deliberately absent: it is a 65 KB raster living in the
# frontend bundle, and inlining it base64 would take this page from ~4 KB to
# ~90 KB -- against the instant-page reason the landing is server-rendered at
# all. The vector wordmark is inlined instead (frontend/public/icons/
# velo-word-blue.svg, viewBox cropped to the path's own bounding box). The
# font is the same Google Fonts link the SPA uses, which depends on no host
# of ours.

public_router = APIRouter(tags=["public"])

# frontend/public/icons/velo-word-blue.svg -- one path, inlined verbatim.
_VELO_WORDMARK_PATH = (
    "m160.12 238.04c0.402-1.206 0.854-1.943 1.357-2.211 0.535-0.301 1.038-0.4"
    "52 1.507-0.452s0.837 0.134 1.105 0.402c0.301 0.268 0.452 0.586 0.452 0.9"
    "54 0 0.402-0.084 0.821-0.251 1.256l-10.952 30.997c-0.268 0.771-0.687 1.3"
    "07-1.256 1.608-0.569 0.268-1.206 0.402-1.909 0.402-0.603 0-1.206-0.134-1"
    ".809-0.402-0.569-0.268-0.971-0.737-1.205-1.407l-10.802-30.846c-0.134-0.3"
    "68-0.201-0.737-0.201-1.105 0-0.503 0.168-0.938 0.503-1.306 0.335-0.369 0"
    ".887-0.553 1.658-0.553 0.469 0 1.055 0.151 1.758 0.452 0.737 0.268 1.306"
    " 1.005 1.708 2.211l8.943 27.279h0.301l9.093-27.279zm29.938 6.078c-0.938 "
    "0-1.658-0.234-2.16-0.703-0.502-0.502-0.754-1.356-0.754-2.562v-2.813h-11."
    "906v13.162h10.55c0.469 0 0.821 0.151 1.055 0.452 0.234 0.268 0.352 0.586"
    " 0.352 0.955 0 0.335-0.151 0.653-0.452 0.954-0.268 0.268-0.587 0.402-0.9"
    "55 0.402h-10.55v14.368h12.66v-2.813c0-1.206 0.251-2.043 0.754-2.512 0.50"
    "2-0.502 1.222-0.753 2.16-0.753 1.44 0 2.16 0.837 2.16 2.511v4.371c0 0.73"
    "7-0.268 1.239-0.804 1.507-0.502 0.235-1.239 0.352-2.21 0.352h-17.835c-1."
    "54 0-2.311-0.837-2.311-2.512v-30.595c0-1.675 0.771-2.512 2.311-2.512h17."
    "081c0.971 0 1.708 0.117 2.211 0.352 0.536 0.234 0.804 0.736 0.804 1.507v"
    "4.371c0 1.674-0.721 2.511-2.161 2.511zm30.675 17.483c1.44 0 2.16 0.838 2"
    ".16 2.512v5.275c0 0.603-0.268 1.022-0.803 1.256-0.503 0.235-1.24 0.352-2"
    ".211 0.352h-16.579c-1.54 0-2.311-0.837-2.311-2.512v-30.595c0-0.938 0.168"
    "-1.591 0.503-1.959 0.368-0.369 0.938-0.553 1.708-0.553 2.143 0 3.215 1.2"
    "89 3.215 3.868v29.088h11.404v-3.466c0-1.206 0.251-2.043 0.754-2.512 0.50"
    "2-0.502 1.222-0.754 2.16-0.754zm41.11-8.59c0 3.717-0.637 6.966-1.909 9.7"
    "46-1.24 2.746-3.082 4.89-5.527 6.43-2.445 1.541-5.476 2.311-9.093 2.311-"
    "3.717 0-6.815-0.77-9.294-2.311-2.445-1.54-4.27-3.7-5.476-6.48s-1.808-6.0"
    "29-1.808-9.747c0-3.684 0.602-6.899 1.808-9.645 1.206-2.747 3.031-4.89 5."
    "476-6.431 2.479-1.541 5.593-2.311 9.344-2.311 3.584 0 6.598 0.77 9.043 2"
    ".311 2.445 1.507 4.287 3.651 5.527 6.431 1.272 2.746 1.909 5.978 1.909 9"
    ".696zm-28.335 0c0 4.521 0.955 8.088 2.864 10.7 1.909 2.579 4.89 3.869 8."
    "942 3.869 4.086 0 7.067-1.29 8.943-3.869 1.875-2.612 2.813-6.179 2.813-1"
    "0.7 0-4.522-0.938-8.055-2.813-10.601-1.876-2.579-4.84-3.868-8.893-3.868-"
    "4.052 0-7.05 1.289-8.992 3.868-1.909 2.546-2.864 6.079-2.864 10.601zm4.2"
    "2 1.708v-3.919h15.172v3.919h-15.172z"
)

_RU_MONTHS_GENITIVE = (
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
)


def _format_practice_when(practice: Practice) -> str:
    """"14 августа в 19:30" in the PRACTICE's own timezone -- the one the
    master scheduled it in, which is the time everyone in the channel is
    talking about. Falls back to UTC if the stored zone is unknown, rather
    than failing to render a page over a formatting detail."""
    try:
        zone = ZoneInfo(practice.timezone)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo("UTC")
    local = practice.scheduled_at.astimezone(zone)
    return (
        f"{local.day} {_RU_MONTHS_GENITIVE[local.month - 1]} "
        f"в {local:%H:%M}"
    )


def _public_page(
    *,
    title: str,
    message: str,
    status_code: int,
    og_title: str | None = None,
    og_description: str | None = None,
    primary: tuple[str, str] | None = None,
    secondary: tuple[str, str] | None = None,
    hint: str | None = None,
) -> HTMLResponse:
    """The ONE page this router serves, in every state it has.

    og tags are emitted only when a caller passes them: a code naming nothing
    has nothing to describe, and inventing a description there would be a
    preview card for a practice that does not exist.

    Every interpolated value goes through html.escape -- a practice title is
    master-supplied text, and this is the first place in this system where
    such text is rendered as HTML rather than handed to a JSON client.
    """
    og = ""
    if og_title is not None:
        og = (
            f'<meta property="og:type" content="website">'
            f'<meta property="og:title" content="{html.escape(og_title)}">'
            f'<meta property="og:description" '
            f'content="{html.escape(og_description or "")}">'
        )
    buttons = ""
    for target, (href, label) in (
        ("primary", primary or ("", "")),
        ("secondary", secondary or ("", "")),
    ):
        if not href:
            continue
        buttons += (
            f'<a class="btn btn--{target}" href="{html.escape(href)}" '
            f'rel="noopener">{html.escape(label)}</a>'
        )
    hint_html = (
        f'<p class="hint">{html.escape(hint)}</p>' if hint else ""
    )
    return HTMLResponse(
        status_code=status_code,
        content=(
            "<!doctype html><html lang='ru'><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            f"<title>{html.escape(title)}</title>"
            f"{og}"
            "<link rel='preconnect' href='https://fonts.googleapis.com'>"
            "<link rel='preconnect' href='https://fonts.gstatic.com' crossorigin>"
            "<link rel='stylesheet' href='https://fonts.googleapis.com/css2"
            "?family=Marmelad&display=swap'>"
            "<style>"
            "*{box-sizing:border-box}"
            "body{margin:0;min-height:100vh;display:flex;flex-direction:column;"
            "align-items:center;justify-content:center;padding:24px;"
            "background:#ffffff;color:#4c6589;text-align:center;"
            "font-family:'Marmelad','Noto Sans',sans-serif}"
            ".mark{width:180px;margin-bottom:8px}"
            ".title{font-size:50px;font-weight:400;letter-spacing:.02em;"
            "margin:0 0 16px}"
            # pre-line, not the default: callers pass "\n" between the
            # practice title and its time (see the landing endpoint), and
            # without this HTML collapses that newline into a space --
            # title and time ran together on one line.
            ".msg{font-size:18px;color:rgba(76,101,137,.7);margin:0 0 33px;"
            "max-width:320px;line-height:1.5;white-space:pre-line}"
            ".btn{display:inline-flex;align-items:center;justify-content:center;"
            "width:100%;max-width:336px;height:50px;font-size:18px;"
            "text-decoration:none;border-radius:9999px;"
            "border:1px solid #ffffff;box-shadow:0 0 20.9px 7px #ffffff;"
            "margin-bottom:12px}"
            ".btn--primary{background:#627a9c;color:#ffffff}"
            ".btn--secondary{background:#ffffff;color:#4c6589;"
            "border:1px solid rgba(76,101,137,.25);box-shadow:none}"
            ".hint{font-size:15px;color:rgba(76,101,137,.5);margin:16px 0 0;"
            "max-width:280px;line-height:1.4}"
            "</style></head><body>"
            "<svg class='mark' viewBox='134 232 130 42' fill='#4c6589' "
            "xmlns='http://www.w3.org/2000/svg' aria-hidden='true'>"
            f"<path d='{_VELO_WORDMARK_PATH}'/></svg>"
            "<h1 class='title'>VEL\u0398</h1>"
            f"<p class='msg'>{html.escape(message)}</p>"
            f"{buttons}{hint_html}"
            "</body></html>"
        ),
        # A narrow CSP for the ONLY HTML this backend serves. Everything the
        # page needs is enumerated, and nothing else is allowed: no scripts
        # at all (there are none), styles inline plus Google Fonts, fonts
        # from gstatic. `form-action 'none'` and `base-uri 'none'` cost
        # nothing here and remove two classes of injection outright, should
        # a future edit ever put unescaped text into this markup.
        #
        # Scoped to this response rather than set in nginx on purpose: the
        # SPA needs a different policy, and one policy loose enough for both
        # protects neither.
        headers={
            "Content-Security-Policy": (
                "default-src 'none'; "
                "style-src 'unsafe-inline' https://fonts.googleapis.com; "
                "font-src https://fonts.gstatic.com; "
                "img-src 'self' data:; "
                "form-action 'none'; base-uri 'none'"
            ),
            "X-Content-Type-Options": "nosniff",
        },
    )


def _not_a_link_page() -> HTMLResponse:
    """404 for a code that names nothing: garbage, or a practice that is
    draft/deleted. NO og tags -- there is nothing truthful to describe, and
    the title of an unpublished practice must not leak to anyone holding a
    URL. The two cases are answered identically on purpose: distinguishing
    them would turn this route into an existence oracle."""
    return _public_page(
        title="Ссылка не найдена",
        message="Эта ссылка не работает. Возможно, практику удалили "
                "или ссылка скопирована не полностью.",
        status_code=status.HTTP_404_NOT_FOUND,
    )


async def _load_public_practice(
    code: str, session: AsyncSession,
) -> Practice | None:
    """code -> practice, or None for every "no such link" case.

    decode_practice_code rejects wrong length and wrong charset WITHOUT
    touching the database -- a scan of malformed codes never reaches
    Postgres. A well-formed code naming no row is a normal miss.
    """
    from app.modules.zoom.service import decode_practice_code, is_publicly_resolvable

    practice_id = decode_practice_code(code)
    if practice_id is None:
        return None
    practice = (
        await session.execute(select(Practice).where(Practice.id == practice_id))
    ).scalar_one_or_none()
    if practice is None or not is_publicly_resolvable(practice):
        return None
    return practice


@public_router.get("/z/{code}")
async def public_practice_landing_endpoint(
    code: str,
    session: AsyncSession = Depends(get_db_reader),
) -> Response:
    """The page behind every link that leaves this system.

    ANONYMOUS BY CONSTRUCTION. A plain browser navigation carries no
    initData, so this route has no idea who is asking -- and therefore
    CANNOT hand out a personal link, no matter how it is reached. That is
    the entire security property of the wrapper: a URL forwarded out of a
    channel is not a skeleton key to somebody else's attendance. It is
    enforced by resolve_zoom_entry receiving user=None, not by a rule.

    Status codes (T-35): 404 means "no such link"; 200 means "the link is
    real, here is its state". Telegram only renders a preview card for 200,
    which is why an honest state page still returns 200.
    """
    from app.modules.zoom.service import ZoomEntryKind, resolve_zoom_entry

    practice = await _load_public_practice(code, session)
    if practice is None:
        return _not_a_link_page()

    resolution = await resolve_zoom_entry(practice, None, session)
    when = _format_practice_when(practice)
    master_name = await get_master_display_name(practice.master_id, session)
    deep_link = f"{settings.telegram_bot_url}?startapp=zoom__{code}"

    if resolution.kind == ZoomEntryKind.CANCELLED:
        # og:description carries the CANCELLATION, not the schedule: a
        # crawler arriving after the cancellation would otherwise paint a
        # card for a live practice over an honest page.
        return _public_page(
            title=practice.title,
            message="Практика отменена.",
            status_code=status.HTTP_200_OK,
            og_title=practice.title,
            og_description=f"Практика отменена. Мастер: {master_name}.",
            primary=(deep_link, "Открыть VELO"),
            hint="Другие практики — в приложении.",
        )

    og_description = f"{when}. Мастер: {master_name}."

    # GUEST with no url is the minting miss (ensure_shared_registrant is
    # best-effort and the retry poller does not cover it -- fixing that is
    # explicitly out of scope). It is NOT 'failed': the meeting exists, only
    # the guest seat in it does not. Either way the honest answer is the same
    # sentence, and the app button still works.
    guest_available = (
        resolution.kind == ZoomEntryKind.GUEST and resolution.url is not None
    )
    if guest_available:
        return _public_page(
            title=practice.title,
            message=f"{practice.title}\n{when}",
            status_code=status.HTTP_200_OK,
            og_title=practice.title,
            og_description=og_description,
            primary=(deep_link, "Открыть VELO"),
            secondary=(f"/z/{code}/guest", "Войти гостем"),
            hint="Если вы записаны на практику, откройте её в приложении — "
                 "так посещение будет засчитано.",
        )

    return _public_page(
        title=practice.title,
        message=f"{practice.title}\n{when}",
        status_code=status.HTTP_200_OK,
        og_title=practice.title,
        og_description=og_description,
        primary=(deep_link, "Открыть VELO"),
        hint="Гостевой вход сейчас недоступен — откройте практику "
             "в приложении.",
    )


@public_router.get("/z/{code}/guest")
async def public_practice_guest_endpoint(
    code: str,
    session: AsyncSession = Depends(get_db_reader),
) -> Response:
    """The guest button's target: 307 straight into Zoom.

    The raw Zoom URL exists here ONLY as the Location header of one response
    -- it is in no page body and in no JSON anywhere in this system. The hop
    itself is unavoidable; the browser has to reach zoom.us somehow. Same
    shape as zoom_start_redirect_endpoint above, Referrer-Policy included so
    zoom.us is not handed the shape of our route.

    Anonymous, like the landing: resolve_zoom_entry is called with user=None,
    so this endpoint cannot return a personal link even by mistake.
    """
    from app.modules.zoom.service import ZoomEntryKind, resolve_zoom_entry

    practice = await _load_public_practice(code, session)
    if practice is None:
        return _not_a_link_page()

    resolution = await resolve_zoom_entry(practice, None, session)
    # The https:// guard matches the two siblings in zoom/service.py that
    # hand out Zoom URLs (get_host_start_url, get_meeting_recording_link):
    # a stored value that is not an https URL is treated as absent rather
    # than redirected to. The value comes from Zoom, so this is
    # defence-in-depth -- but an inconsistency inside one feature is worse
    # than no guard at all, because the next reader has to work out which
    # of the three places is right.
    usable = (
        resolution.kind == ZoomEntryKind.GUEST
        and isinstance(resolution.url, str)
        and resolution.url.startswith("https://")
    )
    if not usable:
        # The landing would not have shown this button in these states; a
        # hand-typed or stale URL can still arrive here.
        return _public_page(
            title=practice.title,
            message="Гостевой вход сейчас недоступен.",
            status_code=status.HTTP_200_OK,
            og_title=practice.title,
            og_description=f"{_format_practice_when(practice)}.",
            primary=(
                f"{settings.telegram_bot_url}?startapp=zoom__{code}",
                "Открыть VELO",
            ),
        )

    return RedirectResponse(
        url=resolution.url,
        status_code=status.HTTP_307_TEMPORARY_REDIRECT,
        headers={"Referrer-Policy": "no-referrer"},
    )
