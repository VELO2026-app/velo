# =============================================================================
# VELO Backend -- Master Groups Service (P1, ПРОМТ №590)
# =============================================================================
#
# Group CRUD + membership + per-student tag/block. Two virtual groups
# ("students" / "deleted") are computed live, never rows -- see
# groups_models.py's module docstring.
#
# BLOCK -> REFUND (recon-first, per the PROMPT): reuses
# payments/refund.py's refund_booking() exactly as
# refund_all_bookings_for_practice() (a MASTER-initiated cancel) already
# does -- cancelled_by_master=True, unconditional 100% refund, no new
# money-movement code. bookings/service.py's recalculate_participants() is
# reused for the same reason cancel_booking() calls it.
#
# SESSION RULES: no session.commit() here (P-01) -- the router flushes.
# =============================================================================

import secrets
from datetime import UTC, datetime
from uuid import UUID

import structlog
from sqlalchemy import and_, delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import (
    BadRequestError,
    ConflictError,
    ForbiddenError,
    NotFoundError,
    VeloError,
)
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.bookings.service import recalculate_participants
from app.modules.masters.groups_models import (
    GroupInvite,
    MasterGroup,
    MasterGroupMembership,
    MasterStudent,
)
from app.modules.payments.refund import refund_booking
from app.modules.practices.models import Practice
from app.modules.users.helpers import display_name
from app.modules.users.models import User

logger = structlog.get_logger()

SYSTEM_GROUP_STUDENTS = "students"
SYSTEM_GROUP_DELETED = "deleted"
_SYSTEM_SLUGS = frozenset({SYSTEM_GROUP_STUDENTS, SYSTEM_GROUP_DELETED})

_GROUP_NAME_STUDENTS = "Ученики"
_GROUP_NAME_DELETED = "Удалённые"


# ===========================================================================
# Derived ("Ученики") / blocked ("Удалённые") base queries
# ===========================================================================


def _derived_students_base(master_id: UUID):
    """Same join shape as students_service.list_master_students, widened
    (owner Q2=A): ANY non-cancelled booking counts (not ATTENDED-only), and
    anyone MasterStudent.blocked_at'd is excluded. The outer join to
    MasterStudent + `blocked_at IS NULL` correctly covers BOTH "no
    master_student row at all" and "row exists but not blocked" -- NULL
    from the outer join and a genuine NULL blocked_at both satisfy IS NULL.
    """
    return (
        select(User, func.count(Booking.id).label("practices_count"))
        .join(Booking, Booking.user_id == User.id)
        .join(Practice, Booking.practice_id == Practice.id)
        .outerjoin(
            MasterStudent,
            and_(
                MasterStudent.master_id == master_id,
                MasterStudent.student_user_id == User.id,
            ),
        )
        .where(
            Practice.master_id == master_id,
            Booking.status != BookingStatus.CANCELLED.value,
            MasterStudent.blocked_at.is_(None),
        )
        .group_by(User.id)
    )


async def _tags_map(
    master_id: UUID, student_ids: list[UUID], session: AsyncSession,
) -> dict[UUID, str | None]:
    """Batched student_id -> tag lookup for a page of results (mirrors
    students_service._needs_attention_map's shape)."""
    if not student_ids:
        return {}
    stmt = select(MasterStudent.student_user_id, MasterStudent.tag).where(
        MasterStudent.master_id == master_id,
        MasterStudent.student_user_id.in_(student_ids),
    )
    rows = (await session.execute(stmt)).all()
    return {sid: tag for sid, tag in rows}


async def count_derived_students(master_id: UUID, session: AsyncSession) -> int:
    """Total size of the virtual "Ученики" group."""
    stmt = select(func.count()).select_from(
        _derived_students_base(master_id).order_by(None).subquery()
    )
    return (await session.execute(stmt)).scalar_one()


async def count_blocked_students(master_id: UUID, session: AsyncSession) -> int:
    """Total size of the virtual "Удалённые" group."""
    stmt = select(func.count(MasterStudent.id)).where(
        MasterStudent.master_id == master_id,
        MasterStudent.blocked_at.is_not(None),
    )
    return (await session.execute(stmt)).scalar_one()


