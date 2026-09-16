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
#   404 not_found (flag off, a school practice detail) -> the audience
#       clause refuses, and the DETAIL ENDPOINT CONVERTS that refusal:
#       practices/service.py catches ForbiddenError from
#       assert_viewer_can_access_practice and re-raises NotFoundError, so a
#       viewer outside the audience cannot learn the practice exists. The
#       gate's own code (403 not_in_audience) never reaches this client --
#       reading the gate and stopping there is a mistake about the layer.
#   403 not_in_audience -> the audience clause
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

import re
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from fastapi import APIRouter, FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

import app.modules.curator_groups.router as curator_groups_router_module
from app.core.config import settings
from app.main import app
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.curator_groups.router import member_router, router
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
# Entry points 1-2 -- EVERY operation on the two school routers
#
# THE LIST IS DERIVED, NOT WRITTEN. Until BE-35 these two tests named five
# calls between them while the routers carried twenty-eight operations, and
# the names said "every". Five endpoints were added over two deliveries,
# none reached the lists, and the tests stayed green the whole time -- a
# killswitch is the one mechanism where "the test passes" and "the feature
# is contained" must not be allowed to drift apart.
#
# There is no count in this comment on purpose. The previous one said 23,
# was right when it was written, and rotted silently; a number kept by hand
# next to a list kept by the framework is the thing that rots.
#
# app.routes IS THE WRONG SOURCE AND WAS MEASURED TO BE. This application
# mounts its routers rather than flattening them, so app.routes holds
# _IncludedRouter objects and contains no curator-group path at all -- a
# test built on it would derive an EMPTY list and pass, which is this very
# defect rebuilt inside its own fix. The routers themselves carry the full
# path (their prefix is set on the APIRouter), and the derived list is
# cross-checked against the OpenAPI document below.
# ===========================================================================

_PATH_PARAM = re.compile(r"\{[^}]+\}")
_NOBODYS_UUID = "00000000-0000-0000-0000-000000000000"


def _operations(source: APIRouter) -> list[tuple[str, str]]:
    """Every (method, full path) one router exposes, deduped and ordered."""
    return sorted(
        {
            (method, route.path)
            for route in source.routes
            for method in route.methods - {"HEAD", "OPTIONS"}
        }
    )


def _url(path: str) -> str:
    """A concrete URL for a route template, pointing at nothing.

    Every path parameter becomes a uuid that belongs to no row. Nothing is
    ever found behind these URLs and nothing needs to be: the killswitch
    answers before the handler, before the body is validated and before the
    caller is authenticated -- which is what makes this whole file need no
    fixtures.
    """
    return _PATH_PARAM.sub(_NOBODYS_UUID, path)


async def _assert_the_switch_covers(
    client: AsyncClient, method: str, path: str,
) -> None:
    """The pair, on one operation: 404 with the flag off, 401 with it on.

    A LONE 404 WOULD PROVE NOTHING. It is also what a URL that does not
    exist returns, so a typo in a derived path would read as success. The
    401 under the flag is the other half: it can only come from a route
    that is really mounted and really reached, which makes the 404 above
    attributable to the switch.

    No token and no body are sent, and that is not laziness -- it is the
    measurement this form rests on. The router-level dependency runs ahead
    of the authentication dependencies (test_an_unauthenticated_caller_...
    below pins that on one endpoint) and ahead of body validation, so the
    five operations that take a body answer 404 without one.
    """
    url = _url(path)
    with _off():
        blocked = await client.request(method, url)
        assert blocked.status_code == 404, (
            f"{method} {url} with the flag OFF: {blocked.status_code} "
            f"{blocked.text}"
        )
    with _on():
        alive = await client.request(method, url)
        assert alive.status_code == 401, (
            f"{method} {url} with the flag ON: expected 401 from the auth "
            f"layer, got {alive.status_code} {alive.text}"
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path"),
    _operations(router),
    ids=lambda v: v if isinstance(v, str) else str(v),
)
async def test_every_curator_endpoint_is_404_when_the_flag_is_off(
    client: AsyncClient, method: str, path: str,
) -> None:
    """The curator's own router, one case per operation.

    The old form was right about the five endpoints it named and wrong
    about the word "every"; what replaced it is the same assertion over a
    list the framework keeps. Parametrised rather than looped so that a
    failure names the operation instead of the first one that broke.

    The "and back on live data" half of the old test did not disappear --
    it moved to test_the_feature_answers_again_when_the_flag_returns below,
    where it can say honestly that it samples.
    """
    await _assert_the_switch_covers(client, method, path)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path"),
    _operations(member_router),
    ids=lambda v: v if isinstance(v, str) else str(v),
)
async def test_every_member_endpoint_is_404_when_the_flag_is_off(
    client: AsyncClient, method: str, path: str,
) -> None:
    """The member-facing router, one case per operation.

    Kept separate from the curator one for the reason the old test gave and
    which still holds: these are two APIRouter objects with two dependency
    lists, and gating one while forgetting the other is precisely the
    failure this file exists to catch.
    """
    await _assert_the_switch_covers(client, method, path)


def test_the_derived_list_is_not_empty_and_matches_the_served_api() -> None:
    """The guard that keeps the two tests above from testing nothing.

    A derived list is only better than a written one while it is populated:
    parametrising over an empty sequence produces zero cases and a green
    run, which is indistinguishable from full coverage in a summary line.

    Cross-checked against app.openapi() rather than app.routes -- see the
    section header for why the latter is empty here. The comparison is
    containment, not equality: the served API holds every other module too.
    """
    derived = set(_operations(router)) | set(_operations(member_router))
    assert derived, "no operations derived from the two school routers"

    served = {
        (method.upper(), path)
        for path, operations in app.openapi()["paths"].items()
        for method in operations
    }
    missing = derived - served
    assert not missing, f"derived but not served: {sorted(missing)}"


