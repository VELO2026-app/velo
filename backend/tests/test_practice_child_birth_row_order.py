# =============================================================================
# A series child born by path A (create_practice with parent_practice_id)
# in the PRACTICE ROW ORDER -- BE-103 W-a and N1.
# =============================================================================
#
#   Wa1  own child of a 'groups' root  x the root switched groups -> public
#   Wa2  own child of a public root    x the root switched public -> students
#   N1a  curator's child for a master  x the curator's audience edit of the
#        root (W4)
#   N1b  curator's child for a master  x the curator's series cancellation
#   N1c  curator's child for a master  x the master publishing the root
#   N1d  curator's child for a master  x deleting the school
#        N1c and N1d are measurements, not regression tests: no cycle in
#        either shape (each says why)
#
# W-a (Wa1/Wa2) is not a deadlock pair: it measures the missing lock. The
# child is paused right after its parent is validated
# (_owned_root_parent_or_400); without the lock the edit commits into that
# window and the child inherits a mix of two states of its parent -- the
# kind it read and the group rows it copies after its INSERT.
#
# N1 (N1a-d) pauses the curator's creation right after the school's group
# is locked as its owner (_lock_group_as_owner) -- the seam exists in the
# fixed code and in the old shape alike. In the fixed code the creation
# then holds the target's rows, the PARENT and the group; in the old shape
# (the parent taken after the group) it holds the group WITHOUT the parent:
# the INCOMPLETE set is the holder's, and a rival holding the root and
# wanting the group (N1a, N1b) closes the cycle when the holder reaches
# for the parent. No gate, no heap order: one root, one group.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError
from app.modules.curator_groups import service as curator_service
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters.groups_models import MasterGroup
from app.modules.masters.models import MasterProfile
from app.modules.practices import cancel_service
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
from tests.helpers import fresh_execute, full_cleanup_range, login_user

_TID_MIN = 70400
_TID_MAX = 70499

_TID_MASTER = 70401
_TID_CURATOR = 70402


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
    school = CuratorGroup(
        curator_user_id=UUID(curator["user"]["id"]), name="Рождение",
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
        "school": school.id,
        "mid": UUID(master["user"]["id"]),
        "cid": UUID(curator["user"]["id"]),
    }


async def _practice(
    db_session: AsyncSession, w: dict, pid: UUID, *, hours: float,
    root: UUID | None = None, school: bool = False,
    status: str = PracticeStatus.SCHEDULED.value,
    audience: str = AudienceKind.PUBLIC.value,
) -> UUID:
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


def _child_body(root: UUID, **extra) -> CreatePracticeRequest:
    return CreatePracticeRequest(
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
        **extra,
    )


def _own_child(w: dict, root: UUID):
    """The master attaches an occurrence to their own root."""
    async def call(session: AsyncSession):
        user = await session.get(User, w["mid"])
        practice, deduped = await practice_service.create_practice(
            user, _child_body(root), session,
        )
        assert not deduped
        return practice.id
    return call


def _curators_child(w: dict, root: UUID):
    """The curator attaches an occurrence to the master's school root, for
    the master (BE-102)."""
    async def call(session: AsyncSession):
        user = await session.get(User, w["cid"])
        practice, deduped = await practice_service.create_practice(
            user,
            _child_body(
                root, master_id=w["mid"], curator_group_id=w["school"],
            ),
            session,
        )
        assert not deduped
        return practice.id
    return call


def _edit(user_id: UUID, pid: UUID, **fields):
    async def call(session: AsyncSession):
        user = await session.get(User, user_id)
        return await practice_service.update_practice(
            pid, user, UpdatePracticeRequest(**fields), session,
        )
    return call


async def _rows(*pids: UUID) -> dict[UUID, tuple[str, str, UUID | None]]:
    """id -> (status, audience_kind, school), read by a fresh session."""
    rows = (await fresh_execute(
        select(
            Practice.id, Practice.status, Practice.audience_kind,
            Practice.curator_group_id,
        ).where(Practice.id.in_(pids)),
    )).all()
    return {r[0]: (r[1], r[2], r[3]) for r in rows}


async def _groups_of(pid: UUID) -> set[UUID]:
    return set((await fresh_execute(
        select(PracticeAudienceGroup.group_id).where(
            PracticeAudienceGroup.practice_id == pid,
        ),
    )).scalars().all())


