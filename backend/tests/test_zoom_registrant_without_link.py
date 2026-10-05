# =============================================================================
# VELO -- Tests: a registrant left without a join link (BE-72)
# =============================================================================
#
# telegram_id band: 60100-60149.
#
# BAND PROVENANCE. free_windows(space=(60000, 99999)) returned (60100, 64999)
# as its first window on 2026-10-01; 60150-64999 stays free.
#
# WHAT IS UNDER TEST
#
#   A registrant either gets a personal join link or, past a point, never
#   will: Zoom answered a create without a join_url (nothing revisits a
#   registered row), or the retry poller spent its five attempts. Owner
#   ruling: the poller stays as it is. What changes is what the system SAYS
#   about such a person and what it RECORDS about him.
#
#   1. ONE PREDICATE -- zoom/service.py's link_unavailable_reason -- and its
#      table, including the empty-string link.
#   2. THE RESOLVER answers kind='unavailable' for it, not 'pending'; a row
#      still under the cap stays 'pending' (pair).
#   3. THE BOOKING LISTS carry zoom_registrant_link_unavailable from the same
#      predicate, behind the same M-3 gate as the link.
#   4. THE LOG: zoom_registrant_link_unavailable, once per registrant, at the
#      transition -- never on a read.
#   5. THE INGEST gives no Zoom verdict to a registrant without
#      zoom_registrant_id or join_url; the proxy (BE-41) decides, and the
#      neighbour with a link is still judged by Zoom in the same run.
#
# Every "unavailable" has its pair "and a row with a link is personal";
# every "no event" has its pair "and the event does fire for X".
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from structlog.testing import capture_logs

from app.core.config import settings
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.diary.models import Checkin, CheckType
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from app.modules.zoom import attendance_service, retry_poller
from app.modules.zoom import service as zoom_service
from app.modules.zoom.attendance_service import ingest_report_for_meeting
from app.modules.zoom.models import (
    ZoomMeeting,
    ZoomMeetingStatus,
    ZoomRegistrant,
    ZoomRegistrantRole,
    ZoomRegistrantStatus,
)
from app.modules.zoom.retry_poller import _poll_cycle
from app.modules.zoom.service import (
    LINK_UNAVAILABLE_REGISTERED_WITHOUT_JOIN_URL,
    LINK_UNAVAILABLE_RETRY_CAP,
    create_registrant_for_booking,
    ensure_host_registrant,
    link_unavailable_reason,
)
from app.modules.zoom.zoom_client import ZoomAPIError
from tests.helpers import auth_headers, full_cleanup_range, login_user

_TID_MIN = 60100
_TID_MAX = 60149

_LINK = "https://zoom.us/w/555000222?tk=personal"
_EVENT = "zoom_registrant_link_unavailable"


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _user(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int, *,
    master: bool = False,
) -> tuple[User, str]:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=f"U{telegram_id}",
    )
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    if master:
        user.role = UserRole.MASTER.value
        db_session.add(
            MasterProfile(
                user_id=user.id,
                data={
                    "account": {"status": "verified"},
                    "profile": {"display_name": "Master"},
                },
            )
        )
    await db_session.flush()
    return user, auth["session_token"]


async def _practice_with_meeting(
    db_session: AsyncSession, master: User, zoom_id: str,
) -> tuple[Practice, ZoomMeeting]:
    """A scheduled practice three hours ahead with an ACTIVE meeting."""
    practice = Practice(
        master_id=master.id,
        title="Without link",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=PracticeStatus.SCHEDULED.value,
        scheduled_at=datetime.now(UTC) + timedelta(hours=3),
        duration_minutes=60,
        timezone="UTC",
        max_participants=10,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        data={},
    )
    db_session.add(practice)
    await db_session.flush()
    meeting = ZoomMeeting(
        practice_id=practice.id,
        zoom_meeting_id=zoom_id,
        zoom_meeting_uuid=f"uuid-{zoom_id}",
        status=ZoomMeetingStatus.ACTIVE.value,
    )
    db_session.add(meeting)
    await db_session.flush()
    return practice, meeting


