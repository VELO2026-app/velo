# =============================================================================
# BE-64 (delivery B) -- the curator cancels any practice of the school,
# series cascade included, and the master is told ONCE per action.
# =============================================================================
#
# The grid: caller (master / curator of this school / curator of another
# school / master of the school / stranger master) x practice (public of the
# school / for the school's students / series of the school / the master's
# own practice outside the school / school changed hands in the window) x
# scope (this / this_and_future) -> status code, what is cancelled, how many
# audit and journal rows, how many notifications to the master (0 or 1).
#
# The race: the cascade against the same curator's edit of one of the
# series' occurrences. The edit holds that practice and waits for the
# school as its owner; a cascade that took the school before the siblings
# deadlocked against it (40P01). The fixed order -- every practice row
# first, in one statement by id, then the school -- is written once, under
# PRACTICE ROW ORDER in practices/service.py.
#
# Practices are built with the same helper shape as
# test_practice_cancel_by_curator.py: every occurrence of a series has its
# root's master and school -- the only shape the API produces (BE-74).
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import AuditLog
from app.core.events.models import OutboxEvent
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupEvent,
    CuratorGroupMember,
    CuratorMemberKind,
)
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
from tests.curator_race_harness import assert_no_deadlock, race
from tests.helpers import (
    auth_headers,
    fresh_execute,
    full_cleanup_range,
    login_user,
)

CANCEL_URL = "/api/v1/practices/{practice_id}/cancel"

_TID_MIN = 70100
_TID_MAX = 70199

_TID_MASTER = 70101
_TID_CURATOR = 70102
_TID_OTHER_CURATOR = 70103
_TID_SCHOOL_MASTER = 70104
_TID_STRANGER = 70105
_TID_NEW_OWNER = 70106

_NOTE = "practice.cancelled_by_curator"
_BY_CURATOR = "practice_cancelled_by_curator"
_BY_MASTER = "practice_cancelled_by_master"


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


async def _master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> dict:
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


async def _school(
    db_session: AsyncSession, curator_id: str, name: str = "Каскад",
) -> CuratorGroup:
    group = CuratorGroup(curator_user_id=UUID(curator_id), name=name)
    db_session.add(group)
    await db_session.commit()
    return group


