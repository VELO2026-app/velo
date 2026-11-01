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
# when the appointee confirms. Eleven tests left test_school_invites.py and
# two left test_school_journal.py with that link.
#
# FIVE PROPERTIES CAME WITH THEM, AND THIS FILE IS WHERE THEY LIVE NOW.
# This list is the point of the header: a deleted test is visible in the
# diff, a property that quietly stopped being checked is not. Each line is
# what the old test proved and where it is proved again:
#
#   1. CAPABILITY, NOT ROLE -- a verified master browsing in user mode is
#      still a master. Was test_capability_not_role_admits_a_master_browsing
#      _as_a_user; now test_a_master_browsing_as_a_user_can_still_be_appointed.
#   2. A NON-MASTER IS NOT MADE A MASTER BY THE OFFER. Was
#      test_plain_user_is_refused_by_the_master_link, then
#      test_a_plain_user_cannot_be_appointed (403 master_required); since
#      BE-59 the offer is KEPT, awaiting verification, and the person is
#      asked to get verified -- now
#      test_a_plain_user_is_appointed_pending_verification.
#   3. CAPABILITY IS CHECKED *NOW*, not once -- a revoked verification
#      decides what the offer is. Was
#      test_a_suspended_master_is_refused_by_the_master_link..., then
#      test_a_candidate_who_lost_verification_cannot_be_appointed (403);
#      now test_a_candidate_who_lost_verification_is_asked_to_get_verified.
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
from app.modules.masters.models import MasterProfile
from app.modules.schools.models import (
    SchoolEvent,
    SchoolEventKind,
    SchoolMasterOffer,
    SchoolMember,
    SchoolMemberKind,
)
from app.modules.users.models import User, UserRole
from tests.helpers import (
    auth_headers,
    fresh_execute,
    full_cleanup_range,
    login_user,
)

SCHOOLS_URL = "/api/v1/masters/me/schools"
OFFER_URL = "/api/v1/masters/me/schools/{school_id}/master-offers"
ACCEPT_URL = "/api/v1/schools/{school_id}/master-offer/accept"
DECLINE_URL = "/api/v1/schools/{school_id}/master-offer/decline"

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
                    "can_create_schools": can_create,
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
        SCHOOLS_URL,
        json={"name": f"Школа {curator['user']['id'][:6]}"},
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _seed_member(
    db_session: AsyncSession, school_id: str, auth: dict,
    kind: SchoolMemberKind = SchoolMemberKind.STUDENT,
) -> None:
    db_session.add(
        SchoolMember(
            school_id=UUID(school_id),
            user_id=UUID(auth["user"]["id"]),
            kind=kind.value,
        )
    )
    await db_session.flush()
    await db_session.commit()


async def _offer(client: AsyncClient, curator: dict, school_id: str, to: dict):
    return await client.post(
        OFFER_URL.format(school_id=school_id),
        json={"to_user_id": to["user"]["id"]},
        headers=auth_headers(curator["session_token"]),
    )


async def _accept(client: AsyncClient, auth: dict, school_id: str):
    return await client.post(
        ACCEPT_URL.format(school_id=school_id),
        headers=auth_headers(auth["session_token"]),
    )


async def _decline(client: AsyncClient, auth: dict, school_id: str):
    return await client.post(
        DECLINE_URL.format(school_id=school_id),
        headers=auth_headers(auth["session_token"]),
    )


async def _offers(school_id: str) -> list[UUID]:
    return list(
        (
            await fresh_execute(
                select(SchoolMasterOffer.to_user_id).where(
                    SchoolMasterOffer.school_id == UUID(school_id)
                )
            )
        ).scalars().all()
    )


async def _kind_of(school_id: str, auth: dict) -> str | None:
    return (
        await fresh_execute(
            select(SchoolMember.kind).where(
                SchoolMember.school_id == UUID(school_id),
                SchoolMember.user_id == UUID(auth["user"]["id"]),
            )
        )
    ).scalar_one_or_none()


