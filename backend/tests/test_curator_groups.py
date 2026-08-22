# =============================================================================
# VELO Backend -- Tests: Curator Groups (P1, tz-curator-groups.md 8.1 #1-3)
# =============================================================================
#
# telegram_id band: 66000-66199 (curator 66001, second master 66002,
# students 66010-66019, admin 66190). Declared module-level below as
# _TID_MIN/_TID_MAX, ONCE -- tests/telegram_id_bands.py reads that
# declaration out of the AST on every run, and a file that uses ids without
# declaring a band fails test_blind_zone_has_not_grown.
#
# ⚠ BACKEND-ONLY, UNPROVEN LOCALLY -- no Postgres in the authoring
# environment. Written to be read and to run on the server; never executed
# via pytest this session. See the delivery report for what WAS checked.
#
# CLEANUP is full_cleanup_range(..., delete_users=True) and NOTHING ELSE.
# All four new tables FK into users / curator_group with ON DELETE CASCADE,
# so deleting the band's users takes their curator groups, memberships,
# invites and transfers with them -- exactly the arrangement chat_threads
# already relies on (test_master_groups.py's own cleanup comment). Plain
# cleanup_range would NOT do: it keeps the users, curator_group rows would
# survive the run, and the second run would hit 409 on the same group name.
#
# Coverage:
#   CRUD: list (incl. empty), create (+ dup 409, other curator's name 201,
#     blank/whitespace/over-long name 422, description ""->NULL / absent),
#     patch (same name no-op, other own name 409, partial description),
#     delete (204, second 404, cascade of members)
#   Ownership: another curator's group -> 404 on patch/delete/members/remove
#   Members: roster kinds, is_visible via real /revoke + re-verify, counters,
#     kind filter (+ 422 on an unknown kind), search, pagination, remove
#     (idempotent, curator's own id, unknown user)
#   Schema: UNIQUE (group_id, user_id) and UNIQUE (group_id) on transfer
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.curator_groups.models import (
    CuratorGroup,
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

GROUPS_URL = "/api/v1/masters/me/curator-groups"
GROUP_URL = "/api/v1/masters/me/curator-groups/{group_id}"
MEMBERS_URL = "/api/v1/masters/me/curator-groups/{group_id}/members"
MEMBER_URL = "/api/v1/masters/me/curator-groups/{group_id}/members/{user_id}"
REVOKE_URL = "/api/v1/admin/masters/{user_id}/revoke"
MAKE_MASTER_URL = "/api/v1/admin/users/{user_id}/make-master"

_TID_MIN = 66000
_TID_MAX = 66199

_TID_CURATOR = 66001
_TID_MASTER2 = 66002
_TID_MASTER3 = 66003
_TID_STUDENT_A = 66010
_TID_STUDENT_B = 66011
_TID_ADMIN = 66190


# ===========================================================================
# Local helpers -- copied, not imported (the convention in every test file:
# _make_verified_master exists locally in 10+ of them). No default
# telegram_id on either, mirroring test_master_students.py -- a default here
# would also have to live inside 66000-66199 or
# test_no_default_id_sits_outside_its_own_band would flag it.
# ===========================================================================


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    first_name: str = "Master",
) -> dict:
    """Create a verified master and return the auth dict."""
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )
    user_id = auth["user"]["id"]

    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    await db_session.flush()

    profile = MasterProfile(
        user_id=user_id,
        data={"account": {"status": "verified"}, "profile": {"bio": "m"}},
    )
    db_session.add(profile)
    await db_session.flush()
    await db_session.commit()
    return auth