async def _booking_with_registrant(
    db_session: AsyncSession,
    practice: Practice,
    meeting: ZoomMeeting,
    user: User,
    *,
    status: str,
    join_url: str | None,
    zoom_registrant_id: str | None = None,
    retry_count: int = 0,
    booking_status: str = BookingStatus.CONFIRMED.value,
) -> tuple[Booking, ZoomRegistrant]:
    """Direct ORM writes: the states under test (a registered row with no
    link, a row at the cap) are ones the booking flow does not produce on
    demand."""
    booking = Booking(
        practice_id=practice.id, user_id=user.id, status=booking_status,
    )
    db_session.add(booking)
    await db_session.flush()
    registrant = ZoomRegistrant(
        zoom_meeting_id=meeting.id,
        user_id=user.id,
        booking_id=booking.id,
        role=ZoomRegistrantRole.STUDENT.value,
        registration_email=f"user-{user.id}@users.velo.invalid",
        status=status,
        join_url=join_url,
        zoom_registrant_id=zoom_registrant_id,
        retry_count=retry_count,
    )
    db_session.add(registrant)
    await db_session.flush()
    return booking, registrant


def _row(*, status: str, join_url: str | None, retry_count: int = 0) -> ZoomRegistrant:
    return ZoomRegistrant(
        status=status, join_url=join_url, retry_count=retry_count,
        role=ZoomRegistrantRole.STUDENT.value,
    )


def _events(logs: list[dict]) -> list[dict]:
    return [e for e in logs if e["event"] == _EVENT]


_CAP = settings.zoom_registrant_create_max_retries
_FAILED = ZoomRegistrantStatus.CREATE_FAILED.value


# ===========================================================================
# 1. The predicate.
# ===========================================================================


@pytest.mark.parametrize(
    ("status", "join_url", "retry_count", "expected"),
    [
        # A link is a link, whatever the status says.
        (ZoomRegistrantStatus.REGISTERED.value, _LINK, 0, None),
        # Registered without one: nothing will ever revisit this row.
        (ZoomRegistrantStatus.REGISTERED.value, None, 0,
         LINK_UNAVAILABLE_REGISTERED_WITHOUT_JOIN_URL),
        # An empty string opens nothing either -- falsy, not just NULL.
        (ZoomRegistrantStatus.REGISTERED.value, "", 0,
         LINK_UNAVAILABLE_REGISTERED_WITHOUT_JOIN_URL),
        # Still being tried: one under the cap, and a fresh row.
        (ZoomRegistrantStatus.CREATE_FAILED.value, None, _CAP - 1, None),
        (ZoomRegistrantStatus.CREATE_FAILED.value, None, 0, None),
        # The cap reached, and (repeat axis) past it.
        (ZoomRegistrantStatus.CREATE_FAILED.value, None, _CAP,
         LINK_UNAVAILABLE_RETRY_CAP),
        (ZoomRegistrantStatus.CREATE_FAILED.value, None, _CAP + 1,
         LINK_UNAVAILABLE_RETRY_CAP),
        # Queued: the poller has not tried yet, or the meeting is not active.
        (ZoomRegistrantStatus.PENDING.value, None, 0, None),
        # Cancelled: nobody is waiting for this link.
        (ZoomRegistrantStatus.CANCELLED.value, None, _CAP, None),
    ],
)
def test_link_unavailable_reason_table(
    status: str, join_url: str | None, retry_count: int, expected: str | None,
) -> None:
    assert link_unavailable_reason(
        _row(status=status, join_url=join_url, retry_count=retry_count),
    ) == expected


