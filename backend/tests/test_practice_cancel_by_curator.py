# =============================================================================
# VELO -- Tests: a school CURATOR cancels a practice run by another master
# =============================================================================
#
# BE-21 / GT-25. telegram_id band: 67200-67399, declared in _TID_MIN/_TID_MAX
# ONCE -- tests/telegram_id_bands.py parses those two names.
#
# BAND PROVENANCE: re-checked against the live registry rather than trusted --
# free_windows(space=(67200, 69999)) returned [(67200, 67999), (68400, 68999),
# (69100, 69999)], so 67200-67399 was free and 67400-67999 stays free.
#
# WHAT THIS FILE PINS, and why each half exists.
#
# Until BE-21 "may cancel" and "is the master" were the same sentence, so one
# ownership check answered everything. Now there are two ways in and the
# interesting cases are the ones BETWEEN them: a master who is a curator of
# the wrong school, a curator whose practice is not a school practice, a
# curator of one of two target schools. Each of those is a separate test
# rather than a parameter, because each fails for a DIFFERENT reason and a
# parametrised failure would not say which.
#
# EVERY 404 HERE IS CHECKED FOR INDISTINGUISHABILITY, not just for the status.
# P-08 in this task protects three different secrets at once -- that the
# practice exists, that it is a school practice, and whose school it is -- and
# a distinct error CODE would leak all three while the status stayed 404. So
# the assertions compare `code` against the code a nonexistent practice
# returns, sampled in the same test rather than hardcoded.
#
# THE 403 CASES ARE HERE ON PURPOSE, and they are not P-08 violations. A
# non-master and an unverified curator are stopped by get_current_master
# before the cancel ladder runs, so they get 403 "Master access required".
# That is not a leak: it tells a person their OWN verification status, which
# they already know and which is not somebody else's secret. P-08 protects
# the existence of another master's practice and another curator's school --
# neither is disclosed by "you are not a verified master".
#
# NO db_session.expire_all() ANYWHERE IN THIS FILE, ON PURPOSE. Post-request
# reads go through fresh_execute, which opens its OWN session and therefore
# needs no help from the test's one. Calling expire_all() first is worse than
# redundant: the test session runs with expire_on_commit=False, so expiring it
# also expires the local Practice/CuratorGroup objects these tests hold, and
# the next `practice.id` becomes a lazy reload -- sync IO inside an async test,
# i.e. sqlalchemy MissingGreenlet. That is exactly how the first version of
# this file failed, in nine tests at once, all of them pointing at a `.id`.
#
# ⚠ BACKEND-ONLY, NOT RUN LOCALLY -- no docker/postgres in this environment
# (same standing caveat as test_curator_audience.py and test_cancellation.py).
# Written for the deploy battery; collection success is not passing.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import AuditLog
from app.core.events.models import OutboxEvent
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupEvent,
    CuratorGroupEventKind,
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
from tests.helpers import (
    auth_headers,
    fresh_execute,
    full_cleanup_range,
    login_user,
)

CANCEL_URL = "/api/v1/practices/{practice_id}/cancel"
BOOKINGS_URL = "/api/v1/bookings"

_TID_MIN = 67200
_TID_MAX = 67399

_TID_MASTER = 67201
_TID_CURATOR = 67202
_TID_OTHER_CURATOR = 67203
_TID_STRANGER_MASTER = 67204
_TID_STUDENT = 67210
_TID_BOOKED = 67211


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """FK-safe shared helper (TD-032), scoped to this file's own band."""
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ===========================================================================
# Local helpers -- copied, not imported, as every test file in this tree does
# ===========================================================================


async def _make_verified_master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
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
            data={"account": {"status": "verified"}, "profile": {"bio": "m"}},
        )
    )
    await db_session.flush()
    await db_session.commit()
    return auth


async def _make_plain_user(
    client: AsyncClient, telegram_id: int, first_name: str = "Student",
) -> dict:
    return await login_user(
        client, telegram_id=telegram_id, first_name=first_name,
    )