def _refused_409(outcome) -> None:
    assert isinstance(outcome.error, ConflictError), outcome.error
    assert outcome.error.code == "series_audience_changed"


_PARENT_LOCK = (practice_service, "_owned_root_parent_or_400")
_GROUP_LOCK = (practice_service, "_lock_group_as_owner")

_PUBLIC = AudienceKind.PUBLIC.value
_GROUPS = AudienceKind.GROUPS.value
_STUDENTS = AudienceKind.STUDENTS.value
_SCHOOL_AUDIENCE = AudienceKind.CURATOR_GROUPS.value
_DRAFT = PracticeStatus.DRAFT.value
_SCHEDULED = PracticeStatus.SCHEDULED.value
_CANCELLED = PracticeStatus.CANCELLED.value


# ===========================================================================
# Wa1 / Wa2 -- W-a: the child inherits ONE state of its parent
# ===========================================================================


@pytest.mark.asyncio
async def test_wa1_a_child_of_a_groups_root_is_not_left_without_groups(
    client: AsyncClient, db_session: AsyncSession, w: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The master attaches an occurrence to a root restricted to a group
    while switching the root to public. Without the parent's lock the
    switch commits between the child's read of the parent (kind 'groups')
    and its copy of the parent's group rows after the INSERT (none left):
    a 'groups' child that nobody can ever see.

    The invariant: the edit waited for the child; the child carries the
    parent's state it was born under -- 'groups' AND the group row (the
    pair: not an empty set); the edit, finding a child it does not hold,
    is refused whole (BE-103 W4, 409) and the root is unchanged.
    """
    group = MasterGroup(master_id=w["mid"], name=f"G-{uuid4()}")
    db_session.add(group)
    await db_session.commit()
    root = await _practice(db_session, w, uuid4(), hours=5, audience=_GROUPS)
    db_session.add(PracticeAudienceGroup(practice_id=root, group_id=group.id))
    await db_session.commit()

    result = await race(
        monkeypatch,
        holder=_own_child(w, root),
        pause_in=_PARENT_LOCK,
        pause="after",
        rival=_edit(w["mid"], root, audience_kind=_PUBLIC),
    )
    assert_no_deadlock(result)
    assert result.rival_waited
    assert result.holder.committed, result.holder.error
    _refused_409(result.rival)
    child = result.holder.result
    rows = await _rows(root, child)
    assert rows[root][1] == _GROUPS
    assert rows[child][1] == _GROUPS
    assert await _groups_of(child) == {group.id} == await _groups_of(root)


@pytest.mark.asyncio
async def test_wa2_a_child_of_a_public_root_does_not_stay_public_alone(
    client: AsyncClient, db_session: AsyncSession, w: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The other direction: the root goes from public to 'students' while
    an occurrence is attached. Without the lock the child keeps the kind it
    read -- a public, bookable session in a series closed to strangers.

    The invariant: the edit waited, the child and the root carry the same
    kind (public: the edit is refused with 409, nothing of it landed).
    """
    root = await _practice(db_session, w, uuid4(), hours=5)

    result = await race(
        monkeypatch,
        holder=_own_child(w, root),
        pause_in=_PARENT_LOCK,
        pause="after",
        rival=_edit(w["mid"], root, audience_kind=_STUDENTS),
    )
    assert_no_deadlock(result)
    assert result.rival_waited
    assert result.holder.committed, result.holder.error
    _refused_409(result.rival)
    child = result.holder.result
    rows = await _rows(root, child)
    assert rows[root][1] == rows[child][1] == _PUBLIC


# ===========================================================================
# N1a-c -- N1: the curator's child takes the parent before the school
# ===========================================================================