# ===========================================================================
# 2. The resolver.
# ===========================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "join_url", "retry_count", "kind", "url"),
    [
        (ZoomRegistrantStatus.CREATE_FAILED.value, None, _CAP, "unavailable", None),
        (ZoomRegistrantStatus.REGISTERED.value, "", 0, "unavailable", None),
        # Pairs: still under the cap is honest waiting; a link is personal.
        (ZoomRegistrantStatus.CREATE_FAILED.value, None, _CAP - 1, "pending", None),
        (ZoomRegistrantStatus.REGISTERED.value, _LINK, 0, "personal", _LINK),
    ],
)
async def test_resolver_answers_from_the_predicate(
    client: AsyncClient,
    db_session: AsyncSession,
    status: str,
    join_url: str | None,
    retry_count: int,
    kind: str,
    url: str | None,
) -> None:
    master, _ = await _user(client, db_session, 60100, master=True)
    student, token = await _user(client, db_session, 60101)
    practice, meeting = await _practice_with_meeting(db_session, master, "555000201")
    meeting.shared_join_url = "https://zoom.us/w/555000201?tk=guest"
    await _booking_with_registrant(
        db_session, practice, meeting, student,
        status=status, join_url=join_url, retry_count=retry_count,
    )
    await db_session.commit()

    resp = await client.get(
        f"/api/v1/practices/{practice.id}/zoom/resolve",
        headers=auth_headers(token),
    )

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"kind": kind, "url": url}


