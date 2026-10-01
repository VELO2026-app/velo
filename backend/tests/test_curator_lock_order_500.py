# =============================================================================
# VELO -- curator_groups: the windows that answered 500 (BE-95 F1, F3-F8)
# =============================================================================
# Same harness and the same lock order as test_curator_lock_order.py (the
# order itself is written once, in the header of curator_groups/service.py).
# These are the windows whose LOUD outcome was a 500: a deadlock between a
# delete and an accept, or an FK failure escaping from a writer that read
# a school a moment before somebody deleted it.
#
# THE "DELETE IN FLIGHT" SHAPE. Several writers here (announce, a practice's
# audience, a curator's cancellation, the invite link) have no async call
# inside their window to pause at. Their window is the other way round: it
# is open while a delete of the school holds the group row and has not yet
# committed. So the delete is the holder: the real delete_curator_group
# runs, and then the test's own _delete_in_flight pauses before returning
# -- before the harness commits it. The writer runs into the locked group
# row, Postgres reports it waiting, the delete is released and commits, and
# the writer's FK check fails against a school that is gone. Nothing in the
# module is replaced or given a hook for the test.
# =============================================================================

import sys
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError, ConflictError, NotFoundError
from app.modules.curator_groups import service as curator_service
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupEvent,
    CuratorGroupMasterOffer,
    CuratorGroupMember,
    CuratorGroupTransfer,
    CuratorMemberKind,
)
from app.modules.masters.models import MasterProfile
from app.modules.practices import cancel_service
from app.modules.practices import service as practices_service
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeAudienceCuratorGroup,
    PracticeStatus,
    PracticeType,
)
from app.modules.practices.series_service import add_curator_group_audience_row
from app.modules.users.models import User, UserRole
from tests.curator_race_harness import assert_no_deadlock, race
from tests.helpers import full_cleanup_range, login_user

_TID_MIN = 69800
_TID_MAX = 69849
_TID_CURATOR = 69801
_TID_HEIR = 69802
_TID_THIRD = 69803
_TID_STUDENT = 69804

MASTER = CuratorMemberKind.MASTER.value
STUDENT = CuratorMemberKind.STUDENT.value
_THIS = sys.modules[__name__]


async def _user(client, db_session, tid: int) -> UUID:
    auth = await login_user(client, telegram_id=tid, first_name=f"U{tid}")
    user_id = UUID(auth["user"]["id"])
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={
                "account": {"status": "verified", "can_create_groups": True},
                "profile": {"bio": "m"},
            },
        )
    )
    await db_session.flush()
    await db_session.commit()
    return user_id


class School:
    id: UUID
    curator: UUID
    heir: UUID
    third: UUID
    student: UUID


async def _school(
    client, db_session, *, transfer=False, offer=False,
) -> School:
    s = School()
    s.curator = await _user(client, db_session, _TID_CURATOR)
    s.heir = await _user(client, db_session, _TID_HEIR)
    s.third = await _user(client, db_session, _TID_THIRD)
    s.student = await _user(client, db_session, _TID_STUDENT)
    group = CuratorGroup(curator_user_id=s.curator, name="Школа BE-95/2")
    db_session.add(group)
    await db_session.flush()
    s.id = group.id
    for uid, kind in (
        (s.heir, MASTER), (s.third, MASTER), (s.student, STUDENT),
    ):
        db_session.add(CuratorGroupMember(group_id=s.id, user_id=uid, kind=kind))
    if transfer:
        db_session.add(CuratorGroupTransfer(group_id=s.id, to_user_id=s.heir))
    if offer:
        db_session.add(
            CuratorGroupMasterOffer(group_id=s.id, to_user_id=s.student)
        )
    await db_session.flush()
    await db_session.commit()
    return s


async def _practice(db_session, s: School, *, addressed: bool) -> UUID:
    """A scheduled practice of the third master, addressed to the school."""
    practice = Practice(
        master_id=s.third,
        title="Практика BE-95",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=PracticeStatus.SCHEDULED.value,
        scheduled_at=datetime.now(UTC) + timedelta(hours=48),
        duration_minutes=60,
        timezone="UTC",
        max_participants=20,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        audience_kind=AudienceKind.CURATOR_GROUPS.value,
    )
    db_session.add(practice)
    await db_session.flush()
    if addressed:
        db_session.add(
            PracticeAudienceCuratorGroup(practice_id=practice.id, group_id=s.id)
        )
    await db_session.commit()
    return practice.id


async def _group(db_session, s: School) -> CuratorGroup | None:
    db_session.expire_all()
    return (
        await db_session.execute(
            select(CuratorGroup).where(CuratorGroup.id == s.id)
        )
    ).scalar_one_or_none()


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    async def _wipe() -> None:
        await full_cleanup_range(
            db_session, _TID_MIN, _TID_MAX, delete_users=True,
        )
        await db_session.commit()

    await _wipe()
    yield
    await _wipe()


async def _hold() -> None:
    """The pause point of a delete in flight: reached after the delete has
    run and before the harness commits it. Does nothing by itself."""


