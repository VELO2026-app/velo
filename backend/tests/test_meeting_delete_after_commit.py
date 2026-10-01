# =============================================================================
# VELO -- Tests: the Zoom-side meeting DELETE is made after commit, by the
# retry poller
# =============================================================================
#
# telegram_id band: 70000-70049.
#
# BAND PROVENANCE. On 2026-10-01, on f883ba9,
# free_windows(space=(69700, 79299)) returned [(70000, 79299)].
#
# WHAT IS UNDER TEST
#
#   delete_meeting_for_practice used to make the Zoom DELETE inside the
#   practice cancel's transaction (practice + bookings FOR UPDATE) and set
#   `deleted` only on Zoom's success. Now an ACTIVE meeting's row goes
#   `deleted` + zoom_delete_pending in the cancel's transaction
#   (attendance-segments skip aside), and zoom/retry_poller.py makes the
#   DELETE after commit.
#
#   1. No DELETE while the practice row is locked -- asserted AT the call:
#      the fake DELETE tries `FOR UPDATE NOWAIT` on the practice from an
#      independent connection.
#   2. The phase: each Zoom answer, the cap, a repeat after a lost commit.
#   3. The host link dies on our pages at once, whatever Zoom answers.
#
#   NOT under test: a meeting still pending_creation / create_failed is
#   left alone by the cancel (as before), and the retry poller can still
#   create it for the cancelled practice -- a known, open hole.
#
# Rows of other files may sit queued in the same database: the phases are
# driven for this file's own rows only, by id.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_session_factory
from app.core.exceptions import BadRequestError
from app.modules.masters.models import MasterProfile
from app.modules.practices.cancel_service import cancel_practice
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from app.modules.zoom import retry_poller, zoom_client
from app.modules.zoom import service as zoom_service
from app.modules.zoom.models import (
    ZoomAttendanceSegment,
    ZoomMeeting,
    ZoomMeetingStatus,
)
from app.modules.zoom.zoom_client import ZoomAPIError
from tests.helpers import full_cleanup_range, login_user

_TID_MIN = 70000
_TID_MAX = 70049

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


async def _master(client: AsyncClient, db_session: AsyncSession, tid: int) -> User:
    auth = await login_user(client, telegram_id=tid, first_name=f"M{tid}")
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    user.role = UserRole.MASTER.value
    db_session.add(
        MasterProfile(
            user_id=user.id,
            data={"account": {"status": "verified"}, "profile": {"display_name": "M"}},
        )
    )
    await db_session.flush()
    return user


