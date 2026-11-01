# =============================================================================
# VELO Backend -- Tests: a curator demotes a master of the school (BE-59 B1)
# =============================================================================
#
# telegram_id band: 68900-68949, declared module-level as _TID_MIN/_TID_MAX
# ONCE -- tests/telegram_id_bands.py parses that declaration out of the AST.
# Re-checked against the live registry rather than assumed:
# free_windows(space=(67600, 69999)) returned [(67950, 67999), (68900, 68999)],
# so 68900-68949 was free and 68950-68999 stays free.
#
# WHAT IS PROVED, AND WHERE:
#   the demotion itself -- kind, membership kept, journal, notification,
#       verification untouched: test_a_master_is_demoted_and_told
#   REPEAT -- a second demotion writes nothing; a demote / re-appoint /
#       demote cycle writes twice: test_demoting_twice_writes_once,
#       test_a_reappointed_master_can_be_demoted_again
#   EMPTINESS -- a student, a non-member: test_demoting_a_student_writes_nothing,
#       test_demoting_a_stranger_to_the_school_writes_nothing
#   SHORTAGE -- not your school: test_another_curator_cannot_demote;
#       the school handed over mid-demotion: the race at the bottom
#   the pending handover dies with the role:
#       test_a_handover_offered_to_the_demoted_master_is_dropped
#   races (tests/curator_race_harness.py, both sides waiting at once):
#       vs remove, vs leave, vs accept-transfer (both start orders),
#       vs accept of a master offer (serialised without a wait -- see the
#       test), and a handover landing mid-demotion.
# =============================================================================

from collections.abc import AsyncGenerator
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events.models import OutboxEvent
from app.core.exceptions import NotFoundError
from app.modules.curator_groups import service as curator_service
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupEvent,
    CuratorGroupEventKind,
    CuratorGroupMasterOffer,
    CuratorGroupMember,
    CuratorGroupTransfer,
    CuratorMemberKind,
)
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from tests.curator_race_harness import assert_no_deadlock, race
from tests.helpers import (
    auth_headers,
    fresh_execute,
    fresh_get,
    full_cleanup_range,
    login_user,
)

GROUPS_URL = "/api/v1/masters/me/curator-groups"
DEMOTE_URL = GROUPS_URL + "/{group_id}/members/{user_id}/demote"
OFFER_URL = GROUPS_URL + "/{group_id}/master-offers"
TRANSFER_URL = GROUPS_URL + "/{group_id}/transfer"
ACCEPT_OFFER_URL = "/api/v1/curator-groups/{group_id}/master-offer/accept"
TRANSFER_ACCEPT_URL = "/api/v1/curator-groups/{group_id}/transfer/accept"

_TID_MIN = 68900
_TID_MAX = 68949

_TID_CURATOR = 68901
_TID_OTHER_CURATOR = 68902
_TID_MASTER = 68910
_TID_SECOND_MASTER = 68911
_TID_STUDENT = 68912
_TID_STRANGER = 68913

DEMOTED = "curator_group.member_demoted"
MASTER = CuratorMemberKind.MASTER.value
STUDENT = CuratorMemberKind.STUDENT.value


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """FK-safe shared helper (TD-032), scoped to this file's own band."""
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ===========================================================================
# Helpers
# ===========================================================================


async def _person(
    client: AsyncClient, db_session: AsyncSession, tid: int,
    *, master: bool = True,
) -> dict:
    auth = await login_user(client, telegram_id=tid, first_name=f"P{tid}")
    if master:
        uid = UUID(auth["user"]["id"])
        user = await db_session.get(User, uid)
        user.role = UserRole.MASTER
        db_session.add(
            MasterProfile(
                user_id=uid,
                data={
                    "account": {"status": "verified", "can_create_groups": True},
                    "profile": {"bio": "m"},
                },
            )
        )
        await db_session.flush()
    await db_session.commit()
    return auth


def _uid(auth: dict) -> UUID:
    return UUID(auth["user"]["id"])


