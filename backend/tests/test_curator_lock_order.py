# =============================================================================
# VELO -- curator_groups: one lock order, and the windows it closes (BE-95)
# =============================================================================
# The module's lock order is written once, in the header of
# app/modules/curator_groups/service.py. Every test here puts two real
# service calls in flight at once through tests/curator_race_harness.py:
# the holder is paused inside its window by wrapping a real function, the
# rival runs into it, and the holder is released. THE ASSERTION IS AN
# INVARIANT, not a winner, and each one carries its pair: not only "the
# transition did not happen" but "the row the rival left is exactly as the
# rival left it".
#
# Two families:
#
#   silent windows (T1-T8) -- two 2xx answers whose combined result matches
#     no order in which the two requests could have run one after the other;
#   deadlocks (F2) -- the delete of a school against a writer holding one of
#     its child rows; before the fix one of the two answered 500.
# =============================================================================

from collections.abc import AsyncGenerator
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError
from app.modules.curator_groups import service as curator_service
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupEvent,
    CuratorGroupEventKind,
    CuratorGroupInvite,
    CuratorGroupMasterOffer,
    CuratorGroupMember,
    CuratorGroupTransfer,
    CuratorMemberKind,
)
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from tests.curator_race_harness import assert_no_deadlock, race
from tests.helpers import full_cleanup_range, login_user

_TID_MIN = 69850
_TID_MAX = 69899
_TID_CURATOR = 69851
_TID_HEIR = 69852  # a master member, the addressee of the transfer
_TID_THIRD = 69853  # another master member
_TID_STUDENT = 69854
_TID_JOINER = 69855

MASTER = CuratorMemberKind.MASTER.value
STUDENT = CuratorMemberKind.STUDENT.value


async def _user(client, db_session, tid: int, *, master: bool) -> UUID:
    auth = await login_user(client, telegram_id=tid, first_name=f"U{tid}")
    user_id = UUID(auth["user"]["id"])
    if master:
        user = await db_session.get(User, user_id)
        user.role = UserRole.MASTER
        db_session.add(
            MasterProfile(
                user_id=user_id,
                data={
                    "account": {
                        "status": "verified",
                        "can_create_groups": True,
                    },
                    "profile": {"bio": "m"},
                },
            )
        )
        await db_session.flush()
    await db_session.commit()
    return user_id


class School:
    """A school with a curator, two master members and a student."""

    def __init__(self) -> None:
        self.id: UUID
        self.curator: UUID
        self.heir: UUID
        self.third: UUID
        self.student: UUID
        self.joiner: UUID
        self.token = "be95-invite-token"


async def _school(
    client: AsyncClient,
    db_session: AsyncSession,
    *,
    transfer_to_heir: bool = False,
    offer_to_student: bool = False,
    invite: bool = False,
) -> School:
    s = School()
    s.curator = await _user(client, db_session, _TID_CURATOR, master=True)
    s.heir = await _user(client, db_session, _TID_HEIR, master=True)
    s.third = await _user(client, db_session, _TID_THIRD, master=True)
    s.student = await _user(client, db_session, _TID_STUDENT, master=True)
    s.joiner = await _user(client, db_session, _TID_JOINER, master=False)
    group = CuratorGroup(curator_user_id=s.curator, name="Школа BE-95")
    db_session.add(group)
    await db_session.flush()
    s.id = group.id
    for uid, kind in (
        (s.heir, MASTER), (s.third, MASTER), (s.student, STUDENT),
    ):
        db_session.add(CuratorGroupMember(group_id=s.id, user_id=uid, kind=kind))
    if transfer_to_heir:
        db_session.add(CuratorGroupTransfer(group_id=s.id, to_user_id=s.heir))
    if offer_to_student:
        db_session.add(
            CuratorGroupMasterOffer(group_id=s.id, to_user_id=s.student)
        )
    if invite:
        db_session.add(CuratorGroupInvite(group_id=s.id, token=s.token))
    await db_session.flush()
    await db_session.commit()
    return s


async def _actor(session: AsyncSession, user_id: UUID) -> User:
    return await session.get(User, user_id)


async def _group(db_session: AsyncSession, s: School) -> CuratorGroup | None:
    db_session.expire_all()
    return (
        await db_session.execute(
            select(CuratorGroup).where(CuratorGroup.id == s.id)
        )
    ).scalar_one_or_none()


