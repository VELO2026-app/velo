# =============================================================================
# PRACTICE ROW ORDER for update_practice (BE-103 W4) -- an audience change of
# a series root takes the root and its non-terminal children in ONE
# statement ORDER BY id, before the school (practices/service.py, header;
# _lock_practice_and_children), and the propagation writes those rows.
# =============================================================================
#
#   G3   W4 (master)  x series cascade from a child
#   G3r  W4 (master)  x series cascade from the root
#   G4   W4 (curator) x the curator's series cascade -- the path through the
#        practices; see its docstring for why not through the school
#   G5   W4           x block_student
#   G6   W4           x delete_curator_group
#   G9   a child cancelled while W4 waits for it -- not rewritten (item 2)
#   G11  a child born while W4's lock waits on the root -- 409 (W-b)
#   G12  the unlocked read says "no change", the locked root says "change"
#        -- 409 (owner ruling, option B)
#
# WHO HOLDS AN INCOMPLETE SET. G3-G6 pause W4 at propagate_audience_to_
# children -- the seam exists in the fixed code and in the old shape alike,
# at the same logical point. In the fixed code W4 holds its whole set there
# and the rival, taking by id, waits holding nothing W4 needs. In the old
# shape (the root alone, the children by the propagation's own UPDATE) W4
# holds the ROOT ONLY: the INCOMPLETE set is the holder's, so these races
# measure W4's order without a gate. Every child id is below the root's,
# so the rival holds every child when it reaches the root, and the old
# shape's UPDATE meets a held child whatever order it scans in: the heap
# order does not decide the outcome, and none is built (no CLUSTER).
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.curator_groups import service as curator_service
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters import groups_service
from app.modules.masters.groups_models import MasterGroup
from app.modules.masters.models import MasterProfile
from app.modules.practices import cancel_service, series_service
from app.modules.practices import service as practice_service
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeAudienceGroup,
    PracticeStatus,
    PracticeType,
)
from app.modules.practices.schemas import (
    CreatePracticeRequest,
    UpdatePracticeRequest,
)
from app.modules.users.models import User, UserRole
from tests.curator_race_harness import assert_no_deadlock, race
from tests.helpers import (
    auth_headers,
    fresh_execute,
    full_cleanup_range,
    login_user,
)

BOOKINGS_URL = "/api/v1/bookings"

_TID_MIN = 70300
_TID_MAX = 70399

_TID_MASTER = 70301
_TID_CURATOR = 70302
_TID_STUDENT = 70310


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
        curator_user_id=UUID(curator["user"]["id"]), name="Аудитория",
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
    root: UUID | None = None, school: bool = False,
    status: str = PracticeStatus.SCHEDULED.value,
    audience: str = AudienceKind.PUBLIC.value,
) -> UUID:
    """A practice of the master with a chosen id; a child has its root's
    master and school, the only shape the API produces."""
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
            status=status,
            scheduled_at=datetime.now(UTC) + timedelta(hours=hours),
            duration_minutes=60,
            timezone="UTC",
            max_participants=20,
            current_participants=0,
            is_free=True,
            price_cents=0,
            currency="eur",
            audience_kind=audience,
            parent_practice_id=root,
            curator_group_id=w["school"] if school else None,
        )
    )
    await db_session.commit()
    return pid


async def _series(
    db_session: AsyncSession, w: dict, *, school: bool = False,
) -> tuple[UUID, UUID, UUID]:
    """root, early, late -- both children with ids BELOW the root's, so a
    rival taking by id holds them both when it reaches the root."""
    early_id, late_id, root_id = _ids(3)
    root = await _practice(db_session, w, root_id, hours=5, school=school)
    early = await _practice(
        db_session, w, early_id, hours=10, root=root, school=school,
    )
    late = await _practice(
        db_session, w, late_id, hours=20, root=root, school=school,
    )
    return root, early, late


async def _book(client: AsyncClient, w: dict, pid: UUID) -> None:
    resp = await client.post(
        BOOKINGS_URL,
        json={"practice_id": str(pid)},
        headers=auth_headers(w["student"]["session_token"]),
    )
    assert resp.status_code == 201, resp.text


async def _rows(*pids: UUID) -> dict[UUID, tuple[str, str, UUID | None]]:
    """id -> (status, audience_kind, school), read by a fresh session."""
    rows = (await fresh_execute(
        select(
            Practice.id, Practice.status, Practice.audience_kind,
            Practice.curator_group_id,
        ).where(Practice.id.in_(pids)),
    )).all()
    return {r[0]: (r[1], r[2], r[3]) for r in rows}


