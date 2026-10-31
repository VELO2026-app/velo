# =============================================================================
# VELO Backend -- Tests: a master acts on a person by id only with a link
# (BE-46)
# =============================================================================
#
# telegram_id band: 71350-71399.
#
# BAND PROVENANCE. On 2026-10-31, at test b85c195, 71350-71449 was a free
# window of free_windows() over the whole allowed space, covered by no
# file's cleanup sweep, and no test file used a number in it.
#
# WHAT IS UNDER TEST. masters/groups_service.has_master_link -- one rule,
# three kinds of action (owner, 2026-10-31):
#
#   GRANT_ACCESS (add_group_member): a booking at any status or a waitlist
#       entry on a practice of this master, or membership of one of his
#       groups;
#   INTERNAL (set_student_tag, block_student): the same, or an existing
#       conversation with this master as its master;
#   OPEN_CHAT (POST /chats/students): INTERNAL, or a shared school where
#       the master is a master or the curator.
#
# and its four doors. Each door answers "no such user" and "no link" with
# the SAME bytes -- that is the oracle being closed -- and writes nothing
# for either. Every refusal has its pair: the same door, a linked person,
# passes.
#
# The comms call of the chat is stubbed at the router's own seam, as in
# test_chats_t3_students.py; the provider of truth here is our tables.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_engine, get_session_factory
from app.core.exceptions import NotFoundError
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.chats.models import ChatThread
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters import groups_service
from app.modules.masters.groups_models import (
    MasterGroup,
    MasterGroupMembership,
    MasterStudent,
)
from app.modules.masters.groups_service import MasterLinkAction, has_master_link
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from app.modules.waitlist.models import Waitlist, WaitlistStatus
from tests.helpers import auth_headers, fresh_execute, full_cleanup_range, login_user

_TID_MIN = 71350
_TID_MAX = 71399

GROUPS_URL = "/api/v1/masters/me/groups"
STUDENTS_URL = "/api/v1/masters/me/students"
CHAT_STUDENTS_URL = "/api/v1/chats/students"

_COMMS_SEAM = "app.modules.chats.router.comms_request"
_THREAD_ID = "cccccccc-0046-4000-8000-000000000046"

