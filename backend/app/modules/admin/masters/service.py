# =============================================================================
# VELO Backend -- Admin Master Service (Phase 2.3, moved Phase 3.1)
# =============================================================================
#
# Business logic for admin actions on master applications.
#
# VERIFY FLOW:
#   1. Load MasterProfile by user_id with FOR UPDATE (P-07)
#   2. Validate status == "pending"
#   3. Update JSONB: status -> "verified", add verification info
#   4. Change User.role -> MASTER
#   5. Record audit event (M-01)
#   6. Return updated profile (caller does flush + refresh)
#
# REJECT FLOW:
#   1. Load MasterProfile by user_id with FOR UPDATE (P-07)
#   2. Validate status == "pending"
#   3. Update JSONB: status -> "rejected", store reason
#   4. Do NOT change User.role
#   5. Record audit event (M-01)
#   6. Return updated profile
#
# JSONB SAFETY:
#   All mutations use copy.deepcopy() + set_jsonb() (P-03).
#   NEVER assign profile.data = ... directly.
#
# SESSION RULES:
#   No session.commit() here (P-01). Router calls flush() + refresh().
# =============================================================================

import copy
import hashlib
import json
import secrets
import uuid as uuid_module
from datetime import UTC, datetime
from uuid import UUID

import structlog
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import record_audit
from app.core.config import settings
from app.core.exceptions import ConflictError, NotFoundError, VeloError
from app.core.redis import get_redis
from app.modules.admin.masters.schemas import (
    AdminMasterProfileUpdate,
    AdminMethodChangeItem,
    PaginatedMethodChangeRequestsResponse,
    RevokeMasterAdvisory,
)
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.practices.taxonomy_models import TaxonomyDirection
from app.modules.users.models import User, UserRole
from app.modules.users.schemas import credentials_without_admin_home
from app.modules.withdrawals.models import Withdrawal, WithdrawalStatus

logger = structlog.get_logger()


async def _load_pending_profile(
    user_id: UUID,
    session: AsyncSession,
) -> MasterProfile:
    """Load MasterProfile with FOR UPDATE and validate 'pending' status.

    Uses SELECT FOR UPDATE (P-07) to prevent race condition when two
    admins act on the same application simultaneously.

    Raises NotFoundError if profile doesn't exist.
    Raises ConflictError if profile is not pending.
    """
    stmt = (
        select(MasterProfile)
        .where(MasterProfile.user_id == user_id)
        .with_for_update()
    )
    result = await session.execute(stmt)
    profile = result.scalar_one_or_none()

    if not profile:
        raise NotFoundError("Master application not found")

    status = profile.data.get("account", {}).get("status")
    if status != "pending":
        # P-08: do not leak current status in error message.
        raise ConflictError("Application is not pending")

    return profile


async def verify_master(
    user_id: UUID,
    admin: User,
    notes: str | None,
    session: AsyncSession,
    promote: list[str] | None = None,
    master_only: list[str] | None = None,
) -> MasterProfile:
    """Verify a pending master application (T4, ПРОМТ №295).

    Sets MasterProfile.data.account.status -> "verified" ONLY. The user's role
    is NOT changed: approval grants master *capability* (a verified profile),
    and the user self-switches into master mode via POST /users/me/role
    (derive_allowed_roles keys on status=="verified"). Keeping role='user'
    lands the approved applicant back in the user zone with the switch offered,
    per the locked call-design.

    promote (ПРОМТ №503 commit 3): optional custom method labels from the
    applicant's own data.profile.methods that the admin chose to promote into
    the taxonomy catalog, reusing the exact same _promote_custom_methods
    helper approve_method_change already uses for an already-verified
    master's later method-change request -- this is the FIRST time that
    mechanism is reachable from the initial-application path. Absent/empty ->
    no catalog write, unchanged from before this parameter existed. Does NOT
    rewrite data.profile.methods itself -- the applicant's stored text is
    untouched; parseMethods/directionLabel (frontend, ПРОМТ №503 commits 1-2)
    now resolve it to the promoted chip on the strength of the catalog label
    matching, the same as any other catalog-matched value.

    master_only (T22-6, ПРОМТ №561): mirrors approve_method_change's own
    parameter -- the admin's "Только этому мастеру" choice on this same
    initial-application dialog. Each label gets a MASTER-SCOPED
    TaxonomyDirection row (_scope_custom_methods_to_master), so the new
    master's own create-practice picker offers it even though no other
    master ever sees it.
    """
    profile = await _load_pending_profile(user_id, session)

    # -- Update JSONB (P-03: deepcopy + set_jsonb) --
    new_data = copy.deepcopy(profile.data)
    new_data["account"]["status"] = "verified"
    new_data["account"]["verification"] = {
        "verified_at": datetime.now(UTC).isoformat(),
        "verified_by": str(admin.id),
        "notes": notes,
    }
    profile.set_jsonb("data", new_data)

    promoted = await _promote_custom_methods(promote or [], session)
    scoped = await _scope_custom_methods_to_master(master_only or [], user_id, session)

    # M-01: audit trail for master verification.
    await record_audit(
        event="master_verified",
        actor_id=admin.id,
        actor_type="admin",
        target_type="master_profile",
        target_id=user_id,
        data={
            "notes": notes,
            "promoted_to_catalog": promoted,
            "scoped_to_master": scoped,
        },
        session=session,
    )

    logger.info(
        "master_verified",
        user_id=str(user_id),
        admin_id=str(admin.id),
        promoted_to_catalog=promoted,
        scoped_to_master=scoped,
    )

    return profile