async def _practice(
    db_session: AsyncSession, master: User, *, meeting_status: str,
    with_zoom_id: bool, hours_ahead: int = 3,
) -> tuple[Practice, ZoomMeeting]:
    practice = Practice(
        master_id=master.id,
        title="Meeting delete after commit",
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
    meeting = ZoomMeeting(
        practice_id=practice.id,
        zoom_meeting_id=f"bf01-{practice.id.hex[:16]}" if with_zoom_id else None,
        zoom_meeting_uuid=f"uuid-bf01-{practice.id}" if with_zoom_id else None,
        status=meeting_status,
    )
    db_session.add(meeting)
    await db_session.flush()
    return practice, meeting


async def _practice_is_lockable(practice_id: UUID) -> bool:
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


def _watch_delete(
    monkeypatch: pytest.MonkeyPatch, practice_id: UUID | None,
    *, answer: BaseException | None = None,
) -> list[tuple[str, bool | None]]:
    """Fake Zoom meeting DELETE, patched everywhere it could be made from.
    Records (zoom_meeting_id, practice lockable at the call -- None when no
    practice is watched); raises `answer` if given."""
    seen: list[tuple[str, bool | None]] = []

    async def fake(*, zoom_meeting_id: str) -> None:
        lockable = None
        if practice_id is not None:
            lockable = await _practice_is_lockable(practice_id)
        seen.append((zoom_meeting_id, lockable))
        if answer is not None:
            raise answer

    monkeypatch.setattr(zoom_client, "delete_meeting", fake)
    monkeypatch.setattr(retry_poller, "delete_meeting", fake)
    monkeypatch.setattr(zoom_service, "delete_meeting", fake, raising=False)
    return seen


async def _cancelled_active(
    client: AsyncClient, db_session: AsyncSession, tid: int,
) -> ZoomMeeting:
    """An active, created meeting whose practice was cancelled and
    committed: the row sits deleted + queued, as a restarted poller finds
    it."""
    master = await _master(client, db_session, tid)
    practice, meeting = await _practice(
        db_session, master, meeting_status=ZoomMeetingStatus.ACTIVE.value,
        with_zoom_id=True,
    )
    await cancel_practice(practice.id, master, db_session)
    await db_session.commit()
    await db_session.refresh(meeting)
    assert meeting.status == ZoomMeetingStatus.DELETED.value
    assert meeting.zoom_delete_pending is True
    return meeting


# ---------------------------------------------------------------------------
# 1. No DELETE while the practice is locked
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cancel_sends_the_delete_only_after_releasing_the_practice(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No DELETE inside the practice cancel; the poller's DELETE comes after
    commit with the practice free, exactly once. Pair: the master's other
    practice keeps its active, unqueued meeting."""
    master = await _master(client, db_session, 70000)
    practice, meeting = await _practice(
        db_session, master, meeting_status=ZoomMeetingStatus.ACTIVE.value,
        with_zoom_id=True,
    )
    _other, other_meeting = await _practice(
        db_session, master, meeting_status=ZoomMeetingStatus.ACTIVE.value,
        with_zoom_id=True, hours_ahead=9,
    )
    await db_session.commit()
    zoom_id, meeting_id = meeting.zoom_meeting_id, meeting.id

    seen = _watch_delete(monkeypatch, practice.id)
    await cancel_practice(practice.id, master, db_session)
    await db_session.flush()
    assert seen == []  # nothing inside the practice cancel
    await db_session.refresh(meeting)
    assert meeting.status == ZoomMeetingStatus.DELETED.value
    assert meeting.zoom_delete_pending is True
    await db_session.commit()

    assert await retry_poller._delete_meeting_one(meeting_id) is True
    assert seen == [(zoom_id, True)]
    await db_session.refresh(meeting)
    await db_session.refresh(other_meeting)
    assert meeting.zoom_delete_pending is False
    assert other_meeting.status == ZoomMeetingStatus.ACTIVE.value
    assert other_meeting.zoom_delete_pending is False


@pytest.mark.asyncio
async def test_meeting_with_attendance_segments_is_left_alone(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The segments skip is unchanged: such a meeting is neither marked nor
    queued, and no DELETE is ever made for it. Pair: the practice itself is
    cancelled."""
    master = await _master(client, db_session, 70001)
    practice, meeting = await _practice(
        db_session, master, meeting_status=ZoomMeetingStatus.ACTIVE.value,
        with_zoom_id=True,
    )
    db_session.add(ZoomAttendanceSegment(zoom_meeting_id=meeting.id))
    await db_session.commit()

    seen = _watch_delete(monkeypatch, practice.id)
    await cancel_practice(practice.id, master, db_session)
    await db_session.commit()
    await db_session.refresh(meeting)
    await db_session.refresh(practice)

    assert practice.status == PracticeStatus.CANCELLED.value
    assert meeting.status == ZoomMeetingStatus.ACTIVE.value
    assert meeting.zoom_delete_pending is False
    assert meeting.id not in set(await retry_poller._claim_delete_pending_meeting_ids())
    assert seen == []


# ---------------------------------------------------------------------------
# 2. The delete phase
# ---------------------------------------------------------------------------


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
async def test_each_zoom_answer_does_what_the_delete_phase_says(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
    answer: BaseException | None, pending: bool, attempts: int, error_part: str | None,
) -> None:
    meeting = await _cancelled_active(client, db_session, 70004)
    seen = _watch_delete(monkeypatch, None, answer=answer)
    assert await retry_poller._delete_meeting_one(meeting.id) is True

    await db_session.refresh(meeting)
    assert [z for z, _ in seen] == [meeting.zoom_meeting_id]
    assert meeting.status == ZoomMeetingStatus.DELETED.value
    assert meeting.zoom_delete_pending is pending
    assert meeting.zoom_delete_attempts == attempts
    if error_part is not None:
        assert error_part in meeting.last_sync_error


@pytest.mark.asyncio
async def test_zoom_refusal_counts_and_stops_at_the_cap_visibly(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SHORTAGE axis: every DELETE refused -> one count per attempt; at the
    cap the row stays queued and says so, and the claim no longer picks
    it. Our status stays deleted throughout."""
    meeting = await _cancelled_active(client, db_session, 70005)
    meeting_id = meeting.id
    seen = _watch_delete(
        monkeypatch, None,
        answer=ZoomAPIError("stub refusal", status_code=500, body="down"),
    )
    cap = settings.zoom_meeting_delete_max_retries
    for _ in range(cap):
        assert await retry_poller._delete_meeting_one(meeting_id) is True

    await db_session.refresh(meeting)
    assert len(seen) == cap
    assert meeting.status == ZoomMeetingStatus.DELETED.value
    assert meeting.zoom_delete_pending is True
    assert meeting.zoom_delete_attempts == cap
    assert "delete cap reached" in meeting.last_sync_error
    assert meeting_id not in set(await retry_poller._claim_delete_pending_meeting_ids())


@pytest.mark.asyncio
async def test_queued_after_restart_lost_commit_repeats_once_then_done(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """REPEAT axis. The process died after the cancel committed: the next
    claim finds the row. Zoom then accepted the DELETE but the poller died
    before its commit: the next cycle sends it again; after that commit a
    further cycle sends nothing. And cancelling the practice a second time
    is refused and queues nothing."""
    meeting = await _cancelled_active(client, db_session, 70006)
    meeting_id, zoom_id = meeting.id, meeting.zoom_meeting_id
    assert meeting_id in set(await retry_poller._claim_delete_pending_meeting_ids())
    seen = _watch_delete(monkeypatch, None)

    original = retry_poller._attempt_meeting_delete

    async def dies_after_zoom_answered(row: ZoomMeeting) -> None:
        await original(row)
        raise RuntimeError("process died before commit")

    monkeypatch.setattr(
        retry_poller, "_attempt_meeting_delete", dies_after_zoom_answered,
    )
    assert await retry_poller._delete_meeting_one(meeting_id) is False
    await db_session.refresh(meeting)
    assert meeting.zoom_delete_pending is True

    monkeypatch.setattr(retry_poller, "_attempt_meeting_delete", original)
    assert await retry_poller._delete_meeting_one(meeting_id) is True
    assert await retry_poller._delete_meeting_one(meeting_id) is False
    assert [z for z, _ in seen] == [zoom_id, zoom_id]

    practice = await db_session.get(Practice, meeting.practice_id)
    master = await db_session.get(User, practice.master_id)
    with pytest.raises(BadRequestError):
        await cancel_practice(meeting.practice_id, master, db_session)
    await db_session.rollback()
    await db_session.refresh(meeting)
    assert meeting.zoom_delete_pending is False
    assert meeting.zoom_delete_attempts == 0


# ---------------------------------------------------------------------------
# 3. The host link
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_host_link_dies_on_our_pages_at_once_even_if_zoom_refuses(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Behaviour change, named at the gate: the master's host link of a
    cancelled practice is no longer served from the cancel on, whatever
    Zoom answers to the DELETE later. Until this delivery a refused DELETE
    left the meeting active and the link resolving. Pair: before the cancel
    it resolves."""
    master = await _master(client, db_session, 70007)
    practice, meeting = await _practice(
        db_session, master, meeting_status=ZoomMeetingStatus.ACTIVE.value,
        with_zoom_id=True,
    )
    await zoom_service.ensure_host_registrant(meeting, practice, db_session)
    await db_session.commit()
    assert await zoom_service.get_host_join_url(practice.id, db_session)

    _watch_delete(
        monkeypatch, None,
        answer=ZoomAPIError("stub refusal", status_code=500, body="down"),
    )
    await cancel_practice(practice.id, master, db_session)
    await db_session.commit()
    assert await zoom_service.get_host_join_url(practice.id, db_session) is None

    assert await retry_poller._delete_meeting_one(meeting.id) is True
    assert await zoom_service.get_host_join_url(practice.id, db_session) is None
