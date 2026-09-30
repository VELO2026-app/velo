# =============================================================================
# VELO Backend -- Tests: consenting to be a school's master is atomic (BE-81)
# =============================================================================
#
# telegram_id band: 69600-69699 (curator 69601, appointee 69602,
# stranger 69603). Declared module-level below as _TID_MIN/_TID_MAX, ONCE --
# tests/telegram_id_bands.py parses that declaration out of the AST on every
# run, and a file using ids without declaring a band fails
# test_blind_zone_has_not_grown. Checked free before it was claimed:
# free_windows(space=(69000, 69999)) returned [(69600, 69999)].
#
# THE WINDOW THIS FILE AIMS AT sat between the relation check and the
# membership write. A comment above that write explained why a removed
# person could never reach it, and the explanation was true -- OF ONE
# REQUEST AT A TIME. A removal committing in between left the write meeting
# None, and the answer was a 500. Nothing held the row: with_for_update
# appears nowhere in curator_groups/ and the isolation level is READ
# COMMITTED.
#
# asyncio.gather CANNOT SHOW THIS, and that was measured in BE-42 rather
# than assumed. The pattern in test_practices.py:415 races two requests that
# do the same thing and diverge only at commit; this race is asymmetric --
# accept is sent first, takes the row lock first and wins every time. A test
# built that way is green before the fix and after it.
#
# SO THE COMPETITOR IS SCHEDULED, NOT RACED, exactly as in
# test_curator_transfer_race.py. _has_master_capability is called inside the
# old window, so wrapping it -- not replacing it; the real function still
# runs and still decides -- puts a second transaction precisely where the
# damage used to happen. The competitor runs under lock_timeout so that
# after the fix "blocked" reports itself as "lost" instead of hanging the
# suite: the claim already holds the offer row, and removal cannot commit
# without it.
#
# THE ASSERTION IS AN INVARIANT, not a winner. "The removal committed" and
# "the person became a master of the school" cannot both be true. Both
# legitimate outcomes satisfy it; only the defect does not.
# =============================================================================

import asyncio
from collections.abc import AsyncGenerator
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session_factory
from app.modules.curator_groups import service as curator_service
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMasterOffer,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

ACCEPT_URL = "/api/v1/curator-groups/{group_id}/master-offer/accept"

_TID_MIN = 69600
_TID_MAX = 69699

_TID_CURATOR = 69601
_TID_APPOINTEE = 69602
_TID_STRANGER = 69603

# Long enough that a free row is always taken, short enough that a locked
# one reports defeat instead of stalling the suite.
_LOCK_TIMEOUT = "700ms"


# ===========================================================================
# Local helpers. Copied rather than imported, the convention here.
# ===========================================================================


async def _master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> dict:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="Мастер",
    )
    user_id = UUID(auth["user"]["id"])
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    await db_session.flush()
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
    return await login_user(
        client, telegram_id=telegram_id, first_name="Мастер",
    )


async def _school_with_offer(
    client: AsyncClient, db_session: AsyncSession,
) -> tuple[dict, dict, CuratorGroup]:
    """A school, a student member, and a pending master offer to them.

    The appointee is a STUDENT of the school: the offer upgrades an
    existing membership row rather than creating one, which is why the
    write at the end of accept is an UPDATE and why a missing row was a
    500 rather than a quiet no-op.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    appointee = await _master(client, db_session, _TID_APPOINTEE)

    school = CuratorGroup(
        curator_user_id=UUID(curator["user"]["id"]), name="Школа BE-81",
    )
    db_session.add(school)
    await db_session.flush()
    db_session.add(
        CuratorGroupMember(
            group_id=school.id,
            user_id=UUID(appointee["user"]["id"]),
            kind=CuratorMemberKind.STUDENT.value,
        )
    )
    db_session.add(
        CuratorGroupMasterOffer(
            group_id=school.id,
            to_user_id=UUID(appointee["user"]["id"]),
        )
    )
    await db_session.flush()
    await db_session.commit()
    return curator, appointee, school


async def _accept(client: AsyncClient, who: dict, school: CuratorGroup):
    return await client.post(
        ACCEPT_URL.format(group_id=school.id),
        headers=auth_headers(who["session_token"]),
    )


async def _membership(
    db_session: AsyncSession, school: CuratorGroup, who: dict,
) -> str | None:
    """The appointee's membership kind, or None if the row is gone."""
    return (
        await db_session.execute(
            select(CuratorGroupMember.kind).where(
                CuratorGroupMember.group_id == school.id,
                CuratorGroupMember.user_id == UUID(who["user"]["id"]),
            )
        )
    ).scalar_one_or_none()


