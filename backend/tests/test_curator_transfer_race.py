# =============================================================================
# VELO Backend -- Tests: accepting a school is atomic (BE-42)
# =============================================================================
#
# telegram_id band: 69300-69399 (curator 69301, heir 69302, bystander 69303).
# Declared module-level below as _TID_MIN/_TID_MAX, ONCE --
# tests/telegram_id_bands.py parses that declaration out of the AST on every
# run, and a file using ids without declaring a band fails
# test_blind_zone_has_not_grown. Checked free before it was claimed:
# free_windows(space=(69000, 69999)) returned [(69300, 69999)].
#
# THE WINDOW THESE TESTS AIM AT lived between two statements INSIDE one
# function: accept read the offer first and deleted it last, and three other
# operations delete the same row -- cancel, remove and leave. Any of them
# landing in between left accept finishing anyway, and the school changed
# hands after its offer had been withdrawn.
#
# WHY asyncio.gather IS NOT ENOUGH HERE, measured before this file was
# written. The pattern from test_practices.py:415 races two POSTs that both
# INSERT and diverge only at commit -- symmetric, so either ordering proves
# the same thing. This window is not symmetric: gathering accept with cancel
# sends accept first, accept takes the row lock first, and the competitor
# simply loses every time. Probed on the broken code: accept=200,
# cancel=204, no cancellation event, school moved -- a legitimate outcome
# that would have been green before the fix and after it. A test built that
# way would have proven nothing while looking like proof.
#
# SO THE COMPETITOR IS SCHEDULED, NOT RACED. _has_master_capability is
# called after the offer is dealt with and before anything else is written,
# which makes it the one point in the real code path where a second
# transaction can be made to land exactly inside the old window. It is
# wrapped, not replaced: the real function still runs and still decides.
# This is a scheduling point, not a stub.
#
# THE COMPETITOR RUNS UNDER lock_timeout, and that is what keeps the test
# from hanging rather than failing. After the fix the offer row is already
# locked by accept's own DELETE when the competitor arrives, so without a
# timeout the competitor would wait for a transaction that is itself
# waiting for the competitor. With one, "blocked" reports itself as "lost",
# which is the truth: the claim got there first.
#
# THE ASSERTION IS AN INVARIANT, not a winner: a competitor that COMMITTED
# its withdrawal and a school that STILL CHANGED HANDS cannot both be true.
# Both legitimate outcomes satisfy it; only the defect does not. Verified in
# both directions before this file was kept -- see the report.
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
    CuratorGroupMember,
    CuratorGroupTransfer,
    CuratorMemberKind,
)
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

GROUPS_URL = "/api/v1/masters/me/curator-groups"
OFFER_URL = "/api/v1/masters/me/curator-groups/{group_id}/transfer"
MEMBER_URL = "/api/v1/masters/me/curator-groups/{group_id}/members/{user_id}"
ACCEPT_URL = "/api/v1/curator-groups/{group_id}/transfer/accept"
MEMBERSHIP_URL = "/api/v1/curator-groups/{group_id}/membership"

_TID_MIN = 69300
_TID_MAX = 69399

_TID_CURATOR = 69301
_TID_HEIR = 69302

# Long enough that a free row is always taken, short enough that a locked
# one reports defeat instead of stalling the suite.
_LOCK_TIMEOUT = "700ms"


# ===========================================================================
# Local helpers. Copied rather than imported, the convention here.
# ===========================================================================


async def _make_verified_master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> dict:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="Master",
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
    return auth


