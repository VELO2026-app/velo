# =============================================================================
# VELO -- Tests: nothing CONFIRMED outlives a successful Zoom ingest (BE-41)
# =============================================================================
#
# telegram_id band: 60000-60049.
#
# BAND PROVENANCE. free_windows(space=(60000, 99999)) returned (60000, 64999)
# as its first window on 2026-09-24; 60050-64999 stays free.
#
# WHAT IS UNDER TEST
#
#   1. THE BOUND. ingest_report_for_meeting walks REGISTRANTS, so a
#      CONFIRMED booking no registrant points at never entered the loop --
#      and once report_ingested_at was set the poller never came back. The
#      booking stayed CONFIRMED forever. The ingest now decides every
#      remaining CONFIRMED booking via the legacy proxy before the stamp.
#      The way in is built for real, through the services, not by deleting
#      a row by hand: block -> unblock -> book again reuses the old
#      registrant, which still points at the cancelled booking.
#   2. PAGINATION. The report used to be read as its first page only
#      (page_size=300): everyone past row 300 became a no_show "via Zoom".
#      Now every page is read; a repeated token or the page cap is a
#      failure, never a truncated report.
#   3. 3001. "Meeting does not exist" is logged calmly and still leaves the
#      practice to the poller and the deadline -- whether 3001 can also mean
#      "still running" is unmeasured.
#
# Every "decided" assertion has its pair "and report_ingested_at is set";
# every "not ingested" has its pair "and the booking is still CONFIRMED".
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from structlog.testing import capture_logs

from app.core.config import settings
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.bookings.service import create_booking
from app.modules.masters.groups_service import block_student, unblock_student
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from app.modules.zoom import attendance_service, report_poller, zoom_client
from app.modules.zoom.attendance_service import ingest_report_for_meeting
from app.modules.zoom.models import (
    ZoomMeeting,
    ZoomMeetingStatus,
    ZoomRegistrant,
    ZoomRegistrantRole,
    ZoomRegistrantStatus,
)
from app.modules.zoom.zoom_client import ZoomAPIError, get_participants_report
from tests.helpers import full_cleanup_range, login_user

_TID_MIN = 60000
_TID_MAX = 60049


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
) -> User:
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
    return user


async def _future_practice_with_meeting(
    db_session: AsyncSession, master: User,
) -> tuple[Practice, ZoomMeeting]:
    """A bookable practice with an ACTIVE meeting -- so booking goes through
    the real create_registrant_for_booking (stub Zoom)."""
    practice = Practice(
        master_id=master.id,
        title="Ingest boundary",
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
        zoom_meeting_id="555000111",
        zoom_meeting_uuid="uuid-be41",
        status=ZoomMeetingStatus.ACTIVE.value,
    )
    db_session.add(meeting)
    await db_session.flush()
    return practice, meeting


async def _finish(db_session: AsyncSession, practice: Practice) -> None:
    """Move the practice into the past and complete it -- what the clock
    and the lifecycle worker do, compressed."""
    practice.scheduled_at = datetime.now(UTC) - timedelta(hours=2)
    practice.status = PracticeStatus.COMPLETED.value
    await db_session.flush()


def _report(monkeypatch: pytest.MonkeyPatch, rows: list[dict] | Exception) -> list:
    """Replace the report fetch as ingest sees it; returns the call log."""
    calls: list = []

    async def fake(*, zoom_meeting_id: str, include_registrant_id: bool) -> list[dict]:
        calls.append(include_registrant_id)
        if isinstance(rows, Exception):
            raise rows
        return rows

    monkeypatch.setattr(attendance_service, "get_participants_report", fake)
    return calls


async def _student_registrant(
    db_session: AsyncSession, meeting: ZoomMeeting, user: User,
) -> ZoomRegistrant:
    return (
        await db_session.execute(
            select(ZoomRegistrant).where(
                ZoomRegistrant.zoom_meeting_id == meeting.id,
                ZoomRegistrant.user_id == user.id,
                ZoomRegistrant.role == ZoomRegistrantRole.STUDENT.value,
            )
        )
    ).scalar_one()


# ===========================================================================
# 1. The bound: a booking no registrant points at.
# ===========================================================================