async def _journal(school_id: str) -> list[str]:
    rows = (
        await fresh_execute(
            select(SchoolEvent.event).where(
                SchoolEvent.school_id == UUID(school_id)
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
    school = await _school(client, curator)
    await _seed_member(db_session, school, cand)

    assert (await _offer(client, curator, school, cand)).status_code == 204

    assert await _offers(school) == [UUID(cand["user"]["id"])]
    assert await _kind_of(school, cand) == SchoolMemberKind.STUDENT.value
    assert SchoolEventKind.MEMBER_PROMOTED.value not in await _journal(
        school
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
    school = await _school(client, curator)
    await _seed_member(db_session, school, cand)
    before = (
        await fresh_execute(
            select(SchoolMember.joined_at).where(
                SchoolMember.school_id == UUID(school),
                SchoolMember.user_id == UUID(cand["user"]["id"]),
            )
        )
    ).scalar_one()

    await _offer(client, curator, school, cand)
    assert (await _accept(client, cand, school)).status_code == 204

    assert await _kind_of(school, cand) == SchoolMemberKind.MASTER.value
    after = (
        await fresh_execute(
            select(SchoolMember.joined_at).where(
                SchoolMember.school_id == UUID(school),
                SchoolMember.user_id == UUID(cand["user"]["id"]),
            )
        )
    ).scalar_one()
    assert after == before
    assert await _offers(school) == []
    assert SchoolEventKind.MEMBER_PROMOTED.value in await _journal(school)


@pytest.mark.asyncio
async def test_declining_changes_nothing_and_removes_the_offer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The other outcome, and the roster must be untouched by it."""
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    school = await _school(client, curator)
    await _seed_member(db_session, school, cand)
    await _offer(client, curator, school, cand)

    assert (await _decline(client, cand, school)).status_code == 204

    assert await _offers(school) == []
    assert await _kind_of(school, cand) == SchoolMemberKind.STUDENT.value
    assert SchoolEventKind.MASTER_OFFER_DECLINED.value in (
        await _journal(school)
    )
    assert SchoolEventKind.MEMBER_PROMOTED.value not in await _journal(
        school
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
    school = await _school(client, curator)
    await _seed_member(db_session, school, cand)

    assert (await _offer(client, curator, school, cand)).status_code == 204
    assert (await _offer(client, curator, school, cand)).status_code == 204

    assert await _offers(school) == [UUID(cand["user"]["id"])]
    assert (await _journal(school)).count(
        SchoolEventKind.MASTER_OFFERED.value
    ) == 1


@pytest.mark.asyncio
async def test_two_candidates_may_be_outstanding_at_once(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """UNIQUE (school_id, to_user_id), not UNIQUE (school_id).

    This is the one place the appointment differs from the transfer it
    mirrors: a school changes hands once, but appointing two teachers in the
    same week is ordinary. Without this test the constraint could be
    tightened to the transfer's shape and nothing would notice.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    a = await _master(client, db_session, _TID_CANDIDATE)
    b = await _master(client, db_session, _TID_SECOND)
    school = await _school(client, curator)
    await _seed_member(db_session, school, a)
    await _seed_member(db_session, school, b)

    assert (await _offer(client, curator, school, a)).status_code == 204
    assert (await _offer(client, curator, school, b)).status_code == 204

    assert sorted(await _offers(school)) == sorted(
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
    school = await _school(client, curator)
    await _seed_member(db_session, school, cand)

    role = (
        await fresh_execute(
            select(User.role).where(User.id == UUID(cand["user"]["id"]))
        )
    ).scalar_one()
    assert str(role) in (UserRole.USER.value, str(UserRole.USER))

    assert (await _offer(client, curator, school, cand)).status_code == 204


@pytest.mark.asyncio
async def test_a_plain_user_is_appointed_pending_verification(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Property 2: a member who is not a master of the platform stays a student.

    WAS: 403 master_required and no offer -- right while the owner's model
    refused such an appointment. BE-59 made it the first step of the flow
    instead: the offer is kept and the person is asked to get verified.
    What still holds, and is asserted, is that the offer makes nobody a
    master -- the kind stays student -- and that the prompt is the
    verification one, NOT "become a master? yes / no".
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    plain = await _plain(client, _TID_PLAIN)
    school = await _school(client, curator)
    await _seed_member(db_session, school, plain)

    resp = await _offer(client, curator, school, plain)
    assert resp.status_code == 204, resp.text
    assert await _offers(school) == [UUID(plain["user"]["id"])]
    assert await _kind_of(school, plain) == SchoolMemberKind.STUDENT.value
    types = await _types_for(plain)
    assert types == ["school.master_verification_required"]


@pytest.mark.asyncio
async def test_a_candidate_who_lost_verification_is_asked_to_get_verified(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Property 3: capability is read NOW, not once and remembered.

    WAS: 403 for a suspended candidate. Since BE-59 the same live read
    decides which prompt goes out: the verification one, because the
    profile is suspended NOW, though it was verified when they joined.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    school = await _school(client, curator)
    await _seed_member(db_session, school, cand)
    await _unverify(db_session, cand)

    resp = await _offer(client, curator, school, cand)
    assert resp.status_code == 204, resp.text
    assert await _offers(school) == [UUID(cand["user"]["id"])]
    assert await _types_for(cand) == [
        "school.master_verification_required",
    ]


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
    school = await _school(client, curator)
    await _seed_member(db_session, school, cand)
    await _offer(client, curator, school, cand)
    await _unverify(db_session, cand)

    resp = await _accept(client, cand, school)
    assert resp.status_code == 403
    assert resp.json()["error"] == "master_required"
    assert await _kind_of(school, cand) == SchoolMemberKind.STUDENT.value
    # The half that makes this a refusal and not a cancellation.
    assert await _offers(school) == [UUID(cand["user"]["id"])]


@pytest.mark.asyncio
async def test_appointing_a_master_of_the_school_is_409(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Nothing to appoint. 409 follows the transfer's precedent, not 400."""
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    school = await _school(client, curator)
    await _seed_member(db_session, school, cand, SchoolMemberKind.MASTER)

    resp = await _offer(client, curator, school, cand)
    assert resp.status_code == 409
    assert resp.json()["error"] == "already_master"
    assert await _offers(school) == []


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
        OFFER_URL.format(school_id=uuid4()),
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
    school = await _school(client, curator)
    await _seed_member(db_session, school, cand)

    baseline = await _missing_code(client, other)
    resp = await _offer(client, other, school, cand)
    assert resp.status_code == 404
    assert resp.json()["error"] == baseline
    assert await _offers(school) == []


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
    school = await _school(client, curator)

    baseline = await _missing_code(client, curator)
    resp = await _offer(client, curator, school, outsider)
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
    school = await _school(client, curator)
    await _seed_member(db_session, school, cand)
    await _offer(client, curator, school, cand)

    assert (await _accept(client, cand, school)).status_code == 204
    second = await _accept(client, cand, school)
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
    school = await _school(client, curator)
    await _seed_member(db_session, school, cand)

    assert (await _decline(client, cand, school)).status_code == 204
    assert SchoolEventKind.MASTER_OFFER_DECLINED.value not in (
        await _journal(school)
    )


@pytest.mark.asyncio
async def test_a_non_member_cannot_accept_an_offer_made_to_somebody_else(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Offers are per person; being in the school is not being the addressee."""
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    bystander = await _master(client, db_session, _TID_SECOND)
    school = await _school(client, curator)
    await _seed_member(db_session, school, cand)
    await _seed_member(db_session, school, bystander)
    await _offer(client, curator, school, cand)

    resp = await _accept(client, bystander, school)
    assert resp.status_code == 404
    assert await _kind_of(school, bystander) == SchoolMemberKind.STUDENT.value
    assert await _offers(school) == [UUID(cand["user"]["id"])]


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
    school = await _school(client, curator)
    await _seed_member(db_session, school, cand)
    await _offer(client, curator, school, cand)
    await _unverify(db_session, curator)

    assert (await _accept(client, cand, school)).status_code == 404
    assert await _kind_of(school, cand) == SchoolMemberKind.STUDENT.value
    assert await _offers(school) == [UUID(cand["user"]["id"])]


@pytest.mark.asyncio
async def test_removal_from_the_school_kills_the_offer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Unlike the two temporary refusals, this one is not coming back.

    THE FIRST VERSION OF THIS TEST DELETED THE MEMBERSHIP ROW BY HAND and
    expected the accept call to notice and clean up. It never got that far:
    consent goes through _relation_or_404, which answers 404 to anyone with
    no relation to the school, so the branch it was testing was unreachable.
    Rather than keep an unbuildable case, the offer is now deleted where the
    removal happens -- and this goes through the real endpoint, which is
    also the only way the deletion can be observed at all.

    Contrast with the dark-school and lapsed-verification tests above: same
    404 for the appointee, opposite fate for the row. Those two conditions
    are temporary and keep the offer; this one is permanent and takes it.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    school = await _school(client, curator)
    await _seed_member(db_session, school, cand)
    await _offer(client, curator, school, cand)
    assert await _offers(school) == [UUID(cand["user"]["id"])]

    removed = await client.delete(
        f"/api/v1/masters/me/schools/{school}/members/"
        f"{cand['user']['id']}",
        headers=auth_headers(curator["session_token"]),
    )
    assert removed.status_code == 204, removed.text

    assert await _offers(school) == []
    assert (await _accept(client, cand, school)).status_code == 404


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
    school = await _school(client, curator)
    await _seed_member(db_session, school, cand)

    await _offer(client, curator, school, cand)

    assert (await _types_for(cand)).count(
        "school.master_offered"
    ) == 1
    assert "school.master_offered" not in await _types_for(curator)


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
    school = await _school(client, curator)
    await _seed_member(db_session, school, taker)
    await _seed_member(db_session, school, refuser)

    await _offer(client, curator, school, taker)
    await _offer(client, curator, school, refuser)
    await _accept(client, taker, school)
    await _decline(client, refuser, school)

    curator_types = await _types_for(curator)
    assert curator_types.count("school.master_offer_accepted") == 1
    assert curator_types.count("school.master_offer_declined") == 1
    assert "school.master_offer_accepted" not in await _types_for(taker)
    assert "school.master_offer_declined" not in await _types_for(
        refuser
    )


@pytest.mark.asyncio
async def test_no_notification_without_a_journal_line_and_the_reverse(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Item 7 on this delivery's own events, both directions in one pass.

    Four writing actions produce their journal lines and school
    notifications; a refused action produces neither. Either assertion alone
    passes in a world where one of the two writers was never called.

    THE REFUSAL CHANGED IN BE-59. It was the offer to a plain user (403
    master_required) -- right while that offer was refused. BE-59 made it
    a writing action: a journal line and the verification prompt, counted
    below with the others. The "refused writes nothing" half is now held by
    the refusal that remains on this path: re-offering somebody who has
    just become a master, 409 already_master.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    taker = await _master(client, db_session, _TID_CANDIDATE)
    refuser = await _master(client, db_session, _TID_SECOND)
    plain = await _plain(client, _TID_PLAIN)
    school = await _school(client, curator)
    for who in (taker, refuser, plain):
        await _seed_member(db_session, school, who)

    await _offer(client, curator, school, taker)
    await _offer(client, curator, school, refuser)
    await _accept(client, taker, school)
    await _decline(client, refuser, school)
    assert (await _offer(client, curator, school, plain)).status_code == 204

    journal_before = await _journal(school)
    taker_before = await _types_for(taker)
    refused = await _offer(client, curator, school, taker)
    assert refused.status_code == 409
    assert refused.json()["error"] == "already_master"
    assert await _journal(school) == journal_before
    assert await _types_for(taker) == taker_before

    journal = await _journal(school)
    assert journal.count(SchoolEventKind.MASTER_OFFERED.value) == 3
    assert journal.count(SchoolEventKind.MEMBER_PROMOTED.value) == 1
    assert journal.count(
        SchoolEventKind.MASTER_OFFER_DECLINED.value
    ) == 1

    school_notes = 0
    for who in (curator, taker, refuser, plain):
        school_notes += sum(
            1 for t in await _types_for(who)
            if t.startswith("school.master_")
        )
    # two offers + one accepted + one declined + one verification prompt.
    assert school_notes == 5
    assert await _types_for(plain) == [
        "school.master_verification_required",
    ]


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
    school = await _school(client, curator)
    headers = auth_headers(curator["session_token"])

    empty = await client.post(
        OFFER_URL.format(school_id=school), json={}, headers=headers,
    )
    assert empty.status_code == 422

    garbage = await client.post(
        OFFER_URL.format(school_id=school),
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
    school = await _school(client, curator)
    await _seed_member(db_session, school, cand)
    await _offer(client, curator, school, cand)

    assert (await _decline(client, cand, school)).status_code == 204
    assert (await _decline(client, cand, school)).status_code == 204
    assert (await _accept(client, cand, school)).status_code == 404


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
    school = await _school(client, curator)
    await _seed_member(db_session, school, cand)
    plain = await _plain(client, _TID_PLAIN)

    resp = await client.post(
        OFFER_URL.format(school_id=school),
        json={"to_user_id": cand["user"]["id"]},
        headers=auth_headers(plain["session_token"]),
    )
    assert resp.status_code == 403
    assert await _offers(school) == []


@pytest.mark.asyncio
async def test_walking_out_takes_the_offer_too(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """State 18, the pair of the removal above.

    Two ways out of a school, two places the offer has to die. Testing only
    one would leave the other free to keep an orphan that springs back to
    life if the person ever re-joins.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    school = await _school(client, curator)
    await _seed_member(db_session, school, cand)
    await _offer(client, curator, school, cand)

    left = await client.delete(
        f"/api/v1/schools/{school}/membership",
        headers=auth_headers(cand["session_token"]),
    )
    assert left.status_code == 204, left.text

    assert await _offers(school) == []