async def count_group_members(group_id: UUID, session: AsyncSession) -> int:
    """Membership count for one CUSTOM group."""
    stmt = select(func.count(MasterGroupMembership.id)).where(
        MasterGroupMembership.group_id == group_id,
    )
    return (await session.execute(stmt)).scalar_one()


async def _list_derived_students(
    master_id: UUID,
    session: AsyncSession,
    *,
    search: str | None,
    limit: int,
    offset: int,
) -> tuple[list[dict], int]:
    base = _derived_students_base(master_id)

    if search:
        full_name = func.concat(
            func.coalesce(User.first_name, ""), " ", func.coalesce(User.last_name, ""),
        )
        base = base.where(full_name.ilike(f"%{search}%"))

    total = (
        await session.execute(
            select(func.count()).select_from(base.order_by(None).subquery())
        )
    ).scalar_one()

    rows = (
        await session.execute(
            base.order_by(func.count(Booking.id).desc(), User.id)
            .limit(limit)
            .offset(offset)
        )
    ).all()

    page_ids = [user.id for user, _count in rows]
    tags = await _tags_map(master_id, page_ids, session)

    items = [
        {
            "id": user.id,
            "name": display_name(user.first_name, user.last_name),
            "avatar_url": user.avatar_url,
            "tag": tags.get(user.id),
        }
        for user, _count in rows
    ]
    return items, total


async def _list_blocked_students(
    master_id: UUID,
    session: AsyncSession,
    *,
    search: str | None,
    limit: int,
    offset: int,
) -> tuple[list[dict], int]:
    base = (
        select(User, MasterStudent.tag, MasterStudent.blocked_at)
        .join(MasterStudent, MasterStudent.student_user_id == User.id)
        .where(
            MasterStudent.master_id == master_id,
            MasterStudent.blocked_at.is_not(None),
        )
    )

    if search:
        full_name = func.concat(
            func.coalesce(User.first_name, ""), " ", func.coalesce(User.last_name, ""),
        )
        base = base.where(full_name.ilike(f"%{search}%"))

    total = (
        await session.execute(
            select(func.count()).select_from(base.order_by(None).subquery())
        )
    ).scalar_one()

    rows = (
        await session.execute(
            base.order_by(MasterStudent.blocked_at.desc(), User.id)
            .limit(limit)
            .offset(offset)
        )
    ).all()

    items = [
        {
            "id": user.id,
            "name": display_name(user.first_name, user.last_name),
            "avatar_url": user.avatar_url,
            "tag": tag,
        }
        for user, tag, _blocked_at in rows
    ]
    return items, total


async def _list_custom_group_members(
    group: MasterGroup,
    master_id: UUID,
    session: AsyncSession,
    *,
    search: str | None,
    limit: int,
    offset: int,
) -> tuple[list[dict], int]:
    base = (
        select(User, MasterGroupMembership.added_at, MasterStudent.tag)
        .join(MasterGroupMembership, MasterGroupMembership.student_user_id == User.id)
        .outerjoin(
            MasterStudent,
            and_(
                MasterStudent.master_id == master_id,
                MasterStudent.student_user_id == User.id,
            ),
        )
        .where(MasterGroupMembership.group_id == group.id)
    )

    if search:
        full_name = func.concat(
            func.coalesce(User.first_name, ""), " ", func.coalesce(User.last_name, ""),
        )
        base = base.where(full_name.ilike(f"%{search}%"))

    total = (
        await session.execute(
            select(func.count()).select_from(base.order_by(None).subquery())
        )
    ).scalar_one()

    rows = (
        await session.execute(
            base.order_by(MasterGroupMembership.added_at.desc(), User.id)
            .limit(limit)
            .offset(offset)
        )
    ).all()

    items = [
        {
            "id": user.id,
            "name": display_name(user.first_name, user.last_name),
            "avatar_url": user.avatar_url,
            "tag": tag,
        }
        for user, _added_at, tag in rows
    ]
    return items, total


# ===========================================================================
# GET /masters/me/groups -- list (virtual + custom)
# ===========================================================================


