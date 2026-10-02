# =============================================================================
# VELO Backend -- Tests: the school analytics aggregate (tz-curator.md §6 MVP)
# =============================================================================
#
# telegram_id band: 89260-89399 (curator 89261, teacher 89262, a second
# curator 89264, students 89270-89272). Declared module-level below as
# _TID_MIN/_TID_MAX, ONCE -- tests/telegram_id_bands.py parses that
# declaration out of the AST on every run. First claimed (65900, 65999)
# after test_curator_group_feedback.py took (65800, 65899); re-claimed
# here 2026-10-02 -- the test branch's test_master_notifications.py
# declares the same 65900-65999 window, and the bands meta-test forbids
# the unrecorded collision, so this file moved (the other side is pushed).
#
# WHAT THIS FILE PINNS. One GET answers the curator's whole analytics
# screen. Four axes, each with its own failure mode:
#
#   1. THE NUMBERS RECONCILE WITH THE FEEDS. The mood aggregate uses the
#      exact /checkins predicate (PRE only, non-cancelled booking) and the
#      rating aggregate the exact /reviews predicate (no booking filter) --
#      a review on a CANCELLED booking is seeded below and MUST count,
#      because that is what the feed shows. If somebody "fixes" the
#      asymmetry in one place only, this test fails.
#   2. DRAFTS AND CANCELS ARE NOBODY'S ANALYTICS -- seeded and excluded
#      from every practices number.
#   3. THE RANKING IS ENGAGEMENT -- top_practices ordered by
#      check-ins + reviews, completed practices only.
#   4. THE GUARDS -- another curator's school is the masked 404 (P-08), a
#      plain user is 403 from get_current_master, and an EMPTY school is
#      zeros with an empty ranking, a 200 -- never a 404.
#   5. THE PERIOD CARDS (owner brief 2026-10-02) -- engagement is scoped to
#      ?period (week/month/quarter; default week, unknown 422), an
#      out-of-window attended booking neither counts as «приходило» nor
#      flips «пришли ещё раз», an out-of-window review is neither a
#      reviewer nor a rating bucket, «вступили и не пришли» is lifetime
#      and STUDENT-only, and the all-time groups do not move with the
#      slider.
#
# ROWS ARE SEEDED, NOT DRIVEN THROUGH THE API (the test_curator_group_
# feedback.py reasoning: check-ins/feedbacks are window-bound and immutable,
# so an API-built history would mean moving the clock in every test).
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.periods import calendar_period_bounds
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.curator_groups.models import (
    CuratorGroup,
    CuratorGroupMember,
    CuratorMemberKind,
)
from app.modules.diary.models import Checkin, CheckType, Feedback
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeStatus,
    PracticeType,
)
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

ANALYTICS_URL = "/api/v1/masters/me/curator-groups/{group_id}/analytics"

_TID_MIN = 89260
_TID_MAX = 89399

_TID_CURATOR = 89261
_TID_TEACHER = 89262
_TID_CURATOR_B = 89264
_TID_STUDENT = 89270
_TID_STUDENT_B = 89271
_TID_STUDENT_C = 89272

async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    first_name: str = "Master",
) -> dict:
    """A verified master -- the only person get_current_master admits."""
    auth = await login_user(client, telegram_id=telegram_id, first_name=first_name)
    user_id = UUID(auth["user"]["id"])

    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    await db_session.flush()

    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={
                "account": {"status": "verified", "can_create_groups": True},
                "profile": {"bio": "m"},
            },
        )
    )
    await db_session.flush()
    await db_session.commit()
    return auth


async def _make_student(client: AsyncClient, telegram_id: int) -> dict:
    return await login_user(client, telegram_id=telegram_id, first_name="Student")


async def _school(db_session: AsyncSession, curator: dict, name: str) -> CuratorGroup:
    group = CuratorGroup(curator_user_id=UUID(curator["user"]["id"]), name=name)
    db_session.add(group)
    await db_session.flush()
    await db_session.commit()
    return group


async def _join_school(
    db_session: AsyncSession,
    school: CuratorGroup,
    auth: dict,
    kind: CuratorMemberKind,
) -> CuratorGroupMember:
    row = CuratorGroupMember(
        group_id=school.id,
        user_id=UUID(auth["user"]["id"]),
        kind=kind.value,
    )
    db_session.add(row)
    await db_session.flush()
    await db_session.commit()
    return row


