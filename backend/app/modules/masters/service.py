# =============================================================================
# VELO Backend -- Master Service (updated RACE-06)
# =============================================================================
#
# Business logic for master applications.
#
# APPLY FLOW:
#   1. Check user.role == USER (masters can't reapply)
#   2. Check if MasterProfile exists:
#      a) No profile -> create with status "pending"
#      b) Profile with status "rejected" -> update data, reset to "pending"
#      c) Profile with status "pending" -> ConflictError (already pending)
#      d) Profile with status "verified" -> should not happen (role=master)
#   3. Return updated/created MasterProfile
#
# RACE CONDITION GUARD:
#   Two concurrent apply requests may both pass the SELECT check (no profile).
#   Both try INSERT with the same user_id (PK) -> one gets IntegrityError.
#   We catch IntegrityError after flush() and convert to ConflictError.
#
#   RACE-06: Reapplication path (status=rejected -> pending) now uses
#   SELECT ... FOR UPDATE. Without this, two concurrent reapplications
#   both see status=rejected and both call set_jsonb -- last write wins,
#   potentially losing rejection history from the first write.
#
# JSONB SAFETY:
#   All mutations to MasterProfile.data use set_jsonb() (from JSONBMixin).
#   NEVER assign profile.data = ... directly.
#
# PUBLIC PROFILE (Calendar iteration, S-4):
#   get_public_master_profile() builds the user-facing MasterPublicResponse
#   for GET /masters/{user_id}. Only verified masters are exposed (404
#   otherwise -- we do not reveal pending/rejected applications). The two
#   counters are LIVE ORM aggregates (ORM-only, no raw SQL), NOT read from
#   the stale data.stats JSONB cache.
# =============================================================================

import copy
import hashlib
from datetime import UTC, datetime
from uuid import UUID

import structlog
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import record_audit
from app.core.events import GROUP_MASTERS, sync_membership_delta  # Phase 6 / T0
from app.core.exceptions import ConflictError, ForbiddenError, NotFoundError
from app.core.redis import get_redis
from app.modules.diary.models import Feedback
from app.modules.masters.models import MasterProfile
from app.modules.masters.schemas import MasterApplyRequest, MasterPublicResponse
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.users.models import User, UserRole

logger = structlog.get_logger()

# Master account status that is publicly visible via GET /masters/{id}.
# Only verified masters are exposed; pending/rejected resolve to 404 so we
# do not reveal the existence of an unverified application.
_PUBLIC_MASTER_STATUS = "verified"

# Practice statuses excluded from the public practices_count aggregate.
# draft and deleted are not "real" practices for a public profile.
_NON_COUNTABLE_PRACTICE_STATUSES = (
    PracticeStatus.DRAFT.value,
    PracticeStatus.DELETED.value,
)


def _build_data(body: MasterApplyRequest) -> dict:
    """Build JSONB data from application request."""
    return {
        "account": {
            "status": "pending",
            "applied_at": datetime.now(UTC).isoformat(),
            "verification": None,
            "rejections": [],
        },
        "profile": {
            "display_name": body.profile.display_name,
            "email": body.profile.email,
            "phone": body.profile.phone,
            "bio": body.experience.bio,
            "methods": body.experience.methods,
            "languages": body.experience.languages,
            "experience_years": body.experience.experience_years,
            "certifications": body.experience.certifications,
        },
        "documents": list(body.documents),
        "availability": {
            "is_accepting": False,
            "note": None,
        },
        "settings": {
            "auto_confirm_bookings": True,
            "max_participants_default": 20,
        },
        "stats": {
            "total_practices": 0,
            "total_participants": 0,
            "avg_rating": None,
        },
    }


def _build_verified_data(body: MasterApplyRequest) -> dict:
    """Build VERIFIED JSONB data for master self-provision (PROMPT №307).

    A role=master account with NO profile (in practice an admin who switched
    into master mode, or a CLI-promoted account) fills the same apply form and
    is verified IMMEDIATELY -- no approval loop (operator ruling). Mirrors
    _build_data but flips account.status to 'verified', stamps a self-provision
    verification block, and opens availability so the master zone is usable at
    once. Same profile fields (methods / experience / bio) as the pending path.
    """
    now_iso = datetime.now(UTC).isoformat()
    data = _build_data(body)
    data["account"]["status"] = "verified"
    data["account"]["verification"] = {
        "verified_at": now_iso,
        "verified_by": "self_provision",
        "notes": None,
    }
    data["availability"]["is_accepting"] = True
    return data