async def _members(db_session: AsyncSession, s: School) -> dict[UUID, str]:
    rows = (
        await db_session.execute(
            select(CuratorGroupMember.user_id, CuratorGroupMember.kind).where(
                CuratorGroupMember.group_id == s.id
            )
        )
    ).all()
    return {uid: kind for uid, kind in rows}


async def _offers(db_session: AsyncSession, s: School) -> list[UUID]:
    return list(
        (
            await db_session.execute(
                select(CuratorGroupMasterOffer.to_user_id).where(
                    CuratorGroupMasterOffer.group_id == s.id
                )
            )
        ).scalars()
    )


async def _transfers(db_session: AsyncSession, s: School) -> list[UUID]:
    return list(
        (
            await db_session.execute(
                select(CuratorGroupTransfer.to_user_id).where(
                    CuratorGroupTransfer.group_id == s.id
                )
            )
        ).scalars()
    )


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


# -- the callables, one per writer --------------------------------------------


def _delete(s: School):
    async def call(session):
        await curator_service.delete_curator_group(s.curator, s.id, session)
    return call


def _remove(s: School, user_id: UUID):
    async def call(session):
        await curator_service.remove_curator_group_member(
            s.curator, s.id, user_id, session,
            actor=await _actor(session, s.curator),
        )
    return call


def _leave(s: School, user_id: UUID):
    async def call(session):
        await curator_service.leave_curator_group(
            s.id, user_id, session, actor=await _actor(session, user_id),
        )
    return call


def _decline_master(s: School):
    async def call(session):
        await curator_service.decline_curator_group_master_offer(
            s.id, s.student, session, actor=await _actor(session, s.student),
        )
    return call


def _accept_master(s: School):
    async def call(session):
        await curator_service.accept_curator_group_master_offer(
            s.id, s.student, session, actor=await _actor(session, s.student),
        )
    return call


def _offer_master(s: School):
    async def call(session):
        await curator_service.offer_curator_group_master(
            s.curator, s.id, s.student, session,
            actor=await _actor(session, s.curator),
        )
    return call


def _accept_transfer(s: School):
    async def call(session):
        await curator_service.accept_curator_group_transfer(
            s.id, s.heir, session, actor=await _actor(session, s.heir),
        )
    return call


def _offer_transfer(s: School, by: UUID, to: UUID):
    async def call(session):
        await curator_service.offer_curator_group_transfer(
            by, s.id, to, session, actor=await _actor(session, by),
        )
    return call


def _cancel_transfer(s: School):
    async def call(session):
        await curator_service.cancel_curator_group_transfer(
            s.curator, s.id, session, actor=await _actor(session, s.curator),
        )
    return call


def _join(s: School):
    async def call(session):
        return await curator_service.join_curator_group_by_token(
            s.token, s.joiner, session, actor=await _actor(session, s.joiner),
        )
    return call


def _rename(s: School, name: str):
    async def call(session):
        await curator_service.update_curator_group(
            s.curator, s.id, name, session,
            actor=await _actor(session, s.curator),
        )
    return call


# =============================================================================
# F2 -- the delete of a school against a writer holding one of its children
# =============================================================================


@pytest.mark.asyncio
async def test_a_delete_waits_for_a_removal_instead_of_deadlocking(
    client, db_session, monkeypatch,
) -> None:
    """remove holds the member row; the delete of the school runs into it.

    ON THE OLD ORDER THIS WAS A DEADLOCK: the delete locked the group and
    cascaded into the member row the removal held, the removal then wrote
    its journal event and asked for the group. Measured on raw SQL before
    the fix; here the mutation (the cascade-only delete) turns this red.

    THE PAIR: the removal committed AND the delete committed after it --
    the student is gone, and so is everything else of the school.
    """
    s = await _school(client, db_session, offer_to_student=True)
    result = await race(
        monkeypatch,
        holder=_remove(s, s.student),
        pause_in=(curator_service, "_drop_pending_transfer_for"),
        rival=_delete(s),
    )
    assert_no_deadlock(result)
    assert result.rival_waited, "the delete never met the removal's lock"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert await _group(db_session, s) is None