async def list_master_groups(master_id: UUID, session: AsyncSession) -> list[dict]:
    """«Ученики» first (always present), custom groups by created_at,
    «Удалённые» LAST and omitted entirely when its count is 0."""
    items: list[dict] = []

    students_count = await count_derived_students(master_id, session)
    items.append(
        {
            "id": SYSTEM_GROUP_STUDENTS,
            "kind": "students",
            "name": _GROUP_NAME_STUDENTS,
            "members_count": students_count,
        }
    )

    custom_groups = (
        await session.execute(
            select(MasterGroup)
            .where(MasterGroup.master_id == master_id)
            .order_by(MasterGroup.created_at)
        )
    ).scalars().all()

    group_ids = [g.id for g in custom_groups]
    member_counts: dict[UUID, int] = {}
    if group_ids:
        rows = (
            await session.execute(
                select(
                    MasterGroupMembership.group_id,
                    func.count(MasterGroupMembership.id),
                )
                .where(MasterGroupMembership.group_id.in_(group_ids))
                .group_by(MasterGroupMembership.group_id)
            )
        ).all()
        member_counts = dict(rows)

    for g in custom_groups:
        items.append(
            {
                "id": str(g.id),
                "kind": "custom",
                "name": g.name,
                "members_count": member_counts.get(g.id, 0),
            }
        )

    deleted_count = await count_blocked_students(master_id, session)
    if deleted_count > 0:
        items.append(
            {
                "id": SYSTEM_GROUP_DELETED,
                "kind": "deleted",
                "name": _GROUP_NAME_DELETED,
                "members_count": deleted_count,
            }
        )

    return items


# ===========================================================================
# Custom group CRUD
# ===========================================================================


async def _get_custom_group_or_404(
    master_id: UUID, group_id_str: str, session: AsyncSession,
) -> MasterGroup:
    """Resolve a path {id} to a CUSTOM group owned by this master.

    Rejects the two system slugs with BadRequestError (400) -- callers that
    accept a system slug (list_group_members) check for it BEFORE calling
    this helper, so reaching here always means "must be a real custom
    group".
    """
    if group_id_str in _SYSTEM_SLUGS:
        raise BadRequestError("This action is not allowed on a system group")
    try:
        group_id = UUID(group_id_str)
    except ValueError:
        raise NotFoundError("Group not found") from None

    # P-08: 404 (not the target master's group) -- never reveal existence
    # of another master's group.
    group = (
        await session.execute(
            select(MasterGroup).where(
                MasterGroup.id == group_id, MasterGroup.master_id == master_id,
            )
        )
    ).scalar_one_or_none()
    if group is None:
        raise NotFoundError("Group not found")
    return group


