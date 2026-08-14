# =============================================================================
# VELO Backend -- Waitlist Router (Phase 5.3 + Frontend Backlog)
# =============================================================================
#
# ENDPOINTS:
#   POST   /api/v1/practices/{id}/waitlist    -- join waitlist
#   GET    /api/v1/waitlist/me               -- my waitlist entries (Backlog)
#   DELETE /api/v1/waitlist/{id}              -- leave / decline
#   POST   /api/v1/waitlist/{id}/confirm      -- confirm spot
#
# ROUTE ORDER:
#   /me MUST come before /{waitlist_id} to avoid FastAPI parsing "me"
#   as a UUID path parameter.
#
# AUTH: get_current_user on all endpoints.
# SESSION: Mutating = get_db_session. Read = get_db_reader.
#
# BUGFIX: confirm endpoint returns JSONResponse(400) instead of raising
# when confirm_waitlist returns (entry, None). This ensures get_db_session
# commits the status changes (expired -> EXPIRED, spot taken -> WAITING).
# =============================================================================

from uuid import UUID

from fastapi import APIRouter, Depends, Query, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_reader, get_db_session
from app.modules.auth.dependencies import get_current_user
from app.modules.practices.schemas import PracticeSummary
from app.modules.users.models import User
from app.modules.waitlist.models import WaitlistStatus
from app.modules.waitlist.schemas import (
    PaginatedWaitlistResponse,
    WaitlistConfirmResponse,
    WaitlistEntryResponse,
    WaitlistWithPracticeResponse,
)
from app.modules.waitlist.service import (
    confirm_waitlist,
    join_waitlist,
    leave_waitlist,
    list_user_waitlist,
)

# Two routers: one for the nested practices path, one for direct waitlist.
practices_waitlist_router = APIRouter(
    prefix="/api/v1/practices", tags=["waitlist"],
)

waitlist_router = APIRouter(
    prefix="/api/v1/waitlist", tags=["waitlist"],
)


@practices_waitlist_router.post(
    "/{practice_id}/waitlist",
    response_model=WaitlistEntryResponse,
    status_code=status.HTTP_201_CREATED,
)
async def join_waitlist_endpoint(
    practice_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> WaitlistEntryResponse:
    """Join the waitlist for a full practice."""
    entry = await join_waitlist(user, practice_id, session)
    return WaitlistEntryResponse.model_validate(entry)


# ===================================================================
# Frontend Backlog: GET /me -- my waitlist entries (BEFORE /{id})
# ===================================================================


@waitlist_router.get(
    "/me",
    response_model=PaginatedWaitlistResponse,
)
async def list_my_waitlist_endpoint(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_reader),
    status_filter: str | None = Query(
        default=None, alias="status",
    ),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PaginatedWaitlistResponse:
    """List waitlist entries for the current user.

    Returns paginated list with embedded PracticeSummary so the
    frontend can render cards without additional API calls.

    Optional ``status`` filter (e.g. ``?status=waiting``).
    """
    items, total = await list_user_waitlist(
        user, session,
        status_filter=status_filter,
        limit=limit,
        offset=offset,
    )

    # Resolve master display names for this page. The embedded PracticeSummary
    # has no ORM source for master_name (it lives on a different row), so
    # model_validate leaves it None -> list cards showed a "Мастер" fallback.
    # Fill it here with the same helper the single-booking/detail responses use.
    # Dedup by master_id so a master repeated across the page is looked up once.
    from app.modules.masters.service import get_master_display_name

    master_names: dict[UUID, str] = {}
    for row in items:
        mid = row[1].master_id
        if mid not in master_names:
            master_names[mid] = await get_master_display_name(mid, session)

    return PaginatedWaitlistResponse(
        items=[
            WaitlistWithPracticeResponse(
                id=entry.id,
                practice_id=entry.practice_id,
                user_id=entry.user_id,
                position=entry.position,
                status=entry.status,
                joined_at=entry.joined_at,
                notified_at=entry.notified_at,
                expires_at=entry.expires_at,
                created_at=entry.created_at,
                updated_at=entry.updated_at,
                # T-35: the summary carries no Zoom URL at all any more (the
                # zoom_link column and its fail-closed gate are gone), so
                # there is nothing here for a waitlisted user to be denied.
                practice=PracticeSummary.from_practice(
                    practice,
                    master_name=master_names[practice.master_id],
                ),
            )
            for entry, practice in items
        ],
        total=total,
        limit=limit,
        offset=offset,
    )


# ===================================================================
# DELETE /{waitlist_id} -- leave / decline
# ===================================================================


@waitlist_router.delete(
    "/{waitlist_id}",
    response_model=WaitlistEntryResponse,
)
async def leave_waitlist_endpoint(
    waitlist_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> WaitlistEntryResponse:
    """Leave the waitlist or decline a spot offer."""
    entry = await leave_waitlist(waitlist_id, user, session)
    await session.flush()
    await session.refresh(entry)
    return WaitlistEntryResponse.model_validate(entry)


# ===================================================================
# POST /{waitlist_id}/confirm -- confirm spot
# ===================================================================


@waitlist_router.post(
    "/{waitlist_id}/confirm",
    response_model=WaitlistConfirmResponse,
    status_code=status.HTTP_201_CREATED,
)
async def confirm_waitlist_endpoint(
    waitlist_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> WaitlistConfirmResponse | JSONResponse:
    """Confirm a waitlist spot -- creates a booking.

    Returns 201 + booking on success.
    Returns 400 (as JSONResponse, NOT exception) when expired or spot
    taken. JSONResponse lets get_db_session commit the status changes
    (EXPIRED / back to WAITING) instead of rolling them back.
    """
    entry, booking = await confirm_waitlist(
        waitlist_id, user, session,
    )

    if booking is None:
        # Expired or spot taken -- entry status already updated.
        # Flush so get_db_session sees dirty state and commits.
        await session.flush()
        await session.refresh(entry)

        if entry.status == WaitlistStatus.EXPIRED.value:
            msg = "Waitlist offer has expired"
        else:
            # WAITING -- spot was taken by concurrent booking.
            msg = "Spot is no longer available, returned to waitlist"

        return JSONResponse(
            status_code=400,
            content={"error": "bad_request", "message": msg},
        )

    await session.flush()
    await session.refresh(entry)
    await session.refresh(booking)
    return WaitlistConfirmResponse(
        waitlist_entry=WaitlistEntryResponse.model_validate(entry),
        booking_id=booking.id,
    )