@pytest.mark.asyncio
async def test_a_delete_waits_for_a_declined_appointment(
    client, db_session, monkeypatch,
) -> None:
    """decline holds the offer row; the delete runs into it.

    The same deadlock through a different child: the decline took the
    offer, the cascade reached the offer last and waited, the decline's
    journal event asked for the group.
    """
    s = await _school(client, db_session, offer_to_student=True)
    result = await race(
        monkeypatch,
        holder=_decline_master(s),
        pause_in=(curator_service, "_frozen_name"),
        rival=_delete(s),
    )
    assert_no_deadlock(result)
    assert result.rival_waited, "the delete never met the decline's lock"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert await _group(db_session, s) is None


# =============================================================================
# T5 / ПОВТОР -- the delete by owner
# =============================================================================


@pytest.mark.asyncio
async def test_a_curator_who_handed_the_school_over_cannot_delete_it(
    client, db_session, monkeypatch,
) -> None:
    """The heir accepts while the old curator's delete is in its window.

    ON THE OLD CODE BOTH ANSWERED SUCCESS and the school was gone: the
    delete matched by id alone, after the accept had committed, answered
    200 and notified the old curator that the school was handed over.

    THE PAIR: the delete is refused AND the school is exactly as the accept
    left it -- the heir owns it, is no longer a member of it, the old
    curator is a master of it, nobody else moved.
    """
    s = await _school(client, db_session, transfer_to_heir=True)
    result = await race(
        monkeypatch,
        holder=_delete(s),
        pause_in=(curator_service, "_get_group_or_404"),
        pause="after",
        rival=_accept_transfer(s),
    )
    assert result.rival.committed, result.rival.error
    assert isinstance(result.holder.error, NotFoundError), result.holder
    group = await _group(db_session, s)
    assert group is not None, "the old curator deleted the heir's school"
    assert group.curator_user_id == s.heir
    assert await _members(db_session, s) == {
        s.curator: MASTER, s.third: MASTER, s.student: STUDENT,
    }


@pytest.mark.asyncio
async def test_two_deletes_of_one_school_give_one_success(
    client, db_session, monkeypatch,
) -> None:
    """ПОВТОР: the same curator deletes from two tabs.

    The second is answered 404 -- what it would get one after the other --
    where the old ORM delete matched nothing, warned, and answered 204.
    """
    s = await _school(client, db_session)
    result = await race(
        monkeypatch,
        holder=_delete(s),
        pause_in=(curator_service, "_get_group_or_404"),
        pause="after",
        rival=_delete(s),
    )
    assert result.rival.committed, result.rival.error
    assert isinstance(result.holder.error, NotFoundError), result.holder
    assert await _group(db_session, s) is None


@pytest.mark.asyncio
async def test_deleting_a_school_with_no_children(client, db_session) -> None:
    """ПУСТОТА: nothing to delete but the group -- still one clean delete."""
    curator = await _user(client, db_session, _TID_CURATOR, master=True)
    group = CuratorGroup(curator_user_id=curator, name="Пустая BE-95")
    db_session.add(group)
    await db_session.commit()
    group_id = group.id
    await curator_service.delete_curator_group(curator, group_id, db_session)
    await db_session.commit()
    db_session.expire_all()
    assert await db_session.get(CuratorGroup, group_id) is None


# =============================================================================
# T1 / T2 -- an appointment and the membership it changes
# =============================================================================


@pytest.mark.asyncio
async def test_an_appointment_cannot_outlive_the_membership(
    client, db_session, monkeypatch,
) -> None:
    """The student leaves while the curator is appointing them.

    ON THE OLD CODE THE OFFER SURVIVED THE PERSON: the leave found no offer
    yet to take with it and committed; the offer was written after it,
    addressed to a non-member, and would have been acceptable the day they
    re-joined -- an appointment GT-27 deletes at the source precisely so it
    cannot outlive the membership.

    THE PAIR: the leave left no member row AND no offer for that person.
    """
    s = await _school(client, db_session)
    result = await race(
        monkeypatch,
        holder=_offer_master(s),
        pause_in=(curator_service, "_master_offer_row"),
        rival=_leave(s, s.student),
    )
    assert_no_deadlock(result)
    assert result.rival_waited, "the leave never met the offer's lock"
    assert result.rival.committed, result.rival.error
    members = await _members(db_session, s)
    assert s.student not in members
    assert await _offers(db_session, s) == [], "an offer to a non-member"