def _build_reapply_data(
    existing_data: dict, body: MasterApplyRequest
) -> dict:
    """Rebuild JSONB data for reapplication, preserving rejection history."""
    new_data = _build_data(body)

    # Carry over rejection history from previous application.
    old_rejections = existing_data.get("account", {}).get("rejections", [])
    old_status = existing_data.get("account", {}).get("status")

    # Archive the previous rejection into history.
    if old_status == "rejected":
        rejection_record = {
            "rejected_at": existing_data.get("account", {}).get(
                "rejected_at"
            ),
            "reason": existing_data.get("account", {}).get(
                "rejection_reason"
            ),
        }
        old_rejections = [*old_rejections, rejection_record]

    new_data["account"]["rejections"] = old_rejections

    return new_data


async def apply_for_master(
    user: User,
    body: MasterApplyRequest,
    session: AsyncSession,
) -> MasterProfile:
    """Submit or resubmit a master application.

    Creates a new MasterProfile or updates an existing rejected one.
    """
    # Self-provision (PROMPT №307): a role=master account WITHOUT a profile --
    # an admin who switched into master mode, or a CLI-promoted account -- fills
    # this same form and gets a VERIFIED profile immediately (no approval loop).
    # A role=master WITH a profile is already a master -> 409. Real masters
    # (invite -> apply -> approve -> switch) always have a profile, so they never
    # reach the verified-create branch.
    if user.role == UserRole.MASTER:
        stmt = (
            select(MasterProfile)
            .where(MasterProfile.user_id == user.id)
            .with_for_update()
        )
        existing = (await session.execute(stmt)).scalar_one_or_none()
        if existing is not None:
            raise ConflictError(
                message="Already a master", code="already_master"
            )
        profile = MasterProfile(
            user_id=user.id,
            data=_build_verified_data(body),
        )
        session.add(profile)
        try:
            async with session.begin_nested():
                await session.flush()
        except IntegrityError:
            raise ConflictError(
                message="Already a master", code="already_master"
            )
        # Phase 6 / T0: self-provision creates a VERIFIED profile out
        # of nothing -- a master-capability gain (had none: the guard
        # above 409s when a profile exists). Same transaction (ID-2).
        await sync_membership_delta(
            session, user, group_key=GROUP_MASTERS, had=False, has=True
        )
        logger.info("master_self_provisioned", user_id=str(user.id))
        return profile

    # Only regular users can apply (the normal application path).
    if user.role != UserRole.USER:
        raise ForbiddenError("Only users with role 'user' can apply")

    # RACE-06: FOR UPDATE prevents two concurrent reapplications from
    # both seeing status=rejected and overwriting each other's set_jsonb.
    # The second request will block until the first commits, then see
    # status=pending -> ConflictError.
    stmt = (
        select(MasterProfile)
        .where(MasterProfile.user_id == user.id)
        .with_for_update()
    )
    result = await session.execute(stmt)
    existing = result.scalar_one_or_none()

    if existing is not None:
        status = existing.data.get("account", {}).get("status")

        if status == "pending":
            raise ConflictError("Application already pending")

        if status == "verified":
            # Should not happen (user.role would be MASTER), but guard anyway.
            raise ConflictError("Already verified as master")

        # Status is "rejected" -- allow reapplication.
        # Uses set_jsonb() to ensure SQLAlchemy detects the JSONB change.
        existing.set_jsonb("data", _build_reapply_data(existing.data, body))
        await _emit_application_received(session, user)
        logger.info(
            "master_reapplication_submitted",
            user_id=str(user.id),
        )
        return existing

    # No existing profile -- create new one.
    # Race condition guard: two concurrent requests may both reach this point.
    # flush() triggers INSERT; if user_id PK already exists, IntegrityError
    # is raised and converted to ConflictError.
    profile = MasterProfile(
        user_id=user.id,
        data=_build_data(body),
    )
    session.add(profile)

    try:
        async with session.begin_nested():
            await session.flush()
    except IntegrityError:
        raise ConflictError("Application already pending")

    await _emit_application_received(session, user)

    logger.info(
        "master_application_submitted",
        user_id=str(user.id),
    )

    return profile