@pytest.mark.asyncio
async def test_resolver_on_an_inactive_meeting_is_unchanged_by_the_registrant(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """EMPTINESS: the meeting is not ACTIVE. Step 3 answers before the
    registrant is ever read, so even a registrant at the cap says what the
    MEETING says -- 'pending' for pending_creation."""
    master, _ = await _user(client, db_session, 60102, master=True)
    student, token = await _user(client, db_session, 60103)
    practice, meeting = await _practice_with_meeting(db_session, master, "555000202")
    await _booking_with_registrant(
        db_session, practice, meeting, student,
        status=ZoomRegistrantStatus.CREATE_FAILED.value, join_url=None,
        retry_count=_CAP,
    )
    meeting.status = ZoomMeetingStatus.PENDING_CREATION.value
    await db_session.commit()

    resp = await client.get(
        f"/api/v1/practices/{practice.id}/zoom/resolve",
        headers=auth_headers(token),
    )

    assert resp.json()["kind"] == "pending"


# ===========================================================================
# 3. The booking lists.
# ===========================================================================


@pytest.mark.asyncio
async def test_both_booking_lists_carry_the_flag_from_the_same_predicate(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Three bookings of one student on three practices: at the cap, still
    under it, and with a link. GET /me and GET /me/upcoming must agree
    with each other and with the predicate."""
    master, _ = await _user(client, db_session, 60104, master=True)
    student, token = await _user(client, db_session, 60105)

    expected: dict[str, tuple[str | None, bool]] = {}
    cases = [
        ("555000203", _FAILED, None, _CAP, (None, True)),
        ("555000204", _FAILED, None, _CAP - 1, (None, False)),
        ("555000205", ZoomRegistrantStatus.REGISTERED.value, _LINK, 0, (_LINK, False)),
    ]
    for zoom_id, status, join_url, retry_count, want in cases:
        practice, meeting = await _practice_with_meeting(db_session, master, zoom_id)
        booking, _ = await _booking_with_registrant(
            db_session, practice, meeting, student,
            status=status, join_url=join_url, retry_count=retry_count,
        )
        expected[str(booking.id)] = want
    await db_session.commit()

    listed = await client.get("/api/v1/bookings/me", headers=auth_headers(token))
    upcoming = await client.get(
        "/api/v1/bookings/me/upcoming", headers=auth_headers(token),
    )
    assert listed.status_code == 200, listed.text
    assert upcoming.status_code == 200, upcoming.text

    for rows in (listed.json()["items"], upcoming.json()):
        got = {
            r["id"]: (
                r["zoom_registrant_join_url"],
                r["zoom_registrant_link_unavailable"],
            )
            for r in rows
            if r["id"] in expected
        }
        assert got == expected


@pytest.mark.asyncio
async def test_list_flag_stays_behind_the_m3_gate(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A PENDING booking (purchase not settled) never shows the link, and so
    never shows why it is missing either. Pair: the same registrant on a
    CONFIRMED booking raises the flag (previous test)."""
    master, _ = await _user(client, db_session, 60106, master=True)
    student, token = await _user(client, db_session, 60107)
    practice, meeting = await _practice_with_meeting(db_session, master, "555000206")
    booking, _ = await _booking_with_registrant(
        db_session, practice, meeting, student,
        status=ZoomRegistrantStatus.REGISTERED.value, join_url=None,
        booking_status=BookingStatus.PENDING.value,
    )
    await db_session.commit()

    listed = await client.get("/api/v1/bookings/me", headers=auth_headers(token))

    row = next(r for r in listed.json()["items"] if r["id"] == str(booking.id))
    assert row["zoom_registrant_link_unavailable"] is False
    assert row["zoom_registrant_join_url"] is None


# ===========================================================================
# 4. The log -- once per registrant, at the transition.
# ===========================================================================


@pytest.mark.asyncio
async def test_poller_logs_the_attempt_that_reaches_the_cap_once(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SHORTAGE: Zoom refuses every attempt. The attempt that reaches the cap
    logs the event; the next cycle (REPEAT) does not claim the row, does not
    call Zoom, and logs nothing. Pair: the row one attempt below, failing in
    the same cycle, logs nothing -- it may still get a link."""
    master, _ = await _user(client, db_session, 60108, master=True)
    at_edge_user, _ = await _user(client, db_session, 60109)
    below_user, _ = await _user(client, db_session, 60110)
    practice, meeting = await _practice_with_meeting(db_session, master, "555000207")
    _, at_edge = await _booking_with_registrant(
        db_session, practice, meeting, at_edge_user,
        status=ZoomRegistrantStatus.CREATE_FAILED.value, join_url=None,
        retry_count=_CAP - 1,
    )
    _, below = await _booking_with_registrant(
        db_session, practice, meeting, below_user,
        status=ZoomRegistrantStatus.CREATE_FAILED.value, join_url=None,
        retry_count=_CAP - 2,
    )
    await db_session.commit()

    calls: list[str] = []

    async def refuse(*, zoom_meeting_id: str, email: str, **_kw) -> dict:
        calls.append(email)
        raise ZoomAPIError("refused", status_code=500, body={"code": 500})

    monkeypatch.setattr(retry_poller, "create_registrant", refuse)

    with capture_logs() as first:
        await _poll_cycle()
    with capture_logs() as second:
        await _poll_cycle()

    events = _events(first)
    assert [e["registrant_id"] for e in events] == [str(at_edge.id)]
    assert events[0]["reason"] == LINK_UNAVAILABLE_RETRY_CAP
    assert events[0]["role"] == ZoomRegistrantRole.STUDENT.value
    # REPEAT: the row at the cap is not claimed again; `below` reaches the
    # cap on the second cycle and is the only one logged there.
    assert [e["registrant_id"] for e in _events(second)] == [str(below.id)]
    assert calls.count(at_edge.registration_email) == 1
    assert calls.count(below.registration_email) == 2


@pytest.mark.asyncio
async def test_poller_logs_a_success_without_a_join_url_once(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Zoom accepts the registrant and returns no join_url: the row becomes
    registered without a link, logged once; the next cycle does not claim a
    registered row. Pair: a success WITH a join_url logs nothing."""
    master, _ = await _user(client, db_session, 60111, master=True)
    no_url_user, _ = await _user(client, db_session, 60112)
    url_user, _ = await _user(client, db_session, 60113)
    practice, meeting = await _practice_with_meeting(db_session, master, "555000208")
    _, no_url = await _booking_with_registrant(
        db_session, practice, meeting, no_url_user,
        status=ZoomRegistrantStatus.PENDING.value, join_url=None,
    )
    _, with_url = await _booking_with_registrant(
        db_session, practice, meeting, url_user,
        status=ZoomRegistrantStatus.PENDING.value, join_url=None,
    )
    await db_session.commit()

    async def accept(*, zoom_meeting_id: str, email: str, **_kw) -> dict:
        if email == no_url.registration_email:
            return {"id": "reg-no-url"}
        return {"id": "reg-with-url", "join_url": _LINK}

    monkeypatch.setattr(retry_poller, "create_registrant", accept)

    with capture_logs() as first:
        await _poll_cycle()
    with capture_logs() as second:
        await _poll_cycle()

    events = _events(first)
    assert [e["registrant_id"] for e in events] == [str(no_url.id)]
    assert events[0]["reason"] == LINK_UNAVAILABLE_REGISTERED_WITHOUT_JOIN_URL
    assert _events(second) == []
    await db_session.refresh(no_url)
    await db_session.refresh(with_url)
    assert no_url.status == ZoomRegistrantStatus.REGISTERED.value
    assert with_url.join_url == _LINK


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("response", "logged"),
    [({"id": "reg-1"}, True), ({"id": "reg-1", "join_url": _LINK}, False)],
)
async def test_booking_time_create_without_a_join_url_is_logged(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    response: dict,
    logged: bool,
) -> None:
    """The booking-time writer logs the same event; the reuse path (REPEAT:
    the same booking registered again) does not, because it writes
    nothing."""
    master, _ = await _user(client, db_session, 60114, master=True)
    student, _ = await _user(client, db_session, 60115)
    practice, _meeting = await _practice_with_meeting(db_session, master, "555000209")
    booking = Booking(
        practice_id=practice.id, user_id=student.id,
        status=BookingStatus.CONFIRMED.value,
    )
    db_session.add(booking)
    await db_session.flush()

    async def fake(**_kw) -> dict:
        return response

    monkeypatch.setattr(zoom_service, "create_registrant", fake)

    with capture_logs() as first:
        row = await create_registrant_for_booking(booking, student, db_session)
    await db_session.flush()
    with capture_logs() as again:
        reused = await create_registrant_for_booking(booking, student, db_session)

    assert reused.id == row.id
    assert [e["registrant_id"] for e in _events(first)] == (
        [str(row.id)] if logged else []
    )
    assert _events(again) == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("response", "logged"),
    [({"id": "host-1"}, True), ({"id": "host-1", "join_url": _LINK}, False)],
)
async def test_host_registrant_without_a_join_url_is_logged_with_its_role(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    response: dict,
    logged: bool,
) -> None:
    """The host is a registrant too; role='host' on the event is what lets a
    count of students leave him out."""
    master, _ = await _user(client, db_session, 60123, master=True)
    practice, meeting = await _practice_with_meeting(db_session, master, "555000212")

    async def fake(**_kw) -> dict:
        return response

    monkeypatch.setattr(zoom_service, "create_registrant", fake)

    with capture_logs() as logs:
        await ensure_host_registrant(meeting, practice, db_session)

    events = _events(logs)
    if logged:
        assert len(events) == 1
        assert events[0]["role"] == ZoomRegistrantRole.HOST.value
        assert events[0]["booking_id"] is None
    else:
        assert events == []


@pytest.mark.asyncio
async def test_resolver_reads_do_not_log(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A read is not a transition: the screen is opened many times, the
    registrant is left without a link once."""
    master, _ = await _user(client, db_session, 60116, master=True)
    student, token = await _user(client, db_session, 60117)
    practice, meeting = await _practice_with_meeting(db_session, master, "555000210")
    await _booking_with_registrant(
        db_session, practice, meeting, student,
        status=ZoomRegistrantStatus.REGISTERED.value, join_url=None,
    )
    await db_session.commit()

    with capture_logs() as logs:
        for _ in range(3):
            resp = await client.get(
                f"/api/v1/practices/{practice.id}/zoom/resolve",
                headers=auth_headers(token),
            )
            assert resp.json()["kind"] == "unavailable"
        await client.get("/api/v1/bookings/me", headers=auth_headers(token))

    assert _events(logs) == []


# ===========================================================================
# 5. The ingest.
# ===========================================================================


@pytest.mark.asyncio
async def test_ingest_judges_only_registrants_zoom_could_have_seen(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One practice, one ingest, four students:

      linked     -- id + link, a report row above the threshold
                    -> attended via zoom_report (the pair: unchanged).
      no_url_ci  -- id, no link, PRE check-in -> attended via legacy_proxy.
      empty_url  -- id, link "" (falsy), nothing else -> no_show via
                    legacy_proxy, not via zoom_report.
      no_id      -- link, no id -> legacy_proxy: Zoom cannot attribute a
                    segment to him, so zero seconds back nothing.

    And the run's logs count them apart: three bookings without a link,
    none "unregistered"."""
    master, _ = await _user(client, db_session, 60118, master=True)
    users = [(await _user(client, db_session, 60119 + i))[0] for i in range(4)]
    practice, meeting = await _practice_with_meeting(db_session, master, "555000211")
    linked, _ = await _booking_with_registrant(
        db_session, practice, meeting, users[0],
        status=ZoomRegistrantStatus.REGISTERED.value, join_url=_LINK,
        zoom_registrant_id="reg-linked",
    )
    no_url_ci, _ = await _booking_with_registrant(
        db_session, practice, meeting, users[1],
        status=ZoomRegistrantStatus.REGISTERED.value, join_url=None,
        zoom_registrant_id="reg-no-url",
    )
    empty_url, _ = await _booking_with_registrant(
        db_session, practice, meeting, users[2],
        status=ZoomRegistrantStatus.REGISTERED.value, join_url="",
        zoom_registrant_id="reg-empty",
    )
    no_id, _ = await _booking_with_registrant(
        db_session, practice, meeting, users[3],
        status=ZoomRegistrantStatus.REGISTERED.value, join_url=_LINK,
        zoom_registrant_id=None,
    )
    db_session.add(
        Checkin(
            practice_id=practice.id, user_id=users[1].id,
            booking_id=no_url_ci.id, mood=5, check_type=CheckType.PRE.value,
        )
    )
    practice.scheduled_at = datetime.now(UTC) - timedelta(hours=2)
    practice.status = PracticeStatus.COMPLETED.value
    await db_session.flush()

    async def report(*, zoom_meeting_id: str, include_registrant_id: bool) -> list:
        return [{
            "registrant_id": "reg-linked",
            "user_email": "",
            "duration": practice.duration_minutes * 60,
            "join_time": "2026-10-01T10:00:00Z",
            "leave_time": "2026-10-01T11:00:00Z",
        }]

    monkeypatch.setattr(attendance_service, "get_participants_report", report)

    with capture_logs() as logs:
        ingested = await ingest_report_for_meeting(meeting, practice, db_session)
    await db_session.flush()

    assert ingested is True
    assert meeting.report_ingested_at is not None
    got = {}
    for booking in (linked, no_url_ci, empty_url, no_id):
        await db_session.refresh(booking)
        got[booking.id] = (booking.status, booking.attendance_decided_via)
    assert got == {
        linked.id: (BookingStatus.ATTENDED.value, "zoom_report"),
        no_url_ci.id: (BookingStatus.ATTENDED.value, "legacy_proxy"),
        empty_url.id: (BookingStatus.NO_SHOW.value, "legacy_proxy"),
        no_id.id: (BookingStatus.NO_SHOW.value, "legacy_proxy"),
    }

    proxied = [
        e for e in logs
        if e["event"] == "zoom_report_registrant_without_link_proxied"
    ]
    assert len(proxied) == 1
    assert proxied[0]["bookings_decided"] == 3
    assert sorted(proxied[0]["booking_ids"]) == sorted(
        str(b.id) for b in (no_url_ci, empty_url, no_id)
    )
    assert not [
        e for e in logs if e["event"] == "zoom_report_unregistered_bookings_decided"
    ]
    summary = next(e for e in logs if e["event"] == "zoom_report_ingested")
    assert summary["without_link_bookings_decided"] == 3
    assert summary["unregistered_bookings_decided"] == 0
    assert summary["bookings_decided"] == 1