async def _load_verified_master(
    user_id: UUID,
    session: AsyncSession,
    *,
    for_update: bool,
) -> tuple[User, MasterProfile]:
    """Load a VERIFIED master's (User, MasterProfile) for revoke/preview (A1).

    for_update takes SELECT FOR UPDATE on the mutating path (P-07). Raises
    NotFoundError if profile/user missing, ConflictError if not verified (revoke
    only makes sense on a live capability — status=="verified").
    """
    stmt = select(MasterProfile).where(MasterProfile.user_id == user_id)
    if for_update:
        stmt = stmt.with_for_update()
    profile = (await session.execute(stmt)).scalar_one_or_none()
    if not profile:
        raise NotFoundError("Master profile not found")
    status = (profile.data or {}).get("account", {}).get("status")
    if status != "verified":
        raise ConflictError("Master is not verified")
    user = await session.get(User, user_id)
    if not user:
        raise NotFoundError("User not found")
    return user, profile


async def _build_revoke_advisory(
    user_id: UUID,
    profile: MasterProfile,
    session: AsyncSession,
) -> RevokeMasterAdvisory:
    """CLI-style downgrade signals (WARN-not-block, operator Б).

    Mirrors set_role.py to_user's guard queries (scheduled/live practices,
    balance, pending withdrawals) but is advisory only -- never blocks.
    """
    scheduled = int(
        (
            await session.execute(
                select(func.count())
                .select_from(Practice)
                .where(
                    Practice.master_id == user_id,
                    Practice.status.in_(
                        [
                            PracticeStatus.SCHEDULED.value,
                            PracticeStatus.LIVE.value,
                        ]
                    ),
                )
            )
        ).scalar_one()
    )
    pending = int(
        (
            await session.execute(
                select(func.count())
                .select_from(Withdrawal)
                .where(
                    Withdrawal.user_id == user_id,
                    Withdrawal.status == WithdrawalStatus.PENDING.value,
                )
            )
        ).scalar_one()
    )
    available = profile.available_cents
    frozen = profile.frozen_cents
    return RevokeMasterAdvisory(
        scheduled_or_live_practices=scheduled,
        available_cents=available,
        frozen_cents=frozen,
        pending_withdrawals=pending,
        has_warnings=(
            scheduled > 0 or available > 0 or frozen > 0 or pending > 0
        ),
    )


async def get_revoke_advisory(
    user_id: UUID,
    session: AsyncSession,
) -> RevokeMasterAdvisory:
    """Read-only preview of the revoke advisory (for the confirm dialog)."""
    _, profile = await _load_verified_master(
        user_id, session, for_update=False
    )
    return await _build_revoke_advisory(user_id, profile, session)


