# =============================================================================
# VELO -- Tests: the Zoom-side registrant cancel is made after commit, by the
# retry poller (BE-96)
# =============================================================================
#
# telegram_id band: 69900-69949.
#
# BAND PROVENANCE. 69800-69849 was taken first by test_curator_lock_order_500
# (BE-97, landed while BE-96 was being assembled). On 2026-10-01, on b8aa9cd,
# free_windows(space=(69700, 79299)) returned [(69900, 79299)], and
# 69900-69949 overlapped no declared band and no BLIND_ZONE cleanup range.
#
# WHAT IS UNDER TEST
#
#   cancel_registrant_for_booking used to call Zoom inside the caller's
#   transaction -- block_student held its practices and bookings FOR
#   UPDATE through N calls, cancel_booking its practice through one. Now it
#   sets our row cancelled + zoom_cancel_pending in that transaction and
#   zoom/retry_poller.py makes the call after commit.
#
#   1. No Zoom call ever runs while the practice row is locked -- asserted
#      AT the call: the fake Zoom cancel tries `FOR UPDATE NOWAIT` on the
#      practice from an independent connection. Inside the old in-
#      transaction call that fails with 55P03. For block_student and for
#      cancel_booking.
#   2. The race with a retry-poller create holding the row through its own
#      Zoom call: the cancel waits, lands on the committed row, and the
#      freshly created registrant is cancelled in Zoom too.
#   3. The cancel phase itself: what each Zoom answer does to the queue,
#      the cap, the claim, and a repeat after a lost commit.
#
# Rows of other files may sit queued in the same database, so these tests
# drive the phase for their OWN rows only (_cancel_registrant_one by id),
# and check the claim by membership, never by equality.
# =============================================================================

import asyncio
from collections.abc import AsyncGenerator, Awaitable, Callable
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_session_factory
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.bookings.service import cancel_booking, create_booking
from app.modules.masters.groups_service import block_student
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from app.modules.zoom import retry_poller, zoom_client
from app.modules.zoom import service as zoom_service
from app.modules.zoom.models import (
    ZoomMeeting,
    ZoomMeetingStatus,
    ZoomRegistrant,
    ZoomRegistrantStatus,
)
from app.modules.zoom.zoom_client import ZoomAPIError
from tests.helpers import full_cleanup_range, login_user

_TID_MIN = 69900
_TID_MAX = 69949

_LOCK_NOT_AVAILABLE = "55P03"


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


