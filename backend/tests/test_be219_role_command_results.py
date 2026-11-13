# =============================================================================
# VELO -- BE-219: the role commands report what they really did
# =============================================================================
# Band 88680-88699 (free window 88680-88699, telegram_id_bands.py).
#
# 1. `velo setrole` (scripts/set_role.py main): 0 -- committed or nothing
#    to do; 1 -- refused, nothing committed; 2 -- wrong arguments. Each
#    branch is driven through main itself, as the machine's verb runs it.
# 2. dev_admin_simulator --reset-master goes through the projection: a
#    verified profile deleted is group:masters left, role=user without the
#    switched-away marker is group:admins and the support roster left --
#    read from rows it holds (LOCK ORDER in app/modules/users/service.py),
#    which the two races measure.
#
# Every drop of an admin capability here keeps another admin in the band:
# the last holder is refused (BE-202), which is tested in
# test_be202_last_admin.py, not here.
# =============================================================================

import sys
from collections.abc import AsyncGenerator
from uuid import UUID

import pytest
from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session_factory
from app.core.events import (
    EVENT_GROUP_CHANGED,
    EVENT_SECTION_MEMBERSHIP_CHANGED,
    GROUP_ADMINS,
    GROUP_MASTERS,
)
from app.core.events.models import OutboxEvent
from app.modules.admin.masters import service as admin_masters_service
from app.modules.masters.models import MasterProfile
from app.modules.users import service as users_service
from app.modules.users.models import User, UserRole
from app.modules.users.schemas import has_admin_capability, has_admin_home
from scripts import dev_admin_simulator, set_role
from tests.helpers import full_cleanup_range
from tests.school_race_harness import assert_no_deadlock, race

BAND_MIN, BAND_MAX = 88680, 88699

_MARKER = {"role_switch": {"home_role": UserRole.ADMIN.value}}


@pytest.fixture(autouse=True)
async def _clean(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, BAND_MIN, BAND_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, BAND_MIN, BAND_MAX, delete_users=True)
    await db_session.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _make_user(
    tid: int, *, role: str, credentials: dict | None = None
) -> UUID:
    async with get_session_factory()() as s:
        user = User(
            telegram_id=tid,
            first_name="Result",
            role=role,
            credentials=dict(credentials or {}),
        )
        s.add(user)
        await s.commit()
        return user.id


async def _add_profile(uid: UUID, status: str) -> None:
    async with get_session_factory()() as s:
        s.add(
            MasterProfile(
                user_id=uid,
                data={
                    "account": {"status": status},
                    "profile": {"display_name": "Result Master", "methods": []},
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
                    select(OutboxEvent)
                    .where(
                        or_(
                            p["recipient_id"].astext == str(uid),
                            p["operator_id"].astext == str(uid),
                        )
                    )
                    .order_by(OutboxEvent.id)
                )
            ).scalars()
        )


async def _membership(uid: UUID) -> list[tuple[str, bool]]:
    """(group or section key, member) of every membership event, in order."""
    out = []
    for e in await _events(uid):
        if e.event_type == EVENT_GROUP_CHANGED:
            out.append((e.payload["group_key"], e.payload["member"]))
        elif e.event_type == EVENT_SECTION_MEMBERSHIP_CHANGED:
            out.append((e.payload["section_key"], e.payload["member"]))
    return out


def _state(row: User) -> tuple:
    return (row.role, row.credentials, row.updated_at, row.snapshot_version)


async def _keep_another_admin() -> UUID:
    return await _make_user(BAND_MAX, role=UserRole.ADMIN.value)


@pytest.fixture
def setrole(monkeypatch: pytest.MonkeyPatch):
    """Run `velo setrole <args>` through main; the engine stays up."""

    async def _keep_engine() -> None:
        return None

    monkeypatch.setattr(set_role, "dispose_engine", _keep_engine)

    async def _run(*args: str) -> int:
        monkeypatch.setattr(sys, "argv", ["set_role.py", *args])
        return await set_role.main()

    return _run


# ---------------------------------------------------------------------------
# 1. setrole exit codes
# ---------------------------------------------------------------------------


