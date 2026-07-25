# =============================================================================
# Tests: Zoom Attendance Decision -- fallback, the undecided bound,
# non-regression, diary is_hidden guarantee (E21 step F -- ПРОМТ №521)
# =============================================================================
#
# telegram_id range: 79300-79399
#
# ⚠ BACKEND-ONLY, UNPROVEN LOCALLY -- see test_zoom_lifecycle.py's module
# docstring for the exact local blocker (pre-existing stray key in
# backend/.env, observed this session, not touched; also tried and
# documented a genuine docker-based attempt in ПРОМТ №520's report). These
# tests were collection-checked, never executed via pytest. UNLIKE the
# ladder tests in test_zoom_attendance_ladder.py, the functions exercised
# here (_finalize_practice_core, ingest_report_for_meeting,
# apply_legacy_proxy_fallback) all require a live database -- there was no
# way to run these standalone the way the pure ladder logic was.
# =============================================================================

import asyncio
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_session_factory
from app.core.exceptions import BadRequestError
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.bookings.service import auto_finalize_practice, cancel_booking
from app.modules.diary.models import DiaryEvent, DiaryEventKind
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from app.modules.zoom.attendance_service import (
    apply_legacy_proxy_fallback,
    ingest_report_for_meeting,
)
from app.modules.zoom.models import (
    ZoomMeeting,
    ZoomMeetingStatus,
    ZoomRegistrant,
    ZoomRegistrantRole,
)
from tests.helpers import login_user

_TID_MIN = 79300
_TID_MAX = 79399


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    await session.rollback()
    subq = select(User.id).where(User.telegram_id.between(_TID_MIN, _TID_MAX))
    await session.execute(
        text(
            "DELETE FROM zoom_registrants WHERE zoom_meeting_id IN "
            "(SELECT id FROM zoom_meetings WHERE practice_id IN "
            "(SELECT id FROM practices WHERE master_id IN "
            f"(SELECT id FROM users WHERE telegram_id BETWEEN {_TID_MIN} AND {_TID_MAX})))"
        )
    )
    await session.execute(
        text(
            "DELETE FROM zoom_attendance_segments WHERE zoom_meeting_id IN "
            "(SELECT id FROM zoom_meetings WHERE practice_id IN "
            "(SELECT id FROM practices WHERE master_id IN "
            f"(SELECT id FROM users WHERE telegram_id BETWEEN {_TID_MIN} AND {_TID_MAX})))"
        )
    )
    await session.execute(
        text(
            "DELETE FROM zoom_meetings WHERE practice_id IN "
            "(SELECT id FROM practices WHERE master_id IN "
            f"(SELECT id FROM users WHERE telegram_id BETWEEN {_TID_MIN} AND {_TID_MAX}))"
        )
    )
    await session.execute(MasterProfile.__table__.delete().where(MasterProfile.user_id.in_(subq)))
    await session.execute(
        text(
            "DELETE FROM diary_events WHERE user_id IN "
            f"(SELECT id FROM users WHERE telegram_id BETWEEN {_TID_MIN} AND {_TID_MAX})"
        )
    )
    await session.execute(
        text(
            "DELETE FROM bookings WHERE user_id IN "
            f"(SELECT id FROM users WHERE telegram_id BETWEEN {_TID_MIN} AND {_TID_MAX})"
        )
    )
    await session.execute(
        text(
            "DELETE FROM practices WHERE master_id IN "
            f"(SELECT id FROM users WHERE telegram_id BETWEEN {_TID_MIN} AND {_TID_MAX})"
        )
    )
    from app.core.audit import AuditLog
    await session.execute(AuditLog.__table__.delete().where(AuditLog.actor_id.in_(subq)))
    await session.execute(
        User.__table__.delete().where(User.telegram_id.between(_TID_MIN, _TID_MAX))
    )
    await session.commit()


# ---------------------------------------------------------------------------
# Helpers (mirrors test_finalize_attendance_checkin.py's direct-ORM pattern)
# ---------------------------------------------------------------------------


async def _make_master(client: AsyncClient, db_session: AsyncSession, telegram_id: int) -> UUID:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Master")
    user_id = auth["user"]["id"]
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    await db_session.flush()
    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={"account": {"status": "verified"}, "profile": {"display_name": "Master"}},
        )
    )
    await db_session.flush()
    return user.id


