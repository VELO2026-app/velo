# =============================================================================
# VELO Backend -- Tests: Master Students (E5, CRM aggregate)
# =============================================================================
#
# telegram_id range: 91000-91999
#
# Coverage:
#   GET /masters/me/students
#     - lists users with >= 1 attended booking; non-attended excluded
#     - practices_count = attended practices
#     - needs_attention = latest feedback in confused bucket (<= 3); latest wins
#     - name search; offset/limit pagination
#     - requires verified master (403) / no auth (401)
#   GET /masters/me/students/{id}
#     - practices_count, hours, satisfaction_pct, recent_checkins, feedbacks
#     - satisfaction_pct null when no feedback
#     - P6 (PROMPT №609, owner-ruled widen): opens for a non-cancelled
#       (not-yet-attended) booking, and for a custom-group member with NO
#       booking at all -- both degrade to honest zero/empty aggregates.
#       Still 404s for a real stranger (no booking of any status, no
#       group membership) -- proves the gate was widened, not removed.
#     - T24-20 (PROMPT №638): a master's OWN blocked student now opens too
#       (narrow allow-path, separate from is_master_audience_member) --
#       response carries blocked=True/False.
#     - T-37 (PROMPT №706): a chat-only contact (no booking, no group
#       membership) also opens -- this file's own code is UNCHANGED; the
#       gate widened because groups_service.is_master_audience_member did.
#       Proves the cross-module effect, not a change to this module.
#     - T-37 amendment (PROMPT №707, 2026-08-14): a cancelled-only-booking
#       contact also opens, for the same cross-module reason. practices_count
#       stays 0 -- this module's ATTENDED-only aggregate was never touched.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.chats.models import ChatThread
from app.modules.diary.models import Checkin, CheckType, Feedback
from app.modules.masters.groups_models import MasterGroup, MasterGroupMembership
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

STUDENTS_URL = "/api/v1/masters/me/students"
STUDENT_DETAIL_URL = "/api/v1/masters/me/students/{student_id}"
BLOCK_URL = "/api/v1/masters/me/students/{student_id}/block"

_TID_MIN = 91000
_TID_MAX = 91999


# ===================================================================
# Cleanup
# ===================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean test data before/after each test, FK-safe.

    Switched to the shared full_cleanup_range (P6, PROMPT №609) instead of
    this file's own ad-hoc delete list -- the new group-membership tests
    below are the first in this file to touch master_group/
    master_group_membership, which the old hand-rolled list never knew
    about. full_cleanup_range is a strict superset of what the old list
    covered (same tables plus groups/ledgers/etc.), so nothing here loses
    coverage.
    """
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)


# ===================================================================
# Helpers
# ===================================================================


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
) -> dict:
    """Create a verified master and return the auth dict."""
    auth = await login_user(client, telegram_id=telegram_id, first_name="Master")
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
    return auth


async def _create_completed_practice(
    db_session: AsyncSession,
    master_id: str,
    *,
    duration_minutes: int = 60,
) -> Practice:
    """Create a completed practice owned by master_id."""
    practice = Practice(
        master_id=master_id,
        title="Students Practice",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=PracticeStatus.COMPLETED.value,
        scheduled_at=datetime.now(UTC) - timedelta(hours=3),
        duration_minutes=duration_minutes,
        timezone="UTC",
        max_participants=20,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
    )
    db_session.add(practice)
    await db_session.flush()
    return practice


async def _attend(
    client: AsyncClient,
    db_session: AsyncSession,
    practice: Practice,
    telegram_id: int,
    *,
    first_name: str | None = None,
    status: str = BookingStatus.ATTENDED.value,
) -> tuple[str, Booking]:
    """Log a user in and create a booking (default attended) on `practice`.

    Returns (user_id, booking). One user can be reused across practices by
    passing the SAME telegram_id (login_user upserts by telegram_id).
    """
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=first_name or f"U{telegram_id}",
    )
    user_id = auth["user"]["id"]
    booking = Booking(
        practice_id=practice.id,
        user_id=user_id,
        status=status,
        joined_at=datetime.now(UTC) - timedelta(hours=2),
    )
    db_session.add(booking)
    await db_session.flush()
    return user_id, booking


async def _add_feedback(
    db_session: AsyncSession,
    practice: Practice,
    user_id: str,
    booking: Booking,
    *,
    rating: int,
    comment: str | None = None,
    created_at: datetime | None = None,
) -> None:
    fb = Feedback(
        practice_id=practice.id,
        user_id=user_id,
        booking_id=booking.id,
        rating=rating,
        comment=comment,
    )
    if created_at is not None:
        fb.created_at = created_at
    db_session.add(fb)
    await db_session.flush()


async def _add_checkin(
    db_session: AsyncSession,
    practice: Practice,
    user_id: str,
    booking: Booking,
    *,
    mood: int,
    comment: str | None = None,
) -> None:
    ci = Checkin(
        practice_id=practice.id,
        user_id=user_id,
        booking_id=booking.id,
        mood=mood,
        comment=comment,
        check_type=CheckType.PRE.value,
    )
    db_session.add(ci)
    await db_session.flush()


# ===================================================================
# GET /masters/me/students -- list
# ===================================================================


@pytest.mark.asyncio
async def test_students_list_basic(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Lists users with an attended booking; one item per student."""
    master = await _make_verified_master(client, db_session, telegram_id=91900)
    practice = await _create_completed_practice(db_session, master["user"]["id"])

    await _attend(client, db_session, practice, 91001, first_name="Alice")
    await _attend(client, db_session, practice, 91002, first_name="Bob")
    await db_session.commit()

    resp = await client.get(STUDENTS_URL, headers=auth_headers(master["session_token"]))
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 2
    names = {it["name"] for it in data["items"]}
    assert names == {"Alice", "Bob"}
    item = data["items"][0]
    assert set(item.keys()) == {
        "id", "name", "avatar_url", "practices_count", "needs_attention",
    }
    assert item["practices_count"] == 1


