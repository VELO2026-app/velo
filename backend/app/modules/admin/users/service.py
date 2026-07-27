# =============================================================================
# VELO Backend -- Admin Users Service (Phase 3.2, updated F8-fix)
# =============================================================================
#
# Queries for admin user/master listings.
# All read-only -- use get_db_reader in router.
#
# USERS LIST:
#   Filters: role, is_active
#   Order: created_at DESC (newest first)
#
# MASTERS LIST:
#   Joins User + MasterProfile, filters by JSONB account.status.
#   Shortcuts /pending and /rejected are just status filters.
#
# F8-fix (W-1):
#   get_master_by_id() -- single master lookup by user_id.
#   Used by GET /admin/masters/{user_id} so the frontend review screen
#   can do a proper single-resource fetch instead of scanning 100 items.
# =============================================================================

import copy
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events import (  # Phase 6 / T0
    GROUP_ADMINS,
    GROUP_MASTERS,
    sync_membership_delta,
)
from app.core.exceptions import BadRequestError, ConflictError, NotFoundError
from app.modules.admin.users.schemas import (
    AdminMasterDetail,
    AdminMasterListItem,
    PaginatedMastersResponse,
    PaginatedUsersResponse,
)
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.users.models import User, UserRole
from app.modules.users.schemas import (
    UserResponse,
    credentials_without_admin_home,
    has_admin_home,
)

logger = structlog.get_logger()

# R8: countable practices for the list-card "Практик" stat -- mirrors
# masters/stats_service._NON_COUNTED_PRACTICE_STATUSES (drafts/deletes never
# ran, a cancelled practice did not take place). Duplicated locally rather
# than importing a private name across modules.
_NON_COUNTED_PRACTICE_STATUSES = (
    PracticeStatus.DRAFT.value,
    PracticeStatus.DELETED.value,
    PracticeStatus.CANCELLED.value,
)


async def list_users(
    session: AsyncSession,
    *,
    limit: int = 20,
    offset: int = 0,
    role: str | None = None,
    is_active: bool | None = None,
) -> PaginatedUsersResponse:
    """List all users with optional filters and pagination."""
    # -- Base query --
    query = select(User).order_by(User.created_at.desc())
    count_query = select(func.count(User.id))

    # -- Filters --
    if role is not None:
        try:
            role_enum = UserRole(role)
        except ValueError:
            raise BadRequestError(f"Invalid role: {role}") from None
        query = query.where(User.role == role_enum)
        count_query = count_query.where(User.role == role_enum)

    if is_active is not None:
        query = query.where(User.is_active == is_active)
        count_query = count_query.where(User.is_active == is_active)

    # -- Total count --
    total_result = await session.execute(count_query)
    total = total_result.scalar_one()

    # -- Paginated items --
    query = query.limit(limit).offset(offset)
    result = await session.execute(query)
    users = result.scalars().all()

    return PaginatedUsersResponse(
        items=[UserResponse.model_validate(u) for u in users],
        total=total,
        limit=limit,
        offset=offset,
    )


async def _practices_counts_for_masters(
    master_ids: list[UUID],
    session: AsyncSession,
) -> dict[UUID, int]:
    """Map master_id -> all-time countable-practice count, for a page.

    ONE bounded query regardless of page size (GROUP BY master_id), same
    read-model shape as practices/enrichment_service.py
    attendance_counts_for_practices. "Countable" mirrors
    masters/stats_service._count_practices: excludes
    draft/deleted/cancelled (never ran / not real sessions).
    """
    if not master_ids:
        return {}
    rows = (
        await session.execute(
            select(Practice.master_id, func.count(Practice.id))
            .where(
                Practice.master_id.in_(master_ids),
                Practice.status.notin_(_NON_COUNTED_PRACTICE_STATUSES),
            )
            .group_by(Practice.master_id)
        )
    ).all()
    return dict(rows)


async def _students_counts_for_masters(
    master_ids: list[UUID],
    session: AsyncSession,
) -> dict[UUID, int]:
    """Map master_id -> all-time DISTINCT attended-student count, for a page.

    ONE bounded query regardless of page size (GROUP BY master_id via the
    Practice join). A student is counted once per master even if they
    attended several of that master's practices.
    """
    if not master_ids:
        return {}
    rows = (
        await session.execute(
            select(
                Practice.master_id,
                func.count(func.distinct(Booking.user_id)),
            )
            .select_from(Booking)
            .join(Practice, Booking.practice_id == Practice.id)
            .where(
                Practice.master_id.in_(master_ids),
                Booking.status == BookingStatus.ATTENDED.value,
            )
            .group_by(Practice.master_id)
        )
    ).all()
    return dict(rows)


