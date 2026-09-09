# =============================================================================
# VELO Backend -- Tests: appointing a school master (GT-27)
# =============================================================================
#
# telegram_id band: 67600-67799, declared module-level as _TID_MIN/_TID_MAX
# ONCE -- tests/telegram_id_bands.py parses that declaration out of the AST.
# Re-checked against the live registry rather than assumed:
# free_windows(space=(67600, 69999)) returned [(67600, 67999), (68400, 68999),
# (69100, 69999)], so 67600-67799 was free and 67800-67999 stays free.
#
# WHAT REPLACED WHAT. A school used to have two invite links, and the master
# one promoted an existing student to kind='master' on join. Cancelled by
# owner ruling: the curator APPOINTS, and the appointment takes effect only
# when the appointee confirms. Eleven tests left test_curator_invites.py and
# two left test_curator_group_journal.py with that link.
#
# FIVE PROPERTIES CAME WITH THEM, AND THIS FILE IS WHERE THEY LIVE NOW.
# This list is the point of the header: a deleted test is visible in the
# diff, a property that quietly stopped being checked is not. Each line is
# what the old test proved and where it is proved again:
#
#   1. CAPABILITY, NOT ROLE -- a verified master browsing in user mode is
#      still a master. Was test_capability_not_role_admits_a_master_browsing
#      _as_a_user; now test_a_master_browsing_as_a_user_can_still_be_appointed.
#   2. A NON-MASTER IS REFUSED with master_required. Was
#      test_plain_user_is_refused_by_the_master_link; now
#      test_a_plain_user_cannot_be_appointed.
#   3. CAPABILITY IS CHECKED *NOW*, not once -- a revoked verification
#      refuses. Was test_a_suspended_master_is_refused_by_the_master_link...;
#      now test_a_candidate_who_lost_verification_cannot_be_appointed.
#   4. joined_at IS NOT REFRESHED when kind changes -- the person has been in
#      the school since the day they walked in, and kind describes their
#      role, not their arrival. Was test_a_student_member_is_upgraded_by_the
#      _master_link; now test_accepting_changes_the_kind_and_not_the_arrival.
#   5. CAPABILITY IS CHECKED EVEN FOR SOMEONE ALREADY INSIDE. Was
#      test_a_suspended_master_member_cannot_use_the_master_link; now
#      test_verification_lost_between_offer_and_consent_refuses_but_keeps_it.
#
# THE TWO REFUSALS THAT KEEP THE OFFER. A dark school and a lapsed
# verification are both TEMPORARY conditions about somebody's status, not
# verdicts on the appointment -- so both refuse and both leave the row
# alone. Re-verify and the offer is still there. Being removed from the
# school is different and deletes it: the offer had nothing left to change.
#
# ⚠ BACKEND-ONLY, NOT RUN LOCALLY -- no docker/postgres in this environment.
# Written for the deploy battery; collection success is not passing.
# =============================================================================

from collections.abc import AsyncGenerator
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events.models import OutboxEvent
from app.modules.curator_groups.models import (
    CuratorGroupEvent,
    CuratorGroupEventKind,
    CuratorGroupMasterOffer,
    CuratorGroupMember,
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

GROUPS_URL = "/api/v1/masters/me/curator-groups"
OFFER_URL = "/api/v1/masters/me/curator-groups/{group_id}/master-offers"
ACCEPT_URL = "/api/v1/curator-groups/{group_id}/master-offer/accept"
DECLINE_URL = "/api/v1/curator-groups/{group_id}/master-offer/decline"

_TID_MIN = 67600
_TID_MAX = 67799

_TID_CURATOR = 67601
_TID_OTHER_CURATOR = 67602
_TID_CANDIDATE = 67610
_TID_SECOND = 67611
_TID_PLAIN = 67620


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """FK-safe shared helper (TD-032), scoped to this file's own band.

    Schools and their offers are reached only through cascades -- the helper
    names no curator table. The leftover check after the sweep is the same
    guard BE-25 added for the same reason: a school of this band surviving
    would surface as a failure in another file, and this file runs first.
    """
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ===========================================================================
# Helpers -- every one goes through a real endpoint or the model the endpoint
# writes. Nothing invents a state the API cannot produce.
# ===========================================================================


async def _master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
    *, verified: bool = True, can_create: bool = True, role_user: bool = False,
) -> dict:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=f"M{telegram_id}",
    )
    uid = UUID(auth["user"]["id"])
    user = await db_session.get(User, uid)
    user.role = UserRole.USER if role_user else UserRole.MASTER
    await db_session.flush()
    db_session.add(
        MasterProfile(
            user_id=uid,
            data={
                "account": {
                    "status": "verified" if verified else "suspended",
                    "can_create_groups": can_create,
                },
                "profile": {"bio": "m"},
            },
        )
    )
    await db_session.flush()
    await db_session.commit()
    return auth