GRANT = MasterLinkAction.GRANT_ACCESS
INTERNAL = MasterLinkAction.INTERNAL
CHAT = MasterLinkAction.OPEN_CHAT
ALL = (GRANT, INTERNAL, CHAT)


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean all test data for this band before/after each test (ORM only).

    Users go (delete_users=True), and with them, by FK CASCADE, every row
    this file hangs off them: practices, bookings, waitlist entries, groups
    and memberships, chat pointers, schools and their member rows."""
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    # full_cleanup_range does not commit on its own.
    await full_cleanup_range(session, _TID_MIN, _TID_MAX, delete_users=True)
    await session.commit()


# ===================================================================
# Fixtures
# ===================================================================


async def _master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> dict:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Master")
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    user.role = UserRole.MASTER.value
    db_session.add(
        MasterProfile(
            user_id=user.id,
            data={"account": {"status": "verified"}, "profile": {"bio": "m"}},
        )
    )
    await db_session.commit()
    return auth


async def _person(client: AsyncClient, telegram_id: int) -> dict:
    return await login_user(client, telegram_id=telegram_id, first_name="Person")


def _id(auth: dict) -> UUID:
    return UUID(auth["user"]["id"])


async def _practice(
    db_session: AsyncSession, master_id: UUID, *, school_id: UUID | None = None,
) -> Practice:
    practice = Practice(
        master_id=master_id,
        title="BE-46 practice",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=PracticeStatus.COMPLETED.value,
        scheduled_at=datetime.now(UTC) - timedelta(days=3),
        duration_minutes=60,
        timezone="UTC",
        max_participants=20,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        curator_group_id=school_id,
    )
    db_session.add(practice)
    await db_session.flush()
    return practice


async def _booking(
    db_session: AsyncSession, master_id: UUID, person_id: UUID,
    status: str = BookingStatus.CANCELLED.value,
) -> None:
    practice = await _practice(db_session, master_id)
    db_session.add(Booking(practice_id=practice.id, user_id=person_id, status=status))
    await db_session.commit()


async def _waitlist(
    db_session: AsyncSession, master_id: UUID, person_id: UUID,
) -> None:
    practice = await _practice(db_session, master_id)
    db_session.add(
        Waitlist(
            practice_id=practice.id,
            user_id=person_id,
            position=1,
            status=WaitlistStatus.EXPIRED.value,
            joined_at=datetime.now(UTC),
        )
    )
    await db_session.commit()


async def _group(
    db_session: AsyncSession, master_id: UUID, name: str = "BE-46 group",
) -> MasterGroup:
    group = MasterGroup(master_id=master_id, name=name)
    db_session.add(group)
    await db_session.flush()
    return group


async def _membership(
    db_session: AsyncSession, master_id: UUID, person_id: UUID,
    name: str = "BE-46 group",
) -> MasterGroup:
    group = await _group(db_session, master_id, name)
    db_session.add(MasterGroupMembership(group_id=group.id, student_user_id=person_id))
    await db_session.commit()
    return group


async def _thread(
    db_session: AsyncSession, *, client_id: UUID, operator_id: UUID,
) -> None:
    db_session.add(
        ChatThread(
            comms_thread_id=UUID(_THREAD_ID),
            client_user_id=client_id,
            operator_user_id=operator_id,
        )
    )
    await db_session.commit()


async def _school(
    db_session: AsyncSession, curator_id: UUID, members: dict[UUID, str],
) -> CuratorGroup:
    school = CuratorGroup(curator_user_id=curator_id, name=f"BE-46 {uuid4().hex[:6]}")
    db_session.add(school)
    await db_session.flush()
    for user_id, kind in members.items():
        db_session.add(
            CuratorGroupMember(group_id=school.id, user_id=user_id, kind=kind),
        )
    await db_session.commit()
    return school


def _thread_payload() -> dict:
    return {
        "id": _THREAD_ID,
        "client": str(uuid4()),
        "operator_kind": "user",
        "operator_value": str(uuid4()),
        "assignee": None,
        "kind": "dm",
        "status": "open",
        "subject_type": None,
        "subject_id": None,
        "title": None,
        "priority": None,
        "last_message_at": None,
        "created_at": "2026-10-31T09:00:00+00:00",
        "created": True,
    }


async def _new_group(client: AsyncClient, headers: dict, name: str) -> str:
    resp = await client.post(GROUPS_URL, json={"name": name}, headers=headers)
    return resp.json()["id"]


async def _link(db_session: AsyncSession, master_id: UUID, person_id: UUID, action):
    return await has_master_link(master_id, person_id, db_session, action=action)


# ===================================================================
# The rule: what each source grants, per kind of action
# ===================================================================


@pytest.mark.parametrize("status", [s.value for s in BookingStatus])
async def test_a_booking_at_any_status_links_for_every_action(
    client: AsyncClient, db_session: AsyncSession, status: str,
) -> None:
    """Cancelled included: the person chose this master once."""
    master = await _master(client, db_session, 71350)
    person = await _person(client, 71351)
    await _booking(db_session, _id(master), _id(person), status)

    assert [await _link(db_session, _id(master), _id(person), a) for a in ALL] == [
        True, True, True,
    ]


async def test_a_waitlist_entry_links_for_every_action(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """At any status -- an expired entry was still the person's own act."""
    master = await _master(client, db_session, 71350)
    person = await _person(client, 71351)
    await _waitlist(db_session, _id(master), _id(person))

    assert [await _link(db_session, _id(master), _id(person), a) for a in ALL] == [
        True, True, True,
    ]