async def _practice(
    db_session: AsyncSession, master: User, *, meeting_status: str,
    hours_ahead: int = 3,
) -> Practice:
    practice = Practice(
        master_id=master.id,
        title="Zoom cancel after commit",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=PracticeStatus.SCHEDULED.value,
        scheduled_at=datetime.now(UTC) + timedelta(hours=hours_ahead),
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
    db_session.add(
        ZoomMeeting(
            practice_id=practice.id,
            zoom_meeting_id=f"be96-{practice.id.hex[:16]}",
            zoom_meeting_uuid=f"uuid-be96-{practice.id}",
            status=meeting_status,
        )
    )
    await db_session.flush()
    return practice


async def _registrant_of(
    db_session: AsyncSession, booking_id: UUID,
) -> ZoomRegistrant:
    return (
        await db_session.execute(
            select(ZoomRegistrant).where(ZoomRegistrant.booking_id == booking_id)
        )
    ).scalar_one()


async def _practice_is_lockable(practice_id: UUID) -> bool:
    """From an independent connection: can the practice row be taken FOR
    UPDATE right now? False when another transaction holds it."""
    async with get_session_factory()() as probe:
        try:
            await probe.execute(
                text("SELECT id FROM practices WHERE id = :id FOR UPDATE NOWAIT"),
                {"id": practice_id},
            )
            return True
        except DBAPIError as exc:
            orig = getattr(exc, "orig", None)
            state = getattr(orig, "sqlstate", None) or getattr(
                getattr(orig, "__cause__", None), "sqlstate", None,
            )
            assert state == _LOCK_NOT_AVAILABLE, exc
            return False
        finally:
            await probe.rollback()


def _zoom_cancel_watch(
    monkeypatch: pytest.MonkeyPatch, practice_id: UUID,
) -> list[tuple[str, bool]]:
    """Fake Zoom cancel, patched EVERYWHERE the call could be made from --
    the client module, the poller, and zoom.service should the call ever
    move back there. Records (zoom_registrant_id, practice lockable at the
    moment of the call)."""
    seen: list[tuple[str, bool]] = []

    async def fake(
        *, zoom_meeting_id: str, zoom_registrant_id: str, email: str, action: str,
    ) -> None:
        assert action == "cancel"
        seen.append((zoom_registrant_id, await _practice_is_lockable(practice_id)))

    monkeypatch.setattr(zoom_client, "update_registrant_status", fake)
    monkeypatch.setattr(retry_poller, "update_registrant_status", fake)
    monkeypatch.setattr(zoom_service, "update_registrant_status", fake, raising=False)
    return seen


def _zoom_answers(
    monkeypatch: pytest.MonkeyPatch, answer: BaseException | None,
) -> list[str]:
    """Fake Zoom cancel for the phase: records ids, raises `answer` if set."""
    calls: list[str] = []

    async def fake(
        *, zoom_meeting_id: str, zoom_registrant_id: str, email: str, action: str,
    ) -> None:
        calls.append(zoom_registrant_id)
        if answer is not None:
            raise answer

    monkeypatch.setattr(retry_poller, "update_registrant_status", fake)
    return calls


async def _booked_and_cancelled(
    client: AsyncClient, db_session: AsyncSession, tid: int,
) -> ZoomRegistrant:
    """A registered student whose booking was cancelled and committed: the
    row sits cancelled + queued, as a restarted poller finds it."""
    master = await _user(client, db_session, tid, master=True)
    student = await _user(client, db_session, tid + 1)
    practice = await _practice(
        db_session, master, meeting_status=ZoomMeetingStatus.ACTIVE.value,
    )
    booking = await create_booking(student, practice.id, session=db_session)
    await db_session.flush()
    await cancel_booking(booking.id, student, db_session)
    await db_session.commit()
    row = await _registrant_of(db_session, booking.id)
    assert row.status == ZoomRegistrantStatus.CANCELLED.value
    assert row.zoom_cancel_pending is True
    assert row.zoom_registrant_id
    return row


# ---------------------------------------------------------------------------
# 1. No Zoom call while the practice is locked
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_block_sends_the_zoom_cancel_only_after_releasing_the_practice(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """block_student makes no Zoom call inside its transaction; the poller's
    call comes after commit, with the practice free. Pair: the call is made
    -- exactly once, for the registrant the block cancelled."""
    master = await _user(client, db_session, 69900, master=True)
    student = await _user(client, db_session, 69901)
    practice = await _practice(
        db_session, master, meeting_status=ZoomMeetingStatus.ACTIVE.value,
    )
    booking = await create_booking(student, practice.id, session=db_session)
    await db_session.commit()
    row = await _registrant_of(db_session, booking.id)
    zoom_id, row_id = row.zoom_registrant_id, row.id

    seen = _zoom_cancel_watch(monkeypatch, practice.id)
    await block_student(master.id, student.id, db_session)
    await db_session.flush()
    assert seen == []  # nothing inside the block's transaction
    await db_session.commit()

    assert await retry_poller._cancel_registrant_one(row_id) is True
    assert seen == [(zoom_id, True)]


@pytest.mark.asyncio
async def test_cancel_booking_sends_the_zoom_cancel_only_after_releasing_the_practice(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Same claim for the student's own cancel_booking, which holds its
    practice FOR UPDATE (T-13) for its whole transaction."""
    master = await _user(client, db_session, 69902, master=True)
    student = await _user(client, db_session, 69903)
    practice = await _practice(
        db_session, master, meeting_status=ZoomMeetingStatus.ACTIVE.value,
    )
    booking = await create_booking(student, practice.id, session=db_session)
    await db_session.commit()
    row = await _registrant_of(db_session, booking.id)
    zoom_id, row_id = row.zoom_registrant_id, row.id

    seen = _zoom_cancel_watch(monkeypatch, practice.id)
    await cancel_booking(booking.id, student, db_session)
    await db_session.flush()
    assert seen == []
    await db_session.commit()

    assert await retry_poller._cancel_registrant_one(row_id) is True
    assert seen == [(zoom_id, True)]


# ---------------------------------------------------------------------------
# 2. The race with a retry-poller create
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cancel_racing_a_poller_create_still_cancels_the_new_registrant(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The registrant is pending (meeting not active at booking time); the
    meeting becomes active; the retry poller's create takes the row FOR
    UPDATE and is held inside its Zoom call. The student cancels meanwhile
    -- in his own session, seen WAITING on that row by Postgres. Released:
    the create commits a fresh id, the cancel lands on top of it writing
    only status and the queue flag -- the id survives, the flag is set, and
    the cancel phase cancels exactly that fresh registrant in Zoom."""
    master = await _user(client, db_session, 69904, master=True)
    student = await _user(client, db_session, 69905)
    practice = await _practice(
        db_session, master,
        meeting_status=ZoomMeetingStatus.PENDING_CREATION.value,
    )
    booking = await create_booking(student, practice.id, session=db_session)
    await db_session.flush()
    row = await _registrant_of(db_session, booking.id)
    assert row.status == ZoomRegistrantStatus.PENDING.value
    assert row.zoom_registrant_id is None
    meeting = await db_session.get(ZoomMeeting, row.zoom_meeting_id)
    meeting.status = ZoomMeetingStatus.ACTIVE.value
    await db_session.commit()
    row_id, booking_id = row.id, booking.id

    reached, release = asyncio.Event(), asyncio.Event()

    async def held_create(**_: object) -> dict:
        reached.set()
        await release.wait()
        return {
            "registrant_id": "be96-raced-id",
            "join_url": "https://zoom.test/j/raced",
        }

    monkeypatch.setattr(retry_poller, "create_registrant", held_create)
    create_task = asyncio.create_task(retry_poller._retry_registrant_one(row_id))
    await asyncio.wait_for(reached.wait(), 5)

    cancel_state: dict = {}
    cancel_task = asyncio.create_task(
        _in_own_session(lambda s: cancel_booking(booking_id, student, s), cancel_state)
    )
    assert await _wait_until_waiting_on_lock(cancel_state), (
        "cancel_booking never waited on the registrant row -- no race was built"
    )
    release.set()
    await asyncio.wait_for(asyncio.gather(create_task, cancel_task), 15)
    assert cancel_state["result"] == "committed", cancel_state.get("error")

    db_session.expire_all()
    stored = await _registrant_of(db_session, booking_id)
    assert stored.status == ZoomRegistrantStatus.CANCELLED.value
    assert stored.zoom_registrant_id == "be96-raced-id"
    assert stored.zoom_cancel_pending is True

    calls = _zoom_answers(monkeypatch, None)
    assert await retry_poller._cancel_registrant_one(row_id) is True
    assert calls == ["be96-raced-id"]
    stored_booking = await db_session.get(Booking, booking_id)
    assert stored_booking.status == BookingStatus.CANCELLED.value


async def _in_own_session(
    work: Callable[[AsyncSession], Awaitable[object]], state: dict,
) -> None:
    session = get_session_factory()()
    try:
        state["pid"] = (
            await session.execute(text("select pg_backend_pid()"))
        ).scalar_one()
        await work(session)
        await session.commit()
        state["result"] = "committed"
    except Exception as exc:  # asserted by the test
        await session.rollback()
        state["result"] = "error"
        state["error"] = exc
    finally:
        await session.close()


async def _wait_until_waiting_on_lock(state: dict) -> bool:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + 5.0
    while loop.time() < deadline:
        if "pid" in state:
            async with get_session_factory()() as probe:
                wait_type = (
                    await probe.execute(
                        text(
                            "select wait_event_type from pg_stat_activity "
                            "where pid = :p"
                        ),
                        {"p": state["pid"]},
                    )
                ).scalar_one_or_none()
            if wait_type == "Lock":
                return True
        await asyncio.sleep(0.05)
    return False


# ---------------------------------------------------------------------------
# 3. The cancel phase
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_claim_finds_a_queued_row_after_restart_and_skips_done_and_capped_ones(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Process died after the cancel committed, before any Zoom call: the
    next poller's claim finds the queued row. Pair: a row whose cancel is
    done, and a row at the cap, are not claimed."""
    queued = await _booked_and_cancelled(client, db_session, 69906)
    done = await _booked_and_cancelled(client, db_session, 69908)
    capped = await _booked_and_cancelled(client, db_session, 69910)
    done.zoom_cancel_pending = False
    capped.zoom_cancel_attempts = settings.zoom_registrant_cancel_max_retries
    await db_session.commit()

    claimed = set(await retry_poller._claim_cancel_pending_registrant_ids())
    assert queued.id in claimed
    assert done.id not in claimed
    assert capped.id not in claimed


@pytest.mark.asyncio
async def test_zoom_refusal_counts_and_stops_at_the_cap_visibly(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SHORTAGE axis: every attempt refused -> one count per attempt; at the
    cap the row stays queued and says so -- never cleared as if sent, never
    retried forever. Our status stays cancelled throughout."""
    row = await _booked_and_cancelled(client, db_session, 69912)
    row_id = row.id
    calls = _zoom_answers(
        monkeypatch, ZoomAPIError("stub refusal", status_code=500, body="down"),
    )
    cap = settings.zoom_registrant_cancel_max_retries
    for _ in range(cap):
        assert await retry_poller._cancel_registrant_one(row_id) is True

    await db_session.refresh(row)
    assert len(calls) == cap
    assert row.status == ZoomRegistrantStatus.CANCELLED.value
    assert row.zoom_cancel_pending is True
    assert row.zoom_cancel_attempts == cap
    assert "cancel cap reached" in row.last_sync_error
    assert row_id not in set(await retry_poller._claim_cancel_pending_registrant_ids())


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("answer", "pending", "attempts", "error_part"),
    [
        (None, False, 0, None),
        (ZoomAPIError("gone", status_code=404, body="3001"), False, 0, None),
        (ZoomAPIError("slow down", status_code=429, body="x"), True, 0, "429"),
        (RuntimeError("not a Zoom error"), True, 1, "non-Zoom-API"),
    ],
    ids=["success", "404-gone", "429-uncounted", "unexpected-counted"],
)
async def test_each_zoom_answer_does_what_the_phase_says(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
    answer: BaseException | None, pending: bool, attempts: int, error_part: str | None,
) -> None:
    """One attempt per Zoom answer: success and 404 clear the queue, 429
    keeps it uncounted, an unexpected error keeps it and counts."""
    row = await _booked_and_cancelled(client, db_session, 69914)
    calls = _zoom_answers(monkeypatch, answer)
    assert await retry_poller._cancel_registrant_one(row.id) is True

    await db_session.refresh(row)
    assert calls == [row.zoom_registrant_id]
    assert row.status == ZoomRegistrantStatus.CANCELLED.value
    assert row.zoom_cancel_pending is pending
    assert row.zoom_cancel_attempts == attempts
    if error_part is not None:
        assert error_part in row.last_sync_error


@pytest.mark.asyncio
async def test_lost_commit_repeats_the_call_once_then_the_row_is_done(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """REPEAT axis: Zoom accepted the cancel, the poller died before its
    commit -> the flag is still there and the next cycle sends it again;
    after that commit the row is done and a further cycle sends nothing."""
    row = await _booked_and_cancelled(client, db_session, 69916)
    row_id, zoom_id = row.id, row.zoom_registrant_id
    calls = _zoom_answers(monkeypatch, None)

    original = retry_poller._attempt_registrant_cancel

    async def dies_after_zoom_answered(r: ZoomRegistrant, s: AsyncSession) -> None:
        await original(r, s)
        raise RuntimeError("process died before commit")

    monkeypatch.setattr(
        retry_poller, "_attempt_registrant_cancel", dies_after_zoom_answered,
    )
    assert await retry_poller._cancel_registrant_one(row_id) is False
    await db_session.refresh(row)
    assert row.zoom_cancel_pending is True

    monkeypatch.setattr(retry_poller, "_attempt_registrant_cancel", original)
    assert await retry_poller._cancel_registrant_one(row_id) is True
    assert await retry_poller._cancel_registrant_one(row_id) is False
    await db_session.refresh(row)
    assert calls == [zoom_id, zoom_id]
    assert row.zoom_cancel_pending is False
