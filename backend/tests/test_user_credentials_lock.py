# =============================================================================
# VELO -- Tests: writers of User.credentials take the users row first (BE-85)
# =============================================================================
#
# telegram_id band: 70850-70899.
#
# BAND PROVENANCE. On 2026-10-01 70850-70899 lay inside the free window
# 70050-79299 of free_windows() over ALLOWED_SPACE.
#
# WHAT IS UNDER TEST
#
#   Every writer of credentials rewrites the whole dict from the copy in
#   memory. Before BE-85 none of them locked the row, so a writer that had
#   read it before another committed put the old blob back. For the email
#   that is a divergence from comms: update_user emits the new address, a
#   stale switch_user_role restores the old one, the snapshot_version
#   trigger raises the version, nobody emits.
#
#   Now each writer takes the row with lock_user_row (FOR NO KEY UPDATE,
#   populate_existing) before it reads it, and the order with
#   master_profiles is users -> master_profiles. Both are written once, in
#   the header of app/modules/users/service.py (ROW LOCK ON users).
#
# HOW THE CROSSING IS BUILT. tests/curator_race_harness.race: the holder is
# paused inside its window by wrapping a real call it makes there, the
# rival runs until Postgres reports it waiting on a lock (pg_stat_activity)
# or finishes, then the holder is released. The rival loads the user the
# way the auth dependency does -- a plain SELECT, before the holder
# commits -- so it holds exactly the stale copy a real request would.
#
# WHAT IS ASSERTED IS AN INVARIANT, NOT A WINNER: the email in the row is
# the email of the last user_upserted snapshot in the outbox, and the
# version too; plus the pair -- what each side wrote is still there.
# =============================================================================

from collections.abc import AsyncGenerator
from uuid import UUID

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session_factory
from app.core.events.models import OutboxEvent
from app.modules.admin.masters import service as admin_masters_service
from app.modules.masters.models import MasterProfile
from app.modules.payments.models import UserLedger
from app.modules.users import service as users_service
from app.modules.users.models import User, UserRole
from app.modules.users.schemas import UserUpdate
from app.modules.users.service import switch_user_role, update_user
from tests.curator_race_harness import race
from tests.helpers import full_cleanup_range

_TID_MIN = 70850
_TID_MAX = 70899

_DEADLOCK = "40P01"
_LOCK_NOT_AVAILABLE = "55P03"


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _sqlstate(exc: BaseException | None) -> str | None:
    orig = getattr(exc, "orig", None)
    for candidate in (orig, getattr(orig, "__cause__", None)):
        state = getattr(candidate, "sqlstate", None)
        if state:
            return state
    return None


async def _make_user(telegram_id: int, *, role: str, credentials: dict) -> UUID:
    factory = get_session_factory()
    async with factory() as s:
        user = User(
            telegram_id=telegram_id,
            first_name="Lock",
            role=role,
            credentials=credentials,
        )
        s.add(user)
        await s.commit()
        return user.id


async def _add_verified_profile(user_id: UUID) -> None:
    factory = get_session_factory()
    async with factory() as s:
        s.add(
            MasterProfile(
                user_id=user_id,
                data={
                    "account": {"status": "verified"},
                    "profile": {"display_name": "Lock Master"},
                    "availability": {"is_accepting": True},
                },
            )
        )
        await s.commit()


async def _row(user_id: UUID) -> User:
    factory = get_session_factory()
    async with factory() as s:
        return (await s.execute(select(User).where(User.id == user_id))).scalar_one()


async def _snapshots(user_id: UUID) -> list[dict]:
    """user_upserted payloads for the user, in publication order."""
    factory = get_session_factory()
    async with factory() as s:
        rows = (
            (
                await s.execute(
                    select(OutboxEvent.payload)
                    .where(
                        OutboxEvent.event_type == "user_upserted",
                        OutboxEvent.payload["recipient_id"].astext == str(user_id),
                    )
                    .order_by(OutboxEvent.id)
                )
            )
            .scalars()
            .all()
        )
    return list(rows)