async def _practice(
    db_session: AsyncSession,
    master_id: str,
    *,
    school: CuratorGroup | None,
    hours: float,
    audience_kind: str | None = None,
    status: str = PracticeStatus.SCHEDULED.value,
    parent: Practice | None = None,
    title: str = "P",
) -> Practice:
    """A practice of the shape the API produces: a child has its root's
    master and school (BE-74), and the master of a school practice is a
    member of the school (_usable_curator_group_or_400)."""
    if audience_kind is None:
        audience_kind = (
            AudienceKind.CURATOR_GROUPS.value
            if school is not None
            else AudienceKind.PUBLIC.value
        )
    practice = Practice(
        master_id=UUID(master_id),
        title=title,
        description="x",
        practice_type=(
            PracticeType.SERIES.value if parent is not None
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
        audience_kind=audience_kind,
        parent_practice_id=parent.id if parent is not None else None,
        curator_group_id=school.id if school is not None else None,
    )
    db_session.add(practice)
    await db_session.flush()
    if school is not None and school.curator_user_id != practice.master_id:
        member = (
            await db_session.execute(
                select(CuratorGroupMember.id).where(
                    CuratorGroupMember.group_id == school.id,
                    CuratorGroupMember.user_id == practice.master_id,
                )
            )
        ).scalar_one_or_none()
        if member is None:
            db_session.add(
                CuratorGroupMember(
                    group_id=school.id,
                    user_id=practice.master_id,
                    kind=CuratorMemberKind.MASTER.value,
                )
            )
    await db_session.commit()
    return practice


async def _cancel(client, who: dict, practice: Practice, scope: str | None):
    kwargs = {} if scope is None else {"json": {"scope": scope}}
    return await client.post(
        CANCEL_URL.format(practice_id=practice.id),
        headers=auth_headers(who["session_token"]),
        **kwargs,
    )


async def _statuses(*practices: Practice) -> dict[UUID, str]:
    return dict((await fresh_execute(
        select(Practice.id, Practice.status).where(
            Practice.id.in_([p.id for p in practices]),
        ),
    )).all())


async def _audits(event: str, *practices: Practice) -> list[AuditLog]:
    return list((await fresh_execute(
        select(AuditLog).where(
            AuditLog.event == event,
            AuditLog.target_id.in_([p.id for p in practices]),
        ),
    )).scalars().all())


async def _journal(school: CuratorGroup) -> list[CuratorGroupEvent]:
    return list((await fresh_execute(
        select(CuratorGroupEvent).where(
            CuratorGroupEvent.group_id == school.id,
        ),
    )).scalars().all())


def _count_line(note: OutboxEvent, n: int) -> None:
    """The size of the action, as the master reads it in both channels:
    the template variable (telegram, comms-profile/templates/*.yaml) and the
    same line in the in-app body VELO writes (BE-64, owner, 2026-10-02)."""
    assert note.payload["action_data"]["cancelled_count"] == n
    assert f"Отменено занятий: {n}." in note.payload["body"]


async def _notes(master: dict) -> list[OutboxEvent]:
    """practice.cancelled_by_curator queued FOR THIS MASTER only -- the
    outbox is shared by the suite (see _outbox_types_for in
    test_practice_cancel_by_curator.py)."""
    return list((await fresh_execute(
        select(OutboxEvent).where(
            OutboxEvent.payload["type"].astext == _NOTE,
            OutboxEvent.payload["target_value"].astext == master["user"]["id"],
        ),
    )).scalars().all())


@pytest.fixture
async def world(client: AsyncClient, db_session: AsyncSession) -> dict:
    master = await _master(client, db_session, _TID_MASTER)
    curator = await _master(client, db_session, _TID_CURATOR)
    other_curator = await _master(client, db_session, _TID_OTHER_CURATOR)
    school_master = await _master(client, db_session, _TID_SCHOOL_MASTER)
    stranger = await _master(client, db_session, _TID_STRANGER)
    school = await _school(db_session, curator["user"]["id"])
    other_school = await _school(
        db_session, other_curator["user"]["id"], name="Другая",
    )
    db_session.add(
        CuratorGroupMember(
            group_id=school.id, user_id=UUID(school_master["user"]["id"]),
            kind=CuratorMemberKind.MASTER.value,
        )
    )
    await db_session.commit()
    return {
        "master": master, "curator": curator, "other_curator": other_curator,
        "school_master": school_master, "stranger": stranger,
        "school": school, "other_school": other_school,
    }


# ===========================================================================
# 1. The grid -- the curator of this school
# ===========================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize("audience", [
    AudienceKind.PUBLIC.value, AudienceKind.CURATOR_GROUPS.value,
])
@pytest.mark.parametrize("scope", [None, "this", "this_and_future"])
async def test_curator_cancels_a_single_practice_of_the_school(
    client: AsyncClient, db_session: AsyncSession, world: dict,
    audience: str, scope: str | None,
) -> None:
    """Public or for the school's students, any scope on a non-series
    practice: one cancelled, one audit row naming the school AND the master,
    one journal row, one note. A non-series practice has no siblings, so
    "this_and_future" reduces to "this"."""
    w = world
    p = await _practice(
        db_session, w["master"]["user"]["id"], school=w["school"], hours=24,
        audience_kind=audience,
    )
    resp = await _cancel(client, w["curator"], p, scope)
    assert resp.status_code == 200, resp.text

    assert await _statuses(p) == {p.id: PracticeStatus.CANCELLED.value}
    audits = await _audits(_BY_CURATOR, p)
    assert len(audits) == 1
    assert audits[0].actor_id == UUID(w["curator"]["user"]["id"])
    assert audits[0].data["group_id"] == str(w["school"].id)
    assert audits[0].data["master_id"] == w["master"]["user"]["id"]
    assert [e.data["practice_id"] for e in await _journal(w["school"])] == [
        str(p.id),
    ]
    notes = await _notes(w["master"])
    assert len(notes) == 1
    _count_line(notes[0], 1)