async def _plain(client: AsyncClient, telegram_id: int) -> dict:
    return await login_user(
        client, telegram_id=telegram_id, first_name="Plain",
    )


async def _unverify(db_session: AsyncSession, auth: dict) -> None:
    profile = await db_session.get(MasterProfile, UUID(auth["user"]["id"]))
    profile.data = {
        **profile.data,
        "account": {**profile.data["account"], "status": "suspended"},
    }
    await db_session.flush()
    await db_session.commit()


async def _school(client: AsyncClient, curator: dict) -> str:
    resp = await client.post(
        GROUPS_URL,
        json={"name": f"Школа {curator['user']['id'][:6]}"},
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _seed_member(
    db_session: AsyncSession, group_id: str, auth: dict,
    kind: CuratorMemberKind = CuratorMemberKind.STUDENT,
) -> None:
    db_session.add(
        CuratorGroupMember(
            group_id=UUID(group_id),
            user_id=UUID(auth["user"]["id"]),
            kind=kind.value,
        )
    )
    await db_session.flush()
    await db_session.commit()


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


async def _offers(group_id: str) -> list[UUID]:
    return list(
        (
            await fresh_execute(
                select(CuratorGroupMasterOffer.to_user_id).where(
                    CuratorGroupMasterOffer.group_id == UUID(group_id)
                )
            )
        ).scalars().all()
    )


async def _kind_of(group_id: str, auth: dict) -> str | None:
    return (
        await fresh_execute(
            select(CuratorGroupMember.kind).where(
                CuratorGroupMember.group_id == UUID(group_id),
                CuratorGroupMember.user_id == UUID(auth["user"]["id"]),
            )
        )
    ).scalar_one_or_none()


async def _journal(group_id: str) -> list[str]:
    rows = (
        await fresh_execute(
            select(CuratorGroupEvent.event).where(
                CuratorGroupEvent.group_id == UUID(group_id)
            )
        )
    ).all()
    return [e for (e,) in rows]


async def _types_for(auth: dict) -> list[str]:
    """Notification types queued FOR ONE PERSON.

    Scoped by data->>'target_value', the same access path full_cleanup_range
    uses. An unfiltered select returns the whole suite's outbox and turns
    every count here into a coincidence -- BE-25 learned that the hard way.
    """
    rows = (
        await fresh_execute(
            select(OutboxEvent).where(
                OutboxEvent.payload["target_value"].astext
                == str(auth["user"]["id"]),
            )
        )
    ).scalars().all()
    return [(r.payload or {}).get("type", "") for r in rows]


# ===========================================================================
# The appointment itself
# ===========================================================================


@pytest.mark.asyncio
async def test_the_curator_appoints_and_nothing_changes_until_consent(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The whole design in one test: an offer is made, the roster does not move.

    Both halves matter. Only the first would pass against an implementation
    that promoted on the spot -- which is exactly the cancelled behaviour of
    the master link this replaces.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    group = await _school(client, curator)
    await _seed_member(db_session, group, cand)

    assert (await _offer(client, curator, group, cand)).status_code == 204

    assert await _offers(group) == [UUID(cand["user"]["id"])]
    assert await _kind_of(group, cand) == CuratorMemberKind.STUDENT.value
    assert CuratorGroupEventKind.MEMBER_PROMOTED.value not in await _journal(
        group
    )


@pytest.mark.asyncio
async def test_accepting_changes_the_kind_and_not_the_arrival(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Property 4, moved here from the master-link upgrade test.

    joined_at is NOT refreshed: the person has been in this school since the
    day they walked in, and kind describes their role, not their arrival.
    Asserted by reading joined_at before and after, not by trusting that
    nothing in the accept path touches it.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    group = await _school(client, curator)
    await _seed_member(db_session, group, cand)
    before = (
        await fresh_execute(
            select(CuratorGroupMember.joined_at).where(
                CuratorGroupMember.group_id == UUID(group),
                CuratorGroupMember.user_id == UUID(cand["user"]["id"]),
            )
        )
    ).scalar_one()

    await _offer(client, curator, group, cand)
    assert (await _accept(client, cand, group)).status_code == 204

    assert await _kind_of(group, cand) == CuratorMemberKind.MASTER.value
    after = (
        await fresh_execute(
            select(CuratorGroupMember.joined_at).where(
                CuratorGroupMember.group_id == UUID(group),
                CuratorGroupMember.user_id == UUID(cand["user"]["id"]),
            )
        )
    ).scalar_one()
    assert after == before
    assert await _offers(group) == []
    assert CuratorGroupEventKind.MEMBER_PROMOTED.value in await _journal(group)


@pytest.mark.asyncio
async def test_declining_changes_nothing_and_removes_the_offer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The other outcome, and the roster must be untouched by it."""
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    group = await _school(client, curator)
    await _seed_member(db_session, group, cand)
    await _offer(client, curator, group, cand)

    assert (await _decline(client, cand, group)).status_code == 204

    assert await _offers(group) == []
    assert await _kind_of(group, cand) == CuratorMemberKind.STUDENT.value
    assert CuratorGroupEventKind.MASTER_OFFER_DECLINED.value in (
        await _journal(group)
    )
    assert CuratorGroupEventKind.MEMBER_PROMOTED.value not in await _journal(
        group
    )


@pytest.mark.asyncio
async def test_a_repeated_offer_is_not_a_second_row(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Idempotent per candidate, unlike a transfer, which answers 409.

    Paired with the journal: a second press must not add a line saying the
    curator decided twice when they decided once.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    group = await _school(client, curator)
    await _seed_member(db_session, group, cand)

    assert (await _offer(client, curator, group, cand)).status_code == 204
    assert (await _offer(client, curator, group, cand)).status_code == 204

    assert await _offers(group) == [UUID(cand["user"]["id"])]
    assert (await _journal(group)).count(
        CuratorGroupEventKind.MASTER_OFFERED.value
    ) == 1


@pytest.mark.asyncio
async def test_two_candidates_may_be_outstanding_at_once(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """UNIQUE (group_id, to_user_id), not UNIQUE (group_id).

    This is the one place the appointment differs from the transfer it
    mirrors: a school changes hands once, but appointing two teachers in the
    same week is ordinary. Without this test the constraint could be
    tightened to the transfer's shape and nothing would notice.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    a = await _master(client, db_session, _TID_CANDIDATE)
    b = await _master(client, db_session, _TID_SECOND)
    group = await _school(client, curator)
    await _seed_member(db_session, group, a)
    await _seed_member(db_session, group, b)

    assert (await _offer(client, curator, group, a)).status_code == 204
    assert (await _offer(client, curator, group, b)).status_code == 204

    assert sorted(await _offers(group)) == sorted(
        [UUID(a["user"]["id"]), UUID(b["user"]["id"])]
    )


# ===========================================================================
# Who may be appointed -- properties 1, 2, 3
# ===========================================================================


@pytest.mark.asyncio
async def test_a_master_browsing_as_a_user_can_still_be_appointed(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Property 1: CAPABILITY, not role.

    A verified master who happens to be looking at the app in user mode is
    still a teacher -- the profile is what makes them one, the role is only
    which zone they are reading. Moved here from the master-link test that
    proved the same thing about joining.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE, role_user=True)
    group = await _school(client, curator)
    await _seed_member(db_session, group, cand)

    role = (
        await fresh_execute(
            select(User.role).where(User.id == UUID(cand["user"]["id"]))
        )
    ).scalar_one()
    assert str(role) in (UserRole.USER.value, str(UserRole.USER))

    assert (await _offer(client, curator, group, cand)).status_code == 204


@pytest.mark.asyncio
async def test_a_plain_user_cannot_be_appointed(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Property 2: a member who is not a master of the platform is refused.

    403 master_required, and the offer is not created -- paired, because a
    refusal that still wrote the row would surface only when somebody
    accepted it.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    plain = await _plain(client, _TID_PLAIN)
    group = await _school(client, curator)
    await _seed_member(db_session, group, plain)

    resp = await _offer(client, curator, group, plain)
    assert resp.status_code == 403
    assert resp.json()["error"] == "master_required"
    assert await _offers(group) == []


@pytest.mark.asyncio
async def test_a_candidate_who_lost_verification_cannot_be_appointed(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Property 3: capability is read NOW, not once and remembered."""
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    group = await _school(client, curator)
    await _seed_member(db_session, group, cand)
    await _unverify(db_session, cand)

    resp = await _offer(client, curator, group, cand)
    assert resp.status_code == 403
    assert resp.json()["error"] == "master_required"
    assert await _offers(group) == []


@pytest.mark.asyncio
async def test_verification_lost_between_offer_and_consent_refuses_but_keeps_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Property 5, and the reason the gate cannot be walked around by waiting.

    Checking capability only at the offer would let a candidate be appointed
    while verified and confirm a week later without it. The refusal is
    temporary in both directions: the OFFER SURVIVES, so re-verifying
    restores the ability to accept something genuinely offered.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    group = await _school(client, curator)
    await _seed_member(db_session, group, cand)
    await _offer(client, curator, group, cand)
    await _unverify(db_session, cand)

    resp = await _accept(client, cand, group)
    assert resp.status_code == 403
    assert resp.json()["error"] == "master_required"
    assert await _kind_of(group, cand) == CuratorMemberKind.STUDENT.value
    # The half that makes this a refusal and not a cancellation.
    assert await _offers(group) == [UUID(cand["user"]["id"])]


@pytest.mark.asyncio
async def test_appointing_a_master_of_the_school_is_409(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Nothing to appoint. 409 follows the transfer's precedent, not 400."""
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    group = await _school(client, curator)
    await _seed_member(db_session, group, cand, CuratorMemberKind.MASTER)

    resp = await _offer(client, curator, group, cand)
    assert resp.status_code == 409
    assert resp.json()["error"] == "already_master"
    assert await _offers(group) == []


# ===========================================================================
# Who may appoint -- and every refusal indistinguishable from "no school"
# ===========================================================================


async def _missing_code(client: AsyncClient, auth: dict) -> str:
    """The code a school that does not exist returns, sampled live.

    Sampled rather than hardcoded: this is the baseline the other refusals
    are compared against, and a hardcoded one could drift apart from the
    real answer without any test noticing -- which is the drift P-08 guards.
    """
    resp = await client.post(
        OFFER_URL.format(group_id=uuid4()),
        json={"to_user_id": str(uuid4())},
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 404
    return resp.json()["error"]


@pytest.mark.asyncio
async def test_a_stranger_curator_gets_the_missing_school_answer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """404 with the SAME code a nonexistent school returns.

    Status alone is not the assertion: a distinct code would keep the 404
    and still tell the caller that the school exists and is merely somebody
    else's.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    other = await _master(client, db_session, _TID_OTHER_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    group = await _school(client, curator)
    await _seed_member(db_session, group, cand)

    baseline = await _missing_code(client, other)
    resp = await _offer(client, other, group, cand)
    assert resp.status_code == 404
    assert resp.json()["error"] == baseline
    assert await _offers(group) == []


@pytest.mark.asyncio
async def test_appointing_somebody_who_is_not_in_the_school_is_the_same_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """"Not a member" and "no such school" are one answer.

    The curator already knows their own roster, so distinguishing the two
    buys nothing and leaks whether a given account exists.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    outsider = await _master(client, db_session, _TID_CANDIDATE)
    group = await _school(client, curator)

    baseline = await _missing_code(client, curator)
    resp = await _offer(client, curator, group, outsider)
    assert resp.status_code == 404
    assert resp.json()["error"] == baseline


# ===========================================================================
# Answering an offer that is not, or no longer, yours
# ===========================================================================


@pytest.mark.asyncio
async def test_accepting_twice_finds_nothing_the_second_time(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The row IS the offer, so the second accept has nothing to consume."""
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    group = await _school(client, curator)
    await _seed_member(db_session, group, cand)
    await _offer(client, curator, group, cand)

    assert (await _accept(client, cand, group)).status_code == 204
    second = await _accept(client, cand, group)
    assert second.status_code == 404
    assert second.json()["error"] == "master_offer_not_found"


@pytest.mark.asyncio
async def test_declining_something_never_offered_is_204_and_writes_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """204 where accept answers 404, the same asymmetry transfer uses.

    Refusing something never offered leaves the world in the state you asked
    for, so success is honest and reveals nothing. Paired with the journal:
    honest does not mean recorded.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    group = await _school(client, curator)
    await _seed_member(db_session, group, cand)

    assert (await _decline(client, cand, group)).status_code == 204
    assert CuratorGroupEventKind.MASTER_OFFER_DECLINED.value not in (
        await _journal(group)
    )


@pytest.mark.asyncio
async def test_a_non_member_cannot_accept_an_offer_made_to_somebody_else(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Offers are per person; being in the school is not being the addressee."""
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    bystander = await _master(client, db_session, _TID_SECOND)
    group = await _school(client, curator)
    await _seed_member(db_session, group, cand)
    await _seed_member(db_session, group, bystander)
    await _offer(client, curator, group, cand)

    resp = await _accept(client, bystander, group)
    assert resp.status_code == 404
    assert await _kind_of(group, bystander) == CuratorMemberKind.STUDENT.value
    assert await _offers(group) == [UUID(cand["user"]["id"])]


@pytest.mark.asyncio
async def test_a_dark_school_refuses_the_consent_and_keeps_the_offer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """I-6 holds on this path, and it holds for a reason worth naming.

    The invariant is not that the activity gate is everywhere -- the
    curator-side write helpers do not carry it. It holds because consent
    goes through _relation_or_404, which does. The refusal is a 404 like
    everything else about a dark school, and the OFFER SURVIVES: the
    curator's verification can come back, and the appointment with it.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    group = await _school(client, curator)
    await _seed_member(db_session, group, cand)
    await _offer(client, curator, group, cand)
    await _unverify(db_session, curator)

    assert (await _accept(client, cand, group)).status_code == 404
    assert await _kind_of(group, cand) == CuratorMemberKind.STUDENT.value
    assert await _offers(group) == [UUID(cand["user"]["id"])]


@pytest.mark.asyncio
async def test_removal_from_the_school_kills_the_offer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Unlike the two temporary refusals, this one is not coming back.

    The offer was going to change a membership row that no longer exists, so
    accepting deletes it rather than keeping it warm. Contrast asserted
    against the dark-school test above: same 404, different fate for the row.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    group = await _school(client, curator)
    await _seed_member(db_session, group, cand)
    await _offer(client, curator, group, cand)

    await db_session.execute(
        CuratorGroupMember.__table__.delete().where(
            CuratorGroupMember.group_id == UUID(group),
            CuratorGroupMember.user_id == UUID(cand["user"]["id"]),
        )
    )
    await db_session.commit()

    assert (await _accept(client, cand, group)).status_code == 404
    assert await _offers(group) == []


# ===========================================================================
# Notifications and the journal (item 7: neither drifts from the other)
# ===========================================================================


@pytest.mark.asyncio
async def test_the_candidate_is_told_and_the_curator_is_not(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The offer goes to the person it is about; the curator pressed it."""
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    group = await _school(client, curator)
    await _seed_member(db_session, group, cand)

    await _offer(client, curator, group, cand)

    assert (await _types_for(cand)).count(
        "curator_group.master_offered"
    ) == 1
    assert "curator_group.master_offered" not in await _types_for(curator)


@pytest.mark.asyncio
async def test_both_outcomes_reach_the_curator_and_not_the_decider(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Accept and decline are one rule with two endings.

    Two schools rather than two rounds on one, so each outcome is counted in
    a queue that saw exactly one appointment.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    taker = await _master(client, db_session, _TID_CANDIDATE)
    refuser = await _master(client, db_session, _TID_SECOND)
    group = await _school(client, curator)
    await _seed_member(db_session, group, taker)
    await _seed_member(db_session, group, refuser)

    await _offer(client, curator, group, taker)
    await _offer(client, curator, group, refuser)
    await _accept(client, taker, group)
    await _decline(client, refuser, group)

    curator_types = await _types_for(curator)
    assert curator_types.count("curator_group.master_offer_accepted") == 1
    assert curator_types.count("curator_group.master_offer_declined") == 1
    assert "curator_group.master_offer_accepted" not in await _types_for(taker)
    assert "curator_group.master_offer_declined" not in await _types_for(
        refuser
    )


@pytest.mark.asyncio
async def test_no_notification_without_a_journal_line_and_the_reverse(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Item 7 on this delivery's own events, both directions in one pass.

    Three writing actions produce three journal lines and three school
    notifications; a refused action produces neither. Either assertion alone
    passes in a world where one of the two writers was never called.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    taker = await _master(client, db_session, _TID_CANDIDATE)
    refuser = await _master(client, db_session, _TID_SECOND)
    plain = await _plain(client, _TID_PLAIN)
    group = await _school(client, curator)
    for who in (taker, refuser, plain):
        await _seed_member(db_session, group, who)

    await _offer(client, curator, group, taker)
    await _offer(client, curator, group, refuser)
    await _accept(client, taker, group)
    await _decline(client, refuser, group)
    refused = await _offer(client, curator, group, plain)
    assert refused.status_code == 403

    journal = await _journal(group)
    assert journal.count(CuratorGroupEventKind.MASTER_OFFERED.value) == 2
    assert journal.count(CuratorGroupEventKind.MEMBER_PROMOTED.value) == 1
    assert journal.count(
        CuratorGroupEventKind.MASTER_OFFER_DECLINED.value
    ) == 1

    school_notes = 0
    for who in (curator, taker, refuser, plain):
        school_notes += sum(
            1 for t in await _types_for(who)
            if t.startswith("curator_group.master_offer")
        )
    # two offers + one accepted + one declined; the refusal wrote nothing.
    assert school_notes == 4
    assert await _types_for(plain) == []


# ===========================================================================
# Three axes on the inputs this delivery adds
# ===========================================================================


@pytest.mark.asyncio
async def test_offer_body_axes(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """PUSTOTA / NEHVATKA on to_user_id.

    An absent field and a non-uuid are both rejected by FastAPI before the
    service is reached -- asserted so that a later hand-rolled parse cannot
    quietly turn either into a 500.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    group = await _school(client, curator)
    headers = auth_headers(curator["session_token"])

    empty = await client.post(
        OFFER_URL.format(group_id=group), json={}, headers=headers,
    )
    assert empty.status_code == 422

    garbage = await client.post(
        OFFER_URL.format(group_id=group),
        json={"to_user_id": "not-a-uuid"},
        headers=headers,
    )
    assert garbage.status_code == 422


@pytest.mark.asyncio
async def test_consent_axes_repeat_and_empty(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """POVTOR / PUSTOTA on the decision.

    Declining twice is 204 both times -- the second changes nothing and says
    so. Accepting a school that never had an offer is the 404 baseline.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    group = await _school(client, curator)
    await _seed_member(db_session, group, cand)
    await _offer(client, curator, group, cand)

    assert (await _decline(client, cand, group)).status_code == 204
    assert (await _decline(client, cand, group)).status_code == 204
    assert (await _accept(client, cand, group)).status_code == 404


@pytest.mark.asyncio
async def test_a_plain_user_who_is_not_a_master_cannot_appoint_at_all(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """403 from the master guard, before the ladder -- not 404.

    Same shape as BE-25: the guard tells a person about their OWN status,
    which is not somebody else's secret. Asserting 404 here would demand a
    change to a dependency every master endpoint shares.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    group = await _school(client, curator)
    await _seed_member(db_session, group, cand)
    plain = await _plain(client, _TID_PLAIN)

    resp = await client.post(
        OFFER_URL.format(group_id=group),
        json={"to_user_id": cand["user"]["id"]},
        headers=auth_headers(plain["session_token"]),
    )
    assert resp.status_code == 403
    assert await _offers(group) == []