async def test_a_live_master_side_refuses_u_with_1_and_writes_nothing(setrole) -> None:
    """The downgrade guard used to answer 0. A non-zero balance is a live
    master side: exit 1, the row, the profile and the outbox untouched."""
    tid = BAND_MIN
    uid = await _make_user(tid, role=UserRole.MASTER.value)
    await _add_profile(uid, "verified")
    async with get_session_factory()() as s:
        await s.execute(
            update(MasterProfile)
            .where(MasterProfile.user_id == uid)
            .values(available_cents=100)
        )
        await s.commit()
    before = _state(await _row(uid))

    assert await setrole(str(tid), "U", "--yes") == 1
    assert _state(await _row(uid)) == before
    assert (await _profile(uid)).data["account"]["status"] == "verified"
    assert await _events(uid) == []


async def test_answering_n_refuses_with_1(setrole, monkeypatch) -> None:
    tid = BAND_MIN + 1
    uid = await _make_user(tid, role=UserRole.USER.value)
    before = _state(await _row(uid))
    monkeypatch.setattr("builtins.input", lambda prompt="": "n")

    assert await setrole(str(tid), "A") == 1
    assert _state(await _row(uid)) == before
    assert await _events(uid) == []


async def test_an_unknown_user_is_1(setrole) -> None:
    assert await setrole(str(BAND_MIN + 2), "A", "--yes") == 1


@pytest.mark.parametrize(
    "args",
    [
        pytest.param([str(BAND_MIN + 3)], id="no-role"),
        pytest.param([str(BAND_MIN + 3), "X"], id="unknown-letter"),
        pytest.param(["not-a-number", "A"], id="id-not-a-number"),
    ],
)
async def test_wrong_arguments_are_2(setrole, args) -> None:
    with pytest.raises(SystemExit) as exc:
        await setrole(*args, "--yes")
    assert exc.value.code == 2


async def test_nothing_to_do_is_0_and_a_change_is_0_and_committed(setrole) -> None:
    """POVTOR: A twice. The first commits the role and the roster ADD; the
    second finds an admin and says so -- 0, nothing new in the outbox
    (frontend/e2e/stack/up.sh runs `setrole 607031 A` under set -e)."""
    tid = BAND_MIN + 4
    uid = await _make_user(tid, role=UserRole.USER.value)

    assert await setrole(str(tid), "A", "--yes") == 0
    assert (await _row(uid)).role == UserRole.ADMIN.value
    events_after_first = len(await _events(uid))
    assert events_after_first > 0

    assert await setrole(str(tid), "A", "--yes") == 0
    assert len(await _events(uid)) == events_after_first


# ---------------------------------------------------------------------------
# 2. --reset-master through the projection
# ---------------------------------------------------------------------------


async def test_reset_of_an_admin_leaves_admins_and_the_roster() -> None:
    """The repeat of the card: an admin without the marker, no profile ->
    member false for group:admins and the support roster, by his id."""
    await _keep_another_admin()
    uid = await _make_user(BAND_MIN + 5, role=UserRole.ADMIN.value)

    await dev_admin_simulator.run_reset_master(str(uid), False)

    row = await _row(uid)
    assert row.role == UserRole.USER.value
    assert not has_admin_capability(row.role, row.credentials)
    assert await _membership(uid) == [(GROUP_ADMINS, False), ("support", False)]


async def test_reset_of_a_verified_admin_master_leaves_both_groups() -> None:
    await _keep_another_admin()
    uid = await _make_user(BAND_MIN + 6, role=UserRole.ADMIN.value)
    await _add_profile(uid, "verified")

    await dev_admin_simulator.run_reset_master(str(uid), False)

    assert await _profile(uid) is None
    assert await _membership(uid) == [
        (GROUP_MASTERS, False),
        (GROUP_ADMINS, False),
        ("support", False),
    ]