async def _load_unlocked(s: AsyncSession, user_id: UUID) -> User:
    """Load the user as the auth dependency does: a plain SELECT."""
    return (await s.execute(select(User).where(User.id == user_id))).scalar_one()


async def _assert_row_matches_last_snapshot(user_id: UUID) -> User:
    row = await _row(user_id)
    snaps = await _snapshots(user_id)
    assert snaps, "the PATCH emitted no snapshot -- nothing to compare with"
    last = snaps[-1]
    assert (row.credentials or {}).get("email") == last["email"], (
        f"row email {row.credentials.get('email')!r} vs last snapshot {last['email']!r}"
    )
    assert row.snapshot_version == last["version"], (
        f"row version {row.snapshot_version} vs last snapshot "
        f"{last['version']} -- a write changed the snapshot and nobody sent it"
    )
    return row


async def _nowait_probe(user_id: UUID, strength: str) -> str | None:
    """Try the row lock of `strength` NOWAIT from a fresh session.

    Returns the SQLSTATE of the failure, or None when the lock was granted.
    """
    factory = get_session_factory()
    async with factory() as s:
        try:
            await s.execute(
                text(f"SELECT id FROM users WHERE id = :id {strength} NOWAIT"),
                {"id": user_id},
            )
            return None
        except DBAPIError as exc:
            return _sqlstate(exc)
        finally:
            await s.rollback()


# ---------------------------------------------------------------------------
# The invariant: PATCH email against an admin's role switch
# ---------------------------------------------------------------------------

# PUSTOTA: {} is the reachable empty blob (server_default '{}'); None is
# not reachable -- the column is NOT NULL in the migration -- so it is not
# built here.
_INITIAL = [
    pytest.param({}, id="empty-credentials"),
    pytest.param(
        {"email": "old@lock.example", "telegram_username": "keepme"},
        id="filled-credentials",
    ),
]


@pytest.mark.parametrize("initial", _INITIAL)
async def test_patch_email_then_stale_switch_keeps_row_equal_to_snapshot(
    monkeypatch: pytest.MonkeyPatch, initial: dict
) -> None:
    """The PATCH holds the row (email written, snapshot emitted); a switch
    that loaded the user before the PATCH committed comes in. It must wait,
    re-read, and leave the new email -- otherwise it writes its stale copy
    back and the row disagrees with the snapshot comms got."""
    uid = await _make_user(
        _TID_MIN + 1, role=UserRole.ADMIN.value, credentials=dict(initial)
    )

    async def holder(s: AsyncSession) -> None:
        user = await _load_unlocked(s, uid)
        await update_user(user, UserUpdate(email="new@lock.example"), s)

    async def rival(s: AsyncSession) -> None:
        user = await _load_unlocked(s, uid)
        await switch_user_role(user, UserRole.USER, s)

    result = await race(
        monkeypatch,
        holder=holder,
        pause_in=(users_service, "emit_user_upserted"),
        pause="after",
        rival=rival,
    )

    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert result.rival_waited, "the two never met -- the test proves nothing"

    row = await _assert_row_matches_last_snapshot(uid)
    assert row.credentials["email"] == "new@lock.example"
    # The pair: the switch's own effect is there too.
    assert row.role == UserRole.USER.value
    assert row.credentials["role_switch"]["home_role"] == UserRole.ADMIN.value
    for key, value in initial.items():
        if key != "email":
            assert row.credentials[key] == value


