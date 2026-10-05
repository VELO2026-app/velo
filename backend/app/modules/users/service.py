# =============================================================================
# VELO Backend — Users Service
# =============================================================================
#
# RESPONSIBILITIES:
#   1. Get user by ID
#   2. Update user profile (partial update)
#
# PATTERN:
#   Functions accept AsyncSession and return ORM objects.
#   Router handles HTTP concerns, service handles domain logic.
#
# TD-029 fix: removed session.merge() from update_user.
#   Previously the user came from get_current_user (read-only session),
#   requiring an explicit merge into the write session. Now the router
#   uses get_current_user_write, which loads the user via the same
#   get_db_session instance as the endpoint — merge is unnecessary.
#
# ONBOARDING:
#   onboarding_completed is not a column -- it lives in the credentials
#   JSONB sandbox. update_user routes it there via set_jsonb() (JSONBMixin),
#   which flag_modified()s the column so SQLAlchemy emits the UPDATE.
#   Plain setattr would target a non-existent column and silently no-op.
#
# ROW LOCK ON users (BE-85). THE ONE PLACE IT IS WRITTEN; every writer of
# the users row that points here follows it.
#
#   Every function that writes User.credentials -- or User.role, which is
#   decided from credentials (the switched-away-admin marker) -- takes the
#   row with lock_user_row() BEFORE it reads either. They all rewrite the
#   whole credentials dict from the copy in memory, so under READ COMMITTED
#   a writer that read the row before another one committed would put the
#   old blob back: a lost update, and for credentials['email'] a silent
#   divergence from the snapshot already sent to comms (update_user emits
#   the new address; a stale writer restores the old one, the trigger
#   raises the version, nobody emits). The writers: update_user,
#   switch_user_role, reset_user_to_onboarding (here), make_master
#   (admin/users), revoke_master (admin/masters), scripts/set_role and
#   scripts/seed. The login upsert (auth/service.py) merges in SQL
#   (`credentials || fresh` under the row lock ON CONFLICT takes) and needs
#   nothing from here.
#
#   STRENGTH: FOR NO KEY UPDATE, not FOR UPDATE. The writers change no key
#   column, and that is the lock their UPDATE takes anyway. FOR UPDATE
#   would also conflict with KEY SHARE -- the lock every insert of a child
#   row (booking, ledger, diary, ...) takes on this row through its FK --
#   so every such insert for this person would queue behind a profile
#   edit. (It does NOT deadlock against record_user_ledger's KEY SHARE ->
#   FOR UPDATE upgrade: measured in BE-85, Postgres lets the holder of the
#   KEY SHARE upgrade past a queued FOR UPDATE.) Against the balance
#   writers' FOR UPDATE it still excludes both ways.
#
#   REFRESH: the row is usually in the session already (the auth
#   dependency loaded it, unlocked). A locking SELECT does not overwrite
#   the attributes of an instance the identity map holds, so without
#   populate_existing the writer would hold the lock and still write the
#   stale copy. Hence lock first, mutate after: populate_existing would
#   also overwrite a change made before it.
#
#   ORDER: users -> master_profiles, for the rows of one person. A
#   function that locks both takes users first. Payments already takes
#   them so for a master's sale (the master_ledger insert takes KEY SHARE
#   on users before record_master_ledger locks master_profiles FOR UPDATE);
#   make_master takes users and then writes the profile; revoke_master was
#   the one taking master_profiles first, and it is turned. The KEY SHARE
#   of a child insert does not conflict with FOR NO KEY UPDATE, so it does
#   not count as a position in this order.
# =============================================================================

from uuid import UUID

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events import emit_user_upserted  # Phase 6 / T0
from app.core.exceptions import ForbiddenError
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from app.modules.users.schemas import (
    UserUpdate,
    derive_allowed_roles,
    has_admin_home,
)