async def _emit_application_received(
    session: AsyncSession, user: User,
) -> None:
    """Comms (T1, dictionary §2): master.application_received to
    group:admins -- a COMMUNICATION audience, so it goes as ONE emit
    and comms expands it over its synced contact book (C-boundary
    ID-4; the admins group is maintained by the T0 sync). Category-
    less (decision A): admins always hear about new applications."""
    from app.core.events.notify import (
        TARGET_GROUP_ADMINS,
        emit_notification,
    )
    applicant = " ".join(
        part for part in (user.first_name, user.last_name) if part
    ) or "Пользователь"
    target_type, target_value = TARGET_GROUP_ADMINS
    await emit_notification(
        session,
        type="master.application_received",
        target_type=target_type,
        target_value=target_value,
        title="Новая заявка мастера",
        body=(
            f"{applicant} подал(а) заявку на профиль мастера -- "
            f"требуется проверка."
        ),
        action_data={
            "action": "open_admin_masters",
            "params": {"user_id": str(user.id)},
            "applicant_name": applicant,
        },
    )


# ---------------------------------------------------------------------------
# F4: candidate withdraws their own PENDING application
# ---------------------------------------------------------------------------
#
# PRODUCT DECISION (operator, 2026-07-15): "человек отозвал заявку, а не
# аккаунт" -- status flip ONLY. The User row, role, and history are
# untouched; the applicant is still an ordinary user and can re-apply at any
# time (apply_for_master's reapply branch handles any non-pending/verified
# status generically, so no special-casing is needed for it to work again).
# Only a "pending" application can be withdrawn -- once verified/rejected the
# admin has already acted, and there is nothing left to withdraw.


async def withdraw_master_application(
    user: User,
    session: AsyncSession,
) -> MasterProfile:
    """Withdraw the caller's own pending master application.

    Flips MasterProfile.data.account.status to "cancelled_by_user" -- the
    same JSONB-status-write shape as reject/verify, just from the applicant
    side. FOR UPDATE mirrors the reapply race guard (RACE-06): two concurrent
    withdraw/apply requests must not interleave.

    Raises:
        NotFoundError: no application exists for this user.
        ConflictError: the application is not "pending" (already verified,
            rejected, or already withdrawn -- nothing to withdraw).
    """
    stmt = (
        select(MasterProfile)
        .where(MasterProfile.user_id == user.id)
        .with_for_update()
    )
    result = await session.execute(stmt)
    profile = result.scalar_one_or_none()

    if profile is None:
        raise NotFoundError("No master application found")

    account_status = profile.data.get("account", {}).get("status")
    if account_status != "pending":
        raise ConflictError("Only a pending application can be withdrawn")

    new_data = copy.deepcopy(profile.data)
    new_data.setdefault("account", {})
    new_data["account"]["status"] = "cancelled_by_user"
    profile.set_jsonb("data", new_data)

    logger.info(
        "master_application_withdrawn",
        user_id=str(user.id),
    )

    return profile


async def get_master_profile(
    user_id: UUID,
    session: AsyncSession,
) -> MasterProfile | None:
    """Fetch MasterProfile by user_id. Returns None if not found."""
    stmt = select(MasterProfile).where(MasterProfile.user_id == user_id)
    result = await session.execute(stmt)
    return result.scalar_one_or_none()


async def get_master_display_name(
    master_id: UUID,
    session: AsyncSession,
) -> str:
    """Get master's display name for notification templates.

    NEW-01: Extracted from reminders.py to shared location.
    Used by reminders, waitlist notifications, and any future
    module that needs a human-readable master name.

    Lookup order:
      1. MasterProfile.data.profile.display_name
      2. User.first_name
      3. Fallback: "Master"
    """
    profile = await session.get(MasterProfile, master_id)
    if profile:
        display_name = (
            profile.data.get("profile", {}).get("display_name")
        )
        if display_name:
            return display_name

    user = await session.get(User, master_id)
    if user and user.first_name:
        return user.first_name

    return "Master"


async def get_master_full_name(
    master_id: UUID,
    session: AsyncSession,
) -> str:
    """Get master's "First Last" name from Telegram profile data (W7 fix).

    Mirrors practices/service.master_full_name's convention exactly
    (Telegram first_name + last_name, ignoring MasterProfile.display_name),
    so the same practice shows the same master name in the diary feed as
    it does on practice cards. Previously the diary feed used
    get_master_display_name (which prefers MasterProfile.display_name) --
    the two disagreed whenever a master had set a custom display name.
    """
    user = await session.get(User, master_id)
    if user is None:
        return "Мастер"

    parts = [p for p in (user.first_name, user.last_name) if p]
    return " ".join(parts) if parts else "Мастер"