async def create_group(
    master_id: UUID, name: str, session: AsyncSession,
) -> MasterGroup:
    existing = (
        await session.execute(
            select(MasterGroup).where(
                MasterGroup.master_id == master_id, MasterGroup.name == name,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise ConflictError(f"A group named '{name}' already exists")

    group = MasterGroup(master_id=master_id, name=name)
    try:
        async with session.begin_nested():
            session.add(group)
            await session.flush()
    except IntegrityError:
        # Lost a concurrent create-with-the-same-name race -- the unique
        # index is the real guard, the SELECT above is just the fast path
        # (same discipline as practices/service.py's dup-guard).
        raise ConflictError(f"A group named '{name}' already exists") from None
    return group


async def rename_group(
    master_id: UUID, group_id_str: str, name: str, session: AsyncSession,
) -> MasterGroup:
    group = await _get_custom_group_or_404(master_id, group_id_str, session)
    if group.name == name:
        return group

    dup = (
        await session.execute(
            select(MasterGroup).where(
                MasterGroup.master_id == master_id, MasterGroup.name == name,
            )
        )
    ).scalar_one_or_none()
    if dup is not None:
        raise ConflictError(f"A group named '{name}' already exists")

    group.name = name
    try:
        async with session.begin_nested():
            await session.flush()
    except IntegrityError:
        raise ConflictError(f"A group named '{name}' already exists") from None
    return group


async def delete_group(
    master_id: UUID, group_id_str: str, session: AsyncSession,
) -> None:
    group = await _get_custom_group_or_404(master_id, group_id_str, session)
    await session.delete(group)
    await session.flush()


# ===========================================================================
# Membership
# ===========================================================================


async def list_group_members(
    master_id: UUID,
    group_id_str: str,
    session: AsyncSession,
    *,
    search: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> tuple[list[dict], int]:
    if group_id_str == SYSTEM_GROUP_STUDENTS:
        return await _list_derived_students(
            master_id, session, search=search, limit=limit, offset=offset,
        )
    if group_id_str == SYSTEM_GROUP_DELETED:
        return await _list_blocked_students(
            master_id, session, search=search, limit=limit, offset=offset,
        )
    group = await _get_custom_group_or_404(master_id, group_id_str, session)
    return await _list_custom_group_members(
        group, master_id, session, search=search, limit=limit, offset=offset,
    )


async def add_group_member(
    master_id: UUID, group_id_str: str, student_user_id: UUID, session: AsyncSession,
) -> None:
    """Add-access, not move (owner-settled): the student keeps every other
    group/virtual membership they already have."""
    group = await _get_custom_group_or_404(master_id, group_id_str, session)

    student = await session.get(User, student_user_id)
    if student is None:
        raise NotFoundError("Student not found")

    existing = (
        await session.execute(
            select(MasterGroupMembership).where(
                MasterGroupMembership.group_id == group.id,
                MasterGroupMembership.student_user_id == student_user_id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return  # already a member -- idempotent no-op

    membership = MasterGroupMembership(
        group_id=group.id, student_user_id=student_user_id,
    )
    try:
        async with session.begin_nested():
            session.add(membership)
            await session.flush()
    except IntegrityError:
        # Lost a concurrent add race -- already a member either way.
        pass


async def remove_group_member(
    master_id: UUID, group_id_str: str, student_user_id: UUID, session: AsyncSession,
) -> None:
    """Remove from a CUSTOM group. Removing from "Ученики" is BLOCK (a
    separate endpoint); "Удалённые" is UNBLOCK -- both rejected here via
    _get_custom_group_or_404's system-slug guard."""
    group = await _get_custom_group_or_404(master_id, group_id_str, session)
    await session.execute(
        delete(MasterGroupMembership).where(
            MasterGroupMembership.group_id == group.id,
            MasterGroupMembership.student_user_id == student_user_id,
        )
    )


# ===========================================================================
# Per-student tag
# ===========================================================================


async def _get_or_none_master_student(
    master_id: UUID, student_user_id: UUID, session: AsyncSession,
) -> MasterStudent | None:
    return (
        await session.execute(
            select(MasterStudent)
            .where(
                MasterStudent.master_id == master_id,
                MasterStudent.student_user_id == student_user_id,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()


async def set_student_tag(
    master_id: UUID, student_user_id: UUID, tag: str | None, session: AsyncSession,
) -> str | None:
    """Upsert (or clear) the single tag for this (master, student) pair.

    ONE tag per student (owner Q1=A) -- this REPLACES, never appends.
    Clearing to null deletes the row entirely UNLESS the student is also
    blocked (the row must persist for the block to keep meaning anything).
    """
    student = await session.get(User, student_user_id)
    if student is None:
        raise NotFoundError("Student not found")

    row = await _get_or_none_master_student(master_id, student_user_id, session)

    if tag is None:
        if row is None:
            return None
        if row.blocked_at is not None:
            row.tag = None
            await session.flush()
            return None
        await session.delete(row)
        await session.flush()
        return None

    if row is None:
        row = MasterStudent(
            master_id=master_id, student_user_id=student_user_id, tag=tag,
        )
        session.add(row)
    else:
        row.tag = tag
    await session.flush()
    return tag


# ===========================================================================
# Block / unblock
# ===========================================================================


async def block_student(
    master_id: UUID, student_user_id: UUID, session: AsyncSession,
) -> dict:
    """Block a student: set blocked_at, drop them from every custom group,
    and cancel+refund their FUTURE confirmed bookings on this master's
    practices.

    Money movement REUSES refund_booking() (payments/refund.py) exactly as
    refund_all_bookings_for_practice() already does for a master-initiated
    cancel -- cancelled_by_master=True, unconditional 100% refund. No new
    ledger-writing code.
    """
    student = await session.get(User, student_user_id)
    if student is None:
        raise NotFoundError("Student not found")

    now = datetime.now(UTC)

    row = await _get_or_none_master_student(master_id, student_user_id, session)
    if row is None:
        row = MasterStudent(master_id=master_id, student_user_id=student_user_id)
        session.add(row)
        await session.flush()
    row.blocked_at = now

    # Drop from ALL this master's custom groups.
    await session.execute(
        delete(MasterGroupMembership).where(
            MasterGroupMembership.student_user_id == student_user_id,
            MasterGroupMembership.group_id.in_(
                select(MasterGroup.id).where(MasterGroup.master_id == master_id)
            ),
        )
    )

    # Cancel + refund FUTURE CONFIRMED bookings on this master's practices.
    future_rows = (
        await session.execute(
            select(Booking, Practice)
            .join(Practice, Booking.practice_id == Practice.id)
            .where(
                Practice.master_id == master_id,
                Booking.user_id == student_user_id,
                Booking.status == BookingStatus.CONFIRMED.value,
                Practice.scheduled_at > now,
            )
            .with_for_update(of=Booking)
        )
    ).all()

    cancelled_count = 0
    touched_practice_ids: set[UUID] = set()
    for booking, practice in future_rows:
        booking.status = BookingStatus.CANCELLED.value
        booking.cancelled_at = now
        booking.cancellation_reason = "Blocked by master"
        await refund_booking(
            booking=booking,
            practice=practice,
            session=session,
            cancelled_by_master=True,
        )
        touched_practice_ids.add(practice.id)
        cancelled_count += 1

    for practice_id in touched_practice_ids:
        await recalculate_participants(practice_id, session)

    await session.flush()

    logger.info(
        "master_student_blocked",
        master_id=str(master_id),
        student_user_id=str(student_user_id),
        cancelled_bookings_count=cancelled_count,
    )

    return {"blocked_at": now, "cancelled_bookings_count": cancelled_count}


async def unblock_student(
    master_id: UUID, student_user_id: UUID, session: AsyncSession,
) -> None:
    """Clear blocked_at. The student returns to «Ученики» automatically
    (derived). Custom-group memberships are NOT restored (owner-settled).
    The tag is kept -- the row is only deleted if there is no tag either.
    """
    row = await _get_or_none_master_student(master_id, student_user_id, session)
    if row is None or row.blocked_at is None:
        raise NotFoundError("Student is not blocked")

    row.blocked_at = None
    if row.tag is None:
        await session.delete(row)
    await session.flush()

    logger.info(
        "master_student_unblocked",
        master_id=str(master_id),
        student_user_id=str(student_user_id),
    )


# ===========================================================================
# P3 addenda (ПРОМТ №592): tag palette + a student's custom groups
# ===========================================================================


async def list_distinct_tags(master_id: UUID, session: AsyncSession) -> list[str]:
    """GET /masters/me/tags -- every distinct tag this master has used,
    alphabetical. Closes the P2 palette-source gap (AddTagSheet used to
    derive its palette from whatever page of members happened to be
    loaded)."""
    stmt = (
        select(MasterStudent.tag)
        .where(
            MasterStudent.master_id == master_id,
            MasterStudent.tag.is_not(None),
        )
        .distinct()
        .order_by(MasterStudent.tag)
    )
    return list((await session.execute(stmt)).scalars().all())


async def list_student_custom_groups(
    master_id: UUID, student_user_id: UUID, session: AsyncSession,
) -> list[MasterGroup]:
    """GET /masters/me/students/{id}/groups -- the CUSTOM groups this
    student is in for this master (powers the profile's group chips).
    Never includes the two virtuals -- they aren't membership rows."""
    stmt = (
        select(MasterGroup)
        .join(
            MasterGroupMembership,
            MasterGroupMembership.group_id == MasterGroup.id,
        )
        .where(
            MasterGroup.master_id == master_id,
            MasterGroupMembership.student_user_id == student_user_id,
        )
        .order_by(MasterGroup.name)
    )
    return list((await session.execute(stmt)).scalars().all())


# ===========================================================================
# P4 addenda (ПРОМТ №593): group invite links
# ===========================================================================


async def get_or_create_group_invite(
    master_id: UUID, group_id_str: str, session: AsyncSession,
) -> str:
    """Create-or-return the group's reusable invite link. CUSTOM groups
    only (400 on a system slug, via _get_custom_group_or_404). Idempotent:
    a repeat call for the same group returns the SAME url -- the master
    tapping «Пригласить» again expects the link they already shared to
    still work, not a fresh one that invalidates it.

    Raises:
        VeloError 503 (bot_url_not_configured): telegram_bot_url unset
            (same guard/code as admin/masters/service.py's
            issue_master_invite -- composing a link with an empty prefix
            would be broken, not just unconfigured-looking).
    """
    if not settings.telegram_bot_url:
        raise VeloError(
            message="telegram_bot_url is not configured",
            code="bot_url_not_configured",
            status_code=503,
        )

    group = await _get_custom_group_or_404(master_id, group_id_str, session)

    existing = (
        await session.execute(
            select(GroupInvite).where(GroupInvite.group_id == group.id)
        )
    ).scalar_one_or_none()

    if existing is None:
        token = secrets.token_urlsafe(32)
        invite = GroupInvite(group_id=group.id, token=token)
        try:
            async with session.begin_nested():
                session.add(invite)
                await session.flush()
        except IntegrityError:
            # Lost a concurrent create race -- the winner's row is the
            # answer, same discipline as create_group's dup-guard.
            existing = (
                await session.execute(
                    select(GroupInvite).where(GroupInvite.group_id == group.id)
                )
            ).scalar_one()
            token = existing.token
    else:
        token = existing.token

    return f"{settings.telegram_bot_url}?startapp=group_invite__{token}"


async def join_group_by_token(
    joiner_id: UUID, token: str, session: AsyncSession,
) -> dict:
    """Resolve a group-invite token and add the joiner to that group.

    403 if the joiner is currently blocked by that group's master
    (master_student.blocked_at set) -- a block must not be bypassable by
    re-joining through an old invite link the joiner already had open.
    Idempotent: already-a-member re-joins as a silent success (same
    discipline as add_group_member).

    404 (never 403) for an unknown/garbage token -- same "don't reveal
    which case it was" posture as _get_custom_group_or_404.
    """
    invite = (
        await session.execute(select(GroupInvite).where(GroupInvite.token == token))
    ).scalar_one_or_none()
    if invite is None:
        raise NotFoundError("Invite not found")

    group = await session.get(MasterGroup, invite.group_id)
    if group is None:
        # Orphaned row -- impossible under ondelete=CASCADE, but treat
        # exactly like an unknown token rather than 500ing.
        raise NotFoundError("Invite not found")

    master = await session.get(User, group.master_id)
    if master is None:
        raise NotFoundError("Invite not found")

    blocked = (
        await session.execute(
            select(MasterStudent.blocked_at).where(
                MasterStudent.master_id == group.master_id,
                MasterStudent.student_user_id == joiner_id,
                MasterStudent.blocked_at.is_not(None),
            )
        )
    ).scalar_one_or_none()
    if blocked is not None:
        raise ForbiddenError("This master has restricted your access")

    existing = (
        await session.execute(
            select(MasterGroupMembership).where(
                MasterGroupMembership.group_id == group.id,
                MasterGroupMembership.student_user_id == joiner_id,
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        membership = MasterGroupMembership(group_id=group.id, student_user_id=joiner_id)
        try:
            async with session.begin_nested():
                session.add(membership)
                await session.flush()
        except IntegrityError:
            pass  # lost a concurrent join race -- already a member either way

    return {
        "group_id": group.id,
        "group_name": group.name,
        "master_name": display_name(master.first_name, master.last_name),
    }