def _delete_in_flight(s: School):
    async def call(session):
        await curator_service.delete_curator_group(s.curator, s.id, session)
        await _THIS._hold()
    return call


async def _actor(session, user_id):
    return await session.get(User, user_id)


# =============================================================================
# F1 -- the delete of a school against the two accepts (BE-97's order)
# =============================================================================


@pytest.mark.asyncio
async def test_a_delete_waits_for_an_appointment_being_accepted(
    client, db_session, monkeypatch,
) -> None:
    """accept holds the member row and the claimed offer; delete runs in.

    ON THE OLD ORDER (claim first, member row last) THIS WAS A DEADLOCK even
    after the delete was fixed: the delete took the member row the accept
    had not locked yet, waited for the offer, and the accept then asked for
    the member row.
    """
    s = await _school(client, db_session, offer=True)

    async def accept(session):
        await curator_service.accept_curator_group_master_offer(
            s.id, s.student, session, actor=await _actor(session, s.student),
        )

    async def delete(session):
        await curator_service.delete_curator_group(s.curator, s.id, session)

    result = await race(
        monkeypatch,
        holder=accept,
        pause_in=(curator_service, "_has_master_capability"),
        rival=delete,
    )
    assert_no_deadlock(result)
    assert result.rival_waited, "the delete never met the accept's lock"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert await _group(db_session, s) is None


@pytest.mark.asyncio
async def test_a_delete_meets_a_transfer_being_accepted(
    client, db_session, monkeypatch,
) -> None:
    """accept holds the heir's member row and the claimed transfer.

    THE PAIR: the accept committed first, so by the time the delete reaches
    the group row the school is the heir's -- the delete matches nothing,
    is refused, and the school is exactly as the accept left it.
    """
    s = await _school(client, db_session, transfer=True)

    async def accept(session):
        await curator_service.accept_curator_group_transfer(
            s.id, s.heir, session, actor=await _actor(session, s.heir),
        )

    async def delete(session):
        await curator_service.delete_curator_group(s.curator, s.id, session)

    result = await race(
        monkeypatch,
        holder=accept,
        pause_in=(curator_service, "_has_master_capability"),
        rival=delete,
    )
    assert_no_deadlock(result)
    assert result.rival_waited, "the delete never met the accept's lock"
    assert result.holder.committed, result.holder.error
    assert isinstance(result.rival.error, NotFoundError), result.rival
    group = await _group(db_session, s)
    assert group is not None and group.curator_user_id == s.heir
    members = {
        uid: kind
        for uid, kind in (
            await db_session.execute(
                select(CuratorGroupMember.user_id, CuratorGroupMember.kind)
                .where(CuratorGroupMember.group_id == s.id)
            )
        ).all()
    }
    assert members == {s.curator: MASTER, s.third: MASTER, s.student: STUDENT}


# =============================================================================
# F6 -- a rename lands inside a transfer's accept
# =============================================================================


@pytest.mark.asyncio
async def test_a_rename_inside_an_accept_is_a_409_not_a_500(
    client, db_session, monkeypatch,
) -> None:
    """The school is renamed to a name the heir already uses, mid-accept.

    The accept's name check had already passed against the OLD name; the
    collision surfaced at the group row's UPDATE on UNIQUE (curator_user_id,
    name) and escaped as a 500.

    THE PAIR: refused with the module's own 409, AND nothing of the accept
    stayed -- the rename stands, the old curator owns the school, the offer
    is still there and the heir is still a member.
    """
    s = await _school(client, db_session, transfer=True)
    db_session.add(CuratorGroup(curator_user_id=s.heir, name="Новое имя"))
    await db_session.commit()

    async def rename(session):
        await curator_service.update_curator_group(
            s.curator, s.id, "Новое имя", session,
            actor=await _actor(session, s.curator),
        )

    async def accept(session):
        await curator_service.accept_curator_group_transfer(
            s.id, s.heir, session, actor=await _actor(session, s.heir),
        )

    result = await race(
        monkeypatch,
        holder=rename,
        pause_in=(curator_service, "_lock_group_as_owner"),
        pause="after",
        rival=accept,
    )
    assert_no_deadlock(result)
    assert result.rival_waited, "the accept never met the rename's lock"
    assert result.holder.committed, result.holder.error
    assert isinstance(result.rival.error, ConflictError), result.rival
    assert result.rival.error.code == "curator_group_name_taken"
    group = await _group(db_session, s)
    assert group.curator_user_id == s.curator and group.name == "Новое имя"
    pending = (
        await db_session.execute(
            select(CuratorGroupTransfer.to_user_id).where(
                CuratorGroupTransfer.group_id == s.id
            )
        )
    ).scalars().all()
    assert pending == [s.heir]
    heir_row = (
        await db_session.execute(
            select(CuratorGroupMember.kind).where(
                CuratorGroupMember.group_id == s.id,
                CuratorGroupMember.user_id == s.heir,
            )
        )
    ).scalar_one_or_none()
    assert heir_row == MASTER


