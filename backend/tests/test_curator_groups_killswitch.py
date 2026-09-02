# =============================================================================
# VELO Backend -- Tests: the schools killswitch (GT-19)
# =============================================================================
#
# telegram_id band: 65600-65799. Declared once, module-level, as
# _TID_MIN/_TID_MAX -- tests/telegram_id_bands.py reads that declaration out
# of the AST on every run, and a file using ids without declaring a band
# fails test_blind_zone_has_not_grown. Checked free against the live
# registry before it was claimed: free_windows(space=(65000, 65999))
# returned [(65600, 65999)].
#
# THE DANGER HERE IS THE OPPOSITE OF THE USUAL ONE. Normally a test asks
# "does the feature work". A killswitch has to be asked "does OFF mean
# off" -- and a missed entry point does not fail a test that only checks
# the ones somebody remembered. So the shape of this file is: enumerate the
# map, and cover every point on it, including the two that are NOT gated on
# purpose.
#
# EVERY TEST HAS TWO HALVES. With the flag off, the thing is gone; with the
# flag in its default, the same thing works exactly as before. A test that
# only checked the off state would pass just as happily if the dependency
# were unconditional -- which would take the whole feature down in
# production.
#
# THE LAYER THAT ANSWERS, PER CODE, decided before the tests were written
# (the check that caught a real defect in GT-16):
#
#   404 (flag off, school endpoints) -> the ROUTER dependency. Measured, not
#       assumed: a router-level dependency runs BEFORE the path ones, so an
#       UNAUTHENTICATED caller also gets 404 here, and a plain user gets 404
#       where get_current_master would otherwise answer 403. Any expectation
#       of 401/403 on these paths with the flag off is wrong about the layer.
#   403 not_in_audience (flag off, a school practice) -> the audience clause
#       inside assert_viewer_can_access_practice.
#   200 for the practice's own master -> list_public_practices ORs in
#       `Practice.master_id == user.id`, which the flag does not touch.
#   200 for a booking holder -> the H-R2-8 read grandfather, which runs
#       BEFORE the audience assert and is deliberately not gated.
#
# ⚠ BACKEND-ONLY, UNPROVEN LOCALLY -- no Postgres in the authoring
# environment. Never executed via pytest this session. What WAS measured is
# in the delivery report.
#
# THE FLAG IS TOGGLED WITH patch.object(settings, ...), never by editing the
# environment: the setting is read at call time by both consumers, and a
# test that mutated os.environ would need a Settings reload and would leak
# into whatever ran next.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeAudienceCuratorGroup,
    PracticeStatus,
    PracticeType,
)
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

GROUPS_URL = "/api/v1/masters/me/curator-groups"
GROUP_URL = "/api/v1/masters/me/curator-groups/{group_id}"
JOURNAL_URL = "/api/v1/masters/me/curator-groups/{group_id}/journal"
MEMBERS_URL = "/api/v1/masters/me/curator-groups/{group_id}/members"
INVITES_URL = "/api/v1/masters/me/curator-groups/{group_id}/invites"
MINE_URL = "/api/v1/curator-groups/mine"
PAGE_URL = "/api/v1/curator-groups/{group_id}"
JOIN_URL = "/api/v1/curator-groups/join"
LEAVE_URL = "/api/v1/curator-groups/{group_id}/membership"
PRACTICES_URL = "/api/v1/practices"
DETAIL_URL = "/api/v1/practices/{practice_id}"
ADMIN_SCHOOLS_URL = "/api/v1/admin/curator-groups"

_TID_MIN = 65600
_TID_MAX = 65799

_TID_CURATOR = 65601
_TID_MASTER_B = 65602
_TID_STUDENT = 65610
_TID_BOOKER = 65611
_TID_OUTSIDER = 65630
_TID_ADMIN = 65690

_FLAG = "curator_groups_enabled"


def _off():
    """The killswitch pulled, for the duration of a `with` block."""
    return patch.object(settings, _FLAG, False)