async def test_membership_of_his_group_links_for_every_action(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The trace an invite-link join leaves -- the only one there is."""
    master = await _master(client, db_session, 71350)
    person = await _person(client, 71351)
    await _membership(db_session, _id(master), _id(person))

    assert [await _link(db_session, _id(master), _id(person), a) for a in ALL] == [
        True, True, True,
    ]


async def test_a_booking_on_his_school_practice_links(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A school's practice is his when he is its master_id (question 3)."""
    master = await _master(client, db_session, 71350)
    curator = await _master(client, db_session, 71352)
    person = await _person(client, 71351)
    school = await _school(
        db_session, _id(curator), {_id(master): CuratorMemberKind.MASTER.value},
    )
    practice = await _practice(db_session, _id(master), school_id=school.id)
    db_session.add(Booking(
        practice_id=practice.id, user_id=_id(person),
        status=BookingStatus.CONFIRMED.value,
    ))
    await db_session.commit()

    assert await _link(db_session, _id(master), _id(person), GRANT) is True


async def test_a_conversation_links_for_bookkeeping_and_chat_never_for_access(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Someone who wrote to him: a tag, a block, opening that chat -- yes;
    a group membership -- no, or opening a chat would earn access."""
    master = await _master(client, db_session, 71350)
    person = await _person(client, 71351)
    await _thread(db_session, client_id=_id(person), operator_id=_id(master))

    assert await _link(db_session, _id(master), _id(person), GRANT) is False
    assert await _link(db_session, _id(master), _id(person), INTERNAL) is True
    assert await _link(db_session, _id(master), _id(person), CHAT) is True


async def test_the_reverse_conversation_does_not_link(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The master as somebody else's CLIENT is not his student's
    conversation; counted, it would let him create the forward one."""
    master = await _master(client, db_session, 71350)
    other = await _master(client, db_session, 71351)
    await _thread(db_session, client_id=_id(master), operator_id=_id(other))

    assert [await _link(db_session, _id(master), _id(other), a) for a in ALL] == [
        False, False, False,
    ]


@pytest.mark.parametrize("caller_role", ["school_master", "curator"])
async def test_a_shared_school_links_for_chat_only(
    client: AsyncClient, db_session: AsyncSession, caller_role: str,
) -> None:
    """BE-76 / BE-78: a school master or the curator writes to a member of
    his school. Nothing else follows from the school."""
    caller = await _master(client, db_session, 71350)
    curator = await _master(client, db_session, 71352)
    person = await _person(client, 71351)
    members = {_id(person): CuratorMemberKind.STUDENT.value}
    if caller_role == "school_master":
        members[_id(caller)] = CuratorMemberKind.MASTER.value
        await _school(db_session, _id(curator), members)
    else:
        await _school(db_session, _id(caller), members)

    assert await _link(db_session, _id(caller), _id(person), CHAT) is True
    assert await _link(db_session, _id(caller), _id(person), INTERNAL) is False
    assert await _link(db_session, _id(caller), _id(person), GRANT) is False


async def test_a_school_where_the_caller_is_only_a_student_does_not_link(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Fellow students of one school are not each other's audience."""
    caller = await _master(client, db_session, 71350)
    curator = await _master(client, db_session, 71352)
    person = await _person(client, 71351)
    await _school(db_session, _id(curator), {
        _id(caller): CuratorMemberKind.STUDENT.value,
        _id(person): CuratorMemberKind.STUDENT.value,
    })

    assert await _link(db_session, _id(caller), _id(person), CHAT) is False


async def test_a_guest_of_a_school_practice_outside_the_school_does_not_link(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """BE-78's refused case: the guest booked ANOTHER school master's
    practice and is no member of the school -- no chat for this master."""
    caller = await _master(client, db_session, 71350)
    colleague = await _master(client, db_session, 71353)
    curator = await _master(client, db_session, 71352)
    guest = await _person(client, 71351)
    school = await _school(db_session, _id(curator), {
        _id(caller): CuratorMemberKind.MASTER.value,
        _id(colleague): CuratorMemberKind.MASTER.value,
    })
    practice = await _practice(db_session, _id(colleague), school_id=school.id)
    db_session.add(Booking(
        practice_id=practice.id, user_id=_id(guest),
        status=BookingStatus.ATTENDED.value,
    ))
    await db_session.commit()

    assert await _link(db_session, _id(caller), _id(guest), CHAT) is False


async def test_another_masters_booking_and_group_do_not_link(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """SHORTAGE: everything the person did, he did toward someone else."""
    master = await _master(client, db_session, 71350)
    other = await _master(client, db_session, 71352)
    person = await _person(client, 71351)
    await _booking(db_session, _id(other), _id(person), BookingStatus.ATTENDED.value)
    await _waitlist(db_session, _id(other), _id(person))
    await _membership(db_session, _id(other), _id(person))
    await _thread(db_session, client_id=_id(person), operator_id=_id(other))

    assert [await _link(db_session, _id(master), _id(person), a) for a in ALL] == [
        False, False, False,
    ]


async def test_nobody_and_a_stranger_are_both_unlinked(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """EMPTINESS: an account with no trace at all, and no account."""
    master = await _master(client, db_session, 71350)
    stranger = await _person(client, 71351)

    for person_id in (_id(stranger), uuid4()):
        assert [await _link(db_session, _id(master), person_id, a) for a in ALL] == [
            False, False, False,
        ]


async def test_the_link_is_one_statement(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The refusal must not differ between "no user" and "no link" in the
    number of queries either: one SELECT, whatever the answer."""
    master = await _master(client, db_session, 71350)
    stranger = await _person(client, 71351)
    calls = 0
    real_scalar = db_session.scalar

    async def counting_scalar(*args, **kwargs):
        nonlocal calls
        calls += 1
        return await real_scalar(*args, **kwargs)

    db_session.scalar = counting_scalar  # type: ignore[method-assign]
    try:
        for person_id in (_id(stranger), uuid4()):
            await _link(db_session, _id(master), person_id, CHAT)
    finally:
        del db_session.scalar
    assert calls == 2


# ===================================================================
# The four doors: one answer for "no such user" and "no link"
# ===================================================================


async def _two_refusals(client: AsyncClient, call) -> tuple:
    return await call(uuid4()), await call(None)


async def test_add_group_member_refuses_both_alike_and_adds_nobody(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _master(client, db_session, 71350)
    stranger = await _person(client, 71351)
    headers = auth_headers(master["session_token"])
    group_id = await _new_group(client, headers, "G")

    async def add(person_id):
        return await client.post(
            f"{GROUPS_URL}/{group_id}/members",
            json={"student_user_id": str(person_id or _id(stranger))},
            headers=headers,
        )

    missing, unlinked = await _two_refusals(client, add)

    assert missing.status_code == unlinked.status_code == 404
    assert missing.content == unlinked.content
    rows = (await fresh_execute(
        select(MasterGroupMembership).where(
            MasterGroupMembership.group_id == UUID(group_id),
        )
    )).scalars().all()
    assert rows == []


async def test_add_group_member_adds_a_linked_person(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The pair: the same door lets a person with a booking through."""
    master = await _master(client, db_session, 71350)
    person = await _person(client, 71351)
    await _booking(db_session, _id(master), _id(person))
    headers = auth_headers(master["session_token"])
    group_id = await _new_group(client, headers, "G")

    resp = await client.post(
        f"{GROUPS_URL}/{group_id}/members",
        json={"student_user_id": person["user"]["id"]},
        headers=headers,
    )

    assert resp.status_code == 204
    rows = (await fresh_execute(
        select(MasterGroupMembership).where(
            MasterGroupMembership.group_id == UUID(group_id),
        )
    )).scalars().all()
    assert [str(r.student_user_id) for r in rows] == [person["user"]["id"]]


async def test_add_group_member_refuses_a_conversation_only_contact(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Somebody who only wrote to him is in «Ученики», but a group would
    GIVE him something: refused, with the same 404 as a stranger."""
    master = await _master(client, db_session, 71350)
    writer = await _person(client, 71351)
    await _thread(db_session, client_id=_id(writer), operator_id=_id(master))
    headers = auth_headers(master["session_token"])
    group_id = await _new_group(client, headers, "G")

    resp = await client.post(
        f"{GROUPS_URL}/{group_id}/members",
        json={"student_user_id": writer["user"]["id"]},
        headers=headers,
    )

    assert resp.status_code == 404


async def test_add_group_member_into_another_of_his_groups(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Already in one of his groups (joined by invite) -> into another."""
    master = await _master(client, db_session, 71350)
    person = await _person(client, 71351)
    await _membership(db_session, _id(master), _id(person), name="By invite")
    headers = auth_headers(master["session_token"])
    group_id = await _new_group(client, headers, "Second")

    resp = await client.post(
        f"{GROUPS_URL}/{group_id}/members",
        json={"student_user_id": person["user"]["id"]},
        headers=headers,
    )

    assert resp.status_code == 204


async def test_the_rule_is_in_the_service_not_the_route(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Every door, present or future, goes through add_group_member."""
    master = await _master(client, db_session, 71350)
    stranger = await _person(client, 71351)
    group = await _group(db_session, _id(master))
    await db_session.commit()

    with pytest.raises(NotFoundError):
        await groups_service.add_group_member(
            _id(master), str(group.id), _id(stranger), db_session,
        )


async def test_set_student_tag_refuses_both_alike_and_writes_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _master(client, db_session, 71350)
    stranger = await _person(client, 71351)
    headers = auth_headers(master["session_token"])

    async def tag(person_id):
        return await client.put(
            f"{STUDENTS_URL}/{person_id or _id(stranger)}/tag",
            json={"tag": "x"},
            headers=headers,
        )

    missing, unlinked = await _two_refusals(client, tag)
    cleared = await client.put(
        f"{STUDENTS_URL}/{_id(stranger)}/tag", json={"tag": None}, headers=headers,
    )

    assert missing.status_code == unlinked.status_code == cleared.status_code == 404
    assert missing.content == unlinked.content == cleared.content
    rows = (await fresh_execute(
        select(MasterStudent).where(MasterStudent.master_id == _id(master))
    )).scalars().all()
    assert rows == []


async def test_set_student_tag_tags_a_conversation_contact(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The pair, through the weakest INTERNAL link: a conversation."""
    master = await _master(client, db_session, 71350)
    writer = await _person(client, 71351)
    await _thread(db_session, client_id=_id(writer), operator_id=_id(master))

    resp = await client.put(
        f"{STUDENTS_URL}/{writer['user']['id']}/tag",
        json={"tag": "Пишет"},
        headers=auth_headers(master["session_token"]),
    )

    assert resp.status_code == 200
    assert resp.json()["tag"] == "Пишет"


async def test_block_student_refuses_both_alike_and_leaves_no_dossier(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A block row on a stranger used to open the stranger's dossier --
    name and avatar of any id. Now: no row, and the dossier stays 404."""
    master = await _master(client, db_session, 71350)
    stranger = await _person(client, 71351)
    headers = auth_headers(master["session_token"])

    async def block(person_id):
        return await client.post(
            f"{STUDENTS_URL}/{person_id or _id(stranger)}/block", headers=headers,
        )

    missing, unlinked = await _two_refusals(client, block)
    dossier = await client.get(f"{STUDENTS_URL}/{_id(stranger)}", headers=headers)

    assert missing.status_code == unlinked.status_code == 404
    assert missing.content == unlinked.content
    assert dossier.status_code == 404
    rows = (await fresh_execute(
        select(MasterStudent).where(MasterStudent.master_id == _id(master))
    )).scalars().all()
    assert rows == []


async def test_block_student_blocks_a_conversation_contact(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The pair: someone who only wrote to him can be blocked."""
    master = await _master(client, db_session, 71350)
    writer = await _person(client, 71351)
    await _thread(db_session, client_id=_id(writer), operator_id=_id(master))

    resp = await client.post(
        f"{STUDENTS_URL}/{writer['user']['id']}/block",
        headers=auth_headers(master["session_token"]),
    )

    assert resp.status_code == 200
    assert resp.json()["blocked_at"]


async def test_open_chat_refuses_both_alike_and_creates_nothing(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No comms call, no pointer row, and no name in either answer."""
    master = await _master(client, db_session, 71350)
    stranger = await _person(client, 71351)
    headers = auth_headers(master["session_token"])
    comms = AsyncMock(return_value=_thread_payload())
    monkeypatch.setattr(_COMMS_SEAM, comms)

    async def open_chat(person_id):
        return await client.post(
            CHAT_STUDENTS_URL,
            json={"student_id": str(person_id or _id(stranger))},
            headers=headers,
        )

    missing, unlinked = await _two_refusals(client, open_chat)

    assert missing.status_code == unlinked.status_code == 404
    assert missing.content == unlinked.content
    assert b"Person" not in unlinked.content
    comms.assert_not_awaited()
    rows = (await fresh_execute(
        select(ChatThread).where(ChatThread.operator_user_id == _id(master))
    )).scalars().all()
    assert rows == []


async def test_open_chat_opens_an_existing_conversation(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Somebody wrote first: the master answers from his own screen, and it
    is the SAME conversation -- one pointer row."""
    master = await _master(client, db_session, 71350)
    writer = await _person(client, 71351)
    await _thread(db_session, client_id=_id(writer), operator_id=_id(master))
    monkeypatch.setattr(_COMMS_SEAM, AsyncMock(return_value=_thread_payload()))

    resp = await client.post(
        CHAT_STUDENTS_URL,
        json={"student_id": writer["user"]["id"]},
        headers=auth_headers(master["session_token"]),
    )

    assert resp.status_code == 200
    assert resp.json()["peer"]["user_id"] == writer["user"]["id"]
    rows = (await fresh_execute(
        select(ChatThread).where(ChatThread.operator_user_id == _id(master))
    )).scalars().all()
    assert len(rows) == 1


async def test_open_chat_with_a_member_of_his_school(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """BE-76: a school master writes first to a student of the school."""
    master = await _master(client, db_session, 71350)
    curator = await _master(client, db_session, 71352)
    student = await _person(client, 71351)
    await _school(db_session, _id(curator), {
        _id(master): CuratorMemberKind.MASTER.value,
        _id(student): CuratorMemberKind.STUDENT.value,
    })
    comms = AsyncMock(return_value=_thread_payload())
    monkeypatch.setattr(_COMMS_SEAM, comms)

    resp = await client.post(
        CHAT_STUDENTS_URL,
        json={"student_id": student["user"]["id"]},
        headers=auth_headers(master["session_token"]),
    )

    assert resp.status_code == 200
    comms.assert_awaited_once()


@pytest.mark.parametrize("door", ["add", "tag", "block", "chat"])
async def test_both_refusals_run_the_same_statements(
    client: AsyncClient, db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch, door: str,
) -> None:
    """Equal bytes are not enough: a door that looked the user up first
    and refused with the SAME text would still answer "no such user" one
    query sooner -- measured, that mutant passed every byte test. So each
    door's two refusals must execute the same number of statements."""
    master = await _master(client, db_session, 71350)
    stranger = await _person(client, 71351)
    headers = auth_headers(master["session_token"])
    monkeypatch.setattr(_COMMS_SEAM, AsyncMock(return_value=_thread_payload()))
    group_id = await _new_group(client, headers, "G")

    async def knock(person_id: UUID):
        if door == "add":
            return await client.post(
                f"{GROUPS_URL}/{group_id}/members",
                json={"student_user_id": str(person_id)}, headers=headers,
            )
        if door == "tag":
            return await client.put(
                f"{STUDENTS_URL}/{person_id}/tag", json={"tag": "x"}, headers=headers,
            )
        if door == "block":
            return await client.post(
                f"{STUDENTS_URL}/{person_id}/block", headers=headers,
            )
        return await client.post(
            CHAT_STUDENTS_URL, json={"student_id": str(person_id)}, headers=headers,
        )

    counts = []
    for person_id in (uuid4(), _id(stranger)):
        statements: list[str] = []

        def _watch(
            conn, cursor, statement, parameters, context, executemany,
            seen: list[str] = statements,
        ):
            seen.append(statement)

        sync_engine = get_engine().sync_engine
        event.listen(sync_engine, "before_cursor_execute", _watch)
        try:
            resp = await knock(person_id)
        finally:
            event.remove(sync_engine, "before_cursor_execute", _watch)
        assert resp.status_code == 404
        counts.append(len(statements))

    assert counts[0] == counts[1]
    assert counts[0] > 0, "the watcher saw nothing -- it would pass anything"


# ===================================================================
# The race: the link is removed while it is being used
# ===================================================================


async def test_a_link_removed_in_flight_gives_one_of_the_serial_orders(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The person is in group A only (that is the link); the master adds
    him to group B while removing him from A in another transaction.

    Built deterministically on two real connections: the removal has
    DELETED and holds its transaction open while the add reads the link.
    Under READ COMMITTED the add still sees A -- the removal is not
    committed -- and adds. Both commit: B has him, A does not, exactly the
    serial order "add, then remove". Then the other order, removal
    committed first: the add finds no link and refuses. No 500 either way,
    and no lock is taken by the add, so nothing can wait on anything."""
    master = await _master(client, db_session, 71350)
    person = await _person(client, 71351)
    group_a = await _membership(db_session, _id(master), _id(person), name="A")
    group_b = await _group(db_session, _id(master), "B")
    await db_session.commit()
    master_id, person_id = _id(master), _id(person)

    factory = get_session_factory()
    async with factory() as remover, factory() as adder:
        await groups_service.remove_group_member(
            master_id, str(group_a.id), person_id, remover,
        )
        await remover.flush()
        await groups_service.add_group_member(
            master_id, str(group_b.id), person_id, adder,
        )
        await adder.commit()
        await remover.commit()

    members = (await fresh_execute(
        select(MasterGroupMembership.group_id).where(
            MasterGroupMembership.student_user_id == person_id,
        )
    )).scalars().all()
    assert members == [group_b.id]

    # The other serial order: the removal (now of B, the only link left) is
    # committed before the add into A looks.
    async with factory() as remover:
        await groups_service.remove_group_member(
            master_id, str(group_b.id), person_id, remover,
        )
        await remover.commit()
    async with factory() as adder:
        with pytest.raises(NotFoundError):
            await groups_service.add_group_member(
                master_id, str(group_a.id), person_id, adder,
            )