async def list_masters(
    session: AsyncSession,
    *,
    limit: int = 20,
    offset: int = 0,
    # L-04 fix: type aligned with router Literal (P-11).
    status: Literal["pending", "verified", "rejected"] | None = None,
) -> PaginatedMastersResponse:
    """List masters (users with MasterProfile) with optional status filter.

    Joins User + MasterProfile. Filters by JSONB data.account.status.
    Sequential scan on master_profiles (small table, no GIN index for MVP).

    R8: the rich-card fields on AdminMasterListItem cost at most 2 extra
    bounded queries for the WHOLE page (practices_counts + students_counts,
    both GROUP BY master_id -- no N+1). methods and available_cents are free:
    methods comes off the profile row already in hand, available_cents is a
    plain column already loaded by the join.
    """
    # -- Base query: join User + MasterProfile --
    query = (
        select(User, MasterProfile)
        .join(MasterProfile, User.id == MasterProfile.user_id)
        .order_by(MasterProfile.created_at.desc())
    )
    count_query = select(func.count(MasterProfile.user_id)).select_from(
        MasterProfile
    )

    # -- Status filter (JSONB) --
    if status is not None:
        jsonb_filter = (
            MasterProfile.data["account"]["status"].as_string() == status
        )
        query = query.where(jsonb_filter)
        count_query = count_query.where(jsonb_filter)

    # -- Total count --
    total_result = await session.execute(count_query)
    total = total_result.scalar_one()

    # -- Paginated items --
    query = query.limit(limit).offset(offset)
    result = await session.execute(query)
    rows = result.all()

    master_ids = [user.id for user, _profile in rows]
    practices_by_master = await _practices_counts_for_masters(
        master_ids, session
    )
    students_by_master = await _students_counts_for_masters(
        master_ids, session
    )

    items = [
        AdminMasterListItem(
            id=user.id,
            telegram_id=user.telegram_id,
            first_name=user.first_name,
            last_name=user.last_name,
            avatar_url=user.avatar_url,
            role=str(user.role),
            is_active=user.is_active,
            master_status=profile.data.get("account", {}).get(
                "status", "unknown"
            ),
            methods=profile.data.get("profile", {}).get("methods", []),
            practices_count=practices_by_master.get(user.id, 0),
            students_count=students_by_master.get(user.id, 0),
            available_cents=profile.available_cents,
        )
        for user, profile in rows
    ]

    return PaginatedMastersResponse(
        items=items,
        total=total,
        limit=limit,
        offset=offset,
    )


async def get_master_by_id(
    user_id: UUID,
    session: AsyncSession,
) -> AdminMasterDetail:
    """Fetch a single master by user_id, with profile detail (T3).

    Joins User + MasterProfile. Raises NotFoundError if the user has
    no MasterProfile (i.e. never applied). Carries the review-screen profile
    fields (methods / experience_years / bio) read from data.profile — additive
    over the F8-fix (W-1) list-item shape, no migration.

    Used by GET /api/v1/admin/masters/{user_id}.
    """
    stmt = (
        select(User, MasterProfile)
        .join(MasterProfile, User.id == MasterProfile.user_id)
        .where(User.id == user_id)
    )
    result = await session.execute(stmt)
    row = result.one_or_none()

    if row is None:
        raise NotFoundError("Master not found")

    user, profile = row
    prof = profile.data.get("profile", {})
    return AdminMasterDetail(
        id=user.id,
        telegram_id=user.telegram_id,
        first_name=user.first_name,
        last_name=user.last_name,
        avatar_url=user.avatar_url,
        role=str(user.role),
        is_active=user.is_active,
        master_status=profile.data.get("account", {}).get("status", "unknown"),
        methods=prof.get("methods", []),
        experience_years=prof.get("experience_years", 0),
        bio=prof.get("bio"),
        # Batch H: additional admin-editable fields (display_name = визитка;
        # email/phone/certifications admin-only, not public).
        display_name=prof.get("display_name"),
        email=prof.get("email"),
        phone=prof.get("phone"),
        languages=prof.get("languages", []),
        certifications=prof.get("certifications", []),
    )


# ---------------------------------------------------------------------------
# Explicit admin make-master (ПРОМТ №292)
# ---------------------------------------------------------------------------
# Distinct from the application-approval path (admin/masters verify_master):
# this is a direct admin grant from the all-users screen, with no prior
# application. It ports scripts/set_role.py `to_master`: create/re-verify a
# MasterProfile and set role=master. Additive JSONB, no migration.