async def _unverify(db_session: AsyncSession, user_id: str) -> None:
    profile = await db_session.get(MasterProfile, UUID(user_id))
    profile.data = {**profile.data, "account": {"status": "pending"}}
    await db_session.flush()
    await db_session.commit()


async def _school(
    db_session: AsyncSession, curator_id: str, name: str = "Тихое утро",
) -> CuratorGroup:
    group = CuratorGroup(curator_user_id=UUID(curator_id), name=name)
    db_session.add(group)
    await db_session.flush()
    await db_session.commit()
    return group


async def _create_practice(
    db_session: AsyncSession,
    master_id: str,
    *,
    audience_kind: str = AudienceKind.CURATOR_GROUPS.value,
    schools: list | None = None,
    status: str = PracticeStatus.SCHEDULED.value,
    hours_from_now: float = 48,
    parent_practice_id: UUID | None = None,
    title: str = "School Practice",
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
        audience_kind=audience_kind,
        parent_practice_id=parent_practice_id,
    )
    db_session.add(practice)
    await db_session.flush()
    for school in schools or []:
        db_session.add(
            PracticeAudienceCuratorGroup(
                practice_id=practice.id, group_id=school.id,
            )
        )
        # THE MASTER JOINS THE SCHOOL, and this is not decoration.
        #
        # POST /practices refuses to publish into a school the master does
        # not belong to -- _member_curator_group_ids_or_400,
        # practices/service.py: "curator_group_ids must be active schools
        # you belong to". So a school practice whose master is an outsider
        # is a state the API cannot produce, and building one here by hand
        # would be testing a shape that does not exist.
        #
        # It also has a consequence that is invisible until something
        # books: _is_curator_group_audience_clause requires FOUR things at
        # once -- an audience row, a verified curator, the VIEWER in the
        # school, and _master_in_curator_group_clause, i.e. the master
        # being the curator or a kind='master' member with a verified
        # profile. Miss the last one and the practice has no audience at
        # all: nobody can book it, and the 403 says not_in_audience while
        # pointing at the booker.
        if school.curator_user_id != practice.master_id:
            existing = (
                await db_session.execute(
                    select(CuratorGroupMember.id).where(
                        CuratorGroupMember.group_id == school.id,
                        CuratorGroupMember.user_id == practice.master_id,
                    )
                )
            ).scalar_one_or_none()
            if existing is None:
                db_session.add(
                    CuratorGroupMember(
                        group_id=school.id,
                        user_id=practice.master_id,
                        kind=CuratorMemberKind.MASTER.value,
                    )
                )
    await db_session.flush()
    await db_session.commit()
    return practice


async def _join_school(
    db_session: AsyncSession, group_id, user_id: str,
    kind: CuratorMemberKind = CuratorMemberKind.STUDENT,
) -> CuratorGroupMember:
    row = CuratorGroupMember(
        group_id=group_id, user_id=UUID(user_id), kind=kind.value,
    )
    db_session.add(row)
    await db_session.flush()
    await db_session.commit()
    return row