async def test_reset_of_a_marker_holder_keeps_the_admin_and_leaves_masters() -> None:
    """NEKHVATKA: role master with the switched-away marker. The marker is
    not cleared, so the admin capability stays -- no admin event; the
    verified profile deleted is group:masters left."""
    uid = await _make_user(
        BAND_MIN + 7, role=UserRole.MASTER.value, credentials=_MARKER
    )
    await _add_profile(uid, "verified")

    await dev_admin_simulator.run_reset_master(str(uid), False)

    row = await _row(uid)
    assert row.role == UserRole.USER.value
    assert has_admin_home(row.credentials)
    assert await _membership(uid) == [(GROUP_MASTERS, False)]


async def test_reset_of_a_pending_applicant_twice_sends_nothing() -> None:
    """PUSTOTA and POVTOR: a profile that was never verified is no master
    capability, so its deletion sends nothing; the second run finds no
    profile and a plain user -- nothing again."""
    uid = await _make_user(BAND_MIN + 8, role=UserRole.USER.value)
    await _add_profile(uid, "pending")

    await dev_admin_simulator.run_reset_master(str(uid), False)
    assert await _profile(uid) is None
    await dev_admin_simulator.run_reset_master(str(uid), False)

    assert (await _row(uid)).role == UserRole.USER.value
    assert await _membership(uid) == []


async def test_a_dry_run_writes_nothing() -> None:
    await _keep_another_admin()
    uid = await _make_user(BAND_MIN + 9, role=UserRole.ADMIN.value)
    await _add_profile(uid, "verified")
    before = _state(await _row(uid))

    await dev_admin_simulator.run_reset_master(str(uid), True)

    assert _state(await _row(uid)) == before
    assert (await _profile(uid)).data["account"]["status"] == "verified"
    assert await _membership(uid) == []


# ---------------------------------------------------------------------------
# 3. The races: --reset-master reads what it holds
# ---------------------------------------------------------------------------


async def test_reset_waits_for_a_verification_and_leaves_the_masters_it_joined(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """verify_master holds the pending profile FOR UPDATE; reset comes in and
    waits on that profile. Once the verification commits, reset reads the
    profile as verified and sends group:masters left. Invariant: the masters
    events of the person are [join, leave] and the profile is gone -- the
    projection says what the rows say."""
    admin = await _keep_another_admin()
    uid = await _make_user(BAND_MIN + 10, role=UserRole.USER.value)
    await _add_profile(uid, "pending")

    async def holder(s: AsyncSession) -> None:
        actor = await s.get(User, admin)
        await admin_masters_service.verify_master(uid, actor, None, s)

    async def rival(s: AsyncSession) -> None:
        await dev_admin_simulator.reset_master(s, str(uid), False)

    result = await race(
        monkeypatch,
        holder=holder,
        pause_in=(admin_masters_service, "_load_pending_profile"),
        pause="after",
        rival=rival,
    )

    assert_no_deadlock(result)
    assert result.rival_waited, "the two never met -- the test proves nothing"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert await _profile(uid) is None
    assert [m for m in await _membership(uid) if m[0] == GROUP_MASTERS] == [
        (GROUP_MASTERS, True),
        (GROUP_MASTERS, False),
    ]


async def test_reset_waits_for_a_role_switch_and_keeps_the_admin_it_left(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An admin switches into user mode (the marker is written) while reset
    comes in for him. reset waits on the users row and then reads role user
    WITH the marker: he still holds the admin capability, so no admin event
    goes -- comms keeps him on the roster, as velo does."""
    await _keep_another_admin()
    uid = await _make_user(BAND_MIN + 11, role=UserRole.ADMIN.value)

    async def holder(s: AsyncSession) -> None:
        user = await s.get(User, uid)
        await users_service.switch_user_role(user, UserRole.USER, s)

    async def rival(s: AsyncSession) -> None:
        await dev_admin_simulator.reset_master(s, str(uid), False)

    result = await race(
        monkeypatch,
        holder=holder,
        pause_in=(users_service, "lock_user_row"),
        pause="after",
        rival=rival,
    )

    assert_no_deadlock(result)
    assert result.rival_waited, "the two never met -- the test proves nothing"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    row = await _row(uid)
    assert row.role == UserRole.USER.value
    assert has_admin_home(row.credentials)
    assert await _membership(uid) == []
