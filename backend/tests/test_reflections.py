# =============================================================================
# VELO Backend -- Tests: BE-108 -- no-show reflection
# =============================================================================
#
# telegram_id band: 72800-72849. Declared module-level below as
# _TID_MIN/_TID_MAX, ONCE. Checked free before it was claimed:
# free_windows(space=(55000, 99999)) returned (72800, 79299), and no test
# file names an id in 72800-72899 (grepped, the declared map does not see
# undeclared files).
#
# Coverage:
#   - POST /practices/{id}/reflection: the input -> outcome grid of the gate
#     (booking status, empty comment forms, length, repeat, other user,
#     cancelled + no_show, auth), the row read back by SQL, the audit row.
#   - has_reflection on GET /bookings/me and /bookings/me/upcoming.
#   - The race of two first submissions (curator_race_harness): the second
#     waits on the unique index and gets 409, one row.
#
# NOT BUILT, deliberately: a race of create_reflection against cancel_booking
# on the same no_show booking. The cell is real (cancel_booking takes the
# practice, then the booking FOR UPDATE, even a no_show one, before refusing
# it), but on the current schema the RI triggers of `reflections` already
# take the practice before the booking (pg_trigger: practice_id_fkey,
# user_id_fkey, booking_id_fkey, in OID order), so removing the writer's
# explicit FOR KEY SHARE changes nothing a test can see; and the direction
# where it would matter -- cancel holding the practice, the reflection
# arriving -- cannot be paused with the harness: cancel_booking calls no
# module-level function between its two locks.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import AuditLog
from app.core.config import settings
from app.core.exceptions import ConflictError
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.diary import service as diary_service
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from tests.curator_race_harness import assert_no_deadlock, race
from tests.helpers import auth_headers, full_cleanup_range, login_user

_TID_MIN = 72800
_TID_MAX = 72849

REFLECTION_URL = "/api/v1/practices/{practice_id}/reflection"
MY_BOOKINGS_URL = "/api/v1/bookings/me"
MY_UPCOMING_URL = "/api/v1/bookings/me/upcoming"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean this file's band before and after each test."""
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ---------------------------------------------------------------------------
# Local helpers. Copied rather than imported, the convention here.
# ---------------------------------------------------------------------------
async def _master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> str:
    """A verified master; returns the user id."""
    auth = await login_user(client, telegram_id=telegram_id, first_name="Master")
    user_id = auth["user"]["id"]
    user = await db_session.get(User, user_id)
    user.role = UserRole.MASTER
    db_session.add(
        MasterProfile(
            user_id=user_id,
            data={
                "account": {"status": "verified"},
                "profile": {"bio": "Test master"},
            },
        )
    )
    await db_session.flush()
    return user_id


