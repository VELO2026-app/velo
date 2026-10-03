# =============================================================================
# VELO Backend -- Tests: a curator creates a practice for a master (BE-102)
# =============================================================================
#
# telegram_id band: 89140-89199. Declared module-level below as
# _TID_MIN/_TID_MAX, once (tests/telegram_id_bands.py parses it).
#
# THE GRID (owner ruling, 2026-10-01): caller (the school's curator / a
# master of the school / an outsider) x target (self / a verified master of
# THIS school / a master only of the curator's OTHER school / a student / an
# unverified master / a master member without any profile / a stranger / no
# such user) x school (named / not named). Every refusal is paired with a
# success that differs from it in ONE axis, so a refusal cannot pass because
# the fixture itself is broken.
#
# The race block puts a demotion and a removal of the target INTO the
# window between the target check and the INSERT, with the harness that
# can see a waiter (tests/curator_race_harness.py).
# =============================================================================

from collections.abc import AsyncGenerator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import AuditLog
from app.core.config import settings
from app.core.events.models import OutboxEvent
from app.modules.curator_groups import service as curator_service
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters.models import MasterProfile
from app.modules.practices import service as practice_service
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeStatus,
    PracticeType,
)
from app.modules.practices.schemas import CreatePracticeRequest
from app.modules.users.models import User, UserRole
from tests.curator_race_harness import assert_no_deadlock, race
from tests.helpers import (
    auth_headers,
    fresh_execute,
    full_cleanup_range,
    login_user,
)

PRACTICES_URL = "/api/v1/practices"

_TID_MIN = 89140
_TID_MAX = 89199

_TID_CURATOR = 89141
_TID_TARGET = 89142
_TID_OTHER_SCHOOL_MASTER = 89143
_TID_STUDENT = 89144
_TID_UNVERIFIED = 89145
_TID_NO_PROFILE = 89146
_TID_SCHOOL_MASTER = 89147
_TID_OUTSIDER = 89148

_EVENT = "practice_created_by_curator"
_TYPE = "curator_group.practice_created_for_master"
_SLOT = datetime(2031, 3, 4, 10, 0, tzinfo=UTC)


# ===========================================================================
# Helpers -- copied, not imported, as every test file in this tree does
# ===========================================================================


async def _user(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
    first_name: str, *, status: str | None, methods: list[str] | None = None,
) -> dict:
    """A logged-in user; with a master profile of `status` unless None."""
    auth = await login_user(client, telegram_id=telegram_id, first_name=first_name)
    user_id = UUID(auth["user"]["id"])
    if status is not None:
        user = await db_session.get(User, user_id)
        user.role = UserRole.MASTER
        profile: dict = {"bio": "m"}
        if methods is not None:
            profile["methods"] = methods
        db_session.add(
            MasterProfile(
                user_id=user_id,
                data={"account": {"status": status}, "profile": profile},
            )
        )
    await db_session.flush()
    await db_session.commit()
    return auth


async def _join(
    db_session: AsyncSession, group_id: UUID, user_id: str,
    kind: CuratorMemberKind,
) -> None:
    db_session.add(
        CuratorGroupMember(
            group_id=group_id, user_id=UUID(user_id), kind=kind.value,
        )
    )
    await db_session.flush()
    await db_session.commit()


@dataclass
class _S:
    curator: dict
    target: dict
    other_school_master: dict
    student: dict
    unverified: dict
    no_profile: dict
    school_master: dict
    outsider: dict
    school: UUID
    other_school: UUID

    def id(self, who: str) -> str:
        return getattr(self, who)["user"]["id"]

    def token(self, who: str) -> str:
        return getattr(self, who)["session_token"]