async def is_master_verified(
    master_id: UUID,
    session: AsyncSession,
) -> bool:
    """Whether a master's account status is "verified".

    Used by the diary projections to snapshot the verified badge as-of the
    event (the feed is an append-only historical record). Reads the same
    data.account.status as get_public_master_profile. Returns False when no
    profile exists. Cheap in the projection path: the caller
    (_practice_snapshot) primes the MasterProfile into the session identity
    map first, so this session.get is a cache hit there.
    """
    profile = await session.get(MasterProfile, master_id)
    if profile is None:
        return False
    status = profile.data.get("account", {}).get("status")
    return status == _PUBLIC_MASTER_STATUS


async def get_master_avatar_url(
    master_id: UUID,
    session: AsyncSession,
) -> str | None:
    """Master avatar URL (User.avatar_url, synced from Telegram photo_url).

    Used by the diary projections to snapshot the avatar as-of the event
    (same pattern/rationale as is_master_verified). Returns None when the
    user has no Telegram photo. Cheap in the projection path: the caller
    (_practice_snapshot) primes the User into the session identity map first,
    so this session.get is a cache hit there.
    """
    user = await session.get(User, master_id)
    return user.avatar_url if user else None


async def get_public_master_profile(
    user_id: UUID,
    session: AsyncSession,
) -> MasterPublicResponse:
    """Build the user-facing public master profile (S-4).

    Returns a MasterPublicResponse with display fields, avatar, and two
    live ORM aggregate counters. Only verified masters are exposed.

    Visibility (P-08 style -- do not reveal existence):
      - No MasterProfile row for user_id          -> 404
      - MasterProfile status != "verified"        -> 404

    Counters (ORM-only, never the stale data.stats cache):
      practices_count -- Practice rows for this master, excluding
                         draft/deleted statuses.
      reviews_count   -- Feedback rows across all of this master's
                         practices (joined Feedback -> Practice).

    avatar_url is User.avatar_url (synced from Telegram photo_url on login);
    None when the master has no Telegram photo. The MasterProfile is joined
    via its user_id PK to the users row to read first_name fallback + avatar.
    """
    # Load the profile + owning user in one outer-joined row. MasterProfile
    # PK is user_id (see get_master_display_name), so we match on it.
    stmt = (
        select(MasterProfile, User.first_name, User.avatar_url)
        .join(User, MasterProfile.user_id == User.id)
        .where(MasterProfile.user_id == user_id)
    )
    result = await session.execute(stmt)
    row = result.one_or_none()

    if row is None:
        raise NotFoundError("Master not found")

    profile, first_name, avatar_url = row

    account = profile.data.get("account", {})
    if account.get("status") != _PUBLIC_MASTER_STATUS:
        # Pending/rejected: do not reveal the unverified application.
        raise NotFoundError("Master not found")

    prof = profile.data.get("profile", {})

    # The two counters below run sequentially, not via asyncio.gather:
    # a single AsyncSession does not allow concurrent operations
    # (SQLAlchemy raises "another operation is in progress"), and spinning
    # up a second session/connection just to parallelize two cheap indexed
    # COUNTs on a cold path (profile open) is not worth the overhead.

    # -- Live counter: public practices (excludes draft/deleted) --
    practices_count_stmt = select(func.count(Practice.id)).where(
        Practice.master_id == user_id,
        Practice.status.notin_(_NON_COUNTABLE_PRACTICE_STATUSES),
    )
    practices_count = (
        await session.execute(practices_count_stmt)
    ).scalar_one()

    # -- Live counter: all feedback across this master's practices --
    # Intentionally NOT filtered by Practice.status: this counts every
    # feedback the master ever received (variant A). It is asymmetric with
    # practices_count (which excludes draft/deleted) on purpose -- the two
    # are independent stats on the profile, not a matched pair, so feedback
    # on a since-deleted/cancelled practice still counts as a real review.
    reviews_count_stmt = (
        select(func.count(Feedback.id))
        .join(Practice, Feedback.practice_id == Practice.id)
        .where(Practice.master_id == user_id)
    )
    reviews_count = (
        await session.execute(reviews_count_stmt)
    ).scalar_one()

    # display_name falls back to User.first_name when the profile field is
    # empty (mirrors get_master_display_name lookup order).
    display_name = prof.get("display_name") or first_name

    return MasterPublicResponse(
        user_id=profile.user_id,
        status=account.get("status", _PUBLIC_MASTER_STATUS),
        display_name=display_name,
        bio=prof.get("bio"),
        methods=prof.get("methods", []),
        experience_years=prof.get("experience_years"),
        avatar_url=avatar_url,
        practices_count=practices_count,
        reviews_count=reviews_count,
    )