def _edit(user_id: UUID, pid: UUID, **fields):
    async def call(session: AsyncSession):
        user = await session.get(User, user_id)
        return await practice_service.update_practice(
            pid, user, UpdatePracticeRequest(**fields), session,
        )
    return call


def _cascade(user_id: UUID, pid: UUID):
    async def call(session: AsyncSession):
        user = await session.get(User, user_id)
        return await cancel_service.cancel_practice(
            pid, user, session, scope="this_and_future",
        )
    return call


def _cancel_one(user_id: UUID, pid: UUID):
    async def call(session: AsyncSession):
        user = await session.get(User, user_id)
        return await cancel_service.cancel_practice(pid, user, session)
    return call


def _block_student(w: dict):
    async def call(session: AsyncSession):
        return await groups_service.block_student(w["mid"], w["sid"], session)
    return call


_PROPAGATION = (series_service, "propagate_audience_to_children")

_STUDENTS = AudienceKind.STUDENTS.value
_PUBLIC = AudienceKind.PUBLIC.value
_SCHOOL_AUDIENCE = AudienceKind.CURATOR_GROUPS.value
_CANCELLED = PracticeStatus.CANCELLED.value
_SCHEDULED = PracticeStatus.SCHEDULED.value


def _committed_both(result) -> None:
    assert_no_deadlock(result)
    assert result.rival_waited
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error


# ===========================================================================
# G3 / G3r / G4 -- the series cascade
# ===========================================================================