async def _practice(
    db_session: AsyncSession,
    master: dict,
    school: CuratorGroup,
    *,
    title: str,
    status: str = PracticeStatus.SCHEDULED.value,
    hours_from_now: float = 48,
    direction: str | None = None,
) -> Practice:
    practice = Practice(
        master_id=UUID(master["user"]["id"]),
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
        audience_kind=AudienceKind.CURATOR_GROUPS.value,
        curator_group_id=school.id,
        data={"taxonomy": {"direction": direction}} if direction else {},
    )
    db_session.add(practice)
    await db_session.flush()
    await db_session.commit()
    return practice


async def _booking(
    db_session: AsyncSession,
    practice: Practice,
    student: dict,
    status: str = BookingStatus.CONFIRMED.value,
) -> Booking:
    booking = Booking(
        practice_id=practice.id,
        user_id=UUID(student["user"]["id"]),
        status=status,
    )
    db_session.add(booking)
    await db_session.flush()
    await db_session.commit()
    return booking


async def _checkin(
    db_session: AsyncSession,
    practice: Practice,
    student: dict,
    booking: Booking,
    *,
    mood: int,
    check_type: str = CheckType.PRE.value,
) -> Checkin:
    row = Checkin(
        practice_id=practice.id,
        user_id=UUID(student["user"]["id"]),
        booking_id=booking.id,
        mood=mood,
        comment=None,
        check_type=check_type,
    )
    db_session.add(row)
    await db_session.flush()
    await db_session.commit()
    return row


async def _feedback(
    db_session: AsyncSession,
    practice: Practice,
    student: dict,
    booking: Booking,
    *,
    rating: int,
) -> Feedback:
    row = Feedback(
        practice_id=practice.id,
        user_id=UUID(student["user"]["id"]),
        booking_id=booking.id,
        rating=rating,
        comment=None,
    )
    db_session.add(row)
    await db_session.flush()
    await db_session.commit()
    return row