@pytest.mark.asyncio
async def test_curator_cascade_from_the_middle_cancels_what_is_ahead_once(
    client: AsyncClient, db_session: AsyncSession, world: dict,
) -> None:
    """A cascade addressed at an occurrence in the middle of a series.

    Root (earlier) survives -- the cascade looks forward only. Ahead: two
    still scheduled -> cancelled; one already cancelled and one completed
    -> untouched (no second audit, no journal row for them). One audit and
    one journal row per occurrence the action cancelled, and ONE note to
    the master for the whole action, keyed on the addressed occurrence.
    """
    w = world
    mid_ = w["master"]["user"]["id"]
    root = await _practice(db_session, mid_, school=w["school"], hours=10)
    middle = await _practice(
        db_session, mid_, school=w["school"], hours=20, parent=root,
    )
    ahead = [
        await _practice(
            db_session, mid_, school=w["school"], hours=h, parent=root,
        )
        for h in (30, 40)
    ]
    gone = await _practice(
        db_session, mid_, school=w["school"], hours=50, parent=root,
        status=PracticeStatus.CANCELLED.value,
    )
    done = await _practice(
        db_session, mid_, school=w["school"], hours=60, parent=root,
        status=PracticeStatus.COMPLETED.value,
    )

    resp = await _cancel(client, w["curator"], middle, "this_and_future")
    assert resp.status_code == 200, resp.text

    cancelled = {middle.id, *(p.id for p in ahead)}
    assert await _statuses(root, middle, *ahead, gone, done) == {
        root.id: PracticeStatus.SCHEDULED.value,
        **{pid: PracticeStatus.CANCELLED.value for pid in cancelled},
        gone.id: PracticeStatus.CANCELLED.value,
        done.id: PracticeStatus.COMPLETED.value,
    }
    audits = await _audits(_BY_CURATOR, root, middle, *ahead, gone, done)
    assert {a.target_id for a in audits} == cancelled
    assert len(audits) == len(cancelled)
    assert all(a.data["group_id"] == str(w["school"].id) for a in audits)
    journal = await _journal(w["school"])
    assert sorted(e.data["practice_id"] for e in journal) == sorted(
        str(pid) for pid in cancelled
    )
    notes = await _notes(w["master"])
    assert len(notes) == 1
    assert notes[0].payload["action_data"]["params"]["practice_id"] == str(
        middle.id,
    )
    # 1 + N: the addressed occurrence and the two ahead -- not the
    # cancelled and completed ones the action did not touch.
    _count_line(notes[0], 3)


@pytest.mark.asyncio
async def test_curator_this_on_a_series_cancels_only_this_one(
    client: AsyncClient, db_session: AsyncSession, world: dict,
) -> None:
    w = world
    mid_ = w["master"]["user"]["id"]
    root = await _practice(db_session, mid_, school=w["school"], hours=10)
    later = await _practice(
        db_session, mid_, school=w["school"], hours=20, parent=root,
    )
    resp = await _cancel(client, w["curator"], root, "this")
    assert resp.status_code == 200, resp.text
    assert await _statuses(root, later) == {
        root.id: PracticeStatus.CANCELLED.value,
        later.id: PracticeStatus.SCHEDULED.value,
    }
    assert len(await _journal(w["school"])) == 1
    assert len(await _notes(w["master"])) == 1


# ===========================================================================
# 2. The grid -- everybody else
# ===========================================================================


@pytest.mark.asyncio
async def test_master_cascade_is_unchanged_and_tells_nobody(
    client: AsyncClient, db_session: AsyncSession, world: dict,
) -> None:
    """The master's own cascade over a school series: by_master audits, no
    journal rows, no note -- the C2 predicate and the master path as they
    were, through the new lock order."""
    w = world
    mid_ = w["master"]["user"]["id"]
    root = await _practice(db_session, mid_, school=w["school"], hours=10)
    later = await _practice(
        db_session, mid_, school=w["school"], hours=20, parent=root,
    )
    resp = await _cancel(client, w["master"], root, "this_and_future")
    assert resp.status_code == 200, resp.text
    assert set((await _statuses(root, later)).values()) == {
        PracticeStatus.CANCELLED.value,
    }
    assert len(await _audits(_BY_MASTER, root, later)) == 2
    assert await _audits(_BY_CURATOR, root, later) == []
    assert await _journal(w["school"]) == []
    assert await _notes(w["master"]) == []