async def revoke_master(
    user_id: UUID,
    admin: User,
    session: AsyncSession,
) -> RevokeMasterAdvisory:
    """Revoke a master's capability, preserving all data (A1, operator Б).

    Mirrors CLI `set_role.py to_user` EXACTLY (one behavior across CLI + admin):
      - User.role -> user, ONLY if currently master (+ clear the switched-away
        admin round-trip marker, R-1);
      - profile data.account.status -> "suspended",
        data.availability.is_accepting -> False.
    Capability keys on status=="verified" (users/service.user_has_master_
    capability), so suspending drops it -> the account logs in user-only. Every
    row is kept: re-grant via the existing make_master re-verify branch restores
    status="verified" + role=master. The CLI-style guard signals are computed
    and returned as advisory but NEVER block (operator Б).
    """
    user, profile = await _load_verified_master(
        user_id, session, for_update=True
    )
    advisory = await _build_revoke_advisory(user_id, profile, session)

    # -- role reset (mirror set_role._set_role): only if currently master --
    if user.role == UserRole.MASTER.value:
        user.role = UserRole.USER.value
        cleared = credentials_without_admin_home(user.credentials)
        if cleared != (user.credentials or {}):
            user.set_jsonb("credentials", cleared)

    # -- soft-freeze the profile (mirror set_role to_user, P-03) --
    new_data = copy.deepcopy(profile.data)
    new_data.setdefault("account", {})["status"] = "suspended"
    new_data.setdefault("availability", {})["is_accepting"] = False
    profile.set_jsonb("data", new_data)

    await record_audit(
        event="master_revoked",
        actor_id=admin.id,
        actor_type="admin",
        target_type="master_profile",
        target_id=user_id,
        data={"advisory": advisory.model_dump()},
        session=session,
    )
    logger.info(
        "master_revoked",
        user_id=str(user_id),
        admin_id=str(admin.id),
        scheduled_or_live=advisory.scheduled_or_live_practices,
        pending_withdrawals=advisory.pending_withdrawals,
        has_warnings=advisory.has_warnings,
    )
    return advisory


async def reject_master(
    user_id: UUID,
    admin: User,
    reason: str,
    session: AsyncSession,
) -> MasterProfile:
    """Reject a pending master application.

    Stores rejection reason and archives it in rejection history.
    Does NOT change User.role -- user stays as USER and can reapply.
    """
    profile = await _load_pending_profile(user_id, session)

    # -- Update JSONB (P-03: deepcopy + set_jsonb) --
    new_data = copy.deepcopy(profile.data)
    new_data["account"]["status"] = "rejected"
    new_data["account"]["rejected_at"] = datetime.now(UTC).isoformat()
    new_data["account"]["rejection_reason"] = reason
    new_data["account"]["rejected_by"] = str(admin.id)
    profile.set_jsonb("data", new_data)

    # M-01: audit trail for master rejection.
    await record_audit(
        event="master_rejected",
        actor_id=admin.id,
        actor_type="admin",
        target_type="master_profile",
        target_id=user_id,
        data={"reason": reason},
        session=session,
    )

    logger.info(
        "master_rejected",
        user_id=str(user_id),
        admin_id=str(admin.id),
        reason=reason,
    )

    return profile


# ---------------------------------------------------------------------------
# M3 (E19-FLAT): method change-request moderation
# ---------------------------------------------------------------------------


async def _load_profile_with_pending_method_change(
    user_id: UUID,
    session: AsyncSession,
) -> MasterProfile:
    """Load MasterProfile FOR UPDATE and validate a pending method request.

    Mirrors _load_pending_profile but gates on
    data.profile.method_change_request.status == "pending" (P-07 race guard:
    two admins acting on the same request).

    Raises NotFoundError if there is no pending method-change request.
    """
    stmt = (
        select(MasterProfile)
        .where(MasterProfile.user_id == user_id)
        .with_for_update()
    )
    result = await session.execute(stmt)
    profile = result.scalar_one_or_none()

    if not profile:
        raise NotFoundError("Method change request not found")

    request = profile.data.get("profile", {}).get("method_change_request")
    if not isinstance(request, dict) or request.get("status") != "pending":
        raise NotFoundError("Method change request not found")

    return profile


async def list_pending_method_changes(
    session: AsyncSession,
    *,
    limit: int = 20,
    offset: int = 0,
) -> PaginatedMethodChangeRequestsResponse:
    """List masters with a pending method change-request (newest first).

    Joins User + MasterProfile and filters on the JSONB
    data.profile.method_change_request.status == "pending". Read-only.
    """
    pending_filter = (
        MasterProfile.data["profile"]["method_change_request"][
            "status"
        ].as_string()
        == "pending"
    )

    query = (
        select(User, MasterProfile)
        .join(MasterProfile, User.id == MasterProfile.user_id)
        .where(pending_filter)
        .order_by(MasterProfile.created_at.desc())
    )
    count_query = (
        select(func.count(MasterProfile.user_id))
        .select_from(MasterProfile)
        .where(pending_filter)
    )

    total = (await session.execute(count_query)).scalar_one()

    query = query.limit(limit).offset(offset)
    rows = (await session.execute(query)).all()

    items = [
        AdminMethodChangeItem(
            user_id=user.id,
            display_name=profile.data.get("profile", {}).get("display_name"),
            first_name=user.first_name,
            last_name=user.last_name,
            avatar_url=user.avatar_url,
            current_methods=profile.data.get("profile", {}).get("methods", []),
            proposed_methods=profile.data["profile"]["method_change_request"][
                "proposed_methods"
            ],
            submitted_at=profile.data["profile"]["method_change_request"][
                "submitted_at"
            ],
        )
        for user, profile in rows
    ]

    return PaginatedMethodChangeRequestsResponse(
        items=items,
        total=total,
        limit=limit,
        offset=offset,
    )


