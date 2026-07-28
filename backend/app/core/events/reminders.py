# =============================================================================
# VELO Backend -- Reminder orchestration over comms (Phase 6 / T1, item 2)
# =============================================================================
#
# The domain orchestration the comms donor "left behind" (comms
# app/engine/reminders.py header: booking loops, reschedule =
# cancel + schedule by the caller) -- rebuilt product-side on the
# frozen contract:
#
#   SCHEDULE = notification_request with a FUTURE scheduled_at
#     ("a reminder is just a Notification with a FUTURE scheduled_at";
#     scheduled_at = anchor - lead, expiry_at = anchor -- no point
#     reminding about something that already started). The mute gate
#     for the `reminders` category applies at due time (comms §2.5).
#   CANCEL   = reminder_cancel event (additive T1 extension, approved
#     2026-07-28) matched through correlation keys stored in
#     action_data: booking_id (per-booking cancel, user-targeted) and
#     practice_id (per-practice cancel, no target -- kills the whole
#     practice's series, donor semantics).
#   RESCHEDULE = cancel + schedule by the caller (donor rule).
#
# SERIES: the donor triple 24h / 1h / 10min re-keyed to the dot
# dictionary (booking.reminder_24h / _1h / _10m), minimum lead from
# settings (donor default 5 min): a reminder already (almost) due is
# skipped, not scheduled into the past. The donor's master_reminder_*
# series is NOT rebuilt -- absent from the locked dictionary §2
# (deferred with a dictionary-amendment trigger).
#
# PROMPTS (ID-6): practice_outcome schedules prompt.leave_feedback at
# outcome + delay (settings), expiring after the settings window. v1
# schedules feedback ONLY (the single live donor emit);
# prompt.leave_review is registered in the profile but deliberately
# unscheduled -- enabling it is one more _schedule_prompt call here.
#
# Everything rides the transactional outbox: a reminder/cancel exists
# exactly when the booking / cancellation / outcome commits.
# =============================================================================

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.events.notify import (
    emit_notification,
    emit_reminder_cancel,
)

logger = structlog.get_logger()

# Reminders jump the default queue priority (comms donor value).
REMINDER_PRIORITY = 2


@dataclass(frozen=True)
class ReminderSpec:
    """One reminder in the series: profile type key + lead, plus the
    stored-fallback text shown by the inbox bell (channel templates
    override telegram at delivery)."""

    type: str
    lead: timedelta
    title: str
    body_suffix: str


# The donor series (reminders.py: 24h / 1h / 10min before
# practice.scheduled_at), re-keyed to the dot dictionary.
BOOKING_REMINDER_SPECS: tuple[ReminderSpec, ...] = (
    ReminderSpec(
        type="booking.reminder_24h",
        lead=timedelta(hours=24),
        title="Практика завтра",
        body_suffix="начнётся через 24 часа",
    ),
    ReminderSpec(
        type="booking.reminder_1h",
        lead=timedelta(hours=1),
        title="Практика через 1 час",
        body_suffix="начнётся через 1 час",
    ),
    ReminderSpec(
        type="booking.reminder_10m",
        lead=timedelta(minutes=10),
        title="Практика скоро начнётся",
        body_suffix="начнётся через 10 минут",
    ),
)

BOOKING_REMINDER_TYPES = [spec.type for spec in BOOKING_REMINDER_SPECS]

PROMPT_FEEDBACK_TYPE = "prompt.leave_feedback"


def format_event_time(dt: datetime) -> str:
    """Pre-format a timestamp for the wire (arch §2.3: datetime does
    not survive action_data -- dates travel as finished strings). Same
    value the donor exposed (no timezone conversion), readable form.
    """
    return dt.strftime("%d.%m.%Y %H:%M")


async def schedule_booking_reminders(
    session: AsyncSession,
    *,
    booking_id: str,
    user_id: str,
    practice_id: str,
    practice_title: str,
    master_name: str,
    scheduled_at: datetime,
) -> int:
    """Schedule the reminder series for one booking (anchor =
    practice.scheduled_at). Returns the number of reminders emitted
    (0..3 -- leads already inside the min-lead cutoff are skipped).
    """
    now = datetime.now(UTC)
    cutoff = now + timedelta(
        seconds=settings.booking_reminder_min_lead_seconds,
    )
    emitted = 0
    when_text = format_event_time(scheduled_at)

    for spec in BOOKING_REMINDER_SPECS:
        send_at = scheduled_at - spec.lead
        if send_at < cutoff:
            continue
        await emit_notification(
            session,
            type=spec.type,
            target_type="user",
            target_value=user_id,
            title=spec.title,
            body=(
                f"Практика «{practice_title}» {spec.body_suffix}. "
                f"Начало: {when_text}. Мастер: {master_name}."
            ),
            action_data={
                "action": "open_practice",
                "params": {"practice_id": practice_id},
                # Correlation keys for reminder_cancel:
                "booking_id": booking_id,
                "practice_id": practice_id,
                # Template variables (pre-rendered scalars):
                "practice_title": practice_title,
                "master_name": master_name,
                "scheduled_at": when_text,
            },
            priority=REMINDER_PRIORITY,
            scheduled_at=send_at,
            expiry_at=scheduled_at,
        )
        emitted += 1

    if emitted:
        logger.info(
            "booking_reminders_scheduled",
            booking_id=booking_id,
            practice_id=practice_id,
            count=emitted,
        )
    return emitted


async def cancel_booking_reminders(
    session: AsyncSession,
    *,
    booking_id: str,
    user_id: str,
) -> None:
    """Cancel one booking's pending reminders (booking cancelled):
    correlated by booking_id, scoped to the booker's user target
    (donor semantics of the per-booking cancel)."""
    await emit_reminder_cancel(
        session,
        types=BOOKING_REMINDER_TYPES,
        correlation_key="booking_id",
        correlation_value=booking_id,
        target_type="user",
        target_value=user_id,
    )


async def cancel_practice_reminders(
    session: AsyncSession,
    *,
    practice_id: str,
) -> None:
    """Cancel EVERY pending reminder of a practice (practice cancelled
    or rescheduled): correlated by practice_id, no target filter
    (donor semantics of the per-practice cancel)."""
    await emit_reminder_cancel(
        session,
        types=BOOKING_REMINDER_TYPES,
        correlation_key="practice_id",
        correlation_value=practice_id,
    )


async def schedule_feedback_prompt(
    session: AsyncSession,
    *,
    user_id: str,
    practice_id: str,
    practice_title: str,
) -> None:
    """practice_outcome -> a delayed prompt.leave_feedback nudge for
    one attendee (ID-6: the prompt rides the reminder mechanic, not a
    direct emit)."""
    now = datetime.now(UTC)
    action_data: dict[str, Any] = {
        "action": "open_feedback",
        "params": {"practice_id": practice_id},
        "practice_id": practice_id,
        "practice_title": practice_title,
    }
    await emit_notification(
        session,
        type=PROMPT_FEEDBACK_TYPE,
        target_type="user",
        target_value=user_id,
        title="Как прошла практика?",
        body=f"Поделитесь впечатлением о практике «{practice_title}».",  # noqa: RUF001
        action_data=action_data,
        priority=REMINDER_PRIORITY,
        scheduled_at=now + timedelta(
            seconds=settings.prompt_feedback_delay_seconds,
        ),
        expiry_at=now + timedelta(
            seconds=settings.prompt_feedback_expiry_seconds,
        ),
    )
