# =============================================================================
# VELO -- BE-220: the admin simulator reports what it really did
# =============================================================================
# Band 88820-88839 (free window 88820-88999, telegram_id_bands.py).
#
# 1. --block / --unblock write users.is_active under lock_user_row and send
#    the user_upserted snapshot in the same transaction; the value the row
#    already has writes and sends nothing. A race of two --block runs sends
#    ONE snapshot (the second reads "already" from the row it holds).
# 2. --watch / --once: a refused item no longer breaks or hides the pass --
#    every item is attempted, the pass ends on its summary, and --once exits
#    1 when anything was refused. The refusals are REAL service refusals:
#    another admin decides the request between the scan and the call.
#
# Every user here is named "Bee220 ..." and the passes run with
# only="bee220", so pending requests of other files are never touched.
# =============================================================================

import sys
from collections.abc import AsyncGenerator
from uuid import UUID

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session_factory
from app.core.events import EVENT_USER_UPSERTED
from app.core.events.models import OutboxEvent
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from scripts import dev_admin_simulator as sim
from tests.helpers import full_cleanup_range
from tests.school_race_harness import assert_no_deadlock, race

BAND_MIN, BAND_MAX = 88820, 88839
ONLY = "bee220"


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


async def _make_user(tid: int, *, active: bool = True) -> UUID:
    async with get_session_factory()() as s:
        user = User(
            telegram_id=tid,
            first_name=f"Bee220 {tid}",
            role=UserRole.USER.value,
            is_active=active,
            credentials={},
        )
        s.add(user)
        await s.commit()
        return user.id


async def _add_profile(uid: UUID, *, status: str, request: str | None = None) -> None:
    profile = {"display_name": "Bee220 Master", "methods": []}
    if request is not None:
        profile["method_change_request"] = {
            "status": request,
            "proposed_methods": ["breath"],
        }
    async with get_session_factory()() as s:
        s.add(
            MasterProfile(
                user_id=uid,
                data={
                    "account": {"status": status},
                    "profile": profile,
                    "availability": {"is_accepting": True},
                },
            )
        )
        await s.commit()


async def _row(uid: UUID) -> User:
    async with get_session_factory()() as s:
        return (await s.execute(select(User).where(User.id == uid))).scalar_one()


async def _snapshots(uid: UUID) -> list[dict]:
    async with get_session_factory()() as s:
        return [
            e.payload
            for e in (
                await s.execute(
                    select(OutboxEvent)
                    .where(
                        OutboxEvent.event_type == EVENT_USER_UPSERTED,
                        OutboxEvent.payload["recipient_id"].astext == str(uid),
                    )
                    .order_by(OutboxEvent.id)
                )
            ).scalars()
        ]


def _state(row: User) -> tuple:
    return (row.is_active, row.updated_at, row.snapshot_version)


async def _request(uid: UUID) -> dict | None:
    async with get_session_factory()() as s:
        profile = await s.get(MasterProfile, uid)
        return (profile.data or {}).get("profile", {}).get("method_change_request")


@pytest.fixture
def another_admin_decides_first(monkeypatch: pytest.MonkeyPatch):
    """Make approve_method_change meet a request another admin has just
    rejected: the rejection commits in its own session between the scan and
    the call, and the REAL service then refuses (no pending request)."""
    real = sim.approve_method_change
    refused_for: set[UUID] = set()

    async def _approve(user_id, admin, session, *args, **kwargs):
        if user_id in refused_for:
            async with get_session_factory()() as other:
                profile = await other.get(MasterProfile, user_id)
                data = dict(profile.data)
                data["profile"] = dict(data["profile"])
                data["profile"]["method_change_request"] = {
                    **data["profile"]["method_change_request"],
                    "status": "rejected",
                }
                await other.execute(
                    update(MasterProfile)
                    .where(MasterProfile.user_id == user_id)
                    .values(data=data)
                )
                await other.commit()
        return await real(user_id, admin, session, *args, **kwargs)

    monkeypatch.setattr(sim, "approve_method_change", _approve)
    return refused_for


# ---------------------------------------------------------------------------
# 1. --block / --unblock
# ---------------------------------------------------------------------------


async def test_block_writes_and_sends_one_snapshot() -> None:
    uid = await _make_user(BAND_MIN)
    version_before = (await _row(uid)).snapshot_version

    await sim.run_block(str(uid), blocked=True, dry_run=False)

    row = await _row(uid)
    assert row.is_active is False
    assert row.snapshot_version == version_before + 1
    snaps = await _snapshots(uid)
    assert [(s["active"], s["version"]) for s in snaps] == [
        (False, version_before + 1)
    ]


async def test_unblock_writes_and_sends_one_snapshot() -> None:
    uid = await _make_user(BAND_MIN + 1, active=False)

    await sim.run_block(str(uid), blocked=False, dry_run=False)

    assert (await _row(uid)).is_active is True
    assert [s["active"] for s in await _snapshots(uid)] == [True]


@pytest.mark.parametrize(
    ("active", "blocked"),
    [
        pytest.param(False, True, id="block-the-blocked"),
        pytest.param(True, False, id="unblock-the-active"),
    ],
)
async def test_the_value_it_already_has_writes_and_sends_nothing(
    active: bool, blocked: bool
) -> None:
    uid = await _make_user(BAND_MIN + 2, active=active)
    before = _state(await _row(uid))

    await sim.run_block(str(uid), blocked=blocked, dry_run=False)

    assert _state(await _row(uid)) == before
    assert await _snapshots(uid) == []