@pytest.mark.parametrize("initial", _INITIAL)
async def test_switch_then_stale_patch_keeps_marker_and_email(
    monkeypatch: pytest.MonkeyPatch, initial: dict
) -> None:
    """The other start order: the switch holds the row and has decided; a
    PATCH that loaded the user before it committed comes in. The PATCH must
    wait and merge into the switched row -- otherwise one of the two blobs
    is lost (the marker, or the email the snapshot already carries)."""
    uid = await _make_user(
        _TID_MIN + 2, role=UserRole.ADMIN.value, credentials=dict(initial)
    )

    async def holder(s: AsyncSession) -> None:
        user = await _load_unlocked(s, uid)
        await switch_user_role(user, UserRole.USER, s)

    async def rival(s: AsyncSession) -> None:
        user = await _load_unlocked(s, uid)
        await update_user(user, UserUpdate(email="new@lock.example"), s)

    result = await race(
        monkeypatch,
        holder=holder,
        pause_in=(users_service, "user_has_master_capability"),
        pause="after",
        rival=rival,
    )

    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert result.rival_waited, "the two never met -- the test proves nothing"

    row = await _assert_row_matches_last_snapshot(uid)
    assert row.credentials["email"] == "new@lock.example"
    assert row.role == UserRole.USER.value
    assert row.credentials["role_switch"]["home_role"] == UserRole.ADMIN.value


_MARKER = {"role_switch": {"home_role": UserRole.ADMIN.value}}


async def _rival_reset(s: AsyncSession, uid: UUID, admin_id: UUID) -> None:
    user = await _load_unlocked(s, uid)
    await users_service.reset_user_to_onboarding(user, s)


async def _rival_make_master(s: AsyncSession, uid: UUID, admin_id: UUID) -> None:
    from app.modules.admin.users.service import make_master

    # make_master loads the user itself; the plain read the dependency
    # would do is the admin, not the target -- the target's stale copy is
    # whatever make_master's own load sees before the PATCH commits.
    await _load_unlocked(s, uid)
    admin = await _load_unlocked(s, admin_id)
    await make_master(uid, admin, s)


async def _rival_revoke(s: AsyncSession, uid: UUID, admin_id: UUID) -> None:
    await _load_unlocked(s, uid)
    admin = await _load_unlocked(s, admin_id)
    await admin_masters_service.revoke_master(uid, admin, s)


@pytest.mark.parametrize(
    ("rival_call", "role", "with_profile", "offset"),
    [
        pytest.param(_rival_reset, UserRole.USER.value, False, 20, id="reset"),
        pytest.param(
            _rival_make_master, UserRole.USER.value, False, 21, id="make_master"
        ),
        pytest.param(
            _rival_revoke, UserRole.MASTER.value, True, 22, id="revoke_master"
        ),
    ],
)
async def test_patch_email_then_stale_writer_keeps_row_equal_to_snapshot(
    monkeypatch: pytest.MonkeyPatch, rival_call, role, with_profile, offset
) -> None:
    """Every other credentials writer against a PATCH of the email that
    holds the row: each must wait and write into the PATCHed row. The user
    carries the switched-away-admin marker, so make_master and revoke do
    rewrite credentials (they clear it); reset always does."""
    admin_id = await _make_user(
        _TID_MIN + offset + 10, role=UserRole.ADMIN.value, credentials={}
    )
    uid = await _make_user(
        _TID_MIN + offset,
        role=role,
        credentials={"email": "old@lock.example", **_MARKER},
    )
    if with_profile:
        await _add_verified_profile(uid)

    async def holder(s: AsyncSession) -> None:
        user = await _load_unlocked(s, uid)
        await update_user(user, UserUpdate(email="new@lock.example"), s)

    async def rival(s: AsyncSession) -> None:
        await rival_call(s, uid, admin_id)

    result = await race(
        monkeypatch,
        holder=holder,
        pause_in=(users_service, "emit_user_upserted"),
        pause="after",
        rival=rival,
    )

    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert result.rival_waited, "the two never met -- the test proves nothing"
    row = await _assert_row_matches_last_snapshot(uid)
    assert row.credentials["email"] == "new@lock.example"


# ---------------------------------------------------------------------------
# POVTOR: two PATCHes
# ---------------------------------------------------------------------------