async def _offer_left(
    db_session: AsyncSession, school: CuratorGroup, who: dict,
) -> bool:
    return (
        await db_session.execute(
            select(CuratorGroupMasterOffer.id).where(
                CuratorGroupMasterOffer.group_id == school.id,
                CuratorGroupMasterOffer.to_user_id
                == UUID(who["user"]["id"]),
            )
        )
    ).scalar_one_or_none() is not None


# ===========================================================================
# Cleanup
# ===========================================================================


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


# ===========================================================================
# The race the card is about
# ===========================================================================


async def _accept_with_competitor(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    appointee: dict,
    school: CuratorGroup,
    competitor,
):
    """POST accept, running `competitor` in its own transaction midway.

    The wrap sits on _has_master_capability, which accept calls after it
    has dealt with the offer and before it writes the membership -- the one
    reachable point inside the old window. The real function is still
    called and still decides; only the timing of a second transaction is
    added.

    The competitor runs under lock_timeout so that after the fix "blocked"
    reports itself as "lost" rather than waiting for a transaction that is
    itself waiting for the competitor.
    """
    real = curator_service._has_master_capability
    outcome: dict = {"rival": None}

    async def _wrapped(user_id, session):
        factory = get_session_factory()
        async with factory() as rival:
            try:
                await rival.execute(
                    text(f"SET LOCAL lock_timeout = '{_LOCK_TIMEOUT}'")
                )
                await competitor(rival)
                await rival.commit()
                outcome["rival"] = "won"
            except Exception:
                await rival.rollback()
                outcome["rival"] = "lost"
        return await real(user_id, session)

    monkeypatch.setattr(
        curator_service, "_has_master_capability", _wrapped,
    )
    response = await _accept(client, appointee, school)
    return response, outcome["rival"]