async def _school_with_offer(
    client: AsyncClient, db_session: AsyncSession,
) -> tuple[dict, dict, str]:
    """A curator, a member master, and a pending offer to that member."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    heir = await _make_verified_master(client, db_session, _TID_HEIR)

    created = await client.post(
        GROUPS_URL,
        json={"name": "Школа перехода"},
        headers=auth_headers(curator["session_token"]),
    )
    assert created.status_code == 201, created.text
    group_id = created.json()["id"]

    db_session.add(
        CuratorGroupMember(
            group_id=UUID(group_id),
            user_id=UUID(heir["user"]["id"]),
            kind=CuratorMemberKind.MASTER.value,
        )
    )
    await db_session.flush()
    await db_session.commit()

    offered = await client.post(
        OFFER_URL.format(group_id=group_id),
        json={"to_user_id": heir["user"]["id"]},
        headers=auth_headers(curator["session_token"]),
    )
    assert offered.status_code in (200, 201), offered.text
    return curator, heir, group_id


async def _state(
    db_session: AsyncSession, group_id: str, heir: dict,
) -> dict:
    """Who owns the school, and is the heir still a member row.

    Read through the test's own session AFTER the request has committed.
    The membership half is the pair the invariant needs: "the school did
    not move" alone is satisfied by any failure, including one that left
    the heir's row deleted halfway through.
    """
    group = (
        await db_session.execute(
            select(CuratorGroup).where(CuratorGroup.id == UUID(group_id))
        )
    ).scalar_one()
    await db_session.refresh(group)
    member = (
        await db_session.execute(
            select(CuratorGroupMember.id).where(
                CuratorGroupMember.group_id == UUID(group_id),
                CuratorGroupMember.user_id == UUID(heir["user"]["id"]),
            )
        )
    ).scalar_one_or_none()
    transfer = (
        await db_session.execute(
            select(CuratorGroupTransfer.id).where(
                CuratorGroupTransfer.group_id == UUID(group_id)
            )
        )
    ).scalar_one_or_none()
    return {
        "moved": str(group.curator_user_id) == heir["user"]["id"],
        "heir_is_member": member is not None,
        "offer_left": transfer is not None,
    }


async def _accept_with_competitor(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    heir: dict,
    group_id: str,
    competitor,
):
    """POST accept, running `competitor` in its own transaction midway.

    The wrap sits on _has_master_capability, which accept calls after it
    has dealt with the offer and before it writes anything else -- the one
    reachable point inside the old window. The real function is still
    called and still decides; only the timing of a second transaction is
    added.
    """
    real = curator_service._has_master_capability
    result: dict = {"competitor": None}

    async def _wrapped(user_id, session):
        factory = get_session_factory()
        async with factory() as rival:
            try:
                await rival.execute(
                    text(f"SET LOCAL lock_timeout = '{_LOCK_TIMEOUT}'")
                )
                await competitor(rival)
                await rival.commit()
                result["competitor"] = "won"
            except Exception:
                await rival.rollback()
                result["competitor"] = "lost"
        return await real(user_id, session)

    monkeypatch.setattr(
        curator_service, "_has_master_capability", _wrapped,
    )
    response = await client.post(
        ACCEPT_URL.format(group_id=group_id),
        headers=auth_headers(heir["session_token"]),
    )
    return response, result["competitor"]


def _assert_consistent(state: dict, competitor: str, label: str) -> None:
    """The invariant, and the pair that keeps it from passing on any crash.

    A competitor that committed its withdrawal and a school that changed
    hands anyway cannot both be true. When the withdrawal won, the school
    must be where it was AND the heir must still hold their member row --
    a half-applied transfer is the failure this pair exists to catch.
    """
    assert not (competitor == "won" and state["moved"]), (
        f"{label}: the school moved after its offer was withdrawn"
    )
    if competitor == "won":
        assert state["heir_is_member"], (
            f"{label}: transfer refused but the heir's member row is gone"
        )
    else:
        assert state["moved"], (
            f"{label}: the competitor lost and the transfer did not happen"
        )


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
# Three competitors, one window
# ===========================================================================


@pytest.mark.asyncio
async def test_an_offer_withdrawn_mid_accept_does_not_move_the_school(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The curator changes their mind while the heir is accepting.

    On the old order the withdrawal committed and the school moved anyway
    -- both halves true at once, which is the defect. Measured on that
    code before the fix was written, not inferred from it.
    """
    curator, heir, group_id = await _school_with_offer(client, db_session)

    async def _cancel(rival: AsyncSession) -> None:
        actor = await rival.get(User, UUID(curator["user"]["id"]))
        await curator_service.cancel_curator_group_transfer(
            UUID(curator["user"]["id"]),
            UUID(group_id),
            rival,
            actor=actor,
        )

    response, competitor = await _accept_with_competitor(
        client, monkeypatch, heir, group_id, _cancel,
    )
    state = await _state(db_session, group_id, heir)
    _assert_consistent(state, competitor, "cancel")
    assert response.status_code in (200, 404), response.text


