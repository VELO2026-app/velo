# =============================================================================
# VELO Backend -- Master Students Router (E5, tag/block P1 ПРОМТ №590,
# tag-palette + per-student groups P3 ПРОМТ №592)
# =============================================================================
#
# Master-facing "my students" CRM aggregate + the per-student tag/block
# annotation (groups feature P1) + two small P3 addenda.
#
# ENDPOINTS:
#   GET    /api/v1/masters/me/students                -- searchable, paginated list
#   GET    /api/v1/masters/me/students/{id}            -- per-student detail aggregate
#   PUT    /api/v1/masters/me/students/{id}/tag        -- upsert/clear the tag
#   POST   /api/v1/masters/me/students/{id}/block      -- block, cancel/refund future
#   DELETE /api/v1/masters/me/students/{id}/block      -- unblock
#   GET    /api/v1/masters/me/tags                     -- P3: distinct tag palette
#   GET    /api/v1/masters/me/students/{id}/groups     -- P3: this student's groups
#
# Mounted as a SEPARATE router (like finance) so the dynamic /{user_id} route
# on the main masters router (single-segment) never shadows these two-segment
# /me/students* paths. The static /me/students is declared before the dynamic
# /me/students/{student_id}; the /tag, /block and /groups sub-paths never
# collide with the bare {student_id} route (different path shapes, matched by
# FastAPI on path+method). /me/tags is its own top-level static path, no
# collision with anything.
#
# AUTH: get_current_master on all endpoints (verified master only).
# SESSION: get_db_reader for every GET (read-only), get_db_session for the
# tag/block mutations (P-01 -- router flushes, service never commits).
# =============================================================================

from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db_reader, get_db_session
from app.modules.auth.dependencies import get_current_master
from app.modules.masters.groups_schemas import (
    BlockStudentResponse,
    DistinctTagsResponse,
    SetStudentTagRequest,
    StudentGroupItem,
    StudentGroupsResponse,
    StudentTagResponse,
)
from app.modules.masters.groups_service import (
    block_student,
    list_distinct_tags,
    list_student_custom_groups,
    set_student_tag,
    unblock_student,
)
from app.modules.masters.models import MasterProfile
from app.modules.masters.students_schemas import (
    PaginatedStudentsResponse,
    StudentDetailResponse,
    StudentListItem,
)
from app.modules.masters.students_service import (
    get_master_student_detail,
    list_master_students,
)
from app.modules.users.models import User

logger = structlog.get_logger()

router = APIRouter(prefix="/api/v1/masters", tags=["master-students"])


@router.get("/me/students", response_model=PaginatedStudentsResponse)
async def list_my_students_endpoint(
    search: str | None = Query(default=None, min_length=1, max_length=100),
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_reader),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PaginatedStudentsResponse:
    """List my students (users with >= 1 attended booking on my practices).

    Optional case-insensitive name search; most-attended first.
    """
    user, _profile = master_tuple
    items, total = await list_master_students(
        user.id, session, search=search, limit=limit, offset=offset,
    )
    return PaginatedStudentsResponse(
        items=[StudentListItem(**item) for item in items],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/me/students/{student_id}", response_model=StudentDetailResponse)
async def get_my_student_endpoint(
    student_id: UUID,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_reader),
) -> StudentDetailResponse:
    """Per-student detail: counts, hours, satisfaction, recent activity.

    404 if the user is not this master's student (no attended booking).
    """
    user, _profile = master_tuple
    data = await get_master_student_detail(user.id, student_id, session)
    return StudentDetailResponse(**data)


@router.put("/me/students/{student_id}/tag", response_model=StudentTagResponse)
async def set_student_tag_endpoint(
    student_id: UUID,
    body: SetStudentTagRequest,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_session),
) -> StudentTagResponse:
    """Upsert the single tag for this student (null clears it).

    404 if student_id does not resolve to an existing user.
    """
    user, _profile = master_tuple
    tag = await set_student_tag(user.id, student_id, body.tag, session)
    await session.flush()
    return StudentTagResponse(student_user_id=student_id, tag=tag)


@router.post("/me/students/{student_id}/block", response_model=BlockStudentResponse)
async def block_student_endpoint(
    student_id: UUID,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_session),
) -> BlockStudentResponse:
    """Block: sets blocked_at, drops the student from every custom group,
    and cancels+refunds their FUTURE confirmed bookings on this master's
    practices (refund via the existing refund_booking() path -- no new
    money movement). 404 if student_id does not resolve to an existing
    user.
    """
    user, _profile = master_tuple
    result = await block_student(user.id, student_id, session)
    await session.flush()
    return BlockStudentResponse(
        student_user_id=student_id,
        blocked_at=result["blocked_at"],
        cancelled_bookings_count=result["cancelled_bookings_count"],
    )


@router.delete("/me/students/{student_id}/block", status_code=204)
async def unblock_student_endpoint(
    student_id: UUID,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_session),
) -> None:
    """Unblock: clears blocked_at. The student returns to «Ученики»
    automatically (derived) -- custom-group memberships are NOT restored,
    the tag is kept. 404 if the student isn't currently blocked.
    """
    user, _profile = master_tuple
    await unblock_student(user.id, student_id, session)
    await session.flush()


@router.get("/me/tags", response_model=DistinctTagsResponse)
async def list_my_tags_endpoint(
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_reader),
) -> DistinctTagsResponse:
    """P3 addendum (ПРОМТ №592): every distinct tag this master has used,
    alphabetical. Closes the P2 tag-palette gap (AddTagSheet used to derive
    its palette from whatever page of members happened to be loaded)."""
    user, _profile = master_tuple
    tags = await list_distinct_tags(user.id, session)
    return DistinctTagsResponse(tags=tags)


@router.get("/me/students/{student_id}/groups", response_model=StudentGroupsResponse)
async def list_student_groups_endpoint(
    student_id: UUID,
    master_tuple: tuple[User, MasterProfile] = Depends(get_current_master),
    session: AsyncSession = Depends(get_db_reader),
) -> StudentGroupsResponse:
    """P3 addendum (ПРОМТ №592): the CUSTOM groups this student is in for
    this master (powers the profile's group chips). Never includes the two
    virtuals -- they aren't membership rows."""
    user, _profile = master_tuple
    groups = await list_student_custom_groups(user.id, student_id, session)
    return StudentGroupsResponse(
        groups=[StudentGroupItem(id=g.id, name=g.name) for g in groups],
    )