async def test_concurrent_patches_of_different_fields_both_survive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two PATCHes at once, different credentials fields: the second waits
    and merges into the first one's row instead of writing back the copy
    it read before -- phone and bio both survive, and the email in the row
    is the email of the last snapshot."""
    uid = await _make_user(_TID_MIN + 3, role=UserRole.USER.value, credentials={})

    async def holder(s: AsyncSession) -> None:
        user = await _load_unlocked(s, uid)
        await update_user(
            user, UserUpdate(email="first@lock.example", phone="+4930123456"), s
        )

    async def rival(s: AsyncSession) -> None:
        user = await _load_unlocked(s, uid)
        await update_user(user, UserUpdate(email="second@lock.example", bio="bio"), s)

    result = await race(
        monkeypatch,
        holder=holder,
        pause_in=(users_service, "emit_user_upserted"),
        pause="after",
        rival=rival,
    )

    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert result.rival_waited

    row = await _assert_row_matches_last_snapshot(uid)
    assert row.credentials["phone"] == "+4930123456"
    assert row.credentials["bio"] == "bio"
    assert row.credentials["email"] == "second@lock.example"
    versions = [snap["version"] for snap in await _snapshots(uid)]
    assert versions == sorted(versions) and len(set(versions)) == 2, versions


async def test_same_patch_twice_in_a_row_raises_the_version_once() -> None:
    """Sequential repeat: the second PATCH with the same email is a replay
    -- it emits again with the SAME version, and the row still matches."""
    uid = await _make_user(_TID_MIN + 4, role=UserRole.USER.value, credentials={})
    factory = get_session_factory()
    for _ in range(2):
        async with factory() as s:
            user = await _load_unlocked(s, uid)
            await update_user(user, UserUpdate(email="same@lock.example"), s)
            await s.commit()

    await _assert_row_matches_last_snapshot(uid)
    snaps = await _snapshots(uid)
    assert len(snaps) == 2
    assert snaps[0]["version"] == snaps[1]["version"]
    assert snaps[1]["email"] == "same@lock.example"


# ---------------------------------------------------------------------------
# NEHVATKA: the writer fails after taking the lock
# ---------------------------------------------------------------------------


async def test_writer_failing_after_the_lock_leaves_row_and_outbox(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """update_user throws after it locked, wrote and emitted. The session
    is rolled back the way get_db_session does it (P-01): the email is the
    old one, no snapshot left, and the lock is gone with the transaction."""
    uid = await _make_user(
        _TID_MIN + 5,
        role=UserRole.USER.value,
        credentials={"email": "old@lock.example"},
    )
    real_emit = users_service.emit_user_upserted

    async def emit_then_fail(session, user) -> None:
        await real_emit(session, user)
        raise RuntimeError("boom after emit")

    monkeypatch.setattr(users_service, "emit_user_upserted", emit_then_fail)

    factory = get_session_factory()
    async with factory() as s:
        user = await _load_unlocked(s, uid)
        with pytest.raises(RuntimeError, match="boom after emit"):
            await update_user(user, UserUpdate(email="new@lock.example"), s)
        # While the failed transaction is still open the row is held ...
        assert await _nowait_probe(uid, "FOR NO KEY UPDATE") == (_LOCK_NOT_AVAILABLE)
        await s.rollback()

    # ... and after the rollback it is free, unchanged, with no snapshot.
    assert await _nowait_probe(uid, "FOR NO KEY UPDATE") is None
    row = await _row(uid)
    assert row.credentials == {"email": "old@lock.example"}
    assert await _snapshots(uid) == []


# ---------------------------------------------------------------------------
# The strength: FOR NO KEY UPDATE, not FOR UPDATE
# ---------------------------------------------------------------------------


async def test_child_insert_does_not_wait_for_a_credentials_writer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """While update_user holds the row, an insert of a child row (the FK
    check takes KEY SHARE on users) goes through without waiting. Pair:
    both committed, the PATCH's email is in the row."""
    uid = await _make_user(_TID_MIN + 6, role=UserRole.USER.value, credentials={})

    async def holder(s: AsyncSession) -> None:
        user = await _load_unlocked(s, uid)
        await update_user(user, UserUpdate(email="new@lock.example"), s)

    async def rival(s: AsyncSession) -> None:
        s.add(
            UserLedger(user_id=uid, amount_cents=0, status="done", reason="be85-probe")
        )
        await s.flush()

    result = await race(
        monkeypatch,
        holder=holder,
        pause_in=(users_service, "emit_user_upserted"),
        pause="after",
        rival=rival,
    )

    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert not result.rival_waited, (
        "a child insert waited for the credentials writer -- the lock is "
        "stronger than FOR NO KEY UPDATE"
    )
    await _assert_row_matches_last_snapshot(uid)