@pytest.mark.asyncio
async def test_reoffering_to_somebody_who_just_accepted(
    client, db_session, monkeypatch,
) -> None:
    """The curator re-sends the appointment as the student accepts it.

    ON THE OLD CODE a fresh offer was written to somebody who had just
    become a master, with a fresh notification, and a second accept would
    have recorded the promotion twice.

    THE PAIR: the re-send is the honest 409 AND the accept's result stands
    -- a master, and no offer left behind.

    THE PAUSE SITS ON _membership_row SINCE BE-59, and the window is the
    same one. It sat on _has_master_capability, which the offer used to
    call right after reading the membership and before locking it; BE-59
    moved that read past the member lock (under the profile's FOR SHARE),
    where a pause would hold the member row and test a different race.
    _membership_row's first call is the read this window starts from.
    """
    s = await _school(client, db_session, offer_to_student=True)
    result = await race(
        monkeypatch,
        holder=_offer_master(s),
        pause_in=(curator_service, "_membership_row"),
        pause="after",
        rival=_accept_master(s),
    )
    assert result.rival.committed, result.rival.error
    assert isinstance(result.holder.error, ConflictError), result.holder
    assert result.holder.error.code == "already_master"
    assert (await _members(db_session, s))[s.student] == MASTER
    assert await _offers(db_session, s) == []


# =============================================================================
# T3 / T4 -- a transfer offer and what it is addressed to
# =============================================================================


@pytest.mark.asyncio
async def test_a_transfer_cannot_be_offered_to_somebody_who_just_left(
    client, db_session, monkeypatch,
) -> None:
    """The addressee leaves between the roster read and the INSERT."""
    s = await _school(client, db_session)
    result = await race(
        monkeypatch,
        holder=_offer_transfer(s, s.curator, s.third),
        pause_in=(curator_service, "_visible_master_ids"),
        pause="after",
        rival=_leave(s, s.third),
    )
    assert result.rival.committed, result.rival.error
    assert isinstance(result.holder.error, NotFoundError), result.holder
    assert result.holder.error.code == "transfer_target_not_member"
    assert await _transfers(db_session, s) == []
    assert s.third not in await _members(db_session, s)


@pytest.mark.asyncio
async def test_a_transfer_offered_while_the_addressee_leaves(
    client, db_session, monkeypatch,
) -> None:
    """Both in flight: the offer holds the addressee's row, the leave waits.

    THE PAIR: the leave committed after the offer and took it with it --
    no member row and no transfer to them.
    """
    s = await _school(client, db_session)
    result = await race(
        monkeypatch,
        holder=_offer_transfer(s, s.curator, s.third),
        pause_in=(curator_service, "_lock_member"),
        pause="after",
        rival=_leave(s, s.third),
    )
    assert_no_deadlock(result)
    assert result.rival_waited, "the leave never met the offer's lock"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert await _transfers(db_session, s) == [], "a transfer to a non-member"
    assert s.third not in await _members(db_session, s)


@pytest.mark.asyncio
async def test_a_former_curator_cannot_offer_the_school_away(
    client, db_session, monkeypatch,
) -> None:
    """The heir accepts between the old curator's two reads.

    ON THE OLD CODE the pending check then saw nothing and the old curator
    offered the heir's school to a third person, who could have taken it.

    THE PAIR: refused AND the school is the heir's with nothing pending.
    """
    s = await _school(client, db_session, transfer_to_heir=True)
    result = await race(
        monkeypatch,
        holder=_offer_transfer(s, s.curator, s.third),
        pause_in=(curator_service, "_pending_transfer"),
        rival=_accept_transfer(s),
    )
    assert result.rival.committed, result.rival.error
    assert isinstance(result.holder.error, NotFoundError), result.holder
    assert (await _group(db_session, s)).curator_user_id == s.heir
    assert await _transfers(db_session, s) == []


@pytest.mark.asyncio
async def test_a_former_curator_cannot_withdraw_the_new_owners_offer(
    client, db_session, monkeypatch,
) -> None:
    """T8: the heir accepts and offers the school on, mid-cancel.

    Reachable only while the old curator's request stalls for two of the
    heir's -- rare, and the same mechanism as the delete above.
    """
    s = await _school(client, db_session, transfer_to_heir=True)

    async def accept_then_offer_on(session):
        await _accept_transfer(s)(session)
        await session.commit()
        await _offer_transfer(s, s.heir, s.third)(session)

    result = await race(
        monkeypatch,
        holder=_cancel_transfer(s),
        pause_in=(curator_service, "_get_group_or_404"),
        pause="after",
        rival=accept_then_offer_on,
    )
    assert result.rival.committed, result.rival.error
    assert isinstance(result.holder.error, NotFoundError), result.holder
    assert await _transfers(db_session, s) == [s.third]


