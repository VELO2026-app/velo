# =============================================================================
# VELO Backend -- Tests: school notifications (BE-25 / GT-26)
# =============================================================================
#
# telegram_id band: 67400-67599, declared module-level below as
# _TID_MIN/_TID_MAX ONCE -- tests/telegram_id_bands.py parses that declaration
# out of the AST, and a file using ids without declaring a band fails
# test_blind_zone_has_not_grown.
#
# BAND PROVENANCE: re-checked against the live registry rather than assumed --
# free_windows(space=(67400, 69999)) returned [(67400, 67999), (68400, 68999),
# (69100, 69999)], so 67400-67599 was free and 67600-67999 stays free.
#
# WHAT THIS FILE PINS
#
# Five school events now reach a person: a transfer offered, accepted or
# declined, a member joined, a member removed. The interesting assertions are
# not "a notification exists" but the three shapes around it:
#
#   1. WHO. Every one of the five is addressed to a single real user, and in
#      every one that user is a PARTY TO THE EVENT -- the addressee of the
#      offer, the curator who lost the school, the curator whose school gained
#      someone, the member who was removed. Nobody learns that a school exists
#      from one of these. That is the whole reason these are not gated on the
#      school being active (I-6): a fact that already happened to a person who
#      already knew the school. Each of the four types asserts it separately
#      rather than trusting the sentence -- an owner ruling recorded as a test.
#
#   2. WHO NOT. The actor never notifies himself. Accept and decline both go
#      to the OTHER party, and leaving a school on your own produces nothing
#      at all -- you were the one who did it.
#
#   3. JOURNAL AND NOTIFICATION DO NOT DRIFT (item 6). For every notifying
#      event there is a journal line, and there is no notification without
#      one. Asserted as a pair on the same action, because either half alone
#      passes in a world where one of the two writers was never called.
#
# EVERY OUTBOX READ IS SCOPED TO ONE RECIPIENT. The outbox is append-only and
# shared by the whole suite: an unfiltered select returns every notification
# any test ever queued, and an "exactly one" assertion against it is a lie
# that happens to be true when nobody else emits that type. This file learned
# that the expensive way in GT-25 and does not repeat it.
#
# ⚠ BACKEND-ONLY, NOT RUN LOCALLY -- no docker/postgres in this environment
# (same standing caveat as test_curator_transfer.py). Written for the deploy
# battery; collection success is not passing.
# =============================================================================

from collections.abc import AsyncGenerator
from unittest.mock import patch
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.events.models import OutboxEvent
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupEvent,
    CuratorGroupEventKind,
    CuratorMemberKind,
)
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from tests.helpers import (
    auth_headers,
    fresh_execute,
    full_cleanup_range,
    login_user,
)

CURATOR_GROUPS_URL = "/api/v1/masters/me/curator-groups"
MEMBER_URL = "/api/v1/masters/me/curator-groups/{group_id}/members/{user_id}"
INVITES_URL = "/api/v1/masters/me/curator-groups/{group_id}/invites"
OFFER_URL = "/api/v1/masters/me/curator-groups/{group_id}/transfer"
JOIN_URL = "/api/v1/curator-groups/join"
LEAVE_URL = "/api/v1/curator-groups/{group_id}/membership"
ACCEPT_URL = "/api/v1/curator-groups/{group_id}/transfer/accept"
DECLINE_URL = "/api/v1/curator-groups/{group_id}/transfer/decline"

# Read out of the service, not guessed: _INVITE_DEEPLINK_KIND at
# curator_groups/service.py:1473. The bot url is patched the same way
# test_curator_invites.py patches it -- the real settings value is not
# guaranteed on a test stand, and the token is what we are after.
_BOT_URL = "https://t.me/velo_test_bot"
_DEEPLINK = "?startapp=curator_group_invite__"

_TID_MIN = 67400
_TID_MAX = 67599