@pytest.mark.asyncio
async def test_rebooked_after_unblock_is_decided_not_left_confirmed(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The reachable way in, through the real services. The precondition
    asserts document the root (which this delivery does NOT fix): the
    reused registrant still points at the cancelled booking."""
    master = await _user(client, db_session, 60000, master=True)
    student = await _user(client, db_session, 60001)
    practice, meeting = await _future_practice_with_meeting(db_session, master)

    first = await create_booking(student, practice.id, session=db_session)
    await block_student(master.id, student.id, db_session)
    await unblock_student(master.id, student.id, db_session)
    second = await create_booking(student, practice.id, session=db_session)
    await db_session.flush()

    registrant = await _student_registrant(db_session, meeting, student)
    await db_session.refresh(first)
    assert first.status == BookingStatus.CANCELLED.value
    assert second.status == BookingStatus.CONFIRMED.value
    assert registrant.status != ZoomRegistrantStatus.CANCELLED.value
    assert registrant.booking_id == first.id  # the root: reused, not re-pointed

    await _finish(db_session, practice)
    # He really sat through it on the reused link -- which Zoom cannot tie
    # to this booking; the proxy decides it, the bound's documented cost.
    _report(monkeypatch, [
        {"registrant_id": registrant.zoom_registrant_id, "duration": 3600},
    ])

    ok = await ingest_report_for_meeting(meeting, practice, db_session)
    await db_session.flush()
    await db_session.refresh(second)
    await db_session.refresh(meeting)

    assert ok is True
    assert second.status in {BookingStatus.ATTENDED.value, BookingStatus.NO_SHOW.value}
    assert second.attendance_decided_via == "legacy_proxy"
    assert meeting.report_ingested_at is not None


@pytest.mark.asyncio
async def test_each_booking_is_decided_by_its_own_route(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A registrant-backed booking is decided via Zoom and is NOT touched by
    the proxy tail; a booking with no registrant is decided by the proxy.
    Four report rows for three people: the host twice (no registrant_id --
    normal, he enters by start_url), the student twice with one
    registrant_id, each half the threshold -- summed, he attended."""
    master = await _user(client, db_session, 60002, master=True)
    backed = await _user(client, db_session, 60003)
    orphan = await _user(client, db_session, 60004)
    practice, meeting = await _future_practice_with_meeting(db_session, master)
    backed_booking = await create_booking(backed, practice.id, session=db_session)
    orphan_booking = Booking(
        practice_id=practice.id, user_id=orphan.id,
        status=BookingStatus.CONFIRMED.value,
    )
    db_session.add(orphan_booking)
    await db_session.flush()
    registrant = await _student_registrant(db_session, meeting, backed)
    await _finish(db_session, practice)
    _report(monkeypatch, [
        {"user_email": "host@x", "duration": 3600},
        {"user_email": "host@x", "duration": 60},
        {"registrant_id": registrant.zoom_registrant_id, "duration": 900},
        {"registrant_id": registrant.zoom_registrant_id, "duration": 900},
    ])

    assert await ingest_report_for_meeting(meeting, practice, db_session) is True
    for obj in (backed_booking, orphan_booking, meeting):
        await db_session.refresh(obj)

    assert backed_booking.status == BookingStatus.ATTENDED.value
    assert backed_booking.attendance_decided_via == "zoom_report"
    assert backed_booking.zoom_minutes_present == 30
    assert orphan_booking.status == BookingStatus.NO_SHOW.value
    assert orphan_booking.attendance_decided_via == "legacy_proxy"
    assert meeting.report_ingested_at is not None


@pytest.mark.asyncio
async def test_empty_report_is_success_every_booking_decided(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """THE EMPTINESS AXIS: zero participants is an answer, not a failure."""
    master = await _user(client, db_session, 60005, master=True)
    backed = await _user(client, db_session, 60006)
    orphan = await _user(client, db_session, 60007)
    practice, meeting = await _future_practice_with_meeting(db_session, master)
    backed_booking = await create_booking(backed, practice.id, session=db_session)
    orphan_booking = Booking(
        practice_id=practice.id, user_id=orphan.id,
        status=BookingStatus.CONFIRMED.value,
    )
    db_session.add(orphan_booking)
    await _finish(db_session, practice)
    _report(monkeypatch, [])

    assert await ingest_report_for_meeting(meeting, practice, db_session) is True
    for obj in (backed_booking, orphan_booking, meeting):
        await db_session.refresh(obj)

    assert backed_booking.status == BookingStatus.NO_SHOW.value
    assert backed_booking.attendance_decided_via == "zoom_report"
    assert orphan_booking.status == BookingStatus.NO_SHOW.value
    assert orphan_booking.attendance_decided_via == "legacy_proxy"
    assert meeting.report_ingested_at is not None


@pytest.mark.asyncio
async def test_after_the_stamp_the_poller_never_calls_zoom_again(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """REPEAT: a second pass over an ingested practice is a no-op. Pair: the
    first pass did call Zoom and did stamp."""
    master = await _user(client, db_session, 60008, master=True)
    student = await _user(client, db_session, 60009)
    practice, meeting = await _future_practice_with_meeting(db_session, master)
    await create_booking(student, practice.id, session=db_session)
    await _finish(db_session, practice)
    calls = _report(monkeypatch, [])
    assert await ingest_report_for_meeting(meeting, practice, db_session) is True
    await db_session.commit()
    assert calls  # the first pass reached Zoom
    calls.clear()

    assert practice.id not in await report_poller._claim_eligible_practice_ids()
    assert await report_poller._process_one(practice.id) is False
    assert calls == []


# ===========================================================================
# 2. 3001 -- calm, and still not a closing.
# ===========================================================================


_CALM = "zoom_report_no_past_instance"
_LOUD = "zoom_report_fetch_failed"


@pytest.mark.parametrize(
    ("exc", "event"),
    [
        (
            ZoomAPIError(
                "x", status_code=404,
                body={"code": 3001, "message": "Meeting does not exist."},
            ),
            _CALM,
        ),
        (
            ZoomAPIError(
                "x", status_code=404,
                body={"code": 1001, "message": "User does not exist."},
            ),
            _LOUD,
        ),
        (ZoomAPIError("x", status_code=404, body="<html>3001</html>"), _LOUD),
        (ZoomAPIError("x", status_code=400, body={"code": 3001}), _LOUD),
        (ZoomAPIError("x", status_code=429, body={"code": 429}), _LOUD),
        (ZoomAPIError("Zoom API request failed: timed out"), _LOUD),
    ],
    ids=["3001", "other-404", "text-body", "3001-not-404", "429", "no-status"],
)
@pytest.mark.asyncio
async def test_failures_leave_the_practice_open_and_3001_is_calm(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
    exc: ZoomAPIError, event: str,
) -> None:
    """THE SHORTAGE AXIS. Only a 404 whose JSON body carries 3001 is the calm
    event; every failure -- 3001 included -- returns False, leaves the stamp
    empty and the booking CONFIRMED for the poller and the deadline."""
    master = await _user(client, db_session, 60010, master=True)
    student = await _user(client, db_session, 60011)
    practice, meeting = await _future_practice_with_meeting(db_session, master)
    booking = await create_booking(student, practice.id, session=db_session)
    await _finish(db_session, practice)
    _report(monkeypatch, exc)

    with capture_logs() as logs:
        ok = await ingest_report_for_meeting(meeting, practice, db_session)
    await db_session.refresh(booking)
    await db_session.refresh(meeting)

    assert ok is False
    assert meeting.report_ingested_at is None
    assert booking.status == BookingStatus.CONFIRMED.value
    events = [entry["event"] for entry in logs]
    assert event in events
    assert ({_CALM, _LOUD} - {event}).isdisjoint(events)
    level = next(e["log_level"] for e in logs if e["event"] == event)
    assert level == ("info" if event == _CALM else "warning")


# ===========================================================================
# 3. Pagination -- the client.
# ===========================================================================


def _pages(monkeypatch: pytest.MonkeyPatch, pages: list[dict]) -> list[dict]:
    """Serve `pages` in order to zoom_client._request; the last page is
    repeated if asked for more. Returns the params of every call."""
    seen: list[dict] = []

    async def fake(
        method: str, path: str, *, params: dict | None = None, **_: object,
    ) -> dict:
        seen.append(dict(params or {}))
        return pages[min(len(seen), len(pages)) - 1]

    monkeypatch.setattr(zoom_client, "_request", fake)
    return seen


@pytest.mark.parametrize("last_token", [None, "", "absent"])
@pytest.mark.asyncio
async def test_every_page_is_read_until_the_token_runs_out(
    monkeypatch: pytest.MonkeyPatch, last_token: str | None,
) -> None:
    last = {"participants": [{"n": 5}]}
    if last_token != "absent":
        last["next_page_token"] = last_token
    seen = _pages(monkeypatch, [
        {"participants": [{"n": 1}, {"n": 2}], "next_page_token": "t1"},
        {"participants": [{"n": 3}, {"n": 4}], "next_page_token": "t2"},
        last,
    ])

    rows = await get_participants_report(
        zoom_meeting_id="1", include_registrant_id=True,
    )

    assert [r["n"] for r in rows] == [1, 2, 3, 4, 5]
    assert [p.get("next_page_token") for p in seen] == [None, "t1", "t2"]
    assert all(p["page_size"] == 300 for p in seen)
    assert all(p["include_fields"] == "registrant_id" for p in seen)


@pytest.mark.asyncio
async def test_repeated_token_is_a_failure_not_a_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen = _pages(monkeypatch, [
        {"participants": [{"n": 1}], "next_page_token": "same"},
        {"participants": [{"n": 2}], "next_page_token": "same"},
    ])

    with pytest.raises(ZoomAPIError, match="repeated"):
        await get_participants_report(zoom_meeting_id="1", include_registrant_id=False)
    assert len(seen) == 2


@pytest.mark.asyncio
async def test_page_cap_with_a_token_pending_is_a_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Never a truncated report. Pair: at exactly the cap with NO token left,
    the report is returned whole (the next test)."""
    monkeypatch.setattr(settings, "zoom_report_max_pages", 3)
    seen: list[dict] = []

    async def endless(
        method: str, path: str, *, params: dict | None = None, **_: object,
    ) -> dict:
        seen.append(dict(params or {}))
        return {"participants": [{"n": len(seen)}], "next_page_token": f"t{len(seen)}"}

    monkeypatch.setattr(zoom_client, "_request", endless)

    with pytest.raises(ZoomAPIError, match="page cap"):
        await get_participants_report(zoom_meeting_id="1", include_registrant_id=False)
    assert len(seen) == 3


@pytest.mark.asyncio
async def test_a_report_of_exactly_the_cap_is_returned_whole(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "zoom_report_max_pages", 3)
    _pages(monkeypatch, [
        {"participants": [{"n": 1}], "next_page_token": "a"},
        {"participants": [{"n": 2}], "next_page_token": "b"},
        {"participants": [{"n": 3}]},
    ])

    rows = await get_participants_report(
        zoom_meeting_id="1", include_registrant_id=False,
    )

    assert [r["n"] for r in rows] == [1, 2, 3]


@pytest.mark.asyncio
async def test_student_on_the_second_page_is_attended_not_a_silent_no_show(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The defect pagination fixes, end to end: 300 unmatched rows fill page
    one, the student's own row is on page two. Read as one page, he was a
    no_show "via Zoom" -- decided, authoritative and wrong."""
    master = await _user(client, db_session, 60012, master=True)
    student = await _user(client, db_session, 60013)
    practice, meeting = await _future_practice_with_meeting(db_session, master)
    booking = await create_booking(student, practice.id, session=db_session)
    registrant = await _student_registrant(db_session, meeting, student)
    await _finish(db_session, practice)
    filler = [{"user_email": f"guest-{i}@x", "duration": 60} for i in range(300)]
    _pages(monkeypatch, [
        {"participants": filler, "next_page_token": "p2"},
        {"participants": [
            {"registrant_id": registrant.zoom_registrant_id, "duration": 3600},
        ]},
    ])

    assert await ingest_report_for_meeting(meeting, practice, db_session) is True
    await db_session.refresh(booking)
    await db_session.refresh(meeting)

    assert booking.status == BookingStatus.ATTENDED.value
    assert booking.attendance_decided_via == "zoom_report"
    assert meeting.report_ingested_at is not None
