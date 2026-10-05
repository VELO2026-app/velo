# =============================================================================
# PRACTICE ROW ORDER (practices/service.py, header) -- every writer of
# several practice rows takes them in ONE statement ORDER BY id.
# =============================================================================
#
# The pairs that were a 40P01 before this order (BE-64 follow-up, O1/O2):
#
#   G1  cancel_practice (series) x delete_curator_group  -- BE-103 (b)
#   G2  cancel_practice (series) x block_student          -- BE-101 p.3
#   G7  delete_curator_group     x block_student          -- gate
#   G8  cancel_practice (series) x block_student          -- gate
#   plus the cascade's own NEHVATKA: the primary rescheduled between the
#   unlocked read and the lock.
#
# TWO KINDS OF RACE, and why both. G1/G2 pause the cascade right after its
# practice rows are taken (_primary_and_later). In the fixed code it then
# holds its WHOLE set, and the rival waits holding nothing it shares; in the
# old shape (the primary first, the series after) it holds the primary only,
# and the rival -- taking by id -- builds the cycle. But a holder that holds
# its whole set is blind to the RIVAL's order: any rival just waits. So the
# rivals' own order (delete_curator_group, block_student) is measured with a
# GATE instead (G7/G8): a third session holds the lowest common row, the
# id-ordered writer queues on it first holding nothing, the second writer
# takes what its own order gives it and queues too; releasing the gate lets
# the first through -- straight into the second's row if the second is not
# in id order. Two single statements cannot be paused in between, so
# without the gate their interleaving is not deterministic.
#
# The common harness (curator_race_harness.py) is used as it is; the gate is
# local to this file.
# =============================================================================

import asyncio
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session_factory
from app.modules.curator_groups import service as curator_service
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters import groups_service
from app.modules.masters.models import MasterProfile
from app.modules.practices import cancel_service
from app.modules.practices import service as practice_service
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeStatus,
    PracticeType,
)
from app.modules.practices.schemas import UpdatePracticeRequest
from app.modules.users.models import User, UserRole
from tests.curator_race_harness import (
    Outcome,
    _run,
    _waiting_on_lock,
    assert_no_deadlock,
    race,
)
from tests.helpers import (
    auth_headers,
    fresh_execute,
    full_cleanup_range,
    login_user,
)

BOOKINGS_URL = "/api/v1/bookings"

_TID_MIN = 70200
_TID_MAX = 70299

_TID_MASTER = 70201
_TID_CURATOR = 70202
_TID_STUDENT = 70210


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """FK-safe shared helper (TD-032), scoped to this file's own band."""
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ===========================================================================
# Local helpers -- copied, not imported, as every test file in this tree does
# ===========================================================================


async def _master(client, db_session: AsyncSession, telegram_id: int) -> dict:
    auth = await login_user(client, telegram_id=telegram_id, first_name="M")
    user_id = UUID(auth["user"]["id"])
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    await db_session.flush()
    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={"account": {"status": "verified"}, "profile": {"bio": "m"}},
        )
    )
    await db_session.commit()
    return auth


@pytest.fixture
async def w(client: AsyncClient, db_session: AsyncSession) -> dict:
    master = await _master(client, db_session, _TID_MASTER)
    curator = await _master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT, first_name="S")
    school = CuratorGroup(
        curator_user_id=UUID(curator["user"]["id"]), name="Порядок",
    )
    db_session.add(school)
    await db_session.flush()
    db_session.add(
        CuratorGroupMember(
            group_id=school.id, user_id=UUID(master["user"]["id"]),
            kind=CuratorMemberKind.MASTER.value,
        )
    )
    await db_session.commit()
    return {
        "master": master, "curator": curator, "student": student,
        "school": school.id,
        "mid": UUID(master["user"]["id"]),
        "cid": UUID(curator["user"]["id"]),
        "sid": UUID(student["user"]["id"]),
    }


