# =============================================================================
# VELO Backend -- Tests: the school-master appointment flow (BE-59, batch A)
# =============================================================================
#
# telegram_id band: 68700-68899, declared module-level as _TID_MIN/_TID_MAX
# ONCE -- tests/telegram_id_bands.py parses that declaration out of the AST.
# Re-checked against the live registry rather than assumed:
# free_windows(space=(67600, 69999)) returned [(67950, 67999), (68700, 68999),
# (69950, 69999)], so 68700-68899 was free and 68900-68999 stays free.
#
# THE OWNER'S FLOW, AND WHERE EACH STEP IS PROVED:
#
#   offer to a non-verified member -> kept, "get verified" prompt
#       test_an_unverified_member_is_offered_and_asked_to_get_verified
#   admin verifies -> "become a master? yes / no", roster awaiting_answer
#       test_verification_turns_the_offer_into_a_question
#   admin rejects -> offer closed, the CURRENT curator is told
#       test_a_rejection_closes_the_offer_and_tells_the_curator
#       test_a_rejection_after_a_handover_tells_the_new_curator
#   the curator withdraws -> gone, journal line, candidate not told
#       test_the_curator_withdraws_an_offer
#   revoke -> the offer stays, silently, awaiting verification again
#       test_a_revocation_keeps_the_offer_and_says_nothing
#
# THE THREE AXES (BE-59 gate): repeat -- re-verification after revoke, by
# verify_master and by make_master, gives a NEW key each time; a second
# withdrawal writes nothing. Emptiness -- verify and reject with no offers,
# roster rows with no offer, a withdrawal of nothing. Shortage -- the
# candidate left before verification, the school changed hands before
# rejection. The races (the profile's FOR SHARE) are at the bottom, through
# tests/curator_race_harness.py, in both start orders.
# =============================================================================

from collections.abc import AsyncGenerator
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events.models import OutboxEvent
from app.modules.admin.masters import service as admin_masters_service
from app.modules.curator_groups import service as curator_service
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupEvent,
    CuratorGroupEventKind,
    CuratorGroupMasterOffer,
    CuratorGroupMember,
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
OFFER_URL = GROUPS_URL + "/{group_id}/master-offers"
CANCEL_URL = GROUPS_URL + "/{group_id}/master-offers/{user_id}"
MEMBERS_URL = GROUPS_URL + "/{group_id}/members"
STUDENT_URL = GROUPS_URL + "/{group_id}/students/{user_id}"
TRANSFER_URL = GROUPS_URL + "/{group_id}/transfer"
ACCEPT_URL = "/api/v1/curator-groups/{group_id}/master-offer/accept"
TRANSFER_ACCEPT_URL = "/api/v1/curator-groups/{group_id}/transfer/accept"
LEAVE_URL = "/api/v1/curator-groups/{group_id}/membership"
APPLY_URL = "/api/v1/masters/apply"
VERIFY_URL = "/api/v1/admin/masters/{user_id}/verify"
REJECT_URL = "/api/v1/admin/masters/{user_id}/reject"
REVOKE_URL = "/api/v1/admin/masters/{user_id}/revoke"
MAKE_MASTER_URL = "/api/v1/admin/users/{user_id}/make-master"

_TID_MIN = 68700
_TID_MAX = 68899

_TID_CURATOR = 68701
_TID_HEIR = 68702
_TID_FELLOW = 68703  # a master of the school who is not its curator
_TID_ADMIN = 68709
_TID_CANDIDATE = 68710
_TID_SECOND_CURATOR = 68711
_TID_BYSTANDER = 68712

OFFERED = "curator_group.master_offered"
VERIFY_PROMPT = "curator_group.master_verification_required"
CLOSED = "curator_group.master_offer_closed"


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """FK-safe shared helper (TD-032), scoped to this file's own band."""
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ===========================================================================
# Helpers -- real endpoints where the step has one; a direct row only for
# the starting state of a person (who they are), never for the flow itself.
# ===========================================================================


def _apply_body() -> dict:
    return {
        "profile": {
            "display_name": "Кандидат",
            "email": "cand@test.com",
            "phone": "+1234567890",
        },
        "experience": {
            "methods": ["meditation"],
            "experience_years": 3,
            "bio": "candidate",
            "certifications": [],
        },
        "documents": [{"type": "certificate", "number": "C-1"}],
    }


