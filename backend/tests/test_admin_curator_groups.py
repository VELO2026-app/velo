# =============================================================================
# VELO Backend -- Tests: Admin view of the schools (P4, GT-9)
# =============================================================================
#
# telegram_id band: 69000-69099 (admin 69090, curators 69001-69003, masters
# 69010-69015, students 69020-69029). Declared module-level below as
# _TID_MIN/_TID_MAX, ONCE -- tests/telegram_id_bands.py parses that
# declaration out of the AST on every run, and a file that uses ids without
# declaring a band fails test_blind_zone_has_not_grown.
#
# ⚠ BACKEND-ONLY, UNPROVEN LOCALLY -- no Postgres in the authoring
# environment. Written to be read and to run on the server.
#
# THE SEED IS NOT COVERED HERE. scripts/seed.py talks to a live stand
# database and never runs from the suite; its check is the owner's ritual
# and the commands are in the delivery report.
#
# Coverage: the admin list (both kinds of school in one listing, counters,
# pagination, auth), curator_groups_count in the masters list, and the pair
# that makes is_active mean something -- a frozen school visible here and
# 404 for its own members at the same moment.
# =============================================================================

from collections.abc import AsyncGenerator
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.curator_groups.models import (
    CuratorGroup,
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

ADMIN_GROUPS_URL = "/api/v1/admin/curator-groups"
ADMIN_MASTERS_URL = "/api/v1/admin/masters/list"
CURATOR_GROUPS_URL = "/api/v1/masters/me/curator-groups"
PAGE_URL = "/api/v1/curator-groups/{group_id}"
MINE_URL = "/api/v1/curator-groups/mine"
REVOKE_URL = "/api/v1/admin/masters/{user_id}/revoke"
MAKE_MASTER_URL = "/api/v1/admin/users/{user_id}/make-master"

_TID_MIN = 69000
_TID_MAX = 69099

_TID_CURATOR = 69001
_TID_CURATOR_B = 69002
_TID_MASTER_A = 69010
_TID_MASTER_B = 69011
_TID_STUDENT_A = 69020
_TID_STUDENT_B = 69021
_TID_ADMIN = 69090


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
) -> None:
    db_session.add(
        CuratorGroupMember(
            group_id=UUID(group_id), user_id=UUID(user_id), kind=kind.value,
        )
    )
    await db_session.flush()
    await db_session.commit()


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