# =============================================================================
# F3 / F4 / F7 / F8 -- a writer against a delete in flight
# =============================================================================


async def _against_delete(monkeypatch, s: School, rival):
    result = await race(
        monkeypatch,
        holder=_delete_in_flight(s),
        pause_in=(_THIS, "_hold"),
        rival=rival,
    )
    assert result.holder.committed, result.holder.error
    assert result.rival_waited, "the writer never met the delete's lock"
    return result


@pytest.mark.asyncio
async def test_announcing_into_a_school_being_deleted(
    client, db_session, monkeypatch,
) -> None:
    """F3: publishing a practice used to answer 500 for a deleted school."""
    s = await _school(client, db_session)
    practice_id = await _practice(db_session, s, addressed=True)

    async def announce(session):
        practice = await session.get(Practice, practice_id)
        return await curator_service.announce_published_practice(
            practice, await _actor(session, s.third), session,
        )

    result = await _against_delete(monkeypatch, s, announce)
    assert result.rival.committed, result.rival.error
    assert result.rival.result == (0, 0), "a school that is gone was announced"
    assert await _group(db_session, s) is None


@pytest.mark.asyncio
async def test_the_invite_link_of_a_school_being_deleted(
    client, db_session, monkeypatch,
) -> None:
    """F4: the invite link of a school deleted mid-request is a 404.

    On the old code the INSERT failed its FK, the failure was read as a lost
    race, and the re-read of the "winner" was scalar_one() -- NoResultFound,
    a 500. TWO THINGS NOW STAND IN THE WAY, and this test is red only when
    both are removed (measured): the ownership lock taken before the INSERT,
    which makes the request wait for the delete and then find no school;
    and scalar_one_or_none() behind it. What the second one exists for on
    its own -- a winner whose link is revoked between its commit and the
    re-read -- has no async call inside its window to pause at, so no test
    here reaches it; see the delivery report.
    """
    s = await _school(client, db_session)

    async def invite(session):
        return await curator_service.get_or_create_curator_group_invite(
            s.curator, s.id, session, actor=await _actor(session, s.curator),
        )

    monkeypatch.setattr(
        curator_service.settings, "telegram_bot_url", "https://t.me/velo_bot",
    )
    result = await _against_delete(monkeypatch, s, invite)
    assert isinstance(result.rival.error, NotFoundError), result.rival
    assert await _group(db_session, s) is None


@pytest.mark.asyncio
async def test_addressing_a_practice_to_a_school_being_deleted(
    client, db_session, monkeypatch,
) -> None:
    """F7: the audience writer refuses with the validation's own 400."""
    s = await _school(client, db_session)
    practice_id = await _practice(db_session, s, addressed=False)

    async def address(session):
        await practices_service._set_practice_audience_curator_groups(
            practice_id, [s.id], session,
        )

    result = await _against_delete(monkeypatch, s, address)
    assert isinstance(result.rival.error, BadRequestError), result.rival
    rows = (
        await db_session.execute(
            select(PracticeAudienceCuratorGroup.id).where(
                PracticeAudienceCuratorGroup.practice_id == practice_id
            )
        )
    ).all()
    assert rows == []


@pytest.mark.asyncio
async def test_a_series_row_for_a_school_being_deleted_is_skipped(
    client, db_session, monkeypatch,
) -> None:
    """F7, the series writers: the row is skipped, the request survives.

    THE PAIR: the helper reports the skip AND the same request can still
    write -- the savepoint confined the failure to the one row.
    """
    s = await _school(client, db_session)
    practice_id = await _practice(db_session, s, addressed=False)

    async def copy_row(session):
        skipped_ok = await add_curator_group_audience_row(
            practice_id, s.id, session,
        )
        practice = await session.get(Practice, practice_id)
        practice.title = "Практика BE-95, после пропуска"
        await session.flush()
        return skipped_ok

    result = await _against_delete(monkeypatch, s, copy_row)
    assert result.rival.committed, result.rival.error
    assert result.rival.result is False
    db_session.expire_all()
    practice = await db_session.get(Practice, practice_id)
    assert practice.title == "Практика BE-95, после пропуска"


@pytest.mark.asyncio
async def test_a_curator_cancelling_into_a_school_being_deleted(
    client, db_session, monkeypatch,
) -> None:
    """F8: the cancellation committed its refunds and then failed its FK.

    THE PAIR: the practice IS cancelled, and no journal row survived for a
    school that is gone.
    """
    s = await _school(client, db_session)
    practice_id = await _practice(db_session, s, addressed=True)

    async def cancel(session):
        await cancel_service.cancel_practice(
            practice_id, await _actor(session, s.curator), session,
        )

    result = await _against_delete(monkeypatch, s, cancel)
    assert result.rival.committed, result.rival.error
    db_session.expire_all()
    practice = await db_session.get(Practice, practice_id)
    assert practice.status == PracticeStatus.CANCELLED.value
    left = (
        await db_session.execute(
            select(CuratorGroupEvent.id).where(
                CuratorGroupEvent.group_id == s.id
            )
        )
    ).all()
    assert left == []
