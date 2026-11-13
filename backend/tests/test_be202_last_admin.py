# =============================================================================
# VELO -- BE-202: the support roster never loses its last admin
# =============================================================================
# Band 88660-88679 (free window 88660-88699, telegram_id_bands.py).
#
# comms 3.14 serves a section whose roster was ever declared by its members
# only, and by nobody once they are all removed. velo declares `support`
# with the admin capability (role == admin OR the switched-away marker),
# so every path that takes the capability away refuses its last holder
# with 409 last_admin, before the role is written (LOCK ORDER in
# app/modules/users/service.py).
#
# THE WORLD IS MADE SOLE. refuse_last_admin_drop counts holders across the
# whole users table, and the suite's cleanup resets `role` but not the
# switched-away marker, so other files leave holders behind for the rest
# of the session. A refusal test that counted them would take its colour
# from file order. _sole_admins parks every holder outside this band (role
# user, marker cleared) in a commit before each test and puts each row
# back byte for byte afterwards -- role, credentials, updated_at -- and
# checks that it did.
#
# WHAT IS ASSERTED, per path: the refusal and its pair (the code is
# last_admin AND the row is still a holder, untouched, AND nothing went to
# the outbox about it). For the race: an invariant, not a winner -- one
# drop committed, the other refused, the refused one's row exactly as it
# was, and exactly one holder left.
# =============================================================================

import sys
from collections.abc import AsyncGenerator
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session_factory
from app.core.events.models import OutboxEvent
from app.core.exceptions import ConflictError
from app.modules.admin.masters import service as admin_masters_service
from app.modules.admin.users import service as admin_users_service
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from app.modules.users.schemas import credentials_without_admin_home, has_admin_home
from app.modules.users.service import admin_capability_clause
from scripts import dev_admin_simulator, seed, set_role
from tests.helpers import auth_headers, full_cleanup_range, login_user
from tests.school_race_harness import assert_no_deadlock, race

BAND_MIN, BAND_MAX = 88660, 88679

_MARKER = {"role_switch": {"home_role": UserRole.ADMIN.value}}
_MAKE_MASTER_URL = "/api/v1/admin/users/{user_id}/make-master"


# ---------------------------------------------------------------------------
# The sole world
# ---------------------------------------------------------------------------


def _outside_band():
    return or_(
        User.telegram_id.is_(None),
        User.telegram_id < BAND_MIN,
        User.telegram_id > BAND_MAX,
    )