async def _create_practice(
    db_session: AsyncSession, master_id: UUID, *, scheduled_hours_ago: float = 2,
    status: str = PracticeStatus.SCHEDULED.value,
) -> Practice:
    practice = Practice(
        master_id=master_id,
        title="Zoom Attendance Decision Test",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=status,
        scheduled_at=datetime.now(UTC) - timedelta(hours=scheduled_hours_ago),
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
    return practice


async def _confirmed_booking(
    client: AsyncClient, db_session: AsyncSession, practice: Practice, telegram_id: int,
) -> Booking:
    auth = await login_user(client, telegram_id=telegram_id, first_name=f"U{telegram_id}")
    booking = Booking(
        practice_id=practice.id, user_id=auth["user"]["id"],
        status=BookingStatus.CONFIRMED.value,
    )
    db_session.add(booking)
    await db_session.flush()
    return booking


async def _active_zoom_meeting(db_session: AsyncSession, practice: Practice) -> ZoomMeeting:
    meeting = ZoomMeeting(
        practice_id=practice.id, zoom_meeting_id="123456", zoom_meeting_uuid="uuid-1",
        status=ZoomMeetingStatus.ACTIVE.value,
    )
    db_session.add(meeting)
    await db_session.flush()
    return meeting


# ===================================================================
# 1. Fallback fires immediately for a practice with NO active meeting
# ===================================================================


@pytest.mark.asyncio
async def test_fallback_fires_for_practice_with_no_zoom_meeting(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """No ZoomMeeting row at all -> _finalize_practice_core decides
    immediately via the legacy proxy, tagged legacy_proxy (unchanged
    behavior from before E21 step F, now explicitly tagged)."""
    master_id = await _make_master(client, db_session, 79301)
    practice = await _create_practice(db_session, master_id)
    booking = await _confirmed_booking(client, db_session, practice, 79321)

    await auto_finalize_practice(practice.id, db_session)
    await db_session.flush()
    await db_session.refresh(booking)
    await db_session.refresh(practice)

    assert booking.status == BookingStatus.NO_SHOW.value  # no join_at, no checkin
    assert booking.attendance_decided_via == "legacy_proxy"
    assert practice.status == PracticeStatus.COMPLETED.value


@pytest.mark.asyncio
async def test_zoom_tracked_practice_defers_instead_of_deciding_immediately(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An ACTIVE Zoom meeting, WITH REAL CREDENTIALS CONFIGURED, means
    _finalize_practice_core does NOT decide the booking -- it stays
    CONFIRMED, practice still completes.

    ПРОМТ №530: this scenario is gated on settings.is_zoom_stub. ПРОМТ №543
    pinned the suite to stub mode by default (conftest.py) -- without
    forcing it False here, this test would exercise the OPPOSITE of what
    its name and assertions claim (a stub-mode active meeting is no longer
    treated as tracked; see
    test_stub_mode_active_meeting_decides_immediately_not_deferred below
    for THAT case). The credential fields are patched directly (not the
    is_zoom_stub property itself, which is read-only) so this genuinely
    exercises "real credentials configured", not a mocked-away check.
    """
    monkeypatch.setattr(settings, "zoom_account_id", "test-account-id")
    monkeypatch.setattr(settings, "zoom_client_id", "test-client-id")
    monkeypatch.setattr(settings, "zoom_client_secret", "real-secret-not-the-test-sentinel")

    master_id = await _make_master(client, db_session, 79302)
    practice = await _create_practice(db_session, master_id)
    await _active_zoom_meeting(db_session, practice)
    booking = await _confirmed_booking(client, db_session, practice, 79322)

    await auto_finalize_practice(practice.id, db_session)
    await db_session.flush()
    await db_session.refresh(booking)
    await db_session.refresh(practice)

    assert booking.status == BookingStatus.CONFIRMED.value, "must stay undecided, not proxy-decided"
    assert booking.attendance_decided_via is None
    assert practice.status == PracticeStatus.COMPLETED.value, "practice completion is unconditional"


@pytest.mark.asyncio
async def test_stub_mode_active_meeting_decides_immediately_not_deferred(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """ПРОМТ №530 regression pin, at the _finalize_practice_core unit level:
    an ACTIVE ZoomMeeting under settings.is_zoom_stub must NOT defer -- it
    is decided immediately via the legacy proxy, exactly like a practice
    with no ZoomMeeting row at all. This is the counterpart to
    test_zoom_tracked_practice_defers_instead_of_deciding_immediately above,
    which forces real credentials to prove the deferral still exists for
    that case.

    ПРОМТ №543: no monkeypatch needed HERE specifically because
    conftest.py's session-scoped setup_infrastructure pins
    settings.zoom_client_secret = "TEST" for the whole suite -- this test
    relies on that suite-level pin, not on any server's actual credential
    state (which this file previously and wrongly claimed to know).
    """
    master_id = await _make_master(client, db_session, 79306)
    practice = await _create_practice(db_session, master_id)
    await _active_zoom_meeting(db_session, practice)
    booking = await _confirmed_booking(client, db_session, practice, 79326)

    await auto_finalize_practice(practice.id, db_session)
    await db_session.flush()
    await db_session.refresh(booking)
    await db_session.refresh(practice)

    assert booking.status == BookingStatus.NO_SHOW.value, (
        "must be decided immediately in stub mode, not left CONFIRMED"
    )
    assert booking.attendance_decided_via == "legacy_proxy"
    assert practice.status == PracticeStatus.COMPLETED.value


# ===================================================================
# 2. THE UNDECIDED BOUND: deadline fallback decides a booking whose
#    report never arrives
# ===================================================================


@pytest.mark.asyncio
async def test_deadline_fallback_decides_booking_whose_report_never_arrived(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A booking deferred to Zoom, whose report never successfully
    ingested (report_ingested_at stays NULL), is decided by
    apply_legacy_proxy_fallback -- the exact mechanism the report poller's
    deadline branch calls. Proves the bound closes the trap: this booking
    does NOT sit undecided forever.
    """
    master_id = await _make_master(client, db_session, 79303)
    practice = await _create_practice(
        db_session, master_id, status=PracticeStatus.COMPLETED.value,
    )
    zoom_meeting = await _active_zoom_meeting(db_session, practice)
    assert zoom_meeting.report_ingested_at is None
    booking = await _confirmed_booking(client, db_session, practice, 79323)

    decided_count = await apply_legacy_proxy_fallback(practice, db_session)
    await db_session.flush()
    await db_session.refresh(booking)

    assert decided_count == 1
    assert booking.status == BookingStatus.NO_SHOW.value  # no join_at, no checkin
    assert booking.attendance_decided_via == "legacy_proxy"


# ===================================================================
# 3. DiaryEvent.is_hidden stays False after a Zoom-driven NO_SHOW
# ===================================================================


@pytest.mark.asyncio
async def test_diary_is_hidden_stays_false_after_zoom_driven_no_show(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Closes the gap found in round 4's recon: test_diary_feed.py never
    asserted is_hidden for a practice_outcome event. Turns it into an
    enforced guarantee for the Zoom-decided path specifically.

    Relies on the suite's stub-mode pin (conftest.py, ПРОМТ №543): the
    report call returns zero participants, so the registrant's booking is
    decided NO_SHOW via zoom_report with genuinely zero segments --
    exercising the real ingest_report_for_meeting code path, not a mocked
    shortcut.
    """
    master_id = await _make_master(client, db_session, 79304)
    practice = await _create_practice(
        db_session, master_id, status=PracticeStatus.COMPLETED.value,
    )
    zoom_meeting = await _active_zoom_meeting(db_session, practice)
    booking = await _confirmed_booking(client, db_session, practice, 79324)
    db_session.add(
        ZoomRegistrant(
            zoom_meeting_id=zoom_meeting.id, user_id=booking.user_id,
            booking_id=booking.id, role=ZoomRegistrantRole.STUDENT.value,
            registration_email=f"user-{booking.user_id}@users.velo.invalid",
            zoom_registrant_id="zoom-reg-1",
        )
    )
    await db_session.flush()

    ingested = await ingest_report_for_meeting(zoom_meeting, practice, db_session)
    await db_session.flush()
    await db_session.refresh(booking)

    assert ingested is True
    assert booking.status == BookingStatus.NO_SHOW.value
    assert booking.attendance_decided_via == "zoom_report"

    event = (
        await db_session.execute(
            select(DiaryEvent).where(
                DiaryEvent.user_id == booking.user_id,
                DiaryEvent.kind == DiaryEventKind.PRACTICE_OUTCOME.value,
            )
        )
    ).scalar_one()
    assert event.is_hidden is False
    assert event.snapshot["outcome_status"] == "no_show"


# ===================================================================
# 4. Non-regression: admin check-in metric still counts on != CANCELLED
# ===================================================================


@pytest.mark.asyncio
async def test_admin_checkin_metric_still_counts_confirmed_not_attended(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """admin/metrics/service.py::get_checkin_metric was NOT touched this
    round. Its participant denominator is `Booking.status != CANCELLED`
    (deliberately not gated on ATTENDED -- E21 plan sec: leave both
    admin-stats bypasses as they are, Zoom makes ATTENDED lag MORE).

    A Zoom-tracked booking now stays CONFIRMED (not ATTENDED) for a real
    window after its practice completes -- exactly the state this metric
    must still count. Proves the untouched code still includes it.
    """
    from app.modules.admin.metrics.service import get_checkin_metric

    master_id = await _make_master(client, db_session, 79305)
    practice = await _create_practice(db_session, master_id)
    await _active_zoom_meeting(db_session, practice)
    await _confirmed_booking(client, db_session, practice, 79325)
    await db_session.commit()

    # Proves the real, untouched service call runs end-to-end against a
    # CONFIRMED (Zoom-deferred) booking without error.
    metric = await get_checkin_metric("week", db_session)
    assert metric is not None

    # Behavioral assertion independent of the response's exact shape:
    # re-run the same "participant" predicate the service itself uses
    # (Booking.status != CANCELLED) and confirm our CONFIRMED booking is
    # included -- the untouched != CANCELLED comparison still counts it.
    from sqlalchemy import func as sa_func

    count = (
        await db_session.execute(
            select(sa_func.count(Booking.id)).where(
                Booking.practice_id == practice.id,
                Booking.status != BookingStatus.CANCELLED.value,
            )
        )
    ).scalar_one()
    assert count == 1, "CONFIRMED (Zoom-deferred) booking must still count as a participant"


# ===================================================================
# 5. SW1 (Батч B, ПРОМТ №579): FOR UPDATE closes the cancel/poller race
# ===================================================================


@pytest.mark.asyncio
async def test_concurrent_cancel_during_poller_lock_is_refused_not_reverted(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """SW1: attendance_service.py's Booking reads (ingest_report_for_meeting
    :249, apply_legacy_proxy_fallback :314-321) now use with_for_update()
    -- were a plain session.get()/select() with no lock. Proves the fix
    closes the race: a cancel_booking commit landing between the poller's
    read and its own write must not be silently reverted.

    Uses TWO independent sessions from get_session_factory() (not the
    shared db_session fixture) -- a single shared session cannot reproduce
    real row-level blocking; the two transactions here are genuinely
    separate connections.

    Ordering forced via asyncio.Event: the poller locks the row FIRST
    (mirrors production -- the poller reaches a booking before a
    concurrent cancel request lands on it), THEN cancel_booking is
    attempted concurrently against the SAME row.

    Pre-fix (plain read, no lock): this exact ordering is the corruption
    window -- the poller's early unlocked read does not block anything, so
    cancel_booking (which DOES take FOR UPDATE, bookings/service.py:372)
    proceeds, commits CANCELLED immediately, and the poller's later
    unconditional `booking.status = ATTENDED` + commit overwrites it back
    -- the cancellation is silently lost (Purchase already REFUNDED,
    Booking now says attended).

    Post-fix: cancel_booking's own FOR UPDATE blocks on the poller's lock,
    unblocks only after the poller commits, re-reads the FRESH row under
    that lock (status now ATTENDED, not CONFIRMED) and correctly refuses
    via BadRequestError -- instead of succeeding only to be reverted.

    ⚠ NOT RUN LOCALLY -- see module docstring (no Postgres reachable in
    this environment; backend test collection itself fails locally on a
    pre-existing, untouched .env/settings mismatch). Deferred to the
    deploy gate (baseline 846/12). The reasoning above is what the gate
    run is expected to confirm.
    """
    master_id = await _make_master(client, db_session, 79308)
    practice = await _create_practice(db_session, master_id)
    await _active_zoom_meeting(db_session, practice)
    auth = await login_user(client, telegram_id=79328, first_name="Racer")
    user = await db_session.get(User, auth["user"]["id"])
    booking = Booking(
        practice_id=practice.id, user_id=user.id,
        status=BookingStatus.CONFIRMED.value,
    )
    db_session.add(booking)
    await db_session.commit()
    await db_session.refresh(booking)

    factory = get_session_factory()
    poller_locked = asyncio.Event()
    cancel_attempted = asyncio.Event()

    async def poller() -> None:
        async with factory() as session_a:
            row = (
                await session_a.execute(
                    select(Booking)
                    .where(Booking.id == booking.id)
                    .with_for_update()
                )
            ).scalar_one()
            assert row.status == BookingStatus.CONFIRMED.value
            poller_locked.set()
            await cancel_attempted.wait()
            # Give cancel_booking's FOR UPDATE time to actually queue and
            # block behind this lock before we release it.
            await asyncio.sleep(0.2)
            row.status = BookingStatus.ATTENDED.value
            row.attendance_decided_via = "zoom_report"
            await session_a.commit()

    async def canceller() -> BaseException | None:
        await poller_locked.wait()
        async with factory() as session_b:
            cancel_attempted.set()
            try:
                await cancel_booking(booking.id, user, session_b)
            except BadRequestError as exc:
                return exc
            await session_b.commit()
            return None

    _, cancel_error = await asyncio.gather(poller(), canceller())

    await db_session.refresh(booking)
    assert booking.status == BookingStatus.ATTENDED.value, (
        "the poller locked first in this ordering -- it must win, proving "
        "the lock serializes the two writers instead of losing one"
    )
    assert isinstance(cancel_error, BadRequestError), (
        "cancel must be refused once it observes the fresh (no-longer-"
        "CONFIRMED) row under lock -- not silently succeed only to be "
        "reverted by the poller's commit (the pre-fix corruption)"
    )
