# =============================================================================
# VELO Backend -- Tests: Diary Feed (Diary redesign iteration)
# =============================================================================
#
# telegram_id range: 90000-90999
#   90001-90099 -- regular users (feed owners)
#   90100-90199 -- second users (isolation checks)
#   90900-90999 -- master users
#
# Coverage:
#   - Projection on booking create  -> booking_confirmed event in feed
#   - Projection on booking cancel  -> booking_cancelled_by_user event
#   - Projection on check-in        -> checkin event (append-once, immutable)
#   - Projection on diary entry      -> note/dream event
#   - Soft-delete entry             -> event drops out of feed
#   - Restore soft-deleted entry     -> event re-projected back into feed
#   - Projection on finalize         -> practice_outcome events (attended/no_show)
#   - GET /diary/feed: newest-first, category filter, search, cursor paging
#   - Isolation: a user never sees another user's events
#   - Auth: 401 without token
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from uuid import UUID

from app.modules.bookings.service import auto_finalize_practice
from app.modules.diary.models import DiaryEvent, DiaryEventKind
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, login_user, full_cleanup_range

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
PRACTICES_URL = "/api/v1/practices"
BOOKINGS_URL = "/api/v1/bookings"
CHECKIN_URL = "/api/v1/practices/{practice_id}/checkin"
DIARY_URL = "/api/v1/diary"
FEED_URL = "/api/v1/diary/feed"

_TID_MIN = 90000
_TID_MAX = 90999


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean all test data before/after each test (TD-032: ORM, no raw SQL)."""
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    """Full ORM cleanup for telegram_id 90000-90999."""
    await full_cleanup_range(session, _TID_MIN, _TID_MAX, delete_users=True)
    await session.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _valid_practice_body(**overrides: object) -> dict:
    """Return a valid CreatePracticeRequest body (scheduled in the future)."""
    scheduled = datetime.now(UTC) + timedelta(days=2)
    body = {
        "practice_type": "live",
        "title": "Evening meditation",
        "description": "Calm wind-down",
        "scheduled_at": scheduled.isoformat(),
        "duration_minutes": 45,
        "timezone": "Europe/Moscow",
        "max_participants": 10,
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
        "direction": "meditation",
        "difficulty": "beginner",
    }
    body.update(overrides)
    return body


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = 90900,
) -> dict:
    """Create a verified master and return auth dict."""
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="MasterMind",
    )
    user_id = auth["user"]["id"]

    await db_session.execute(
        update(User)
        .where(User.id == user_id)
        .values(role=UserRole.MASTER.value)
    )
    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={
                "account": {"status": "verified"},
                "profile": {"bio": "bio", "methods": ["meditation"]},
            },
        )
    )
    await db_session.commit()
    return auth


async def _create_scheduled_practice(
    client: AsyncClient,
    master_auth: dict,
    **overrides: object,
) -> str:
    """Create a draft practice and move it to scheduled. Returns practice id.

    ПРОМТ №530: no fail_zoom_create workaround needed anymore -- a stub-mode
    ZoomMeeting row is still created (zoom/service.py create_meeting_for_
    practice creates it unconditionally), but bookings/service.py's
    zoom_tracked check ANDs meeting-exists with `not settings.is_zoom_stub`,
    so a practice built the plain way here is never treated as Zoom-tracked
    while the suite's stub-mode pin (conftest.py, ПРОМТ №543) holds -- always
    decided via the legacy proxy at finalize, same as before E21 shipped.
    The №529 fail_zoom_create parameter added here to work around the
    opposite (briefly true) behavior has been reverted -- carrying it
    forward would have been a workaround for a condition that no longer
    exists.
    """
    headers = auth_headers(master_auth["session_token"])
    resp = await client.post(
        PRACTICES_URL, json=_valid_practice_body(**overrides), headers=headers,
    )
    assert resp.status_code == 201, resp.text
    practice_id = resp.json()["id"]

    resp = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"status": "scheduled"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return practice_id


async def _book(
    client: AsyncClient,
    practice_id: str,
    telegram_id: int,
) -> dict:
    """Log in a user and book the practice. Returns {auth, booking_id}."""
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="Booker",
    )
    resp = await client.post(
        BOOKINGS_URL,
        json={"practice_id": practice_id},
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code in (200, 201), resp.text
    return {"auth": auth, "booking_id": resp.json()["id"]}


async def _feed(
    client: AsyncClient,
    token: str,
    **params: object,
) -> dict:
    """GET /diary/feed with optional query params. Returns the JSON body."""
    resp = await client.get(
        FEED_URL, params=params, headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


# ===================================================================
# Projection: booking create / cancel
# ===================================================================


@pytest.mark.asyncio
async def test_booking_creates_feed_event(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Booking a practice projects a booking_confirmed event into the feed."""
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(client, master)
    booker = await _book(client, pid, telegram_id=90001)

    body = await _feed(client, booker["auth"]["session_token"])
    kinds = [item["kind"] for item in body["items"]]
    assert "booking_confirmed" in kinds

    event = next(
        i for i in body["items"] if i["kind"] == "booking_confirmed"
    )
    assert event["source_type"] == "booking"
    assert event["snapshot"]["practice_title"] == "Evening meditation"
    assert event["snapshot"]["master_name"] == "MasterMind"
    assert event["snapshot"]["direction"] == "meditation"