# =============================================================================
# T6 -- joining a school that is deleted mid-join
# =============================================================================


@pytest.mark.asyncio
async def test_joining_a_school_deleted_mid_join_is_not_a_success(
    client, db_session, monkeypatch,
) -> None:
    """The FK refusal used to be read as a lost race: 200 "student"."""
    s = await _school(client, db_session, invite=True)
    result = await race(
        monkeypatch,
        holder=_join(s),
        pause_in=(curator_service, "_membership_row"),
        rival=_delete(s),
    )
    assert result.rival.committed, result.rival.error
    assert isinstance(result.holder.error, NotFoundError), result.holder
    assert result.holder.error.code == "invite_not_found"
    assert await _group(db_session, s) is None


# =============================================================================
# T7 / F5 -- the edit of a school
# =============================================================================


async def _renames(db_session: AsyncSession, s: School) -> list[tuple]:
    rows = (
        await db_session.execute(
            select(CuratorGroupEvent.data)
            .where(
                CuratorGroupEvent.group_id == s.id,
                CuratorGroupEvent.event
                == CuratorGroupEventKind.GROUP_RENAMED.value,
            )
            .order_by(CuratorGroupEvent.seq)
        )
    ).scalars().all()
    return [(d["old_name"], d["new_name"]) for d in rows]


@pytest.mark.asyncio
async def test_two_renames_record_what_each_actually_replaced(
    client, db_session, monkeypatch,
) -> None:
    """ПОВТОР: two tabs rename the school at once.

    ON THE OLD CODE each journal line said it renamed FROM the name its
    own tab had loaded: "Школа -> Б" after "Школа -> А", about a school
    that was called А. The journal must read as a chain.
    """
    s = await _school(client, db_session)
    result = await race(
        monkeypatch,
        holder=_rename(s, "А"),
        pause_in=(curator_service, "_lock_group_as_owner"),
        pause="after",
        rival=_rename(s, "Б"),
    )
    assert_no_deadlock(result)
    assert result.rival_waited, "the second rename never met the first"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert await _renames(db_session, s) == [
        ("Школа BE-95", "А"), ("А", "Б"),
    ]
    assert (await _group(db_session, s)).name == "Б"


@pytest.mark.asyncio
async def test_an_edit_and_a_delete_of_one_school(
    client, db_session, monkeypatch,
) -> None:
    """F5: the delete lands inside the edit.

    ON THE OLD CODE the edit's UPDATE met a vanished row at flush --
    StaleDataError, a 500. Now the delete waits for the edit.
    """
    s = await _school(client, db_session)
    result = await race(
        monkeypatch,
        holder=_rename(s, "А"),
        pause_in=(curator_service, "_lock_group_as_owner"),
        pause="after",
        rival=_delete(s),
    )
    assert_no_deadlock(result)
    assert result.rival_waited, "the delete never met the edit's lock"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert await _group(db_session, s) is None


@pytest.mark.asyncio
async def test_an_appointment_made_while_the_school_is_renamed(
    client, db_session, monkeypatch,
) -> None:
    """The group row is taken once, at full strength -- never upgraded.

    The rename holds the group to read it and then needs the stronger lock
    to change its name. An offer that had inserted its row first (the FK
    check takes KEY SHARE on the group) and only then asked for the group
    to re-check ownership was upgrading the same lock the other way: a
    deadlock, measured on the first form of this delivery. The offer now
    checks ownership before the INSERT, so it waits on the rename holding
    nothing the rename needs.
    """
    s = await _school(client, db_session)
    result = await race(
        monkeypatch,
        holder=_rename(s, "А"),
        pause_in=(curator_service, "_lock_group_as_owner"),
        pause="after",
        rival=_offer_master(s),
    )
    assert_no_deadlock(result)
    assert result.rival_waited, "the offer never met the rename's lock"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert await _offers(db_session, s) == [s.student]
    assert (await _group(db_session, s)).name == "А"
