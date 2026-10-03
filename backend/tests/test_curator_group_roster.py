# =============================================================================
# VELO Backend -- Tests: the school roster for its masters (BE-76)
# =============================================================================
#
# telegram_id band: 70500-70599, declared once below as _TID_MIN/_TID_MAX
# (checked free against tests/telegram_id_bands.py before it was claimed).
# Each test owns its own ids inside the band.
#
# GET /api/v1/masters/me/curator-groups/{id}/roster opens the school's
# member list to the MASTERS OF THE SCHOOL (owner decisions, BE-76):
#   - who reads it: an active school (its curator verified) AND the viewer
#     belongs to it as a master -- the curator, or a kind='master' member
#     with a verified profile; everyone else with a master role gets the
#     masked 404 (P-08), a non-master a 403 from get_current_master;
#   - what they read: user_id, name, avatar_url, kind, joined_at -- never
#     the curator's is_visible / master_offer -- and no master who is
#     suspended right now;
#   - kind / search / paging / order: the curator's /members helper, so the
#     two lists are the same list minus the suspended masters.
# The curator's /members is untouched and keeps its own tests.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from unittest.mock import patch
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

ROSTER_URL = "/api/v1/masters/me/curator-groups/{group_id}/roster"
MEMBERS_URL = "/api/v1/masters/me/curator-groups/{group_id}/members"

_TID_MIN = 70500
_TID_MAX = 70599

_ROSTER_KEYS = {"user_id", "name", "avatar_url", "kind", "joined_at"}


@pytest.fixture(autouse=True)
async def _clean_band(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    # Committed before the test body: an uncommitted DELETE would park this
    # session holding user-row locks that the body's first login waits on.
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# =============================================================================
# Helpers
# =============================================================================


async def _master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    first_name: str,
    *,
    status: str = "verified",
) -> dict:
    """A master-role user with a profile in `status` (verified / suspended)."""
    auth = await login_user(client, telegram_id=telegram_id, first_name=first_name)
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    user.role = UserRole.MASTER
    db_session.add(
        MasterProfile(
            user_id=user.id,
            data={
                "account": {"status": status, "can_create_groups": True},
                "profile": {"bio": "m"},
            },
        )
    )
    await db_session.commit()
    return auth


async def _set_status(db_session: AsyncSession, auth: dict, status: str) -> None:
    profile = await db_session.get(MasterProfile, UUID(auth["user"]["id"]))
    profile.data = {
        **profile.data,
        "account": {**profile.data["account"], "status": status},
    }
    await db_session.commit()


async def _user(client: AsyncClient, telegram_id: int, first_name: str) -> dict:
    return await login_user(client, telegram_id=telegram_id, first_name=first_name)


async def _school(db_session: AsyncSession, curator: dict, name: str) -> CuratorGroup:
    group = CuratorGroup(curator_user_id=UUID(curator["user"]["id"]), name=name)
    db_session.add(group)
    await db_session.commit()
    return group


async def _join(
    db_session: AsyncSession,
    school: CuratorGroup,
    who: dict,
    kind: CuratorMemberKind,
    joined_at: datetime,
) -> None:
    db_session.add(
        CuratorGroupMember(
            group_id=school.id,
            user_id=UUID(who["user"]["id"]),
            kind=kind.value,
            joined_at=joined_at,
        )
    )
    await db_session.commit()


async def _get(client: AsyncClient, url: str, who: dict, **params: object):
    return await client.get(
        url, params=params, headers=auth_headers(who["session_token"])
    )


async def _school_with_people(client: AsyncClient, db_session: AsyncSession, base: int):
    """A school with every kind of person the grid needs; ids from `base`.

    Members, newest membership first: Борис (master, verified), Сергей
    (master, SUSPENDED), Анна (student), Вера (student), Марк (a verified
    master-role user who is a STUDENT here). Outside the school: a stranger
    master, another school's curator, a plain user.
    """
    t0 = datetime.now(UTC) - timedelta(days=10)
    curator = await _master(client, db_session, base, "Куратор")
    boris = await _master(client, db_session, base + 1, "Борис")
    sergey = await _master(client, db_session, base + 2, "Сергей")
    anna = await _user(client, base + 3, "Анна")
    vera = await _user(client, base + 4, "Вера")
    mark = await _master(client, db_session, base + 5, "Марк")
    stranger = await _master(client, db_session, base + 6, "Чужой")
    other_curator = await _master(client, db_session, base + 7, "Другой")
    plain = await _user(client, base + 8, "Прохожий")

    school = await _school(db_session, curator, "Роза ветров")
    await _school(db_session, other_curator, "Другая школа")
    # joined_at strictly ordered so the newest-first order is a fact, not luck.
    await _join(
        db_session, school, mark, CuratorMemberKind.STUDENT, t0 + timedelta(days=1)
    )
    await _join(
        db_session, school, vera, CuratorMemberKind.STUDENT, t0 + timedelta(days=2)
    )
    await _join(
        db_session, school, anna, CuratorMemberKind.STUDENT, t0 + timedelta(days=3)
    )
    await _join(
        db_session, school, sergey, CuratorMemberKind.MASTER, t0 + timedelta(days=4)
    )
    await _join(
        db_session, school, boris, CuratorMemberKind.MASTER, t0 + timedelta(days=5)
    )
    await _set_status(db_session, sergey, "suspended")
    return {
        "school": school,
        "curator": curator,
        "boris": boris,
        "sergey": sergey,
        "anna": anna,
        "vera": vera,
        "mark": mark,
        "stranger": stranger,
        "other_curator": other_curator,
        "plain": plain,
    }


# =============================================================================
# The grid of rights
# =============================================================================