@pytest.mark.asyncio
async def test_removing_the_heir_mid_accept_does_not_move_the_school(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The curator removes the heir from the school while they accept.

    Removal retracts the pending offer in the same transaction (GT-4), so
    it reaches the same row by a different door -- and the same window.
    """
    curator, heir, group_id = await _school_with_offer(client, db_session)

    async def _remove(rival: AsyncSession) -> None:
        actor = await rival.get(User, UUID(curator["user"]["id"]))
        await curator_service.remove_curator_group_member(
            UUID(curator["user"]["id"]),
            UUID(group_id),
            UUID(heir["user"]["id"]),
            rival,
            actor=actor,
        )

    response, competitor = await _accept_with_competitor(
        client, monkeypatch, heir, group_id, _remove,
    )
    state = await _state(db_session, group_id, heir)
    assert not (competitor == "won" and state["moved"]), (
        "remove: the school moved after the heir had been removed"
    )
    assert response.status_code in (200, 404), response.text


@pytest.mark.asyncio
async def test_the_heir_leaving_mid_accept_does_not_move_the_school(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The heir walks out of the school while their own accept is in
    flight -- the fourth door onto the same row, named in the card's
    prose and missing from its table of work."""
    _curator, heir, group_id = await _school_with_offer(client, db_session)

    async def _leave(rival: AsyncSession) -> None:
        actor = await rival.get(User, UUID(heir["user"]["id"]))
        await curator_service.leave_curator_group(
            UUID(group_id),
            UUID(heir["user"]["id"]),
            rival,
            actor=actor,
        )

    response, competitor = await _accept_with_competitor(
        client, monkeypatch, heir, group_id, _leave,
    )
    state = await _state(db_session, group_id, heir)
    assert not (competitor == "won" and state["moved"]), (
        "leave: the school moved after the heir had left it"
    )
    assert response.status_code in (200, 404), response.text


# ===========================================================================
# Two accepts by one heir
# ===========================================================================


@pytest.mark.asyncio
async def test_two_simultaneous_accepts_give_one_200_and_one_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The double tap, and here asyncio.gather IS the right tool.

    This race is symmetric -- two identical requests, either may arrive
    first -- so the pattern from test_practices.py:415 applies as written:
    each request resolves get_db_session independently, so neither sees
    the other's uncommitted work.

    ON THE OLD ORDER THIS RETURNED 500. Both reads found the offer, both
    inserted a member row for the previous curator, and the second died on
    uq_curator_group_member_group_user. Measured, not deduced: the probe
    printed the UniqueViolationError before a line of the fix was written.
    A 500 is not merely ugly here -- it is a transfer whose outcome the
    caller cannot tell from a server fault.
    """
    _curator, heir, group_id = await _school_with_offer(client, db_session)

    first, second = await asyncio.gather(
        client.post(
            ACCEPT_URL.format(group_id=group_id),
            headers=auth_headers(heir["session_token"]),
        ),
        client.post(
            ACCEPT_URL.format(group_id=group_id),
            headers=auth_headers(heir["session_token"]),
        ),
    )

    assert sorted([first.status_code, second.status_code]) == [200, 404], (
        f"{first.status_code} / {second.status_code}: "
        f"{first.text} | {second.text}"
    )
    loser = first if first.status_code == 404 else second
    assert loser.json()["error"] == "transfer_not_found", loser.text

    state = await _state(db_session, group_id, heir)
    assert state["moved"]
    assert not state["offer_left"]
    assert not state["heir_is_member"], (
        "I-2: the new curator must not also hold a member row"
    )


@pytest.mark.asyncio
async def test_a_second_accept_afterwards_is_404_but_proves_less(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Sequential double accept -- and a warning to whoever reads it.

    THIS TEST WOULD HAVE PASSED ON THE BROKEN CODE. The second call starts
    after the first has committed, so its own read finds no offer and it
    refuses for the ordinary reason, with no race involved. It is kept
    because the plain, boring shape of the endpoint deserves a test -- but
    anybody who takes it as coverage of BE-42 will believe the window is
    closed when it is open. The test above, with asyncio.gather, is the
    one that notices.
    """
    _curator, heir, group_id = await _school_with_offer(client, db_session)

    first = await client.post(
        ACCEPT_URL.format(group_id=group_id),
        headers=auth_headers(heir["session_token"]),
    )
    assert first.status_code == 200, first.text

    second = await client.post(
        ACCEPT_URL.format(group_id=group_id),
        headers=auth_headers(heir["session_token"]),
    )
    assert second.status_code == 404, second.text
    assert second.json()["error"] == "transfer_not_found", second.text
