# =============================================================================
# VELO Backend -- Tests: Curator group transfer (GT-4, 8.2 #5-6)
# =============================================================================
#
# telegram_id band: 66600-66799 (curator 66601, masters 66602-66606,
# students 66610-66619, stranger 66630, admin 66690). Declared module-level
# below as _TID_MIN/_TID_MAX, ONCE -- tests/telegram_id_bands.py parses that
# declaration out of the AST on every run, and a file that uses ids without
# declaring a band fails test_blind_zone_has_not_grown.
#
# Neighbours in the same module: 66000-66199 (CRUD), 66200-66399 (member
# page), 66400-66599 (invites). Four files, four disjoint bands.
#
# ⚠ BACKEND-ONLY, UNPROVEN LOCALLY -- no Postgres in the authoring
# environment. Written to be read and to run on the server.
#
# Coverage: the twelve rows of the TZ 3.4 "Предложение передачи" table, the
# seven-step accept transaction asserted as ONE database state, auto-cancel
# in its two and only two points, and who is allowed to see the offer.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import datetime
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupInvite,
    CuratorGroupMember,
    CuratorGroupTransfer,
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
GROUP_URL = "/api/v1/masters/me/curator-groups/{group_id}"
MEMBER_URL = "/api/v1/masters/me/curator-groups/{group_id}/members/{user_id}"
INVITES_URL = "/api/v1/masters/me/curator-groups/{group_id}/invites"
OFFER_URL = "/api/v1/masters/me/curator-groups/{group_id}/transfer"
MINE_URL = "/api/v1/curator-groups/mine"
PAGE_URL = "/api/v1/curator-groups/{group_id}"
MEMBERSHIP_URL = "/api/v1/curator-groups/{group_id}/membership"
ACCEPT_URL = "/api/v1/curator-groups/{group_id}/transfer/accept"
DECLINE_URL = "/api/v1/curator-groups/{group_id}/transfer/decline"
REVOKE_URL = "/api/v1/admin/masters/{user_id}/revoke"
MAKE_MASTER_URL = "/api/v1/admin/users/{user_id}/make-master"

_BOT_URL = "https://t.me/velo_test_bot"

_TID_MIN = 66600
_TID_MAX = 66799

_TID_CURATOR = 66601
_TID_HEIR = 66602
_TID_MASTER_B = 66603
_TID_MASTER_C = 66604
_TID_STUDENT_A = 66610
_TID_STUDENT_B = 66611
_TID_STRANGER = 66630
_TID_ADMIN = 66690


# ===========================================================================
# Local helpers -- copied, not imported, as every test file in this tree does
# ===========================================================================


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    first_name: str = "Master",
    last_name: str | None = None,
) -> dict:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )
    user_id = UUID(auth["user"]["id"])

    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    if last_name is not None:
        user.last_name = last_name
    await db_session.flush()

    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={"account": {"status": "verified"}, "profile": {"bio": "m"}},
        )
    )
    await db_session.flush()
    await db_session.commit()
    return auth


