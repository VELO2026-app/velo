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
#   CANCEL   = reminder_cancel event matched by the ENVELOPE
#     correlation, on equality (comms 3.0.0 never reads the letter). ONE
#     JOB HAS ONE CORRELATION, so each reminder is cancelled along its
#     own axis only:
#       "booking:<booking_id>"   -- a participant's series, cancelled
#                                   per booking (user-targeted);
#       "practice:<practice_id>" -- the master's own reminder, cancelled
#                                   per practice (no target).
#     The prefixes exist only so the two axes can never collide by
#     accident. "Cancel the whole practice" is therefore not one event
#     but a fan-out the CALLER supplies: one per-booking cancel for every
#     booking that holds a series, plus the one master cancel -- see
#     cancel_practice_reminders.
#   RESCHEDULE = cancel + schedule by the caller (donor rule).
#
# IDEMPOTENCY KEYS name the scheduling ACT, not only the reminder. comms
# holds a key forever, whatever became of its job: a cancelled reminder
# still owns its key. Re-scheduling a moved practice under the key of the
# cancelled series would be refused as a conflict (other bytes) or, on a
# move back to an earlier time, answered with the cancelled job (same
# bytes) -- either way no reminder. So every key carries the act that
# scheduled it: BOOKED_ACT / PUBLISHED_ACT for the one-off acts whose
# identity the booking / practice id already is, and a freshly minted
# reschedule act (new_reschedule_act) per move of the practice. Minting
# is safe because the move itself is gated in the domain: the reschedule
# branch of update_practice runs only when scheduled_at actually changes,
# on a row taken FOR UPDATE -- a repeated request to the same time emits
# nothing, and two concurrent moves are serialized.
#
# SERIES: the donor triple 24h / 1h / 10min re-keyed to the dot
# dictionary (booking.reminder_24h / _1h / _10m), minimum lead from
# settings (donor default 5 min): a reminder already (almost) due is
# skipped, not scheduled into the past. The donor's master_reminder_*
# series was deferred here with a dictionary-amendment trigger; BE-33
# fired that trigger and rebuilt the 1h leg as
# practice.master_reminder_1h -- per PRACTICE, not per booking, so it
# is a sibling of the series rather than a fourth member of it.
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

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, NamedTuple
from uuid import uuid4

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.events.notify import (
    emit_notification,
    emit_reminder_cancel,
)

logger = structlog.get_logger()

# The act identities of the two one-off scheduling acts (see header).
BOOKED_ACT = "booked"
PUBLISHED_ACT = "published"


def new_reschedule_act() -> str:
    """A fresh act identity for ONE move of a practice (see header)."""
    return f"reschedule-{uuid4().hex}"


def booking_correlation(booking_id: str) -> str:
    """The envelope correlation of one booking's reminder series."""
    return f"booking:{booking_id}"


def practice_correlation(practice_id: str) -> str:
    """The envelope correlation of a practice's master reminder."""
    return f"practice:{practice_id}"


class BookingRef(NamedTuple):
    """A booking whose reminder series is to be cancelled."""

    booking_id: str
    user_id: str


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

