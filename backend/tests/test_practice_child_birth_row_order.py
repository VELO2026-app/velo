# =============================================================================
# A series child born by path A (create_practice with parent_practice_id)
# in the PRACTICE ROW ORDER -- BE-103 W-a (and what became of N1).
# =============================================================================
#
#   Wa1  own child of a 'groups' root  x the root switched groups -> public
#   Wa2  own child of a public root    x the root switched public -> students
#   N1   a curator cannot add a child for a master at all (owner, 3
#        October) -- refused before anything is read; no race left to run
#
# W-a (Wa1/Wa2) is not a deadlock pair: it measures the missing lock. The
# child is paused right after its parent is validated
# (_owned_root_parent_or_400); without the lock the edit commits into that
# window and the child inherits a mix of two states of its parent -- the
# kind it read and the group rows it copies after its INSERT.
#
# N1 (BE-102 publish, owner 3 October): N1a-d raced a CURATOR'S child for
# a master against an audience edit, a series cancellation, the root's
# publication and the school's deletion -- the parent-before-group order of
# BE-103. That child no longer exists: a curator creates for a master only
# a standalone practice or a series root (both born published), and
# parent_practice_id on that path is refused first, before any row is read
# or locked. N1b showed why: a child born published outlived a series
# cancellation that was already waiting on its parent. So there is no
# lock order left to measure here -- the four races are replaced by one
# test of the refusal.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session_factory
from app.core.exceptions import BadRequestError, ConflictError
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters.groups_models import MasterGroup
from app.modules.masters.models import MasterProfile
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

_PUBLIC = AudienceKind.PUBLIC.value
_GROUPS = AudienceKind.GROUPS.value
_STUDENTS = AudienceKind.STUDENTS.value
_SCHOOL_AUDIENCE = AudienceKind.CURATOR_GROUPS.value


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
# N1 -- a curator cannot add an occurrence for a master (owner, 3 October)
# ===========================================================================


@pytest.mark.asyncio
async def test_n1_a_curator_adding_an_occurrence_for_a_master_is_refused(
    client: AsyncClient,
    db_session: AsyncSession,
    w: dict,
) -> None:
    """parent_practice_id + master_id from a curator -> 400
    curator_cannot_add_occurrence, and no practice appears.

    Replaces N1a-d (curator's child x audience edit / series cancellation /
    root publication / school deletion): those pinned a child the owner's
    3 October ruling removed -- the curator creates only a standalone
    practice or a root for a master, born published, so the races have no
    holder to run. THE PAIR: the master's own, otherwise identical request
    for the same root creates the child.
    """
    root = await _practice(db_session, w, uuid4(), hours=30, school=True)

    async with get_session_factory()() as session:
        curator = await session.get(User, w["cid"])
        with pytest.raises(BadRequestError) as refused:
            await practice_service.create_practice(
                curator,
                _child_body(root, master_id=w["mid"], curator_group_id=w["school"]),
                session,
            )
        await session.rollback()
    assert refused.value.code == "curator_cannot_add_occurrence"
    children = (
        await fresh_execute(
            select(Practice.id).where(Practice.parent_practice_id == root)
        )
    ).all()
    assert children == []

    async with get_session_factory()() as session:
        master = await session.get(User, w["mid"])
        child, deduped = await practice_service.create_practice(
            master,
            _child_body(root),
            session,
        )
        await session.commit()
    assert not deduped
    assert child.parent_practice_id == root