def _ids(n: int) -> list[UUID]:
    """n fresh ids, ascending -- the order the rows are locked in."""
    return sorted(uuid4() for _ in range(n))


async def _practice(
    db_session: AsyncSession, w: dict, pid: UUID, *, hours: float,
    root: UUID | None = None,
) -> UUID:
    """A PUBLIC practice of the school (BE-74 allows it) with a chosen id,
    so anyone can book it through the API; a child has its root's master
    and school, the only shape the API produces."""
    db_session.add(
        Practice(
            id=pid,
            master_id=w["mid"],
            title=f"P{hours}",
            description="x",
            practice_type=(
                PracticeType.SERIES.value if root is not None
                else PracticeType.LIVE.value
            ),
            status=PracticeStatus.SCHEDULED.value,
            scheduled_at=datetime.now(UTC) + timedelta(hours=hours),
            duration_minutes=60,
            timezone="UTC",
            max_participants=20,
            current_participants=0,
            is_free=True,
            price_cents=0,
            currency="eur",
            audience_kind=AudienceKind.PUBLIC.value,
            parent_practice_id=root,
            curator_group_id=w["school"],
        )
    )
    await db_session.commit()
    return pid


async def _book(client: AsyncClient, w: dict, pid: UUID) -> None:
    """Through the real endpoint: a hand-inserted Booking has no Purchase and
    the refund refuses it (see _book in test_practice_cancel_by_curator.py)."""
    resp = await client.post(
        BOOKINGS_URL,
        json={"practice_id": str(pid)},
        headers=auth_headers(w["student"]["session_token"]),
    )
    assert resp.status_code == 201, resp.text


async def _statuses(*pids: UUID) -> dict[UUID, str]:
    return dict((await fresh_execute(
        select(Practice.id, Practice.status).where(Practice.id.in_(pids)),
    )).all())


async def _scan_order(*pids: UUID) -> list[UUID]:
    """The rows in heap order (ctid) -- the order an UPDATE without ORDER BY
    meets them when it scans the table."""
    rows = (await fresh_execute(
        text(
            "SELECT id FROM practices WHERE id = ANY(:ids) ORDER BY ctid"
        ).bindparams(ids=list(pids)),
    )).scalars().all()
    return list(rows)


async def _heap_in_time_order() -> None:
    """Rewrite the practices table in scheduled_at order (index name from
    pg_indexes, not from the model). After it the scan order of any plan
    over these rows -- seq scan, or an index scan on curator_group_id,
    whose equal keys follow the heap -- is the time order."""
    async with get_session_factory()() as session:
        await session.execute(
            text("CLUSTER practices USING ix_practices_scheduled_at")
        )
        await session.commit()


def _cascade(w: dict, pid: UUID):
    async def call(session: AsyncSession):
        user = await session.get(User, w["cid"])
        return await cancel_service.cancel_practice(
            pid, user, session, scope="this_and_future",
        )
    return call


def _delete_school(w: dict):
    async def call(session: AsyncSession):
        await curator_service.delete_curator_group(
            w["cid"], w["school"], session,
        )
    return call


def _block(w: dict):
    async def call(session: AsyncSession):
        return await groups_service.block_student(w["mid"], w["sid"], session)
    return call


async def _wait_until_waiting(pids: dict[str, int], role: str) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + 10.0
    while True:
        if role in pids and await _waiting_on_lock(pids[role]):
            return
        if loop.time() > deadline:
            pytest.fail(f"{role} never queued on a lock -- the gate was not met")
        await asyncio.sleep(0.01)