@pytest.mark.asyncio
async def test_curator_of_his_own_practice_cancels_as_its_master(
    client: AsyncClient, db_session: AsyncSession, world: dict,
) -> None:
    """The curator's own practice in his school: he is its master, the
    owner path answers (None), so no note to himself and no journal row."""
    w = world
    p = await _practice(
        db_session, w["curator"]["user"]["id"], school=w["school"], hours=24,
    )
    resp = await _cancel(client, w["curator"], p, "this_and_future")
    assert resp.status_code == 200, resp.text
    assert len(await _audits(_BY_MASTER, p)) == 1
    assert await _journal(w["school"]) == []
    assert await _notes(w["curator"]) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("who", ["other_curator", "school_master", "stranger"])
@pytest.mark.parametrize("scope", ["this", "this_and_future"])
async def test_nobody_else_reaches_a_school_series(
    client: AsyncClient, db_session: AsyncSession, world: dict,
    who: str, scope: str,
) -> None:
    """P-08: the curator of another school, a master of this school and a
    stranger get the 404 a nonexistent practice gets, and nothing moves."""
    w = world
    mid_ = w["master"]["user"]["id"]
    root = await _practice(
        db_session, mid_, school=w["school"], hours=10,
        audience_kind=AudienceKind.PUBLIC.value,
    )
    later = await _practice(
        db_session, mid_, school=w["school"], hours=20, parent=root,
        audience_kind=AudienceKind.PUBLIC.value,
    )
    resp = await _cancel(client, w[who], root, scope)
    assert resp.status_code == 404
    assert resp.json()["error"] == "not_found"
    assert set((await _statuses(root, later)).values()) == {
        PracticeStatus.SCHEDULED.value,
    }
    assert await _audits(_BY_CURATOR, root, later) == []
    assert await _journal(w["school"]) == []
    assert await _notes(w["master"]) == []


@pytest.mark.asyncio
async def test_curator_cannot_cancel_the_masters_practice_outside_the_school(
    client: AsyncClient, db_session: AsyncSession, world: dict,
) -> None:
    w = world
    p = await _practice(
        db_session, w["master"]["user"]["id"], school=None, hours=24,
    )
    resp = await _cancel(client, w["curator"], p, "this_and_future")
    assert resp.status_code == 404
    assert await _statuses(p) == {p.id: PracticeStatus.SCHEDULED.value}
    assert await _notes(w["master"]) == []


# ===========================================================================
# 3. Axes
# ===========================================================================


@pytest.mark.asyncio
async def test_repeat_is_refused_on_status_with_no_second_note(
    client: AsyncClient, db_session: AsyncSession, world: dict,
) -> None:
    """POVTOR: the same cascade twice -- the second is refused on the
    primary's status and writes nothing; the note stays one."""
    w = world
    mid_ = w["master"]["user"]["id"]
    root = await _practice(db_session, mid_, school=w["school"], hours=10)
    await _practice(db_session, mid_, school=w["school"], hours=20, parent=root)

    first = await _cancel(client, w["curator"], root, "this_and_future")
    assert first.status_code == 200, first.text
    second = await _cancel(client, w["curator"], root, "this_and_future")
    assert second.status_code == 400
    assert len(await _journal(w["school"])) == 2
    assert len(await _notes(w["master"])) == 1


@pytest.mark.asyncio
async def test_series_with_nothing_ahead_cancels_one_with_one_note(
    client: AsyncClient, db_session: AsyncSession, world: dict,
) -> None:
    """PUSTOTA: the last occurrence of a series, everything before it in
    the past or done -- the cascade has no siblings: one cancelled, one
    journal row, one note."""
    w = world
    mid_ = w["master"]["user"]["id"]
    root = await _practice(
        db_session, mid_, school=w["school"], hours=-48,
        status=PracticeStatus.COMPLETED.value,
    )
    last = await _practice(
        db_session, mid_, school=w["school"], hours=24, parent=root,
    )
    resp = await _cancel(client, w["curator"], last, "this_and_future")
    assert resp.status_code == 200, resp.text
    assert await _statuses(root, last) == {
        root.id: PracticeStatus.COMPLETED.value,
        last.id: PracticeStatus.CANCELLED.value,
    }
    assert len(await _journal(w["school"])) == 1
    notes = await _notes(w["master"])
    assert len(notes) == 1
    _count_line(notes[0], 1)


