# =============================================================================
# VELO Backend -- Tests: Admin Practices (E9 / 4c)
# =============================================================================
#
# telegram_id range: 94000-94999
#   94900     -- admin caller
#   94800     -- master (practice owner)
#   94001+    -- participants
#
# The list is platform-wide (seed present), so list assertions check scope
# invariants (every returned item matches the requested scope) + shape +
# pagination rather than exact totals. Detail is fetched by id -> isolated,
# so it carries exact field/roster assertions.
#
# Cleanup is explicit + FK-safe for the 94xxx range.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from app.modules.zoom.models import ZoomMeeting, ZoomMeetingStatus
from tests.helpers import auth_headers, login_user

PRACTICES_URL = "/api/v1/admin/practices"
DETAIL_URL = "/api/v1/admin/practices/{practice_id}"
ZOOM_ATTENDANCE_URL = "/api/v1/admin/practices/{practice_id}/zoom-attendance"

_TID_MIN = 94000
_TID_MAX = 94999


# ===================================================================
# Cleanup (explicit, FK-safe)
# ===================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    await session.rollback()
    subq = select(User.id).where(User.telegram_id.between(_TID_MIN, _TID_MAX))

    await session.execute(
        Booking.__table__.delete().where(Booking.user_id.in_(subq))
    )
    await session.execute(
        Practice.__table__.delete().where(Practice.master_id.in_(subq))
    )
    await session.execute(
        MasterProfile.__table__.delete().where(MasterProfile.user_id.in_(subq))
    )
    from app.core.audit import AuditLog
    await session.execute(
        AuditLog.__table__.delete().where(AuditLog.actor_id.in_(subq))
    )
    await session.execute(
        User.__table__.delete().where(
            User.telegram_id.between(_TID_MIN, _TID_MAX)
        )
    )
    await session.commit()


# ===================================================================
# Helpers
# ===================================================================


async def _make_admin(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int = 94900,
) -> str:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Admin")
    await db_session.execute(
        update(User)
        .where(User.id == auth["user"]["id"])
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.flush()
    return auth["session_token"]


async def _make_master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int = 94800,
) -> str:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Master")
    user_id = auth["user"]["id"]
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    await db_session.flush()
    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={
                "account": {"status": "verified"},
                "profile": {"display_name": "Master"},
            },
        )
    )
    await db_session.flush()
    return user_id


async def _create_practice(
    db_session: AsyncSession,
    master_id: str,
    *,
    scheduled_at: datetime,
    status: str = PracticeStatus.SCHEDULED.value,
    max_participants: int | None = 10,
    direction: str | None = None,
    title: str = "Admin Practice",
) -> Practice:
    data = {"taxonomy": {"direction": direction}} if direction else {}
    practice = Practice(
        master_id=master_id,
        title=title,
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=status,
        scheduled_at=scheduled_at,
        duration_minutes=60,
        timezone="UTC",
        max_participants=max_participants,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        data=data,
    )
    db_session.add(practice)
    await db_session.flush()
    return practice


async def _book(
    client: AsyncClient,
    db_session: AsyncSession,
    practice: Practice,
    telegram_id: int,
    *,
    status: str = BookingStatus.CONFIRMED.value,
    cancelled_at: datetime | None = None,
    created_at: datetime | None = None,
) -> Booking:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=f"P{telegram_id}",
    )
    booking = Booking(
        practice_id=practice.id,
        user_id=auth["user"]["id"],
        status=status,
        cancelled_at=cancelled_at,
    )
    if created_at is not None:
        booking.created_at = created_at
    db_session.add(booking)
    await db_session.flush()
    return booking


# ===================================================================
# GET /admin/practices -- list
# ===================================================================