async def _admin_list(
    client: AsyncClient, admin_token: str, query: str = "",
) -> dict:
    resp = await client.get(
        f"{ADMIN_GROUPS_URL}{query}", headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _find_paged(
    client: AsyncClient, admin_token: str, url: str, row_id: str,
) -> dict | None:
    """Walk the pages until the row turns up, or the list runs out.

    Deliberately NOT a single ?limit=100 call. These are PLATFORM-WIDE
    listings: every other test file's masters and schools are in them too,
    and however many there are today, one page is a bet on a number nobody
    is holding constant. Walking is a few more requests and no assumption.
    """
    offset = 0
    while True:
        resp = await client.get(
            f"{url}?limit=100&offset={offset}",
            headers=auth_headers(admin_token),
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        for item in body["items"]:
            if item["id"] == row_id:
                return item
        offset += len(body["items"])
        if not body["items"] or offset >= body["total"]:
            return None


async def _all_pages(
    client: AsyncClient, admin_token: str, url: str,
) -> list[dict]:
    """Every row of a paginated admin listing, for the same reason."""
    items: list[dict] = []
    offset = 0
    while True:
        resp = await client.get(
            f"{url}?limit=100&offset={offset}",
            headers=auth_headers(admin_token),
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        items.extend(body["items"])
        offset += len(body["items"])
        if not body["items"] or offset >= body["total"]:
            return items


async def _row_for(
    client: AsyncClient, admin_token: str, group_id: str,
) -> dict | None:
    return await _find_paged(client, admin_token, ADMIN_GROUPS_URL, group_id)


async def _master_row(
    client: AsyncClient, admin_token: str, user_id: str,
) -> dict | None:
    return await _find_paged(client, admin_token, ADMIN_MASTERS_URL, user_id)


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
# Auth
# ===========================================================================


@pytest.mark.asyncio
async def test_a_non_admin_cannot_read_the_school_list(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """403 from get_current_admin -- there is no auth code of our own here.

    Paired with the admin's own 200 on the same URL, so "403" cannot mean
    the route is simply not mounted.
    """
    master = await _make_verified_master(client, db_session, _TID_CURATOR)
    plain = await login_user(client, telegram_id=_TID_STUDENT_A)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)

    for who in (master, plain):
        resp = await client.get(
            ADMIN_GROUPS_URL, headers=auth_headers(who["session_token"]),
        )
        assert resp.status_code == 403, who["user"]["id"]

    ok = await client.get(
        ADMIN_GROUPS_URL, headers=auth_headers(admin_token),
    )
    assert ok.status_code == 200


# ===========================================================================
# The list itself
# ===========================================================================


@pytest.mark.asyncio
async def test_the_list_carries_the_curator_and_both_counters(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Counters follow the same visibility rule the group's own page uses --
    asserted by comparing the two answers, not by restating the rule."""
    curator = await _make_verified_master(
        client, db_session, _TID_CURATOR, first_name="Анна", last_name="Петрова",
    )
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER_A, first_name="Teacher",
    )
    student_a = await login_user(client, telegram_id=_TID_STUDENT_A)
    student_b = await login_user(client, telegram_id=_TID_STUDENT_B)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    group = await _create_group(client, curator, name="Школа дыхания")
    await _seed_member(
        db_session, group["id"], teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    for who in (student_a, student_b):
        await _seed_member(
            db_session, group["id"], who["user"]["id"],
            CuratorMemberKind.STUDENT,
        )

    row = await _row_for(client, admin_token, group["id"])
    assert row is not None
    assert row["name"] == "Школа дыхания"
    assert row["curator"] == {
        "user_id": curator["user"]["id"], "display_name": "Анна Петрова",
    }
    assert row["masters_count"] == 1
    assert row["students_count"] == 2
    assert row["is_active"] is True
    assert row["created_at"]

    page = (
        await client.get(
            PAGE_URL.format(group_id=group["id"]),
            headers=auth_headers(curator["session_token"]),
        )
    ).json()
    assert row["masters_count"] == page["masters_count"]
    assert row["students_count"] == page["students_count"]


@pytest.mark.asyncio
async def test_a_frozen_school_stays_in_the_admin_list_while_members_get_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The reason is_active is a FIELD and not a filter, in one test.

    At the same moment: the admin sees the school with is_active=false, and
    its own member gets a 404 and an empty /mine. Re-verification puts both
    back, with the counters unchanged -- nothing was rewritten to hide it.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    group = await _create_group(client, curator)
    await _seed_member(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    before = await _row_for(client, admin_token, group["id"])
    assert before["is_active"] is True

    await _revoke(client, admin_token, curator["user"]["id"])

    frozen = await _row_for(client, admin_token, group["id"])
    assert frozen is not None
    assert frozen["is_active"] is False
    assert frozen["students_count"] == before["students_count"] == 1

    members_view = await client.get(
        PAGE_URL.format(group_id=group["id"]),
        headers=auth_headers(student["session_token"]),
    )
    assert members_view.status_code == 404
    mine = await client.get(
        MINE_URL, headers=auth_headers(student["session_token"]),
    )
    assert mine.json()["items"] == []

    await _re_verify(client, admin_token, curator["user"]["id"])

    thawed = await _row_for(client, admin_token, group["id"])
    assert thawed["is_active"] is True
    assert thawed["students_count"] == 1
    assert (
        await client.get(
            PAGE_URL.format(group_id=group["id"]),
            headers=auth_headers(student["session_token"]),
        )
    ).status_code == 200


@pytest.mark.asyncio
async def test_a_revoked_member_drops_out_of_masters_count_but_keeps_the_row(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """I-4 as the admin sees it. The row survival check is the pair: without
    it, "the count fell" could equally mean the membership was deleted."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER_A, first_name="Teacher",
    )
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    group = await _create_group(client, curator)
    await _seed_member(
        db_session, group["id"], teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    assert (await _row_for(client, admin_token, group["id"]))[
        "masters_count"
    ] == 1

    await _revoke(client, admin_token, teacher["user"]["id"])

    row = await _row_for(client, admin_token, group["id"])
    assert row["masters_count"] == 0
    assert row["is_active"] is True

    rows = (
        await fresh_execute(
            select(CuratorGroupMember.user_id).where(
                CuratorGroupMember.group_id == UUID(group["id"])
            )
        )
    ).scalars().all()
    assert UUID(teacher["user"]["id"]) in rows


@pytest.mark.asyncio
async def test_an_empty_school_reports_zeros_and_is_still_listed(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    group = await _create_group(client, curator)

    row = await _row_for(client, admin_token, group["id"])
    assert row is not None
    assert (row["masters_count"], row["students_count"]) == (0, 0)


@pytest.mark.asyncio
async def test_schools_of_different_curators_all_appear(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The list is platform-wide, not scoped to anyone."""
    first = await _make_verified_master(client, db_session, _TID_CURATOR)
    second = await _make_verified_master(
        client, db_session, _TID_CURATOR_B, first_name="Second",
    )
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    a = await _create_group(client, first, name="Первая школа")
    b = await _create_group(client, second, name="Вторая школа")

    found = {
        i["id"]: i["curator"]["user_id"]
        for i in await _all_pages(client, admin_token, ADMIN_GROUPS_URL)
    }
    assert found[a["id"]] == first["user"]["id"]
    assert found[b["id"]] == second["user"]["id"]


@pytest.mark.asyncio
async def test_a_deleted_school_leaves_the_list(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Deletion is physical, so this is the one way a school disappears --
    unlike freezing, which only flips a flag."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    group = await _create_group(client, curator)
    assert await _row_for(client, admin_token, group["id"]) is not None

    await client.delete(
        f"{CURATOR_GROUPS_URL}/{group['id']}",
        headers=auth_headers(curator["session_token"]),
    )

    assert await _row_for(client, admin_token, group["id"]) is None
    left = (
        await fresh_execute(
            select(CuratorGroup.id).where(CuratorGroup.id == UUID(group["id"]))
        )
    ).scalars().all()
    assert left == []


@pytest.mark.asyncio
async def test_the_list_is_newest_first(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """created_at DESC, matching every other admin listing with a natural
    time order."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    older = await _create_group(client, curator, name="Старая")
    newer = await _create_group(client, curator, name="Новая")

    ours = [
        i["id"]
        for i in await _all_pages(client, admin_token, ADMIN_GROUPS_URL)
        if i["id"] in (older["id"], newer["id"])
    ]
    assert ours == [newer["id"], older["id"]]


@pytest.mark.asyncio
async def test_pagination_walks_the_list_without_repeating_a_row(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """limit=1 across the page, plus an offset past total giving an empty
    page with total intact."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    for name in ("Первая", "Вторая", "Третья"):
        await _create_group(client, curator, name=name)

    total = (await _admin_list(client, admin_token))["total"]
    assert total >= 3

    seen = []
    for offset in range(3):
        page = await _admin_list(client, admin_token, f"?limit=1&offset={offset}")
        assert page["limit"] == 1
        assert page["offset"] == offset
        assert page["total"] == total
        assert len(page["items"]) == 1
        seen.append(page["items"][0]["id"])
    assert len(set(seen)) == 3

    far = await _admin_list(client, admin_token, f"?offset={total + 50}")
    assert far["items"] == []
    assert far["total"] == total


@pytest.mark.asyncio
async def test_an_out_of_range_limit_is_422(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    for query in ("?limit=0", "?limit=101", "?offset=-1"):
        resp = await client.get(
            f"{ADMIN_GROUPS_URL}{query}", headers=auth_headers(admin_token),
        )
        assert resp.status_code == 422, query


@pytest.mark.asyncio
async def test_the_admin_list_says_nothing_about_transfers(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A hand-over is a deal between two people and the admin is not one of
    them (TZ 1), so the field is absent rather than shown "in the shadow".

    Asserted with a LIVE offer in place, which is the only state where the
    absence could be wrong.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    heir = await _make_verified_master(
        client, db_session, _TID_MASTER_A, first_name="Heir",
    )
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    group = await _create_group(client, curator)
    await _seed_member(
        db_session, group["id"], heir["user"]["id"], CuratorMemberKind.MASTER,
    )
    offered = await client.post(
        f"{CURATOR_GROUPS_URL}/{group['id']}/transfer",
        json={"to_user_id": heir["user"]["id"]},
        headers=auth_headers(curator["session_token"]),
    )
    assert offered.status_code == 200, offered.text

    row = await _row_for(client, admin_token, group["id"])
    assert "transfer" not in row
    assert "transfer_offered" not in row


# ===========================================================================
# curator_groups_count in the masters list
# ===========================================================================


@pytest.mark.asyncio
async def test_curator_groups_count_is_zero_not_null_without_schools(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Zero is a real answer; null is reserved for "fell out of the batch",
    exactly as for the two counters beside it."""
    master = await _make_verified_master(client, db_session, _TID_MASTER_A)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)

    row = await _master_row(client, admin_token, master["user"]["id"])
    assert row is not None
    assert row["curator_groups_count"] == 0


@pytest.mark.asyncio
async def test_curator_groups_count_counts_owned_schools_only(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Two of their own -> 2. Teaching in somebody else's school does NOT
    add to it: ownership lives in curator_user_id and nowhere else (I-2),
    and the pair here is the master who is a member of a third school and
    still reports 2.
    """
    owner = await _make_verified_master(client, db_session, _TID_MASTER_A)
    other = await _make_verified_master(
        client, db_session, _TID_CURATOR, first_name="Other",
    )
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    await _create_group(client, owner, name="Своя первая")
    await _create_group(client, owner, name="Своя вторая")
    theirs = await _create_group(client, other, name="Чужая")
    await _seed_member(
        db_session, theirs["id"], owner["user"]["id"], CuratorMemberKind.MASTER,
    )

    row = await _master_row(client, admin_token, owner["user"]["id"])
    assert row["curator_groups_count"] == 2

    other_row = await _master_row(client, admin_token, other["user"]["id"])
    assert other_row["curator_groups_count"] == 1


@pytest.mark.asyncio
async def test_revoking_a_master_does_not_change_their_school_count(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Frozen schools still belong to the person, and this is the screen
    where the admin has to see that.

    The pair that gives it meaning: the same schools now report
    is_active=false in the school list, so the count did not stay put out of
    ignorance -- both facts hold at once.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER_A)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    first = await _create_group(client, master, name="Первая")
    second = await _create_group(client, master, name="Вторая")
    assert (await _master_row(client, admin_token, master["user"]["id"]))[
        "curator_groups_count"
    ] == 2

    await _revoke(client, admin_token, master["user"]["id"])

    row = await _master_row(client, admin_token, master["user"]["id"])
    assert row is not None
    assert row["curator_groups_count"] == 2

    states = {
        i["id"]: i["is_active"]
        for i in await _all_pages(client, admin_token, ADMIN_GROUPS_URL)
        if i["id"] in (first["id"], second["id"])
    }
    assert states == {first["id"]: False, second["id"]: False}


@pytest.mark.asyncio
async def test_the_masters_list_still_carries_its_original_fields(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The new field is additive: the neighbours it was modelled on are
    still there and still filled, so nothing was displaced on the way in."""
    master = await _make_verified_master(client, db_session, _TID_MASTER_A)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    await _create_group(client, master, name="Школа")

    row = await _master_row(client, admin_token, master["user"]["id"])
    for field in (
        "master_status",
        "practices_count",
        "students_count",
        "available_cents",
        "curator_groups_count",
    ):
        assert field in row, field
    assert row["practices_count"] == 0
    assert row["curator_groups_count"] == 1
