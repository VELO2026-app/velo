# =============================================================================
# VELO Backend -- Tests: Curator Group page, member side (GT-2, 8.1 #4-5)
# =============================================================================
#
# telegram_id band: 66200-66399 (curator 66201, masters 66202-66205,
# students 66210-66219, stranger 66230, admin 66290). Declared module-level
# below as _TID_MIN/_TID_MAX, ONCE -- tests/telegram_id_bands.py parses that
# declaration out of the AST on every run, and a file that uses ids without
# declaring a band fails test_blind_zone_has_not_grown.
#
# The neighbouring band 66000-66199 belongs to test_curator_groups.py (GT-1,
# the curator-facing half). Same module, two files, two disjoint bands.
#
# ⚠ BACKEND-ONLY, UNPROVEN LOCALLY -- no Postgres in the authoring
# environment. Written to be read and to run on the server.
#
# CLEANUP is full_cleanup_range(..., delete_users=True) and nothing else:
# every curator-group table cascades from users / curator_group, so deleting
# the band's users takes groups, memberships and practices with them.
#
# Coverage:
#   Activity (I-6): all four reads 404 while the curator is suspended, and
#     come back on re-verification with the member rows byte-identical
#   relation: curator / master / student / none
#   mine: empty, both roles at once, ordering, inactive groups excluded
#   roster: curator first, suspended member vanishes, total == masters_count
#     + 1, pagination does not repeat the curator
#   feed: only the school's masters, blocked viewer, drafts, past practices
#   leave: idempotent, curator 409, works while the group is INACTIVE (I-5)
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters.groups_models import MasterStudent
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeStatus,
    PracticeType,
)
from app.modules.users.models import User, UserRole
from tests.helpers import (
    auth_headers,
    fresh_execute,
    full_cleanup_range,
    login_user,
)

CURATOR_GROUPS_URL = "/api/v1/masters/me/curator-groups"
MINE_URL = "/api/v1/curator-groups/mine"
PAGE_URL = "/api/v1/curator-groups/{group_id}"
MASTERS_URL = "/api/v1/curator-groups/{group_id}/masters"
PRACTICES_URL = "/api/v1/curator-groups/{group_id}/practices"
MEMBERSHIP_URL = "/api/v1/curator-groups/{group_id}/membership"
REVOKE_URL = "/api/v1/admin/masters/{user_id}/revoke"
MAKE_MASTER_URL = "/api/v1/admin/users/{user_id}/make-master"

_TID_MIN = 66200
_TID_MAX = 66399

_TID_CURATOR = 66201
_TID_MASTER_A = 66202
_TID_MASTER_B = 66203
_TID_MASTER_C = 66204
_TID_STUDENT_A = 66210
_TID_STUDENT_B = 66211
_TID_STRANGER = 66230
_TID_ADMIN = 66290


# ===========================================================================
# Local helpers -- copied, not imported, as every test file in this tree does
# ===========================================================================


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    first_name: str = "Master",
    *,
    display_name: str | None = None,
    methods: list[str] | None = None,
    experience_years: int | None = None,
) -> dict:
    """Create a verified master and return the auth dict.

    Commits: get_current_master and every read below run on the request's
    OWN session, and a flush alone is invisible across sessions under READ
    COMMITTED.
    """
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )
    user_id = auth["user"]["id"]

    user = await db_session.get(User, UUID(user_id))
    user.role = UserRole.MASTER
    await db_session.flush()

    profile_block: dict = {"bio": "m"}
    if display_name is not None:
        profile_block["display_name"] = display_name
    if methods is not None:
        profile_block["methods"] = methods
    if experience_years is not None:
        profile_block["experience_years"] = experience_years

    db_session.add(
        MasterProfile(
            user_id=UUID(user_id),
            data={"account": {"status": "verified"}, "profile": profile_block},
        )
    )
    await db_session.flush()
    await db_session.commit()
    return auth


