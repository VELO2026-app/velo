# =============================================================================
# VELO -- Tests: block_student takes Practice before Booking (BE-99)
# =============================================================================
#
# telegram_id band: 69750-69799.
#
# BAND PROVENANCE. On 2026-10-01 69750-69799 overlapped no declared band
# (declared_bands()) and no BLIND_ZONE cleanup range.
#
# WHAT IS UNDER TEST
#
#   block_student used to lock the student's Booking rows first and reach
#   the practice row later, twice: refund_booking's INSERT into
#   master_ledger takes FOR KEY SHARE on it (FK), recalculate_participants
#   takes FOR UPDATE on it. Two real crossings, both measured into 40P01:
#
#     S1. the student's own cancel_booking of the same booking -- it locks
#         Practice, then waits for the Booking the block holds;
#     S2. a second block, of another student, on a shared practice -- each
#         holds KEY SHARE on the practice, each goes for FOR UPDATE.
#
#   Now the order is Practice (by id) -> Booking -> master_profiles.
#
# HOW THE CROSSING IS BUILT. Two independent sessions on two real
# connections, never asyncio.gather over one session. The block is paused
# INSIDE its locked window (a pass-through hook on a call it makes there);
# the competitor is started and the test waits until Postgres itself
# reports the competitor's backend as waiting on a lock (pg_stat_activity)
# -- so the two really overlap, not merely run one after another. Then the
# block is released. With the old order this is the moment both wait on
# each other and one of them dies with 40P01.
#
# Every "no 40P01" has its pair: the data both outcomes left is true --
# each booking CANCELLED once, refunded once, the participant count right.
#
# The report poller is NOT a competitor here: it takes practices whose
# scheduled_at + duration + margin is in the past, block_student only
# practices whose scheduled_at is in the future -- disjoint rows.
# =============================================================================

import asyncio
from collections.abc import AsyncGenerator, Awaitable, Callable
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session_factory
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.bookings.service import cancel_booking, create_booking
from app.modules.masters import groups_service
from app.modules.masters.groups_models import MasterStudent
from app.modules.masters.models import MasterProfile
from app.modules.payments.models import MasterLedger, Purchase, PurchaseStatus
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from app.modules.zoom import service as zoom_service
from app.modules.zoom.models import ZoomMeeting, ZoomMeetingStatus, ZoomRegistrant
from tests.helpers import full_cleanup_range, login_user

_TID_MIN = 69750
_TID_MAX = 69799

_DEADLOCK = "40P01"


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


async def _user(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int, *,
    master: bool = False,
) -> User:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=f"U{telegram_id}",
    )
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    if master:
        user.role = UserRole.MASTER.value
        db_session.add(
            MasterProfile(
                user_id=user.id,
                data={
                    "account": {"status": "verified"},
                    "profile": {"display_name": "Master"},
                },
            )
        )
    await db_session.flush()
    return user


async def _practice(db_session: AsyncSession, master: User) -> Practice:
    practice = Practice(
        master_id=master.id,
        title="Lock order",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=PracticeStatus.SCHEDULED.value,
        scheduled_at=datetime.now(UTC) + timedelta(hours=3),
        duration_minutes=60,
        timezone="UTC",
        max_participants=10,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        data={},
    )
    db_session.add(practice)
    await db_session.flush()
    return practice


class _Outcome:
    def __init__(self) -> None:
        self.pid: int | None = None
        self.result: str | None = None
        self.error: BaseException | None = None
        self.value: object = None


def _sqlstate(exc: BaseException) -> str | None:
    orig = getattr(exc, "orig", None)
    for candidate in (orig, getattr(orig, "__cause__", None)):
        state = getattr(candidate, "sqlstate", None)
        if state:
            return state
    return None


async def _in_own_session(
    work: Callable[[AsyncSession], Awaitable[object]], outcome: _Outcome,
) -> None:
    """Run `work` in its OWN session on its own connection and commit.
    Records the backend pid first, so the test can ask Postgres whether
    this transaction is waiting."""
    session = get_session_factory()()
    try:
        outcome.pid = (
            await session.execute(text("select pg_backend_pid()"))
        ).scalar_one()
        outcome.value = await work(session)
        await session.commit()
        outcome.result = "committed"
    except Exception as exc:  # recorded and asserted by the test
        await session.rollback()
        outcome.error = exc
        outcome.result = "error"
    finally:
        await session.close()


