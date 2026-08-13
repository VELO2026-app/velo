# =============================================================================
# VELO Backend -- Tests: student ENTITLEMENT vs student DISPLAY (T-20)
# =============================================================================
#
# telegram_id band: 99100-99149. Declared here per the band convention.
# Verified free before taking it: no test in tests/ references any id in
# 99000-99299 (checked as literals, not as declared ranges). Deliberately
# NOT in the 89xxx space -- 89441-89899 is the comms T1 window and a second,
# repo-invisible registry lives on that side (see test_chats_t3_students.py's
# header for what that cost last time).
#
# WHAT THIS FILE LOCKS (owner ruling 2026-08-13): the word "student" names
# TWO different things, and they are SPLIT.
#
#   RIGHT   -- who may ENTER an audience_kind=students practice. NARROW:
#              practices/audience_service.STUDENT_ENTITLEMENT_STATUSES =
#              {CONFIRMED, ATTENDED, NO_SHOW}. PENDING is an intent, not an
#              entitlement. NO_SHOW deliberately KEEPS the right -- the
#              person was a student; missing one session does not revoke it.
#   DISPLAY -- who a master SEES in their students list / can open a CRM
#              card for. WIDE (any non-cancelled booking, unblocked):
#              masters/groups_service._derived_students_base. UNCHANGED by
#              T-20; widening the display SOURCES is T-37, not here.
#
# The two tests that matter most are the ones that would look like bugs if
# you believed "student" meant one thing:
#   - a PENDING-only booker is REFUSED by the gate but still LISTED and
#     still has an openable CRM card (test_display_stays_wide_...);
#   - a NO_SHOW booker is ADMITTED by the gate.
#
# ⚠ BACKEND-ONLY, UNPROVEN LOCALLY -- no Postgres reachable in this
# environment and app.core.config does not import here (backend/.env sets
# REDIS_PASSWORD, which Settings forbids), so pytest cannot even collect
# from the backend directory. Same posture as test_practice_audience.py:
# written to be read and to run in CI; never executed via pytest this
# session.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.masters.models import MasterProfile
from app.modules.practices.audience_service import STUDENT_ENTITLEMENT_STATUSES
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeStatus,
    PracticeType,
)
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

PRACTICES_URL = "/api/v1/practices"
BOOKINGS_URL = "/api/v1/bookings"
DERIVED_MEMBERS_URL = "/api/v1/masters/me/groups/students/members"
STUDENT_DETAIL_URL = "/api/v1/masters/me/students/{student_id}"

_TID_MIN = 99100
_TID_MAX = 99149


# ===================================================================
# Cleanup
# ===================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ===================================================================
# Helpers (own module -- mirrors test_practice_audience.py's shapes)
# ===================================================================


async def _make_verified_master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> dict:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Master")
    user_id = auth["user"]["id"]
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
    return auth


async def _practice(
    db_session: AsyncSession,
    master_id: str,
    *,
    audience_kind: str = AudienceKind.PUBLIC.value,
    hours_from_now: float = 48,
    status: str = PracticeStatus.SCHEDULED.value,
) -> Practice:
    practice = Practice(
        master_id=master_id,
        title="T20 Practice",
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
    )
    db_session.add(practice)
    await db_session.flush()
    return practice


async def _booking(
    db_session: AsyncSession, user_id: str, practice_id, status: str,
) -> Booking:
    booking = Booking(
        practice_id=practice_id, user_id=user_id, status=status,
    )
    db_session.add(booking)
    await db_session.flush()
    return booking


def _ids(resp_json: dict) -> set[str]:
    return {item["id"] for item in resp_json["items"]}


async def _history_and_target(
    client: AsyncClient,
    db_session: AsyncSession,
    *,
    master_tid: int,
    student_tid: int,
    history_status: str,
) -> tuple[dict, dict, Practice]:
    """Build the whole T-20 fixture in one shot.

    A master with TWO practices: a PAST one the student holds a booking on
    in `history_status` (the only relationship they have with this master),
    and a FUTURE students-only one -- the thing the gate protects.

    Returns (master_auth, student_auth, students_only_practice).
    """
    master = await _make_verified_master(client, db_session, master_tid)
    master_id = master["user"]["id"]

    past = await _practice(
        db_session, master_id,
        hours_from_now=-72,
        status=PracticeStatus.COMPLETED.value,
    )
    students_only = await _practice(
        db_session, master_id, audience_kind=AudienceKind.STUDENTS.value,
    )

    student = await login_user(
        client, telegram_id=student_tid, first_name="Student",
    )
    await _booking(db_session, student["user"]["id"], past.id, history_status)
    await db_session.commit()

    return master, student, students_only


# ===================================================================
# The set itself
# ===================================================================


def test_entitlement_set_membership_is_exactly_the_ruling() -> None:
    """The set is the deliverable, so assert it directly rather than only
    through five HTTP round-trips. NO_SHOW in, PENDING out."""
    expected = {
        BookingStatus.CONFIRMED.value,
        BookingStatus.ATTENDED.value,
        BookingStatus.NO_SHOW.value,
    }
    assert expected == STUDENT_ENTITLEMENT_STATUSES
    assert BookingStatus.PENDING.value not in STUDENT_ENTITLEMENT_STATUSES
    assert BookingStatus.CANCELLED.value not in STUDENT_ENTITLEMENT_STATUSES