def test_the_module_still_exposes_exactly_two_routers() -> None:
    """A third router would make the derived list a sample again, silently.

    The two tests above walk `router` and `member_router` by name. Nothing
    stops a future delivery from adding a third APIRouter to the module
    with its own endpoints and its own -- or forgotten -- dependency, and
    the derived list would not notice. This assertion is what turns that
    into a failing test instead of a quiet gap, and it is stated as an
    identity rather than a count so that renaming one is also caught.
    """
    routers = {
        name
        for name, value in vars(curator_groups_router_module).items()
        if isinstance(value, APIRouter)
    }
    assert routers == {"router", "member_router"}, sorted(routers)


@pytest.mark.asyncio
async def test_a_route_added_to_a_school_router_joins_the_check() -> None:
    """The first twin: a new endpoint is picked up without anyone editing.

    This is the property the whole delivery is for, and it has to be shown
    rather than asserted about itself -- on a live tree the derived list is
    green both when it covers everything and when it covers nothing.

    The probe route is added to the APIRouter only. include_router copied
    its routes into the application at startup, so nothing here reaches the
    served API or the OpenAPI document, and the removal in `finally` leaves
    the object as it was either way.
    """
    async def _probe() -> None:  # pragma: no cover - never called
        return None

    before = _operations(router)
    router.add_api_route("/me/curator-groups/__probe__", _probe,
                         methods=["GET"], include_in_schema=False)
    try:
        after = _operations(router)
        assert len(after) == len(before) + 1
        assert (
            "GET",
            "/api/v1/masters/me/curator-groups/__probe__",
        ) in after
    finally:
        router.routes.pop()
    assert _operations(router) == before


@pytest.mark.asyncio
async def test_an_endpoint_without_the_dependency_fails_the_check() -> None:
    """The second twin: the assertion refuses a route the switch misses.

    Without this, a green run proves only that nothing was checked
    incorrectly -- not that an uncovered endpoint would be caught. A
    throwaway application carries one route with no killswitch dependency,
    and the same helper the two tests above use is pointed at it.

    A SEPARATE APPLICATION, NOT A ROUTE BOLTED ONTO THE REAL ONE: this app
    caches its OpenAPI document after the first call, so mounting and
    unmounting on the shared instance would leave later tests reading a
    stale schema -- including the cross-check above. Measured, not
    supposed.
    """
    naked = FastAPI()

    @naked.get("/unprotected")
    async def _unprotected() -> dict:
        return {"ok": True}

    transport = ASGITransport(app=naked)
    async with AsyncClient(
        transport=transport, base_url="http://test",
    ) as loose_client:
        with pytest.raises(AssertionError, match="with the flag OFF"):
            await _assert_the_switch_covers(
                loose_client, "GET", "/unprotected",
            )


@pytest.mark.asyncio
async def test_the_feature_answers_again_when_the_flag_returns(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The other half of the two old tests, with a name that admits it.

    SAMPLED, AND IT CANNOT BE OTHERWISE. Proving that every operation works
    under the flag needs a valid body for the five that take one and real
    state for the rest -- that is a test of the feature, which the rest of
    this suite already is. What belongs here is the narrower claim: the
    switch is a switch and not a wall, so the same school and the same
    member are reachable again the moment it goes back on.

    The school and the member exist in the database throughout the file;
    the point was never that there is nothing to find.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    student = await login_user(client, telegram_id=_TID_STUDENT)
    school = await _make_school(db_session, curator)
    await _add_member(
        db_session, school, student, CuratorMemberKind.STUDENT.value,
    )
    gid = str(school.id)

    with _on():
        curator_headers = auth_headers(curator["session_token"])
        assert (
            await client.get(GROUPS_URL, headers=curator_headers)
        ).status_code == 200
        assert (
            await client.get(
                MEMBERS_URL.format(group_id=gid), headers=curator_headers,
            )
        ).status_code == 200

        mine = await client.get(
            MINE_URL, headers=auth_headers(student["session_token"]),
        )
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
    """404 for a member: the audience layer refuses, the endpoint converts.

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
        # 404, NOT the 403 the audience gate itself raises. The detail
        # endpoint catches ForbiddenError from
        # assert_viewer_can_access_practice and re-raises NotFoundError
        # ("Practice not found", practices/service.py), so a viewer outside
        # the audience cannot even learn the practice exists. Reading the
        # gate and expecting its code here is a mistake about the LAYER --
        # what reaches the client comes from the caller above the gate.
        assert refused.status_code == 404, refused.text
        assert refused.json()["error"] == "not_found"

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
        # Three columns and no money: the price lives on the Purchase,
        # not the Booking (see bookings/models.py). Same construction as
        # test_curator_audience_advisory.py, which builds a booking for the
        # same purpose next door.
        Booking(
            user_id=UUID(booker["user"]["id"]),
            practice_id=practice.id,
            status=BookingStatus.CONFIRMED.value,
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
        # 404 for the same reason as the audience-gate test above: the
        # detail endpoint converts the gate's 403 so the practice's
        # existence is not disclosed. The pair that matters here is
        # 200-vs-404 between the booking holder and somebody without a
        # booking, not the particular refusal code.
        assert refused.status_code == 404, refused.text


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