async def _through_gate(
    gate_row: UUID, first, second,
) -> tuple[Outcome, Outcome]:
    """Hold gate_row in a third session; queue `first` on it, then `second`;
    release. Asserts the queue ORDER it needs, rather than assuming it:
    `first` is seen waiting before `second` starts, and `second` is seen
    waiting before the gate opens."""
    factory = get_session_factory()
    pids: dict[str, int] = {}
    async with factory() as gate:
        await gate.execute(
            select(Practice.id).where(Practice.id == gate_row).with_for_update()
        )
        first_task = asyncio.create_task(_run("first", first, pids))
        await _wait_until_waiting(pids, "first")
        second_task = asyncio.create_task(_run("second", second, pids))
        await _wait_until_waiting(pids, "second")
        await gate.rollback()
    return await asyncio.gather(first_task, second_task)


def _no_deadlock(*outcomes: Outcome) -> None:
    for o in outcomes:
        assert not o.deadlocked, f"deadlock victim: {o.error!r}"
        assert o.committed, o.error


# ===========================================================================
# G1 / G2 -- the cascade paused right after its practice rows
# ===========================================================================


@pytest.mark.asyncio
async def test_g1_cascade_against_deleting_the_school(
    client: AsyncClient, db_session: AsyncSession, w: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """BE-103 (b): the curator's series cancellation against the deletion of
    the school. The later occurrence has the LOWER id, so the deletion
    (by id) takes it first and then waits for the primary: with the
    cascade holding the primary only (the old shape) that is the cycle.

    The invariant: both committed, both occurrences cancelled, and the
    school's deletion left them without a school.
    """
    low, high = _ids(2)
    primary = await _practice(db_session, w, high, hours=10)
    later = await _practice(db_session, w, low, hours=20, root=primary)

    result = await race(
        monkeypatch,
        holder=_cascade(w, primary),
        pause_in=(cancel_service, "_primary_and_later"),
        rival=_delete_school(w),
    )
    assert_no_deadlock(result)
    assert result.rival_waited
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert set((await _statuses(primary, later)).values()) == {
        PracticeStatus.CANCELLED.value,
    }
    schools = (await fresh_execute(
        select(Practice.curator_group_id).where(
            Practice.id.in_([primary, later]),
        ),
    )).scalars().all()
    assert schools == [None, None]


@pytest.mark.asyncio
async def test_g2_cascade_against_blocking_the_student(
    client: AsyncClient, db_session: AsyncSession, w: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """BE-101 p.3: the curator's series cancellation against the master
    blocking a student booked on both occurrences. The later occurrence has
    the lower id: the block takes it first and waits for the primary.

    The invariant: both committed, both occurrences cancelled, the
    student's bookings gone with them (the block found nothing left to
    cancel, the cascade refunded them).
    """
    low, high = _ids(2)
    primary = await _practice(db_session, w, high, hours=10)
    later = await _practice(db_session, w, low, hours=20, root=primary)
    for pid in (primary, later):
        await _book(client, w, pid)

    result = await race(
        monkeypatch,
        holder=_cascade(w, primary),
        pause_in=(cancel_service, "_primary_and_later"),
        rival=_block(w),
    )
    assert_no_deadlock(result)
    assert result.rival_waited
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert set((await _statuses(primary, later)).values()) == {
        PracticeStatus.CANCELLED.value,
    }


# ===========================================================================
# G7 / G8 -- the rival's own order, through a gate
# ===========================================================================


@pytest.mark.asyncio
async def test_g7_deleting_the_school_against_blocking_through_a_gate(
    client: AsyncClient, db_session: AsyncSession, w: dict,
) -> None:
    """delete_curator_group must take the school's practices by id.

    Rows x1 < x2 by id, the student booked on both; x2 sits EARLIER in the
    heap, so an UPDATE without order meets it first. The heap order is
    BUILT, not hoped for: a booking rewrites the practice row
    (current_participants), and where the new version lands is the free
    space map's choice -- it came out the other way on the stand. CLUSTER
    by the scheduled_at index lays the table out in time order, and x2 is
    the earlier one. The gate holds x1. The
    block (by id) queues on x1 holding nothing. The deletion then queues
    too: by id it waits on x1 holding nothing; by scan order it takes x2
    first and waits on x1 -- and when the gate opens the block gets x1 and
    walks into x2. Preconditions asserted, not assumed.
    """
    x1, x2 = _ids(2)
    await _practice(db_session, w, x2, hours=10)
    await _practice(db_session, w, x1, hours=20)
    for pid in (x2, x1):
        await _book(client, w, pid)
    await _heap_in_time_order()
    assert await _scan_order(x1, x2) == [x2, x1], (
        "the heap order the window needs (x2 before x1) was not built"
    )

    block, delete = await _through_gate(x1, _block(w), _delete_school(w))
    _no_deadlock(block, delete)
    schools = (await fresh_execute(
        select(Practice.curator_group_id).where(Practice.id.in_([x1, x2])),
    )).scalars().all()
    assert schools == [None, None]


@pytest.mark.asyncio
async def test_g8_cascade_against_blocking_through_a_gate(
    client: AsyncClient, db_session: AsyncSession, w: dict,
) -> None:
    """block_student must take the practices by id (BE-99), not by time.

    The series: a (earlier) and b (later) with id(b) < id(a) -- the id order
    is the reverse of the time order. The student is booked on both, so both
    rows are in BOTH sets, and the gate holds b, the lowest id. The cascade
    from a (by id) queues on b holding nothing; the block then queues: by id
    on b holding nothing, by time it takes a first and waits on b -- and when
    the gate opens the cascade gets b and walks into a.
    """
    low, high = _ids(2)
    a = await _practice(db_session, w, high, hours=10)
    b = await _practice(db_session, w, low, hours=20, root=a)
    for pid in (a, b):
        await _book(client, w, pid)
    # The preconditions of the window, stated.
    times = dict((await fresh_execute(
        select(Practice.id, Practice.scheduled_at).where(
            Practice.id.in_([a, b]),
        ),
    )).all())
    assert b < a and times[b] > times[a], "id order must reverse time order"

    cascade, block = await _through_gate(b, _cascade(w, a), _block(w))
    _no_deadlock(cascade, block)
    assert set((await _statuses(a, b)).values()) == {
        PracticeStatus.CANCELLED.value,
    }


# ===========================================================================
# NEHVATKA -- the primary moved between the read and the lock
# ===========================================================================


@pytest.mark.asyncio
async def test_rescheduled_primary_sets_the_boundary_from_its_new_time(
    client: AsyncClient, db_session: AsyncSession, w: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The cascade reads the primary unlocked, the master moves it later and
    commits, then the cascade locks its set. The boundary "not earlier than
    the primary" must come from the LOCKED primary: the occurrence between
    the old and the new time was in the set by the old time and is not by
    the new one -- it stays untouched; the one after the new time goes.

    Holder paused BEFORE _manager_of_practice_or_404 -- the read is done,
    nothing is locked yet, so the rival commits without waiting.
    """
    root, primary, between, after = _ids(4)
    await _practice(db_session, w, root, hours=5)
    await _practice(db_session, w, primary, hours=10, root=root)
    await _practice(db_session, w, between, hours=20, root=root)
    await _practice(db_session, w, after, hours=40, root=root)
    moved_to = datetime.now(UTC) + timedelta(hours=30)

    async def reschedule(session: AsyncSession):
        user = await session.get(User, w["mid"])
        return await practice_service.update_practice(
            primary, user, UpdatePracticeRequest(scheduled_at=moved_to), session,
        )

    result = await race(
        monkeypatch,
        holder=_cascade(w, primary),
        pause_in=(cancel_service, "_manager_of_practice_or_404"),
        rival=reschedule,
    )
    assert result.rival.committed, result.rival.error
    assert result.holder.committed, result.holder.error
    assert await _statuses(root, primary, between, after) == {
        root: PracticeStatus.SCHEDULED.value,
        primary: PracticeStatus.CANCELLED.value,
        between: PracticeStatus.SCHEDULED.value,
        after: PracticeStatus.CANCELLED.value,
    }