@pytest.mark.asyncio
async def test_practices_list_shape(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """List returns the paginated shape; every item has a temporal status."""
    token = await _make_admin(client, db_session)
    master_id = await _make_master(client, db_session)
    await _create_practice(
        db_session, master_id, scheduled_at=datetime.now(UTC) + timedelta(days=2),
    )
    await _create_practice(
        db_session, master_id,
        scheduled_at=datetime.now(UTC) - timedelta(days=2),
        status=PracticeStatus.COMPLETED.value,
    )
    await db_session.commit()

    resp = await client.get(PRACTICES_URL, headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()
    assert {"items", "total", "limit", "offset"} <= set(data.keys())
    assert data["total"] >= 2
    assert data["items"], "expected at least one practice"
    item = data["items"][0]
    assert {
        "id", "title", "direction", "master_name", "master_verified",
        "scheduled_at", "duration_minutes", "booked", "capacity", "status",
        "timezone",
    } == set(item.keys())
    assert all(it["status"] in ("upcoming", "past") for it in data["items"])


@pytest.mark.asyncio
async def test_practices_list_scope_upcoming(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """scope=upcoming returns only upcoming practices."""
    token = await _make_admin(client, db_session)
    master_id = await _make_master(client, db_session)
    await _create_practice(
        db_session, master_id, scheduled_at=datetime.now(UTC) + timedelta(days=3),
    )
    await db_session.commit()

    resp = await client.get(
        PRACTICES_URL, params={"scope": "upcoming", "limit": 100},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    assert all(it["status"] == "upcoming" for it in resp.json()["items"])


@pytest.mark.asyncio
async def test_practices_list_scope_past(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """scope=past returns only past practices."""
    token = await _make_admin(client, db_session)
    master_id = await _make_master(client, db_session)
    await _create_practice(
        db_session, master_id,
        scheduled_at=datetime.now(UTC) - timedelta(days=3),
        status=PracticeStatus.COMPLETED.value,
    )
    await db_session.commit()

    resp = await client.get(
        PRACTICES_URL, params={"scope": "past", "limit": 100},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    assert all(it["status"] == "past" for it in resp.json()["items"])


@pytest.mark.asyncio
async def test_practices_list_pagination(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """limit caps the page; total counts the full set."""
    token = await _make_admin(client, db_session)
    master_id = await _make_master(client, db_session)
    for i in range(3):
        await _create_practice(
            db_session, master_id,
            scheduled_at=datetime.now(UTC) + timedelta(days=i + 1),
        )
    await db_session.commit()

    resp = await client.get(
        PRACTICES_URL, params={"limit": 2, "offset": 0}, headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["items"]) <= 2
    assert data["total"] >= len(data["items"])


def _starts(items: list[dict]) -> list[datetime]:
    return [datetime.fromisoformat(it["scheduled_at"]) for it in items]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "order,soonest_first",
    [(None, False), ("desc", False), ("asc", True)],
)
async def test_practices_list_upcoming_order(
    client: AsyncClient,
    db_session: AsyncSession,
    order: str | None,
    soonest_first: bool,
) -> None:
    """BE-257: scope=upcoming&order=asc lists the nearest practice first, so
    it stands on page one. Without `order` -- or with desc -- the list is as
    it was before: newest first, so a caller that never heard of the
    parameter is not moved."""
    token = await _make_admin(client, db_session)
    master_id = await _make_master(client, db_session)
    now = datetime.now(UTC)
    # Created out of order on purpose: the order is the list's, not the
    # insertion's.
    later = await _create_practice(
        db_session, master_id, scheduled_at=now + timedelta(days=30),
    )
    soonest = await _create_practice(
        db_session, master_id, scheduled_at=now + timedelta(days=10),
    )
    middle = await _create_practice(
        db_session, master_id, scheduled_at=now + timedelta(days=20),
    )
    await db_session.commit()
    params: dict = {"scope": "upcoming", "limit": 100}
    if order is not None:
        params["order"] = order

    resp = await client.get(
        PRACTICES_URL, params=params, headers=auth_headers(token),
    )

    assert resp.status_code == 200
    items = resp.json()["items"]
    assert _starts(items) == sorted(_starts(items), reverse=not soonest_first)
    mine = {str(later.id), str(soonest.id), str(middle.id)}
    expected = [str(soonest.id), str(middle.id), str(later.id)]
    assert [it["id"] for it in items if it["id"] in mine] == (
        expected if soonest_first else expected[::-1]
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("scope", ["past", "all"])
async def test_practices_list_order_is_read_for_upcoming_only(
    client: AsyncClient,
    db_session: AsyncSession,
    scope: str,
) -> None:
    """BE-257: order=asc moves the upcoming scope and nothing else; the past
    and the whole list stay newest first (what their tabs read)."""
    token = await _make_admin(client, db_session)
    master_id = await _make_master(client, db_session)
    now = datetime.now(UTC)
    for days in (30, 10, 20):
        await _create_practice(
            db_session, master_id,
            scheduled_at=now - timedelta(days=days),
            status=PracticeStatus.COMPLETED.value,
        )
    await db_session.commit()

    resp = await client.get(
        PRACTICES_URL, params={"scope": scope, "order": "asc", "limit": 100},
        headers=auth_headers(token),
    )

    assert resp.status_code == 200
    starts = _starts(resp.json()["items"])
    assert len(starts) >= 3
    assert starts == sorted(starts, reverse=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("order", ["asc", "desc"])
async def test_practices_list_equal_starts_keep_one_place_across_pages(
    client: AsyncClient,
    db_session: AsyncSession,
    order: str,
) -> None:
    """BE-257: two practices that start at the same instant come in the same
    order (by id) whichever page boundary falls between them -- a page of
    one row never repeats a practice or drops the other."""
    token = await _make_admin(client, db_session)
    master_id = await _make_master(client, db_session)
    start = datetime.now(UTC) + timedelta(days=15)
    first = await _create_practice(
        db_session, master_id, scheduled_at=start, title="Same start A",
    )
    second = await _create_practice(
        db_session, master_id, scheduled_at=start, title="Same start B",
    )
    await db_session.commit()
    by_id = [str(pid) for pid in sorted((first.id, second.id))]
    headers = auth_headers(token)
    params = {"scope": "upcoming", "order": order}

    full = await client.get(
        PRACTICES_URL, params={**params, "limit": 100}, headers=headers,
    )
    ids = [it["id"] for it in full.json()["items"]]
    at = ids.index(by_id[0])
    pages = [
        (
            await client.get(
                PRACTICES_URL,
                params={**params, "limit": 1, "offset": at + n},
                headers=headers,
            )
        ).json()["items"]
        for n in (0, 1)
    ]

    assert ids[at : at + 2] == by_id
    assert [[it["id"] for it in page] for page in pages] == [
        [by_id[0]], [by_id[1]],
    ]


# ===================================================================
# GET /admin/practices/{id} -- detail
# ===================================================================


@pytest.mark.asyncio
async def test_practice_detail_upcoming(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Upcoming detail: booked/capacity + roster of registered participants."""
    token = await _make_admin(client, db_session)
    master_id = await _make_master(client, db_session)
    practice = await _create_practice(
        db_session, master_id,
        scheduled_at=datetime.now(UTC) + timedelta(days=2),
        max_participants=10, direction="yoga",
    )
    await _book(client, db_session, practice, 94001)
    await _book(client, db_session, practice, 94002)
    await db_session.commit()

    resp = await client.get(
        DETAIL_URL.format(practice_id=practice.id), headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "upcoming"
    assert data["booked"] == 2
    assert data["attended"] == 0
    assert data["capacity"] == 10
    assert data["direction"] == "yoga"
    assert data["master_name"] == "Master"
    assert data["master_verified"] is True
    assert len(data["roster"]) == 2
    assert {"user_id", "name", "avatar_url", "status"} == set(data["roster"][0].keys())


@pytest.mark.asyncio
async def test_practice_detail_past_split_excludes_cancelled(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Past detail: attended/no_show roster; cancelled is excluded entirely."""
    token = await _make_admin(client, db_session)
    master_id = await _make_master(client, db_session)
    practice = await _create_practice(
        db_session, master_id,
        scheduled_at=datetime.now(UTC) - timedelta(days=2),
        status=PracticeStatus.COMPLETED.value,
    )
    await _book(client, db_session, practice, 94010, status=BookingStatus.ATTENDED.value)
    await _book(client, db_session, practice, 94011, status=BookingStatus.ATTENDED.value)
    await _book(client, db_session, practice, 94012, status=BookingStatus.NO_SHOW.value)
    await _book(client, db_session, practice, 94013, status=BookingStatus.CANCELLED.value)
    await db_session.commit()

    resp = await client.get(
        DETAIL_URL.format(practice_id=practice.id), headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "past"
    # cancelled excluded from booked and roster.
    assert data["booked"] == 3
    assert data["attended"] == 2
    assert len(data["roster"]) == 3
    statuses = sorted(r["status"] for r in data["roster"])
    assert statuses == ["attended", "attended", "no_show"]


@pytest.mark.asyncio
async def test_practice_detail_lists_cancelled_bookings_apart(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """BE-257: the cancelled bookings come in a list of their own, earliest
    cancellation first (a time never recorded last), each with its time. The
    roster and the head-count stay the live ones; a person who cancelled
    twice shows twice, under two booking ids."""
    token = await _make_admin(client, db_session)
    master_id = await _make_master(client, db_session)
    practice = await _create_practice(
        db_session, master_id, scheduled_at=datetime.now(UTC) + timedelta(days=2),
    )
    cancelled = BookingStatus.CANCELLED.value
    t1 = datetime(2026, 11, 20, 9, 0, tzinfo=UTC)
    t2 = datetime(2026, 11, 21, 18, 30, tzinfo=UTC)
    live = await _book(client, db_session, practice, 94020)
    second = await _book(
        client, db_session, practice, 94021, status=cancelled, cancelled_at=t2,
    )
    first = await _book(
        client, db_session, practice, 94021, status=cancelled, cancelled_at=t1,
    )
    unrecorded = await _book(client, db_session, practice, 94022, status=cancelled)
    await db_session.commit()

    resp = await client.get(
        DETAIL_URL.format(practice_id=practice.id), headers=auth_headers(token),
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["booked"] == 1
    assert [str(live.user_id)] == [r["user_id"] for r in data["roster"]]
    assert [(c["booking_id"], c["cancelled_at"]) for c in data["cancelled"]] == [
        (str(first.id), "2026-11-20T09:00:00Z"),
        (str(second.id), "2026-11-21T18:30:00Z"),
        (str(unrecorded.id), None),
    ]
    assert {c["name"] for c in data["cancelled"]} == {"P94021", "P94022"}
    assert {c["status"] for c in data["cancelled"]} == {"cancelled"}


@pytest.mark.asyncio
async def test_practice_detail_404_missing(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Unknown practice id: 404."""
    token = await _make_admin(client, db_session)
    await db_session.commit()
    resp = await client.get(
        DETAIL_URL.format(practice_id=uuid4()), headers=auth_headers(token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_practice_detail_404_deleted(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Soft-deleted practice resolves to 404."""
    token = await _make_admin(client, db_session)
    master_id = await _make_master(client, db_session)
    practice = await _create_practice(
        db_session, master_id,
        scheduled_at=datetime.now(UTC) - timedelta(days=1),
        status=PracticeStatus.DELETED.value,
    )
    await db_session.commit()

    resp = await client.get(
        DETAIL_URL.format(practice_id=practice.id), headers=auth_headers(token),
    )
    assert resp.status_code == 404


# ===================================================================
# auth
# ===================================================================


@pytest.mark.asyncio
async def test_practices_no_auth(client: AsyncClient) -> None:
    resp = await client.get(PRACTICES_URL)
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_practices_non_admin(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    auth = await login_user(client, telegram_id=94050, first_name="Plain")
    resp = await client.get(PRACTICES_URL, headers=auth_headers(auth["session_token"]))
    assert resp.status_code == 403


# ===================================================================
# GET /admin/practices/{id}/zoom-attendance -- cancelled bookings (BE-257)
# ===================================================================


@pytest.mark.asyncio
async def test_zoom_attendance_lists_cancelled_bookings_apart(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """BE-257: the cancelled bookings are not in `bookings` (the live
    attendance) but in `cancelled`, with the time of the cancellation and
    what Zoom recorded for them."""
    token = await _make_admin(client, db_session)
    master_id = await _make_master(client, db_session)
    practice = await _create_practice(
        db_session, master_id, scheduled_at=datetime.now(UTC) - timedelta(days=1),
        status=PracticeStatus.COMPLETED.value,
    )
    db_session.add(
        ZoomMeeting(
            practice_id=practice.id, zoom_meeting_id="94100",
            zoom_meeting_uuid="uuid-94100", status=ZoomMeetingStatus.ACTIVE.value,
        )
    )
    attended = await _book(
        client, db_session, practice, 94030, status=BookingStatus.ATTENDED.value,
    )
    cancelled_at = datetime(2026, 11, 22, 7, 15, tzinfo=UTC)
    cancelled = await _book(
        client, db_session, practice, 94031,
        status=BookingStatus.CANCELLED.value, cancelled_at=cancelled_at,
    )
    cancelled.zoom_minutes_present = 12
    await db_session.commit()

    resp = await client.get(
        ZOOM_ATTENDANCE_URL.format(practice_id=practice.id),
        headers=auth_headers(token),
    )

    assert resp.status_code == 200
    data = resp.json()
    assert [b["booking_id"] for b in data["bookings"]] == [str(attended.id)]
    assert data["bookings"][0]["cancelled_at"] is None
    assert len(data["cancelled"]) == 1
    row = data["cancelled"][0]
    assert row["booking_id"] == str(cancelled.id)
    assert row["status"] == "cancelled"
    assert row["cancelled_at"] == "2026-11-22T07:15:00Z"
    assert row["zoom_minutes_present"] == 12


@pytest.mark.asyncio
async def test_zoom_attendance_orders_live_by_booking_and_cancelled_by_cancellation(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """BE-257: several cancellations come earliest first, those cancelled at
    the same instant in booking order, a time never recorded last; the live
    bookings, which carry no cancellation time, keep their booking order --
    one query orders both lists."""
    token = await _make_admin(client, db_session)
    master_id = await _make_master(client, db_session)
    practice = await _create_practice(
        db_session, master_id, scheduled_at=datetime.now(UTC) - timedelta(days=1),
        status=PracticeStatus.COMPLETED.value,
    )
    db_session.add(
        ZoomMeeting(
            practice_id=practice.id, zoom_meeting_id="94110",
            zoom_meeting_uuid="uuid-94110", status=ZoomMeetingStatus.ACTIVE.value,
        )
    )
    booked = datetime(2026, 11, 1, tzinfo=UTC)
    early = datetime(2026, 11, 20, 9, 0, tzinfo=UTC)
    late = datetime(2026, 11, 21, 18, 30, tzinfo=UTC)
    cancelled = BookingStatus.CANCELLED.value

    def at(hours: int) -> datetime:
        return booked + timedelta(hours=hours)

    live_1 = await _book(client, db_session, practice, 94050, created_at=at(1))
    cancelled_late = await _book(
        client, db_session, practice, 94051,
        status=cancelled, cancelled_at=late, created_at=at(2),
    )
    live_2 = await _book(
        client, db_session, practice, 94052,
        status=BookingStatus.ATTENDED.value, created_at=at(3),
    )
    cancelled_early = await _book(
        client, db_session, practice, 94053,
        status=cancelled, cancelled_at=early, created_at=at(4),
    )
    unrecorded = await _book(
        client, db_session, practice, 94054, status=cancelled, created_at=at(5),
    )
    cancelled_tie = await _book(
        client, db_session, practice, 94055,
        status=cancelled, cancelled_at=early, created_at=at(6),
    )
    await db_session.commit()

    resp = await client.get(
        ZOOM_ATTENDANCE_URL.format(practice_id=practice.id),
        headers=auth_headers(token),
    )

    assert resp.status_code == 200
    data = resp.json()
    assert [b["booking_id"] for b in data["bookings"]] == [
        str(live_1.id), str(live_2.id),
    ]
    assert [b["booking_id"] for b in data["cancelled"]] == [
        str(cancelled_early.id), str(cancelled_tie.id),
        str(cancelled_late.id), str(unrecorded.id),
    ]


@pytest.mark.asyncio
async def test_zoom_attendance_without_meeting_answers_empty_lists(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A practice with no Zoom meeting answers with every list empty, the
    new one included, even when it holds a cancelled booking."""
    token = await _make_admin(client, db_session)
    master_id = await _make_master(client, db_session)
    practice = await _create_practice(
        db_session, master_id, scheduled_at=datetime.now(UTC) + timedelta(days=2),
    )
    await _book(
        client, db_session, practice, 94040,
        status=BookingStatus.CANCELLED.value,
        cancelled_at=datetime(2026, 11, 22, 7, 15, tzinfo=UTC),
    )
    await db_session.commit()

    resp = await client.get(
        ZOOM_ATTENDANCE_URL.format(practice_id=practice.id),
        headers=auth_headers(token),
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["zoom_meeting_status"] is None
    assert data["bookings"] == []
    assert data["cancelled"] == []