async def test_a_dry_run_writes_and_sends_nothing() -> None:
    uid = await _make_user(BAND_MIN + 3)
    before = _state(await _row(uid))

    await sim.run_block(str(uid), blocked=True, dry_run=True)

    assert _state(await _row(uid)) == before
    assert await _snapshots(uid) == []


async def test_two_blocks_at_once_send_one_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The first --block holds the users row; the second waits on it, reads
    is_active=false from the row it then holds and writes nothing. One
    snapshot, one version step -- not a write and a replay."""
    uid = await _make_user(BAND_MIN + 4)
    version_before = (await _row(uid)).snapshot_version
    answers: dict[str, User | None] = {}

    async def holder(s: AsyncSession) -> None:
        answers["holder"] = await sim.set_active(s, str(uid), False, False)

    async def rival(s: AsyncSession) -> None:
        answers["rival"] = await sim.set_active(s, str(uid), False, False)

    result = await race(
        monkeypatch,
        holder=holder,
        pause_in=(sim, "lock_user_row"),
        pause="after",
        rival=rival,
    )

    assert_no_deadlock(result)
    assert result.rival_waited, "the two never met -- the test proves nothing"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert answers["holder"] is not None and answers["rival"] is None
    row = await _row(uid)
    assert row.is_active is False
    assert row.snapshot_version == version_before + 1
    assert [s["active"] for s in await _snapshots(uid)] == [False]


# ---------------------------------------------------------------------------
# 2. --watch / --once
# ---------------------------------------------------------------------------


async def test_two_refusals_in_a_row_reach_the_summary_and_exit_1(
    another_admin_decides_first, capsys: pytest.CaptureFixture[str]
) -> None:
    """Before BE-220 the first refusal already broke the pass: the rollback
    expired the profile, and the line that logged the refusal read it
    (MissingGreenlet). Now both are attempted and both are reported."""
    a = await _make_user(BAND_MIN + 5)
    b = await _make_user(BAND_MIN + 6)
    for uid in (a, b):
        await _add_profile(uid, status="verified", request="pending")
        another_admin_decides_first.add(uid)

    code = await sim.run_watch(
        once=True, interval=0, only=ONLY, can_create_schools=False, dry_run=False
    )

    assert code == 1
    out = capsys.readouterr().out
    assert "pass: 0 verified, 0 approved, 2 refused" in out
    assert f"refused: method change {a}" in out
    assert f"refused: method change {b}" in out


async def test_a_refusal_does_not_stop_the_items_after_it(
    another_admin_decides_first, capsys: pytest.CaptureFixture[str]
) -> None:
    """An application is verified, the first method change is refused, the
    second is approved -- all in one pass, which still exits 1."""
    applicant = await _make_user(BAND_MIN + 7)
    await _add_profile(applicant, status="pending")
    refused = await _make_user(BAND_MIN + 8)
    approved = await _make_user(BAND_MIN + 9)
    for uid in (refused, approved):
        await _add_profile(uid, status="verified", request="pending")
    another_admin_decides_first.add(refused)

    code = await sim.run_watch(
        once=True, interval=0, only=ONLY, can_create_schools=False, dry_run=False
    )

    assert code == 1
    assert "pass: 1 verified, 1 approved, 1 refused" in capsys.readouterr().out
    async with get_session_factory()() as s:
        assert (await s.get(MasterProfile, applicant)).data["account"][
            "status"
        ] == "verified"
    assert await _request(approved) is None


async def test_a_clean_pass_exits_0() -> None:
    uid = await _make_user(BAND_MIN + 10)
    await _add_profile(uid, status="verified", request="pending")

    assert await sim.run_watch(
        once=True, interval=0, only=ONLY, can_create_schools=False, dry_run=False
    ) == 0
    assert await _request(uid) is None


async def test_a_rejected_request_is_not_pending_and_not_a_refusal(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A rejected method change stays in the profile with status "rejected".
    It is not pending: the pass does not pick it, so --once is not made red
    by a request nobody can approve."""
    uid = await _make_user(BAND_MIN + 11)
    await _add_profile(uid, status="verified", request="rejected")

    assert await sim.run_watch(
        once=True, interval=0, only=ONLY, can_create_schools=False, dry_run=False
    ) == 0
    assert "nothing pending" in capsys.readouterr().out
    assert (await _request(uid))["status"] == "rejected"


async def test_main_returns_the_pass_result(
    another_admin_decides_first, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The exit code reaches the process: main returns run_watch's answer
    (it used to return None -- exit 0 whatever happened)."""
    uid = await _make_user(BAND_MIN + 12)
    await _add_profile(uid, status="verified", request="pending")
    another_admin_decides_first.add(uid)

    async def _keep_engine() -> None:
        return None

    monkeypatch.setattr(sim, "dispose_engine", _keep_engine)
    monkeypatch.setattr(
        sys, "argv", ["dev_admin_simulator.py", "--watch", "--once", "--only", ONLY]
    )
    assert await sim.main() == 1