# ---------------------------------------------------------------------------
# E16: master updates their languages (freely editable, no moderation)
# ---------------------------------------------------------------------------


async def update_master_languages(
    profile: MasterProfile,
    languages: list[str],
    session: AsyncSession,
) -> MasterProfile:
    """Replace the master's language set (E16, Q2=А -- no moderation).

    Writes data.profile.languages wholesale. The profile must be bound to the
    caller's write session (the router re-loads it via session.get, mirroring
    update_payout_details). Caller does flush + refresh.
    """
    new_data = copy.deepcopy(profile.data)
    new_data.setdefault("profile", {})
    new_data["profile"]["languages"] = list(languages)
    profile.set_jsonb("data", new_data)

    logger.info(
        "master_languages_updated",
        user_id=str(profile.user_id),
        count=len(languages),
    )

    return profile


# ---------------------------------------------------------------------------
# M3 (E19-FLAT): master submits a method change-request
# ---------------------------------------------------------------------------


async def submit_method_change_request(
    profile: MasterProfile,
    proposed_methods: list[str],
    session: AsyncSession,
) -> MasterProfile:
    """Record a pending method change-request on the master's profile.

    FLAT branch (M3): stores the proposed flat method list under
    data.profile.method_change_request with status "pending". Does NOT touch
    data.profile.methods -- the live method set only changes when an admin
    approves (admin/masters/service.approve_method_change).

    The profile must be bound to the caller's write session (the router
    re-loads it via session.get, mirroring update_payout_details).

    Raises:
        ConflictError (method_change_pending): a request is already pending.
    """
    prof = profile.data.get("profile", {})
    existing = prof.get("method_change_request")
    if isinstance(existing, dict) and existing.get("status") == "pending":
        raise ConflictError(
            "A method change request is already pending",
            code="method_change_pending",
        )

    # P-03: deepcopy + set_jsonb for safe JSONB mutation.
    new_data = copy.deepcopy(profile.data)
    new_data.setdefault("profile", {})
    new_data["profile"]["method_change_request"] = {
        "status": "pending",
        "proposed_methods": list(proposed_methods),
        "submitted_at": datetime.now(UTC).isoformat(),
        "decided_at": None,
        "decided_by": None,
        "reject_reason": None,
    }
    profile.set_jsonb("data", new_data)

    await record_audit(
        event="master_method_change_requested",
        actor_id=profile.user_id,
        actor_type="master",
        target_type="master_profile",
        target_id=profile.user_id,
        data={"proposed_methods": list(proposed_methods)},
        session=session,
    )

    logger.info(
        "master_method_change_requested",
        user_id=str(profile.user_id),
    )

    return profile


# ---------------------------------------------------------------------------
# Batch-INVITE: claim a generic one-time master invite (Redis, atomic burn)
# ---------------------------------------------------------------------------
# Prefix duplicated from admin/masters/service.MASTER_INVITE_KEY_PREFIX to avoid
# a cross-module import -- keep the two literals in sync.
MASTER_INVITE_KEY_PREFIX = "master_invite:"


async def claim_master_invite(token: str) -> datetime:
    """Validate + burn a generic one-time master invite (atomic).

    The supplied token is hashed and looked up in Redis under
    MASTER_INVITE_KEY_PREFIX. GETDEL burns it atomically -- the first claim
    wins; any later claim of the same token 404s (consumed). Becoming a
    master still goes through the regular apply wizard + admin approval loop;
    nothing is verified here. The caller is already auto-registered at login,
    so any authenticated opener may claim.

    Raises:
        NotFoundError (invite_invalid): token unknown / already consumed.
    """
    token_hash = hashlib.sha256(token.encode()).hexdigest()

    redis = get_redis()
    # Atomic single-command read-and-delete: no interleave between the check
    # and the burn, so two concurrent claims can never both succeed.
    stored = await redis.getdel(f"{MASTER_INVITE_KEY_PREFIX}{token_hash}")
    if stored is None:
        raise NotFoundError(
            "Invite link is invalid or already used",
            code="invite_invalid",
        )

    logger.info("master_invite_claimed")

    return datetime.now(UTC)