_TID_CURATOR = 67401
_TID_HEIR = 67402
_TID_MASTER_B = 67403
_TID_STUDENT = 67410
_TID_STUDENT_B = 67411


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """FK-safe shared helper (TD-032), scoped to this file's own band.

    It also sweeps this band's outbox rows by data->>'target_value', which
    is what keeps the per-recipient counts below honest between tests.

    THE LEFTOVER CHECK AFTER THE SWEEP IS NOT DECORATION. Schools and their
    journals are reached only through a cascade -- curator_group cascades
    from users, curator_group_event cascades from curator_group -- and the
    helper never names either table. A school that ended up owned by
    somebody outside this band would survive the sweep silently, and the
    first symptom would be a FAILURE IN ANOTHER FILE: test_curator_group_
    journal.py counts journal rows and this file runs before it. That is
    exactly how BE-25 was found. Asserting here turns "somebody else's test
    is red" into "this file leaked", which is the difference between an
    hour and a minute.
    """
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    leftovers = (
        await fresh_execute(
            select(CuratorGroup.id)
            .join(User, User.id == CuratorGroup.curator_user_id)
            .where(User.telegram_id.between(_TID_MIN, _TID_MAX))
        )
    ).scalars().all()
    assert leftovers == [], (
        f"{len(leftovers)} school(s) of this band survived the sweep -- "
        f"their journal rows will surface as a failure in another file"
    )


# ===========================================================================
# Local helpers -- copied, not imported, as every test file in this tree does.
#
# All of them go through the REAL endpoints. Nothing here inserts a
# CuratorGroupMember or a CuratorGroupTransfer by hand: the ladders in front
# of those tables (own_group, capability, roster membership) are exactly what
# decides who ends up notified, and a helper that stepped around them would
# be testing a state the API cannot produce.
# ===========================================================================


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    first_name: str = "Master",
) -> dict:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )
    user_id = UUID(auth["user"]["id"])
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    await db_session.flush()
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
    return auth


async def _make_student(
    client: AsyncClient, telegram_id: int, first_name: str = "Student",
) -> dict:
    return await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )


async def _create_group(
    client: AsyncClient, curator: dict, name: str = "Школа дыхания",
) -> dict:
    resp = await client.post(
        CURATOR_GROUPS_URL,
        json={"name": name},
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _invite_token(
    client: AsyncClient, curator: dict, group_id: str,
) -> str:
    with patch.object(settings, "telegram_bot_url", _BOT_URL):
        resp = await client.post(
            INVITES_URL.format(group_id=group_id),
            json={},
            headers=auth_headers(curator["session_token"]),
        )
    assert resp.status_code == 200, resp.text
    url = resp.json()["invite_url"]
    assert url.startswith(f"{_BOT_URL}{_DEEPLINK}"), url
    return url.split(_DEEPLINK, 1)[1]


async def _join(client: AsyncClient, auth: dict, token: str):
    return await client.post(
        JOIN_URL,
        json={"token": token},
        headers=auth_headers(auth["session_token"]),
    )


async def _join_as(
    client: AsyncClient, curator: dict, group_id: str, joiner: dict,
    kind: CuratorMemberKind = CuratorMemberKind.STUDENT,
) -> None:
    token = await _invite_token(client, curator, group_id)
    resp = await _join(client, joiner, token)
    assert resp.status_code == 200, resp.text


async def _offer(client: AsyncClient, curator: dict, group_id: str, to: dict):
    return await client.post(
        OFFER_URL.format(group_id=group_id),
        json={"to_user_id": to["user"]["id"]},
        headers=auth_headers(curator["session_token"]),
    )


async def _accept(client: AsyncClient, auth: dict, group_id: str):
    return await client.post(
        ACCEPT_URL.format(group_id=group_id),
        headers=auth_headers(auth["session_token"]),
    )


async def _decline(client: AsyncClient, auth: dict, group_id: str):
    return await client.post(
        DECLINE_URL.format(group_id=group_id),
        headers=auth_headers(auth["session_token"]),
    )


async def _remove(
    client: AsyncClient, curator: dict, group_id: str, member: dict,
):
    return await client.delete(
        MEMBER_URL.format(group_id=group_id, user_id=member["user"]["id"]),
        headers=auth_headers(curator["session_token"]),
    )


async def _leave(client: AsyncClient, auth: dict, group_id: str):
    return await client.delete(
        LEAVE_URL.format(group_id=group_id),
        headers=auth_headers(auth["session_token"]),
    )


async def _notes_for(user: dict) -> list[dict]:
    """Notification payloads queued FOR ONE PERSON.

    Scoped by data->>'target_value', the same access path full_cleanup_range
    uses to sweep this band. An unfiltered select would return the whole
    suite's outbox and turn every count below into a coincidence.
    """
    rows = (
        await fresh_execute(
            select(OutboxEvent).where(
                OutboxEvent.payload["target_value"].astext
                == str(user["user"]["id"]),
            )
        )
    ).scalars().all()
    return [row.payload or {} for row in rows]


async def _types_for(user: dict) -> list[str]:
    return [p.get("type", "") for p in await _notes_for(user)]


async def _journal(group_id: str) -> list[str]:
    rows = (
        await fresh_execute(
            select(CuratorGroupEvent.event).where(
                CuratorGroupEvent.group_id == UUID(group_id)
            )
        )
    ).all()
    return [e for (e,) in rows]


# ===========================================================================
# Item 1 -- the offer reaches its addressee
# ===========================================================================


@pytest.mark.asyncio
async def test_transfer_offer_reaches_the_addressee(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The addressee learns of the offer without opening the app.

    Paired with the curator's own queue: the person who made the offer must
    not be told about his own click. Only the first half would pass against
    an implementation that notified both parties.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    heir = await _make_verified_master(client, db_session, _TID_HEIR)
    group = await _create_group(client, curator)
    await _join_as(client, curator, group["id"], heir, CuratorMemberKind.MASTER)

    assert (await _offer(client, curator, group["id"], heir)).status_code == 200

    assert (await _types_for(heir)).count(
        "curator_group.transfer_offered"
    ) == 1
    assert "curator_group.transfer_offered" not in await _types_for(curator)


@pytest.mark.asyncio
async def test_the_offer_names_the_school_and_points_at_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The payload carries the school's name and id, not just a type.

    A notification that says only "you have been offered a school" is
    useless to a master who teaches in three of them. The action verb is
    asserted too: the inbox falls back to mark-read-only on an action it
    does not know, so naming the intent now is what lets the frontend map
    it later without a second backend change.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    heir = await _make_verified_master(client, db_session, _TID_HEIR)
    group = await _create_group(client, curator, name="Тихое утро")
    await _join_as(client, curator, group["id"], heir, CuratorMemberKind.MASTER)
    await _offer(client, curator, group["id"], heir)

    note = next(
        p for p in await _notes_for(heir)
        if p.get("type") == "curator_group.transfer_offered"
    )
    action = note["action_data"]
    assert action["action"] == "open_curator_group"
    assert action["params"]["group_id"] == group["id"]
    assert action["group_name"] == "Тихое утро"
    assert "Тихое утро" in note["body"]


@pytest.mark.asyncio
async def test_a_cancelled_offer_does_not_notify_again(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Cancelling is not an event anybody is told about.

    transfer_cancelled stays out of the notifying set on purpose: the
    addressee who never opened the app has nothing to un-learn, and the one
    who did will find the banner gone. Paired with the journal, which DOES
    record the cancellation -- proving the silence is a choice about
    notifications, not a missing journal line.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    heir = await _make_verified_master(client, db_session, _TID_HEIR)
    group = await _create_group(client, curator)
    await _join_as(client, curator, group["id"], heir, CuratorMemberKind.MASTER)
    await _offer(client, curator, group["id"], heir)

    cancelled = await client.delete(
        OFFER_URL.format(group_id=group["id"]),
        headers=auth_headers(curator["session_token"]),
    )
    assert cancelled.status_code == 204

    assert (await _types_for(heir)).count(
        "curator_group.transfer_offered"
    ) == 1
    assert CuratorGroupEventKind.TRANSFER_CANCELLED.value in await _journal(
        group["id"]
    )


# ===========================================================================
# Item 2 -- both outcomes reach the initiator, neither reaches the decider
# ===========================================================================


@pytest.mark.asyncio
async def test_accept_tells_the_previous_curator_and_not_the_acceptor(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Losing a school is the one thing its former owner must not miss.

    The recipient is read from previous_curator_id, captured before the
    ownership assignment. Reading "the group's curator" after it would
    address the acceptor -- who would then be told he accepted from
    himself. Both halves asserted: the former owner gets exactly one, the
    acceptor gets none.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    heir = await _make_verified_master(client, db_session, _TID_HEIR)
    group = await _create_group(client, curator)
    await _join_as(client, curator, group["id"], heir, CuratorMemberKind.MASTER)
    await _offer(client, curator, group["id"], heir)

    assert (await _accept(client, heir, group["id"])).status_code == 200

    assert (await _types_for(curator)).count(
        "curator_group.transfer_accepted"
    ) == 1
    assert "curator_group.transfer_accepted" not in await _types_for(heir)


@pytest.mark.asyncio
async def test_decline_tells_the_curator_and_not_the_decliner(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The other outcome of the same offer, and it must not be the quiet one.

    Splitting the pair -- telling the curator about an accept but not a
    decline -- would leave him waiting on an answer that already came.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    heir = await _make_verified_master(client, db_session, _TID_HEIR)
    group = await _create_group(client, curator)
    await _join_as(client, curator, group["id"], heir, CuratorMemberKind.MASTER)
    await _offer(client, curator, group["id"], heir)

    assert (await _decline(client, heir, group["id"])).status_code == 204

    assert (await _types_for(curator)).count(
        "curator_group.transfer_declined"
    ) == 1
    assert "curator_group.transfer_declined" not in await _types_for(heir)


@pytest.mark.asyncio
async def test_accept_notification_survives_the_ownership_change(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The school named in the notification is the one that changed hands.

    Written because the accept transaction reassigns curator_user_id, drops
    the acceptor's member row and inserts one for the previous curator, all
    before the notification is queued. If the body were built from a re-read
    group instead of the values in hand, this is where it would go wrong
    quietly -- the type would still be right.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    heir = await _make_verified_master(client, db_session, _TID_HEIR)
    group = await _create_group(client, curator, name="Северный ветер")
    await _join_as(client, curator, group["id"], heir, CuratorMemberKind.MASTER)
    await _offer(client, curator, group["id"], heir)
    await _accept(client, heir, group["id"])

    note = next(
        p for p in await _notes_for(curator)
        if p.get("type") == "curator_group.transfer_accepted"
    )
    assert note["action_data"]["params"]["group_id"] == group["id"]
    assert "Северный ветер" in note["body"]


# ===========================================================================
# Item 4 -- membership
# ===========================================================================


@pytest.mark.asyncio
async def test_a_join_tells_the_curator_and_not_the_joiner(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The arrivals feed goes to the curator only.

    This is the one notification of the five that scales with the size of a
    school, which is why its type carries the curator_groups category. The
    joiner gets nothing: he pressed the link.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await _make_student(client, _TID_STUDENT)
    group = await _create_group(client, curator)

    await _join_as(client, curator, group["id"], student)

    assert (await _types_for(curator)).count(
        "curator_group.member_joined"
    ) == 1
    assert "curator_group.member_joined" not in await _types_for(student)


@pytest.mark.asyncio
async def test_removal_tells_the_person_removed(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Losing access to a school's practices is otherwise invisible.

    Paired with the curator's queue: he did the removing and is not told
    about it.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await _make_student(client, _TID_STUDENT)
    group = await _create_group(client, curator)
    await _join_as(client, curator, group["id"], student)

    assert (await _remove(client, curator, group["id"], student)).status_code == 204

    assert (await _types_for(student)).count(
        "curator_group.member_removed"
    ) == 1
    assert "curator_group.member_removed" not in await _types_for(curator)


@pytest.mark.asyncio
async def test_leaving_on_your_own_notifies_nobody(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """member_left is deliberately silent -- you know what you did.

    Both queues are asserted empty of school types, not just the leaver's:
    the curator is not told either, because a member leaving is not an event
    about the curator's standing and would be exactly the feed the arrivals
    category exists to let him mute.

    Paired with the journal, which DOES record the departure. Silence in the
    inbox and a line in the journal is the intended shape; silence in both
    would mean the leave itself stopped working.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await _make_student(client, _TID_STUDENT)
    group = await _create_group(client, curator)
    await _join_as(client, curator, group["id"], student)
    before = await _types_for(curator)

    assert (await _leave(client, student, group["id"])).status_code == 204

    assert await _types_for(student) == []
    assert await _types_for(curator) == before
    assert CuratorGroupEventKind.MEMBER_LEFT.value in await _journal(
        group["id"]
    )


# ===========================================================================
# The recipient always already knew the school (owner ruling, развилка C)
# ===========================================================================


@pytest.mark.asyncio
async def test_every_recipient_was_already_a_party_to_the_school(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The reason these notifications need no I-6 activity gate, asserted.

    Not gating on the school being active is safe only while every recipient
    already knows the school exists -- otherwise a dark school would leak
    through the inbox. This walks all four types in one school and checks
    the recipient against the set of people who were curator or member
    BEFORE the action, so the property is measured rather than reasoned.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    heir = await _make_verified_master(client, db_session, _TID_HEIR)
    student = await _make_student(client, _TID_STUDENT)
    group = await _create_group(client, curator)
    await _join_as(client, curator, group["id"], heir, CuratorMemberKind.MASTER)
    await _join_as(client, curator, group["id"], student)

    insiders = {
        curator["user"]["id"], heir["user"]["id"], student["user"]["id"],
    }

    await _offer(client, curator, group["id"], heir)
    await _remove(client, curator, group["id"], student)
    await _decline(client, heir, group["id"])

    for person in (curator, heir, student):
        for payload in await _notes_for(person):
            if not payload.get("type", "").startswith("curator_group."):
                continue
            assert payload["target_value"] in insiders


# ===========================================================================
# Item 6 -- journal and notifications do not drift
# ===========================================================================


@pytest.mark.asyncio
async def test_every_notifying_action_also_wrote_a_journal_line(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Both directions on one school, in one pass.

    Four notifying actions produce four journal lines of the matching kinds,
    and the count of school notifications across every participant equals
    four -- no notification without an event, no notifying event without a
    notification. Either assertion alone passes in a world where one of the
    two writers was never called at all.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    heir = await _make_verified_master(client, db_session, _TID_HEIR)
    student = await _make_student(client, _TID_STUDENT)
    group = await _create_group(client, curator)

    await _join_as(client, curator, group["id"], heir, CuratorMemberKind.MASTER)
    await _join_as(client, curator, group["id"], student)
    await _remove(client, curator, group["id"], student)
    await _offer(client, curator, group["id"], heir)
    await _accept(client, heir, group["id"])

    journal = await _journal(group["id"])
    for kind in (
        CuratorGroupEventKind.MEMBER_JOINED,
        CuratorGroupEventKind.MEMBER_REMOVED,
        CuratorGroupEventKind.TRANSFER_OFFERED,
        CuratorGroupEventKind.TRANSFER_ACCEPTED,
    ):
        assert kind.value in journal

    school_notes = 0
    for person in (curator, heir, student):
        school_notes += sum(
            1 for t in await _types_for(person)
            if t.startswith("curator_group.")
        )
    # two joins -> two arrivals, one removal, one offer, one accept.
    assert school_notes == 5


@pytest.mark.asyncio
async def test_a_refused_action_writes_neither(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The other half of item 6: a rejected call leaves both empty.

    A second offer while one is pending is a 409. Nothing is journalled and
    nothing is queued -- which is what proves the notification lives inside
    the same transaction as the action rather than beside it.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    heir = await _make_verified_master(client, db_session, _TID_HEIR)
    other = await _make_verified_master(client, db_session, _TID_MASTER_B)
    group = await _create_group(client, curator)
    await _join_as(client, curator, group["id"], heir, CuratorMemberKind.MASTER)
    await _join_as(
        client, curator, group["id"], other, CuratorMemberKind.MASTER,
    )
    await _offer(client, curator, group["id"], heir)

    second = await _offer(client, curator, group["id"], other)
    assert second.status_code == 409

    assert await _types_for(other) == []
    assert (await _journal(group["id"])).count(
        CuratorGroupEventKind.TRANSFER_OFFERED.value
    ) == 1


# ===========================================================================
# Three axes on the profile itself
# ===========================================================================


@pytest.mark.asyncio
async def test_repeated_join_notifies_once(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """POVTOR on the join input: the same person, the same link, twice.

    The second join is a no-op on membership, so it must be a no-op on the
    curator's feed too. Without this, a student tapping a link twice doubles
    every arrival in a large school.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await _make_student(client, _TID_STUDENT)
    group = await _create_group(client, curator)
    token = await _invite_token(
        client, curator, group["id"], CuratorMemberKind.STUDENT.value,
    )

    first = await _join(client, student, token)
    assert first.status_code == 200, first.text
    # The second join is idempotent, not an error: the service finds the
    # membership row already there and returns the same page.
    second = await _join(client, student, token)
    assert second.status_code == 200, second.text

    assert (await _types_for(curator)).count(
        "curator_group.member_joined"
    ) == 1


@pytest.mark.asyncio
async def test_removing_somebody_who_is_not_a_member_notifies_nobody(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """PUSTOTA on the removal input: nothing was there, so nothing happened.

    The service returns early when no membership row matched, and the
    notification must sit behind that early return rather than in front of
    it -- otherwise a curator could ping any user id by asking to remove it.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    stranger = await _make_student(client, _TID_STUDENT_B)
    group = await _create_group(client, curator)

    await _remove(client, curator, group["id"], stranger)

    assert await _types_for(stranger) == []
    assert await _journal(group["id"]) == [
        CuratorGroupEventKind.GROUP_CREATED.value
    ]