async def _school(client: AsyncClient, curator: dict, name: str) -> str:
    resp = await client.post(
        GROUPS_URL, json={"name": name},
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _seed(
    db_session: AsyncSession, group_id: str, auth: dict, kind: str,
) -> None:
    db_session.add(
        CuratorGroupMember(group_id=UUID(group_id), user_id=_uid(auth), kind=kind)
    )
    await db_session.flush()
    await db_session.commit()


async def _demote(client, curator: dict, group_id: str, who: dict):
    return await client.post(
        DEMOTE_URL.format(group_id=group_id, user_id=who["user"]["id"]),
        headers=auth_headers(curator["session_token"]),
    )


async def _kind(group_id, user_id) -> str | None:
    return (
        await fresh_execute(
            select(CuratorGroupMember.kind).where(
                CuratorGroupMember.group_id == UUID(str(group_id)),
                CuratorGroupMember.user_id == UUID(str(user_id)),
            )
        )
    ).scalar_one_or_none()


async def _journal(group_id) -> list[tuple[str, dict]]:
    rows = (
        await fresh_execute(
            select(CuratorGroupEvent.event, CuratorGroupEvent.data)
            .where(CuratorGroupEvent.group_id == UUID(str(group_id)))
            .order_by(CuratorGroupEvent.seq)
        )
    ).all()
    return [(e, d) for e, d in rows]


async def _events(group_id) -> list[str]:
    return [e for e, _ in await _journal(group_id)]


async def _school_notes_for(user_id) -> list[dict]:
    """curator_group.* payloads queued for one person, oldest first.

    Scoped by target_value (the cleanup's own access path) and by the
    school family, so a contact-book sync row can never decide a count.
    """
    rows = (
        await fresh_execute(
            select(OutboxEvent)
            .where(
                OutboxEvent.payload["target_value"].astext == str(user_id),
            )
            .order_by(OutboxEvent.created_at, OutboxEvent.id)
        )
    ).scalars().all()
    return [
        r.payload for r in rows
        if (r.payload or {}).get("type", "").startswith("curator_group.")
    ]


async def _demoted_notes_for(user_id) -> list[dict]:
    return [p for p in await _school_notes_for(user_id) if p["type"] == DEMOTED]


# ===========================================================================
# The demotion
# ===========================================================================


@pytest.mark.asyncio
async def test_a_master_is_demoted_and_told(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """204; the person stays, as a student; one journal line naming them;
    one notification to THEM; their platform verification is untouched;
    another master of the school is not affected (the pair)."""
    curator = await _person(client, db_session, _TID_CURATOR)
    master = await _person(client, db_session, _TID_MASTER)
    other = await _person(client, db_session, _TID_SECOND_MASTER)
    group = await _school(client, curator, "Школа понижения")
    await _seed(db_session, group, master, MASTER)
    await _seed(db_session, group, other, MASTER)

    resp = await _demote(client, curator, group, master)
    assert resp.status_code == 204, resp.text

    assert await _kind(group, _uid(master)) == STUDENT
    assert await _kind(group, _uid(other)) == MASTER
    demotions = [
        d for e, d in await _journal(group)
        if e == CuratorGroupEventKind.MEMBER_DEMOTED.value
    ]
    assert len(demotions) == 1
    assert demotions[0]["target_user_id"] == master["user"]["id"]
    assert "transfer_cancelled" not in demotions[0]

    [note] = await _demoted_notes_for(_uid(master))
    assert note["action_data"]["action"] == "open_curator_group"
    assert note["action_data"]["group_name"] == "Школа понижения"
    assert note["action_data"]["actor_name"] == f"P{_TID_CURATOR}"
    assert await _demoted_notes_for(_uid(curator)) == []

    profile = await fresh_get(MasterProfile, _uid(master))
    assert profile.data["account"]["status"] == "verified"


@pytest.mark.asyncio
async def test_demoting_twice_writes_once(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """REPEAT (owner ruling): the second demotion is a 204 with no journal
    line and no notification."""
    curator = await _person(client, db_session, _TID_CURATOR)
    master = await _person(client, db_session, _TID_MASTER)
    group = await _school(client, curator, "Школа повтора")
    await _seed(db_session, group, master, MASTER)

    for _ in range(2):
        assert (await _demote(client, curator, group, master)).status_code == 204

    assert (await _events(group)).count(
        CuratorGroupEventKind.MEMBER_DEMOTED.value
    ) == 1
    assert len(await _demoted_notes_for(_uid(master))) == 1


@pytest.mark.asyncio
async def test_demoting_a_student_writes_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """EMPTINESS: nobody to demote. The pair: the student is still there."""
    curator = await _person(client, db_session, _TID_CURATOR)
    student = await _person(client, db_session, _TID_STUDENT, master=False)
    group = await _school(client, curator, "Школа учеников")
    await _seed(db_session, group, student, STUDENT)
    before = await _events(group)

    assert (await _demote(client, curator, group, student)).status_code == 204

    assert await _kind(group, _uid(student)) == STUDENT
    assert await _events(group) == before
    assert await _school_notes_for(_uid(student)) == []


@pytest.mark.asyncio
async def test_demoting_a_stranger_to_the_school_writes_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """EMPTINESS: not a member at all -- still 204, no row appears, the
    journal holds only the school's creation."""
    curator = await _person(client, db_session, _TID_CURATOR)
    stranger = await _person(client, db_session, _TID_STRANGER)
    group = await _school(client, curator, "Школа чужих")

    assert (await _demote(client, curator, group, stranger)).status_code == 204

    assert await _kind(group, _uid(stranger)) is None
    assert await _events(group) == [CuratorGroupEventKind.GROUP_CREATED.value]


@pytest.mark.asyncio
async def test_another_curator_cannot_demote(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """SHORTAGE: not your school -- the school's 404 (P-08); kind stays."""
    curator = await _person(client, db_session, _TID_CURATOR)
    other = await _person(client, db_session, _TID_OTHER_CURATOR)
    master = await _person(client, db_session, _TID_MASTER)
    group = await _school(client, curator, "Школа своя")
    await _seed(db_session, group, master, MASTER)

    resp = await _demote(client, other, group, master)
    assert resp.status_code == 404
    assert await _kind(group, _uid(master)) == MASTER


@pytest.mark.asyncio
async def test_a_handover_offered_to_the_demoted_master_is_dropped(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A school is handed only to one of its masters: the pending handover
    to the person demoted dies with the role, the journal says so, and
    their accept is then the honest 404."""
    curator = await _person(client, db_session, _TID_CURATOR)
    heir = await _person(client, db_session, _TID_MASTER)
    group = await _school(client, curator, "Школа наследника")
    await _seed(db_session, group, heir, MASTER)
    resp = await client.post(
        TRANSFER_URL.format(group_id=group),
        json={"to_user_id": heir["user"]["id"]},
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200, resp.text

    assert (await _demote(client, curator, group, heir)).status_code == 204

    transfers = (
        await fresh_execute(
            select(CuratorGroupTransfer.id).where(
                CuratorGroupTransfer.group_id == UUID(group)
            )
        )
    ).all()
    assert transfers == []
    [data] = [
        d for e, d in await _journal(group)
        if e == CuratorGroupEventKind.MEMBER_DEMOTED.value
    ]
    assert data["transfer_cancelled"] is True
    resp = await client.post(
        TRANSFER_ACCEPT_URL.format(group_id=group),
        headers=auth_headers(heir["session_token"]),
    )
    assert resp.status_code == 404
    group_row = await fresh_get(CuratorGroup, UUID(group))
    assert group_row.curator_user_id == _uid(curator)


@pytest.mark.asyncio
async def test_a_reappointed_master_can_be_demoted_again(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """REPEAT across a cycle: demote -> appoint -> accept -> demote is two
    demotions, two lines, two notifications under two different keys."""
    curator = await _person(client, db_session, _TID_CURATOR)
    master = await _person(client, db_session, _TID_MASTER)
    group = await _school(client, curator, "Школа цикла")
    await _seed(db_session, group, master, MASTER)

    assert (await _demote(client, curator, group, master)).status_code == 204
    resp = await client.post(
        OFFER_URL.format(group_id=group),
        json={"to_user_id": master["user"]["id"]},
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 204, resp.text
    resp = await client.post(
        ACCEPT_OFFER_URL.format(group_id=group),
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 204, resp.text
    assert await _kind(group, _uid(master)) == MASTER
    assert (await _demote(client, curator, group, master)).status_code == 204

    assert await _kind(group, _uid(master)) == STUDENT
    events = await _events(group)
    assert events.count(CuratorGroupEventKind.MEMBER_DEMOTED.value) == 2
    assert events.count(CuratorGroupEventKind.MEMBER_PROMOTED.value) == 1
    notes = await _demoted_notes_for(_uid(master))
    assert len(notes) == 2
    assert len({n["idempotency_key"] for n in notes}) == 2


# ===========================================================================
# Races (tests/curator_race_harness.py)
# ===========================================================================


class _S:
    group: UUID
    curator: UUID
    master: UUID
    second: UUID


async def _race_school(
    client, db_session, *, transfer_to_master: bool = False,
    master_kind: str = MASTER, offer_to_master: bool = False,
) -> _S:
    s = _S()
    s.curator = _uid(await _person(client, db_session, _TID_CURATOR))
    s.master = _uid(await _person(client, db_session, _TID_MASTER))
    s.second = _uid(await _person(client, db_session, _TID_SECOND_MASTER))
    group = CuratorGroup(curator_user_id=s.curator, name="Школа гонки B1")
    db_session.add(group)
    await db_session.flush()
    s.group = group.id
    db_session.add(
        CuratorGroupMember(group_id=s.group, user_id=s.master, kind=master_kind)
    )
    db_session.add(
        CuratorGroupMember(group_id=s.group, user_id=s.second, kind=MASTER)
    )
    if transfer_to_master:
        db_session.add(CuratorGroupTransfer(group_id=s.group, to_user_id=s.master))
    if offer_to_master:
        db_session.add(
            CuratorGroupMasterOffer(group_id=s.group, to_user_id=s.master)
        )
    await db_session.flush()
    await db_session.commit()
    return s


def _demote_call(s: _S, by: UUID, who: UUID):
    async def call(session):
        await curator_service.demote_curator_group_master(
            by, s.group, who, session, actor=await session.get(User, by),
        )
    return call


def _remove_call(s: _S):
    async def call(session):
        await curator_service.remove_curator_group_member(
            s.curator, s.group, s.master, session,
            actor=await session.get(User, s.curator),
        )
    return call


def _leave_call(s: _S):
    async def call(session):
        await curator_service.leave_curator_group(
            s.group, s.master, session, actor=await session.get(User, s.master),
        )
    return call


def _accept_transfer_call(s: _S):
    async def call(session):
        await curator_service.accept_curator_group_transfer(
            s.group, s.master, session, actor=await session.get(User, s.master),
        )
    return call


def _accept_offer_call(s: _S):
    async def call(session):
        await curator_service.accept_curator_group_master_offer(
            s.group, s.master, session, actor=await session.get(User, s.master),
        )
    return call


async def _curator_of(s: _S) -> UUID:
    return (await fresh_get(CuratorGroup, s.group)).curator_user_id


@pytest.mark.asyncio
async def test_a_removal_mid_demotion_neither_deadlocks_nor_demotes_a_ghost(
    client, db_session, monkeypatch,
) -> None:
    """Remove holds the member row (deleted) and is paused; the demotion's
    claim waits on that row, then finds nothing: 204, no demotion line."""
    s = await _race_school(client, db_session)
    result = await race(
        monkeypatch,
        holder=_remove_call(s),
        pause_in=(curator_service, "_drop_pending_transfer_for"),
        rival=_demote_call(s, s.curator, s.master),
    )
    assert_no_deadlock(result)
    assert result.rival_waited, "the demotion never met the removal's lock"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert await _kind(s.group, s.master) is None
    events = await _events(s.group)
    assert CuratorGroupEventKind.MEMBER_REMOVED.value in events
    assert CuratorGroupEventKind.MEMBER_DEMOTED.value not in events


@pytest.mark.asyncio
async def test_leaving_mid_demotion_leaves_after_it(
    client, db_session, monkeypatch,
) -> None:
    """The demotion holds the member row; the leave waits, then leaves as a
    student. Both lines, in that order; nobody left behind."""
    s = await _race_school(client, db_session)
    result = await race(
        monkeypatch,
        holder=_demote_call(s, s.curator, s.master),
        pause_in=(curator_service, "_drop_pending_transfer_for"),
        rival=_leave_call(s),
    )
    assert_no_deadlock(result)
    assert result.rival_waited, "the leave never met the demotion's lock"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert await _kind(s.group, s.master) is None
    events = await _events(s.group)
    assert events.index(CuratorGroupEventKind.MEMBER_DEMOTED.value) < (
        events.index(CuratorGroupEventKind.MEMBER_LEFT.value)
    )


@pytest.mark.asyncio
async def test_a_handover_accepted_mid_demotion_of_the_heir(
    client, db_session, monkeypatch,
) -> None:
    """The heir accepts first and is paused holding their member row; the
    demotion of the heir waits, then finds no master row -- the heir is the
    curator now. Not demoted, no demotion line."""
    s = await _race_school(client, db_session, transfer_to_master=True)
    result = await race(
        monkeypatch,
        holder=_accept_transfer_call(s),
        pause_in=(curator_service, "_has_master_capability"),
        rival=_demote_call(s, s.curator, s.master),
    )
    assert_no_deadlock(result)
    assert result.rival_waited, "the demotion never met the accept's lock"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert await _curator_of(s) == s.master
    assert CuratorGroupEventKind.MEMBER_DEMOTED.value not in await _events(
        s.group
    )


@pytest.mark.asyncio
async def test_a_demotion_landing_first_kills_the_handover(
    client, db_session, monkeypatch,
) -> None:
    """The other start order: the demotion holds the heir's row (about to
    drop the transfer); the accept waits, then finds no transfer -- 404,
    and its delete of the member row is rolled back (P-01). The school did
    not change hands; the heir is a student of it."""
    s = await _race_school(client, db_session, transfer_to_master=True)
    result = await race(
        monkeypatch,
        holder=_demote_call(s, s.curator, s.master),
        pause_in=(curator_service, "_drop_pending_transfer_for"),
        rival=_accept_transfer_call(s),
    )
    assert_no_deadlock(result)
    assert result.rival_waited, "the accept never met the demotion's lock"
    assert result.holder.committed, result.holder.error
    assert isinstance(result.rival.error, NotFoundError), result.rival
    assert await _curator_of(s) == s.curator
    assert await _kind(s.group, s.master) == STUDENT


@pytest.mark.asyncio
async def test_an_appointment_accepted_mid_demotion_is_serialised(
    client, db_session, monkeypatch,
) -> None:
    """A student accepts an offer and is paused holding their row while the
    curator demotes them.

    THE DEMOTION DOES NOT WAIT, AND THAT IS THE MECHANISM, NOT A GAP. Its
    claim is an UPDATE whose predicate is kind='master'; the version of the
    row visible to it is the committed 'student' one, the predicate does not
    match, and Postgres does not wait on a lock held on a row that does not
    match. So the demotion serialises BEFORE the accept: "demoted a
    student" (a no-op 204), then "the student accepted". Measured: an
    earlier form of this test asserted the opposite winner and failed.

    THE INVARIANT, not the winner: a demotion line exists exactly when the
    person ends a student, and the promotion happened once.
    """
    s = await _race_school(
        client, db_session, master_kind=STUDENT, offer_to_master=True,
    )
    result = await race(
        monkeypatch,
        holder=_accept_offer_call(s),
        pause_in=(curator_service, "_has_master_capability"),
        rival=_demote_call(s, s.curator, s.master),
    )
    assert_no_deadlock(result)
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    events = await _events(s.group)
    demoted = CuratorGroupEventKind.MEMBER_DEMOTED.value in events
    assert demoted == (await _kind(s.group, s.master) == STUDENT)
    assert events.count(CuratorGroupEventKind.MEMBER_PROMOTED.value) == 1
    # This start order, specifically: the no-op came first.
    assert not result.rival_waited
    assert not demoted
    assert await _kind(s.group, s.master) == MASTER


@pytest.mark.asyncio
async def test_a_former_curator_cannot_demote_in_the_new_owners_school(
    client, db_session, monkeypatch,
) -> None:
    """The school changes hands while its old curator demotes ANOTHER
    master. The accept holds the group row; the demotion's ownership check
    waits on it, re-reads, and refuses -- the rollback restores the kind.
    This is the case _lock_group_as_owner is in demote_curator_group_master
    for."""
    s = await _race_school(client, db_session, transfer_to_master=True)
    result = await race(
        monkeypatch,
        holder=_accept_transfer_call(s),
        pause_in=(curator_service, "_frozen_name"),
        rival=_demote_call(s, s.curator, s.second),
    )
    assert_no_deadlock(result)
    assert result.rival_waited, "the demotion never met the group's lock"
    assert result.holder.committed, result.holder.error
    assert isinstance(result.rival.error, NotFoundError), result.rival
    assert await _curator_of(s) == s.master
    assert await _kind(s.group, s.second) == MASTER