@pytest.fixture
async def s(client: AsyncClient, db_session: AsyncSession) -> _S:
    """Two schools of ONE curator, and one person per cell of the grid.

    The target has a confirmed method ("yoga"); the curator has none, so
    the confirmed-methods gate fails OPEN for the curator and is closed
    for the target -- which is what lets a test tell whose methods it read.
    """
    curator = await _user(client, db_session, _TID_CURATOR, "Кира", status="verified")
    target = await _user(
        client, db_session, _TID_TARGET, "Тимур", status="verified",
        methods=["yoga"],
    )
    other = await _user(
        client, db_session, _TID_OTHER_SCHOOL_MASTER, "Ольга", status="verified",
    )
    student = await _user(
        client, db_session, _TID_STUDENT, "Степан", status="verified",
    )
    unverified = await _user(
        client, db_session, _TID_UNVERIFIED, "Ульяна", status="pending",
    )
    no_profile = await _user(client, db_session, _TID_NO_PROFILE, "Нина", status=None)
    school_master = await _user(
        client, db_session, _TID_SCHOOL_MASTER, "Марк", status="verified",
    )
    outsider = await _user(
        client, db_session, _TID_OUTSIDER, "Павел", status="verified",
    )
    curator_id = UUID(curator["user"]["id"])
    school = CuratorGroup(curator_user_id=curator_id, name="Школа А")
    other_school = CuratorGroup(curator_user_id=curator_id, name="Школа Б")
    db_session.add_all([school, other_school])
    await db_session.flush()
    await db_session.commit()
    master = CuratorMemberKind.MASTER
    await _join(db_session, school.id, target["user"]["id"], master)
    await _join(db_session, school.id, unverified["user"]["id"], master)
    await _join(db_session, school.id, no_profile["user"]["id"], master)
    await _join(db_session, school.id, school_master["user"]["id"], master)
    await _join(
        db_session, school.id, student["user"]["id"], CuratorMemberKind.STUDENT,
    )
    await _join(db_session, other_school.id, other["user"]["id"], master)
    return _S(
        curator=curator, target=target, other_school_master=other,
        student=student, unverified=unverified, no_profile=no_profile,
        school_master=school_master, outsider=outsider,
        school=school.id, other_school=other_school.id,
    )


def _body(**overrides) -> dict:
    base: dict = {
        "practice_type": "live",
        "direction": "yoga",
        "difficulty": "beginner",
        "title": "Утренняя практика",
        "description": "x",
        "scheduled_at": _SLOT.isoformat(),
        "duration_minutes": 60,
        "timezone": "UTC",
        "max_participants": 20,
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
        "audience_kind": AudienceKind.PUBLIC.value,
    }
    base.update(overrides)
    return base


async def _post(client: AsyncClient, token: str, **overrides):
    return await client.post(
        PRACTICES_URL, json=_body(**overrides), headers=auth_headers(token),
    )


async def _practices_of(user_id: str) -> list[Practice]:
    return list(
        (
            await fresh_execute(
                select(Practice).where(Practice.master_id == UUID(user_id))
            )
        ).scalars().all()
    )


async def _audit_rows(practice_id: str) -> list[AuditLog]:
    return list(
        (
            await fresh_execute(
                select(AuditLog).where(
                    AuditLog.event == _EVENT,
                    AuditLog.target_id == UUID(practice_id),
                )
            )
        ).scalars().all()
    )


async def _notifications_to(user_id: str) -> list[OutboxEvent]:
    return list(
        (
            await fresh_execute(
                select(OutboxEvent).where(
                    OutboxEvent.payload["type"].astext == _TYPE,
                    OutboxEvent.payload["target_value"].astext == user_id,
                )
            )
        ).scalars().all()
    )


async def _seed_practice(
    master_id: str, school: UUID | None, *, status: str = PracticeStatus.DRAFT.value,
    parent_id: UUID | None = None, practice_type: str = PracticeType.LIVE.value,
) -> UUID:
    """A practice written straight to the DB, on the slot _body() uses."""
    from app.core.database import get_session_factory

    async with get_session_factory()() as session:
        practice = Practice(
            master_id=UUID(master_id),
            title="Утренняя практика",
            description="x",
            practice_type=practice_type,
            status=status,
            scheduled_at=_SLOT,
            duration_minutes=60,
            timezone="UTC",
            max_participants=20,
            current_participants=0,
            is_free=True,
            price_cents=0,
            currency="eur",
            audience_kind=AudienceKind.PUBLIC.value,
            curator_group_id=school,
            parent_practice_id=parent_id,
        )
        session.add(practice)
        await session.commit()
        return practice.id


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ===========================================================================
# 1. The one success, and what it writes
# ===========================================================================