async def _make_admin(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> str:
    """Create an admin and return their session token."""
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


async def _join(
    db_session: AsyncSession,
    group_id: str,
    user_id: str,
    kind: CuratorMemberKind,
    joined_at: datetime | None = None,
) -> None:
    """Seed a membership row directly.

    There is still no API path INTO a group in this delivery -- joining by
    invite link is GT-3. The row is a reachable state with a named writer,
    not an invented one.
    """
    row = CuratorGroupMember(
        group_id=UUID(group_id), user_id=UUID(user_id), kind=kind.value,
    )
    if joined_at is not None:
        row.joined_at = joined_at
    db_session.add(row)
    await db_session.flush()
    await db_session.commit()


async def _create_practice(
    db_session: AsyncSession,
    master_id: str,
    *,
    title: str = "Group Practice",
    status: str = PracticeStatus.SCHEDULED.value,
    hours_from_now: float = 48,
) -> Practice:
    practice = Practice(
        master_id=UUID(master_id),
        title=title,
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=status,
        scheduled_at=datetime.now(UTC) + timedelta(hours=hours_from_now),
        duration_minutes=60,
        timezone="UTC",
        max_participants=20,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        audience_kind=AudienceKind.PUBLIC.value,
    )
    db_session.add(practice)
    await db_session.flush()
    await db_session.commit()
    return practice


async def _block(
    db_session: AsyncSession, master_id: str, student_user_id: str,
) -> None:
    """The master blocks this viewer -- the real master_student row."""
    db_session.add(
        MasterStudent(
            master_id=UUID(master_id),
            student_user_id=UUID(student_user_id),
            blocked_at=datetime.now(UTC),
        )
    )
    await db_session.flush()
    await db_session.commit()


async def _revoke(client: AsyncClient, admin_token: str, user_id: str) -> None:
    """Suspend a master the way production does -- the admin endpoint."""
    resp = await client.post(
        REVOKE_URL.format(user_id=user_id), headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text


async def _re_verify(
    client: AsyncClient, admin_token: str, user_id: str,
) -> None:
    """Bring a suspended master back.

    make-master, NOT /masters/{id}/verify: verify_master() goes through
    _load_pending_profile(), which raises ConflictError unless the status is
    "pending" -- after a revoke it is "suspended", so /verify answers 409 and
    re-verifies nothing. revoke_master()'s own docstring names this path.
    """
    resp = await client.post(
        MAKE_MASTER_URL.format(user_id=user_id),
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text


def _four_reads(group_id: str) -> list[str]:
    return [
        PAGE_URL.format(group_id=group_id),
        MASTERS_URL.format(group_id=group_id),
        PRACTICES_URL.format(group_id=group_id),
        MINE_URL,
    ]


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
# relation -- who sees what
# ===========================================================================


@pytest.mark.asyncio
async def test_curator_sees_the_page_as_curator(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The owner reads their own group through the MEMBER endpoint too.

    AMENDED BY GT-4. This test used to assert `"transfer" not in body`, and
    that was RIGHT when it was written: through GT-3 the field genuinely did
    not exist, because curator_group_transfer had no writer and a hardcoded
    null would have been a promise with nothing behind it. GT-4 gave it a
    writer, so the field is now always present -- and null for a group with
    no pending offer, which is what this group is. The assertion is
    tightened rather than dropped: `is None` still fails if the field ever
    starts carrying something for a group nobody has offered anywhere.
    """
    curator = await _make_verified_master(
        client, db_session, _TID_CURATOR, display_name="Мастер VELO",
    )
    group = await _create_group(client, curator)

    resp = await client.get(
        PAGE_URL.format(group_id=group["id"]),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["viewer"]["relation"] == "curator"
    assert body["curator"]["user_id"] == curator["user"]["id"]
    assert body["curator"]["display_name"] == "Мастер VELO"
    assert body["transfer"] is None


@pytest.mark.asyncio
async def test_master_and_student_members_each_see_their_own_relation(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """One group, two members, two different relations on the same data."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER_A, first_name="Teacher",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    group = await _create_group(client, curator)
    await _join(
        db_session, group["id"], teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    await _join(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )

    url = PAGE_URL.format(group_id=group["id"])
    m = await client.get(url, headers=auth_headers(teacher["session_token"]))
    s = await client.get(url, headers=auth_headers(student["session_token"]))
    assert m.status_code == 200
    assert s.status_code == 200
    assert m.json()["viewer"]["relation"] == "master"
    assert s.json()["viewer"]["relation"] == "student"


@pytest.mark.asyncio
async def test_stranger_gets_404_on_all_four_reads(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """No relation -> the group does not exist, as far as you know.

    Paired with the member's own 200 on the same URLs, so "404" cannot come
    from a route that simply is not mounted.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    stranger = await login_user(client, telegram_id=_TID_STRANGER)
    group = await _create_group(client, curator)

    theirs = auth_headers(stranger["session_token"])
    for url in _four_reads(group["id"])[:3]:
        resp = await client.get(url, headers=theirs)
        assert resp.status_code == 404, url
    assert (await client.get(MINE_URL, headers=theirs)).json()["items"] == []

    mine = auth_headers(curator["session_token"])
    for url in _four_reads(group["id"])[:3]:
        assert (await client.get(url, headers=mine)).status_code == 200, url


@pytest.mark.asyncio
async def test_unknown_group_is_404_and_a_malformed_id_is_422(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """{id} is a UUID in the path, so a malformed one never reaches the
    service and 404 stays reserved for "not yours / not there"."""
    member = await login_user(client, telegram_id=_TID_STUDENT_A)
    headers = auth_headers(member["session_token"])

    missing = await client.get(PAGE_URL.format(group_id=uuid4()), headers=headers)
    assert missing.status_code == 404

    malformed = await client.get(
        PAGE_URL.format(group_id="not-a-uuid"), headers=headers,
    )
    assert malformed.status_code == 422


# ===========================================================================
# I-6 -- an inactive group is invisible, and comes back untouched
# ===========================================================================


@pytest.mark.asyncio
async def test_suspended_curator_hides_the_group_and_reverification_restores_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """I-6 end to end through the real admin endpoints.

    The whole point is that NOTHING is written to hide the group and nothing
    is written to bring it back: the member rows must be byte-identical
    before and after.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    group = await _create_group(client, curator)
    await _join(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )

    headers = auth_headers(student["session_token"])
    before_rows = (
        await fresh_execute(
            select(CuratorGroupMember.id, CuratorGroupMember.joined_at).where(
                CuratorGroupMember.group_id == UUID(group["id"])
            )
        )
    ).all()

    for url in _four_reads(group["id"])[:3]:
        assert (await client.get(url, headers=headers)).status_code == 200, url

    await _revoke(client, admin_token, curator["user"]["id"])

    for url in _four_reads(group["id"])[:3]:
        assert (await client.get(url, headers=headers)).status_code == 404, url
    assert (await client.get(MINE_URL, headers=headers)).json()["items"] == []

    await _re_verify(client, admin_token, curator["user"]["id"])

    for url in _four_reads(group["id"])[:3]:
        assert (await client.get(url, headers=headers)).status_code == 200, url
    assert len((await client.get(MINE_URL, headers=headers)).json()["items"]) == 1

    after_rows = (
        await fresh_execute(
            select(CuratorGroupMember.id, CuratorGroupMember.joined_at).where(
                CuratorGroupMember.group_id == UUID(group["id"])
            )
        )
    ).all()
    assert after_rows == before_rows


@pytest.mark.asyncio
async def test_the_curator_loses_their_own_group_while_suspended(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Inactive is a property of the GROUP, not a per-viewer rule.

    After a revoke the owner is a plain user again, so they reach the member
    endpoints -- and see nothing, exactly like everybody else.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    group = await _create_group(client, curator)
    headers = auth_headers(curator["session_token"])

    assert (await client.get(MINE_URL, headers=headers)).json()["items"] != []

    await _revoke(client, admin_token, curator["user"]["id"])

    assert (await client.get(MINE_URL, headers=headers)).json()["items"] == []
    page = await client.get(
        PAGE_URL.format(group_id=group["id"]), headers=headers,
    )
    assert page.status_code == 404


@pytest.mark.asyncio
async def test_deleted_group_is_404_like_any_other(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Deleted, inactive and never-existed are one answer."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    group = await _create_group(client, curator)
    await _join(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    headers = auth_headers(student["session_token"])
    assert (
        await client.get(
            PAGE_URL.format(group_id=group["id"]), headers=headers,
        )
    ).status_code == 200

    await client.delete(
        f"{CURATOR_GROUPS_URL}/{group['id']}",
        headers=auth_headers(curator["session_token"]),
    )

    assert (
        await client.get(
            PAGE_URL.format(group_id=group["id"]), headers=headers,
        )
    ).status_code == 404


# ===========================================================================
# mine
# ===========================================================================


@pytest.mark.asyncio
async def test_mine_is_empty_for_someone_in_no_groups(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    user = await login_user(client, telegram_id=_TID_STUDENT_A)
    resp = await client.get(
        MINE_URL, headers=auth_headers(user["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["items"] == []


@pytest.mark.asyncio
async def test_mine_lists_curated_first_then_joined(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A master who runs one school and teaches at another sees both, with
    their own first and the right relation on each."""
    me = await _make_verified_master(client, db_session, _TID_CURATOR)
    other = await _make_verified_master(
        client, db_session, _TID_MASTER_A, first_name="Other",
    )
    mine_group = await _create_group(client, me, name="Моя школа")
    their_group = await _create_group(client, other, name="Чужая школа")
    await _join(
        db_session, their_group["id"], me["user"]["id"],
        CuratorMemberKind.MASTER,
    )

    items = (
        await client.get(MINE_URL, headers=auth_headers(me["session_token"]))
    ).json()["items"]
    assert [i["name"] for i in items] == ["Моя школа", "Чужая школа"]
    assert [i["relation"] for i in items] == ["curator", "master"]
    assert items[0]["id"] == mine_group["id"]
    assert items[1]["curator"]["user_id"] == other["user"]["id"]


@pytest.mark.asyncio
async def test_mine_orders_joined_groups_by_most_recent_membership(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """joined_at DESC -- newest school first, mirroring the GT-1 roster."""
    older_curator = await _make_verified_master(client, db_session, _TID_MASTER_A)
    newer_curator = await _make_verified_master(
        client, db_session, _TID_MASTER_B, first_name="Newer",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    older = await _create_group(client, older_curator, name="Старая")
    newer = await _create_group(client, newer_curator, name="Новая")
    await _join(
        db_session, older["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
        joined_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    await _join(
        db_session, newer["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
        joined_at=datetime(2026, 6, 1, tzinfo=UTC),
    )

    items = (
        await client.get(
            MINE_URL, headers=auth_headers(student["session_token"]),
        )
    ).json()["items"]
    assert [i["name"] for i in items] == ["Новая", "Старая"]


# ===========================================================================
# Roster
# ===========================================================================


@pytest.mark.asyncio
async def test_roster_puts_the_curator_first_and_carries_public_fields(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The curator leads even with zero practices, and the row is a strict
    subset of the public master profile -- no financial or contact field."""
    curator = await _make_verified_master(
        client, db_session, _TID_CURATOR,
        display_name="Куратор", methods=["yoga"], experience_years=8,
    )
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER_A, first_name="Teacher",
    )
    group = await _create_group(client, curator)
    await _join(
        db_session, group["id"], teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    await _create_practice(db_session, teacher["user"]["id"])

    body = (
        await client.get(
            MASTERS_URL.format(group_id=group["id"]),
            headers=auth_headers(teacher["session_token"]),
        )
    ).json()
    assert body["total"] == 2
    first, second = body["items"]
    assert first["is_curator"] is True
    assert first["user_id"] == curator["user"]["id"]
    assert first["display_name"] == "Куратор"
    assert first["methods"] == ["yoga"]
    assert first["experience_years"] == 8
    assert first["practices_count"] == 0
    assert second["is_curator"] is False
    assert second["practices_count"] == 1
    for forbidden in ("frozen_cents", "available_cents", "email", "phone"):
        assert forbidden not in first


@pytest.mark.asyncio
async def test_suspended_master_leaves_the_roster_and_the_total(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """I-4 on the member side: hidden here, where GT-1 showed the curator an
    is_visible=false row. Same predicate, two audiences."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER_A, first_name="Teacher",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    group = await _create_group(client, curator)
    await _join(
        db_session, group["id"], teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    await _join(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    headers = auth_headers(student["session_token"])
    url = MASTERS_URL.format(group_id=group["id"])

    assert (await client.get(url, headers=headers)).json()["total"] == 2

    await _revoke(client, admin_token, teacher["user"]["id"])

    after = (await client.get(url, headers=headers)).json()
    assert after["total"] == 1
    assert [i["is_curator"] for i in after["items"]] == [True]

    rows = (
        await fresh_execute(
            select(CuratorGroupMember.user_id).where(
                CuratorGroupMember.group_id == UUID(group["id"])
            )
        )
    ).scalars().all()
    assert UUID(teacher["user"]["id"]) in rows


@pytest.mark.asyncio
async def test_roster_total_equals_masters_count_plus_the_curator(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Two counts of one visibility rule must agree -- they would drift in
    silence, which is why this is asserted rather than assumed.

    Checked twice: with a visible master, and again after suspending them.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER_A, first_name="Teacher",
    )
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    group = await _create_group(client, curator)
    await _join(
        db_session, group["id"], teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    headers = auth_headers(curator["session_token"])

    async def _pair() -> tuple[int, int]:
        page = (
            await client.get(
                PAGE_URL.format(group_id=group["id"]), headers=headers,
            )
        ).json()
        roster = (
            await client.get(
                MASTERS_URL.format(group_id=group["id"]), headers=headers,
            )
        ).json()
        return page["masters_count"], roster["total"]

    masters_count, total = await _pair()
    assert (masters_count, total) == (1, 2)

    await _revoke(client, admin_token, teacher["user"]["id"])
    masters_count, total = await _pair()
    assert (masters_count, total) == (0, 1)


@pytest.mark.asyncio
async def test_pagination_never_repeats_the_curator(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The curator is index 0 of a virtual list, not an extra row glued to
    every page. limit=1 gives only them; offset=1 starts at the first real
    member and must not include them again."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    first = await _make_verified_master(
        client, db_session, _TID_MASTER_A, first_name="First",
    )
    second = await _make_verified_master(
        client, db_session, _TID_MASTER_B, first_name="Second",
    )
    group = await _create_group(client, curator)
    await _join(
        db_session, group["id"], first["user"]["id"], CuratorMemberKind.MASTER,
        joined_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    await _join(
        db_session, group["id"], second["user"]["id"], CuratorMemberKind.MASTER,
        joined_at=datetime(2026, 6, 1, tzinfo=UTC),
    )
    headers = auth_headers(curator["session_token"])
    url = MASTERS_URL.format(group_id=group["id"])

    page1 = (await client.get(f"{url}?limit=1&offset=0", headers=headers)).json()
    assert page1["total"] == 3
    assert [i["user_id"] for i in page1["items"]] == [curator["user"]["id"]]

    page2 = (await client.get(f"{url}?limit=1&offset=1", headers=headers)).json()
    assert [i["user_id"] for i in page2["items"]] == [second["user"]["id"]]

    page3 = (await client.get(f"{url}?limit=1&offset=2", headers=headers)).json()
    assert [i["user_id"] for i in page3["items"]] == [first["user"]["id"]]

    seen = [
        i["user_id"] for p in (page1, page2, page3) for i in p["items"]
    ]
    assert len(seen) == len(set(seen)) == 3


@pytest.mark.asyncio
async def test_roster_offset_past_total_is_an_empty_page(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group = await _create_group(client, curator)
    body = (
        await client.get(
            f"{MASTERS_URL.format(group_id=group['id'])}?offset=50",
            headers=auth_headers(curator["session_token"]),
        )
    ).json()
    assert body["items"] == []
    assert body["total"] == 1


@pytest.mark.asyncio
async def test_roster_practices_count_matches_the_public_master_profile(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The pair that keeps the imported constant honest: the roster and
    GET /masters/{id} count the same practices, drafts excluded."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER_A, first_name="Teacher",
    )
    group = await _create_group(client, curator)
    await _join(
        db_session, group["id"], teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    await _create_practice(db_session, teacher["user"]["id"], title="Live")
    await _create_practice(
        db_session, teacher["user"]["id"], title="Draft",
        status=PracticeStatus.DRAFT.value,
    )
    headers = auth_headers(curator["session_token"])

    roster = (
        await client.get(
            MASTERS_URL.format(group_id=group["id"]), headers=headers,
        )
    ).json()
    from_roster = next(
        i["practices_count"] for i in roster["items"] if not i["is_curator"]
    )
    public = await client.get(
        f"/api/v1/masters/{teacher['user']['id']}", headers=headers,
    )
    assert public.status_code == 200
    assert from_roster == public.json()["practices_count"] == 1


# ===========================================================================
# Practice feed
# ===========================================================================


@pytest.mark.asyncio
async def test_feed_shows_the_schools_masters_and_nobody_else(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Curator's and members' practices in; an outsider's practice out, even
    though it is a perfectly public practice."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER_A, first_name="Teacher",
    )
    outsider = await _make_verified_master(
        client, db_session, _TID_MASTER_C, first_name="Outsider",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    group = await _create_group(client, curator)
    await _join(
        db_session, group["id"], teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    await _join(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    await _create_practice(db_session, curator["user"]["id"], title="By curator")
    await _create_practice(db_session, teacher["user"]["id"], title="By teacher")
    await _create_practice(db_session, outsider["user"]["id"], title="Outside")

    body = (
        await client.get(
            PRACTICES_URL.format(group_id=group["id"]),
            headers=auth_headers(student["session_token"]),
        )
    ).json()
    titles = sorted(i["title"] for i in body["items"])
    assert titles == ["By curator", "By teacher"]
    assert body["total"] == 2


@pytest.mark.asyncio
async def test_feed_hides_drafts_and_past_practices(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The feed's own status/time gate applies unchanged -- including to the
    author, who sees neither their draft nor their finished practice here."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group = await _create_group(client, curator)
    await _create_practice(db_session, curator["user"]["id"], title="Upcoming")
    await _create_practice(
        db_session, curator["user"]["id"], title="Draft",
        status=PracticeStatus.DRAFT.value,
    )
    await _create_practice(
        db_session, curator["user"]["id"], title="Past", hours_from_now=-48,
    )

    body = (
        await client.get(
            PRACTICES_URL.format(group_id=group["id"]),
            headers=auth_headers(curator["session_token"]),
        )
    ).json()
    assert [i["title"] for i in body["items"]] == ["Upcoming"]


@pytest.mark.asyncio
async def test_a_master_who_blocked_the_viewer_gives_no_practices(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Blocking hides PRACTICES, not people.

    The blocked viewer still sees the group and still sees the blocker in
    the roster -- what disappears is that master's practices, and only for
    them. The pair proves it is per-viewer: a second student, not blocked,
    still sees the same practice.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER_A, first_name="Teacher",
    )
    blocked = await login_user(client, telegram_id=_TID_STUDENT_A)
    other = await login_user(client, telegram_id=_TID_STUDENT_B)
    group = await _create_group(client, curator)
    await _join(
        db_session, group["id"], teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    for who in (blocked, other):
        await _join(
            db_session, group["id"], who["user"]["id"],
            CuratorMemberKind.STUDENT,
        )
    await _create_practice(db_session, teacher["user"]["id"], title="By teacher")
    await _block(db_session, teacher["user"]["id"], blocked["user"]["id"])

    url = PRACTICES_URL.format(group_id=group["id"])
    blocked_body = (
        await client.get(url, headers=auth_headers(blocked["session_token"]))
    ).json()
    other_body = (
        await client.get(url, headers=auth_headers(other["session_token"]))
    ).json()
    assert blocked_body["items"] == []
    assert [i["title"] for i in other_body["items"]] == ["By teacher"]

    roster = (
        await client.get(
            MASTERS_URL.format(group_id=group["id"]),
            headers=auth_headers(blocked["session_token"]),
        )
    ).json()
    assert teacher["user"]["id"] in [i["user_id"] for i in roster["items"]]


@pytest.mark.asyncio
async def test_group_with_no_visible_masters_yields_an_empty_feed(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The empty-set case: an empty master_ids list must mean "nobody", not
    "everybody". A public practice by an outsider proves the difference --
    with the wrong branch it would appear here."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER_A, first_name="Teacher",
    )
    outsider = await _make_verified_master(
        client, db_session, _TID_MASTER_C, first_name="Outsider",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    group = await _create_group(client, curator)
    await _join(
        db_session, group["id"], teacher["user"]["id"], CuratorMemberKind.MASTER,
    )
    await _join(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    await _create_practice(db_session, teacher["user"]["id"], title="By teacher")
    await _create_practice(db_session, outsider["user"]["id"], title="Outside")

    await _revoke(client, admin_token, teacher["user"]["id"])

    body = (
        await client.get(
            PRACTICES_URL.format(group_id=group["id"]),
            headers=auth_headers(student["session_token"]),
        )
    ).json()
    assert body["items"] == []
    assert body["total"] == 0


@pytest.mark.asyncio
async def test_group_without_practices_is_an_empty_page_not_a_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group = await _create_group(client, curator)
    resp = await client.get(
        PRACTICES_URL.format(group_id=group["id"]),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["total"] == 0


# ===========================================================================
# Leaving
# ===========================================================================


@pytest.mark.asyncio
async def test_leaving_removes_the_row_and_repeats_are_still_204(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The first 204 is checked against the group actually disappearing, so
    "204" can never stand in for "did nothing"."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    group = await _create_group(client, curator)
    await _join(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )
    headers = auth_headers(student["session_token"])
    url = MEMBERSHIP_URL.format(group_id=group["id"])

    first = await client.delete(url, headers=headers)
    assert first.status_code == 204
    assert (await client.get(MINE_URL, headers=headers)).json()["items"] == []
    assert (
        await client.get(
            PAGE_URL.format(group_id=group["id"]), headers=headers,
        )
    ).status_code == 404

    page = (
        await client.get(
            PAGE_URL.format(group_id=group["id"]),
            headers=auth_headers(curator["session_token"]),
        )
    ).json()
    assert page["students_count"] == 0

    second = await client.delete(url, headers=headers)
    assert second.status_code == 204


@pytest.mark.asyncio
async def test_leaving_a_group_you_never_joined_is_204(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """No row to delete is success, not a 404 -- and a 404 would reveal
    which group ids exist to anyone willing to try them."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    stranger = await login_user(client, telegram_id=_TID_STRANGER)
    group = await _create_group(client, curator)

    resp = await client.delete(
        MEMBERSHIP_URL.format(group_id=group["id"]),
        headers=auth_headers(stranger["session_token"]),
    )
    assert resp.status_code == 204

    unknown = await client.delete(
        MEMBERSHIP_URL.format(group_id=uuid4()),
        headers=auth_headers(stranger["session_token"]),
    )
    assert unknown.status_code == 204


@pytest.mark.asyncio
async def test_the_curator_cannot_leave_their_own_group(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """409 with the machine code, and the group is untouched afterwards."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    group = await _create_group(client, curator)

    resp = await client.delete(
        MEMBERSHIP_URL.format(group_id=group["id"]),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 409
    assert resp.json()["error"] == "curator_cannot_leave"

    still = (
        await fresh_execute(
            select(CuratorGroup).where(CuratorGroup.id == UUID(group["id"]))
        )
    ).scalar_one_or_none()
    assert still is not None


@pytest.mark.asyncio
async def test_a_member_can_leave_a_group_that_is_inactive(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """I-5: leaving is unconditional, so it must not be gated on the group
    being active.

    Routing the exit through the 404 resolver would trap a member inside a
    school they cannot see and cannot leave until an admin re-verifies
    somebody else. The proof is the round trip: leave while hidden, restore
    the curator, and the group comes back WITHOUT the person who left.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    stayer = await login_user(client, telegram_id=_TID_STUDENT_B)
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)
    group = await _create_group(client, curator)
    for who in (student, stayer):
        await _join(
            db_session, group["id"], who["user"]["id"],
            CuratorMemberKind.STUDENT,
        )

    await _revoke(client, admin_token, curator["user"]["id"])

    headers = auth_headers(student["session_token"])
    assert (
        await client.get(
            PAGE_URL.format(group_id=group["id"]), headers=headers,
        )
    ).status_code == 404
    left = await client.delete(
        MEMBERSHIP_URL.format(group_id=group["id"]), headers=headers,
    )
    assert left.status_code == 204

    await _re_verify(client, admin_token, curator["user"]["id"])

    assert (
        await client.get(
            PAGE_URL.format(group_id=group["id"]), headers=headers,
        )
    ).status_code == 404
    assert (
        await client.get(
            PAGE_URL.format(group_id=group["id"]),
            headers=auth_headers(stayer["session_token"]),
        )
    ).status_code == 200

    page = (
        await client.get(
            PAGE_URL.format(group_id=group["id"]),
            headers=auth_headers(curator["session_token"]),
        )
    ).json()
    assert page["students_count"] == 1
