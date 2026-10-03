# =============================================================================
# VELO Backend -- Tests: the time in a notification is the reader's clock
# =============================================================================
#
# BE-102 notification time (owner, 3 October): Telegram said 16:00 where the
# card said 19:00 -- format_event_time printed the stored UTC instant. Now:
#   a STUDENT reads users.timezone   (the student zone: useViewerTimezone)
#   a MASTER  reads practice.timezone (the master zone: the practice's zone)
#
# telegram_id band: 67950-67999 (free_windows(space=(55000, 99999)) listed
# (67950, 67999) before it was claimed).
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session_factory
from app.core.events.models import OutboxEvent
from app.core.events.reminders import format_event_time
from app.modules.bookings.service import create_booking
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeStatus,
    PracticeType,
)
from app.modules.practices.schemas import UpdatePracticeRequest
from app.modules.practices.service import update_practice
from app.modules.users.models import User, UserRole
from tests.helpers import fresh_execute, full_cleanup_range, login_user

_TID_MIN = 67950
_TID_MAX = 67999
_TID_MASTER = 67951
_TID_STUDENT = 67952

# 16:00 UTC, three days ahead -- 19:00 in Moscow, 01:00 next day in Tokyo.
_SLOT = (datetime.now(UTC) + timedelta(days=3)).replace(
    hour=16,
    minute=0,
    second=0,
    microsecond=0,
)


def _local(tz: str) -> str:
    """What the app's card shows: the instant in that zone, dd.mm.yyyy HH:MM."""
    return _SLOT.astimezone(ZoneInfo(tz)).strftime("%d.%m.%Y %H:%M")


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX)
    await db_session.commit()


# ---------------------------------------------------------------------------
# The function
# ---------------------------------------------------------------------------


def test_format_event_time_is_the_zones_wall_clock() -> None:
    assert format_event_time(_SLOT, "Europe/Moscow") == _local("Europe/Moscow")
    assert format_event_time(_SLOT, "Asia/Tokyo") == _local("Asia/Tokyo")
    assert format_event_time(_SLOT, "UTC") == _SLOT.strftime("%d.%m.%Y %H:%M")
    # The defect, pinned: Moscow is NOT the UTC reading.
    assert format_event_time(_SLOT, "Europe/Moscow").endswith("19:00")
    assert format_event_time(_SLOT, "Asia/Tokyo").endswith("01:00")


def test_a_naive_instant_is_utc_and_an_unknown_zone_reads_as_utc() -> None:
    naive = _SLOT.replace(tzinfo=None)
    assert format_event_time(naive, "Europe/Moscow") == _local("Europe/Moscow")
    assert format_event_time(_SLOT, "Not/AZone") == _local("UTC")


# ---------------------------------------------------------------------------
# The call sites: a master and a student, two zones, one practice
# ---------------------------------------------------------------------------


async def _world(
    client: AsyncClient, db_session: AsyncSession
) -> tuple[UUID, UUID, UUID]:
    master = UUID(
        (await login_user(client, telegram_id=_TID_MASTER, first_name="M"))["user"][
            "id"
        ]
    )
    student = UUID(
        (await login_user(client, telegram_id=_TID_STUDENT, first_name="S"))["user"][
            "id"
        ]
    )
    await db_session.execute(
        update(User).where(User.id == master).values(role=UserRole.MASTER.value)
    )
    await db_session.execute(
        update(User).where(User.id == student).values(timezone="Asia/Tokyo")
    )
    db_session.add(
        MasterProfile(user_id=master, data={"account": {"status": "verified"}})
    )
    practice = Practice(
        master_id=master,
        title="Вечерняя практика",
        practice_type=PracticeType.LIVE.value,
        status=PracticeStatus.DRAFT.value,
        scheduled_at=_SLOT,
        duration_minutes=60,
        timezone="Europe/Moscow",
        max_participants=10,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        audience_kind=AudienceKind.PUBLIC.value,
    )
    db_session.add(practice)
    await db_session.commit()
    return master, student, practice.id


async def _payloads(type_: str, target: UUID) -> list[dict]:
    rows = (
        (
            await fresh_execute(
                select(OutboxEvent).where(
                    OutboxEvent.payload["type"].astext == type_,
                    OutboxEvent.payload["target_value"].astext == str(target),
                )
            )
        )
        .scalars()
        .all()
    )
    return [r.payload for r in rows]


@pytest.mark.asyncio
async def test_the_master_reads_the_practice_zone_and_the_student_their_own(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    master_id, student_id, practice_id = await _world(client, db_session)

    async with get_session_factory()() as session:
        master = await session.get(User, master_id)
        await update_practice(
            practice_id,
            master,
            UpdatePracticeRequest(status=PracticeStatus.SCHEDULED.value),
            session,
        )
        await session.commit()
    async with get_session_factory()() as session:
        student = await session.get(User, student_id)
        await create_booking(student, practice_id, session)
        await session.commit()

    (master_note,) = await _payloads("practice.master_reminder_1h", master_id)
    assert master_note["action_data"]["scheduled_at"] == _local("Europe/Moscow")

    (booked,) = await _payloads("booking.confirmed", student_id)
    assert booked["action_data"]["scheduled_at"] == _local("Asia/Tokyo")
    assert _local("Asia/Tokyo") in booked["body"]
    # The student's reminders are in the student's zone too.
    reminders = await _payloads("booking.reminder_24h", student_id)
    assert reminders and all(
        r["action_data"]["scheduled_at"] == _local("Asia/Tokyo") for r in reminders
    )