async def _make_admin(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
) -> tuple[dict, str]:
    """Create a user and upgrade to admin role. Returns (auth_data, token)."""
    auth = await login_user(client, telegram_id=telegram_id, first_name="Admin")
    await db_session.execute(
        update(User)
        .where(User.id == UUID(auth["user"]["id"]))
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    return auth, auth["session_token"]


async def _create_group(
    client: AsyncClient, auth: dict, name: str = "Школа дыхания", **extra,
) -> dict:
    """POST a group and return its response body."""
    body = {"name": name, **extra}
    resp = await client.post(
        GROUPS_URL, json=body, headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _add_member(
    db_session: AsyncSession,
    group_id: str,
    user_id: str,
    kind: CuratorMemberKind,
    joined_at: datetime | None = None,
) -> None:
    """Seed a membership row directly.

    There is NO API path into a curator group in this delivery -- joining is
    by invite link and arrives in GT-3. The row is still a REACHABLE state
    (its writer is named), so seeding it here is not building an imaginary
    world; it is standing in for a writer that exists on paper and lands
    next.
    """
    row = CuratorGroupMember(
        group_id=UUID(group_id),
        user_id=UUID(user_id),
        kind=kind.value,
    )
    if joined_at is not None:
        row.joined_at = joined_at
    db_session.add(row)
    await db_session.flush()
    await db_session.commit()


async def _revoke(client: AsyncClient, admin_token: str, user_id: str) -> None:
    """Suspend a master the way production does it -- the admin endpoint.

    NOT a hand-edit of data.account.status: a JSONB poke would produce a
    state that only the test knows how to make, and would silently stop
    resembling the real one the day revoke_master changes.
    """
    resp = await client.post(
        REVOKE_URL.format(user_id=user_id), headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text


async def _re_verify(
    client: AsyncClient, admin_token: str, user_id: str,
) -> None:
    """Bring a suspended master back.

    THIS IS make-master, NOT /masters/{id}/verify. Read from the bodies:
    verify_master() goes through _load_pending_profile(), which raises
    ConflictError unless status == "pending" -- after a revoke the status is
    "suspended", so /verify answers 409 "Application is not pending" and
    never re-verifies anything. revoke_master()'s own docstring names the
    real path: "re-grant via the existing make_master re-verify branch".
    make_master() re-verifies a non-verified profile in place AND restores
    role=master, which revoke had dropped to user.
    """
    resp = await client.post(
        MAKE_MASTER_URL.format(user_id=user_id),
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text


# ===========================================================================
# Cleanup
# ===========================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(
        db_session, _TID_MIN, _TID_MAX, delete_users=True,
    )
    await db_session.commit()
    yield
    await full_cleanup_range(
        db_session, _TID_MIN, _TID_MAX, delete_users=True,
    )
    await db_session.commit()


# ===========================================================================
# Access -- who may touch these endpoints at all
# ===========================================================================


@pytest.mark.asyncio
async def test_plain_user_gets_403_on_every_curator_endpoint(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A user with no master capability is refused by get_current_master.

    Paired with its positive twin below (a verified master gets 200 on the
    same URL) so that "403 here" cannot be produced by the route simply not
    existing.
    """
    plain = await login_user(client, telegram_id=_TID_STUDENT_A)
    resp = await client.get(
        GROUPS_URL, headers=auth_headers(plain["session_token"]),
    )
    assert resp.status_code == 403

    master = await _make_verified_master(client, db_session, _TID_CURATOR)
    ok = await client.get(
        GROUPS_URL, headers=auth_headers(master["session_token"]),
    )
    assert ok.status_code == 200


@pytest.mark.asyncio
async def test_suspended_curator_is_refused_on_all_six_endpoints(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """After /revoke the curator is refused everywhere -- and the code is
    the ROLE one, not master_profile_not_verified.

    revoke_master() does two things, not one: it flips
    data.account.status to "suspended" AND drops User.role from master to
    user. get_current_master checks the role FIRST, so the request never
    reaches the profile-status branch and comes back with the generic
    "forbidden". Asserting master_profile_not_verified here would be
    asserting a code this path cannot produce.
    """
    master = await _make_verified_master(client, db_session, _TID_CURATOR)
    group = await _create_group(client, master)
    _admin, admin_token = await _make_admin(client, db_session, _TID_ADMIN)

    await _revoke(client, admin_token, master["user"]["id"])

    headers = auth_headers(master["session_token"])
    gid = group["id"]
    calls = [
        await client.get(GROUPS_URL, headers=headers),
        await client.post(GROUPS_URL, json={"name": "Вторая"}, headers=headers),
        await client.patch(
            GROUP_URL.format(group_id=gid), json={"name": "Иная"},
            headers=headers,
        ),
        await client.delete(GROUP_URL.format(group_id=gid), headers=headers),
        await client.get(MEMBERS_URL.format(group_id=gid), headers=headers),
        await client.delete(
            MEMBER_URL.format(group_id=gid, user_id=uuid4()), headers=headers,
        ),
    ]
    assert [r.status_code for r in calls] == [403] * 6
    assert all(r.json()["error"] == "forbidden" for r in calls)


# ===========================================================================
# Create -- POVTOR / PUSTOTA / NEHVATKA
# ===========================================================================


@pytest.mark.asyncio
async def test_create_group_makes_the_master_a_curator(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """No grant, no flag: creating the group IS becoming its curator (I-1)."""
    master = await _make_verified_master(client, db_session, _TID_CURATOR)
    body = await _create_group(client, master, name="Школа дыхания")

    assert body["name"] == "Школа дыхания"
    assert body["description"] is None
    assert body["masters_count"] == 0
    assert body["students_count"] == 0
    assert body["created_at"]

    row = (
        await fresh_execute(
            select(CuratorGroup).where(CuratorGroup.id == UUID(body["id"]))
        )
    ).scalar_one()
    assert str(row.curator_user_id) == master["user"]["id"]


@pytest.mark.asyncio
async def test_create_duplicate_name_same_curator_conflicts(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """POVTOR: the same name twice under one curator -> 409 with the code."""
    master = await _make_verified_master(client, db_session, _TID_CURATOR)
    await _create_group(client, master, name="Школа")

    resp = await client.post(
        GROUPS_URL,
        json={"name": "Школа"},
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 409
    assert resp.json()["error"] == "curator_group_name_taken"


@pytest.mark.asyncio
async def test_same_name_under_another_curator_is_allowed(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Uniqueness is per curator, not global (I-7).

    The pair for the 409 above: it proves the conflict comes from the
    (curator, name) pair and not from the name alone.
    """
    first = await _make_verified_master(client, db_session, _TID_CURATOR)
    second = await _make_verified_master(
        client, db_session, _TID_MASTER2, first_name="Other",
    )
    await _create_group(client, first, name="Школа")
    body = await _create_group(client, second, name="Школа")
    assert body["name"] == "Школа"


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["", " ", "   ", "\t"])
async def test_blank_or_whitespace_name_is_422(
    client: AsyncClient,
    db_session: AsyncSession,
    name: str,
) -> None:
    """PUSTOTA: TZ 5.5 wants 422 for a blank name, and whitespace counts.

    This is why CuratorGroupNameStr sets strip_whitespace=True while the
    older GroupNameStr does not: without stripping, " " has length 1 and
    would pass min_length, creating a group whose name is a space.
    """
    master = await _make_verified_master(client, db_session, _TID_CURATOR)
    resp = await client.post(
        GROUPS_URL,
        json={"name": name},
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_name_is_stored_stripped(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The pair for the 422 above: stripping does not merely reject, it
    normalizes -- so "Школа" and " Школа " cannot become two groups."""
    master = await _make_verified_master(client, db_session, _TID_CURATOR)
    body = await _create_group(client, master, name="  Школа  ")
    assert body["name"] == "Школа"

    resp = await client.post(
        GROUPS_URL,
        json={"name": "Школа"},
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_over_long_name_and_description_are_422(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """NEHVATKA on the other side: past the caps, 422 from the schema."""
    master = await _make_verified_master(client, db_session, _TID_CURATOR)
    headers = auth_headers(master["session_token"])

    long_name = await client.post(
        GROUPS_URL, json={"name": "я" * 101}, headers=headers,
    )
    assert long_name.status_code == 422

    long_desc = await client.post(
        GROUPS_URL,
        json={"name": "Школа", "description": "д" * 501},
        headers=headers,
    )
    assert long_desc.status_code == 422


@pytest.mark.asyncio
async def test_blank_description_becomes_null_and_absent_stays_null(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """PUSTOTA: "" and whitespace normalize to NULL, never stored as ""."""
    master = await _make_verified_master(client, db_session, _TID_CURATOR)

    blank = await _create_group(client, master, name="A", description="   ")
    absent = await _create_group(client, master, name="B")
    filled = await _create_group(client, master, name="C", description=" тут ")

    assert blank["description"] is None
    assert absent["description"] is None
    assert filled["description"] == "тут"

    rows = (
        await fresh_execute(
            select(CuratorGroup.name, CuratorGroup.description).where(
                CuratorGroup.curator_user_id == UUID(master["user"]["id"])
            )
        )
    ).all()
    assert dict(rows) == {"A": None, "B": None, "C": "тут"}


# ===========================================================================
# List
# ===========================================================================


@pytest.mark.asyncio
async def test_list_is_empty_for_a_master_who_curates_nothing(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A verified master with no groups gets [], not a 404: there is no
    "not a curator" state to report (I-1)."""
    master = await _make_verified_master(client, db_session, _TID_CURATOR)
    resp = await client.get(
        GROUPS_URL, headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["items"] == []


@pytest.mark.asyncio
async def test_list_shows_only_my_groups_with_counts(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Counters are per group and computed in one pass; another curator's
    group never appears."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    other = await _make_verified_master(
        client, db_session, _TID_MASTER2, first_name="Other",
    )
    member_master = await _make_verified_master(
        client, db_session, _TID_MASTER3, first_name="Teacher",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_A)

    mine = await _create_group(client, curator, name="Моя")
    await _create_group(client, curator, name="Пустая")
    await _create_group(client, other, name="Чужая")

    await _add_member(
        db_session, mine["id"], member_master["user"]["id"],
        CuratorMemberKind.MASTER,
    )
    await _add_member(
        db_session, mine["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )

    resp = await client.get(
        GROUPS_URL, headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200
    items = {i["name"]: i for i in resp.json()["items"]}
    assert set(items) == {"Моя", "Пустая"}
    assert items["Моя"]["masters_count"] == 1
    assert items["Моя"]["students_count"] == 1
    assert items["Пустая"]["masters_count"] == 0
    assert items["Пустая"]["students_count"] == 0


# ===========================================================================
# Patch
# ===========================================================================


@pytest.mark.asyncio
async def test_patch_to_its_own_current_name_is_a_no_op_200(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """POVTOR: a group's own name is not a competitor to itself."""
    master = await _make_verified_master(client, db_session, _TID_CURATOR)
    group = await _create_group(client, master, name="Школа")

    resp = await client.patch(
        GROUP_URL.format(group_id=group["id"]),
        json={"name": "Школа"},
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "Школа"


@pytest.mark.asyncio
async def test_patch_to_another_of_my_groups_names_conflicts(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """POVTOR: renaming onto a sibling's name -> 409."""
    master = await _make_verified_master(client, db_session, _TID_CURATOR)
    first = await _create_group(client, master, name="Первая")
    await _create_group(client, master, name="Вторая")

    resp = await client.patch(
        GROUP_URL.format(group_id=first["id"]),
        json={"name": "Вторая"},
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 409
    assert resp.json()["error"] == "curator_group_name_taken"


@pytest.mark.asyncio
async def test_patch_without_description_leaves_the_column_untouched(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """PUSTOTA, both directions: an absent key preserves, an explicit empty
    one clears. This is the whole reason description_provided exists."""
    master = await _make_verified_master(client, db_session, _TID_CURATOR)
    group = await _create_group(
        client, master, name="Школа", description="Про дыхание",
    )
    headers = auth_headers(master["session_token"])
    url = GROUP_URL.format(group_id=group["id"])

    renamed = await client.patch(url, json={"name": "Школа-2"}, headers=headers)
    assert renamed.status_code == 200
    assert renamed.json()["description"] == "Про дыхание"

    cleared = await client.patch(
        url, json={"name": "Школа-2", "description": "  "}, headers=headers,
    )
    assert cleared.status_code == 200
    assert cleared.json()["description"] is None

    row = (
        await fresh_execute(
            select(CuratorGroup.description).where(
                CuratorGroup.id == UUID(group["id"])
            )
        )
    ).scalar_one()
    assert row is None


@pytest.mark.asyncio
async def test_patch_reports_live_counters(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The patch reply carries the same counters the list does -- it is not
    a create-shaped reply full of zeros."""
    master = await _make_verified_master(client, db_session, _TID_CURATOR)
    group = await _create_group(client, master, name="Школа")
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    await _add_member(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )

    resp = await client.patch(
        GROUP_URL.format(group_id=group["id"]),
        json={"name": "Школа+"},
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["students_count"] == 1


# ===========================================================================
# Delete
# ===========================================================================


@pytest.mark.asyncio
async def test_delete_cascades_members_and_second_delete_is_404(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """POVTOR: the second DELETE is a 404, and the memberships are gone."""
    master = await _make_verified_master(client, db_session, _TID_CURATOR)
    group = await _create_group(client, master, name="Школа")
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    await _add_member(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )

    headers = auth_headers(master["session_token"])
    url = GROUP_URL.format(group_id=group["id"])

    first = await client.delete(url, headers=headers)
    assert first.status_code == 204

    left = (
        await fresh_execute(
            select(CuratorGroupMember).where(
                CuratorGroupMember.group_id == UUID(group["id"])
            )
        )
    ).scalars().all()
    assert left == []

    second = await client.delete(url, headers=headers)
    assert second.status_code == 404


@pytest.mark.asyncio
async def test_delete_of_an_empty_group_is_204(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """PUSTOTA: nothing to cascade is not a special case."""
    master = await _make_verified_master(client, db_session, _TID_CURATOR)
    group = await _create_group(client, master, name="Пустая")
    resp = await client.delete(
        GROUP_URL.format(group_id=group["id"]),
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_delete_is_never_blocked_by_anything(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """I-11: unlike master_group's delete_group, no 409 guard exists here.

    Deliberately asserted on a POPULATED group -- the shape that would trip
    a guard if one were ever copied over from the student-groups module.
    """
    master = await _make_verified_master(client, db_session, _TID_CURATOR)
    other = await _make_verified_master(
        client, db_session, _TID_MASTER2, first_name="Teacher",
    )
    group = await _create_group(client, master, name="Школа")
    await _add_member(
        db_session, group["id"], other["user"]["id"], CuratorMemberKind.MASTER,
    )

    resp = await client.delete(
        GROUP_URL.format(group_id=group["id"]),
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 204


# ===========================================================================
# Ownership -- NEHVATKA on every {id} route
# ===========================================================================


@pytest.mark.asyncio
async def test_another_curators_group_is_404_on_every_id_route(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Someone else's group and a group that never existed answer alike.

    Paired with the owner's own 200 on the same URL, so "404" cannot be
    coming from a mis-declared route.
    """
    owner = await _make_verified_master(client, db_session, _TID_CURATOR)
    stranger = await _make_verified_master(
        client, db_session, _TID_MASTER2, first_name="Stranger",
    )
    group = await _create_group(client, owner, name="Школа")
    gid = group["id"]

    theirs = auth_headers(stranger["session_token"])
    assert (
        await client.patch(
            GROUP_URL.format(group_id=gid), json={"name": "Моё"},
            headers=theirs,
        )
    ).status_code == 404
    assert (
        await client.get(MEMBERS_URL.format(group_id=gid), headers=theirs)
    ).status_code == 404
    assert (
        await client.delete(
            MEMBER_URL.format(group_id=gid, user_id=uuid4()), headers=theirs,
        )
    ).status_code == 404
    assert (
        await client.delete(GROUP_URL.format(group_id=gid), headers=theirs)
    ).status_code == 404

    mine = auth_headers(owner["session_token"])
    assert (
        await client.get(MEMBERS_URL.format(group_id=gid), headers=mine)
    ).status_code == 200


@pytest.mark.asyncio
async def test_unknown_group_id_is_404_and_a_malformed_one_is_422(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """{id} is a UUID in the path, so a malformed id never reaches the
    service -- FastAPI answers 422 and the 404 stays reserved for "not
    yours / not there"."""
    master = await _make_verified_master(client, db_session, _TID_CURATOR)
    headers = auth_headers(master["session_token"])

    missing = await client.get(
        MEMBERS_URL.format(group_id=uuid4()), headers=headers,
    )
    assert missing.status_code == 404

    malformed = await client.get(
        MEMBERS_URL.format(group_id="not-a-uuid"), headers=headers,
    )
    assert malformed.status_code == 422


@pytest.mark.asyncio
async def test_patch_after_delete_is_404(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A deleted group is indistinguishable from someone else's."""
    master = await _make_verified_master(client, db_session, _TID_CURATOR)
    group = await _create_group(client, master, name="Школа")
    headers = auth_headers(master["session_token"])

    await client.delete(GROUP_URL.format(group_id=group["id"]), headers=headers)
    resp = await client.patch(
        GROUP_URL.format(group_id=group["id"]),
        json={"name": "Снова"},
        headers=headers,
    )
    assert resp.status_code == 404


# ===========================================================================
# Members -- roster, visibility, filters
# ===========================================================================


@pytest.mark.asyncio
async def test_empty_roster_reports_zero_total(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """PUSTOTA: no rows is total=0, not a 404."""
    master = await _make_verified_master(client, db_session, _TID_CURATOR)
    group = await _create_group(client, master, name="Школа")
    resp = await client.get(
        MEMBERS_URL.format(group_id=group["id"]),
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json() == {"items": [], "total": 0, "limit": 20, "offset": 0}


@pytest.mark.asyncio
async def test_verified_master_member_is_visible_and_counted(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A master member with a live verified profile: shown, and inside
    masters_count."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER2, first_name="Teacher",
    )
    group = await _create_group(client, curator, name="Школа")
    await _add_member(
        db_session, group["id"], teacher["user"]["id"],
        CuratorMemberKind.MASTER,
    )

    headers = auth_headers(curator["session_token"])
    roster = await client.get(
        MEMBERS_URL.format(group_id=group["id"]), headers=headers,
    )
    assert roster.status_code == 200
    item = roster.json()["items"][0]
    assert item["kind"] == "master"
    assert item["is_visible"] is True

    listing = await client.get(GROUPS_URL, headers=headers)
    assert listing.json()["items"][0]["masters_count"] == 1


@pytest.mark.asyncio
async def test_student_member_with_a_verified_profile_is_still_a_student(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A verified master who joined as a student stays a student.

    kind is the relation, not a guess from the person's capabilities: they
    are visible (visibility is a rule about MASTER rows) and they do NOT
    count towards masters_count.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER2, first_name="Teacher",
    )
    group = await _create_group(client, curator, name="Школа")
    await _add_member(
        db_session, group["id"], teacher["user"]["id"],
        CuratorMemberKind.STUDENT,
    )

    headers = auth_headers(curator["session_token"])
    item = (
        await client.get(
            MEMBERS_URL.format(group_id=group["id"]), headers=headers,
        )
    ).json()["items"][0]
    assert item["kind"] == "student"
    assert item["is_visible"] is True

    counts = (await client.get(GROUPS_URL, headers=headers)).json()["items"][0]
    assert counts["masters_count"] == 0
    assert counts["students_count"] == 1


@pytest.mark.asyncio
async def test_suspended_master_hides_and_returns_without_touching_rows(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """I-4 end to end, through the real admin endpoints.

    Suspension is not a membership change: the row's id and joined_at are
    the SAME before, during and after, which is what makes re-verification
    automatic rather than a repair.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER2, first_name="Teacher",
    )
    _admin, admin_token = await _make_admin(client, db_session, _TID_ADMIN)

    group = await _create_group(client, curator, name="Школа")
    await _add_member(
        db_session, group["id"], teacher["user"]["id"],
        CuratorMemberKind.MASTER,
    )

    headers = auth_headers(curator["session_token"])
    members_url = MEMBERS_URL.format(group_id=group["id"])

    before = (
        await fresh_execute(
            select(CuratorGroupMember.id, CuratorGroupMember.joined_at).where(
                CuratorGroupMember.group_id == UUID(group["id"])
            )
        )
    ).all()

    await _revoke(client, admin_token, teacher["user"]["id"])

    hidden = (await client.get(members_url, headers=headers)).json()
    assert hidden["total"] == 1
    assert hidden["items"][0]["is_visible"] is False
    assert (
        (await client.get(GROUPS_URL, headers=headers)).json()["items"][0][
            "masters_count"
        ]
        == 0
    )

    await _re_verify(client, admin_token, teacher["user"]["id"])

    back = (await client.get(members_url, headers=headers)).json()
    assert back["items"][0]["is_visible"] is True
    assert (
        (await client.get(GROUPS_URL, headers=headers)).json()["items"][0][
            "masters_count"
        ]
        == 1
    )

    after = (
        await fresh_execute(
            select(CuratorGroupMember.id, CuratorGroupMember.joined_at).where(
                CuratorGroupMember.group_id == UUID(group["id"])
            )
        )
    ).all()
    assert after == before


@pytest.mark.asyncio
async def test_kind_filter_splits_the_roster(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Both kinds without the filter; one kind with it."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    teacher = await _make_verified_master(
        client, db_session, _TID_MASTER2, first_name="Teacher",
    )
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    group = await _create_group(client, curator, name="Школа")
    await _add_member(
        db_session, group["id"], teacher["user"]["id"],
        CuratorMemberKind.MASTER,
    )
    await _add_member(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )

    headers = auth_headers(curator["session_token"])
    url = MEMBERS_URL.format(group_id=group["id"])

    both = (await client.get(url, headers=headers)).json()
    assert both["total"] == 2

    masters = (await client.get(f"{url}?kind=master", headers=headers)).json()
    assert masters["total"] == 1
    assert masters["items"][0]["kind"] == "master"

    students = (await client.get(f"{url}?kind=student", headers=headers)).json()
    assert students["total"] == 1
    assert students["items"][0]["kind"] == "student"


@pytest.mark.asyncio
async def test_unknown_kind_is_422_from_the_literal(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """P-11: an unknown kind is rejected at the FastAPI layer, so no
    hand-rolled Enum(value) can raise ValueError into a 500."""
    master = await _make_verified_master(client, db_session, _TID_CURATOR)
    group = await _create_group(client, master, name="Школа")
    resp = await client.get(
        f"{MEMBERS_URL.format(group_id=group['id'])}?kind=foo",
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_search_matches_by_name_and_misses_cleanly(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A hit returns the person; a miss is an empty page, not a 404."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(
        client, telegram_id=_TID_STUDENT_A, first_name="Ксения",
    )
    group = await _create_group(client, curator, name="Школа")
    await _add_member(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )

    headers = auth_headers(curator["session_token"])
    url = MEMBERS_URL.format(group_id=group["id"])

    hit = (await client.get(f"{url}?search=ксен", headers=headers)).json()
    assert hit["total"] == 1

    miss = (await client.get(f"{url}?search=zzzz", headers=headers)).json()
    assert miss["total"] == 0
    assert miss["items"] == []


@pytest.mark.asyncio
async def test_offset_past_total_returns_an_empty_page_with_a_live_total(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """PUSTOTA at the pagination edge: total keeps telling the truth."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    group = await _create_group(client, curator, name="Школа")
    await _add_member(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )

    body = (
        await client.get(
            f"{MEMBERS_URL.format(group_id=group['id'])}?offset=50",
            headers=auth_headers(curator["session_token"]),
        )
    ).json()
    assert body["items"] == []
    assert body["total"] == 1
    assert body["offset"] == 50


@pytest.mark.asyncio
async def test_roster_is_newest_membership_first(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """joined_at DESC -- the mirror of the student-groups roster ordering."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    older = await login_user(
        client, telegram_id=_TID_STUDENT_A, first_name="Older",
    )
    newer = await login_user(
        client, telegram_id=_TID_STUDENT_B, first_name="Newer",
    )
    group = await _create_group(client, curator, name="Школа")
    await _add_member(
        db_session, group["id"], older["user"]["id"],
        CuratorMemberKind.STUDENT,
        joined_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    await _add_member(
        db_session, group["id"], newer["user"]["id"],
        CuratorMemberKind.STUDENT,
        joined_at=datetime(2026, 6, 1, tzinfo=UTC),
    )

    items = (
        await client.get(
            MEMBERS_URL.format(group_id=group["id"]),
            headers=auth_headers(curator["session_token"]),
        )
    ).json()["items"]
    assert [i["name"] for i in items] == ["Newer", "Older"]


# ===========================================================================
# Remove member
# ===========================================================================


@pytest.mark.asyncio
async def test_remove_member_is_idempotent(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """POVTOR: the row goes on the first call, and the second is still 204.

    The 204 pair: the first one is checked against the roster actually
    shrinking, so "204" alone can never stand in for "did nothing".
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    group = await _create_group(client, curator, name="Школа")
    await _add_member(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )

    headers = auth_headers(curator["session_token"])
    url = MEMBER_URL.format(
        group_id=group["id"], user_id=student["user"]["id"],
    )

    first = await client.delete(url, headers=headers)
    assert first.status_code == 204
    assert (
        await client.get(
            MEMBERS_URL.format(group_id=group["id"]), headers=headers,
        )
    ).json()["total"] == 0

    second = await client.delete(url, headers=headers)
    assert second.status_code == 204


@pytest.mark.asyncio
async def test_removing_the_curator_or_a_stranger_is_204_without_effect(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """NEHVATKA: the curator is not a member row (I-2), so removing them
    deletes nothing -- and neither call disturbs the real member."""
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    group = await _create_group(client, curator, name="Школа")
    await _add_member(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )

    headers = auth_headers(curator["session_token"])
    own = await client.delete(
        MEMBER_URL.format(
            group_id=group["id"], user_id=curator["user"]["id"],
        ),
        headers=headers,
    )
    assert own.status_code == 204

    nobody = await client.delete(
        MEMBER_URL.format(group_id=group["id"], user_id=uuid4()),
        headers=headers,
    )
    assert nobody.status_code == 204

    assert (
        await client.get(
            MEMBERS_URL.format(group_id=group["id"]), headers=headers,
        )
    ).json()["total"] == 1


# ===========================================================================
# Schema-level guarantees -- the constraints, not the endpoints
# ===========================================================================


@pytest.mark.asyncio
async def test_one_relation_per_pair_is_enforced_by_the_database(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """UNIQUE (group_id, user_id): one person cannot hold both a master and
    a student row in one group (I-2).

    Asserted at the DB, not through an endpoint, because there is no join
    API in this delivery -- and because this IS a schema promise that GT-3's
    join will lean on. It is also the closest honest stand-in for the
    concurrent-create race: two simultaneous writers are not reproducible in
    this suite, but the constraint they collide with is.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    group = await _create_group(client, curator, name="Школа")

    await _add_member(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )

    db_session.add(
        CuratorGroupMember(
            group_id=UUID(group["id"]),
            user_id=UUID(student["user"]["id"]),
            kind=CuratorMemberKind.MASTER.value,
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_only_one_pending_transfer_per_group(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """UNIQUE (group_id) on curator_group_transfer (I-10).

    The table has no writer until GT-4; this checks the promise the schema
    makes to that writer, so GT-4 does not discover it by shipping.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    first = await _make_verified_master(
        client, db_session, _TID_MASTER2, first_name="First",
    )
    second = await _make_verified_master(
        client, db_session, _TID_MASTER3, first_name="Second",
    )
    group = await _create_group(client, curator, name="Школа")

    db_session.add(
        CuratorGroupTransfer(
            group_id=UUID(group["id"]),
            to_user_id=UUID(first["user"]["id"]),
        )
    )
    await db_session.flush()
    await db_session.commit()

    db_session.add(
        CuratorGroupTransfer(
            group_id=UUID(group["id"]),
            to_user_id=UUID(second["user"]["id"]),
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_deleting_a_member_user_cascades_the_membership(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """ON DELETE CASCADE on the users FK -- the property this file's whole
    cleanup rests on.

    Checked as a SCHEMA fact rather than as an API state: production never
    hard-deletes a user, so a test dressed as "what the endpoint does when a
    member disappears" would be describing a situation that does not occur.
    What does occur is full_cleanup_range(delete_users=True) around every
    test in this file, and this is the guarantee that makes it sufficient.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT_A)
    group = await _create_group(client, curator, name="Школа")
    await _add_member(
        db_session, group["id"], student["user"]["id"],
        CuratorMemberKind.STUDENT,
    )

    user = await db_session.get(User, UUID(student["user"]["id"]))
    await db_session.delete(user)
    await db_session.commit()

    left = (
        await fresh_execute(
            select(CuratorGroupMember).where(
                CuratorGroupMember.group_id == UUID(group["id"])
            )
        )
    ).scalars().all()
    assert left == []

    counts = (
        await client.get(
            GROUPS_URL, headers=auth_headers(curator["session_token"]),
        )
    ).json()["items"][0]
    assert counts["students_count"] == 0