def test_entitlement_set_is_not_the_zoom_set() -> None:
    """Guards the ONE thing a well-meaning future cleanup would do: notice
    that two status sets sit near each other and alias them. They answer
    different questions -- per-master entitlement vs per-practice zoom-link
    visibility -- and NO_SHOW belongs to exactly one of them. Aliasing would
    hand a live meeting link to every no-show.
    """
    from app.modules.practices.service import ZOOM_VISIBLE_BOOKING_STATUSES

    assert STUDENT_ENTITLEMENT_STATUSES != ZOOM_VISIBLE_BOOKING_STATUSES
    assert BookingStatus.NO_SHOW.value not in ZOOM_VISIBLE_BOOKING_STATUSES


# ===================================================================
# THE RIGHT -- the students-only gate, one case per booking status
# ===================================================================


@pytest.mark.parametrize(
    ("history_status", "master_tid", "student_tid", "admitted"),
    [
        (BookingStatus.CONFIRMED.value, 99100, 99101, True),
        (BookingStatus.ATTENDED.value, 99102, 99103, True),
        # The deliberate one: absence does not revoke entitlement.
        (BookingStatus.NO_SHOW.value, 99104, 99105, True),
        # T-20's actual narrowing: PENDING used to pass here.
        (BookingStatus.PENDING.value, 99106, 99107, False),
        (BookingStatus.CANCELLED.value, 99108, 99109, False),
    ],
)
@pytest.mark.asyncio
async def test_students_gate_admits_exactly_the_entitlement_statuses(
    client: AsyncClient,
    db_session: AsyncSession,
    history_status: str,
    master_tid: int,
    student_tid: int,
    admitted: bool,
) -> None:
    """One booking with this master, in `history_status`, and nothing else.
    Both enforcement points must agree: the SQL feed filter
    (viewer_audience_clause, listing_service.py) and the per-practice raise
    (assert_viewer_can_access_practice, reached from create_booking).
    """
    _master, student, students_only = await _history_and_target(
        client, db_session,
        master_tid=master_tid,
        student_tid=student_tid,
        history_status=history_status,
    )
    headers = auth_headers(student["session_token"])

    feed = await client.get(PRACTICES_URL, headers=headers)
    assert feed.status_code == 200
    assert (str(students_only.id) in _ids(feed.json())) is admitted

    booked = await client.post(
        BOOKINGS_URL, json={"practice_id": str(students_only.id)}, headers=headers,
    )
    if admitted:
        assert booked.status_code == 201
    else:
        assert booked.status_code == 403
        assert booked.json()["error"] == "not_a_student"


@pytest.mark.asyncio
async def test_pending_booking_on_the_target_practice_is_not_self_admitting(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The nastier shape of the same hole: the PENDING booking sits on the
    students-only practice ITSELF. Under the old `!= CANCELLED` rule such a
    row made its own holder a "student" of that master, so a single
    status-less INSERT would have bootstrapped access to that practice and
    to every other students-only practice by the same master. Booking.status
    still carries default=PENDING AND server_default=PENDING
    (bookings/models.py), so this stays a live shape even though no code
    path writes PENDING today.
    """
    master = await _make_verified_master(client, db_session, 99110)
    students_only = await _practice(
        db_session, master["user"]["id"],
        audience_kind=AudienceKind.STUDENTS.value,
    )
    student = await login_user(client, telegram_id=99111, first_name="Pending")
    await _booking(
        db_session,
        student["user"]["id"],
        students_only.id,
        BookingStatus.PENDING.value,
    )
    await db_session.commit()

    feed = await client.get(
        PRACTICES_URL, headers=auth_headers(student["session_token"]),
    )
    assert feed.status_code == 200
    assert str(students_only.id) not in _ids(feed.json())


# ===================================================================
# THE SPLIT -- narrow right, wide display, on ONE person
# ===================================================================


@pytest.mark.asyncio
async def test_display_stays_wide_while_the_entitlement_is_narrow(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The whole ruling on one user, asserted together on purpose.

    A PENDING-only booker is:
      - REFUSED by the students-only gate (the narrow RIGHT), and
      - still LISTED in the master's derived «Ученики» group, and
      - still has an OPENABLE CRM card (the wide DISPLAY).

    Read as three separate expectations that looks like an inconsistency;
    it is the design. If a later change makes the list and the gate agree
    by narrowing DISPLAY, this test fails -- which is the point, because
    display is a contact list and narrowing it silently loses people from
    the master's screen.
    """
    master, student, students_only = await _history_and_target(
        client, db_session,
        master_tid=99112,
        student_tid=99113,
        history_status=BookingStatus.PENDING.value,
    )
    student_id = student["user"]["id"]
    master_headers = auth_headers(master["session_token"])

    # RIGHT: narrow.
    refused = await client.post(
        BOOKINGS_URL,
        json={"practice_id": str(students_only.id)},
        headers=auth_headers(student["session_token"]),
    )
    assert refused.status_code == 403
    assert refused.json()["error"] == "not_a_student"

    # DISPLAY: wide -- the master still sees them in «Ученики».
    listed = await client.get(DERIVED_MEMBERS_URL, headers=master_headers)
    assert listed.status_code == 200
    assert student_id in {item["id"] for item in listed.json()["items"]}

    # DISPLAY: wide -- and the card the list links to actually opens.
    # (P6/PROMPT №609 already made list and card agree; asserted here so a
    # T-20-shaped narrowing of the GATE can never be mistaken for licence
    # to narrow the CARD back to ATTENDED-only and resurrect the 404.)
    card = await client.get(
        STUDENT_DETAIL_URL.format(student_id=student_id), headers=master_headers,
    )
    assert card.status_code == 200
    # ...with its attended-only aggregates honestly empty, NOT widened.
    body = card.json()
    assert body["practices_count"] == 0
    assert body["hours"] == 0
    assert body["satisfaction_pct"] is None
    assert body["recent_checkins"] == []
    assert body["feedbacks"] == []