@pytest.mark.asyncio
async def test_n1a_curators_child_against_the_curators_audience_edit(
    client: AsyncClient, db_session: AsyncSession, w: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The curator attaches an occurrence for the master and, at the same
    time, moves the root to the school's audience. The edit takes the
    series and then the school (practice -> group); the creation, in the
    old shape, held the school and then wanted the parent: 40P01.

    The invariant: no deadlock; the creation committed and the edit,
    which waited on the parent and then found a child it does not hold, is
    refused with 409; the child carries the root's audience and the school.
    """
    root = await _practice(db_session, w, uuid4(), hours=5, school=True)

    result = await race(
        monkeypatch,
        holder=_curators_child(w, root),
        pause_in=_GROUP_LOCK,
        pause="after",
        rival=_edit(w["cid"], root, audience_kind=_SCHOOL_AUDIENCE),
    )
    assert_no_deadlock(result)
    assert result.rival_waited
    assert result.holder.committed, result.holder.error
    _refused_409(result.rival)
    child = result.holder.result
    rows = await _rows(root, child)
    assert rows[root][1:] == rows[child][1:] == (_PUBLIC, w["school"])


@pytest.mark.asyncio
async def test_n1b_curators_child_against_the_curators_series_cancellation(
    client: AsyncClient, db_session: AsyncSession, w: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The curator attaches an occurrence for the master while cancelling
    the series. The cancellation takes the series by id and then the school
    as its owner; the creation in the old shape held the school and wanted
    the parent.

    The invariant: both committed; the series is cancelled -- and the
    newborn is not in it: a draft, outside the cascade's set
    (_CANCELLABLE_PRACTICE_STATUSES), left attached to a cancelled root.
    That last part is asserted as what the code does today, not as what it
    should do (BE-103, observation "a child of a dead root").
    """
    root = await _practice(db_session, w, uuid4(), hours=5, school=True)

    async def cascade(session: AsyncSession):
        user = await session.get(User, w["cid"])
        return await cancel_service.cancel_practice(
            root, user, session, scope="this_and_future",
        )

    result = await race(
        monkeypatch,
        holder=_curators_child(w, root),
        pause_in=_GROUP_LOCK,
        pause="after",
        rival=cascade,
    )
    assert_no_deadlock(result)
    assert result.rival_waited
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    child = result.holder.result
    rows = await _rows(root, child)
    assert rows[root][0] == _CANCELLED
    assert rows[child][0] == _DRAFT


@pytest.mark.asyncio
async def test_n1c_curators_child_against_the_master_publishing_the_root(
    client: AsyncClient, db_session: AsyncSession, w: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The curator attaches an occurrence for the master to a draft school
    root while the master publishes it. A MEASUREMENT, like N1d: the gate
    predicted a cycle here (the publication's journal row takes KEY SHARE
    on the group the creation holds as its owner), and the old shape
    refuted it -- KEY SHARE does not conflict with the owner's lock (a
    no-op UPDATE, FOR NO KEY UPDATE): in the old shape the two never meet
    and both commit. In the fixed shape they do meet, on the parent (FOR
    SHARE against the publication's FOR UPDATE), which this asserts.

    The invariant: the publication waited for the creation; both
    committed; the root is published and the child exists, a draft of the
    school.
    """
    root = await _practice(
        db_session, w, uuid4(), hours=30, school=True, status=_DRAFT,
    )

    result = await race(
        monkeypatch,
        holder=_curators_child(w, root),
        pause_in=_GROUP_LOCK,
        pause="after",
        rival=_edit(w["mid"], root, status=_SCHEDULED),
    )
    assert_no_deadlock(result)
    assert result.rival_waited
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    child = result.holder.result
    rows = await _rows(root, child)
    assert rows[root][0] == _SCHEDULED
    assert rows[child][0] == _DRAFT
    assert rows[child][2] == w["school"]


# ===========================================================================
# N1d -- a measurement: deleting the school is not a cycle with the creation
# ===========================================================================


@pytest.mark.asyncio
async def test_n1d_curators_child_against_deleting_the_school(
    client: AsyncClient, db_session: AsyncSession, w: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The curator attaches an occurrence for the master while deleting the
    school. delete_curator_group deletes the school's member rows FIRST,
    and the creation holds the master's member row FOR SHARE: the deletion
    waits there, holding nothing the creation wants -- in the fixed shape
    and in the old one alike. Green on both is the point: the W4 report's
    inference "N1 x delete_curator_group -> 40P01" is refuted by it.

    The invariant: both committed; the deletion, which ran second, left
    the root and the newborn without a school.
    """
    root = await _practice(db_session, w, uuid4(), hours=5, school=True)

    async def delete_school(session: AsyncSession):
        await curator_service.delete_curator_group(
            w["cid"], w["school"], session,
        )

    result = await race(
        monkeypatch,
        holder=_curators_child(w, root),
        pause_in=_GROUP_LOCK,
        pause="after",
        rival=delete_school,
    )
    assert_no_deadlock(result)
    assert result.rival_waited
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    child = result.holder.result
    rows = await _rows(root, child)
    assert rows[root][2] is None
    assert rows[child][2] is None