async def _master(
    client: AsyncClient, db_session: AsyncSession, tid: int,
) -> dict:
    auth = await login_user(client, telegram_id=tid, first_name=f"M{tid}")
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


async def _plain(client: AsyncClient, tid: int, name: str = "Кандидат") -> dict:
    return await login_user(client, telegram_id=tid, first_name=name)


async def _admin(client: AsyncClient, db_session: AsyncSession) -> dict:
    auth = await login_user(client, telegram_id=_TID_ADMIN, first_name="Adm")
    await db_session.execute(
        update(User)
        .where(User.id == UUID(auth["user"]["id"]))
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    return auth


async def _school(client: AsyncClient, curator: dict, name: str) -> str:
    resp = await client.post(
        GROUPS_URL, json={"name": name},
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
            group_id=UUID(group_id), user_id=UUID(auth["user"]["id"]),
            kind=kind.value,
        )
    )
    await db_session.flush()
    await db_session.commit()


async def _offer(client, curator: dict, group_id: str, to: dict):
    return await client.post(
        OFFER_URL.format(group_id=group_id),
        json={"to_user_id": to["user"]["id"]},
        headers=auth_headers(curator["session_token"]),
    )


async def _apply(client, auth: dict):
    resp = await client.post(
        APPLY_URL, json=_apply_body(),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 201, resp.text


async def _verify(client, admin: dict, auth: dict):
    resp = await client.post(
        VERIFY_URL.format(user_id=auth["user"]["id"]), json={},
        headers=auth_headers(admin["session_token"]),
    )
    assert resp.status_code == 200, resp.text


async def _reject(client, admin: dict, auth: dict):
    resp = await client.post(
        REJECT_URL.format(user_id=auth["user"]["id"]),
        json={"reason": "документы не подошли"},
        headers=auth_headers(admin["session_token"]),
    )
    assert resp.status_code == 200, resp.text


async def _revoke(client, admin: dict, auth: dict):
    resp = await client.post(
        REVOKE_URL.format(user_id=auth["user"]["id"]),
        headers=auth_headers(admin["session_token"]),
    )
    assert resp.status_code == 200, resp.text


async def _make_master(client, admin: dict, auth: dict):
    return await client.post(
        MAKE_MASTER_URL.format(user_id=auth["user"]["id"]),
        headers=auth_headers(admin["session_token"]),
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


async def _offer_id(group_id: str, auth: dict) -> UUID:
    return (
        await fresh_execute(
            select(CuratorGroupMasterOffer.id).where(
                CuratorGroupMasterOffer.group_id == UUID(group_id),
                CuratorGroupMasterOffer.to_user_id == UUID(auth["user"]["id"]),
            )
        )
    ).scalar_one()


async def _outbox_for(auth: dict) -> list[dict]:
    """Notification payloads queued FOR ONE PERSON, oldest first.

    Scoped by target_value, the same access path full_cleanup_range uses:
    an unscoped select would read the whole suite's outbox.
    """
    rows = (
        await fresh_execute(
            select(OutboxEvent)
            .where(
                OutboxEvent.payload["target_value"].astext
                == str(auth["user"]["id"]),
            )
            .order_by(OutboxEvent.created_at, OutboxEvent.id)
        )
    ).scalars().all()
    return [r.payload or {} for r in rows]


async def _types_for(auth: dict) -> list[str]:
    return [p.get("type", "") for p in await _outbox_for(auth)]


async def _school_types_for(auth: dict) -> list[str]:
    return [t for t in await _types_for(auth) if t.startswith("curator_group.")]


async def _journal(group_id: str) -> list[tuple[str, dict]]:
    rows = (
        await fresh_execute(
            select(CuratorGroupEvent.event, CuratorGroupEvent.data)
            .where(CuratorGroupEvent.group_id == UUID(group_id))
            .order_by(CuratorGroupEvent.seq)
        )
    ).all()
    return [(e, d) for e, d in rows]


async def _roster_state(client, curator: dict, group_id: str) -> dict:
    resp = await client.get(
        MEMBERS_URL.format(group_id=group_id),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    return {i["user_id"]: i["master_offer"] for i in resp.json()["items"]}


# ===========================================================================
# The offer to somebody who is not a verified master
# ===========================================================================


@pytest.mark.asyncio
async def test_an_unverified_member_is_offered_and_asked_to_get_verified(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The offer is kept; the prompt is the verification one, pointing at
    the application -- not "become a master? yes / no"."""
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _plain(client, _TID_CANDIDATE)
    group = await _school(client, curator, "Школа верификации")
    await _seed_member(db_session, group, cand)

    resp = await _offer(client, curator, group, cand)
    assert resp.status_code == 204, resp.text

    assert await _offers(group) == [UUID(cand["user"]["id"])]
    [prompt] = [
        p for p in await _outbox_for(cand)
        if p.get("type", "").startswith("curator_group.")
    ]
    assert prompt["type"] == VERIFY_PROMPT
    assert prompt["action_data"]["action"] == "open_master_application"
    assert prompt["action_data"]["group_name"] == "Школа верификации"
    # The journal records the curator's act exactly as for a verified one.
    assert [e for e, _ in await _journal(group)][-1] == (
        CuratorGroupEventKind.MASTER_OFFERED.value
    )
    roster = await _roster_state(client, curator, group)
    assert roster[cand["user"]["id"]] == "awaiting_verification"


@pytest.mark.asyncio
async def test_a_repeated_offer_to_an_unverified_member_prompts_once(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """REPEAT: the second press is the curator re-sending, not a new fact."""
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _plain(client, _TID_CANDIDATE)
    group = await _school(client, curator, "Школа повтора")
    await _seed_member(db_session, group, cand)

    assert (await _offer(client, curator, group, cand)).status_code == 204
    assert (await _offer(client, curator, group, cand)).status_code == 204
    assert await _school_types_for(cand) == [VERIFY_PROMPT]
    assert len(await _offers(group)) == 1


# ===========================================================================
# Verification
# ===========================================================================


@pytest.mark.asyncio
async def test_verification_turns_the_offer_into_a_question(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Admin verifies -> every waiting school asks; the answer then works.

    Two schools, so "every" is measured rather than assumed, and each
    prompt names its own school and its own curator.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    second = await _master(client, db_session, _TID_SECOND_CURATOR)
    admin = await _admin(client, db_session)
    cand = await _plain(client, _TID_CANDIDATE)
    g1 = await _school(client, curator, "Первая школа")
    g2 = await _school(client, second, "Вторая школа")
    for g in (g1, g2):
        await _seed_member(db_session, g, cand)
    await _offer(client, curator, g1, cand)
    await _offer(client, second, g2, cand)
    await _apply(client, cand)

    await _verify(client, admin, cand)

    offered = [p for p in await _outbox_for(cand) if p["type"] == OFFERED]
    assert {p["action_data"]["group_name"] for p in offered} == {
        "Первая школа", "Вторая школа",
    }
    assert {p["action_data"]["actor_name"] for p in offered} == {
        f"M{_TID_CURATOR}", f"M{_TID_SECOND_CURATOR}",
    }
    for p in offered:
        assert p["action_data"]["action"] == "open_curator_group"
    keys = {p["idempotency_key"] for p in offered}
    assert keys == {
        k for k in keys if k.startswith("curator-master-offer-ready:")
    }
    assert len(keys) == 2
    # No journal line for the admin's decision -- the curator acted once.
    assert [e for e, _ in await _journal(g1)].count(
        CuratorGroupEventKind.MASTER_OFFERED.value
    ) == 1

    assert (await _roster_state(client, curator, g1))[
        cand["user"]["id"]
    ] == "awaiting_answer"
    resp = await client.post(
        ACCEPT_URL.format(group_id=g1),
        headers=auth_headers(cand["session_token"]),
    )
    assert resp.status_code == 204, resp.text


@pytest.mark.asyncio
async def test_verification_without_offers_announces_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """EMPTINESS: nothing waits, nothing is sent -- and verification itself
    still happened (the pair)."""
    admin = await _admin(client, db_session)
    cand = await _plain(client, _TID_CANDIDATE)
    await _apply(client, cand)

    await _verify(client, admin, cand)

    profile = await fresh_get(MasterProfile, UUID(cand["user"]["id"]))
    assert profile.data["account"]["status"] == "verified"
    assert await _school_types_for(cand) == []


@pytest.mark.asyncio
async def test_a_member_who_left_before_verification_is_not_asked(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """SHORTAGE: leaving takes the offer with it at the source, so the
    verification has nothing to announce for that school."""
    curator = await _master(client, db_session, _TID_CURATOR)
    admin = await _admin(client, db_session)
    cand = await _plain(client, _TID_CANDIDATE)
    group = await _school(client, curator, "Школа ухода")
    await _seed_member(db_session, group, cand)
    await _offer(client, curator, group, cand)
    resp = await client.delete(
        LEAVE_URL.format(group_id=group),
        headers=auth_headers(cand["session_token"]),
    )
    assert resp.status_code == 204, resp.text
    await _apply(client, cand)

    await _verify(client, admin, cand)

    assert await _offers(group) == []
    assert OFFERED not in await _types_for(cand)
    assert VERIFY_PROMPT in await _types_for(cand)  # the pair: it WAS offered


@pytest.mark.asyncio
async def test_reverification_after_revoke_asks_again_under_a_new_key(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """REPEAT: verify -> revoke -> re-apply -> verify gives two prompts.

    The offer stays through the revocation (owner ruling), so the second
    verification finds the same offer -- and must not reuse the first
    key, or comms would drop the second prompt as a duplicate.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    admin = await _admin(client, db_session)
    cand = await _plain(client, _TID_CANDIDATE)
    group = await _school(client, curator, "Школа возврата")
    await _seed_member(db_session, group, cand)
    await _offer(client, curator, group, cand)
    await _apply(client, cand)
    await _verify(client, admin, cand)
    await _revoke(client, admin, cand)
    await _apply(client, cand)
    await _verify(client, admin, cand)

    offered = [p for p in await _outbox_for(cand) if p["type"] == OFFERED]
    assert len(offered) == 2
    assert len({p["idempotency_key"] for p in offered}) == 2
    offer_id = str(await _offer_id(group, cand))
    for p in offered:
        assert p["idempotency_key"].startswith(
            f"curator-master-offer-ready:{offer_id}:"
        )


@pytest.mark.asyncio
async def test_make_master_after_revoke_asks_again_under_a_new_key(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """REPEAT, the case that ruled out verified_at as the key.

    make_master re-verifies a suspended profile with setdefault, which
    KEEPS the earlier verification block -- verified_at is the same
    before and after. The key must still differ.
    """
    curator = await _master(client, db_session, _TID_CURATOR)
    admin = await _admin(client, db_session)
    cand = await _plain(client, _TID_CANDIDATE)
    group = await _school(client, curator, "Школа make-master")
    await _seed_member(db_session, group, cand)
    await _offer(client, curator, group, cand)
    await _apply(client, cand)
    await _verify(client, admin, cand)
    before = (await fresh_get(MasterProfile, UUID(cand["user"]["id"]))).data
    await _revoke(client, admin, cand)

    resp = await _make_master(client, admin, cand)
    assert resp.status_code == 200, resp.text

    after = (await fresh_get(MasterProfile, UUID(cand["user"]["id"]))).data
    # The premise of this test, measured: the stamp did not move.
    assert (
        after["account"]["verification"]["verified_at"]
        == before["account"]["verification"]["verified_at"]
    )
    offered = [p for p in await _outbox_for(cand) if p["type"] == OFFERED]
    assert len(offered) == 2
    assert len({p["idempotency_key"] for p in offered}) == 2


@pytest.mark.asyncio
async def test_make_master_of_an_already_verified_person_announces_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """REPEAT: an approved applicant who never switched has the capability
    already -- verify announced; make_master only changes the role."""
    curator = await _master(client, db_session, _TID_CURATOR)
    admin = await _admin(client, db_session)
    cand = await _plain(client, _TID_CANDIDATE)
    group = await _school(client, curator, "Школа роли")
    await _seed_member(db_session, group, cand)
    await _offer(client, curator, group, cand)
    await _apply(client, cand)
    await _verify(client, admin, cand)

    resp = await _make_master(client, admin, cand)
    assert resp.status_code == 200, resp.text

    assert (await _types_for(cand)).count(OFFERED) == 1


@pytest.mark.asyncio
async def test_make_master_of_a_plain_member_asks_them(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The make_master path with no profile at all: created verified, and
    the waiting school asks."""
    curator = await _master(client, db_session, _TID_CURATOR)
    admin = await _admin(client, db_session)
    cand = await _plain(client, _TID_CANDIDATE)
    group = await _school(client, curator, "Школа без профиля")
    await _seed_member(db_session, group, cand)
    await _offer(client, curator, group, cand)

    resp = await _make_master(client, admin, cand)
    assert resp.status_code == 200, resp.text

    assert await _school_types_for(cand) == [VERIFY_PROMPT, OFFERED]


@pytest.mark.asyncio
async def test_self_provision_asks_the_waiting_school(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A role=master account with no profile fills the form and is verified
    on the spot -- a verification, so the school asks."""
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _plain(client, _TID_CANDIDATE)
    group = await _school(client, curator, "Школа самопровижна")
    await _seed_member(db_session, group, cand)
    await _offer(client, curator, group, cand)
    await db_session.execute(
        update(User)
        .where(User.id == UUID(cand["user"]["id"]))
        .values(role=UserRole.MASTER.value)
    )
    await db_session.commit()

    await _apply(client, cand)

    profile = await fresh_get(MasterProfile, UUID(cand["user"]["id"]))
    assert profile.data["account"]["status"] == "verified"
    assert await _school_types_for(cand) == [VERIFY_PROMPT, OFFERED]


@pytest.mark.asyncio
async def test_set_role_to_master_asks_the_waiting_school(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The CLI path, called the way main() calls it: a session, a user,
    assume_yes. A verification like make_master's, so the school asks."""
    from scripts import set_role  # a script, not a package

    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _plain(client, _TID_CANDIDATE)
    group = await _school(client, curator, "Школа CLI")
    await _seed_member(db_session, group, cand)
    await _offer(client, curator, group, cand)

    user = await db_session.get(User, UUID(cand["user"]["id"]))
    assert await set_role.to_master(db_session, user, assume_yes=True)
    await db_session.commit()

    assert await _school_types_for(cand) == [VERIFY_PROMPT, OFFERED]


# ===========================================================================
# Rejection
# ===========================================================================


@pytest.mark.asyncio
async def test_a_rejection_closes_the_offer_and_tells_the_curator(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    curator = await _master(client, db_session, _TID_CURATOR)
    admin = await _admin(client, db_session)
    cand = await _plain(client, _TID_CANDIDATE, name="Отказник")
    group = await _school(client, curator, "Школа отказа")
    await _seed_member(db_session, group, cand)
    await _offer(client, curator, group, cand)
    offer_id = await _offer_id(group, cand)
    await _apply(client, cand)

    await _reject(client, admin, cand)

    assert await _offers(group) == []
    closed = [p for p in await _outbox_for(curator) if p["type"] == CLOSED]
    assert len(closed) == 1
    assert closed[0]["idempotency_key"] == (
        f"curator-master-offer-closed:{offer_id}"
    )
    assert closed[0]["action_data"]["group_name"] == "Школа отказа"
    assert closed[0]["action_data"]["target_name"] == "Отказник"
    # The candidate learns of the rejection from the application, not from
    # the school; the school's journal does not carry an admin's name.
    assert CLOSED not in await _types_for(cand)
    assert [e for e, _ in await _journal(group)] == [
        CuratorGroupEventKind.GROUP_CREATED.value,
        CuratorGroupEventKind.MASTER_OFFERED.value,
    ]
    # Membership is untouched -- the person is still a student here.
    roster = await _roster_state(client, curator, group)
    assert roster[cand["user"]["id"]] is None


@pytest.mark.asyncio
async def test_a_rejection_without_offers_closes_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """EMPTINESS: the pair is the rejection itself landing."""
    curator = await _master(client, db_session, _TID_CURATOR)
    admin = await _admin(client, db_session)
    cand = await _plain(client, _TID_CANDIDATE)
    await _apply(client, cand)

    await _reject(client, admin, cand)

    profile = await fresh_get(MasterProfile, UUID(cand["user"]["id"]))
    assert profile.data["account"]["status"] == "rejected"
    assert CLOSED not in await _types_for(curator)


@pytest.mark.asyncio
async def test_a_rejection_after_a_handover_tells_the_new_curator(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """SHORTAGE: the school changed hands between the offer and the
    decision. The outcome is news to whoever holds the school now."""
    curator = await _master(client, db_session, _TID_CURATOR)
    heir = await _master(client, db_session, _TID_HEIR)
    admin = await _admin(client, db_session)
    cand = await _plain(client, _TID_CANDIDATE)
    group = await _school(client, curator, "Школа передачи")
    await _seed_member(db_session, group, heir, CuratorMemberKind.MASTER)
    await _seed_member(db_session, group, cand)
    await _offer(client, curator, group, cand)
    resp = await client.post(
        TRANSFER_URL.format(group_id=group),
        json={"to_user_id": heir["user"]["id"]},
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    resp = await client.post(
        TRANSFER_ACCEPT_URL.format(group_id=group),
        headers=auth_headers(heir["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    await _apply(client, cand)

    await _reject(client, admin, cand)

    assert CLOSED in await _types_for(heir)
    assert CLOSED not in await _types_for(curator)


@pytest.mark.asyncio
async def test_a_new_offer_after_a_rejection_starts_over(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The rejected person may apply again; nothing is revived by that --
    a new appointment is the curator's new decision, and it gets the
    verification prompt again."""
    curator = await _master(client, db_session, _TID_CURATOR)
    admin = await _admin(client, db_session)
    cand = await _plain(client, _TID_CANDIDATE)
    group = await _school(client, curator, "Школа заново")
    await _seed_member(db_session, group, cand)
    await _offer(client, curator, group, cand)
    await _apply(client, cand)
    await _reject(client, admin, cand)
    await _apply(client, cand)
    assert await _offers(group) == []

    assert (await _offer(client, curator, group, cand)).status_code == 204
    assert (await _types_for(cand)).count(VERIFY_PROMPT) == 2
    assert (await _roster_state(client, curator, group))[
        cand["user"]["id"]
    ] == "awaiting_verification"


# ===========================================================================
# Revocation
# ===========================================================================


@pytest.mark.asyncio
async def test_a_revocation_keeps_the_offer_and_says_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    curator = await _master(client, db_session, _TID_CURATOR)
    admin = await _admin(client, db_session)
    cand = await _plain(client, _TID_CANDIDATE)
    group = await _school(client, curator, "Школа отзыва верификации")
    await _seed_member(db_session, group, cand)
    await _apply(client, cand)
    await _verify(client, admin, cand)
    await _offer(client, curator, group, cand)
    assert (await _roster_state(client, curator, group))[
        cand["user"]["id"]
    ] == "awaiting_answer"
    cand_before = await _school_types_for(cand)
    curator_before = await _school_types_for(curator)

    await _revoke(client, admin, cand)

    assert await _offers(group) == [UUID(cand["user"]["id"])]
    assert (await _roster_state(client, curator, group))[
        cand["user"]["id"]
    ] == "awaiting_verification"
    assert await _school_types_for(cand) == cand_before
    assert await _school_types_for(curator) == curator_before


# ===========================================================================
# The curator's withdrawal
# ===========================================================================


@pytest.mark.asyncio
async def test_the_curator_withdraws_an_offer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """204, offer gone, one journal line naming the person, candidate not
    told; their accept is then the honest 404. Done twice: the second
    withdrawal writes nothing (REPEAT)."""
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _master(client, db_session, _TID_CANDIDATE)
    group = await _school(client, curator, "Школа отзыва")
    await _seed_member(db_session, group, cand)
    await _offer(client, curator, group, cand)
    cand_before = await _school_types_for(cand)

    url = CANCEL_URL.format(group_id=group, user_id=cand["user"]["id"])
    for _ in range(2):
        resp = await client.delete(
            url, headers=auth_headers(curator["session_token"]),
        )
        assert resp.status_code == 204, resp.text

    assert await _offers(group) == []
    cancels = [
        d for e, d in await _journal(group)
        if e == CuratorGroupEventKind.MASTER_OFFER_CANCELLED.value
    ]
    assert len(cancels) == 1
    assert cancels[0]["target_user_id"] == cand["user"]["id"]
    assert await _school_types_for(cand) == cand_before
    resp = await client.post(
        ACCEPT_URL.format(group_id=group),
        headers=auth_headers(cand["session_token"]),
    )
    assert resp.status_code == 404
    assert resp.json()["error"] == "master_offer_not_found"


@pytest.mark.asyncio
async def test_withdrawing_nothing_writes_nothing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """EMPTINESS: a member with no offer -- 204 and no journal line. The
    pair: the journal does have the school's creation in it."""
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _plain(client, _TID_CANDIDATE)
    group = await _school(client, curator, "Школа пустоты")
    await _seed_member(db_session, group, cand)

    resp = await client.delete(
        CANCEL_URL.format(group_id=group, user_id=cand["user"]["id"]),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 204, resp.text
    events = [e for e, _ in await _journal(group)]
    assert events == [CuratorGroupEventKind.GROUP_CREATED.value]


@pytest.mark.asyncio
async def test_a_stranger_cannot_withdraw_somebody_elses_offer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Another curator gets the school's 404 (P-08); the offer stays."""
    curator = await _master(client, db_session, _TID_CURATOR)
    other = await _master(client, db_session, _TID_SECOND_CURATOR)
    cand = await _plain(client, _TID_CANDIDATE)
    group = await _school(client, curator, "Школа чужая")
    await _seed_member(db_session, group, cand)
    await _offer(client, curator, group, cand)

    resp = await client.delete(
        CANCEL_URL.format(group_id=group, user_id=cand["user"]["id"]),
        headers=auth_headers(other["session_token"]),
    )
    assert resp.status_code == 404
    assert await _offers(group) == [UUID(cand["user"]["id"])]


# ===========================================================================
# What the curator reads
# ===========================================================================


@pytest.mark.asyncio
async def test_the_roster_shows_the_offer_only_where_there_is_one(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """EMPTINESS with its pair: null for a member without an offer, a
    state for the one with it -- in the same response."""
    curator = await _master(client, db_session, _TID_CURATOR)
    cand = await _plain(client, _TID_CANDIDATE)
    bystander = await _plain(client, _TID_BYSTANDER, name="Ученик")
    group = await _school(client, curator, "Школа ростера")
    await _seed_member(db_session, group, cand)
    await _seed_member(db_session, group, bystander)
    await _offer(client, curator, group, cand)

    roster = await _roster_state(client, curator, group)
    assert roster[bystander["user"]["id"]] is None
    assert roster[cand["user"]["id"]] == "awaiting_verification"


@pytest.mark.asyncio
async def test_the_student_profile_shows_the_offer_to_the_curator_only(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A fellow master of the school reads null; the curator reads the state.
    Both are 200s on the same student."""
    curator = await _master(client, db_session, _TID_CURATOR)
    fellow = await _master(client, db_session, _TID_FELLOW)
    cand = await _plain(client, _TID_CANDIDATE)
    group = await _school(client, curator, "Школа профиля")
    await _seed_member(db_session, group, fellow, CuratorMemberKind.MASTER)
    await _seed_member(db_session, group, cand)
    await _offer(client, curator, group, cand)
    url = STUDENT_URL.format(group_id=group, user_id=cand["user"]["id"])

    as_curator = await client.get(
        url, headers=auth_headers(curator["session_token"]),
    )
    as_fellow = await client.get(
        url, headers=auth_headers(fellow["session_token"]),
    )
    assert as_curator.status_code == 200, as_curator.text
    assert as_fellow.status_code == 200, as_fellow.text
    assert as_curator.json()["master_offer"] == "awaiting_verification"
    assert as_fellow.json()["master_offer"] is None


# ===========================================================================
# Races -- the profile's FOR SHARE (tests/curator_race_harness.py)
# ===========================================================================


class _Race:
    """A school, its curator, an admin and a pending applicant member."""

    group: UUID
    curator: UUID
    admin: UUID
    cand: UUID


async def _race_setup(
    client: AsyncClient, db_session: AsyncSession, *, offered: bool = False,
    verified: bool = False,
) -> _Race:
    r = _Race()
    curator = await _master(client, db_session, _TID_CURATOR)
    admin = await _admin(client, db_session)
    cand = await _plain(client, _TID_CANDIDATE)
    r.curator = UUID(curator["user"]["id"])
    r.admin = UUID(admin["user"]["id"])
    r.cand = UUID(cand["user"]["id"])
    db_session.add(
        MasterProfile(
            user_id=r.cand,
            data={
                "account": {
                    "status": "verified" if verified else "pending",
                    "rejections": [],
                },
                "profile": {"bio": "c"},
            },
        )
    )
    group = CuratorGroup(curator_user_id=r.curator, name="Школа гонки")
    db_session.add(group)
    await db_session.flush()
    r.group = group.id
    db_session.add(
        CuratorGroupMember(
            group_id=r.group, user_id=r.cand,
            kind=CuratorMemberKind.STUDENT.value,
        )
    )
    if offered:
        db_session.add(CuratorGroupMasterOffer(group_id=r.group, to_user_id=r.cand))
    await db_session.flush()
    await db_session.commit()
    return r


def _offer_call(r: _Race):
    async def call(session):
        await curator_service.offer_curator_group_master(
            r.curator, r.group, r.cand, session,
            actor=await session.get(User, r.curator),
        )
    return call


def _verify_call(r: _Race):
    async def call(session):
        await admin_masters_service.verify_master(
            r.cand, await session.get(User, r.admin), None, session,
        )
    return call


def _reject_call(r: _Race):
    async def call(session):
        await admin_masters_service.reject_master(
            r.cand, await session.get(User, r.admin), "нет", session,
        )
    return call


def _accept_call(r: _Race):
    async def call(session):
        await curator_service.accept_curator_group_master_offer(
            r.group, r.cand, session, actor=await session.get(User, r.cand),
        )
    return call


def _cancel_call(r: _Race):
    async def call(session):
        await curator_service.cancel_curator_group_master_offer(
            r.curator, r.group, r.cand, session,
            actor=await session.get(User, r.curator),
        )
    return call


def _auth(uid: UUID) -> dict:
    return {"user": {"id": str(uid)}}


@pytest.mark.asyncio
async def test_a_verification_landing_mid_offer_still_asks_the_candidate(
    client, db_session, monkeypatch,
) -> None:
    """Offer first: it holds the profile FOR SHARE and reads "pending";
    the verification waits, then finds the offer and announces it.

    WITHOUT THE LOCK the verification committed past the paused offer,
    announced an empty set, and the offer -- having read "pending" --
    sent only the verification prompt: a verified candidate with a
    question nobody asked. The pair: the rival did wait, and committed.
    """
    r = await _race_setup(client, db_session)
    result = await race(
        monkeypatch,
        holder=_offer_call(r),
        pause_in=(curator_service, "_has_master_capability"),
        rival=_verify_call(r),
    )
    assert_no_deadlock(result)
    assert result.rival_waited, "the verification never met the offer's lock"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert await _school_types_for(_auth(r.cand)) == [VERIFY_PROMPT, OFFERED]


@pytest.mark.asyncio
async def test_an_offer_landing_mid_verification_asks_once(
    client, db_session, monkeypatch,
) -> None:
    """Verification first: it holds the profile and is paused before its
    announcement; the offer waits on the profile, then reads "verified"
    and asks by itself. Exactly one question, no verification prompt."""
    r = await _race_setup(client, db_session)
    result = await race(
        monkeypatch,
        holder=_verify_call(r),
        pause_in=(admin_masters_service, "announce_pending_master_offers"),
        rival=_offer_call(r),
    )
    assert_no_deadlock(result)
    assert result.rival_waited, "the offer never met the verification's lock"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    assert await _school_types_for(_auth(r.cand)) == [OFFERED]


@pytest.mark.asyncio
async def test_a_rejection_landing_mid_offer_closes_the_new_offer(
    client, db_session, monkeypatch,
) -> None:
    """Offer first, rejection waits on the profile, then finds the offer
    it would otherwise have missed and closes it -- the curator is told."""
    r = await _race_setup(client, db_session)
    result = await race(
        monkeypatch,
        holder=_offer_call(r),
        pause_in=(curator_service, "_has_master_capability"),
        rival=_reject_call(r),
    )
    assert_no_deadlock(result)
    assert result.rival_waited, "the rejection never met the offer's lock"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    offers = (
        await fresh_execute(
            select(CuratorGroupMasterOffer.id).where(
                CuratorGroupMasterOffer.group_id == r.group
            )
        )
    ).all()
    assert offers == []
    assert CLOSED in await _types_for(_auth(r.curator))


@pytest.mark.asyncio
async def test_a_withdrawal_mid_accept_neither_deadlocks_nor_double_counts(
    client, db_session, monkeypatch,
) -> None:
    """Accept holds the member row and has claimed the offer; the
    withdrawal's DELETE waits on that offer row, then finds nothing --
    204 with no journal line. A master, no offer, one promotion."""
    r = await _race_setup(client, db_session, offered=True, verified=True)
    result = await race(
        monkeypatch,
        holder=_accept_call(r),
        pause_in=(curator_service, "_has_master_capability"),
        rival=_cancel_call(r),
    )
    assert_no_deadlock(result)
    assert result.rival_waited, "the withdrawal never met the accept's claim"
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error
    kind = (
        await fresh_execute(
            select(CuratorGroupMember.kind).where(
                CuratorGroupMember.group_id == r.group,
                CuratorGroupMember.user_id == r.cand,
            )
        )
    ).scalar_one()
    assert kind == CuratorMemberKind.MASTER.value
    events = [e for e, _ in await _journal(str(r.group))]
    assert CuratorGroupEventKind.MASTER_OFFER_CANCELLED.value not in events
    assert events.count(CuratorGroupEventKind.MEMBER_PROMOTED.value) == 1