# ---------------------------------------------------------------------------
# The order: users -> master_profiles (revoke_master was turned)
# ---------------------------------------------------------------------------


async def test_revoke_against_cli_downgrade_does_not_deadlock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`velo setrole <id> U` (set_role.to_user) takes users first (its
    _find_user) and then writes the profile. It is held after the users
    lock; revoke_master of the same master comes in. revoke takes users
    first too, so it waits for the CLI and then finds the profile already
    suspended (409). With the old order -- the profile FOR UPDATE first --
    revoke would hold the profile and wait for users, the CLI would wait
    for the profile: 40P01. Invariant: the CLI committed, revoke refused,
    and the row is what the CLI left."""
    from scripts import set_role

    admin_id = await _make_user(_TID_MIN + 8, role=UserRole.ADMIN.value, credentials={})
    master_tid = _TID_MIN + 9
    master_id = await _make_user(master_tid, role=UserRole.MASTER.value, credentials={})
    await _add_verified_profile(master_id)

    async def holder(s: AsyncSession) -> None:
        user = await set_role._find_user(s, master_tid)
        applied = await set_role.to_user(s, user, True)
        assert applied

    async def rival(s: AsyncSession) -> None:
        admin = await _load_unlocked(s, admin_id)
        await admin_masters_service.revoke_master(master_id, admin, s)

    result = await race(
        monkeypatch,
        holder=holder,
        pause_in=(set_role, "_scheduled_or_live_practices"),
        pause="after",
        rival=rival,
    )

    for side in (result.holder, result.rival):
        assert _sqlstate(side.error) != _DEADLOCK, side.error
    assert result.rival_waited, "the two never met -- the test proves nothing"
    assert result.holder.committed, result.holder.error
    assert result.rival.error is not None
    assert "not verified" in str(result.rival.error)

    row = await _row(master_id)
    assert row.role == UserRole.USER.value
    factory = get_session_factory()
    async with factory() as s:
        profile = await s.get(MasterProfile, master_id)
        assert profile.data["account"]["status"] == "suspended"


# ---------------------------------------------------------------------------
# The scripts take the row FOR NO KEY UPDATE
# ---------------------------------------------------------------------------


async def test_set_role_find_user_takes_the_row() -> None:
    """set_role._find_user holds the row to the CLI's commit: a second
    session cannot take FOR NO KEY UPDATE NOWAIT (55P03). Pair: KEY SHARE
    still goes through -- the lock is not FOR UPDATE."""
    from scripts import set_role

    tid = _TID_MIN + 10
    uid = await _make_user(tid, role=UserRole.USER.value, credentials={})
    factory = get_session_factory()
    async with factory() as s:
        user = await set_role._find_user(s, tid)
        assert user is not None and user.id == uid
        assert await _nowait_probe(uid, "FOR NO KEY UPDATE") == (_LOCK_NOT_AVAILABLE)
        assert await _nowait_probe(uid, "FOR KEY SHARE") is None
        await s.rollback()


async def test_seed_ensure_master_takes_the_row() -> None:
    """seed.ensure_master takes the row before the profile. The user is a
    master with a verified profile already, so nothing else writes the
    row: the lock is the only thing holding it. Pair as above."""
    from scripts import seed

    tid = _TID_MIN + 11
    uid = await _make_user(tid, role=UserRole.MASTER.value, credentials={})
    await _add_verified_profile(uid)
    factory = get_session_factory()
    async with factory() as s:
        user = await seed.ensure_master(
            s, {"telegram_id": tid, "display_name": "Lock Master"}
        )
        assert user.id == uid
        assert await _nowait_probe(uid, "FOR NO KEY UPDATE") == (_LOCK_NOT_AVAILABLE)
        assert await _nowait_probe(uid, "FOR KEY SHARE") is None
        await s.rollback()