async def _promote_custom_methods(
    labels: list[str],
    session: AsyncSession,
) -> list[str]:
    """Insert each label as a new custom TaxonomyDirection (R5 stage 4).

    source='custom', is_active=True. Dedups case-insensitively against every
    existing direction label (seeded or already-promoted) -- never inserts a
    duplicate. Returns the labels actually inserted (skips the rest).

    Scope: the auto-promote path only ever produces bare custom DIRECTIONS.
    The picker's "Свой вариант" is a single free-text field with no
    direction+style structure, so there is no reachable case today where a
    custom entry is a style under an existing direction -- that would need a
    UI affordance that doesn't exist yet.

    value is a synthetic slug (Cyrillic labels have no natural ASCII slug,
    and nothing reads `value` for a custom row -- every consumer displays
    `label`).
    """
    if not labels:
        return []

    existing_labels = (
        (await session.execute(select(TaxonomyDirection.label))).scalars().all()
    )
    seen_lower = {label.lower() for label in existing_labels}

    promoted: list[str] = []
    for raw in labels:
        label = raw.strip()
        if not label or label.lower() in seen_lower:
            continue
        direction = TaxonomyDirection(
            value=f"custom_{uuid_module.uuid4().hex[:8]}",
            label=label,
            source="custom",
        )
        try:
            async with session.begin_nested():
                session.add(direction)
                await session.flush()
        except IntegrityError:
            # Slug collision (astronomically unlikely) or a racing duplicate
            # insert -- skip rather than fail the whole approval.
            continue
        seen_lower.add(label.lower())
        promoted.append(label)
    return promoted


async def _scope_custom_methods_to_master(
    labels: list[str],
    master_id: UUID,
    session: AsyncSession,
) -> list[str]:
    """Insert each label as a new MASTER-SCOPED TaxonomyDirection (T22-6,
    ПРОМТ №561): the admin's "Только этому мастеру" choice.

    Sibling of _promote_custom_methods, same insert shape (synthetic
    value, source='custom'), except master_id=master_id -- invisible to
    every OTHER master's catalog fetch (list_active_taxonomy's scope
    filter), visible only to this one. This is what closes T22-6: before
    this, "for this master only" wrote the raw label into
    data.profile.methods and created NOTHING, so the direction had zero
    catalog representation anywhere a practice could reference it.

    Dedup is case-insensitive against every label THIS MASTER could
    actually collide with -- every global row (master_id IS NULL) plus this
    master's own previously-scoped rows -- not against every other
    master's private rows, which are none of this master's business and
    must not block them from getting their own row with the same text.
    Returns the labels actually inserted (skips the rest).
    """
    if not labels:
        return []

    existing_labels = (
        await session.execute(
            select(TaxonomyDirection.label).where(
                or_(
                    TaxonomyDirection.master_id.is_(None),
                    TaxonomyDirection.master_id == master_id,
                )
            )
        )
    ).scalars().all()
    seen_lower = {label.lower() for label in existing_labels}

    scoped: list[str] = []
    for raw in labels:
        label = raw.strip()
        if not label or label.lower() in seen_lower:
            continue
        direction = TaxonomyDirection(
            value=f"custom_{uuid_module.uuid4().hex[:8]}",
            label=label,
            source="custom",
            master_id=master_id,
        )
        try:
            async with session.begin_nested():
                session.add(direction)
                await session.flush()
        except IntegrityError:
            # Slug collision (astronomically unlikely) or a racing duplicate
            # insert -- skip rather than fail the whole approval.
            continue
        seen_lower.add(label.lower())
        scoped.append(label)
    return scoped