async def _book(client: AsyncClient, auth: dict, practice: Practice) -> str:
    """Book through the REAL endpoint, not by inserting a Booking row.

    A hand-inserted Booking has no Purchase, and refund_booking refuses one
    (ERR-04, payments/refund.py) -- so the cancellation this file is about
    would 404 on a booking the test itself created. POST /bookings is what
    creates the pair, and it also puts the school-audience predicate in the
    path, which a raw INSERT would skip. The booker therefore has to be a
    member of the school first; see _join_school.
    """
    resp = await client.post(
        BOOKINGS_URL,
        json={"practice_id": str(practice.id)},
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _missing_practice_code(client: AsyncClient, token: str) -> str:
    """The error code a practice that does not exist returns, sampled live.

    Sampled rather than hardcoded on purpose: this is the baseline every
    other 404 in this file is compared against, and hardcoding it would let
    the baseline and the real answer drift apart without a test noticing --
    which is precisely the drift P-08 is guarding.
    """
    resp = await client.post(
        CANCEL_URL.format(practice_id=uuid4()),
        headers=auth_headers(token),
    )
    assert resp.status_code == 404
    return resp.json()["error"]


async def _outbox_types_for(user_id: str) -> list[str]:
    """Notification types queued FOR ONE USER, not for the whole database.

    The outbox is append-only and shared by the entire suite: an unfiltered
    select returns every notification any test ever queued. The first
    version of this helper did exactly that and asserted "exactly one
    practice.cancelled" against 65 of them, most belonging to other files.

    Filtering by data->>'target_value' is the same access path
    full_cleanup_range uses to delete this band's rows (tests/helpers.py) --
    the notification_request payload carries its target there and nowhere
    else. Which also explains why the sibling assertion on
    practice.cancelled_by_curator passed while this one did not: that type
    is emitted only by this file, so the band cleanup happened to leave
    exactly one. It was right by accident, and is now right on purpose.
    """
    rows = (
        await fresh_execute(
            select(OutboxEvent).where(
                OutboxEvent.payload["target_value"].astext == str(user_id),
            )
        )
    ).scalars().all()
    return [(row.payload or {}).get("type", "") for row in rows]


# ===========================================================================
# 1. The right itself
# ===========================================================================


@pytest.mark.asyncio
async def test_curator_cancels_a_practice_run_by_another_master(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The whole point: someone who is not the master cancels, and it works.

    Paired with the state of the practice afterwards, not just the status
    code -- a 200 that left the practice scheduled would be worse than a
    refusal, because the curator would believe the session is gone.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    practice = await _create_practice(
        db_session, master["user"]["id"], schools=[school],
    )

    resp = await client.post(
        CANCEL_URL.format(practice_id=practice.id),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200

    fresh = (await fresh_execute(
        select(Practice).where(Practice.id == practice.id),
    )).scalar_one()
    assert fresh.status == PracticeStatus.CANCELLED.value


@pytest.mark.asyncio
async def test_master_still_cancels_his_own_school_practice(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The old way in did not close when the new one opened."""
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    practice = await _create_practice(
        db_session, master["user"]["id"], schools=[school],
    )

    resp = await client.post(
        CANCEL_URL.format(practice_id=practice.id),
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_curator_of_one_of_two_target_schools_may_cancel(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A practice can be published to several schools; one curator is enough.

    The second school is not decoration -- without it the test would pass
    against an implementation that only ever looks at a single audience row.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    other = await _make_verified_master(
        client, db_session, _TID_OTHER_CURATOR,
    )
    mine = await _school(db_session, curator["user"]["id"], name="Моя")
    theirs = await _school(db_session, other["user"]["id"], name="Чужая")
    practice = await _create_practice(
        db_session, master["user"]["id"], schools=[theirs, mine],
    )

    resp = await client.post(
        CANCEL_URL.format(practice_id=practice.id),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200


# ===========================================================================
# 2. Everyone else -- and every 404 indistinguishable from "no such practice"
# ===========================================================================


@pytest.mark.asyncio
async def test_curator_of_a_different_school_gets_the_missing_practice_answer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """404, and the SAME code a nonexistent practice returns.

    Status alone is not the assertion. A code like `curator_not_entitled`
    would keep the 404 and still tell the caller that the practice exists
    and that the only thing missing is their school -- the exact fact P-08
    is keeping.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    outsider = await _make_verified_master(
        client, db_session, _TID_OTHER_CURATOR,
    )
    school = await _school(db_session, curator["user"]["id"])
    await _school(db_session, outsider["user"]["id"], name="Другая")
    practice = await _create_practice(
        db_session, master["user"]["id"], schools=[school],
    )

    baseline = await _missing_practice_code(
        client, outsider["session_token"],
    )
    resp = await client.post(
        CANCEL_URL.format(practice_id=practice.id),
        headers=auth_headers(outsider["session_token"]),
    )
    assert resp.status_code == 404
    assert resp.json()["error"] == baseline

    fresh = (await fresh_execute(
        select(Practice).where(Practice.id == practice.id),
    )).scalar_one()
    assert fresh.status == PracticeStatus.SCHEDULED.value


@pytest.mark.asyncio
async def test_public_practice_of_the_same_master_is_not_the_curators(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Curating a school is not a right over that master's other practices."""
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    await _school(db_session, curator["user"]["id"])
    practice = await _create_practice(
        db_session, master["user"]["id"],
        audience_kind=AudienceKind.PUBLIC.value, schools=[],
    )

    baseline = await _missing_practice_code(client, curator["session_token"])
    resp = await client.post(
        CANCEL_URL.format(practice_id=practice.id),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 404
    assert resp.json()["error"] == baseline


@pytest.mark.asyncio
async def test_school_practice_with_no_audience_rows_is_nobodys(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """audience_kind says school, but no school is addressed.

    Reachable in production: deleting a school cascades its audience rows
    away and leaves the practice's audience_kind untouched. The right must
    come from the ROWS, not from the kind -- if it came from the kind, every
    curator in the system would inherit this practice.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    await _school(db_session, curator["user"]["id"])
    practice = await _create_practice(
        db_session, master["user"]["id"], schools=[],
    )

    baseline = await _missing_practice_code(client, curator["session_token"])
    resp = await client.post(
        CANCEL_URL.format(practice_id=practice.id),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 404
    assert resp.json()["error"] == baseline


@pytest.mark.asyncio
async def test_master_with_no_school_at_all_gets_the_same_answer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The pre-BE-21 case, unchanged, asserted against the same baseline."""
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    stranger = await _make_verified_master(
        client, db_session, _TID_STRANGER_MASTER,
    )
    school = await _school(db_session, curator["user"]["id"])
    practice = await _create_practice(
        db_session, master["user"]["id"], schools=[school],
    )

    baseline = await _missing_practice_code(client, stranger["session_token"])
    resp = await client.post(
        CANCEL_URL.format(practice_id=practice.id),
        headers=auth_headers(stranger["session_token"]),
    )
    assert resp.status_code == 404
    assert resp.json()["error"] == baseline


@pytest.mark.asyncio
async def test_a_school_member_who_is_not_a_master_is_stopped_at_the_door(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """403, not 404, and that is correct -- see this file's header.

    get_current_master answers before the cancel ladder runs. The 403 says
    "you are not a verified master", a fact about the caller themselves;
    P-08 protects other people's practices and other people's schools, and
    neither is disclosed here. Asserting 404 would be asserting a behaviour
    this endpoint does not have and would quietly demand a change to a
    dependency shared by every master endpoint.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    practice = await _create_practice(
        db_session, master["user"]["id"], schools=[school],
    )
    student = await _make_plain_user(client, _TID_STUDENT)

    resp = await client.post(
        CANCEL_URL.format(practice_id=practice.id),
        headers=auth_headers(student["session_token"]),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_curator_who_lost_verification_loses_the_lever(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A school is alive only while its curator is verified NOW (I-6).

    Also 403 rather than 404, and for the same reason as the test above: an
    unverified master never reaches the ladder. The paired half is what
    matters here -- the practice must still be scheduled afterwards, which
    is what proves the request was refused rather than silently accepted.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    practice = await _create_practice(
        db_session, master["user"]["id"], schools=[school],
    )
    await _unverify(db_session, curator["user"]["id"])

    resp = await client.post(
        CANCEL_URL.format(practice_id=practice.id),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 403

    fresh = (await fresh_execute(
        select(Practice).where(Practice.id == practice.id),
    )).scalar_one()
    assert fresh.status == PracticeStatus.SCHEDULED.value


# ===========================================================================
# 3. Scope -- the cascade stays master-only (item 2)
# ===========================================================================


@pytest.mark.asyncio
async def test_curator_is_refused_the_series_cascade(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """400 with its own code, and the later occurrence survives.

    The code is distinct here, unlike every 404 above, and the difference is
    not an inconsistency: by the time this fires the caller has already been
    told the practice exists (they are entitled to cancel it), so there is
    no secret left to keep and the frontend needs to say something true.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    root = await _create_practice(
        db_session, master["user"]["id"], schools=[school],
        hours_from_now=48,
    )
    later = await _create_practice(
        db_session, master["user"]["id"], schools=[school],
        hours_from_now=72, parent_practice_id=root.id,
    )

    resp = await client.post(
        CANCEL_URL.format(practice_id=root.id),
        headers=auth_headers(curator["session_token"]),
        json={"scope": "this_and_future"},
    )
    assert resp.status_code == 400
    assert resp.json()["error"] == "curator_cannot_cancel_series"

    for pid in (root.id, later.id):
        fresh = (await fresh_execute(
            select(Practice).where(Practice.id == pid),
        )).scalar_one()
        assert fresh.status == PracticeStatus.SCHEDULED.value


@pytest.mark.asyncio
async def test_curator_cannot_reach_another_masters_series_at_all(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The C2 hole, from the curator's side.

    The setup that matters: the series root belongs to ANOTHER MASTER and is
    published to the curator's school, so the curator is genuinely entitled
    to cancel that one occurrence. An attacker then points their own,
    unrelated practice at that root -- parent_practice_id is client-writable
    -- and hopes a curator's cascade walks the tree and refunds it.

    The refusal fires before the sibling query runs, so both the root and
    the forged child survive. Both are asserted: "the cascade was refused"
    and "the cascade ran and found nothing" are indistinguishable from the
    status code alone, and only the second would be a hole.

    The first version of this test made the ROOT the curator's own practice,
    which made him the owner -- the cascade was allowed, the endpoint
    answered 200, and the test caught its own setup rather than the code.
    """
    victim = await _make_verified_master(client, db_session, _TID_MASTER)
    attacker = await _make_verified_master(
        client, db_session, _TID_STRANGER_MASTER,
    )
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    root = await _create_practice(
        db_session, victim["user"]["id"], schools=[school],
        hours_from_now=24, title="Практика школы",
    )
    root_id = root.id
    forged = await _create_practice(
        db_session, attacker["user"]["id"], schools=[],
        audience_kind=AudienceKind.PUBLIC.value, hours_from_now=72,
        parent_practice_id=root_id, title="Подкладка",
    )
    forged_id = forged.id

    resp = await client.post(
        CANCEL_URL.format(practice_id=root_id),
        headers=auth_headers(curator["session_token"]),
        json={"scope": "this_and_future"},
    )
    assert resp.status_code == 400
    assert resp.json()["error"] == "curator_cannot_cancel_series"

    for pid in (root_id, forged_id):
        fresh = (await fresh_execute(
            select(Practice).where(Practice.id == pid),
        )).scalar_one()
        assert fresh.status == PracticeStatus.SCHEDULED.value


# ===========================================================================
# 4. What the cancellation writes down (items 3, 5, 6)
# ===========================================================================


@pytest.mark.asyncio
async def test_audit_says_curator_not_master(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The audit row distinguishes the two actors by EVENT, not by data.

    Paired: the curator's event exists AND the master's event does not. Only
    the first half would pass in an implementation that wrote both.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    practice = await _create_practice(
        db_session, master["user"]["id"], schools=[school],
    )

    resp = await client.post(
        CANCEL_URL.format(practice_id=practice.id),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200

    rows = (await fresh_execute(
        select(AuditLog).where(AuditLog.target_id == practice.id),
    )).scalars().all()
    events = [row.event for row in rows]
    assert "practice_cancelled_by_curator" in events
    assert "practice_cancelled_by_master" not in events

    row = next(r for r in rows if r.event == "practice_cancelled_by_curator")
    assert row.actor_id == UUID(curator["user"]["id"])
    assert row.data["group_ids"] == [str(school.id)]


@pytest.mark.asyncio
async def test_the_master_is_told_and_never_tells_himself(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """item 5, both halves in one place because they are one rule.

    A curator cancelling produces practice.cancelled_by_curator aimed at the
    practice's master; the same master cancelling his own practice produces
    none. Both halves are counted against the MASTER's own queue: one after
    the curator's cancel, and still one -- not two -- after his own. Asserting
    only the first would pass against an implementation that notifies on
    every cancellation, which is the mistake the rule exists to prevent: a
    master emailing himself about his own click.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    by_curator = await _create_practice(
        db_session, master["user"]["id"], schools=[school], title="A",
    )
    by_master = await _create_practice(
        db_session, master["user"]["id"], schools=[school], title="B",
    )

    await client.post(
        CANCEL_URL.format(practice_id=by_curator.id),
        headers=auth_headers(curator["session_token"]),
    )
    after_curator = await _outbox_types_for(master["user"]["id"])
    assert after_curator.count("practice.cancelled_by_curator") == 1

    await client.post(
        CANCEL_URL.format(practice_id=by_master.id),
        headers=auth_headers(master["session_token"]),
    )
    after_master = await _outbox_types_for(master["user"]["id"])
    assert after_master.count("practice.cancelled_by_curator") == 1


@pytest.mark.asyncio
async def test_participants_are_still_told_and_the_count_did_not_move(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """item 5's other half: the audience of practice.cancelled is unchanged.

    One booked user, one practice.cancelled -- not two, and not zero. The
    new master-facing type must sit BESIDE the participant fan-out, not
    replace it or double it.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    booked = await _make_plain_user(client, _TID_BOOKED)
    school = await _school(db_session, curator["user"]["id"])
    practice = await _create_practice(
        db_session, master["user"]["id"], schools=[school],
    )
    await _join_school(db_session, school.id, booked["user"]["id"])
    await _book(client, booked, practice)

    resp = await client.post(
        CANCEL_URL.format(practice_id=practice.id),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200

    types = await _outbox_types_for(booked["user"]["id"])
    assert types.count("practice.cancelled") == 1


@pytest.mark.asyncio
async def test_the_school_journal_records_it_in_the_same_transaction(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """item 6: one journal row, in the actor's school, with the actor's name.

    "Same transaction" is asserted by its consequence rather than by
    instrumentation: the practice is cancelled AND the row exists. The
    inverse -- a refused cancellation leaving no row -- is the test below.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    curator = await _make_verified_master(
        client, db_session, _TID_CURATOR, first_name="Мария",
    )
    school = await _school(db_session, curator["user"]["id"])
    practice = await _create_practice(
        db_session, master["user"]["id"], schools=[school],
    )

    resp = await client.post(
        CANCEL_URL.format(practice_id=practice.id),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200

    rows = (await fresh_execute(
        select(CuratorGroupEvent).where(
            CuratorGroupEvent.group_id == school.id,
            CuratorGroupEvent.event
            == CuratorGroupEventKind.PRACTICE_CANCELLED.value,
        ),
    )).scalars().all()
    assert len(rows) == 1
    assert rows[0].data["practice_id"] == str(practice.id)
    assert rows[0].data["actor_name"]


@pytest.mark.asyncio
async def test_a_refused_cancellation_leaves_no_journal_row(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The journal must not report things that did not happen.

    A curator asks for the cascade, is refused, and the school's journal is
    untouched -- paired with the previous test's "one row on success", so
    neither an always-write nor a never-write implementation passes both.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    root = await _create_practice(
        db_session, master["user"]["id"], schools=[school],
    )

    resp = await client.post(
        CANCEL_URL.format(practice_id=root.id),
        headers=auth_headers(curator["session_token"]),
        json={"scope": "this_and_future"},
    )
    assert resp.status_code == 400

    rows = (await fresh_execute(
        select(CuratorGroupEvent).where(
            CuratorGroupEvent.group_id == school.id,
        ),
    )).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_only_the_actors_school_gets_a_journal_row(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The known gap, pinned as a decision rather than left to be found.

    A practice published to two schools is cancelled by the curator of one.
    The other school loses the practice with nothing in its journal saying
    so -- because it did not do it, and writing somebody else's action into
    its history would be worse than the silence. This test exists so that a
    future change to that rule is a deliberate edit rather than a surprise.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    other = await _make_verified_master(
        client, db_session, _TID_OTHER_CURATOR,
    )
    mine = await _school(db_session, curator["user"]["id"], name="Моя")
    theirs = await _school(db_session, other["user"]["id"], name="Чужая")
    practice = await _create_practice(
        db_session, master["user"]["id"], schools=[mine, theirs],
    )

    await client.post(
        CANCEL_URL.format(practice_id=practice.id),
        headers=auth_headers(curator["session_token"]),
    )

    mine_rows = (await fresh_execute(
        select(CuratorGroupEvent).where(CuratorGroupEvent.group_id == mine.id),
    )).scalars().all()
    theirs_rows = (await fresh_execute(
        select(CuratorGroupEvent).where(
            CuratorGroupEvent.group_id == theirs.id,
        ),
    )).scalars().all()
    assert len(mine_rows) == 1
    assert theirs_rows == []


# ===========================================================================
# 5. Three axes on the two inputs this delivery touches
# ===========================================================================


@pytest.mark.asyncio
async def test_scope_axes_empty_repeat_and_short(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """PUSTOTA / POVTOR / NEHVATKA on the scope body, for a CURATOR.

    Emptiness must land on "this" (the historical default) rather than on
    the refusal, or a curator with no body would be told he cannot cancel
    series he never asked about. A repeated key resolves to the LAST value
    by JSON parsing, so the refusal is what a duplicated scope must produce
    -- asserted rather than assumed. A short/unknown value is rejected
    before the entitlement is even consulted.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    empty = await _create_practice(
        db_session, master["user"]["id"], schools=[school], title="empty",
    )
    repeat = await _create_practice(
        db_session, master["user"]["id"], schools=[school], title="repeat",
    )
    short = await _create_practice(
        db_session, master["user"]["id"], schools=[school], title="short",
    )
    token = auth_headers(curator["session_token"])

    # PUSTOTA -- no body at all.
    assert (await client.post(
        CANCEL_URL.format(practice_id=empty.id), headers=token,
    )).status_code == 200

    # POVTOR -- the key twice; the last one wins and is refused.
    resp = await client.post(
        CANCEL_URL.format(practice_id=repeat.id),
        headers={**token, "Content-Type": "application/json"},
        content='{"scope": "this", "scope": "this_and_future"}',
    )
    assert resp.status_code == 400
    assert resp.json()["error"] == "curator_cannot_cancel_series"

    # NEHVATKA -- a value that is neither.
    assert (await client.post(
        CANCEL_URL.format(practice_id=short.id), headers=token,
        json={"scope": "future"},
    )).status_code in (400, 422)


@pytest.mark.asyncio
async def test_practice_id_axes_repeat_and_missing(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """POVTOR / PUSTOTA on the practice id, from the curator's side.

    Cancelling twice must not refund twice: the second call meets a
    practice that is already cancelled and is refused by status, not by
    entitlement -- 400, not 404, because the curator IS entitled and
    hiding that now would contradict the first call's 200.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    practice = await _create_practice(
        db_session, master["user"]["id"], schools=[school],
    )
    token = auth_headers(curator["session_token"])

    first = await client.post(
        CANCEL_URL.format(practice_id=practice.id), headers=token,
    )
    assert first.status_code == 200
    second = await client.post(
        CANCEL_URL.format(practice_id=practice.id), headers=token,
    )
    assert second.status_code == 400

    # PUSTOTA -- an id that names nothing.
    missing = await client.post(
        CANCEL_URL.format(practice_id=uuid4()), headers=token,
    )
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_a_completed_school_practice_is_refused_by_status(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Entitlement first, status second -- and the curator sees the status.

    A completed practice returns 400, not 404: the curator is entitled, so
    there is nothing to hide, and telling him "already finished" is the
    only answer that lets him stop looking for the button.
    """
    master = await _make_verified_master(client, db_session, _TID_MASTER)
    curator = await _make_verified_master(client, db_session, _TID_CURATOR)
    school = await _school(db_session, curator["user"]["id"])
    practice = await _create_practice(
        db_session, master["user"]["id"], schools=[school],
        status=PracticeStatus.COMPLETED.value, hours_from_now=-48,
    )

    resp = await client.post(
        CANCEL_URL.format(practice_id=practice.id),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 400