_WAIT_SECONDS = 5.0


async def _wait_until_waiting_on_lock(outcome: _Outcome) -> bool:
    """True once Postgres reports outcome's backend as waiting on a lock."""
    deadline = asyncio.get_running_loop().time() + _WAIT_SECONDS
    while asyncio.get_running_loop().time() < deadline:
        if outcome.pid is not None:
            async with get_session_factory()() as probe:
                wait_type = (
                    await probe.execute(
                        text(
                            "select wait_event_type from pg_stat_activity "
                            "where pid = :pid"
                        ),
                        {"pid": outcome.pid},
                    )
                ).scalar_one_or_none()
            if wait_type == "Lock":
                return True
        await asyncio.sleep(0.05)
    return False


def _pause_first_call(
    monkeypatch: pytest.MonkeyPatch, module: object, name: str,
) -> tuple[asyncio.Event, asyncio.Event]:
    """Pass-through hook: the FIRST caller of module.name stops before the
    real call until `release` is set; later callers go straight through."""
    reached, release = asyncio.Event(), asyncio.Event()
    original = getattr(module, name)
    state = {"first": True}

    async def hook(*args: object, **kwargs: object) -> object:
        if state["first"]:
            state["first"] = False
            reached.set()
            await release.wait()
        return await original(*args, **kwargs)

    monkeypatch.setattr(module, name, hook)
    return reached, release


def _pause_after_first_call(
    monkeypatch: pytest.MonkeyPatch, module: object, name: str,
) -> tuple[asyncio.Event, asyncio.Event]:
    """Pass-through hook: the FIRST caller of module.name makes the real
    call -- taking whatever it locks -- and then stops until `release` is
    set; later callers go straight through."""
    reached, release = asyncio.Event(), asyncio.Event()
    original = getattr(module, name)
    state = {"first": True}

    async def hook(*args: object, **kwargs: object) -> object:
        value = await original(*args, **kwargs)
        if state["first"]:
            state["first"] = False
            reached.set()
            await release.wait()
        return value

    monkeypatch.setattr(module, name, hook)
    return reached, release


async def _master_student_rows(
    db_session: AsyncSession, master_id: UUID, student_id: UUID,
) -> list[MasterStudent]:
    db_session.expire_all()
    return list(
        (
            await db_session.execute(
                select(MasterStudent).where(
                    MasterStudent.master_id == master_id,
                    MasterStudent.student_user_id == student_id,
                )
            )
        ).scalars().all()
    )


def _then_hold(
    work: Callable[[AsyncSession], Awaitable[object]],
) -> tuple[Callable[[AsyncSession], Awaitable[object]], asyncio.Event, asyncio.Event]:
    """Wrap `work` so that, after it returns, its transaction stays open --
    holding whatever it wrote and locked -- until `release` is set. For
    services with no later call to hook (set_student_tag returns right
    after its write)."""
    reached, release = asyncio.Event(), asyncio.Event()

    async def held(session: AsyncSession) -> object:
        value = await work(session)
        reached.set()
        await release.wait()
        return value

    return held, reached, release


async def _refunds_for(
    db_session: AsyncSession, practice_id: UUID, student_id: UUID,
) -> int:
    return (
        await db_session.execute(
            select(func.count(MasterLedger.id)).where(
                MasterLedger.practice_id == practice_id,
                MasterLedger.counterparty_id == student_id,
                MasterLedger.reason == f"refund:practice={practice_id}",
            )
        )
    ).scalar_one()