@pytest.fixture(autouse=True)
async def _sole_admins(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Park every admin-capability holder outside the band; restore after."""
    factory = get_session_factory()
    async with factory() as s:
        parked = (
            await s.execute(
                select(
                    User.id, User.role, User.credentials, User.updated_at,
                    User.snapshot_version,
                ).where(admin_capability_clause(), _outside_band())
            )
        ).all()
        for row in parked:
            await s.execute(
                update(User)
                .where(User.id == row.id)
                .values(
                    role=UserRole.USER.value,
                    credentials=credentials_without_admin_home(row.credentials),
                    updated_at=row.updated_at,
                )
            )
        await s.commit()

    await full_cleanup_range(db_session, BAND_MIN, BAND_MAX, delete_users=True)
    await db_session.commit()
    try:
        yield
    finally:
        await full_cleanup_range(db_session, BAND_MIN, BAND_MAX, delete_users=True)
        await db_session.commit()
        async with factory() as s:
            for row in parked:
                await s.execute(
                    update(User)
                    .where(User.id == row.id)
                    .values(
                        role=row.role,
                        credentials=row.credentials,
                        updated_at=row.updated_at,
                    )
                )
            await s.commit()
            for row in parked:
                back = (
                    await s.execute(
                        select(
                            User.role, User.credentials, User.updated_at,
                            User.snapshot_version,
                        ).where(User.id == row.id)
                    )
                ).one()
                assert tuple(back) == (
                    row.role, row.credentials, row.updated_at,
                    row.snapshot_version,
                ), f"parked row {row.id} did not come back as it was"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _make_user(tid: int, *, role: str, credentials: dict | None = None) -> UUID:
    async with get_session_factory()() as s:
        user = User(
            telegram_id=tid,
            first_name="Roster",
            role=role,
            credentials=dict(credentials or {}),
        )
        s.add(user)
        await s.commit()
        return user.id


async def _login_admin(client: AsyncClient, tid: int) -> tuple[UUID, str]:
    auth = await login_user(client, telegram_id=tid, first_name="Admin")
    uid = UUID(auth["user"]["id"])
    async with get_session_factory()() as s:
        await s.execute(
            update(User).where(User.id == uid).values(role=UserRole.ADMIN.value)
        )
        await s.commit()
    return uid, auth["session_token"]


async def _add_verified_profile(uid: UUID) -> None:
    async with get_session_factory()() as s:
        s.add(
            MasterProfile(
                user_id=uid,
                data={
                    "account": {"status": "verified"},
                    "profile": {"display_name": "Roster Master"},
                    "availability": {"is_accepting": True},
                },
            )
        )
        await s.commit()


async def _row(uid: UUID) -> User:
    async with get_session_factory()() as s:
        return (await s.execute(select(User).where(User.id == uid))).scalar_one()


async def _profile(uid: UUID) -> MasterProfile | None:
    async with get_session_factory()() as s:
        return await s.get(MasterProfile, uid)


async def _events(uid: UUID) -> list[OutboxEvent]:
    p = OutboxEvent.payload
    async with get_session_factory()() as s:
        return list(
            (
                await s.execute(
                    select(OutboxEvent).where(
                        or_(
                            p["recipient_id"].astext == str(uid),
                            p["operator_id"].astext == str(uid),
                        )
                    )
                )
            ).scalars()
        )


async def _holders() -> set[UUID]:
    async with get_session_factory()() as s:
        return set(
            (
                await s.execute(select(User.id).where(admin_capability_clause()))
            ).scalars()
        )


def _state(row: User) -> tuple:
    return (row.role, row.credentials, row.updated_at, row.snapshot_version)


async def _assert_refused_untouched(
    uid: UUID, before: tuple, events_before: int
) -> None:
    """The pair of every refusal: still a holder, the row as it was, and
    nothing about it went to the outbox."""
    row = await _row(uid)
    assert _state(row) == before
    assert row.role == UserRole.ADMIN.value or has_admin_home(row.credentials)
    assert len(await _events(uid)) == events_before


def _seed_spec(tid: int) -> dict:
    return {
        "key": "m",
        "telegram_id": tid,
        "display_name": "Seed Master",
        "bio": "bio",
        "methods": ["meditation — presence"],
        "experience_years": 1,
    }


# ---------------------------------------------------------------------------
# The capability as SQL reads as the capability in Python
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("offset", "role", "credentials", "holder"),
    [
        pytest.param(0, UserRole.ADMIN.value, {}, True, id="admin-role"),
        pytest.param(1, UserRole.USER.value, _MARKER, True, id="user-with-marker"),
        pytest.param(2, UserRole.MASTER.value, _MARKER, True, id="master-with-marker"),
        pytest.param(3, UserRole.USER.value, {}, False, id="plain-user"),
        pytest.param(4, UserRole.MASTER.value, {}, False, id="plain-master"),
    ],
)
async def test_clause_and_python_agree(offset, role, credentials, holder) -> None:
    uid = await _make_user(BAND_MIN + offset, role=role, credentials=credentials)
    row = await _row(uid)
    in_sql = uid in await _holders()
    in_python = row.role == UserRole.ADMIN.value or has_admin_home(row.credentials)
    assert in_sql == in_python == holder


# ---------------------------------------------------------------------------
# Every path refuses the last holder
# ---------------------------------------------------------------------------


async def test_make_master_on_the_last_admin_is_409_twice_and_writes_nothing(
    client: AsyncClient,
) -> None:
    """POST make-master on oneself as the only admin. POVTOR: twice, the
    same answer, the row and the outbox untouched both times."""
    uid, token = await _login_admin(client, BAND_MIN)
    before = _state(await _row(uid))
    events_before = len(await _events(uid))

    for _ in range(2):
        resp = await client.post(
            _MAKE_MASTER_URL.format(user_id=uid), headers=auth_headers(token)
        )
        assert resp.status_code == 409
        assert resp.json()["error"] == "last_admin"
        await _assert_refused_untouched(uid, before, events_before)
    assert await _profile(uid) is None


async def test_a_marker_only_holder_is_enough_to_let_the_admin_go(
    client: AsyncClient,
) -> None:
    """NEKHVATKA: the one other holder is a switched-away admin (role
    user, marker). It counts -- velo declares it on the roster -- so the
    drop goes through and the dropped admin leaves group:admins."""
    other = await _make_user(
        BAND_MIN + 1, role=UserRole.USER.value, credentials=_MARKER
    )
    uid, token = await _login_admin(client, BAND_MIN)

    resp = await client.post(
        _MAKE_MASTER_URL.format(user_id=uid), headers=auth_headers(token)
    )
    assert resp.status_code == 200, resp.text
    assert (await _row(uid)).role == UserRole.MASTER.value
    assert await _holders() == {other}
    assert [
        e.payload["member"]
        for e in await _events(uid)
        if e.event_type == "section_membership_changed"
    ] == [False]


async def test_revoke_of_the_last_holder_is_refused() -> None:
    """revoke_master drops the capability of a master holding the marker.
    The last such holder, revoked with itself as the actor -- what
    dev_admin_simulator --suspend does when no admin exists
    (actor_or_self) -- is refused; profile and row untouched."""
    uid = await _make_user(
        BAND_MIN + 2, role=UserRole.MASTER.value, credentials=_MARKER
    )
    await _add_verified_profile(uid)
    before = _state(await _row(uid))
    events_before = len(await _events(uid))

    async with get_session_factory()() as s:
        actor = await s.get(User, uid)
        with pytest.raises(ConflictError) as exc:
            await admin_masters_service.revoke_master(uid, actor, s)
        await s.rollback()
    assert exc.value.code == "last_admin"
    await _assert_refused_untouched(uid, before, events_before)
    assert (await _profile(uid)).data["account"]["status"] == "verified"


async def test_revoke_of_a_user_mode_holder_keeps_the_marker_unrefused() -> None:
    """A holder in role user with a verified profile: revoke suspends the
    profile and leaves role and marker alone -- no drop, so even the only
    holder is not refused."""
    uid = await _make_user(BAND_MIN + 3, role=UserRole.USER.value, credentials=_MARKER)
    await _add_verified_profile(uid)

    async with get_session_factory()() as s:
        actor = await s.get(User, uid)
        await admin_masters_service.revoke_master(uid, actor, s)
        await s.commit()
    assert await _holders() == {uid}
    assert (await _profile(uid)).data["account"]["status"] == "suspended"


@pytest.mark.parametrize("letter", ["M", "U"])
async def test_setrole_on_the_last_admin_exits_1_and_commits_nothing(
    monkeypatch: pytest.MonkeyPatch, letter: str
) -> None:
    """`velo setrole <id> M|U --yes` on the only admin: exit 1, nothing
    committed (to_master and to_user each carry the refusal)."""
    tid = BAND_MIN + 4
    uid = await _make_user(tid, role=UserRole.ADMIN.value)
    before = _state(await _row(uid))
    events_before = len(await _events(uid))

    async def _keep_engine() -> None:
        return None

    monkeypatch.setattr(set_role, "dispose_engine", _keep_engine)
    monkeypatch.setattr(sys, "argv", ["set_role.py", str(tid), letter, "--yes"])
    assert await set_role.main() == 1
    await _assert_refused_untouched(uid, before, events_before)
    assert await _profile(uid) is None


async def test_setrole_u_on_a_profileless_user_mode_holder_is_nothing_to_do() -> None:
    """to_user on role user without a profile answers "nothing to do"
    before the refusal: the marker stays, nothing is dropped."""
    tid = BAND_MIN + 5
    uid = await _make_user(tid, role=UserRole.USER.value, credentials=_MARKER)
    async with get_session_factory()() as s:
        user = await set_role._find_user(s, tid)
        assert await set_role.to_user(s, user, True) is False
        await s.rollback()
    assert await _holders() == {uid}


async def test_seed_flipping_the_last_admin_raises_and_writes_nothing() -> None:
    tid = BAND_MIN + 6
    uid = await _make_user(tid, role=UserRole.ADMIN.value)
    before = _state(await _row(uid))
    events_before = len(await _events(uid))

    async with get_session_factory()() as s:
        with pytest.raises(ConflictError) as exc:
            await seed.ensure_master(s, _seed_spec(tid))
        await s.rollback()
    assert exc.value.code == "last_admin"
    await _assert_refused_untouched(uid, before, events_before)
    assert await _profile(uid) is None


async def test_dev_reset_master_on_the_last_admin_exits_and_writes_nothing() -> None:
    uid = await _make_user(BAND_MIN + 7, role=UserRole.ADMIN.value)
    before = _state(await _row(uid))

    with pytest.raises(SystemExit) as exc:
        await dev_admin_simulator.run_reset_master(str(uid), False)
    assert "last_admin" in str(exc.value)
    row = await _row(uid)
    assert _state(row) == before
    assert row.role == UserRole.ADMIN.value


async def test_make_master_of_a_plain_user_with_no_admin_at_all_is_allowed() -> None:
    """PUSTOTA: no holder at all, and the target is none either -- nothing
    is dropped, so the count is never the answer."""
    uid = await _make_user(BAND_MIN + 8, role=UserRole.USER.value)
    assert await _holders() == set()

    async with get_session_factory()() as s:
        actor = await s.get(User, uid)
        await admin_users_service.make_master(uid, actor, s)
        await s.commit()
    assert (await _row(uid)).role == UserRole.MASTER.value


async def test_the_refusal_comes_before_the_write_in_the_session() -> None:
    """Before the row changes, not after it and a rollback: the refused
    session itself still reads the admin -- no flushed UPDATE, and the
    object in its identity map still says admin."""
    uid = await _make_user(BAND_MIN + 9, role=UserRole.ADMIN.value)
    async with get_session_factory()() as s:
        actor = await s.get(User, uid)
        with pytest.raises(ConflictError):
            await admin_users_service.make_master(uid, actor, s)
        assert actor.role == UserRole.ADMIN.value
        seen = (
            await s.execute(select(User.role).where(User.id == uid))
        ).scalar_one()
        assert seen == UserRole.ADMIN.value
        await s.rollback()


# ---------------------------------------------------------------------------
# The race: two drops of the last two holders
# ---------------------------------------------------------------------------


async def test_two_drops_of_the_last_two_admins_let_one_through(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """make_master(A) is held right after its count; `setrole B U` comes in.
    It waits on the admin roster lock, counts after A's commit, finds
    nobody else and is refused. Invariant: one drop committed, the other
    refused with its row exactly as it was, one holder left."""
    a = await _make_user(BAND_MIN + 10, role=UserRole.ADMIN.value)
    b_tid = BAND_MIN + 11
    b = await _make_user(b_tid, role=UserRole.ADMIN.value)
    b_before = _state(await _row(b))

    async def holder(s: AsyncSession) -> None:
        actor = await s.get(User, a)
        await admin_users_service.make_master(a, actor, s)

    async def rival(s: AsyncSession) -> None:
        user = await set_role._find_user(s, b_tid)
        await set_role.to_user(s, user, True)

    result = await race(
        monkeypatch,
        holder=holder,
        pause_in=(admin_users_service, "refuse_last_admin_drop"),
        pause="after",
        rival=rival,
    )

    assert_no_deadlock(result)
    assert result.rival_waited, "the two never met -- the test proves nothing"
    assert result.holder.committed, result.holder.error
    assert isinstance(result.rival.error, ConflictError), result.rival.error
    assert result.rival.error.code == "last_admin"
    assert (await _row(a)).role == UserRole.MASTER.value
    assert _state(await _row(b)) == b_before
    assert await _holders() == {b}


async def test_cli_and_route_on_one_admin_meet_without_a_deadlock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`setrole A U` against make_master(A), the CLI held just before it
    asks for the roster lock -- the point where a path that took A's row
    BEFORE the roster lock would hold the row while the route holds the
    lock and waits for it: 40P01. Taken first, the CLI holds nothing
    there, the route goes through, the CLI follows. B keeps the roster
    non-empty, so nothing is refused."""
    a_tid = BAND_MIN + 12
    a = await _make_user(a_tid, role=UserRole.ADMIN.value)
    b = await _make_user(BAND_MIN + 13, role=UserRole.ADMIN.value)

    async def holder(s: AsyncSession) -> None:
        user = await set_role._find_user(s, a_tid)
        assert await set_role.to_user(s, user, True)

    async def rival(s: AsyncSession) -> None:
        actor = await s.get(User, b)
        await admin_users_service.make_master(a, actor, s)

    result = await race(
        monkeypatch,
        holder=holder,
        pause_in=(set_role, "take_admin_roster_lock"),
        pause="before",
        rival=rival,
    )

    assert_no_deadlock(result)
    assert result.rival.committed, result.rival.error
    assert result.holder.committed, result.holder.error
    row = await _row(a)
    assert row.role == UserRole.USER.value
    assert not has_admin_home(row.credentials)
    assert (await _profile(a)).data["account"]["status"] == "suspended"
    assert await _holders() == {b}