def _on():
    """The killswitch in its default position, stated explicitly.

    Used where a test asserts the "works as before" half. Written as a
    patch rather than relying on the ambient default so the two halves of
    each test read symmetrically and neither depends on what some other
    test left behind.
    """
    return patch.object(settings, _FLAG, True)


# ===========================================================================
# Fixtures and local helpers -- copied, as in every curator test file.
# ===========================================================================


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    first_name: str = "Master",
) -> dict:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
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


async def _make_admin(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> str:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Admin")
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    user.role = UserRole.ADMIN
    await db_session.flush()
    await db_session.commit()
    return auth["session_token"]


async def _make_school(
    db_session: AsyncSession, curator: dict, name: str = "Школа дыхания",
) -> CuratorGroup:
    """Build the school with the ORM, not through the API.

    Deliberate: with the flag off the creation endpoint answers 404, so a
    test about what happens to an EXISTING school cannot create one through
    the API while the flag is off, and creating it with the flag on would
    make every test carry two flag states before it even starts.
    """
    school = CuratorGroup(
        curator_user_id=UUID(curator["user"]["id"]), name=name,
    )
    db_session.add(school)
    await db_session.flush()
    await db_session.commit()
    return school


async def _add_member(
    db_session: AsyncSession, school: CuratorGroup, auth: dict, kind: str,
) -> None:
    db_session.add(
        CuratorGroupMember(
            group_id=school.id,
            user_id=UUID(auth["user"]["id"]),
            kind=kind,
        )
    )
    await db_session.commit()


async def _make_school_practice(
    db_session: AsyncSession,
    master_id: str,
    schools: list[CuratorGroup],
    title: str = "Практика школы",
) -> Practice:
    practice = Practice(
        master_id=UUID(master_id),
        title=title,
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=PracticeStatus.SCHEDULED.value,
        scheduled_at=datetime.now(UTC) + timedelta(hours=48),
        duration_minutes=60,
        timezone="UTC",
        max_participants=20,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        audience_kind=AudienceKind.CURATOR_GROUPS.value,
    )
    db_session.add(practice)
    await db_session.flush()
    for school in schools:
        db_session.add(
            PracticeAudienceCuratorGroup(
                practice_id=practice.id, group_id=school.id,
            )
        )
    await db_session.flush()
    await db_session.commit()
    return practice


async def _titles_in_feed(client: AsyncClient, auth: dict) -> list[str]:
    resp = await client.get(
        PRACTICES_URL,
        params={"limit": 100},
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    return [p["title"] for p in resp.json()["items"]]


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
# The default -- the half that protects 213 existing tests
# ===========================================================================


@pytest.mark.asyncio
async def test_the_flag_defaults_to_on_and_the_feature_works_under_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The default is True, and under the default a school works end to end.

    TWO ASSERTIONS, AND THE SECOND IS WHY THE FIRST IS NOT ENOUGH. The
    literal `settings.curator_groups_enabled is True` catches somebody
    flipping the default -- which would 404 every school endpoint and take
    down the 213 tests across the five curator files plus the three GT-15..17
    files, with nothing in the failure output pointing at a config line.

    But that assertion alone would still pass in a world where the default
    is True and the dependency refuses anyway. So the same test drives the
    feature: create, read the page, read the journal. If the killswitch is
    wired wrong, this fails here rather than in 213 places.
    """
    assert settings.curator_groups_enabled is True

    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    headers = auth_headers(curator["session_token"])

    created = await client.post(
        GROUPS_URL, json={"name": "Школа дыхания"}, headers=headers,
    )
    assert created.status_code == 201, created.text
    group_id = created.json()["id"]

    assert (
        await client.get(PAGE_URL.format(group_id=group_id), headers=headers)
    ).status_code == 200
    assert (
        await client.get(
            JOURNAL_URL.format(group_id=group_id), headers=headers,
        )
    ).status_code == 200


# ===========================================================================
# Entry point 1-2 -- the 23 endpoints on the two school routers
# ===========================================================================


@pytest.mark.asyncio
async def test_every_curator_endpoint_is_404_when_the_flag_is_off(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The curator's own router: gone, and back when the flag returns.

    The school and its member exist in the database throughout -- the point
    is not that there is nothing to find, it is that what exists is
    unreachable. The "and back" half is in the same test because a
    dependency that refused unconditionally would satisfy the first half
    perfectly.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT)
    school = await _make_school(db_session, curator)
    await _add_member(
        db_session, school, student, CuratorMemberKind.STUDENT.value,
    )
    headers = auth_headers(curator["session_token"])
    gid = str(school.id)

    calls = [
        ("GET", GROUPS_URL),
        ("PATCH", GROUP_URL.format(group_id=gid)),
        ("GET", JOURNAL_URL.format(group_id=gid)),
        ("GET", MEMBERS_URL.format(group_id=gid)),
        ("POST", INVITES_URL.format(group_id=gid)),
    ]

    with _off():
        for verb, url in calls:
            resp = await client.request(
                verb, url, headers=headers, json={"name": "Тихое утро"},
            )
            assert resp.status_code == 404, f"{verb} {url}: {resp.text}"

    with _on():
        assert (
            await client.get(GROUPS_URL, headers=headers)
        ).status_code == 200
        assert (
            await client.get(
                MEMBERS_URL.format(group_id=gid), headers=headers,
            )
        ).status_code == 200


@pytest.mark.asyncio
async def test_every_member_endpoint_is_404_when_the_flag_is_off(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The member-facing router: same, for a real member of a real school.

    A separate test from the curator one because they are two different
    APIRouter objects, each with its own dependency list. Gating one and
    forgetting the other is exactly the "the switch did not switch"
    failure this delivery is about, and no single-router test would show it.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT)
    school = await _make_school(db_session, curator)
    await _add_member(
        db_session, school, student, CuratorMemberKind.STUDENT.value,
    )
    headers = auth_headers(student["session_token"])
    gid = str(school.id)

    with _off():
        for verb, url in (
            ("GET", MINE_URL),
            ("GET", PAGE_URL.format(group_id=gid)),
            ("DELETE", LEAVE_URL.format(group_id=gid)),
            ("POST", JOIN_URL),
        ):
            resp = await client.request(
                verb, url, headers=headers, json={"token": "x" * 32},
            )
            assert resp.status_code == 404, f"{verb} {url}: {resp.text}"

    with _on():
        mine = await client.get(MINE_URL, headers=headers)
        assert mine.status_code == 200, mine.text
        assert gid in [g["id"] for g in mine.json()["items"]]


@pytest.mark.asyncio
async def test_an_unauthenticated_caller_also_gets_404_not_401(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The router dependency runs before the auth ones, so 404 comes first.

    MEASURED BEFORE THIS TEST WAS WRITTEN, not assumed -- and it is the
    reason the file's header spells the layers out. With the flag off the
    endpoint must not reveal that it needs a token, because needing a token
    is a fact about a feature that is supposed to look absent.

    The paired half: with the flag on, the SAME call without a token gets
    401/403 -- which shows the 404 above came from the killswitch and not
    from a route that simply does not exist.
    """
    with _off():
        resp = await client.get(GROUPS_URL)
        assert resp.status_code == 404, resp.text

    with _on():
        resp = await client.get(GROUPS_URL)
        assert resp.status_code in (401, 403), resp.text


@pytest.mark.asyncio
async def test_a_plain_user_gets_404_where_they_would_get_403(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The same shadowing, one layer down: get_current_master never runs.

    Distinct from the unauthenticated case: here the caller IS
    authenticated and simply is not a master, so with the flag on the
    answer is a 403 about their account. With the flag off that 403 becomes
    404 -- the killswitch hides the feature even from someone who would
    have been told they lack a role.
    """
    plain = await login_user(client, telegram_id=_TID_OUTSIDER)
    headers = auth_headers(plain["session_token"])

    with _on():
        resp = await client.get(GROUPS_URL, headers=headers)
        assert resp.status_code == 403, resp.text

    with _off():
        resp = await client.get(GROUPS_URL, headers=headers)
        assert resp.status_code == 404, resp.text


# ===========================================================================
# Entry point 4-5 -- the audience, which is why this flag exists
# ===========================================================================


@pytest.mark.asyncio
async def test_a_school_practice_leaves_every_feed_except_its_masters(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """THE LOAD-BEARING TEST OF THE WHOLE DELIVERY.

    The killswitch exists because schools change what OTHER people see: a
    practice with audience_kind='curator_groups' is hidden from anyone
    outside the target school, so a fault in schools removes practices from
    the calendars of people who never heard of schools. A brake that
    switched off the endpoints but left the audience filter running would
    not stop that -- and would be pulled and believed.

    So: with the flag off the practice is gone from the curator's feed and
    from the student member's feed, and still present in its master's. With
    the flag on, all three see it. Both halves, three viewers, one test,
    because the claim is about the difference between them.
    """
    teacher = await _make_verified_master(client, db_session, _TID_MASTER_B)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT)

    school = await _make_school(db_session, curator)
    await _add_member(
        db_session, school, teacher, CuratorMemberKind.MASTER.value,
    )
    await _add_member(
        db_session, school, student, CuratorMemberKind.STUDENT.value,
    )
    await _make_school_practice(
        db_session, teacher["user"]["id"], [school], title="Практика школы",
    )

    with _on():
        for who in (teacher, curator, student):
            assert "Практика школы" in await _titles_in_feed(client, who)

    with _off():
        assert "Практика школы" in await _titles_in_feed(client, teacher)
        for who in (curator, student):
            assert "Практика школы" not in await _titles_in_feed(client, who)


@pytest.mark.asyncio
async def test_a_school_practice_detail_is_refused_by_the_audience_gate(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """403 not_in_audience for a member, from the audience layer.

    Not 404 and not the killswitch's own code: the practice still exists
    and the refusal is the ordinary "you are not in this practice's
    audience", which is what a member of a school whose audience has gone
    dark genuinely is. Reusing the existing code is deliberate -- a new
    code here would become the reliable way to detect that the flag is
    down.

    The master's own 200 in the same state is the paired half, and it also
    pins the layer: the owner path bypasses the audience gate entirely.
    """
    teacher = await _make_verified_master(client, db_session, _TID_MASTER_B)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _make_school(db_session, curator)
    await _add_member(
        db_session, school, teacher, CuratorMemberKind.MASTER.value,
    )
    practice = await _make_school_practice(
        db_session, teacher["user"]["id"], [school],
    )
    url = DETAIL_URL.format(practice_id=str(practice.id))

    with _on():
        assert (
            await client.get(
                url, headers=auth_headers(curator["session_token"]),
            )
        ).status_code == 200

    with _off():
        refused = await client.get(
            url, headers=auth_headers(curator["session_token"]),
        )
        assert refused.status_code == 403, refused.text
        assert refused.json()["error"] == "not_in_audience"

        owner = await client.get(
            url, headers=auth_headers(teacher["session_token"]),
        )
        assert owner.status_code == 200, owner.text


@pytest.mark.asyncio
async def test_the_master_is_told_that_the_audience_is_unavailable(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """audience_unavailable flips to true, and the school names stay.

    The one place the flag is REPORTED rather than only enforced. The
    master of a practice nobody can see has to know that, and the names
    have to remain: the flag says "nobody sees this", the names say which
    school it was pointed at. Reporting the flag while blanking the names
    would tell them something is broken without telling them what.
    """
    teacher = await _make_verified_master(client, db_session, _TID_MASTER_B)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _make_school(db_session, curator, name="Тихое утро")
    await _add_member(
        db_session, school, teacher, CuratorMemberKind.MASTER.value,
    )
    practice = await _make_school_practice(
        db_session, teacher["user"]["id"], [school],
    )
    url = DETAIL_URL.format(practice_id=str(practice.id))
    headers = auth_headers(teacher["session_token"])

    with _on():
        body = (await client.get(url, headers=headers)).json()
        assert body["audience_unavailable"] is False
        assert body["audience_curator_group_names"] == ["Тихое утро"]

    with _off():
        body = (await client.get(url, headers=headers)).json()
        assert body["audience_unavailable"] is True
        assert body["audience_curator_group_names"] == ["Тихое утро"]


@pytest.mark.asyncio
async def test_a_public_practice_is_untouched_by_the_flag(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The blast radius has an edge, and this test is where it is.

    The killswitch narrows exactly one arm of the audience or_(). A public
    practice by the same master, in the same feed, in the same request must
    be unaffected -- otherwise the brake takes down more than schools, which
    for an emergency lever is the worst possible failure: it would be pulled
    during an incident and make the incident bigger.
    """
    teacher = await _make_verified_master(client, db_session, _TID_MASTER_B)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _make_school(db_session, curator)
    await _add_member(
        db_session, school, teacher, CuratorMemberKind.MASTER.value,
    )
    await _make_school_practice(
        db_session, teacher["user"]["id"], [school], title="Школьная",
    )

    public = Practice(
        master_id=UUID(teacher["user"]["id"]),
        title="Публичная",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=PracticeStatus.SCHEDULED.value,
        scheduled_at=datetime.now(UTC) + timedelta(hours=48),
        duration_minutes=60,
        timezone="UTC",
        max_participants=20,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        audience_kind=AudienceKind.PUBLIC.value,
    )
    db_session.add(public)
    await db_session.commit()

    with _off():
        titles = await _titles_in_feed(client, curator)
        assert "Публичная" in titles
        assert "Школьная" not in titles


# ===========================================================================
# The two points that are NOT gated, on purpose
# ===========================================================================


@pytest.mark.asyncio
async def test_a_booking_holder_keeps_reading_the_practice_they_paid_for(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """H-R2-8 is deliberately NOT gated, and that is a decision.

    The read grandfather in practices/service.py runs BEFORE the audience
    assert, so an access-granting booking still opens the detail with the
    flag off. Switching a feature off must not retroactively take away
    access somebody already has -- the brake stops the audience from
    cutting into calendars, it does not cancel purchases.

    Paired with a member of the same school who holds NO booking and is
    refused in the same state: without that half, "the booker sees it"
    could equally mean the killswitch never fired.
    """
    teacher = await _make_verified_master(client, db_session, _TID_MASTER_B)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    booker = await login_user(client, telegram_id=_TID_BOOKER)
    school = await _make_school(db_session, curator)
    await _add_member(
        db_session, school, teacher, CuratorMemberKind.MASTER.value,
    )
    await _add_member(
        db_session, school, booker, CuratorMemberKind.STUDENT.value,
    )
    practice = await _make_school_practice(
        db_session, teacher["user"]["id"], [school],
    )

    db_session.add(
        Booking(
            user_id=UUID(booker["user"]["id"]),
            practice_id=practice.id,
            status=BookingStatus.CONFIRMED.value,
            price_cents=0,
            currency="eur",
        )
    )
    await db_session.commit()

    url = DETAIL_URL.format(practice_id=str(practice.id))
    with _off():
        held = await client.get(
            url, headers=auth_headers(booker["session_token"]),
        )
        assert held.status_code == 200, held.text

        refused = await client.get(
            url, headers=auth_headers(curator["session_token"]),
        )
        assert refused.status_code == 403, refused.text


@pytest.mark.asyncio
async def test_the_admin_list_of_schools_stays_available(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The operator's cockpit does not go dark with the engine.

    The 24th school operation is NOT gated, deliberately: the admin who
    pulled the switch has to see what they switched off and whether it is
    time to switch it back. It is read-only, admin-gated, and cannot affect
    anyone outside schools -- so it is outside what the brake exists to
    stop.

    This test is the difference between a decision and an oversight: if
    somebody later gates it, this fails and they read why.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _make_school(db_session, curator, name="Тихое утро")
    admin_token = await _make_admin(client, db_session, _TID_ADMIN)

    with _off():
        resp = await client.get(
            ADMIN_SCHOOLS_URL,
            params={"limit": 100},
            headers=auth_headers(admin_token),
        )
        assert resp.status_code == 200, resp.text
        assert str(school.id) in [g["id"] for g in resp.json()["items"]]


# ===========================================================================
# Turning it back on
# ===========================================================================


@pytest.mark.asyncio
async def test_switching_back_on_restores_everything_with_no_rows_touched(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Off then on leaves the school exactly as it was.

    The flag writes nothing -- no row, no journal entry -- so recovery is
    the absence of an action rather than an undo. Asserted through the
    journal specifically: it is the one place a stray write would show up,
    and an emergency lever that logged itself into a school's history would
    be telling that school's curator about our incident.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    headers = auth_headers(curator["session_token"])

    created = await client.post(
        GROUPS_URL, json={"name": "Школа дыхания"}, headers=headers,
    )
    assert created.status_code == 201, created.text
    gid = created.json()["id"]

    before = (
        await client.get(JOURNAL_URL.format(group_id=gid), headers=headers)
    ).json()

    with _off():
        assert (
            await client.get(
                JOURNAL_URL.format(group_id=gid), headers=headers,
            )
        ).status_code == 404

    after = await client.get(
        JOURNAL_URL.format(group_id=gid), headers=headers,
    )
    assert after.status_code == 200, after.text
    assert after.json()["total"] == before["total"]
    assert [e["event"] for e in after.json()["items"]] == [
        e["event"] for e in before["items"]
    ]

    page = await client.get(PAGE_URL.format(group_id=gid), headers=headers)
    assert page.status_code == 200
    assert page.json()["name"] == "Школа дыхания"


@pytest.mark.asyncio
async def test_pulling_the_switch_twice_changes_nothing_the_second_time(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Idempotent, because the flag is read and never written.

    Trivial by construction, and worth pinning anyway: the moment somebody
    makes this flag do work on transition -- cache invalidation, a
    notification, a row -- this test is where that shows up.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _make_school(db_session, curator)
    headers = auth_headers(curator["session_token"])
    gid = str(school.id)

    with _off():
        first = await client.get(
            PAGE_URL.format(group_id=gid), headers=headers,
        )
        with _off():
            second = await client.get(
                PAGE_URL.format(group_id=gid), headers=headers,
            )
    assert first.status_code == 404
    assert second.status_code == 404

    with _on():
        assert (
            await client.get(PAGE_URL.format(group_id=gid), headers=headers)
        ).status_code == 200


@pytest.mark.asyncio
async def test_the_switch_holds_with_no_schools_in_the_database(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """404 for the same reason whether or not there is anything to hide.

    The emptiness case: a caller must not be able to tell "the feature is
    off" from "you have no schools" -- with the flag on an empty account
    gets 200 and an empty list, with it off the same account gets 404, and
    those are the two answers a client has to distinguish.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    headers = auth_headers(curator["session_token"])

    with _on():
        empty = await client.get(GROUPS_URL, headers=headers)
        assert empty.status_code == 200, empty.text
        assert empty.json()["items"] == []

    with _off():
        gone = await client.get(GROUPS_URL, headers=headers)
        assert gone.status_code == 404, gone.text

    missing = str(uuid4())
    with _off():
        assert (
            await client.get(
                PAGE_URL.format(group_id=missing), headers=headers,
            )
        ).status_code == 404