@pytest.mark.asyncio
async def test_curator_creates_a_draft_led_by_a_master_of_the_school(
    client, s: _S,
) -> None:
    """The practice is the TARGET's, in the school, a draft; the curator is
    the audit actor; the master is told. Each write is checked present
    AND non-empty, not just "no error"."""
    resp = await _post(
        client, s.token("curator"),
        master_id=s.id("target"), curator_group_id=str(s.school),
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["master_id"] == s.id("target")
    assert data["master_name"] == "Тимур"
    assert data["curator_group_id"] == str(s.school)
    assert data["status"] == PracticeStatus.DRAFT.value
    assert data["deduplicated"] is False
    assert data["zoom_host_join_url"] is None
    assert await _practices_of(s.id("curator")) == []

    audits = await _audit_rows(data["id"])
    assert len(audits) == 1
    assert audits[0].actor_id == UUID(s.id("curator"))
    assert audits[0].data == {
        "group_id": str(s.school), "master_id": s.id("target"),
    }

    notes = await _notifications_to(s.id("target"))
    assert len(notes) == 1
    payload = notes[0].payload
    assert payload["idempotency_key"] == f"practice-created-by-curator:{data['id']}"
    action = payload["action_data"]
    assert action["action"] == "open_practice"
    assert action["params"] == {"practice_id": data["id"]}
    assert action["group_name"] == "Школа А"
    assert action["actor_name"] == "Кира"
    assert action["practice_title"] == "Утренняя практика"
    assert action["scheduled_at"]


@pytest.mark.asyncio
@pytest.mark.parametrize("own", ["absent", "null", "own_id"])
async def test_own_practice_paths_write_no_audit_and_no_notification(
    client, s: _S, own: str,
) -> None:
    """POVTOR / PUSTOTA of master_id: absent, null and the caller's own id
    all mean "mine" -- with or without a school -- and none of them is the
    curator acting for somebody, so nothing is audited or announced."""
    extra: dict = {}
    if own == "null":
        extra["master_id"] = None
    elif own == "own_id":
        extra["master_id"] = s.id("curator")
    resp = await _post(client, s.token("curator"), **extra)
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["master_id"] == s.id("curator")
    assert data["master_name"] == "Кира"
    assert await _audit_rows(data["id"]) == []
    assert await _notifications_to(s.id("curator")) == []


# ===========================================================================
# 2. Refusals -- each with its one-axis success above or beside it
# ===========================================================================


@pytest.mark.asyncio
async def test_another_master_without_a_school_is_refused(client, s: _S) -> None:
    resp = await _post(client, s.token("curator"), master_id=s.id("target"))
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"] == "master_id_requires_school"
    assert await _practices_of(s.id("target")) == []


@pytest.mark.asyncio
async def test_a_master_of_the_curators_other_school_is_refused_here(
    client, s: _S,
) -> None:
    """The curator of A and B cannot use A for a master who is only in B
    -- and CAN use B for them, so the refusal is about the school."""
    refused = await _post(
        client, s.token("curator"),
        master_id=s.id("other_school_master"), curator_group_id=str(s.school),
    )
    assert refused.status_code == 400, refused.text
    assert refused.json()["error"] == "master_not_in_school"

    allowed = await _post(
        client, s.token("curator"),
        master_id=s.id("other_school_master"),
        curator_group_id=str(s.other_school),
    )
    assert allowed.status_code == 201, allowed.text
    assert allowed.json()["master_id"] == s.id("other_school_master")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "who", ["student", "unverified", "no_profile", "outsider", "nobody"],
)
async def test_every_unfit_target_gets_one_and_the_same_refusal(
    client, s: _S, who: str,
) -> None:
    """A student (verified, but kind='student'), an unverified kind='master'
    member, a kind='master' member with no profile at all, a verified
    stranger, a user id that does not exist: one code for all, so the
    answer never says which of them an id is."""
    target = str(uuid4()) if who == "nobody" else s.id(who)
    resp = await _post(
        client, s.token("curator"),
        master_id=target, curator_group_id=str(s.school),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"] == "master_not_in_school"
    if who != "nobody":
        assert await _practices_of(target) == []


@pytest.mark.asyncio
async def test_a_master_of_the_school_is_not_its_curator(client, s: _S) -> None:
    """403 curator_only -- and the same caller may still create their own
    practice in the school (BE-74), so the 403 is about the delegation."""
    refused = await _post(
        client, s.token("school_master"),
        master_id=s.id("target"), curator_group_id=str(s.school),
    )
    assert refused.status_code == 403, refused.text
    assert refused.json()["error"] == "curator_only"

    own = await _post(
        client, s.token("school_master"), curator_group_id=str(s.school),
    )
    assert own.status_code == 201, own.text


@pytest.mark.asyncio
async def test_an_outsider_cannot_tell_the_school_exists(client, s: _S) -> None:
    """Same refusal as for a school that does not exist."""
    real = await _post(
        client, s.token("outsider"),
        master_id=s.id("target"), curator_group_id=str(s.school),
    )
    missing = await _post(
        client, s.token("outsider"),
        master_id=s.id("target"), curator_group_id=str(uuid4()),
    )
    assert real.status_code == missing.status_code == 400, real.text
    assert real.json() == missing.json()
    # FE-92 follow-up: one code for both -- still indistinguishable.
    assert real.json()["error"] == "curator_group_not_usable"


@pytest.mark.asyncio
async def test_the_killswitch_refuses_the_delegation(client, s: _S) -> None:
    with patch.object(settings, "curator_groups_enabled", False):
        off = await _post(
            client, s.token("curator"),
            master_id=s.id("target"), curator_group_id=str(s.school),
        )
    assert off.status_code == 400, off.text
    assert off.json()["error"] == "curator_group_not_usable"
    assert await _practices_of(s.id("target")) == []
    on = await _post(
        client, s.token("curator"),
        master_id=s.id("target"), curator_group_id=str(s.school),
    )
    assert on.status_code == 201, on.text


# ===========================================================================
# 3. Whose practice: methods, dedup, parent
# ===========================================================================


@pytest.mark.asyncio
async def test_the_targets_confirmed_methods_decide_not_the_curators(
    client, s: _S,
) -> None:
    """The curator's methods are empty (the gate fails open for them); the
    target is confirmed for yoga only. Meditation for the target must be
    refused -- read with the curator's id it would pass."""
    refused = await _post(
        client, s.token("curator"), direction="meditation",
        master_id=s.id("target"), curator_group_id=str(s.school),
    )
    assert refused.status_code == 400, refused.text
    assert refused.json()["error"] == "direction_not_confirmed"
    allowed = await _post(
        client, s.token("curator"), direction="yoga",
        master_id=s.id("target"), curator_group_id=str(s.school),
    )
    assert allowed.status_code == 201, allowed.text


@pytest.mark.asyncio
async def test_dedup_is_by_the_master_and_announces_nothing_new(
    client, s: _S,
) -> None:
    """The target already holds this slot in the school: the curator's
    request returns THAT practice (the slot is the master's), writes no
    audit and no notification -- nothing new was created."""
    existing = await _seed_practice(s.id("target"), s.school)
    resp = await _post(
        client, s.token("curator"),
        master_id=s.id("target"), curator_group_id=str(s.school),
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["id"] == str(existing)
    assert data["deduplicated"] is True
    assert data["master_name"] == "Тимур"
    assert data["zoom_host_join_url"] is None
    assert await _audit_rows(data["id"]) == []
    assert await _notifications_to(s.id("target")) == []
    assert len(await _practices_of(s.id("target"))) == 1


@pytest.mark.asyncio
async def test_the_masters_slot_outside_the_school_is_a_conflict(
    client, s: _S,
) -> None:
    await _seed_practice(s.id("target"), None)
    resp = await _post(
        client, s.token("curator"),
        master_id=s.id("target"), curator_group_id=str(s.school),
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"] == "practice_exists_in_other_school"


@pytest.mark.asyncio
async def test_no_existing_practice_is_handed_over_before_the_checks(
    client, s: _S,
) -> None:
    """A non-curator naming the target and the target's exact slot gets
    the 403, not the target's practice: authorization runs before the
    windowed dedup."""
    existing = await _seed_practice(s.id("target"), s.school)
    resp = await _post(
        client, s.token("school_master"),
        master_id=s.id("target"), curator_group_id=str(s.school),
    )
    assert resp.status_code == 403, resp.text
    assert str(existing) not in resp.text


@pytest.mark.asyncio
async def test_a_series_child_attaches_to_the_masters_root(client, s: _S) -> None:
    """The child of a series gets the same master as its root; the root
    must be the TARGET's, and the curator's own root is refused."""
    series = PracticeType.SERIES.value
    root = await _seed_practice(s.id("target"), s.school, practice_type=series)
    child = await _post(
        client, s.token("curator"), practice_type=series,
        scheduled_at=(_SLOT + timedelta(days=7)).isoformat(),
        parent_practice_id=str(root),
        master_id=s.id("target"), curator_group_id=str(s.school),
    )
    assert child.status_code == 201, child.text
    assert child.json()["master_id"] == s.id("target")
    assert child.json()["parent_practice_id"] == str(root)

    own_root = await _seed_practice(s.id("curator"), s.school, practice_type=series)
    refused = await _post(
        client, s.token("curator"), practice_type=series,
        scheduled_at=(_SLOT + timedelta(days=14)).isoformat(),
        parent_practice_id=str(own_root),
        master_id=s.id("target"), curator_group_id=str(s.school),
    )
    assert refused.status_code == 400, refused.text


# ===========================================================================
# 4. The target losing their place mid-create
# ===========================================================================


def _create_call(s: _S):
    body = CreatePracticeRequest(
        **_body(master_id=s.id("target"), curator_group_id=str(s.school)),
    )

    async def call(session: AsyncSession):
        user = await session.get(User, UUID(s.id("curator")))
        return await practice_service.create_practice(user, body, session)
    return call


def _demote_call(s: _S):
    async def call(session: AsyncSession):
        await curator_service.demote_curator_group_master(
            UUID(s.id("curator")), s.school, UUID(s.id("target")), session,
            actor=await session.get(User, UUID(s.id("curator"))),
        )
    return call


def _remove_call(s: _S):
    async def call(session: AsyncSession):
        await curator_service.remove_curator_group_member(
            UUID(s.id("curator")), s.school, UUID(s.id("target")), session,
            actor=await session.get(User, UUID(s.id("curator"))),
        )
    return call


async def _target_kind(s: _S) -> str | None:
    return (
        await fresh_execute(
            select(CuratorGroupMember.kind).where(
                CuratorGroupMember.group_id == s.school,
                CuratorGroupMember.user_id == UUID(s.id("target")),
            )
        )
    ).scalar_one_or_none()


@pytest.mark.asyncio
@pytest.mark.parametrize("rival", ["demote", "remove"])
async def test_the_target_cannot_leave_between_the_check_and_the_insert(
    s: _S, monkeypatch, rival: str,
) -> None:
    """The create is paused after the target check, before the dedup and
    the INSERT; the demotion / removal starts then. It must WAIT on the
    member row the create holds, so the practice is born while the target
    is still a master of the school, and the rival then lands on top.

    Without the lock the rival commits inside the pause and the practice
    is born for somebody who is no longer a master here: rival_waited is
    False and the order below is reversed."""
    result = await race(
        monkeypatch,
        holder=_create_call(s),
        pause_in=(practice_service, "_find_recent_duplicate_practice"),
        rival=_demote_call(s) if rival == "demote" else _remove_call(s),
    )
    assert_no_deadlock(result)
    assert result.rival_waited is True
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    practices = await _practices_of(s.id("target"))
    assert [p.curator_group_id for p in practices] == [s.school]
    expected = CuratorMemberKind.STUDENT.value if rival == "demote" else None
    assert await _target_kind(s) == expected


@pytest.mark.asyncio
async def test_a_target_demoted_before_the_create_is_refused(
    client, s: _S,
) -> None:
    from app.core.database import get_session_factory

    async with get_session_factory()() as session:
        await _demote_call(s)(session)
        await session.commit()
    assert await _target_kind(s) == CuratorMemberKind.STUDENT.value
    resp = await _post(
        client, s.token("curator"),
        master_id=s.id("target"), curator_group_id=str(s.school),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"] == "master_not_in_school"