# String stub for master-profile fields left blank on an admin grant; the
# admin can edit them later (mirrors scripts/set_role.py EDIT).
_MAKE_MASTER_EDIT = "Отредактировать"


def _admin_make_master_data(user: User) -> dict:
    """Verified MasterProfile.data for an explicit admin make-master grant.

    Mirrors scripts/set_role.py `_build_verified_data` (which mirrors
    masters/service._build_data) with account.status pre-set to 'verified'.
    Blank profile fields are stubbed; the master/admin edits them later.
    """
    now_iso = datetime.now(UTC).isoformat()
    return {
        "account": {
            "status": "verified",
            "applied_at": now_iso,
            "verification": {
                "verified_at": now_iso,
                "verified_by": "admin_make_master",
                "notes": "master granted via admin make-master",
            },
            "rejections": [],
        },
        "profile": {
            "display_name": user.first_name or _MAKE_MASTER_EDIT,
            "email": None,
            "phone": None,
            "bio": _MAKE_MASTER_EDIT,
            "methods": [],
            "experience_years": 0,
            "certifications": [],
        },
        "documents": [],
        "availability": {"is_accepting": True, "note": None},
        "settings": {
            "auto_confirm_bookings": True,
            "max_participants_default": 20,
        },
        "stats": {
            "total_practices": 0,
            "total_participants": 0,
            "avg_rating": None,
        },
        "seed": {"source": "admin_make_master", "granted_at": now_iso},
    }


async def make_master(
    user_id: UUID,
    admin: User,
    session: AsyncSession,
) -> MasterProfile:
    """Explicitly promote a user to master (admin button, ПРОМТ №292).

    Ports scripts/set_role.py `to_master`: if the user has no MasterProfile,
    create a verified one; if a non-verified profile exists, re-verify it in
    place; then set role=master and clear any switched-away-admin marker (R-1,
    credentials_without_admin_home). This is an EXPLICIT admin grant, distinct
    from verify_master (the application-approval path).

    Idempotent-reject: a user who is already a master -> 409 (already_master).
    Write session (get_db_session); the caller flushes (P-01, no commit here).
    """
    user = await session.get(User, user_id)
    if user is None:
        raise NotFoundError("User not found")

    if user.role == UserRole.MASTER:
        raise ConflictError(
            message="User is already a master", code="already_master"
        )

    profile = await session.get(MasterProfile, user_id)
    # Phase 6 / T0: master capability BEFORE this grant -- an approved
    # applicant who never self-switched arrives here already verified
    # (capability held, no delta); everyone else gains it below.
    had_master = (
        profile is not None
        and (profile.data or {}).get("account", {}).get("status") == "verified"
    )
    if profile is None:
        profile = MasterProfile(
            user_id=user_id, data=_admin_make_master_data(user)
        )
        session.add(profile)
    else:
        status = (profile.data or {}).get("account", {}).get("status")
        if status != "verified":
            # Re-verify an existing pending/rejected/suspended profile in place.
            data = copy.deepcopy(profile.data or {})
            acct = data.setdefault("account", {})
            acct["status"] = "verified"
            acct.setdefault(
                "verification",
                {
                    "verified_at": datetime.now(UTC).isoformat(),
                    "verified_by": "admin_make_master",
                    "notes": "re-verified via admin make-master",
                },
            )
            data.setdefault("availability", {})["is_accepting"] = True
            profile.set_jsonb("data", data)

    # Set role=master and clear the switched-away-admin marker (R-1): an
    # authoritative role change makes this the account's home role.
    # Phase 6 / T0: admin capability BEFORE the write -- clearing the
    # marker below (or demoting an admin-role holder) IS the drop.
    had_admin = (
        user.role == UserRole.ADMIN.value or has_admin_home(user.credentials)
    )
    user.role = UserRole.MASTER.value
    cleared = credentials_without_admin_home(user.credentials)
    if cleared != (user.credentials or {}):
        user.set_jsonb("credentials", cleared)

    # Phase 6 / T0: project both capability deltas into the comms
    # contact book, same transaction (ID-2). Master: only when the
    # profile was not verified before (see had_master above). Admin:
    # role is master now and the marker is gone -> capability is False;
    # emit iff it was held.
    await sync_membership_delta(
        session, user, group_key=GROUP_MASTERS, had=had_master, has=True
    )
    await sync_membership_delta(
        session, user, group_key=GROUP_ADMINS, had=had_admin, has=False
    )

    logger.info(
        "admin_make_master",
        admin_id=str(admin.id),
        user_id=str(user_id),
    )
    return profile