# BE-33: the master's own session, one hour out. A SEPARATE constant rather
# than a fourth entry in the series above -- the series is per BOOKING and
# fans out to participants; this one is per PRACTICE and goes to the person
# teaching it. They share an anchor and nothing else.
MASTER_REMINDER_TYPE = "practice.master_reminder_1h"
MASTER_REMINDER_LEAD = timedelta(hours=1)
MASTER_REMINDER_TYPES = [MASTER_REMINDER_TYPE]

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
    act: str,
) -> int:
    """Schedule the reminder series for one booking (anchor =
    practice.scheduled_at). Returns the number of reminders emitted
    (0..3 -- leads already inside the min-lead cutoff are skipped).

    act: BOOKED_ACT when the booking is made, a new_reschedule_act()
    when the practice moves -- part of every key (see header).
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
            idempotency_key=f"reminder:{booking_id}:{spec.type}:{act}",
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
                # Template variables (pre-rendered scalars):
                "practice_title": practice_title,
                "master_name": master_name,
                "scheduled_at": when_text,
            },
            scheduled_at=send_at,
            expiry_at=scheduled_at,
            correlation=booking_correlation(booking_id),
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
    """Cancel one booking's pending reminder series: correlation
    "booking:<booking_id>", scoped to the booker's user target (donor
    semantics of the per-booking cancel). Sent whether or not the series
    was ever scheduled -- a no-match cancel is a zero-row update."""
    await emit_reminder_cancel(
        session,
        types=BOOKING_REMINDER_TYPES,
        correlation=booking_correlation(booking_id),
        target_type="user",
        target_value=user_id,
    )


async def cancel_practice_reminders(
    session: AsyncSession,
    *,
    practice_id: str,
    bookings: Sequence[BookingRef],
) -> int:
    """Cancel every pending reminder of a practice (cancelled or
    rescheduled): one per-booking cancel for each of `bookings`, plus
    ONE cancel of the master's reminder by "practice:<practice_id>".

    A FAN-OUT, NOT ONE EVENT: comms cancels by equality on the job's one
    correlation, and a participant's series carries its booking's, not
    the practice's (module header). So which bookings to cancel is the
    CALLER'S answer, and only the caller knows it at the right moment --
    a practice cancellation refunds (and so cancels) the bookings BEFORE
    their reminders are cancelled, and a query here would find none of
    them still confirmed. Pass every booking that holds a series.

    The master cancel goes out even for a practice with no bookings: the
    master teaches it anyway, and a no-match cancel is a zero-row update.

    THE TYPE LIST IS THE OTHER HALF OF THE FILTER: comms cancels
    `Notification.type.in_(types)` AND the correlation, so a reminder
    type missing from its list survives. prompt.leave_feedback is on
    neither axis on purpose -- it is scheduled after the practice has
    already happened, so there is no cancellation of that practice left
    to apply, and it carries no correlation at all.

    Everything is queued in the caller's transaction: the practice change
    and the whole fan-out commit together or not at all.

    Returns the number of reminder_cancel events queued (len(bookings) + 1).
    """
    for ref in bookings:
        await cancel_booking_reminders(
            session, booking_id=ref.booking_id, user_id=ref.user_id,
        )
    await emit_reminder_cancel(
        session,
        types=MASTER_REMINDER_TYPES,
        correlation=practice_correlation(practice_id),
    )
    return len(bookings) + 1


async def schedule_master_practice_reminder(
    session: AsyncSession,
    *,
    practice_id: str,
    master_user_id: str,
    practice_title: str,
    scheduled_at: datetime,
    act: str,
) -> bool:
    """Schedule the master's own one-hour reminder for one practice.

    PER PRACTICE, NOT PER BOOKING, and that is the whole difference from
    schedule_booking_reminders: a master teaches the session whether or not
    anybody booked it, so an empty practice still gets its reminder. Its
    correlation is "practice:<practice_id>" for the same reason, which is
    what cancel_practice_reminders' master cancel matches on.

    act: PUBLISHED_ACT at publication (root or series child), a
    new_reschedule_act() when the practice moves (module header).

    Returns True when a reminder was emitted, False when the practice
    starts inside the min-lead cutoff (published an hour before it begins:
    the reminder would be due already, and scheduling into the past is what
    the cutoff exists to prevent).
    """
    now = datetime.now(UTC)
    send_at = scheduled_at - MASTER_REMINDER_LEAD
    cutoff = now + timedelta(
        seconds=settings.booking_reminder_min_lead_seconds,
    )
    if send_at < cutoff:
        return False

    when_text = format_event_time(scheduled_at)
    await emit_notification(
        session,
        idempotency_key=f"master-reminder:{practice_id}:{act}",
        type=MASTER_REMINDER_TYPE,
        target_type="user",
        target_value=master_user_id,
        title="Ваша практика через 1 час",
        body=(
            f"Вы ведёте практику «{practice_title}» через 1 час. "
            f"Начало: {when_text}."
        ),
        action_data={
            "action": "open_practice",
            "params": {"practice_id": practice_id},
            "practice_title": practice_title,
            "scheduled_at": when_text,
        },
        scheduled_at=send_at,
        expiry_at=scheduled_at,
        correlation=practice_correlation(practice_id),
    )
    logger.info(
        "master_practice_reminder_scheduled",
        practice_id=practice_id,
        master_user_id=master_user_id,
    )
    return True


async def schedule_feedback_prompt(
    session: AsyncSession,
    *,
    user_id: str,
    practice_id: str,
    practice_title: str,
) -> None:
    """practice_outcome -> a delayed prompt.leave_feedback nudge for
    one attendee (ID-6: the prompt rides the reminder mechanic, not a
    direct emit). Never cancelled, so it carries no correlation; its key
    is the fact "this attendee of this practice was asked" -- one per
    pair."""
    now = datetime.now(UTC)
    action_data: dict[str, Any] = {
        "action": "open_feedback",
        "params": {"practice_id": practice_id},
        "practice_title": practice_title,
    }
    await emit_notification(
        session,
        idempotency_key=f"feedback-prompt:{practice_id}:{user_id}",
        type=PROMPT_FEEDBACK_TYPE,
        target_type="user",
        target_value=user_id,
        title="Как прошла практика?",
        body=f"Поделитесь впечатлением о практике «{practice_title}».",  # noqa: RUF001
        action_data=action_data,
        scheduled_at=now + timedelta(
            seconds=settings.prompt_feedback_delay_seconds,
        ),
        expiry_at=now + timedelta(
            seconds=settings.prompt_feedback_expiry_seconds,
        ),
    )