async def approve_method_change(
    user_id: UUID,
    admin: User,
    session: AsyncSession,
    promote: list[str] | None = None,
    master_only: list[str] | None = None,
) -> MasterProfile:
    """Approve a pending method change-request.

    Copies proposed_methods into the live data.profile.methods and CLEARS the
    request (so the profile response returns method_change_request=None). No
    User.role change. Caller does flush + refresh.

    promote (R5 stage 4, operator decision 3=Б): optional list of custom
    method labels the admin chose to add to the taxonomy catalog, so future
    masters can pick them from MethodTaxonomyPicker instead of retyping
    free text. Absent/empty -> no catalog write, identical to pre-stage-4
    behavior. Deduped against existing rows (_promote_custom_methods).

    master_only (T22-6, ПРОМТ №561): the admin's OTHER choice on the same
    dialog -- "Только этому мастеру". Before this parameter existed, picking
    it approved the method but wrote NOTHING to the catalog, so the
    direction had no representation anywhere a practice could reference it
    and silently never appeared as a create-practice option (T22-6). Each
    label here gets its own MASTER-SCOPED row instead (_scope_custom_
    methods_to_master) -- a real taxonomy entry, visible only in THIS
    master's own create-practice picker.
    """
    profile = await _load_profile_with_pending_method_change(user_id, session)

    new_data = copy.deepcopy(profile.data)
    request = new_data["profile"]["method_change_request"]
    proposed = request.get("proposed_methods", [])

    new_data["profile"]["methods"] = proposed
    # Clear the request -- approval is terminal; the new methods now stand.
    new_data["profile"].pop("method_change_request", None)
    profile.set_jsonb("data", new_data)

    promoted = await _promote_custom_methods(promote or [], session)
    scoped = await _scope_custom_methods_to_master(master_only or [], user_id, session)

    await record_audit(
        event="master_method_change_approved",
        actor_id=admin.id,
        actor_type="admin",
        target_type="master_profile",
        target_id=user_id,
        data={
            "methods": proposed,
            "promoted_to_catalog": promoted,
            "scoped_to_master": scoped,
        },
        session=session,
    )

    logger.info(
        "master_method_change_approved",
        user_id=str(user_id),
        admin_id=str(admin.id),
        promoted_to_catalog=promoted,
        scoped_to_master=scoped,
    )

    return profile


async def edit_master_methods(
    user_id: UUID,
    methods: list[str],
    admin: User,
    session: AsyncSession,
) -> MasterProfile:
    """Admin edits a master's methods during review (T3, ПРОМТ №293).

    Overwrites data.profile.methods with the validated flat list. Mirrors
    approve_method_change's JSONB write (deepcopy -> set_jsonb) + audit, but is
    an admin-initiated DIRECT edit — distinct from the master's own
    method-change request (M3). No User.role / status change. Caller does
    flush + refresh.
    """
    stmt = (
        select(MasterProfile)
        .where(MasterProfile.user_id == user_id)
        .with_for_update()
    )
    profile = (await session.execute(stmt)).scalar_one_or_none()
    if profile is None:
        raise NotFoundError("Master not found")

    new_data = copy.deepcopy(profile.data)
    new_data.setdefault("profile", {})["methods"] = methods
    profile.set_jsonb("data", new_data)

    await record_audit(
        event="master_methods_edited",
        actor_id=admin.id,
        actor_type="admin",
        target_type="master_profile",
        target_id=user_id,
        data={"methods": methods},
        session=session,
    )

    logger.info(
        "master_methods_edited",
        user_id=str(user_id),
        admin_id=str(admin.id),
    )

    return profile


# Keys that live under data.profile.* (JSONB). first_name/last_name are NOT
# here -- they live on the User row and are handled separately below.
_EDITABLE_PROFILE_KEYS = (
    "display_name",
    "email",
    "phone",
    "bio",
    "methods",
    "experience_years",
    "certifications",
    "languages",
)