async def test_who_reads_the_roster(client: AsyncClient, db_session: AsyncSession):
    """Every viewer of the gate's grid, one request each."""
    w = await _school_with_people(client, db_session, 70500)
    url = ROSTER_URL.format(group_id=w["school"].id)

    expected = {
        "curator": 200,
        "boris": 200,  # verified master of the school
        "sergey": 403,  # suspended master of the school: the dependency
        "mark": 404,  # verified master who is a STUDENT here
        "stranger": 404,  # master outside the school
        "other_curator": 404,  # another school's curator
        "anna": 403,  # student of the school: not a master
        "plain": 403,  # plain user
    }
    got = {who: (await _get(client, url, w[who])).status_code for who in expected}
    assert got == expected


async def test_a_school_with_a_suspended_curator_is_404_for_its_masters(
    client: AsyncClient,
    db_session: AsyncSession,
):
    """The school is inactive once its curator is suspended (I-6): the
    roster answers its masters the same 404 as the school page does."""
    w = await _school_with_people(client, db_session, 70510)
    url = ROSTER_URL.format(group_id=w["school"].id)
    # The pair: the master reads it while the school is active.
    assert (await _get(client, url, w["boris"])).status_code == 200

    await _set_status(db_session, w["curator"], "suspended")
    assert (await _get(client, url, w["boris"])).status_code == 404


# =============================================================================
# What a master reads
# =============================================================================


async def test_a_master_reads_everyone_but_the_suspended_without_curator_fields(
    client: AsyncClient,
    db_session: AsyncSession,
):
    w = await _school_with_people(client, db_session, 70520)
    roster = (
        await _get(client, ROSTER_URL.format(group_id=w["school"].id), w["boris"])
    ).json()

    # Newest membership first; Сергей (suspended) is not there.
    assert [i["name"] for i in roster["items"]] == ["Борис", "Анна", "Вера", "Марк"]
    assert roster["total"] == 4
    assert {i["kind"] for i in roster["items"]} == {"master", "student"}
    # Exactly the member fields -- the pair: rows exist and carry values.
    for item in roster["items"]:
        assert set(item) == _ROSTER_KEYS
        assert item["user_id"] and item["name"] and item["joined_at"]

    # The curator's own list still shows Сергей, in the shadow (unchanged).
    members = (
        await _get(client, MEMBERS_URL.format(group_id=w["school"].id), w["curator"])
    ).json()
    assert members["total"] == 5
    sergey = next(i for i in members["items"] if i["name"] == "Сергей")
    assert sergey["is_visible"] is False


async def test_filters_search_and_paging_match_the_curators_list(
    client: AsyncClient,
    db_session: AsyncSession,
):
    """One helper behind both lists: the same kind / search / paging answers,
    minus the suspended master."""
    w = await _school_with_people(client, db_session, 70530)
    gid = w["school"].id

    async def names(who: str, url: str, **params: object) -> tuple[list[str], int]:
        body = (await _get(client, url.format(group_id=gid), w[who], **params)).json()
        return [i["name"] for i in body["items"]], body["total"]

    # kind
    assert await names("boris", ROSTER_URL, kind="student") == (
        ["Анна", "Вера", "Марк"],
        3,
    )
    assert await names("curator", MEMBERS_URL, kind="student") == (
        ["Анна", "Вера", "Марк"],
        3,
    )
    assert await names("boris", ROSTER_URL, kind="master") == (["Борис"], 1)
    assert await names("curator", MEMBERS_URL, kind="master") == (
        ["Борис", "Сергей"],
        2,
    )
    # search (ilike over the name), and a search with no hits
    assert await names("boris", ROSTER_URL, search="ер") == (["Вера"], 1)
    assert await names("curator", MEMBERS_URL, search="ер") == (["Сергей", "Вера"], 2)
    assert await names("boris", ROSTER_URL, search="zzz") == ([], 0)
    # paging: two pages, no repeat, no gap, total unchanged
    first = await names("boris", ROSTER_URL, limit=2, offset=0)
    second = await names("boris", ROSTER_URL, limit=2, offset=2)
    assert first == (["Борис", "Анна"], 4)
    assert second == (["Вера", "Марк"], 4)


async def test_a_lone_master_reads_himself(
    client: AsyncClient, db_session: AsyncSession
):
    """SHORTAGE: a school whose only verified master is the viewer (the other
    is suspended) and no students -- the list is the viewer alone."""
    base = 70540
    curator = await _master(client, db_session, base, "Куратор")
    me = await _master(client, db_session, base + 1, "Я")
    gone = await _master(client, db_session, base + 2, "Ушедший")
    school = await _school(db_session, curator, "Тихая")
    t0 = datetime.now(UTC) - timedelta(days=3)
    await _join(db_session, school, gone, CuratorMemberKind.MASTER, t0)
    await _join(
        db_session, school, me, CuratorMemberKind.MASTER, t0 + timedelta(days=1)
    )
    await _set_status(db_session, gone, "suspended")

    body = (await _get(client, ROSTER_URL.format(group_id=school.id), me)).json()
    assert [i["name"] for i in body["items"]] == ["Я"]
    assert body["total"] == 1


async def test_the_killswitch_closes_the_roster(
    client: AsyncClient, db_session: AsyncSession
):
    """/roster sits on the curator router, whose router-level dependency is
    the schools killswitch: with the flag off it is the same 404."""
    w = await _school_with_people(client, db_session, 70550)
    url = ROSTER_URL.format(group_id=w["school"].id)
    with patch.object(settings, "curator_groups_enabled", True):
        assert (await _get(client, url, w["boris"])).status_code == 200
    with patch.object(settings, "curator_groups_enabled", False):
        assert (await _get(client, url, w["boris"])).status_code == 404