async def _purchase_status(db_session: AsyncSession, booking_id: UUID) -> str:
    return (
        await db_session.execute(
            select(Purchase.status).where(Purchase.booking_id == booking_id)
        )
    ).scalar_one()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_block_and_students_own_cancel_do_not_deadlock(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """S1. The block is paused inside its locked window (at refund_booking);
    the student's own cancel_booking of the same booking starts and is seen
    WAITING by Postgres. Released: no 40P01. The block cancels; the
    student's cancel then finds the booking already cancelled and refuses
    with the ordinary domain error. Pair: cancelled once, refunded once,
    the count is 0."""
    master = await _user(client, db_session, 69750, master=True)
    student = await _user(client, db_session, 69751)
    student_id = student.id
    practice = await _practice(db_session, master)
    booking = await create_booking(student, practice.id, session=db_session)
    await db_session.commit()
    booking_id, practice_id = booking.id, practice.id

    reached, release = _pause_first_call(monkeypatch, groups_service, "refund_booking")
    block, cancel = _Outcome(), _Outcome()
    block_task = asyncio.create_task(_in_own_session(
        lambda s: groups_service.block_student(master.id, student.id, s), block,
    ))
    await asyncio.wait_for(reached.wait(), 5)
    cancel_task = asyncio.create_task(_in_own_session(
        lambda s: cancel_booking(booking_id, student, s), cancel,
    ))

    assert await _wait_until_waiting_on_lock(cancel), (
        "cancel_booking never waited -- the two transactions did not overlap"
    )
    release.set()
    await asyncio.wait_for(asyncio.gather(block_task, cancel_task), 15)

    for outcome in (block, cancel):
        if outcome.error is not None:
            assert _sqlstate(outcome.error) != _DEADLOCK, outcome.error
    assert block.result == "committed"
    assert cancel.result == "error"
    assert not isinstance(cancel.error, DBAPIError)
    assert "Cannot cancel booking in status" in str(cancel.error)

    db_session.expire_all()
    stored = await db_session.get(Booking, booking_id)
    stored_practice = await db_session.get(Practice, practice_id)
    assert stored.status == BookingStatus.CANCELLED.value
    assert stored.cancellation_reason == "Blocked by master"
    refunded = PurchaseStatus.REFUNDED.value
    assert await _purchase_status(db_session, booking_id) == refunded
    assert await _refunds_for(db_session, practice_id, student_id) == 1
    assert stored_practice.current_participants == 0


@pytest.mark.asyncio
async def test_two_blocks_on_a_shared_practice_do_not_deadlock(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """S2. Two students of one master booked the same practice; the master
    blocks both at once. The first block is paused inside its locked window
    (at the registrant cancel, past its refund); the second is seen WAITING
    by Postgres. Released: no 40P01, both commit. Pair: both bookings
    cancelled and refunded exactly once each, both students blocked, the
    count is 0."""
    master = await _user(client, db_session, 69752, master=True)
    first = await _user(client, db_session, 69753)
    second = await _user(client, db_session, 69754)
    practice = await _practice(db_session, master)
    first_booking = await create_booking(first, practice.id, session=db_session)
    second_booking = await create_booking(second, practice.id, session=db_session)
    await db_session.commit()
    master_id, practice_id = master.id, practice.id
    pairs = ((first.id, first_booking.id), (second.id, second_booking.id))

    reached, release = _pause_first_call(
        monkeypatch, zoom_service, "cancel_registrant_for_booking",
    )
    block_one, block_two = _Outcome(), _Outcome()
    one_task = asyncio.create_task(_in_own_session(
        lambda s: groups_service.block_student(master.id, first.id, s), block_one,
    ))
    await asyncio.wait_for(reached.wait(), 5)
    two_task = asyncio.create_task(_in_own_session(
        lambda s: groups_service.block_student(master.id, second.id, s), block_two,
    ))

    assert await _wait_until_waiting_on_lock(block_two), (
        "the second block never waited -- the two transactions did not overlap"
    )
    release.set()
    await asyncio.wait_for(asyncio.gather(one_task, two_task), 15)

    for outcome in (block_one, block_two):
        if outcome.error is not None:
            assert _sqlstate(outcome.error) != _DEADLOCK, outcome.error
    assert block_one.result == "committed", block_one.error
    assert block_two.result == "committed", block_two.error

    db_session.expire_all()
    refunded = PurchaseStatus.REFUNDED.value
    for student_id, booking_id in pairs:
        stored = await db_session.get(Booking, booking_id)
        assert stored.status == BookingStatus.CANCELLED.value
        assert await _purchase_status(db_session, booking_id) == refunded
        assert await _refunds_for(db_session, practice_id, student_id) == 1
        blocked_at = (
            await db_session.execute(
                select(MasterStudent.blocked_at).where(
                    MasterStudent.master_id == master_id,
                    MasterStudent.student_user_id == student_id,
                )
            )
        ).scalar_one()
        assert blocked_at is not None
    stored_practice = await db_session.get(Practice, practice_id)
    assert stored_practice.current_participants == 0


@pytest.mark.asyncio
async def test_same_student_blocked_twice_at_once(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """REPEAT axis, concurrent (promised in BE-99, written in BE-96): two
    blocks of ONE student by one master at the same time. The first is
    paused inside its locked window; the second is seen WAITING by
    Postgres. Released: no 40P01, both commit; the second found nothing
    left to cancel. Pair: the booking cancelled and refunded exactly once,
    the count 0, and its registrant queued for Zoom once.

    No MasterStudent row beforehand (Zoom-2, part 1). This test used to
    create one -- the master tagged the student first -- because without it
    both blocks inserted the row by read-then-insert and the second died on
    uq_master_student_master_student (found here, BE-96 report,
    observations). That detour was right about the lock order and hid a
    500. The row is now taken by an upsert: the second block waits on the
    unique index for the first and then updates the same row, so the pair
    gains "exactly one row, blocked"."""
    master = await _user(client, db_session, 69755, master=True)
    student = await _user(client, db_session, 69756)
    practice = await _practice(db_session, master)
    db_session.add(
        ZoomMeeting(
            practice_id=practice.id,
            zoom_meeting_id=f"be99-{practice.id.hex[:16]}",
            zoom_meeting_uuid=f"uuid-be99-{practice.id}",
            status=ZoomMeetingStatus.ACTIVE.value,
        )
    )
    await db_session.flush()
    booking = await create_booking(student, practice.id, session=db_session)
    await db_session.commit()
    master_id, student_id = master.id, student.id
    booking_id, practice_id = booking.id, practice.id
    assert await _master_student_rows(db_session, master_id, student_id) == []

    reached, release = _pause_first_call(monkeypatch, groups_service, "refund_booking")
    first, second = _Outcome(), _Outcome()
    first_task = asyncio.create_task(_in_own_session(
        lambda s: groups_service.block_student(master_id, student_id, s), first,
    ))
    await asyncio.wait_for(reached.wait(), 5)
    second_task = asyncio.create_task(_in_own_session(
        lambda s: groups_service.block_student(master_id, student_id, s), second,
    ))

    assert await _wait_until_waiting_on_lock(second), (
        "the second block never waited -- the two transactions did not overlap"
    )
    release.set()
    await asyncio.wait_for(asyncio.gather(first_task, second_task), 15)

    for outcome in (first, second):
        if outcome.error is not None:
            assert _sqlstate(outcome.error) != _DEADLOCK, outcome.error
    assert first.result == "committed", first.error
    assert second.result == "committed", second.error
    assert first.value["cancelled_bookings_count"] == 1
    assert second.value["cancelled_bookings_count"] == 0

    db_session.expire_all()
    stored = await db_session.get(Booking, booking_id)
    assert stored.status == BookingStatus.CANCELLED.value
    refunded = PurchaseStatus.REFUNDED.value
    assert await _purchase_status(db_session, booking_id) == refunded
    assert await _refunds_for(db_session, practice_id, student_id) == 1
    stored_practice = await db_session.get(Practice, practice_id)
    assert stored_practice.current_participants == 0
    rows = (
        await db_session.execute(
            select(ZoomRegistrant).where(ZoomRegistrant.booking_id == booking_id)
        )
    ).scalars().all()
    assert len(rows) == 1
    assert rows[0].zoom_cancel_pending is True
    assert rows[0].zoom_cancel_attempts == 0
    pair = await _master_student_rows(db_session, master_id, student_id)
    assert len(pair) == 1
    assert pair[0].blocked_at is not None
    assert pair[0].tag is None


# ===========================================================================
# The (master, student) row itself -- Zoom-2, part 1.
#
# Every writer of the pair takes the row with one upsert
# (groups_service._take_master_student). The races below are the writers
# of that row met two at a time: two tags; a tag and a block with no row
# yet; a block while the tag is being cleared (the delete). Each asserts
# the invariant -- one row, every committed write in it, no 500 -- and its
# pair, that the competitor's own write was left as it left it.
# ===========================================================================


@pytest.mark.asyncio
async def test_same_student_tagged_twice_at_once(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """REPEAT, concurrent: two tags of one student with no row yet. The
    first has written and holds its transaction open; Postgres reports the
    second WAITING (on the unique index); then the first commits. Both
    commit, one row, and it carries the tag written last -- one tag per
    student, a second PUT overwrites (owner Q1=A)."""
    master = await _user(client, db_session, 69757, master=True)
    student = await _user(client, db_session, 69758)
    await db_session.commit()
    master_id, student_id = master.id, student.id

    held, reached, release = _then_hold(
        lambda s: groups_service.set_student_tag(master_id, student_id, "first", s),
    )
    first, second = _Outcome(), _Outcome()
    first_task = asyncio.create_task(_in_own_session(held, first))
    await asyncio.wait_for(reached.wait(), 5)
    second_task = asyncio.create_task(_in_own_session(
        lambda s: groups_service.set_student_tag(master_id, student_id, "second", s),
        second,
    ))

    assert await _wait_until_waiting_on_lock(second), (
        "the second tag never waited -- the two transactions did not overlap"
    )
    release.set()
    await asyncio.wait_for(asyncio.gather(first_task, second_task), 15)

    assert first.result == "committed", first.error
    assert second.result == "committed", second.error
    pair = await _master_student_rows(db_session, master_id, student_id)
    assert [(r.tag, r.blocked_at) for r in pair] == [("second", None)]


@pytest.mark.asyncio
async def test_block_and_tag_at_once_with_no_row_keep_both(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """SHORTAGE, two different writers of one missing row: the tag has
    written and holds; the block waits on the index. Both commit, one row,
    and it carries BOTH writes -- the block did not drop the tag, the tag
    did not survive as the only thing in the row."""
    master = await _user(client, db_session, 69759, master=True)
    student = await _user(client, db_session, 69760)
    await db_session.commit()
    master_id, student_id = master.id, student.id

    held, reached, release = _then_hold(
        lambda s: groups_service.set_student_tag(master_id, student_id, "regular", s),
    )
    tag, block = _Outcome(), _Outcome()
    tag_task = asyncio.create_task(_in_own_session(held, tag))
    await asyncio.wait_for(reached.wait(), 5)
    block_task = asyncio.create_task(_in_own_session(
        lambda s: groups_service.block_student(master_id, student_id, s), block,
    ))

    assert await _wait_until_waiting_on_lock(block), (
        "the block never waited -- the two transactions did not overlap"
    )
    release.set()
    await asyncio.wait_for(asyncio.gather(tag_task, block_task), 15)

    assert tag.result == "committed", tag.error
    assert block.result == "committed", block.error
    pair = await _master_student_rows(db_session, master_id, student_id)
    assert len(pair) == 1
    assert pair[0].tag == "regular"
    assert pair[0].blocked_at is not None


@pytest.mark.asyncio
async def test_block_while_the_tag_is_cleared_blocks(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """EMPTINESS mid-race: the row exists with a tag only. Clearing the tag
    has LOCKED the row (its FOR UPDATE read) and is paused before deleting
    it; the block arrives and Postgres reports it waiting on that row. The
    clear then deletes and commits.

    This is the test that tells the upsert's two forms apart. With
    ON CONFLICT DO NOTHING + a re-read, the block's insert sees the live
    committed row and does nothing, its re-read waits on the clear's lock,
    and after the delete it reads NOTHING -- the block has no row to set.
    DO UPDATE re-checks the deleted row and inserts. So: both commit, one
    row, blocked, and (the pair) the clear's own write stands -- the tag is
    gone, not resurrected by the block."""
    master = await _user(client, db_session, 69761, master=True)
    student = await _user(client, db_session, 69762)
    await groups_service.set_student_tag(master.id, student.id, "regular", db_session)
    await db_session.commit()
    master_id, student_id = master.id, student.id

    reached, release = _pause_after_first_call(
        monkeypatch, groups_service, "_get_or_none_master_student",
    )
    clear, block = _Outcome(), _Outcome()
    clear_task = asyncio.create_task(_in_own_session(
        lambda s: groups_service.set_student_tag(master_id, student_id, None, s),
        clear,
    ))
    await asyncio.wait_for(reached.wait(), 5)
    block_task = asyncio.create_task(_in_own_session(
        lambda s: groups_service.block_student(master_id, student_id, s), block,
    ))

    assert await _wait_until_waiting_on_lock(block), (
        "the block never waited -- the two transactions did not overlap"
    )
    release.set()
    await asyncio.wait_for(asyncio.gather(clear_task, block_task), 15)

    assert clear.result == "committed", clear.error
    assert block.result == "committed", block.error
    pair = await _master_student_rows(db_session, master_id, student_id)
    assert len(pair) == 1
    assert pair[0].blocked_at is not None
    assert pair[0].tag is None