async def edit_master_profile(
    user_id: UUID,
    body: AdminMasterProfileUpdate,
    admin: User,
    session: AsyncSession,
) -> MasterProfile:
    """Admin partial-edit of EVERY master-authored field (batch H).

    Mirrors edit_master_methods (deepcopy -> set_jsonb -> audit, NO status gate)
    but writes the full data.profile.* set AND the account name on the User row.
    Only the keys the client actually sent (model_dump(exclude_unset=True)) are
    applied, so a partial PATCH never clobbers an unsent sibling (e.g. an existing
    method_change_request or availability block). No User.role / status change.
    Caller does flush + refresh.
    """
    stmt = (
        select(MasterProfile)
        .where(MasterProfile.user_id == user_id)
        .with_for_update()
    )
    profile = (await session.execute(stmt)).scalar_one_or_none()
    if profile is None:
        raise NotFoundError("Master not found")

    sent = body.model_dump(exclude_unset=True)

    # -- data.profile.* (JSONB) -- P-03: deepcopy + set_jsonb --
    new_data = copy.deepcopy(profile.data)
    prof = new_data.setdefault("profile", {})
    for key in _EDITABLE_PROFILE_KEYS:
        if key in sent:
            prof[key] = sent[key]
    profile.set_jsonb("data", new_data)

    # -- User.* (account name, В1=В) -- load + write only when a name was sent --
    if "first_name" in sent or "last_name" in sent:
        user = await session.get(User, user_id)
        if user is None:
            raise NotFoundError("User not found")
        if "first_name" in sent:
            user.first_name = sent["first_name"]
        if "last_name" in sent:
            user.last_name = sent["last_name"]

    # Audit the field NAMES only (not values -- avoids spilling email/phone PII
    # into the audit log; the admin action + target are what matters).
    await record_audit(
        event="master_profile_edited",
        actor_id=admin.id,
        actor_type="admin",
        target_type="master_profile",
        target_id=user_id,
        data={"fields": sorted(sent.keys())},
        session=session,
    )

    logger.info(
        "master_profile_edited",
        user_id=str(user_id),
        admin_id=str(admin.id),
        fields=sorted(sent.keys()),
    )

    return profile


async def reject_method_change(
    user_id: UUID,
    admin: User,
    reason: str,
    session: AsyncSession,
) -> MasterProfile:
    """Reject a pending method change-request.

    Marks the request status "rejected" + stores the reason (the master sees
    it on their profile response); data.profile.methods is unchanged. Caller
    does flush + refresh.
    """
    profile = await _load_profile_with_pending_method_change(user_id, session)

    new_data = copy.deepcopy(profile.data)
    request = new_data["profile"]["method_change_request"]
    request["status"] = "rejected"
    request["decided_at"] = datetime.now(UTC).isoformat()
    request["decided_by"] = str(admin.id)
    request["reject_reason"] = reason
    profile.set_jsonb("data", new_data)

    await record_audit(
        event="master_method_change_rejected",
        actor_id=admin.id,
        actor_type="admin",
        target_type="master_profile",
        target_id=user_id,
        data={"reason": reason},
        session=session,
    )

    logger.info(
        "master_method_change_rejected",
        user_id=str(user_id),
        admin_id=str(admin.id),
    )

    return profile


# ---------------------------------------------------------------------------
# Batch-INVITE: generic one-time master invite link (Redis-backed, no TTL)
# ---------------------------------------------------------------------------
# The invite is account-agnostic -- no target user_id. The token's sha256 is
# stored in Redis under MASTER_INVITE_KEY_PREFIX with NO expiry; it lives until
# the first claim burns it atomically (masters/service.claim_master_invite), or
# until a Redis flush drops it (acceptable: the admin regenerates). The prefix
# is duplicated in masters/service.py to avoid a cross-module import -- keep the
# two literals in sync.
MASTER_INVITE_KEY_PREFIX = "master_invite:"


async def issue_master_invite(admin: User) -> tuple[str, datetime]:
    """Issue a generic one-time master invite link.

    No target: the returned link works for any authenticated opener until it
    is claimed once. Only the token's sha256 is persisted (in Redis); the
    plaintext token exists solely inside the returned link.

    Raises:
        VeloError 503 (bot_url_not_configured): telegram_bot_url unset.
    """
    if not settings.telegram_bot_url:
        raise VeloError(
            message="telegram_bot_url is not configured",
            code="bot_url_not_configured",
            status_code=503,
        )

    token = secrets.token_urlsafe(32)
    issued_at = datetime.now(UTC)
    token_hash = hashlib.sha256(token.encode()).hexdigest()

    # No expiry: persist until the first claim burns it (or a Redis flush).
    redis = get_redis()
    await redis.set(
        f"{MASTER_INVITE_KEY_PREFIX}{token_hash}",
        json.dumps(
            {"issued_by": str(admin.id), "issued_at": issued_at.isoformat()}
        ),
    )

    # Audit trail (the token itself is never logged).
    logger.info("master_invite_issued", admin_id=str(admin.id))

    invite_link = (
        f"{settings.telegram_bot_url}?startapp=master_onboarding__{token}"
    )
    return invite_link, issued_at