@pytest.mark.asyncio
async def test_g3_root_audience_edit_against_a_cascade_from_a_child(
    client: AsyncClient, db_session: AsyncSession, w: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The master switches the root to 'students' while cancelling the
    series from its first occurrence. The cascade takes by id: both
    children, then the root.

    The invariant: both committed; the edit landed first (the cascade
    waited), so every row carries the new audience -- and the cascade
    still cancelled exactly the occurrences from the first child on,
    leaving the earlier root scheduled.
    """
    root, early, late = await _series(db_session, w)

    result = await race(
        monkeypatch,
        holder=_edit(w["mid"], root, audience_kind=_STUDENTS),
        pause_in=_PROPAGATION,
        rival=_cascade(w["mid"], early),
    )
    _committed_both(result)
    rows = await _rows(root, early, late)
    assert {pid: r[1] for pid, r in rows.items()} == {
        root: _STUDENTS, early: _STUDENTS, late: _STUDENTS,
    }
    assert {pid: r[0] for pid, r in rows.items()} == {
        root: _SCHEDULED, early: _CANCELLED, late: _CANCELLED,
    }


@pytest.mark.asyncio
async def test_g3r_root_audience_edit_against_a_cascade_from_the_root(
    client: AsyncClient, db_session: AsyncSession, w: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The same pair with the cascade started from the root itself.

    The invariant: both committed, the new audience on all three rows,
    all three cancelled.
    """
    root, early, late = await _series(db_session, w)

    result = await race(
        monkeypatch,
        holder=_edit(w["mid"], root, audience_kind=_STUDENTS),
        pause_in=_PROPAGATION,
        rival=_cascade(w["mid"], root),
    )
    _committed_both(result)
    rows = await _rows(root, early, late)
    assert {r[1] for r in rows.values()} == {_STUDENTS}
    assert {r[0] for r in rows.values()} == {_CANCELLED}


@pytest.mark.asyncio
async def test_g4_curators_root_audience_edit_against_the_curators_cascade(
    client: AsyncClient, db_session: AsyncSession, w: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The curator moves a school series root to the school's audience
    while cancelling the series from a child.

    WHAT THIS MEASURES -- and what it does not. The edit holds its rows and
    then the school (practice -> group); in the old shape it held the root
    and the school and wanted the children. A cycle THROUGH THE SCHOOL alone
    would need the cascade to hold its set without the root and then wait
    for the school -- but the root is in the cascade's set whenever it is
    still scheduled, and an edit of a finished root is not this pair. So
    the cycle this race can build runs through the practices (the cascade
    holds both children and waits for the root), exactly as in G3, with
    the school lock added on the holder's side. It is not a test of the
    school's place in the order.

    The invariant: both committed, the school's audience on all three rows,
    the occurrences from the child on cancelled, the root still scheduled
    and still the school's.
    """
    root, early, late = await _series(db_session, w, school=True)

    result = await race(
        monkeypatch,
        holder=_edit(w["cid"], root, audience_kind=_SCHOOL_AUDIENCE),
        pause_in=_PROPAGATION,
        rival=_cascade(w["cid"], early),
    )
    _committed_both(result)
    rows = await _rows(root, early, late)
    assert {r[1] for r in rows.values()} == {_SCHOOL_AUDIENCE}
    assert {pid: r[0] for pid, r in rows.items()} == {
        root: _SCHEDULED, early: _CANCELLED, late: _CANCELLED,
    }
    assert {r[2] for r in rows.values()} == {w["school"]}


# ===========================================================================
# G5 / G6 -- block_student, delete_curator_group
# ===========================================================================


@pytest.mark.asyncio
async def test_g5_root_audience_edit_against_blocking_a_student(
    client: AsyncClient, db_session: AsyncSession, w: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A student booked on the whole series is blocked by the master while
    the master switches the root's audience. block_student takes the
    student's future practices of the master by id (BE-99).

    The invariant: both committed, the new audience on all three rows, and
    the student holds no active booking on any of them.
    """
    root, early, late = await _series(db_session, w)
    for pid in (root, early, late):
        await _book(client, w, pid)

    result = await race(
        monkeypatch,
        holder=_edit(w["mid"], root, audience_kind=_STUDENTS),
        pause_in=_PROPAGATION,
        rival=_block_student(w),
    )
    _committed_both(result)
    rows = await _rows(root, early, late)
    assert {r[1] for r in rows.values()} == {_STUDENTS}
    active = (await fresh_execute(
        select(Booking.id).where(
            Booking.user_id == w["sid"],
            Booking.practice_id.in_([root, early, late]),
            Booking.status.in_([
                BookingStatus.CONFIRMED.value, BookingStatus.PENDING.value,
            ]),
        ),
    )).scalars().all()
    assert active == []
    # The pair: the bookings existed -- the block had something to undo.
    every = (await fresh_execute(
        select(Booking.id).where(Booking.user_id == w["sid"]),
    )).scalars().all()
    assert len(every) == 3


@pytest.mark.asyncio
async def test_g6_root_audience_edit_against_deleting_the_school(
    client: AsyncClient, db_session: AsyncSession, w: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The master moves a school series root to the school's audience while
    the curator deletes the school. delete_curator_group takes the school's
    practices by id before its UPDATE of them.

    The invariant: both committed; the edit landed first, and the deletion
    then left every row without a school and public (BE-74: a school
    deleted -> its practices go public) -- the deletion saw the edit.
    """
    root, early, late = await _series(db_session, w, school=True)

    async def delete_school(session: AsyncSession):
        await curator_service.delete_curator_group(
            w["cid"], w["school"], session,
        )

    result = await race(
        monkeypatch,
        holder=_edit(w["mid"], root, audience_kind=_SCHOOL_AUDIENCE),
        pause_in=_PROPAGATION,
        rival=delete_school,
    )
    _committed_both(result)
    rows = await _rows(root, early, late)
    assert {r[2] for r in rows.values()} == {None}
    assert {r[1] for r in rows.values()} == {_PUBLIC}
    assert {r[0] for r in rows.values()} == {_SCHEDULED}


# ===========================================================================
# G9 -- item 2: a child cancelled while W4 waits for it
# ===========================================================================


@pytest.mark.asyncio
async def test_g9_a_child_cancelled_in_the_window_keeps_its_audience(
    client: AsyncClient, db_session: AsyncSession, w: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The master cancels one occurrence and, at the same time, switches
    the root's audience. The edit's lock statement waits on the
    occurrence; when it gets it, the occurrence is cancelled -- FOR UPDATE
    re-checks the status filter on it, and the propagation writes only the
    rows that survived (S-d: history is not rewritten).

    Not a deadlock race: the edit waits holding the rows below the
    occurrence's id, the cancellation of one practice wants nothing more.

    The invariant: both committed; the cancelled occurrence keeps the
    audience it had -- and the other one (the pair) took the new audience,
    so "not rewritten" is not "the propagation did nothing".
    """
    root, early, late = await _series(db_session, w)

    result = await race(
        monkeypatch,
        holder=_cancel_one(w["mid"], early),
        pause_in=(cancel_service, "_primary_and_later"),
        rival=_edit(w["mid"], root, audience_kind=_STUDENTS),
    )
    _committed_both(result)
    rows = await _rows(root, early, late)
    assert rows[early][:2] == (_CANCELLED, _PUBLIC)
    assert rows[late][:2] == (_SCHEDULED, _STUDENTS)
    assert rows[root][1] == _STUDENTS


# ===========================================================================
# G11 / G12 -- the locked set is not the set to write: 409
# ===========================================================================


async def _custom_group(db_session: AsyncSession, w: dict) -> UUID:
    group = MasterGroup(master_id=w["mid"], name=f"G-{uuid4()}")
    db_session.add(group)
    await db_session.commit()
    return group.id


@pytest.mark.asyncio
async def test_g11_a_child_born_while_the_lock_waits_refuses_the_edit(
    client: AsyncClient, db_session: AsyncSession, w: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """W-b. The master attaches an occurrence to a root restricted to a
    group (path A: it inherits the root's audience and group rows) while
    switching the root to 'students'. The INSERT holds KEY SHARE on the
    root; the edit's lock statement, whose snapshot predates the new row,
    waits on the root and gets it once the occurrence is committed --
    without the occurrence, which FOR UPDATE does not look for.

    The holder pauses AFTER the INSERT, in the copy of the inherited group
    rows (_set_practice_audience_groups runs after the flush).

    The invariant: the edit is refused whole with 409
    series_audience_changed; the root keeps its audience -- and the newborn
    carries that same audience (the pair: refused, and nothing left
    inconsistent). Without the check the edit commits and the newborn
    stays restricted to the group under a 'students' root.
    """
    (root_id,) = _ids(1)
    group_id = await _custom_group(db_session, w)
    root = await _practice(
        db_session, w, root_id, hours=5,
        audience=AudienceKind.GROUPS.value,
    )
    db_session.add(PracticeAudienceGroup(practice_id=root, group_id=group_id))
    await db_session.commit()

    async def attach(session: AsyncSession):
        user = await session.get(User, w["mid"])
        practice, _ = await practice_service.create_practice(
            user,
            CreatePracticeRequest(
                practice_type="series",
                direction="meditation",
                difficulty="beginner",
                title="Новое занятие",
                description="x",
                scheduled_at=datetime.now(UTC) + timedelta(days=3),
                duration_minutes=60,
                timezone="UTC",
                max_participants=10,
                is_free=True,
                price_cents=0,
                currency="eur",
                parent_practice_id=root,
            ),
            session,
        )
        return practice.id

    result = await race(
        monkeypatch,
        holder=attach,
        pause_in=(practice_service, "_set_practice_audience_groups"),
        pause="after",
        rival=_edit(w["mid"], root, audience_kind=_STUDENTS),
    )
    assert_no_deadlock(result)
    assert result.rival_waited
    assert result.holder.committed, result.holder.error
    assert isinstance(result.rival.error, ConflictError), result.rival.error
    assert result.rival.error.code == "series_audience_changed"

    newborn = result.holder.result
    rows = await _rows(root, newborn)
    assert rows[root][1] == AudienceKind.GROUPS.value
    assert rows[newborn][1] == AudienceKind.GROUPS.value


@pytest.mark.asyncio
async def test_g12_a_stale_no_change_read_refuses_the_edit(
    client: AsyncClient, db_session: AsyncSession, w: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Option B's own window. One edit switches the root to 'students'; a
    second one, sent by a screen still showing 'public', resends 'public'.
    The second one's unlocked read sees 'public' -- "no change", no
    children taken -- and its lock waits for the first. On the locked root
    'public' IS a change, and the children it would have to carry are not
    held.

    The invariant: the first committed, the second is refused whole with
    409 series_audience_changed -- and the series is left consistent: the
    root and both children on 'students' (the pair). Without the re-check
    the second commits, the root goes back to 'public' and the children
    stay on 'students'.
    """
    root, early, late = await _series(db_session, w)

    result = await race(
        monkeypatch,
        holder=_edit(w["mid"], root, audience_kind=_STUDENTS),
        pause_in=_PROPAGATION,
        rival=_edit(w["mid"], root, audience_kind=_PUBLIC),
    )
    assert_no_deadlock(result)
    assert result.rival_waited
    assert result.holder.committed, result.holder.error
    assert isinstance(result.rival.error, ConflictError), result.rival.error
    assert result.rival.error.code == "series_audience_changed"
    rows = await _rows(root, early, late)
    assert {r[1] for r in rows.values()} == {_STUDENTS}