async def _practice(
    db_session: AsyncSession,
    master_id: str,
    *,
    status: str = PracticeStatus.COMPLETED.value,
    scheduled_at: datetime | None = None,
) -> Practice:
    """A practice; by default completed, ended an hour ago."""
    practice = Practice(
        master_id=master_id,
        title="Reflection practice",
        description="d",
        practice_type=PracticeType.LIVE.value,
        status=status,
        scheduled_at=scheduled_at or datetime.now(UTC) - timedelta(hours=2),
        duration_minutes=60,
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


async def _booking(
    db_session: AsyncSession,
    user_id: str,
    practice_id: UUID,
    status: str,
) -> Booking:
    booking = Booking(practice_id=practice_id, user_id=user_id, status=status)
    db_session.add(booking)
    await db_session.flush()
    return booking


async def _setup(
    client: AsyncClient,
    db_session: AsyncSession,
    *,
    status: str = BookingStatus.NO_SHOW.value,
    student_tid: int = 72801,
    master_tid: int = 72840,
) -> tuple[dict, Practice, Booking]:
    """A student with one booking in `status` on a completed practice."""
    master_id = await _master(client, db_session, master_tid)
    auth = await login_user(client, telegram_id=student_tid, first_name="Student")
    practice = await _practice(db_session, master_id)
    booking = await _booking(db_session, auth["user"]["id"], practice.id, status)
    await db_session.commit()
    return auth, practice, booking


async def _post(
    client: AsyncClient, auth: dict, practice_id: UUID, body: dict,
):
    return await client.post(
        REFLECTION_URL.format(practice_id=practice_id),
        json=body,
        headers=auth_headers(auth["session_token"]),
    )


async def _rows(db_session: AsyncSession, practice_id: UUID) -> list[tuple]:
    """(user_id, booking_id, comment) of every reflection on the practice,
    read by SQL -- what the table holds, not what the response said."""
    await db_session.rollback()
    result = await db_session.execute(
        text(
            "SELECT user_id, booking_id, comment FROM reflections "
            "WHERE practice_id = :pid ORDER BY user_id"
        ),
        {"pid": practice_id},
    )
    return [tuple(r) for r in result.all()]


async def _flags(client: AsyncClient, auth: dict, url: str) -> dict[str, bool]:
    """booking id -> has_reflection, as the list endpoint returns it."""
    resp = await client.get(url, headers=auth_headers(auth["session_token"]))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    items = body["items"] if isinstance(body, dict) else body
    return {item["id"]: item["has_reflection"] for item in items}


# ===================================================================
# POST -- the happy path and the stored row
# ===================================================================


@pytest.mark.asyncio
async def test_no_show_booking_records_the_reflection(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """no_show, no reflection yet -> 201; the row holds the stripped text and
    points at the no_show booking."""
    auth, practice, booking = await _setup(client, db_session)

    resp = await _post(client, auth, practice.id, {"comment": "  Болела  "})

    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["practice_id"] == str(practice.id)
    assert data["booking_id"] == str(booking.id)
    assert data["comment"] == "Болела"
    assert await _rows(db_session, practice.id) == [
        (UUID(auth["user"]["id"]), booking.id, "Болела"),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [{}, {"comment": None}, {"comment": ""}, {"comment": "   \n\t "}],
    ids=["absent", "null", "empty", "whitespace"],
)
async def test_an_empty_answer_is_accepted_and_stored_as_null(
    client: AsyncClient, db_session: AsyncSession, body: dict,
) -> None:
    """Owner ruling 3: an empty answer is an answer. Every form of empty is
    201 and NULL in the table -- not 422, not a string of blanks."""
    auth, practice, booking = await _setup(client, db_session)

    resp = await _post(client, auth, practice.id, body)

    assert resp.status_code == 201, resp.text
    assert resp.json()["comment"] is None
    # The row exists (Y) and its comment is NULL (X) -- read from the table.
    assert await _rows(db_session, practice.id) == [
        (UUID(auth["user"]["id"]), booking.id, None),
    ]


@pytest.mark.asyncio
async def test_comment_length_limit_is_the_feedback_one(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Exactly diary_comment_max_length is accepted; one more is 422 and
    writes nothing."""
    limit = settings.diary_comment_max_length
    auth, practice, _ = await _setup(client, db_session)

    too_long = await _post(client, auth, practice.id, {"comment": "x" * (limit + 1)})
    assert too_long.status_code == 422
    assert await _rows(db_session, practice.id) == []

    exact = await _post(client, auth, practice.id, {"comment": "x" * limit})
    assert exact.status_code == 201, exact.text
    assert len((await _rows(db_session, practice.id))[0][2]) == limit


# ===================================================================
# POST -- REPEAT
# ===================================================================


@pytest.mark.asyncio
async def test_a_repeat_is_409_and_the_first_row_is_untouched(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """One reflection per (practice, user), immutable: the second POST is 409
    reflection_already_submitted and the stored text stays the first one."""
    auth, practice, booking = await _setup(client, db_session)
    first = await _post(client, auth, practice.id, {"comment": "первое"})
    assert first.status_code == 201, first.text

    second = await _post(client, auth, practice.id, {"comment": "второе"})

    assert second.status_code == 409
    assert second.json()["error"] == "reflection_already_submitted"
    assert await _rows(db_session, practice.id) == [
        (UUID(auth["user"]["id"]), booking.id, "первое"),
    ]


@pytest.mark.asyncio
async def test_an_empty_first_answer_still_closes_the_door(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """An empty reflection is a reflection: a later text is a repeat, 409."""
    auth, practice, booking = await _setup(client, db_session)
    assert (await _post(client, auth, practice.id, {})).status_code == 201

    again = await _post(client, auth, practice.id, {"comment": "передумала"})

    assert again.status_code == 409
    assert await _rows(db_session, practice.id) == [
        (UUID(auth["user"]["id"]), booking.id, None),
    ]


# ===================================================================
# POST -- MISSING (no no_show booking)
# ===================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status",
    [
        BookingStatus.PENDING.value,
        BookingStatus.CONFIRMED.value,
        BookingStatus.ATTENDED.value,
        BookingStatus.CANCELLED.value,
    ],
)
async def test_any_other_booking_status_is_404_and_writes_nothing(
    client: AsyncClient, db_session: AsyncSession, status: str,
) -> None:
    """Only a no_show booking opens the reflection."""
    auth, practice, _ = await _setup(client, db_session, status=status)

    resp = await _post(client, auth, practice.id, {"comment": "x"})

    assert resp.status_code == 404
    assert resp.json()["error"] == "reflection_not_available"
    assert await _rows(db_session, practice.id) == []


@pytest.mark.asyncio
async def test_no_booking_and_no_practice_are_404(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A practice the user never booked, and a practice that does not exist,
    both answer the same 404 code."""
    master_id = await _master(client, db_session, 72840)
    auth = await login_user(client, telegram_id=72801, first_name="Student")
    practice = await _practice(db_session, master_id)
    await db_session.commit()

    not_booked = await _post(client, auth, practice.id, {})
    missing = await _post(client, auth, uuid4(), {})

    assert not_booked.status_code == 404
    assert not_booked.json()["error"] == "reflection_not_available"
    assert missing.status_code == 404
    assert missing.json()["error"] == "reflection_not_available"
    assert await _rows(db_session, practice.id) == []


@pytest.mark.asyncio
async def test_another_users_no_show_does_not_open_mine(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The booking is looked up for THIS user: a no_show of someone else on
    the same practice is 404 for me; with both no_show, the two reflections
    are independent rows."""
    other, practice, other_booking = await _setup(client, db_session)
    me = await login_user(client, telegram_id=72802, first_name="Me")

    refused = await _post(client, me, practice.id, {})
    assert refused.status_code == 404
    assert await _rows(db_session, practice.id) == []

    my_booking = await _booking(
        db_session, me["user"]["id"], practice.id, BookingStatus.NO_SHOW.value,
    )
    await db_session.commit()
    assert (await _post(client, me, practice.id, {"comment": "моя"})).status_code == 201
    assert (await _post(client, other, practice.id, {})).status_code == 201

    assert sorted(await _rows(db_session, practice.id)) == sorted([
        (UUID(me["user"]["id"]), my_booking.id, "моя"),
        (UUID(other["user"]["id"]), other_booking.id, None),
    ])


@pytest.mark.asyncio
async def test_a_cancelled_earlier_booking_does_not_shadow_the_no_show(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Cancelled, then re-booked and missed: two rows of one (practice, user)
    (uq_booking_practice_user_active allows a cancelled one). The reflection
    goes to the no_show booking."""
    auth, practice, cancelled = await _setup(
        client, db_session, status=BookingStatus.CANCELLED.value,
    )
    no_show = await _booking(
        db_session, auth["user"]["id"], practice.id, BookingStatus.NO_SHOW.value,
    )
    await db_session.commit()

    resp = await _post(client, auth, practice.id, {})

    assert resp.status_code == 201, resp.text
    assert resp.json()["booking_id"] == str(no_show.id)
    assert resp.json()["booking_id"] != str(cancelled.id)


@pytest.mark.asyncio
async def test_unauthenticated_is_401(client: AsyncClient) -> None:
    resp = await client.post(REFLECTION_URL.format(practice_id=uuid4()), json={})
    assert resp.status_code == 401


# ===================================================================
# Audit -- recorded, without the text
# ===================================================================


@pytest.mark.asyncio
async def test_the_audit_row_carries_no_comment_text(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Owner ruling 1: the reflection is the user's alone, and audit_logs is
    read by admins. The audit row exists (Y) and the text is in it nowhere
    (X)."""
    auth, practice, _ = await _setup(client, db_session)
    secret = "очень личное 7f3a"

    resp = await _post(client, auth, practice.id, {"comment": secret})
    assert resp.status_code == 201, resp.text

    await db_session.rollback()
    rows = (
        await db_session.execute(
            select(AuditLog).where(
                AuditLog.event == "reflection_created",
                AuditLog.actor_id == UUID(auth["user"]["id"]),
            )
        )
    ).scalars().all()
    assert len(rows) == 1
    assert rows[0].target_id == UUID(resp.json()["id"])
    assert rows[0].data == {"practice_id": str(practice.id)}
    assert secret not in repr(rows[0].data)


# ===================================================================
# has_reflection on the booking lists
# ===================================================================


@pytest.mark.asyncio
async def test_has_reflection_flips_on_the_booking_list_after_post(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """GET /bookings/me: false before, true after -- for this booking."""
    auth, practice, booking = await _setup(client, db_session)
    assert await _flags(client, auth, MY_BOOKINGS_URL) == {str(booking.id): False}

    assert (await _post(client, auth, practice.id, {})).status_code == 201

    assert await _flags(client, auth, MY_BOOKINGS_URL) == {str(booking.id): True}


@pytest.mark.asyncio
async def test_has_reflection_is_keyed_by_booking_and_by_user(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The cancelled earlier booking of the same practice stays false (keyed
    by booking, not practice); another user's reflection on the practice
    does not light my booking; my attended booking elsewhere stays false."""
    auth, practice, cancelled = await _setup(
        client, db_session, status=BookingStatus.CANCELLED.value,
    )
    no_show = await _booking(
        db_session, auth["user"]["id"], practice.id, BookingStatus.NO_SHOW.value,
    )
    other = await login_user(client, telegram_id=72803, first_name="Other")
    await _booking(
        db_session, other["user"]["id"], practice.id, BookingStatus.NO_SHOW.value,
    )
    second = await _practice(db_session, practice.master_id)
    attended = await _booking(
        db_session, auth["user"]["id"], second.id, BookingStatus.ATTENDED.value,
    )
    await db_session.commit()

    # Only the other user reflects first: nothing of mine lights up.
    assert (await _post(client, other, practice.id, {})).status_code == 201
    assert await _flags(client, auth, MY_BOOKINGS_URL) == {
        str(cancelled.id): False,
        str(no_show.id): False,
        str(attended.id): False,
    }

    assert (await _post(client, auth, practice.id, {})).status_code == 201
    assert await _flags(client, auth, MY_BOOKINGS_URL) == {
        str(cancelled.id): False,
        str(no_show.id): True,
        str(attended.id): False,
    }


@pytest.mark.asyncio
async def test_upcoming_bookings_carry_has_reflection_false(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """/bookings/me/upcoming lists CONFIRMED bookings only; the flag is on
    the response and is false."""
    master_id = await _master(client, db_session, 72840)
    auth = await login_user(client, telegram_id=72801, first_name="Student")
    future = await _practice(
        db_session,
        master_id,
        status=PracticeStatus.SCHEDULED.value,
        scheduled_at=datetime.now(UTC) + timedelta(days=1),
    )
    booking = await _booking(
        db_session, auth["user"]["id"], future.id, BookingStatus.CONFIRMED.value,
    )
    await db_session.commit()

    assert await _flags(client, auth, MY_UPCOMING_URL) == {str(booking.id): False}


# ===================================================================
# REPEAT under concurrency -- two first submissions
# ===================================================================


@pytest.mark.asyncio
async def test_two_first_submissions_make_one_row_and_one_409(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The holder has inserted its row (paused before record_audit, still
    uncommitted); the rival's INSERT waits on the unique index -- seen in
    pg_stat_activity -- and, once the holder commits, is rejected by
    uq_reflection_practice_user and answered 409, not 500. One row stays,
    the holder's."""
    auth, practice, booking = await _setup(client, db_session)
    user = SimpleNamespace(id=UUID(auth["user"]["id"]))

    async def holder(session: AsyncSession):
        return await diary_service.create_reflection(
            user, practice.id, session, comment="первый",
        )

    async def rival(session: AsyncSession):
        return await diary_service.create_reflection(
            user, practice.id, session, comment="второй",
        )

    result = await race(
        monkeypatch,
        holder=holder,
        pause_in=(diary_service, "record_audit"),
        rival=rival,
    )

    assert_no_deadlock(result)
    assert result.rival_waited, "the rival never met the holder's row"
    assert result.holder.committed, result.holder.error
    assert not result.rival.committed
    assert isinstance(result.rival.error, ConflictError), repr(result.rival.error)
    assert result.rival.error.code == "reflection_already_submitted"
    assert await _rows(db_session, practice.id) == [
        (user.id, booking.id, "первый"),
    ]
    # The rival rolled back: no second audit row either.
    audit = (
        await db_session.execute(
            select(AuditLog).where(
                AuditLog.event == "reflection_created",
                AuditLog.actor_id == user.id,
            )
        )
    ).scalars().all()
    assert len(audit) == 1