@pytest.mark.asyncio
async def test_school_handed_over_in_the_window_cancels_nothing(
    client: AsyncClient, db_session: AsyncSession, world: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """NEHVATKA: the school changed hands between the read of the right and
    the lock -- 404, and nothing of the cascade was written.

    The window is built by its two ends, not by a race: the hand-over has
    committed (curator_user_id is the new owner's -- the end state of an
    accepted transfer), and the READ of the right answers as it did before
    it (_curated_school_of patched to the stale answer). Only the re-check
    under the group lock can tell, and it must, before any write.
    """
    w = world
    mid_ = w["master"]["user"]["id"]
    root = await _practice(db_session, mid_, school=w["school"], hours=10)
    later = await _practice(
        db_session, mid_, school=w["school"], hours=20, parent=root,
    )
    new_owner = await _master(client, db_session, _TID_NEW_OWNER)
    await db_session.execute(
        update(CuratorGroup)
        .where(CuratorGroup.id == w["school"].id)
        .values(curator_user_id=UUID(new_owner["user"]["id"]))
    )
    await db_session.commit()
    stale = w["school"].id

    async def _stale_read(practice, user, session):
        return stale

    monkeypatch.setattr(practice_service, "_curated_school_of", _stale_read)

    resp = await _cancel(client, w["curator"], root, "this_and_future")
    assert resp.status_code == 404
    assert resp.json()["error"] == "not_found"
    assert set((await _statuses(root, later)).values()) == {
        PracticeStatus.SCHEDULED.value,
    }
    assert await _audits(_BY_CURATOR, root, later) == []
    assert await _journal(w["school"]) == []
    assert await _notes(w["master"]) == []


# ===========================================================================
# 4. The race -- the cascade against the curator's edit of a sibling
# ===========================================================================


@pytest.mark.asyncio
async def test_cascade_against_the_curators_edit_of_a_sibling_does_not_deadlock(
    client: AsyncClient, db_session: AsyncSession, world: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Holder: the curator edits the series' later occurrence -- it holds
    that practice FOR UPDATE and is paused just before it locks the school
    as its owner (_relock_school_or_404 -> _lock_group_as_owner). Rival:
    the same curator's cascade from the root -- it locks the series in one
    statement by id and waits at the held sibling.

    With the school taken AFTER the siblings, the rival holds no school
    while it waits: the holder gets the school, commits, and the cascade
    then cancels the edited occurrence. With the school taken BEFORE the
    siblings (the order BE-64 removed), the released holder waits for the
    school the rival holds while the rival waits for the holder's row --
    both waiting at once, 40P01. The harness asserts the rival really
    waited on a lock, so a green run is two calls that met.

    The invariant, not a winner: both committed, the edit landed exactly
    as written, and the occurrence is cancelled.
    """
    w = world
    mid_ = w["master"]["user"]["id"]
    root = await _practice(db_session, mid_, school=w["school"], hours=10)
    later = await _practice(
        db_session, mid_, school=w["school"], hours=20, parent=root,
    )
    curator_id = UUID(w["curator"]["user"]["id"])

    async def holder(session: AsyncSession):
        user = await session.get(User, curator_id)
        return await practice_service.update_practice(
            later.id, user, UpdatePracticeRequest(title="Правка"), session,
        )

    async def rival(session: AsyncSession):
        user = await session.get(User, curator_id)
        return await cancel_service.cancel_practice(
            root.id, user, session, scope="this_and_future",
        )

    result = await race(
        monkeypatch,
        holder=holder,
        pause_in=(practice_service, "_lock_group_as_owner"),
        rival=rival,
    )
    assert_no_deadlock(result)
    assert result.rival_waited
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error

    fresh = dict((await fresh_execute(
        select(Practice.id, Practice.title).where(Practice.id == later.id),
    )).all())
    assert fresh[later.id] == "Правка"
    assert set((await _statuses(root, later)).values()) == {
        PracticeStatus.CANCELLED.value,
    }