@pytest.mark.asyncio
async def test_cancel_booking_appends_event(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Cancelling keeps the confirmed event and appends a cancelled event."""
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(client, master)
    booker = await _book(client, pid, telegram_id=90002)
    token = booker["auth"]["session_token"]

    resp = await client.delete(
        f"{BOOKINGS_URL}/{booker['booking_id']}",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text

    body = await _feed(client, token)
    kinds = [i["kind"] for i in body["items"]]
    # Append-only: both facts present.
    assert "booking_confirmed" in kinds
    assert "booking_cancelled_by_user" in kinds


# ===================================================================
# Projection: check-in (append-once, immutable)
# ===================================================================


@pytest.mark.asyncio
async def test_checkin_projects_event_and_is_immutable(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Check-in projects exactly one event; a resubmission is rejected (409)
    and the projected event keeps the original mood (no overwrite)."""
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(client, master)
    booker = await _book(client, pid, telegram_id=90003)
    token = booker["auth"]["session_token"]

    # Move the practice into the check-in window (scheduled within the window).
    await db_session.execute(
        update(Practice)
        .where(Practice.id == pid)
        .values(scheduled_at=datetime.now(UTC) + timedelta(hours=1))
    )
    await db_session.commit()

    # First check-in -- recorded, projects one event.
    resp = await client.post(
        CHECKIN_URL.format(practice_id=pid),
        json={"mood": 2, "comment": "tired"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text

    # Resubmission -- rejected; the recorded data point cannot be changed.
    resp = await client.post(
        CHECKIN_URL.format(practice_id=pid),
        json={"mood": 9, "comment": "better now"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 409, resp.text

    body = await _feed(client, token, category="checkins")
    checkin_events = [i for i in body["items"] if i["kind"] == "checkin"]
    # Exactly one checkin event, still reflecting the original mood.
    assert len(checkin_events) == 1
    assert checkin_events[0]["snapshot"]["mood"] == 2


@pytest.mark.asyncio
async def test_checkin_master_name_matches_telegram_name_not_display_name(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """W7 fix: diary events use the master's Telegram name, same as practice
    cards -- a custom MasterProfile.display_name must NOT leak into the
    diary feed and disagree with what the practice list shows."""
    master = await _make_verified_master(client, db_session)
    await db_session.execute(
        update(MasterProfile)
        .where(MasterProfile.user_id == master["user"]["id"])
        .values(
            data={
                "account": {"status": "verified"},
                "profile": {
                    "bio": "bio",
                    "methods": ["meditation"],
                    "display_name": "Custom Display Name",
                },
            },
        )
    )
    await db_session.commit()

    pid = await _create_scheduled_practice(client, master)
    booker = await _book(client, pid, telegram_id=90004)
    token = booker["auth"]["session_token"]

    await db_session.execute(
        update(Practice)
        .where(Practice.id == pid)
        .values(scheduled_at=datetime.now(UTC) + timedelta(hours=1))
    )
    await db_session.commit()

    resp = await client.post(
        CHECKIN_URL.format(practice_id=pid),
        json={"mood": 3, "comment": "ok"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text

    body = await _feed(client, token, category="checkins")
    checkin_events = [i for i in body["items"] if i["kind"] == "checkin"]
    assert len(checkin_events) == 1
    # Telegram first_name ("MasterMind", set in _make_verified_master), NOT
    # the custom display_name -- matches practices/service.master_full_name.
    assert checkin_events[0]["snapshot"]["master_name"] == "MasterMind"


# ===================================================================
# Projection: diary entry note/dream + soft delete
# ===================================================================


@pytest.mark.asyncio
async def test_note_entry_appears_in_feed(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Creating a note entry projects a note event into the feed."""
    auth = await login_user(client, telegram_id=90004, first_name="Writer")
    token = auth["session_token"]

    resp = await client.post(
        DIARY_URL,
        json={"content": "Today on the job I felt calm."},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201, resp.text
    # Default entry_type is note.
    assert resp.json()["entry_type"] == "note"

    body = await _feed(client, token, category="entries")
    assert len(body["items"]) == 1
    assert body["items"][0]["kind"] == "note"


@pytest.mark.asyncio
async def test_dream_entry_filtered_by_category(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A dream entry shows under the dreams chip, not under entries."""
    auth = await login_user(client, telegram_id=90005, first_name="Dreamer")
    token = auth["session_token"]

    await client.post(
        DIARY_URL,
        json={"content": "I dreamed of the sea.", "entry_type": "dream"},
        headers=auth_headers(token),
    )

    dreams = await _feed(client, token, category="dreams")
    assert [i["kind"] for i in dreams["items"]] == ["dream"]

    entries = await _feed(client, token, category="entries")
    assert entries["items"] == []


@pytest.mark.asyncio
async def test_soft_delete_hides_entry_from_feed(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Soft-deleting an entry removes its event from the feed."""
    auth = await login_user(client, telegram_id=90006, first_name="Writer2")
    token = auth["session_token"]

    resp = await client.post(
        DIARY_URL,
        json={"content": "Ephemeral thought."},
        headers=auth_headers(token),
    )
    entry_id = resp.json()["id"]

    # Present before delete.
    before = await _feed(client, token)
    assert any(i["source_id"] == entry_id for i in before["items"])

    resp = await client.delete(
        f"{DIARY_URL}/{entry_id}", headers=auth_headers(token),
    )
    assert resp.status_code == 204, resp.text

    # Gone after soft delete.
    after = await _feed(client, token)
    assert all(i["source_id"] != entry_id for i in after["items"])


@pytest.mark.asyncio
async def test_restore_reprojects_entry_into_feed(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Restoring a soft-deleted entry brings its event back into the feed.

    Mirrors test_soft_delete_hides_entry_from_feed above: restore_diary_entry
    re-projects via upsert_entry_event, which sets is_hidden = entry.is_deleted
    (now False). This is the assertion that would catch a split silently
    dropping that re-projection call.
    """
    auth = await login_user(client, telegram_id=90014, first_name="Writer3")
    token = auth["session_token"]

    resp = await client.post(
        DIARY_URL,
        json={"content": "Almost lost thought."},
        headers=auth_headers(token),
    )
    entry_id = resp.json()["id"]

    resp = await client.delete(
        f"{DIARY_URL}/{entry_id}", headers=auth_headers(token),
    )
    assert resp.status_code == 204, resp.text

    # Gone while deleted.
    hidden = await _feed(client, token)
    assert all(i["source_id"] != entry_id for i in hidden["items"])

    resp = await client.post(
        f"{DIARY_URL}/{entry_id}/restore", headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text

    # Back after restore.
    after = await _feed(client, token)
    assert any(i["source_id"] == entry_id for i in after["items"])


# ===================================================================
# Projection: finalize -> practice_outcome (attended + no_show)
# ===================================================================


@pytest.mark.asyncio
async def test_finalize_projects_outcome_for_attended_and_no_show(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Finalize projects practice_outcome to both attended and no-show users.

    ПРОМТ №530 reverted the №529 fail_zoom_create workaround: a stub-mode
    ZoomMeeting is still created (zoom/service.py create_meeting_for_
    practice creates it unconditionally), but bookings/service.py's
    zoom_tracked = zoom_meeting is not None and not settings.is_zoom_stub
    means it is never treated as tracked while stub mode is on, so a plain
    _create_scheduled_practice is decided via the legacy proxy immediately
    at finalize -- back to this test's original form and intent. Relies on
    the suite's stub-mode pin (conftest.py, ПРОМТ №543), not on any
    server's actual credential state.
    """
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(client, master)

    attendee = await _book(client, pid, telegram_id=90007)
    absentee = await _book(client, pid, telegram_id=90008)

    # Attendee joins (sets joined_at -> attended at finalize); absentee does not.
    resp = await client.post(
        f"{BOOKINGS_URL}/{attendee['booking_id']}/join",
        headers=auth_headers(attendee["auth"]["session_token"]),
    )
    assert resp.status_code == 200, resp.text

    # Practice is finalized by the system (the manual endpoint was removed --
    # completion is now driven by the lifecycle worker at scheduled_at + duration).
    await auto_finalize_practice(UUID(pid), db_session)
    await db_session.commit()

    # Attendee sees outcome with status attended.
    att_feed = await _feed(
        client, attendee["auth"]["session_token"], category="practices",
    )
    att_outcome = [
        i for i in att_feed["items"] if i["kind"] == "practice_outcome"
    ]
    assert len(att_outcome) == 1
    assert att_outcome[0]["snapshot"]["outcome_status"] == "attended"
    assert att_outcome[0]["source_type"] == "practice"

    # Absentee sees outcome with status no_show.
    abs_feed = await _feed(
        client, absentee["auth"]["session_token"], category="practices",
    )
    abs_outcome = [
        i for i in abs_feed["items"] if i["kind"] == "practice_outcome"
    ]
    assert len(abs_outcome) == 1
    assert abs_outcome[0]["snapshot"]["outcome_status"] == "no_show"

    # DB-level check, deliberately separate from the feed/response-body
    # assertions above: the feed query filters on is_hidden (feed_service.py)
    # so an item's mere presence never directly proves the column's value --
    # it only proves the WHERE clause matched. Read the DiaryEvent rows
    # directly to pin the column itself (mirrors test_zoom_attendance_decision.py's
    # pattern for the same kind).
    outcome_events = (
        await db_session.execute(
            select(DiaryEvent).where(
                DiaryEvent.kind == DiaryEventKind.PRACTICE_OUTCOME.value,
                DiaryEvent.source_id == UUID(pid),
            )
        )
    ).scalars().all()
    assert len(outcome_events) == 2
    assert all(e.is_hidden is False for e in outcome_events)


# ===================================================================
# Feed: ordering, search, cursor pagination
# ===================================================================


@pytest.mark.asyncio
async def test_feed_is_newest_first(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Feed items are ordered by occurred_at descending."""
    auth = await login_user(client, telegram_id=90009, first_name="Seq")
    token = auth["session_token"]

    for n in range(3):
        await client.post(
            DIARY_URL,
            json={"content": f"entry {n}"},
            headers=auth_headers(token),
        )

    body = await _feed(client, token)
    times = [i["occurred_at"] for i in body["items"]]
    assert times == sorted(times, reverse=True)


@pytest.mark.asyncio
async def test_feed_search_matches_content(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Search filters feed items by denormalized text (case-insensitive)."""
    auth = await login_user(client, telegram_id=90010, first_name="Searcher")
    token = auth["session_token"]

    await client.post(
        DIARY_URL,
        json={"content": "A note about the OCEAN waves."},
        headers=auth_headers(token),
    )
    await client.post(
        DIARY_URL,
        json={"content": "A note about mountains."},
        headers=auth_headers(token),
    )

    hits = await _feed(client, token, search="ocean")
    assert len(hits["items"]) == 1
    assert "ocean" in hits["items"][0]["snapshot"]["content_preview"].lower()


@pytest.mark.asyncio
async def test_feed_cursor_pagination(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Cursor paging walks the feed without overlap and ends with null cursor."""
    auth = await login_user(client, telegram_id=90011, first_name="Pager")
    token = auth["session_token"]

    for n in range(5):
        await client.post(
            DIARY_URL,
            json={"content": f"page entry {n}"},
            headers=auth_headers(token),
        )

    # First page of 2.
    page1 = await _feed(client, token, limit=2)
    assert len(page1["items"]) == 2
    assert page1["next_cursor"] is not None

    # Second page using the cursor.
    page2 = await _feed(
        client, token, limit=2, cursor=page1["next_cursor"],
    )
    assert len(page2["items"]) == 2

    ids1 = {i["id"] for i in page1["items"]}
    ids2 = {i["id"] for i in page2["items"]}
    assert ids1.isdisjoint(ids2)

    # Final page: 1 remaining, cursor becomes null (page not full).
    page3 = await _feed(
        client, token, limit=2, cursor=page2["next_cursor"],
    )
    assert len(page3["items"]) == 1
    assert page3["next_cursor"] is None


# ===================================================================
# Isolation + auth
# ===================================================================


@pytest.mark.asyncio
async def test_feed_isolated_per_user(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A user never sees another user's events."""
    auth_a = await login_user(client, telegram_id=90012, first_name="Alice")
    auth_b = await login_user(client, telegram_id=90112, first_name="Bob")

    await client.post(
        DIARY_URL,
        json={"content": "Alice private note."},
        headers=auth_headers(auth_a["session_token"]),
    )

    body_b = await _feed(client, auth_b["session_token"])
    assert body_b["items"] == []


@pytest.mark.asyncio
async def test_feed_requires_auth(client: AsyncClient) -> None:
    """GET /diary/feed without a token returns 401."""
    resp = await client.get(FEED_URL)
    assert resp.status_code == 401


# ===================================================================
# Direct projection check (event row shape)
# ===================================================================


@pytest.mark.asyncio
async def test_booking_event_row_persisted(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The booking_confirmed event row is persisted with correct columns."""
    master = await _make_verified_master(client, db_session)
    pid = await _create_scheduled_practice(client, master)
    booker = await _book(client, pid, telegram_id=90013)
    user_id = booker["auth"]["user"]["id"]

    rows = (
        await db_session.execute(
            select(DiaryEvent).where(
                DiaryEvent.user_id == user_id,
                DiaryEvent.kind == "booking_confirmed",
            )
        )
    ).scalars().all()
    assert len(rows) == 1
    event = rows[0]
    assert event.is_hidden is False
    assert event.source_type == "booking"
    assert event.text_search == "evening meditation"
    assert event.occurred_at is not None