async def lock_user_row(session: AsyncSession, user_id: UUID) -> User | None:
    """Take the users row FOR NO KEY UPDATE and load its current values.

    The lock, its strength, the refresh and the order are in the module
    header (ROW LOCK ON users). populate_existing makes an instance this
    session already holds take the values the row has once the lock is
    granted -- the committed state after any writer this one waited for.
    The instance is the one in the identity map, so a caller holding the
    user object sees it refreshed in place.

    Returns None when there is no such row.
    """
    return (
        await session.execute(
            select(User)
            .where(User.id == user_id)
            .with_for_update(key_share=True)
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()


logger = structlog.get_logger()

# Fields that are not real columns and must be written into the
# credentials JSONB sandbox instead of via setattr.
#
# onboarding_completed: bool flag (welcome flow).
# master_onboarding_completed: bool flag (master-zone welcome flow, E15) --
#   the exact same lifecycle as onboarding_completed, persisted so the master
#   onboarding survives re-login.
# phone / bio / email: profile fields (schema-on-read). They allow an empty
#   string "" as a valid stored value (means "cleared"); None is still dropped
#   below, so clearing is done by sending "", not null. This reuses the
#   exact same write path as onboarding_completed -- no special-casing.
#   email (E11): Telegram provides none, so it is captured via the profile
#   edit form and stored here (additive JSONB, no column, no migration).
_JSONB_CREDENTIAL_FIELDS = frozenset(
    {"onboarding_completed", "master_onboarding_completed", "phone", "bio", "email"}
)


async def update_user(
    user: User,
    data: UserUpdate,
    session: AsyncSession,
) -> User:
    """Apply partial update to user profile.

    Only fields explicitly provided in the request body are updated.
    Uses model_dump(exclude_unset=True) to distinguish between
    "field not sent" and "field sent as null".

    Column fields (first_name, last_name, timezone, language) are applied
    via setattr. JSONB-backed fields (onboarding_completed) are merged into
    the credentials dict via set_jsonb() so the change is tracked.

    The user object must already be bound to the provided session
    (TD-029: ensured by get_current_user_write in the router).

    Args:
        user: Current user ORM object, bound to the write session.
        data: Validated update payload.
        session: Read-write database session (same session that loaded user).

    Returns:
        Updated user ORM object.
    """
    updates = data.model_dump(exclude_unset=True)

    if not updates:
        return user

    # BE-85: lock and refresh the row before reading credentials (module
    # header, ROW LOCK ON users). Refreshes `user` in place.
    await lock_user_row(session, user.id)

    # Split the flat JSONB-backed fields from plain column fields.
    #
    # None is dropped for JSONB fields, empty string is kept:
    #   - onboarding_completed: only true/false are meaningful; null would
    #     store {"onboarding_completed": null}, and bool(None) reads back as
    #     False, silently re-triggering onboarding.
    #   - phone / bio: "not sent" and null both mean "leave untouched"; an
    #     empty string "" is a real value meaning "cleared" and IS written.
    # So clearing phone/bio is done by sending "" (not null). This keeps the
    # single shared write path -- "" passes the `is not None` guard, null does
    # not.
    jsonb_updates = {
        field: value
        for field, value in updates.items()
        if field in _JSONB_CREDENTIAL_FIELDS and value is not None
    }
    column_updates = {
        field: value
        for field, value in updates.items()
        if field not in _JSONB_CREDENTIAL_FIELDS
    }

    # Apply plain column fields.
    for field, value in column_updates.items():
        setattr(user, field, value)

    # Apply JSONB-backed fields into credentials. We build a NEW dict (copy) and
    # hand it to set_jsonb, which reassigns + flag_modified()s the column.
    # Mutating user.credentials in place would not be detected by SQLAlchemy.
    #
    # T-26: TWO nested-object merges used to sit here, one per notification
    # store -- the four-key credentials["notifications"] (set 1) and the
    # nine-key credentials["master_notifications"] (set 2). Both are gone; both
    # stores live in comms now. A blob still holding either key is left alone:
    # this path neither reads nor writes them, so old data is inert rather than
    # a second source of truth. That leaves only flat fields here, which is why
    # the nested-merge machinery went with them.
    if jsonb_updates:
        new_credentials = dict(user.credentials or {})
        new_credentials.update(jsonb_updates)
        user.set_jsonb("credentials", new_credentials)

    await session.flush()

    # Phase 6 / T0: re-sync the comms identity projection when a field
    # of the user_upserted snapshot was SENT. `language` / `timezone`
    # are columns, `email` lives in credentials -- all three arrive
    # through this PATCH. This filter only spares needless sends; whether
    # the snapshot CHANGED is the database's answer (the snapshot_version
    # trigger compares content): the same value sent again leaves the
    # version and reaches comms as a replay. Emitted in THIS transaction
    # (ID-2); name/bio edits do not touch the projection and stay silent.
    if {"language", "timezone", "email"} & updates.keys():
        await emit_user_upserted(session, user)

    logger.info(
        "user_profile_updated",
        user_id=str(user.id),
        fields=list(updates.keys()),
    )

    return user


async def switch_user_role(
    user: User,
    target_role: UserRole,
    session: AsyncSession,
) -> User:
    """Switch the caller's own role in place (capability-derived, A1=B).

    Authorization is derived, not seeded: derive_allowed_roles() (shared with
    UserResponse.role_switch -- single source of truth) computes the allowed
    target set from
      - the current role (an admin may take any of the three roles, including
        MASTER without a master profile -- №254 Q4=A),
      - master capability (a VERIFIED MasterProfile unlocks MASTER),
      - the switched-away-admin marker (see below).
    A target outside the derived set -> 403. In particular a non-admin can
    NEVER switch to ADMIN (admin is granted only via CLI/DB), and a switch to
    MASTER without capability is a plain 403 (the old 409
    master_profile_required is gone together with the seeded allow-lists).

    Round-trip marker: when an admin switches away, credentials.role_switch.
    home_role = "admin" is recorded so the derivation keeps ADMIN in their
    set and they can come back; the marker is cleared on the switch back.
    It is server-written only -- "role_switch" is not PATCHable.

    The role is rewritten directly on the User row (same mechanism as admin
    master-verify), so all existing role guards keep working unchanged.
    Switching to the current role is a harmless no-op (USER/own role is
    always in the set).

    The user object must already be bound to the provided write session
    (ensured by get_current_user_write in the router).

    BE-85: the row is locked first, whatever the branch -- the decision
    reads credentials and the role is written in every case (module
    header, ROW LOCK ON users). A refusal after the lock is rolled back by
    get_db_session (P-01), which releases it.
    """
    await lock_user_row(session, user.id)

    is_admin_home = has_admin_home(user.credentials)
    allowed = derive_allowed_roles(
        user.role,
        await user_has_master_capability(user, session),
        admin_home=is_admin_home,
    )

    if target_role not in allowed:
        raise ForbiddenError(
            "Role not allowed for this account",
            code="role_not_allowed",
        )

    # Maintain the admin round-trip marker (see docstring).
    was_admin = user.role == UserRole.ADMIN or is_admin_home
    if was_admin:
        new_credentials = dict(user.credentials or {})
        role_switch = dict(new_credentials.get("role_switch") or {})
        if target_role == UserRole.ADMIN:
            role_switch.pop("home_role", None)
        else:
            role_switch["home_role"] = UserRole.ADMIN.value
        if role_switch:
            new_credentials["role_switch"] = role_switch
        else:
            new_credentials.pop("role_switch", None)
        user.set_jsonb("credentials", new_credentials)

    user.role = target_role
    await session.flush()

    logger.info(
        "user_role_switched",
        user_id=str(user.id),
        new_role=target_role.value,
    )

    return user


async def reset_user_to_onboarding(
    user: User,
    session: AsyncSession,
) -> User:
    """MVP "delete account": send the user back through onboarding.

    PRODUCT DECISION (MVP): "Удалить аккаунт" does NOT erase data or
    deactivate the account. It only clears the onboarding_completed flag in
    the credentials JSONB. On the next Telegram login the user is treated as
    if new (App.vue shows the welcome/onboarding flow again), while their old
    data (name, phone, bio, bookings) stays in place and resurfaces.

    is_active is intentionally NOT touched: login must still succeed so the
    user lands in onboarding rather than being locked out.

    FUTURE: real deletion / deactivation will change THIS function body only;
    the DELETE /users/me contract stays the same so the frontend does not move.

    Mechanism mirrors update_user's JSONB path: copy credentials, drop the
    flag, set_jsonb() so SQLAlchemy emits the UPDATE. The row is locked
    and refreshed first (BE-85, module header).
    """
    await lock_user_row(session, user.id)

    new_credentials = dict(user.credentials or {})
    new_credentials["onboarding_completed"] = False
    user.set_jsonb("credentials", new_credentials)

    await session.flush()

    logger.info(
        "user_account_reset_to_onboarding",
        user_id=str(user.id),
    )

    return user


async def user_has_master_capability(
    user: User,
    session: AsyncSession,
) -> bool:
    """Whether the user has a VERIFIED MasterProfile (i.e. master capability).

    Used by GET /users/me to derive the role_switch block (it gated
    master_notifications too, until T-26 retired that). This is the "is
    effectively a master" check -- deliberately capability-based rather than
    role==MASTER, so an admin (role=ADMIN) who also has a verified MasterProfile
    is still offered MASTER as a switch target. A missing / pending / rejected
    profile -> False.

    Read-only: the caller passes a read session (get_db_reader in the router).
    """
    stmt = select(MasterProfile).where(MasterProfile.user_id == user.id)
    result = await session.execute(stmt)
    profile = result.scalar_one_or_none()
    if profile is None:
        return False
    return profile.data.get("account", {}).get("status") == "verified"


async def get_master_account(
    user: User,
    session: AsyncSession,
) -> dict | None:
    """Return the user's MasterProfile ``data.account`` block, or None (T5).

    One indexed SELECT (same shape as user_has_master_capability). The GET
    /users/me path uses this to derive BOTH master capability
    (status=="verified") AND the application state (status + rejection_reason)
    surfaced to a role='user' applicant, from a single profile load. None when
    the user has no MasterProfile.
    """
    stmt = select(MasterProfile).where(MasterProfile.user_id == user.id)
    result = await session.execute(stmt)
    profile = result.scalar_one_or_none()
    if profile is None:
        return None
    account = profile.data.get("account")
    return account if isinstance(account, dict) else None