@pytest.fixture(autouse=True)
async def _clean_band(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    # full_cleanup_range leaves its DELETEs uncommitted on purpose ("caller
    # must commit after") -- an uncommitted DELETE here parks the session
    # idle-in-transaction holding user-row locks, and the test body's very
    # first login INSERT (another pooled connection) blocks on them until
    # postgres kills the blocker. Commit BEFORE handing the band over.
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


_TID_OUTSIDER = 89290


async def _seed_lively_school(
    client: AsyncClient,
    db_session: AsyncSession,
) -> tuple[dict, dict, CuratorGroup]:
    """The one history every number in the aggregate test is read off.

    P1 «Дыхание» completed: three attended students (mood 9/5/2, rating
    10/6/2) -> 3 check-ins + 3 reviews. P2 «Медитация» completed: a POST
    check-in and a check-in on a CANCELLED booking -- both invisible to
    the mood aggregate, while BOTH of P2's reviews count (the reviews feed
    has no booking filter). P3 scheduled, already carrying a PRE check-in
    and a review: neither aggregate filters by practice status. Plus one
    draft and one cancelled practice, seeded ONLY to be excluded.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR, first_name="Vera")
    teacher = await _make_verified_master(client, db_session, _TID_TEACHER, first_name="Teacher")
    curator_b = await _make_verified_master(client, db_session, _TID_CURATOR_B, first_name="Other")
    s1 = await _make_student(client, _TID_STUDENT)
    s2 = await _make_student(client, _TID_STUDENT_B)
    s3 = await _make_student(client, _TID_STUDENT_C)

    school = await _school(db_session, curator, "Аналитическая")
    await _join_school(db_session, school, teacher, CuratorMemberKind.MASTER)
    for student in (s1, s2, s3):
        await _join_school(db_session, school, student, CuratorMemberKind.STUDENT)

    p1 = await _practice(
        db_session, teacher, school,
        title="Дыхание", status=PracticeStatus.COMPLETED.value, hours_from_now=-48,
    )
    p2 = await _practice(
        db_session, teacher, school,
        title="Медитация", status=PracticeStatus.COMPLETED.value, hours_from_now=-24,
    )
    await _practice(
        db_session, teacher, school,
        title="Плановая", status=PracticeStatus.SCHEDULED.value, hours_from_now=48,
    )
    await _practice(
        db_session, teacher, school,
        title="Черновик", status=PracticeStatus.DRAFT.value, hours_from_now=72,
    )
    await _practice(
        db_session, teacher, school,
        title="Отменена", status=PracticeStatus.CANCELLED.value, hours_from_now=-72,
    )

    for student, mood, rating in ((s1, 9, 10), (s2, 5, 6), (s3, 2, 2)):
        booking = await _booking(db_session, p1, student)
        await _checkin(db_session, p1, student, booking, mood=mood)
        await _feedback(db_session, p1, student, booking, rating=rating)

    post_booking = await _booking(db_session, p2, s1)
    await _checkin(
        db_session, p2, s1, post_booking, mood=8, check_type=CheckType.POST.value,
    )
    await _feedback(db_session, p2, s1, post_booking, rating=9)
    cancelled_booking = await _booking(
        db_session, p2, s2, status=BookingStatus.CANCELLED.value,
    )
    await _checkin(db_session, p2, s2, cancelled_booking, mood=1)
    await _feedback(db_session, p2, s2, cancelled_booking, rating=9)

    p3 = await _practice(
        db_session, teacher, school,
        title="Впереди", status=PracticeStatus.SCHEDULED.value, hours_from_now=60,
    )
    early_booking = await _booking(db_session, p3, s1)
    await _checkin(db_session, p3, s1, early_booking, mood=7)
    await _feedback(db_session, p3, s1, early_booking, rating=10)

    return curator, curator_b, school


async def test_aggregate_reconciles_with_the_feed_predicates(
    client: AsyncClient, db_session: AsyncSession,
):
    curator, _curator_b, school = await _seed_lively_school(client, db_session)
    resp = await client.get(
        ANALYTICS_URL.format(group_id=school.id),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()

    # Draft «Черновик» and cancelled «Отменена» are in the seed and in NONE
    # of these numbers.
    assert data["practices"] == {"total": 4, "completed": 2, "upcoming": 2}
    assert data["members"] == {"masters": 1, "students": 3}

    # The mood aggregate saw exactly the PRE-on-live-booking check-ins
    # (9=high, 5=mid, 2=low, 7=mid); the POST one and the cancelled-booking
    # one did not pass.
    feedback = data["feedback"]
    assert feedback["checkins_count"] == 4
    assert feedback["mood"] == {"low": 1, "mid": 2, "high": 1}

    # The rating aggregate saw ALL six reviews -- including the two left on
    # the POST/cancelled bookings of P2, because /reviews has no booking
    # filter and these numbers must reconcile with that feed. Five-scale
    # buckets: 10,9,9,10 -> fire; 6 -> neutral; 2 -> bad.
    assert feedback["reviews_count"] == 6
    assert feedback["rating"] == {
        "bad": 1,
        "low": 0,
        "neutral": 1,
        "good": 0,
        "fire": 4,
    }

    # Ranking: engagement (check-ins + reviews) over completed practices
    # only -- P1 (3+3) beats P2 (0+2); the scheduled P3 stays out.
    top = data["top_practices"]
    assert [row["title"] for row in top] == ["Дыхание", "Медитация"]
    assert (top[0]["checkins_count"], top[0]["reviews_count"]) == (3, 3)
    assert (top[1]["checkins_count"], top[1]["reviews_count"]) == (0, 2)
    assert top[0]["master_name"] == "Teacher"
    assert UUID(top[0]["practice_id"])
    assert top[0]["scheduled_at"]


async def test_empty_school_is_zeros_not_404(client: AsyncClient, db_session: AsyncSession):
    curator, _curator_b, school = await _seed_lively_school(client, db_session)
    empty = await _school(db_session, curator, "Пустая")

    resp = await client.get(
        ANALYTICS_URL.format(group_id=empty.id),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "practices": {"total": 0, "completed": 0, "upcoming": 0},
        "members": {"masters": 0, "students": 0},
        "engagement": {
            "practices_conducted": 0,
            "attendees": 0,
            "repeat_attendees": 0,
            "repeat_pct": 0,
            "joined_never_came": 0,
            "reviewers": 0,
            "rating": {"bad": 0, "low": 0, "neutral": 0, "good": 0, "fire": 0},
            "conducted_practices": [],
        },
        "feedback": {
            "checkins_count": 0,
            "reviews_count": 0,
            "mood": {"low": 0, "mid": 0, "high": 0},
            "rating": {"bad": 0, "low": 0, "neutral": 0, "good": 0, "fire": 0},
        },
        "top_practices": [],
    }


async def test_somebody_elses_school_is_the_masked_404(
    client: AsyncClient, db_session: AsyncSession,
):
    _curator, curator_b, school = await _seed_lively_school(client, db_session)

    resp = await client.get(
        ANALYTICS_URL.format(group_id=school.id),
        headers=auth_headers(curator_b["session_token"]),
    )
    assert resp.status_code == 404, resp.text


async def test_a_plain_user_is_403(client: AsyncClient, db_session: AsyncSession):
    _curator, _curator_b, school = await _seed_lively_school(client, db_session)
    outsider = await _make_student(client, _TID_OUTSIDER)

    resp = await client.get(
        ANALYTICS_URL.format(group_id=school.id),
        headers=auth_headers(outsider["session_token"]),
    )
    assert resp.status_code == 403, resp.text


# =============================================================================
# The period cards (engagement)
# =============================================================================

async def _seed_engagement_school(
    client: AsyncClient,
    db_session: AsyncSession,
) -> tuple[dict, CuratorGroup]:
    """A window-shaped history the period cards are read off.

    Two completed practices at `now` land inside the week, the month and
    the quarter alike; «Раньше всех» is seeded one day before the EARLIEST
    of the three windows' starts, so it sits outside every window the
    endpoint accepts and every period must exclude it. (quarter_start - 1
    day alone is NOT enough: in the first days of a quarter that moment
    is still inside the current week.) s1 attended both in-window
    sessions (came again); s2 attended one in-window and the out-of-window
    one -- so if the window filter ever leaked, s2 would flip «пришли ещё
    раз» and this seed catches it. s3 joined and never came; the teacher
    is a MASTER-kind member (never counted as never-came).

    The feedback pair rides the same history: s1 left an in-window review
    (fire) AND one on the out-of-window practice (confused) -- so a
    leaking window would flip s1's review into the buckets too; s2 left
    one in-window review (good). Reviewers in-window = {s1, s2}.
    """
    curator = await _make_verified_master(client, db_session, _TID_CURATOR, first_name="Vera")
    teacher = await _make_verified_master(client, db_session, _TID_TEACHER, first_name="Teacher")
    s1 = await _make_student(client, _TID_STUDENT)
    s2 = await _make_student(client, _TID_STUDENT_B)
    s3 = await _make_student(client, _TID_STUDENT_C)

    school = await _school(db_session, curator, "Вовлечённая")
    await _join_school(db_session, school, teacher, CuratorMemberKind.MASTER)
    for student in (s1, s2, s3):
        await _join_school(db_session, school, student, CuratorMemberKind.STUDENT)

    now = datetime.now(UTC)
    starts = [
        calendar_period_bounds(kind, now)[0] for kind in ("week", "month", "quarter")
    ]
    before_every_window_hours = (
        (min(starts) - timedelta(days=1)) - now
    ).total_seconds() / 3600

    # Deterministic ordering anchors: the window that starts LAST is the
    # narrowest one, so its start +1h/+2h sit inside ALL three windows and
    # pin the scheduled_at.desc() order (Б newer than А) no matter when the
    # suite runs.
    in_early_hours = ((max(starts) + timedelta(hours=1)) - now).total_seconds() / 3600
    in_late_hours = ((max(starts) + timedelta(hours=2)) - now).total_seconds() / 3600

    in_a = await _practice(
        db_session, teacher, school,
        title="Сейчас А", status=PracticeStatus.COMPLETED.value,
        hours_from_now=in_early_hours, direction="yoga",
    )
    in_b = await _practice(
        db_session, teacher, school,
        title="Сейчас Б", status=PracticeStatus.COMPLETED.value,
        hours_from_now=in_late_hours,
    )
    old = await _practice(
        db_session, teacher, school,
        title="Раньше всех", status=PracticeStatus.COMPLETED.value,
        hours_from_now=before_every_window_hours,
    )

    in_a_booking_s1 = await _booking(db_session, in_a, s1, status=BookingStatus.ATTENDED.value)
    await _booking(db_session, in_b, s1, status=BookingStatus.ATTENDED.value)
    in_a_booking_s2 = await _booking(db_session, in_a, s2, status=BookingStatus.ATTENDED.value)
    await _booking(db_session, old, s2, status=BookingStatus.ATTENDED.value)

    # The feedback pair (in-window reviews + one planted outside the
    # earliest window; the reviews feed has no booking filter, so the
    # statuses here are deliberately mixed).
    await _feedback(db_session, in_a, s1, in_a_booking_s1, rating=10)
    await _feedback(db_session, in_a, s2, in_a_booking_s2, rating=6)
    old_booking_s1 = await _booking(db_session, old, s1)
    await _feedback(db_session, old, s1, old_booking_s1, rating=2)

    return curator, school


@pytest.mark.parametrize("period", ["week", "month", "quarter"])
async def test_engagement_is_scoped_to_the_requested_period(
    client: AsyncClient, db_session: AsyncSession, period: str,
):
    curator, school = await _seed_engagement_school(client, db_session)
    resp = await client.get(
        ANALYTICS_URL.format(group_id=school.id) + f"?period={period}",
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()

    # Same numbers under every period: both «Сейчас» practices are inside
    # all three windows, and «Раньше всех» (with s2's attended booking and
    # s1's review) is outside every one of them.
    eng = data["engagement"]
    assert eng["practices_conducted"] == 2
    assert eng["attendees"] == 2
    assert eng["repeat_attendees"] == 1
    assert eng["repeat_pct"] == 50
    assert eng["joined_never_came"] == 1
    assert eng["reviewers"] == 2
    assert eng["rating"] == {"bad": 0, "low": 0, "neutral": 1, "good": 0, "fire": 1}

    # Part 3: every in-window practice, newest first, each with its own
    # aggregates on the same predicates.
    practices = eng["conducted_practices"]
    assert [p["title"] for p in practices] == ["Сейчас Б", "Сейчас А"]

    by_title = {p["title"]: p for p in practices}
    a = by_title["Сейчас А"]
    b = by_title["Сейчас Б"]
    assert [p["scheduled_at"] for p in practices] == sorted(
        [p["scheduled_at"] for p in practices], reverse=True
    )
    # «Сейчас А»: s1 + s2 came, s1 + s2 reviewed (6 -> neutral, 10 -> fire).
    assert a["direction"] == "yoga"
    assert a["master_name"] == "Teacher"
    assert a["attendees_count"] == 2
    assert a["checkins_count"] == 0
    assert a["reviewers_count"] == 2
    assert a["reviews_count"] == 2
    assert a["rating"] == {"bad": 0, "low": 0, "neutral": 1, "good": 0, "fire": 1}
    # «Сейчас Б»: s1 came, nobody reviewed.
    assert b["direction"] is None
    assert b["attendees_count"] == 1
    assert b["checkins_count"] == 0
    assert b["reviewers_count"] == 0
    assert b["reviews_count"] == 0
    assert b["rating"] == {"bad": 0, "low": 0, "neutral": 0, "good": 0, "fire": 0}
    assert UUID(a["practice_id"]) and UUID(b["practice_id"])
    assert a["timezone"] and b["timezone"]
    # The all-time groups do not move with the slider: the school's whole
    # history is three completed practices, whatever the window says.
    assert data["practices"]["completed"] == 3


async def test_engagement_defaults_to_week(client: AsyncClient, db_session: AsyncSession):
    curator, school = await _seed_engagement_school(client, db_session)
    resp = await client.get(
        ANALYTICS_URL.format(group_id=school.id),
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["engagement"]["practices_conducted"] == 2


async def test_unknown_period_is_a_422(client: AsyncClient, db_session: AsyncSession):
    curator, school = await _seed_engagement_school(client, db_session)
    resp = await client.get(
        ANALYTICS_URL.format(group_id=school.id) + "?period=year",
        headers=auth_headers(curator["session_token"]),
    )
    assert resp.status_code == 422, resp.text