@pytest.mark.asyncio
async def test_a_removal_mid_accept_never_promotes_the_removed_person(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The curator removes the appointee while they are consenting.

    ON THE OLD CODE THIS WAS A 500, measured before a line of the fix was
    written: the membership row was gone by the time accept reached it and
    `member.kind` met None.

    THE PAIR: when the removal won, the membership must be exactly what the
    competitor left behind -- gone. "Not promoted" on its own is satisfied
    by a half-applied transaction that deleted the row for its own reasons.
    """
    curator, appointee, school = await _school_with_offer(
        client, db_session,
    )

    async def _remove(rival: AsyncSession) -> None:
        actor = await rival.get(User, UUID(curator["user"]["id"]))
        await curator_service.remove_curator_group_member(
            UUID(curator["user"]["id"]),
            school.id,
            UUID(appointee["user"]["id"]),
            rival,
            actor=actor,
        )

    response, rival = await _accept_with_competitor(
        client, monkeypatch, appointee, school, _remove,
    )

    assert response.status_code < 500, (
        f"the race answered {response.status_code}: {response.text}"
    )
    kind = await _membership(db_session, school, appointee)
    assert not (
        rival == "won" and kind == CuratorMemberKind.MASTER.value
    ), "removed by the curator and promoted anyway"
    if rival == "won":
        assert kind is None, (
            "the removal committed but left a membership row behind"
        )
    else:
        assert kind == CuratorMemberKind.MASTER.value


@pytest.mark.asyncio
async def test_leaving_mid_accept_never_promotes_the_departed_person(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The second competitor: the appointee walks out by their own hand.

    leave_curator_group drops the same offer in the same transaction as the
    membership, so it reaches the identical window by a different door.
    Named in the comment above the write since GT-27 and missing from the
    card's table of work.
    """
    _curator, appointee, school = await _school_with_offer(
        client, db_session,
    )

    async def _leave(rival: AsyncSession) -> None:
        actor = await rival.get(User, UUID(appointee["user"]["id"]))
        await curator_service.leave_curator_group(
            school.id,
            UUID(appointee["user"]["id"]),
            rival,
            actor=actor,
        )

    response, rival = await _accept_with_competitor(
        client, monkeypatch, appointee, school, _leave,
    )

    assert response.status_code < 500, (
        f"the race answered {response.status_code}: {response.text}"
    )
    kind = await _membership(db_session, school, appointee)
    assert not (
        rival == "won" and kind == CuratorMemberKind.MASTER.value
    ), "left the school and was promoted into it anyway"
    if rival == "won":
        assert kind is None
    else:
        assert kind == CuratorMemberKind.MASTER.value


@pytest.mark.asyncio
async def test_declining_mid_accept_never_promotes_the_refuser(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The third competitor, and the one that made no noise at all.

    Decline deletes the offer and leaves the membership row alone, so on
    the old order there was nothing to crash on: MEASURED, the race
    answered 204 and left kind='master'. The person refused the
    appointment and became a master of the school anyway -- quieter than
    the 500 the other two produced, and worse, because nothing in the
    logs would ever have shown it.

    The membership must end as a student either way: promoted if the
    refusal lost the race, untouched by the refusal if it won.
    """
    _curator, appointee, school = await _school_with_offer(
        client, db_session,
    )

    async def _decline(rival: AsyncSession) -> None:
        actor = await rival.get(User, UUID(appointee["user"]["id"]))
        await curator_service.decline_curator_group_master_offer(
            school.id,
            UUID(appointee["user"]["id"]),
            rival,
            actor=actor,
        )

    response, rival = await _accept_with_competitor(
        client, monkeypatch, appointee, school, _decline,
    )

    assert response.status_code < 500, (
        f"the race answered {response.status_code}: {response.text}"
    )
    kind = await _membership(db_session, school, appointee)
    assert not (
        rival == "won" and kind == CuratorMemberKind.MASTER.value
    ), "declined the appointment and was promoted anyway"
    if rival == "won":
        assert kind == CuratorMemberKind.STUDENT.value, (
            "the refusal won, so the membership must be untouched"
        )
    else:
        assert kind == CuratorMemberKind.MASTER.value


@pytest.mark.asyncio
async def test_two_simultaneous_accepts_give_one_204_and_one_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The double tap -- and here asyncio.gather IS the right tool.

    This race is symmetric: two identical requests, either may arrive
    first, so the pattern from test_practices.py:415 applies as written --
    each request resolves get_db_session independently and neither sees
    the other's uncommitted work.

    The loser's code is asserted, not just its status: a 404 that arrived
    for some other reason would say the offer was never there.
    """
    _curator, appointee, school = await _school_with_offer(
        client, db_session,
    )

    first, second = await asyncio.gather(
        _accept(client, appointee, school),
        _accept(client, appointee, school),
    )

    assert sorted([first.status_code, second.status_code]) == [204, 404], (
        f"{first.status_code} / {second.status_code}: "
        f"{first.text} | {second.text}"
    )
    loser = first if first.status_code == 404 else second
    assert loser.json()["error"] == "master_offer_not_found", loser.text

    assert await _membership(db_session, school, appointee) == (
        CuratorMemberKind.MASTER.value
    )
    assert not await _offer_left(db_session, school, appointee)


@pytest.mark.asyncio
async def test_a_second_accept_afterwards_is_404_but_proves_less(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Sequential double accept -- with a warning to whoever reads it.

    THIS TEST WOULD HAVE PASSED ON THE BROKEN CODE. The second call starts
    after the first has committed, so its own read finds no offer and it
    refuses for the ordinary reason, with no race involved. It is kept
    because the plain shape of the endpoint deserves a test -- but anybody
    who takes it as coverage of BE-81 will believe the window is closed
    when it is open. The test above is the one that notices.
    """
    _curator, appointee, school = await _school_with_offer(
        client, db_session,
    )

    first = await _accept(client, appointee, school)
    assert first.status_code == 204, first.text

    second = await _accept(client, appointee, school)
    assert second.status_code == 404, second.text
    assert second.json()["error"] == "master_offer_not_found", second.text


# ===========================================================================
# Emptiness
# ===========================================================================


@pytest.mark.asyncio
async def test_no_offer_and_somebody_elses_offer_are_both_refused(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Two shapes of "not yours", and one valid acceptance beside them.

    The claim's WHERE carries both conditions -- this school, this person
    -- so an offer made to somebody else is as absent as no offer at all,
    and both answer with the same code. The valid acceptance in the same
    test is the pair: without it this would pass on an endpoint that
    refuses everything.
    """
    _curator, appointee, school = await _school_with_offer(
        client, db_session,
    )
    stranger = await _master(client, db_session, _TID_STRANGER)
    db_session.add(
        CuratorGroupMember(
            group_id=school.id,
            user_id=UUID(stranger["user"]["id"]),
            kind=CuratorMemberKind.STUDENT.value,
        )
    )
    await db_session.flush()
    await db_session.commit()

    # A member of the school with no offer of their own.
    theirs = await _accept(client, stranger, school)
    assert theirs.status_code == 404, theirs.text
    assert theirs.json()["error"] == "master_offer_not_found", theirs.text
    assert await _membership(db_session, school, stranger) == (
        CuratorMemberKind.STUDENT.value
    )

    # And the offer that really was made still works.
    mine = await _accept(client, appointee, school)
    assert mine.status_code == 204, mine.text
    assert await _membership(db_session, school, appointee) == (
        CuratorMemberKind.MASTER.value
    )


@pytest.mark.asyncio
async def test_a_lapsed_master_is_refused_and_the_offer_is_still_there(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """403, and the offer survives to be accepted after re-verification.

    THE PROMISE IS OLDER THAN THE FIX; WHAT HOLDS IT UP IS NEW. The
    docstring has always said a lapsed appointee is refused and the offer
    survives, because re-verifying should restore the ability to accept
    something genuinely offered. Before BE-81 that was structural: the
    offer was deleted LAST, so a ForbiddenError never reached it. Now the
    offer is claimed FIRST and survives only because get_db_session rolls
    the request back on an exception.

    The function no longer holds that invariant by itself, so this test
    does. Without it, the day somebody commits half-way through accept --
    or moves the capability check above the claim and then back -- the
    offer would quietly disappear on a 403 and no other test in the suite
    would notice.

    The second half is the pair: re-verified, the same person accepts the
    same offer. "Still in the table" is worth little if it can no longer
    be used.
    """
    _curator, appointee, school = await _school_with_offer(
        client, db_session,
    )
    profile = (
        await db_session.execute(
            select(MasterProfile).where(
                MasterProfile.user_id == UUID(appointee["user"]["id"]),
            )
        )
    ).scalars().one()
    profile.data = {
        **profile.data,
        "account": {**profile.data["account"], "status": "suspended"},
    }
    await db_session.flush()
    await db_session.commit()

    refused = await _accept(client, appointee, school)
    assert refused.status_code == 403, refused.text
    assert refused.json()["error"] == "master_required", refused.text

    assert await _offer_left(db_session, school, appointee), (
        "the 403 took the offer with it"
    )
    assert await _membership(db_session, school, appointee) == (
        CuratorMemberKind.STUDENT.value
    )

    profile.data = {
        **profile.data,
        "account": {**profile.data["account"], "status": "verified"},
    }
    await db_session.flush()
    await db_session.commit()

    accepted = await _accept(client, appointee, school)
    assert accepted.status_code == 204, accepted.text
    assert await _membership(db_session, school, appointee) == (
        CuratorMemberKind.MASTER.value
    )