async def _make_admin(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> str:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Admin")
    await db_session.execute(
        update(User)
        .where(User.id == UUID(auth["user"]["id"]))
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    return auth["session_token"]


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


async def _seed_member(
    db_session: AsyncSession,
    group_id: str,
    user_id: str,
    kind: CuratorMemberKind,
    joined_at: datetime | None = None,
) -> None:
    row = CuratorGroupMember(
        group_id=UUID(group_id), user_id=UUID(user_id), kind=kind.value,
    )
    if joined_at is not None:
        row.joined_at = joined_at
    db_session.add(row)
    await db_session.flush()
    await db_session.commit()


async def _offer(client: AsyncClient, curator: dict, group_id: str, to: dict):
    return await client.post(
        OFFER_URL.format(group_id=group_id),
        json={"to_user_id": to["user"]["id"]},
        headers=auth_headers(curator["session_token"]),
    )


async def _cancel(client: AsyncClient, curator: dict, group_id: str):
    return await client.delete(
        OFFER_URL.format(group_id=group_id),
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


async def _page(client: AsyncClient, auth: dict, group_id: str):
    return await client.get(
        PAGE_URL.format(group_id=group_id),
        headers=auth_headers(auth["session_token"]),
    )


async def _mine(client: AsyncClient, auth: dict) -> list[dict]:
    resp = await client.get(
        MINE_URL, headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    return resp.json()["items"]


async def _transfer_rows(group_id: str):
    return (
        await fresh_execute(
            select(CuratorGroupTransfer.to_user_id).where(
                CuratorGroupTransfer.group_id == UUID(group_id)
            )
        )
    ).scalars().all()


async def _member_rows(group_id: str):
    return (
        await fresh_execute(
            select(
                CuratorGroupMember.user_id,
                CuratorGroupMember.kind,
            ).where(CuratorGroupMember.group_id == UUID(group_id))
        )
    ).all()


async def _curator_of(group_id: str):
    return (
        await fresh_execute(
            select(CuratorGroup.curator_user_id).where(
                CuratorGroup.id == UUID(group_id)
            )
        )
    ).scalar_one()


async def _revoke(client: AsyncClient, admin_token: str, user_id: str) -> None:
    resp = await client.post(
        REVOKE_URL.format(user_id=user_id), headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text


async def _re_verify(
    client: AsyncClient, admin_token: str, user_id: str,
) -> None:
    """make-master, NOT /verify: verify_master goes through
    _load_pending_profile, which 409s on anything but `pending`, and a
    revoked profile is `suspended`."""
    resp = await client.post(
        MAKE_MASTER_URL.format(user_id=user_id),
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text


async def _group_with_heir(
    client: AsyncClient, db_session: AsyncSession,
) -> tuple[dict, dict, dict]:
    """Curator + one visible master member -- the setup most tests need."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    heir = await _make_verified_master(
        client, db_session, _TID_HEIR, first_name="Анна", last_name="Петрова",
    )
    group = await _create_group(client, curator)
    await _seed_member(
        db_session, group["id"], heir["user"]["id"], CuratorMemberKind.MASTER,
    )
    return curator, heir, group


# ===========================================================================
# Cleanup
# ===========================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ===========================================================================
# TZ 3.4 row 1 -- the offer is made
# ===========================================================================


@pytest.mark.asyncio
async def test_offering_to_a_visible_master_creates_the_row(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The reply names the addressee, and the row exists afterwards."""
    curator, heir, group = await _group_with_heir(client, db_session)

    resp = await _offer(client, curator, group["id"], heir)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["to_user_id"] == heir["user"]["id"]
    assert body["to_display_name"] == "Анна Петрова"
    assert body["requested_at"]

    assert await _transfer_rows(group["id"]) == [UUID(heir["user"]["id"])]


# ===========================================================================
# TZ 3.4 row 2 -- a second offer is refused, not swallowed
# ===========================================================================


@pytest.mark.asyncio
async def test_a_second_offer_is_409_even_to_the_same_person(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """No silent overwrite: the first addressee may already be looking at
    the banner, and replacing the offer would retract it without a word.

    Both shapes are checked -- a different person AND the same person -- so
    "409" cannot be coming from a stray equality check on to_user_id.
    """
    curator, heir, group = await _group_with_heir(client, db_session)
    other = await _make_verified_master(
        client, db_session, _TID_MASTER_B, first_name="Other",
    )
    await _seed_member(
        db_session, group["id"], other["user"]["id"], CuratorMemberKind.MASTER,
    )
    assert (await _offer(client, curator, group["id"], heir)).status_code == 200

    to_other = await _offer(client, curator, group["id"], other)
    assert to_other.status_code == 409
    assert to_other.json()["error"] == "transfer_pending"

    to_same = await _offer(client, curator, group["id"], heir)
    assert to_same.status_code == 409

    assert await _transfer_rows(group["id"]) == [UUID(heir["user"]["id"])]


# ===========================================================================
# TZ 3.4 row 3 -- who cannot be the addressee
# ===========================================================================


@pytest.mark.asyncio
async def test_student_stranger_hidden_master_and_self_are_all_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """One answer for four situations (I-10), so nothing leaks about who is
    in the group or whose verification lapsed.

    Paired with a real offer succeeding on the same group, so "404" cannot
    mean the endpoint is broken.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    heir = await _make_verified_master(
        client, db_session, _TID_HEIR, first_name="Heir",
    )
    hidden = await _make_verified_master(
        client, db_session, _TID_MASTER_C, first_name="Hidden",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    stranger = await login_user(client, telegram_id=_TID_STRANGER)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    group = await _create_group(client, curator)
    for who, kind in (
        (heir, CuratorMemberKind.MASTER),
        (hidden, CuratorMemberKind.MASTER),
        (student, CuratorMemberKind.STUDENT),
    ):
        await _seed_member(db_session, group["id"], who["user"]["id"], kind)
    await _revoke(client, admin_token, hidden["user"]["id"])

    for who in (student, stranger, hidden, curator):
        resp = await _offer(client, curator, group["id"], who)
        assert resp.status_code == 404, who["user"]["id"]
        assert resp.json()["error"] == "not_found"

    assert await _transfer_rows(group["id"]) == []
    assert (await _offer(client, curator, group["id"], heir)).status_code == 200


@pytest.mark.asyncio
async def test_offering_in_a_group_with_no_members_is_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Nobody to hand it to."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    someone = await _make_verified_master(
        client, db_session, _TID_HEIR, first_name="Someone",
    )
    group = await _create_group(client, curator)

    assert (await _offer(client, curator, group["id"], someone)).status_code == 404


@pytest.mark.asyncio
async def test_offering_on_someone_elses_group_is_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    _curator, heir, group = await _group_with_heir(client, db_session)
    outsider = await _make_verified_master(
        client, db_session, _TID_MASTER_B, first_name="Outsider",
    )

    resp = await _offer(client, outsider, group["id"], heir)
    assert resp.status_code == 404
    assert (await _cancel(client, outsider, group["id"])).status_code == 404


@pytest.mark.asyncio
async def test_offering_on_a_deleted_group_is_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    curator, heir, group = await _group_with_heir(client, db_session)
    await client.delete(
        GROUP_URL.format(group_id=group["id"]),
        headers=auth_headers(curator["session_token"]),
    )

    assert (await _offer(client, curator, group["id"], heir)).status_code == 404


# ===========================================================================
# TZ 3.4 rows 4 and 6 -- cancel and decline
# ===========================================================================


@pytest.mark.asyncio
async def test_cancel_removes_the_offer_and_repeats_are_still_204(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The first 204 is checked against the row actually going away, so
    "204" can never stand in for "did nothing"."""
    curator, heir, group = await _group_with_heir(client, db_session)
    await _offer(client, curator, group["id"], heir)

    first = await _cancel(client, curator, group["id"])
    assert first.status_code == 204
    assert await _transfer_rows(group["id"]) == []

    assert (await _cancel(client, curator, group["id"])).status_code == 204

    # And the group can be offered again afterwards -- cancel is a
    # withdrawal, not a lock.
    assert (await _offer(client, curator, group["id"], heir)).status_code == 200


@pytest.mark.asyncio
async def test_decline_removes_the_offer_and_repeats_are_still_204(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    curator, heir, group = await _group_with_heir(client, db_session)
    await _offer(client, curator, group["id"], heir)

    first = await _decline(client, heir, group["id"])
    assert first.status_code == 204
    assert await _transfer_rows(group["id"]) == []
    assert await _curator_of(group["id"]) == UUID(curator["user"]["id"])

    assert (await _decline(client, heir, group["id"])).status_code == 204


@pytest.mark.asyncio
async def test_declining_an_offer_that_is_not_yours_is_204_and_harmless(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Decline answers 204 where accept answers 404, and the asymmetry is
    the point: refusing something never offered to you leaves the world in
    the state you asked for, and says nothing about whether an offer exists.

    The pair is the row survival check -- a stranger's decline must not
    clear somebody else's offer.
    """
    curator, heir, group = await _group_with_heir(client, db_session)
    stranger = await login_user(client, telegram_id=_TID_STRANGER)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    await _seed_member(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    await _offer(client, curator, group["id"], heir)

    for who in (stranger, student, curator):
        assert (await _decline(client, who, group["id"])).status_code == 204

    assert await _transfer_rows(group["id"]) == [UUID(heir["user"]["id"])]


# ===========================================================================
# TZ 3.4 row 5 + 3.5 -- the accept transaction
# ===========================================================================


@pytest.mark.asyncio
async def test_accept_moves_the_group_in_one_transaction(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The whole of TZ 3.5 asserted as ONE database state.

    Seven things must all hold together, and checking them in separate
    tests would let a half-applied transaction pass six of them: the new
    curator owns the group, has no member row of their own (I-2), the
    previous curator holds a kind='master' row, the offer is gone, both
    invite tokens are byte-identical, other memberships are untouched, and
    masters_count is unchanged -- one master became the curator while the
    curator became a master.
    """
    curator, heir, group = await _group_with_heir(client, db_session)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    await _seed_member(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    with patch.object(settings, "telegram_bot_url", _BOT_URL):
        for kind in ("master", "student"):
            resp = await client.post(
                INVITES_URL.format(group_id=group["id"]),
                json={"kind": kind},
                headers=auth_headers(curator["session_token"]),
            )
            assert resp.status_code == 200
    tokens_before = sorted(
        (
            await fresh_execute(
                select(CuratorGroupInvite.token).where(
                    CuratorGroupInvite.group_id == UUID(group["id"])
                )
            )
        ).scalars().all()
    )
    counts_before = (await _page(client, curator, group["id"])).json()

    await _offer(client, curator, group["id"], heir)
    accepted = await _accept(client, heir, group["id"])
    assert accepted.status_code == 200, accepted.text

    page = accepted.json()
    assert page["viewer"]["relation"] == "curator"
    assert page["curator"]["user_id"] == heir["user"]["id"]
    assert page["transfer"] is None

    assert await _curator_of(group["id"]) == UUID(heir["user"]["id"])

    rows = {str(uid): kind for uid, kind in await _member_rows(group["id"])}
    assert heir["user"]["id"] not in rows
    assert rows[curator["user"]["id"]] == "master"
    assert rows[student["user"]["id"]] == "student"

    assert await _transfer_rows(group["id"]) == []

    tokens_after = sorted(
        (
            await fresh_execute(
                select(CuratorGroupInvite.token).where(
                    CuratorGroupInvite.group_id == UUID(group["id"])
                )
            )
        ).scalars().all()
    )
    assert tokens_after == tokens_before

    assert page["masters_count"] == counts_before["masters_count"]
    assert page["students_count"] == counts_before["students_count"]


@pytest.mark.asyncio
async def test_the_previous_curator_can_leave_the_normal_way_afterwards(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Why step 4 is an invariant and not a courtesy: without the member row
    the previous curator would have vanished from the school silently, and
    leave would answer 204 to somebody with no tie to it at all."""
    curator, heir, group = await _group_with_heir(client, db_session)
    await _offer(client, curator, group["id"], heir)
    await _accept(client, heir, group["id"])

    page = await _page(client, curator, group["id"])
    assert page.status_code == 200
    assert page.json()["viewer"]["relation"] == "master"

    left = await client.delete(
        MEMBERSHIP_URL.format(group_id=group["id"]),
        headers=auth_headers(curator["session_token"]),
    )
    assert left.status_code == 204
    assert (await _page(client, curator, group["id"])).status_code == 404


@pytest.mark.asyncio
async def test_the_new_curator_cannot_leave_and_the_old_one_can(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Ownership really moved: the 409 follows the group, not the person."""
    curator, heir, group = await _group_with_heir(client, db_session)
    await _offer(client, curator, group["id"], heir)
    await _accept(client, heir, group["id"])

    heirs_exit = await client.delete(
        MEMBERSHIP_URL.format(group_id=group["id"]),
        headers=auth_headers(heir["session_token"]),
    )
    assert heirs_exit.status_code == 409
    assert heirs_exit.json()["error"] == "curator_cannot_leave"


@pytest.mark.asyncio
async def test_a_name_collision_refuses_before_anything_is_written(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """UNIQUE (curator_user_id, name) would fire on step 2 with three more
    mutations already queued behind it. Checking first turns a rollback into
    a clean 409 -- and this test asserts the "nothing happened" half, which
    is the part a caught IntegrityError would get wrong.
    """
    curator, heir, group = await _group_with_heir(client, db_session)
    own = await _create_group(client, heir, name=group["name"])
    assert own["name"] == group["name"]

    await _offer(client, curator, group["id"], heir)
    refused = await _accept(client, heir, group["id"])
    assert refused.status_code == 409
    assert refused.json()["error"] == "curator_group_name_taken"

    assert await _curator_of(group["id"]) == UUID(curator["user"]["id"])
    rows = {str(uid): kind for uid, kind in await _member_rows(group["id"])}
    assert rows == {heir["user"]["id"]: "master"}
    assert await _transfer_rows(group["id"]) == [UUID(heir["user"]["id"])]


@pytest.mark.asyncio
async def test_renaming_the_clashing_group_lets_the_accept_through(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The pair for the 409 above: the offer stays live, so the addressee
    can rename their own group and try again."""
    curator, heir, group = await _group_with_heir(client, db_session)
    own = await _create_group(client, heir, name=group["name"])
    await _offer(client, curator, group["id"], heir)
    assert (await _accept(client, heir, group["id"])).status_code == 409

    renamed = await client.patch(
        GROUP_URL.format(group_id=own["id"]),
        json={"name": "Другая школа"},
        headers=auth_headers(heir["session_token"]),
    )
    assert renamed.status_code == 200

    assert (await _accept(client, heir, group["id"])).status_code == 200
    assert await _curator_of(group["id"]) == UUID(heir["user"]["id"])


# ===========================================================================
# TZ 3.4 row 7 -- accept by the wrong person
# ===========================================================================


@pytest.mark.asyncio
async def test_accept_by_anyone_but_the_addressee_is_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Accept changes who owns a school, so it refuses to distinguish "no
    offer" from "not your offer" -- that is what closes off probing.

    The curator is included deliberately: they made the offer and still
    cannot take it.
    """
    curator, heir, group = await _group_with_heir(client, db_session)
    other = await _make_verified_master(
        client, db_session, _TID_MASTER_B, first_name="Other",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    await _seed_member(
        db_session, group["id"], other["user"]["id"], CuratorMemberKind.MASTER,
    )
    await _seed_member(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    await _offer(client, curator, group["id"], heir)

    for who in (other, student, curator):
        resp = await _accept(client, who, group["id"])
        assert resp.status_code == 404, who["user"]["id"]
        assert resp.json()["error"] == "not_found"

    assert await _curator_of(group["id"]) == UUID(curator["user"]["id"])
    assert (await _accept(client, heir, group["id"])).status_code == 200


@pytest.mark.asyncio
async def test_accept_with_no_offer_at_all_is_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    _curator, heir, group = await _group_with_heir(client, db_session)
    assert (await _accept(client, heir, group["id"])).status_code == 404


@pytest.mark.asyncio
async def test_accepting_twice_gives_404_the_second_time(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The row is gone and the caller is now the curator -- who is by
    definition not the addressee of anything."""
    curator, heir, group = await _group_with_heir(client, db_session)
    await _offer(client, curator, group["id"], heir)
    assert (await _accept(client, heir, group["id"])).status_code == 200
    assert (await _accept(client, heir, group["id"])).status_code == 404


@pytest.mark.asyncio
async def test_accept_after_cancel_is_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    curator, heir, group = await _group_with_heir(client, db_session)
    await _offer(client, curator, group["id"], heir)
    await _cancel(client, curator, group["id"])

    assert (await _accept(client, heir, group["id"])).status_code == 404
    assert await _curator_of(group["id"]) == UUID(curator["user"]["id"])


# ===========================================================================
# TZ 3.4 rows 9 and 10 -- suspension on either side
# ===========================================================================


@pytest.mark.asyncio
async def test_a_suspended_addressee_keeps_the_offer_but_cannot_take_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Being offered the group and being able to accept it are different
    questions, asked at different times.

    The row survives (the curator sees it "in the shadow" and can withdraw
    it), accept gives 403, and re-verification makes the SAME offer work --
    proving nothing was rewritten in between.
    """
    curator, heir, group = await _group_with_heir(client, db_session)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    await _offer(client, curator, group["id"], heir)

    await _revoke(client, admin_token, heir["user"]["id"])

    refused = await _accept(client, heir, group["id"])
    assert refused.status_code == 403
    assert refused.json()["error"] == "master_required"
    assert await _transfer_rows(group["id"]) == [UUID(heir["user"]["id"])]

    seen = (await _page(client, curator, group["id"])).json()
    assert seen["transfer"]["to_user_id"] == heir["user"]["id"]

    await _re_verify(client, admin_token, heir["user"]["id"])
    assert (await _accept(client, heir, group["id"])).status_code == 200


@pytest.mark.asyncio
async def test_the_curator_can_withdraw_an_offer_made_to_a_suspended_master(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Cancel does not consult the addressee's status -- otherwise the
    curator would be stuck with an offer nobody can take."""
    curator, heir, group = await _group_with_heir(client, db_session)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    await _offer(client, curator, group["id"], heir)
    await _revoke(client, admin_token, heir["user"]["id"])

    assert (await _cancel(client, curator, group["id"])).status_code == 204
    assert await _transfer_rows(group["id"]) == []


@pytest.mark.asyncio
async def test_a_suspended_curator_hides_the_offer_and_reverification_restores_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """I-6 reaches accept too: an inactive group answers 404 to its own
    addressee, and the offer is still there when the group comes back."""
    curator, heir, group = await _group_with_heir(client, db_session)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    await _offer(client, curator, group["id"], heir)

    await _revoke(client, admin_token, curator["user"]["id"])
    assert (await _accept(client, heir, group["id"])).status_code == 404
    assert (await _page(client, heir, group["id"])).status_code == 404
    assert await _transfer_rows(group["id"]) == [UUID(heir["user"]["id"])]

    await _re_verify(client, admin_token, curator["user"]["id"])
    assert (await _accept(client, heir, group["id"])).status_code == 200
    assert await _curator_of(group["id"]) == UUID(heir["user"]["id"])


# ===========================================================================
# TZ 3.4 row 8 -- auto-cancel, and only in its two points
# ===========================================================================


@pytest.mark.asyncio
async def test_the_addressee_leaving_retracts_the_offer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    curator, heir, group = await _group_with_heir(client, db_session)
    await _offer(client, curator, group["id"], heir)

    left = await client.delete(
        MEMBERSHIP_URL.format(group_id=group["id"]),
        headers=auth_headers(heir["session_token"]),
    )
    assert left.status_code == 204
    assert await _transfer_rows(group["id"]) == []


@pytest.mark.asyncio
async def test_the_curator_removing_the_addressee_retracts_the_offer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    curator, heir, group = await _group_with_heir(client, db_session)
    await _offer(client, curator, group["id"], heir)

    removed = await client.delete(
        MEMBER_URL.format(
            group_id=group["id"], user_id=heir["user"]["id"],
        ),
        headers=auth_headers(curator["session_token"]),
    )
    assert removed.status_code == 204
    assert await _transfer_rows(group["id"]) == []


@pytest.mark.asyncio
async def test_somebody_else_leaving_does_not_touch_the_offer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The pair that proves auto-cancel is scoped to the addressee, not to
    the group: without the (group, to_user_id) filter this offer would die
    when an unrelated member walked out.
    """
    curator, heir, group = await _group_with_heir(client, db_session)
    bystander = await _make_verified_master(
        client, db_session, _TID_MASTER_B, first_name="Bystander",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_B)
    await _seed_member(
        db_session, group["id"], bystander["user"]["id"],
        CuratorMemberKind.MASTER,
    )
    await _seed_member(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    await _offer(client, curator, group["id"], heir)

    await client.delete(
        MEMBERSHIP_URL.format(group_id=group["id"]),
        headers=auth_headers(bystander["session_token"]),
    )
    await client.delete(
        MEMBER_URL.format(
            group_id=group["id"], user_id=student["user"]["id"],
        ),
        headers=auth_headers(curator["session_token"]),
    )

    assert await _transfer_rows(group["id"]) == [UUID(heir["user"]["id"])]


@pytest.mark.asyncio
async def test_leaving_an_inactive_group_still_retracts_the_offer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Auto-cancel follows the membership, not the group's visibility.

    leave deliberately never checks whether the group is active (I-5), and
    that must not turn into "the offer survives because nobody could see
    the group at the time".
    """
    curator, heir, group = await _group_with_heir(client, db_session)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    await _offer(client, curator, group["id"], heir)
    await _revoke(client, admin_token, curator["user"]["id"])

    left = await client.delete(
        MEMBERSHIP_URL.format(group_id=group["id"]),
        headers=auth_headers(heir["session_token"]),
    )
    assert left.status_code == 204
    assert await _transfer_rows(group["id"]) == []

    await _re_verify(client, admin_token, curator["user"]["id"])
    assert (await _accept(client, heir, group["id"])).status_code == 404


# ===========================================================================
# TZ 3.4 row 11 -- the group is deleted
# ===========================================================================


@pytest.mark.asyncio
async def test_deleting_the_group_takes_the_offer_with_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """ON DELETE CASCADE, asserted rather than assumed -- the offer table
    has had this FK since GT-1 and this is its first writer."""
    curator, heir, group = await _group_with_heir(client, db_session)
    await _offer(client, curator, group["id"], heir)
    assert await _transfer_rows(group["id"]) != []

    deleted = await client.delete(
        GROUP_URL.format(group_id=group["id"]),
        headers=auth_headers(curator["session_token"]),
    )
    assert deleted.status_code == 204
    assert await _transfer_rows(group["id"]) == []


# ===========================================================================
# Who sees the offer
# ===========================================================================


@pytest.mark.asyncio
async def test_the_offer_is_visible_to_exactly_two_people(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Curator and addressee see it; another master and a student see null.

    Not a redacted object and not a missing key -- a member outside the deal
    does not learn that one is under way.
    """
    curator, heir, group = await _group_with_heir(client, db_session)
    other = await _make_verified_master(
        client, db_session, _TID_MASTER_B, first_name="Other",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    await _seed_member(
        db_session, group["id"], other["user"]["id"], CuratorMemberKind.MASTER,
    )
    await _seed_member(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    await _offer(client, curator, group["id"], heir)

    for who in (curator, heir):
        body = (await _page(client, who, group["id"])).json()
        assert body["transfer"] is not None, who["user"]["id"]
        assert body["transfer"]["to_user_id"] == heir["user"]["id"]

    for who in (other, student):
        body = (await _page(client, who, group["id"])).json()
        assert body["transfer"] is None, who["user"]["id"]


@pytest.mark.asyncio
async def test_transfer_offered_is_true_only_for_the_addressee(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Including for the curator, who sees false on their own offer: the
    flag means "somebody is waiting on you", and nobody is waiting on
    them."""
    curator, heir, group = await _group_with_heir(client, db_session)
    other = await _make_verified_master(
        client, db_session, _TID_MASTER_B, first_name="Other",
    )
    await _seed_member(
        db_session, group["id"], other["user"]["id"], CuratorMemberKind.MASTER,
    )

    before = {i["id"]: i["transfer_offered"] for i in await _mine(client, heir)}
    assert before[group["id"]] is False

    await _offer(client, curator, group["id"], heir)

    after = {i["id"]: i["transfer_offered"] for i in await _mine(client, heir)}
    assert after[group["id"]] is True

    for who in (curator, other):
        rows = {i["id"]: i["transfer_offered"] for i in await _mine(client, who)}
        assert rows[group["id"]] is False, who["user"]["id"]


@pytest.mark.asyncio
async def test_the_curator_list_and_patch_both_carry_the_offer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """One schema, one field set. PATCH returns CuratorGroupResponse, so a
    rename reports the pending offer alongside the new name -- and does not
    disturb it."""
    curator, heir, group = await _group_with_heir(client, db_session)
    headers = auth_headers(curator["session_token"])

    listed = (await client.get(CURATOR_GROUPS_URL, headers=headers)).json()
    assert listed["items"][0]["transfer"] is None

    await _offer(client, curator, group["id"], heir)

    listed = (await client.get(CURATOR_GROUPS_URL, headers=headers)).json()
    assert listed["items"][0]["transfer"]["to_user_id"] == heir["user"]["id"]

    renamed = await client.patch(
        GROUP_URL.format(group_id=group["id"]),
        json={"name": "Школа дыхания и покоя"},
        headers=headers,
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Школа дыхания и покоя"
    assert renamed.json()["transfer"]["to_user_id"] == heir["user"]["id"]
    assert await _transfer_rows(group["id"]) == [UUID(heir["user"]["id"])]


@pytest.mark.asyncio
async def test_a_newly_created_group_reports_no_transfer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The field is present and null, not absent."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    resp = await client.post(
        CURATOR_GROUPS_URL,
        json={"name": "Новая"},
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 201
    assert resp.json()["transfer"] is None


# ===========================================================================
# Edges
# ===========================================================================


@pytest.mark.asyncio
async def test_the_sole_master_can_take_the_group(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The smallest possible school still transfers: afterwards the former
    curator is the only master member, and the counter has not moved."""
    curator, heir, group = await _group_with_heir(client, db_session)
    before = (await _page(client, curator, group["id"])).json()["masters_count"]

    await _offer(client, curator, group["id"], heir)
    page = (await _accept(client, heir, group["id"])).json()

    assert page["masters_count"] == before == 1
    rows = {str(uid): kind for uid, kind in await _member_rows(group["id"])}
    assert rows == {curator["user"]["id"]: "master"}


@pytest.mark.asyncio
async def test_a_malformed_group_id_is_422_and_an_unknown_one_is_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """{group_id} is a UUID in the path, so a malformed id never reaches the
    service and 404 stays reserved for "not yours / not there"."""
    curator, heir, _group = await _group_with_heir(client, db_session)

    malformed = await client.post(
        OFFER_URL.format(group_id="not-a-uuid"),
        json={"to_user_id": heir["user"]["id"]},
        headers=auth_headers(curator["session_token"]),
    )
    assert malformed.status_code == 422

    unknown = await client.post(
        OFFER_URL.format(group_id=uuid4()),
        json={"to_user_id": heir["user"]["id"]},
        headers=auth_headers(curator["session_token"]),
    )
    assert unknown.status_code == 404

    assert (await _accept(client, heir, str(uuid4()))).status_code == 404


@pytest.mark.asyncio
async def test_a_malformed_to_user_id_is_422(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    curator, _heir, group = await _group_with_heir(client, db_session)
    resp = await client.post(
        OFFER_URL.format(group_id=group["id"]),
        json={"to_user_id": "nobody"},
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_a_plain_user_cannot_reach_the_curator_side_at_all(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """get_current_master gates offer and cancel; nothing here re-implements
    that check."""
    _curator, heir, group = await _group_with_heir(client, db_session)
    plain = await login_user(client, telegram_id=_TID_STUDENT_A)

    offered = await client.post(
        OFFER_URL.format(group_id=group["id"]),
        json={"to_user_id": heir["user"]["id"]},
        headers=auth_headers(plain["session_token"]),
    )
    assert offered.status_code == 403

    cancelled = await client.delete(
        OFFER_URL.format(group_id=group["id"]),
        headers=auth_headers(plain["session_token"]),
    )
    assert cancelled.status_code == 403