@pytest.mark.asyncio
async def test_students_practices_count(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """practices_count reflects how many of the master's practices they attended."""
    master = await _make_verified_master(client, db_session, telegram_id=91901)
    mid = master["user"]["id"]
    p1 = await _create_completed_practice(db_session, mid)
    p2 = await _create_completed_practice(db_session, mid)

    # Same student (same telegram_id) attends both.
    await _attend(client, db_session, p1, 91010, first_name="Multi")
    await _attend(client, db_session, p2, 91010, first_name="Multi")
    await db_session.commit()

    resp = await client.get(STUDENTS_URL, headers=auth_headers(master["session_token"]))
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["practices_count"] == 2


@pytest.mark.asyncio
async def test_students_excludes_non_attended(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A confirmed-but-not-attended booking does not make a student."""
    master = await _make_verified_master(client, db_session, telegram_id=91902)
    practice = await _create_completed_practice(db_session, master["user"]["id"])

    await _attend(client, db_session, practice, 91020, first_name="Real", status=BookingStatus.ATTENDED.value)
    await _attend(client, db_session, practice, 91021, first_name="Ghost", status=BookingStatus.CONFIRMED.value)
    await db_session.commit()

    resp = await client.get(STUDENTS_URL, headers=auth_headers(master["session_token"]))
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["name"] == "Real"


@pytest.mark.asyncio
async def test_students_needs_attention(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """needs_attention reflects each student's latest feedback bucket."""
    master = await _make_verified_master(client, db_session, telegram_id=91903)
    practice = await _create_completed_practice(db_session, master["user"]["id"])

    _u1, b1 = await _attend(client, db_session, practice, 91030, first_name="Sad")
    await _add_feedback(db_session, practice, _u1, b1, rating=2)
    _u2, b2 = await _attend(client, db_session, practice, 91031, first_name="Happy")
    await _add_feedback(db_session, practice, _u2, b2, rating=9)
    # No feedback at all -> not flagged.
    await _attend(client, db_session, practice, 91032, first_name="Quiet")
    await db_session.commit()

    resp = await client.get(STUDENTS_URL, headers=auth_headers(master["session_token"]))
    assert resp.status_code == 200
    by_name = {it["name"]: it for it in resp.json()["items"]}
    assert by_name["Sad"]["needs_attention"] is True
    assert by_name["Happy"]["needs_attention"] is False
    assert by_name["Quiet"]["needs_attention"] is False


@pytest.mark.asyncio
async def test_students_needs_attention_latest_wins(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An old confused feedback is overridden by a newer positive one."""
    master = await _make_verified_master(client, db_session, telegram_id=91904)
    mid = master["user"]["id"]
    p1 = await _create_completed_practice(db_session, mid)
    p2 = await _create_completed_practice(db_session, mid)
    now = datetime.now(UTC)

    uid, b1 = await _attend(client, db_session, p1, 91040, first_name="Turned")
    await _add_feedback(db_session, p1, uid, b1, rating=2, created_at=now - timedelta(days=2))
    _uid2, b2 = await _attend(client, db_session, p2, 91040, first_name="Turned")
    await _add_feedback(db_session, p2, uid, b2, rating=9, created_at=now)
    await db_session.commit()

    resp = await client.get(STUDENTS_URL, headers=auth_headers(master["session_token"]))
    assert resp.status_code == 200
    item = resp.json()["items"][0]
    assert item["name"] == "Turned"
    assert item["needs_attention"] is False


@pytest.mark.asyncio
async def test_students_search(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Name search filters the list (case-insensitive)."""
    master = await _make_verified_master(client, db_session, telegram_id=91905)
    practice = await _create_completed_practice(db_session, master["user"]["id"])

    await _attend(client, db_session, practice, 91050, first_name="Alice")
    await _attend(client, db_session, practice, 91051, first_name="Bob")
    await db_session.commit()

    resp = await client.get(
        STUDENTS_URL,
        params={"search": "ali"},
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["name"] == "Alice"


@pytest.mark.asyncio
async def test_students_pagination(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """limit/offset paginate while total reflects the full set."""
    master = await _make_verified_master(client, db_session, telegram_id=91906)
    practice = await _create_completed_practice(db_session, master["user"]["id"])
    for i in range(3):
        await _attend(client, db_session, practice, 91060 + i, first_name=f"S{i}")
    await db_session.commit()

    headers = auth_headers(master["session_token"])
    p1 = await client.get(STUDENTS_URL, params={"limit": 2, "offset": 0}, headers=headers)
    assert p1.status_code == 200
    assert p1.json()["total"] == 3
    assert len(p1.json()["items"]) == 2

    p2 = await client.get(STUDENTS_URL, params={"limit": 2, "offset": 2}, headers=headers)
    assert p2.status_code == 200
    assert len(p2.json()["items"]) == 1


@pytest.mark.asyncio
async def test_students_requires_master(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A regular (non-master) user gets 403."""
    user = await login_user(client, telegram_id=91070, first_name="Plain")
    resp = await client.get(STUDENTS_URL, headers=auth_headers(user["session_token"]))
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_students_no_auth(client: AsyncClient) -> None:
    """No auth: 401."""
    resp = await client.get(STUDENTS_URL)
    assert resp.status_code == 401


# ===================================================================
# GET /masters/me/students/{id} -- detail
# ===================================================================


@pytest.mark.asyncio
async def test_student_detail_basic(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Detail returns counts, hours, satisfaction, and recent activity."""
    master = await _make_verified_master(client, db_session, telegram_id=91910)
    mid = master["user"]["id"]
    p1 = await _create_completed_practice(db_session, mid, duration_minutes=60)
    p2 = await _create_completed_practice(db_session, mid, duration_minutes=90)

    uid, b1 = await _attend(client, db_session, p1, 91100, first_name="Deep")
    _uid2, b2 = await _attend(client, db_session, p2, 91100, first_name="Deep")
    await _add_feedback(db_session, p1, uid, b1, rating=8, comment="great")
    await _add_feedback(db_session, p2, uid, b2, rating=6, comment="ok")
    await _add_checkin(db_session, p1, uid, b1, mood=9, comment="ready")
    await db_session.commit()

    url = STUDENT_DETAIL_URL.format(student_id=uid)
    resp = await client.get(url, headers=auth_headers(master["session_token"]))
    assert resp.status_code == 200
    data = resp.json()

    assert data["practices_count"] == 2
    # 60 + 90 = 150 min = 2.5h
    assert data["hours"] == 2.5
    # avg(8, 6) = 7.0 -> 70
    assert data["satisfaction_pct"] == 70
    assert len(data["feedbacks"]) == 2
    assert len(data["recent_checkins"]) == 1
    assert data["recent_checkins"][0]["mood"] == 9
    assert set(data["feedbacks"][0].keys()) == {"rating", "comment", "created_at"}
    assert set(data["recent_checkins"][0].keys()) == {"mood", "comment", "created_at"}


@pytest.mark.asyncio
async def test_student_detail_satisfaction_null_without_feedback(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Attended but no feedback -> satisfaction_pct null, feedbacks empty."""
    master = await _make_verified_master(client, db_session, telegram_id=91911)
    practice = await _create_completed_practice(db_session, master["user"]["id"])
    uid, _b = await _attend(client, db_session, practice, 91110, first_name="Mute")
    await db_session.commit()

    url = STUDENT_DETAIL_URL.format(student_id=uid)
    resp = await client.get(url, headers=auth_headers(master["session_token"]))
    assert resp.status_code == 200
    data = resp.json()
    assert data["practices_count"] == 1
    assert data["satisfaction_pct"] is None
    assert data["feedbacks"] == []


@pytest.mark.asyncio
async def test_student_detail_widened_confirmed_booking_opens(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """P6 (owner-ruled widen, PROMPT №609): a non-cancelled booking that
    hasn't been ATTENDED yet now opens the profile -- this is the exact
    case that was broken in production: reachable from «Мои группы»
    (derived «Ученики» already admits any non-cancelled booking) but
    404'd here before this fix, because this endpoint alone still gated
    on ATTENDED-only. Aggregates stay attended/feedback-only and degrade
    to honest zeros -- practices_count/hours are NOT fabricated for a
    booking that hasn't happened yet.
    """
    master = await _make_verified_master(client, db_session, telegram_id=91913)
    practice = await _create_completed_practice(db_session, master["user"]["id"])
    uid, _b = await _attend(
        client, db_session, practice, 91121, first_name="NotYetAttended",
        status=BookingStatus.CONFIRMED.value,
    )
    await db_session.commit()

    url = STUDENT_DETAIL_URL.format(student_id=uid)
    resp = await client.get(url, headers=auth_headers(master["session_token"]))
    assert resp.status_code == 200
    data = resp.json()
    assert data["practices_count"] == 0
    assert data["hours"] == 0
    assert data["satisfaction_pct"] is None
    assert data["feedbacks"] == []
    assert data["recent_checkins"] == []


@pytest.mark.asyncio
async def test_student_detail_custom_group_member_with_no_bookings_opens(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """P6: the SECOND admitted case -- someone the master added to one of
    their own custom groups, with NO booking at all, also opens."""
    master = await _make_verified_master(client, db_session, telegram_id=91914)
    mid = master["user"]["id"]
    group = MasterGroup(master_id=mid, name="VIP")
    db_session.add(group)
    await db_session.flush()

    auth = await login_user(client, telegram_id=91122, first_name="NoBookingAtAll")
    uid = auth["user"]["id"]
    db_session.add(MasterGroupMembership(group_id=group.id, student_user_id=uid))
    await db_session.commit()

    url = STUDENT_DETAIL_URL.format(student_id=uid)
    resp = await client.get(url, headers=auth_headers(master["session_token"]))
    assert resp.status_code == 200
    data = resp.json()
    assert data["practices_count"] == 0
    assert data["hours"] == 0
    assert data["satisfaction_pct"] is None
    assert data["feedbacks"] == []
    assert data["recent_checkins"] == []


@pytest.mark.asyncio
async def test_student_detail_chat_only_contact_opens(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """T-37 (PROMPT №706): this endpoint's OWN code is unchanged, but its
    gate (groups_service.is_master_audience_member) now delegates entirely
    to the widened _derived_students_base -- so a chat-only contact (no
    booking, no group membership) opens too. Proves the cross-module effect
    without touching students_service.py: THIS module's code did not change,
    only what its dependency admits did. Aggregates stay exactly the same
    honest zeros the pre-existing widened cases already assert."""
    master = await _make_verified_master(client, db_session, telegram_id=91918)
    mid = master["user"]["id"]

    auth = await login_user(client, telegram_id=91919, first_name="ChatOnly")
    uid = auth["user"]["id"]
    db_session.add(
        ChatThread(comms_thread_id=uuid4(), client_user_id=uid, operator_user_id=mid)
    )
    await db_session.commit()

    url = STUDENT_DETAIL_URL.format(student_id=uid)
    resp = await client.get(url, headers=auth_headers(master["session_token"]))
    assert resp.status_code == 200
    data = resp.json()
    assert data["practices_count"] == 0
    assert data["hours"] == 0
    assert data["satisfaction_pct"] is None
    assert data["feedbacks"] == []
    assert data["recent_checkins"] == []


@pytest.mark.asyncio
async def test_student_detail_cancelled_only_contact_opens(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """2026-08-14 amendment to T-37 (PROMPT №707): a booking whose ONLY
    status is CANCELLED now makes its holder a contact -- so the gate
    (groups_service.is_master_audience_member, unchanged CODE, widened
    DEPENDENCY) opens this profile too. This module's own aggregate query
    (ATTENDED-only, untouched by the amendment) correctly reports
    practices_count=0 -- a cancelled booking was never attended, so this
    number is not a new zero the amendment invented, it is the same
    ATTENDED-only computation this file already had, now simply reachable
    for a wider set of visitors."""
    master = await _make_verified_master(client, db_session, telegram_id=91920)
    mid = master["user"]["id"]
    practice = await _create_completed_practice(db_session, mid)

    uid, _b = await _attend(
        client, db_session, practice, 91921, first_name="CancelledOnly",
        status=BookingStatus.CANCELLED.value,
    )
    await db_session.commit()

    url = STUDENT_DETAIL_URL.format(student_id=uid)
    resp = await client.get(url, headers=auth_headers(master["session_token"]))
    assert resp.status_code == 200
    data = resp.json()
    assert data["practices_count"] == 0
    assert data["hours"] == 0
    assert data["satisfaction_pct"] is None
    assert data["feedbacks"] == []
    assert data["recent_checkins"] == []


@pytest.mark.asyncio
async def test_student_detail_stranger_still_404s(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A user with no booking of ANY status and no group membership still
    404s -- the case that proves the gate was WIDENED, not removed."""
    master = await _make_verified_master(client, db_session, telegram_id=91915)
    await db_session.commit()

    # An id that resolves to no User row at all.
    url = STUDENT_DETAIL_URL.format(student_id=uuid4())
    resp = await client.get(url, headers=auth_headers(master["session_token"]))
    assert resp.status_code == 404

    # A real registered user with zero relationship to this master.
    stranger_auth = await login_user(client, telegram_id=91123, first_name="Stranger")
    stranger_id = stranger_auth["user"]["id"]
    resp2 = await client.get(
        STUDENT_DETAIL_URL.format(student_id=stranger_id),
        headers=auth_headers(master["session_token"]),
    )
    assert resp2.status_code == 404


@pytest.mark.asyncio
async def test_student_detail_blocked_student_opens_with_blocked_true(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """T24-20 (PROMPT №638): a master's OWN blocked student now opens (200,
    blocked=True) instead of 404 -- the narrow allow-path in
    get_master_student_detail, NOT a widened is_master_audience_member (a
    stranger still 404s, proven above and re-checked here isn't touched by
    this same call sequence)."""
    master = await _make_verified_master(client, db_session, telegram_id=91916)
    headers = auth_headers(master["session_token"])
    practice = await _create_completed_practice(db_session, master["user"]["id"])
    uid, _b = await _attend(client, db_session, practice, 91124, first_name="ToBlock")
    await db_session.commit()

    block_resp = await client.post(
        BLOCK_URL.format(student_id=uid), headers=headers,
    )
    assert block_resp.status_code == 200

    url = STUDENT_DETAIL_URL.format(student_id=uid)
    resp = await client.get(url, headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["blocked"] is True


@pytest.mark.asyncio
async def test_student_detail_non_blocked_student_carries_blocked_false(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Sibling of the blocked-true case above: an ordinary (not blocked)
    student's detail response carries blocked=False, not an absent/null
    field -- the frontend branches on this to pick the button label."""
    master = await _make_verified_master(client, db_session, telegram_id=91917)
    practice = await _create_completed_practice(db_session, master["user"]["id"])
    uid, _b = await _attend(client, db_session, practice, 91125, first_name="NotBlocked")
    await db_session.commit()

    url = STUDENT_DETAIL_URL.format(student_id=uid)
    resp = await client.get(url, headers=auth_headers(master["session_token"]))
    assert resp.status_code == 200
    assert resp.json()["blocked"] is False
