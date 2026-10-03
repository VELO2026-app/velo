# =============================================================================
# VELO Backend -- Practice Cancel Service (Phase 6.5, W26 split from service.py)
# =============================================================================
#
# Master cancels a scheduled/live practice (or a series scope), refunding all
# active bookings. This is the ONLY path to Practice.status=cancelled (PATCH
# status=cancelled is intentionally blocked in practices/service.py's
# _VALID_TRANSITIONS). Imports only master_full_name from the core.
# =============================================================================

from datetime import UTC, datetime
from uuid import UUID

import structlog
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import record_audit
from app.core.exceptions import BadRequestError, NotFoundError
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.payments.refund import refund_all_bookings_for_practice
from app.modules.practices.models import (
    Practice,
    PracticeStatus,
)
from app.modules.practices.service import (
    _manager_of_practice_or_404,
    master_full_name,
)
from app.modules.users.models import User

logger = structlog.get_logger()

# Statuses from which cancel_practice() is allowed.
_CANCELLABLE_PRACTICE_STATUSES = {
    PracticeStatus.SCHEDULED.value,
    PracticeStatus.LIVE.value,
}


async def _cancel_one(
    practice: Practice,
    user: User,
    session: AsyncSession,
    *,
    occurred_at: datetime | None = None,
    curated_group_id: UUID | None = None,
) -> int:
    """Cancel a single, already-locked + already-validated practice occurrence.

    Runs the full refund flow for ONE occurrence: collect booked users, refund
    all active bookings (+ clear waitlist), flip status to cancelled, audit, and
    project the diary "cancelled" event. The CALLER must have locked the row
    (FOR UPDATE), verified ownership, and confirmed the status is cancellable --
    this core does not re-check. Returns the number of refunded bookings.

    occurred_at is the diary timestamp for the projected "cancelled" event. A
    scope cancellation spanning several occurrences passes ONE shared instant so
    every diary card shares it (W-3); a lone call defaults to now.

    curated_group_id (BE-21, BE-74) is what tells this function WHO is
    cancelling: set means the actor is the curator of the school the
    practice belongs to, and the caller holds that school's row locked as
    its owner; None means the actor is the practice's master. It is not a
    bool because the school journal needs the id, and it is not derived
    here because the caller already had to compute it to decide whether
    the actor was allowed in at all -- asking twice would let the two
    answers drift.
    """
    acting_as_curator = curated_group_id is not None
    # Diary feed: collect the booked users BEFORE the refund flow runs --
    # refund_all_bookings_for_practice transitions bookings to cancelled, so
    # reading them afterwards would yield an empty set. Inline ORM query
    # (Booking/BookingStatus are already imported) -- we do not import the
    # private _booked_user_ids from diary.projections (P: no cross-module
    # private import, consistent with calendar C-1).
    affected_ids_stmt = (
        select(Booking.user_id)
        .where(
            Booking.practice_id == practice.id,
            Booking.status != BookingStatus.CANCELLED.value,
        )
        .distinct()
    )
    affected_user_ids = list(
        (await session.execute(affected_ids_stmt)).scalars().all()
    )

    # Comms (3.0.0): the bookings whose reminder series this cancellation
    # must cancel -- collected BEFORE the refund for the same reason as the
    # users above, and it matters more here: a booking's series is
    # cancelled by its own "booking:<id>" correlation, so a list read
    # after the refund would be empty and every participant's reminders
    # would survive the practice. The set is exactly the refund's
    # (refund_all_bookings_for_practice: PENDING + CONFIRMED) -- every
    # booking this cancellation cancels, the per-booking rule of
    # cancel_booking applied to each. A booking cancelled earlier had its
    # series cancelled then.
    reminder_refs_stmt = select(Booking.id, Booking.user_id).where(
        Booking.practice_id == practice.id,
        Booking.status.in_({
            BookingStatus.PENDING.value,
            BookingStatus.CONFIRMED.value,
        }),
    )
    reminder_rows = (await session.execute(reminder_refs_stmt)).all()

    # Comms (T1, dictionary §2): the waitlist branch of the
    # cancellation gets its own type (practice.cancelled_waitlist) --
    # collect the queue BEFORE refund_all_bookings_for_practice flips
    # every active waitlist entry to `left` (payments/refund.py), same
    # reason the booked users are collected above. Lazy import keeps
    # practices -> waitlist one-way at call time.
    from app.modules.waitlist.models import (
        ACTIVE_STATUSES as _WL_ACTIVE,
    )
    from app.modules.waitlist.models import Waitlist
    waitlist_ids_stmt = (
        select(Waitlist.user_id)
        .where(
            Waitlist.practice_id == practice.id,
            Waitlist.status.in_(_WL_ACTIVE),
        )
        .distinct()
    )
    waitlisted_user_ids = [
        uid
        for uid in (
            await session.execute(waitlist_ids_stmt)
        ).scalars().all()
        if uid not in set(affected_user_ids)
    ]

    # Refund all active bookings + clear waitlist.
    refunded_count = await refund_all_bookings_for_practice(
        practice=practice,
        session=session,
    )

    practice.status = PracticeStatus.CANCELLED.value

    # Audit (BE-21). A distinct EVENT VALUE, not a flag inside data: "show
    # me the cancellations a curator made" is a question the audit should
    # answer with an indexed equality on `event`, not with a JSONB probe.
    # AuditLog.event is String(100) with no CHECK, so a new value costs no
    # migration. group_id carries WHICH school the right came from.
    # BE-64: master_id beside group_id, as on every curator act of BE-63
    # (_tell_master_of_curator_act): actor_id is the curator, master_id the
    # practice's owner -- two people, and the audit row must name both.
    audit_data: dict[str, object] = {"refunded_bookings": refunded_count}
    if acting_as_curator:
        audit_data["group_id"] = str(curated_group_id)
        audit_data["master_id"] = str(practice.master_id)
    await record_audit(
        event=(
            "practice_cancelled_by_curator"
            if acting_as_curator
            else "practice_cancelled_by_master"
        ),
        actor_id=user.id,
        actor_type="user",
        target_type="practice",
        target_id=practice.id,
        data=audit_data,
        session=session,
    )

    # BE-21: actor_id is the ACTOR and master_id is the practice's OWNER --
    # the same value until a curator cancels, and two different people
    # after. The old single `master_id=user.id` field was true only by
    # coincidence of those two being the same person.
    logger.info(
        "practice_cancelled",
        practice_id=str(practice.id),
        master_id=str(practice.master_id),
        actor_id=str(user.id),
        cancelled_by="curator" if acting_as_curator else "master",
        refunded_bookings=refunded_count,
    )

    # Diary feed: fan out "master cancelled the practice" to the users who were
    # booked (collected above, before the refund). occurred_at is now. Master
    # name for the diary card: full "First Last" (MVP rule). Load the User
    # directly rather than get_master_display_name (notification helper).
    from app.modules.diary.projections import project_practice_cancelled
    master_user = await session.get(User, practice.master_id)
    master_name = master_full_name(
        master_user.first_name if master_user else None,
        master_user.last_name if master_user else None,
    )
    await project_practice_cancelled(
        session,
        practice=practice,
        master_name=master_name,
        user_ids=affected_user_ids,
        occurred_at=(
            occurred_at if occurred_at is not None else datetime.now(UTC)
        ),
        cancelled_by="curator" if acting_as_curator else "master",
    )

    # Comms (T1, dictionary §2): practice.cancelled to every booked
    # user + practice.cancelled_waitlist (its own sheet, type #16) to
    # the queue -- both audiences are DOMAIN relations, expanded by
    # velo into per-user emits (C-boundary ID-4). Every pending reminder
    # of the practice is cancelled as a fan-out: one cancel per booking
    # collected above, plus the master's (cancel_practice_reminders).
    # All in the cancellation's transaction (ID-2).
    from app.core.events.notify import emit_notification
    from app.core.events.reminders import (
        BookingRef,
        cancel_practice_reminders,
        format_event_time,
        user_timezones,
    )
    # BE-102 notification time: each reader (booked AND queued) reads THEIR
    # zone -- one query for both lists.
    reader_tz = await user_timezones(
        session, [*affected_user_ids, *waitlisted_user_ids],
    )

    def when_text_for(uid) -> str:
        return format_event_time(
            practice.scheduled_at, reader_tz.get(str(uid), "UTC"),
        )

    for uid in affected_user_ids:
        when_text = when_text_for(uid)
        await emit_notification(
            session,
            idempotency_key=f"practice-cancelled:{practice.id}:{uid}",
            type="practice.cancelled",
            target_type="user",
            target_value=str(uid),
            title="Практика отменена",
            body=(
                f"Практика «{practice.title}» ({when_text}) отменена. "
                f"Оплата возвращена на ваш баланс."
            ),
            action_data={
                "action": "open_wallet",
                "params": {"practice_id": str(practice.id)},
                "practice_title": practice.title,
                "scheduled_at": when_text,
            },
        )
    for uid in waitlisted_user_ids:
        when_text = when_text_for(uid)
        await emit_notification(
            session,
            idempotency_key=f"practice-cancelled-waitlist:{practice.id}:{uid}",
            type="practice.cancelled_waitlist",
            target_type="user",
            target_value=str(uid),
            title="Практика отменена",
            body=(
                f"Практика «{practice.title}» ({when_text}), на "
                f"которую вы стояли в листе ожидания, отменена."
            ),
            action_data={
                "action": "open_practice",
                "params": {"practice_id": str(practice.id)},
                "practice_title": practice.title,
                "scheduled_at": when_text,
            },
        )
    await cancel_practice_reminders(
        session,
        practice_id=str(practice.id),
        bookings=[
            BookingRef(booking_id=str(bid), user_id=str(uid))
            for bid, uid in reminder_rows
        ],
    )

    # BE-21: what only a CURATOR cancellation produces PER OCCURRENCE --
    # the school's journal row. The master's notification is once per
    # ACTION, not per occurrence, and is sent by cancel_practice after the
    # whole cascade (_tell_master_cancelled_by_curator, BE-64).
    #
    # A practice belongs to ONE school (BE-74), and the actor is its
    # curator, so there is no second school that "lost the practice with
    # nothing in its journal" -- the gap BE-21 named for several target
    # schools is gone with them. One row per cancelled occurrence (BE-64):
    # each row is one fact, and the row's data keeps the shape its readers
    # already know.
    #
    # NO SAVEPOINT AROUND THE JOURNAL ROW. BE-95 F8 wrapped it because a
    # school deleted after it was read failed the row's FK and the whole
    # cancellation with a 500. That state is now excluded by the lock
    # order: cancel_practice holds this practice FOR UPDATE and the
    # school locked as its owner (_lock_group_as_owner) before calling
    # here, so delete_curator_group -- which clears its practices'
    # owner before it deletes the school -- waits for this transaction.
    if acting_as_curator:
        from app.modules.curator_groups.models import CuratorGroupEventKind
        from app.modules.curator_groups.service import _record_group_event

        _record_group_event(
            curated_group_id,
            user,
            CuratorGroupEventKind.PRACTICE_CANCELLED,
            session,
            data={
                "practice_id": str(practice.id),
                "practice_title": practice.title,
            },
        )

    # E21: the practice's Zoom meeting goes dead with the practice, so a
    # cancelled session can't still be joined via a still-live personal
    # link: an active meeting's row is marked deleted here and the
    # Zoom-side DELETE is queued for the retry poller -- no Zoom HTTP
    # inside this transaction.
    # Skips meetings that already have attendance segments, and never
    # raises -- refunds/cancellation must proceed regardless of Zoom.
    from app.modules.zoom.service import delete_meeting_for_practice
    await delete_meeting_for_practice(practice, session)

    return refunded_count


async def _tell_master_cancelled_by_curator(
    primary: Practice,
    group_id: UUID,
    cancelled_count: int,
    session: AsyncSession,
) -> None:
    """Tell the practice's master that a school curator cancelled it -- ONCE
    per action (BE-64), however many occurrences the action cancelled.

    He was the actor until BE-21, so nothing was ever sent to him --
    notifying yourself is noise. Now he can lose a session to someone
    else's decision and the money can go back without him touching
    anything, so he is the one person who must not find out by opening
    the app. A master who is ALSO the curator never gets here: he cancels
    as the owner (_manager_of_practice_or_404 answers None for him).

    ONE NOTIFICATION FOR A CASCADE, keyed on the PRIMARY occurrence: the
    action is one fact, and the primary is cancelled exactly once, so the
    key names that fact and nothing else.

    cancelled_count is every occurrence THIS action cancelled, the primary
    included -- so it is >= 1, and 1 for a single cancellation and for a
    series with nothing left ahead; occurrences cancelled or completed
    earlier are not counted. Sent ALWAYS, and the line that shows it is
    unconditional in both the telegram templates and the in-app body: the
    comms template language has no conditions, so "say it only for a
    cascade" is not a template's to decide, and a missing variable would
    render as a literal "{cancelled_count}" (SafeDict). The in-app
    title/body are Russian for everyone (owner, i18n is outside the MVP).
    """
    from app.core.events.notify import emit_notification
    from app.core.events.reminders import format_event_time
    from app.modules.curator_groups.models import CuratorGroup

    group = await session.get(CuratorGroup, group_id)
    # The reader is the master -> the practice's zone (BE-102 notification time).
    when_text = format_event_time(primary.scheduled_at, primary.timezone)
    await emit_notification(
        session,
        idempotency_key=f"practice-cancelled-by-curator:{primary.id}",
        type="practice.cancelled_by_curator",
        target_type="user",
        target_value=str(primary.master_id),
        title="Вашу практику отменили",
        body=(
            f"Практику «{primary.title}» ({when_text}) отменил "
            f"куратор школы «{group.name}». "
            f"Отменено занятий: {cancelled_count}. "
            f"Участникам возвращена оплата."
        ),
        action_data={
            "action": "open_practice",
            "params": {"practice_id": str(primary.id)},
            "practice_title": primary.title,
            "scheduled_at": when_text,
            "group_name": group.name,
            "cancelled_count": cancelled_count,
        },
    )


def _right_over_sibling(user: User, curated_group_id: UUID | None):
    """THE ACTOR'S RIGHT OVER EACH OCCURRENCE OF THE SERIES, as a predicate
    -- the one rule (_manager_of_practice_or_404) asked of every row at once:
      - the master (curated_group_id None): Practice.master_id == user.id
        (C2). Defense in depth since C2-b removed parent_practice_id from
        UpdatePracticeRequest: the series identity is set at birth only.
      - the curator (BE-64): Practice.curator_group_id == the school.
        Every occurrence of a series is born with its root's master and
        school (_owned_root_parent_or_400, the school check in
        create_practice, _build_child_occurrence), the school never
        changes afterwards and delete_curator_group clears it from all of
        a school's practices in one statement (BE-74). So no series has a
        sibling outside the school, and this predicate is not a guard
        against such a state: it is the curator's right, stated where the
        rows are chosen. Deliberately NOT master_id == primary.master_id:
        that is not the curator's right, and once a series may have
        occurrences of several masters (B2) it would silently narrow the
        cancellation.
    """
    return (
        Practice.master_id == user.id
        if curated_group_id is None
        else Practice.curator_group_id == curated_group_id
    )


async def _lock_cancel_set(
    read: Practice,
    user: User,
    curated_group_id: UUID | None,
    scope: str,
    session: AsyncSession,
) -> list[Practice]:
    """Lock every practice this cancellation may touch -- in ONE statement,
    ORDER BY id (PRACTICE ROW ORDER, practices/service.py).

    The set is the primary itself plus, for "this_and_future", its series:
    the same root, the actor's right over each row, still cancellable. The
    TIME BOUNDARY (later than the primary) is deliberately NOT in this
    statement: it would come from the unlocked read, and the primary's
    scheduled_at can be moved (UpdatePracticeRequest) between that read
    and this lock. FOR UPDATE re-checks the rows, not the parameters of
    the predicate -- so the boundary is applied after the lock, from the
    locked primary (cancel_practice). The cost: earlier non-terminal
    occurrences of the series are locked too, and released at commit
    untouched; past ones are normally completed and fall out on status.

    The root id from the read does not go stale: parent_practice_id is set
    at birth and never written again (C2-b removed it from
    UpdatePracticeRequest; one school per series, BE-74).

    populate_existing: the read put the primary into this session, and a
    lock does not refresh an object already there (BE-85).
    """
    wanted = Practice.id == read.id
    if scope == "this_and_future":
        root_id = read.parent_practice_id or read.id
        root_expr = func.coalesce(Practice.parent_practice_id, Practice.id)
        wanted = or_(
            wanted,
            and_(
                root_expr == root_id,
                _right_over_sibling(user, curated_group_id),
                Practice.status.in_(_CANCELLABLE_PRACTICE_STATUSES),
            ),
        )
    return list(
        (
            await session.execute(
                select(Practice)
                .where(wanted)
                .order_by(Practice.id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalars().all()
    )


async def _primary_and_later(
    practice_id: UUID, locked: list[Practice],
) -> tuple[Practice, list[Practice]]:
    """The locked primary, checked, and the occurrences after it.

    Everything here is decided on LOCKED rows: the primary's status and
    the time boundary come from the row this transaction holds, not from
    the read that chose the set. A primary gone between the read and the
    lock (a draft deleted) is the stranger's 404 (P-08).

    Async although it awaits nothing: it is the point right after the
    practice rows are taken, and the race tests pause there
    (tests/test_practice_row_order.py).
    """
    primary = next((p for p in locked if p.id == practice_id), None)
    if primary is None:
        raise NotFoundError("Practice not found")
    if primary.status not in _CANCELLABLE_PRACTICE_STATUSES:
        raise BadRequestError(
            f"Cannot cancel practice in status "
            f"{primary.status}"
        )
    later = [
        p for p in locked
        if p.id != primary.id
        and p.scheduled_at >= primary.scheduled_at
        and p.status in _CANCELLABLE_PRACTICE_STATUSES
    ]
    return primary, later


async def cancel_practice(
    practice_id: UUID,
    user: User,
    session: AsyncSession,
    *,
    scope: str = "this",
) -> Practice:
    """Cancel a scheduled/live practice with full refund to all participants.

    The actor is either the practice's MASTER or the CURATOR of the school
    this practice belongs to (BE-21; any practice of the school, public
    included, since BE-64). This is the ONLY path to
    Practice.status=cancelled (PATCH status=cancelled is intentionally
    blocked in _VALID_TRANSITIONS).

    scope:
      "this"            -- cancel only this occurrence (the historical default).
      "this_and_future" -- for a SERIES, also cancel every LATER occurrence of
                           the same series (scheduled_at >= this one's) that is
                           still cancellable. A non-series practice has no
                           siblings, so it behaves like "this". Past, completed,
                           or already-cancelled occurrences are never touched.
                           Open to the curator too since BE-64.

    Each affected occurrence is locked FOR UPDATE (P-12), refunded via the same
    double-entry flow, audited, and projected to the diary. A curator's
    action also writes one school-journal row per occurrence and ONE
    notification to the master. Returns the primary practice (the one
    addressed by practice_id).

    Raises NotFoundError if not found, or if the actor is neither the owner
    nor the curator of the practice's school (P-08: 404 not 403, and the
    SAME message and code in every one of those cases -- a distinct code
    would tell a stranger that the practice exists and that the school is
    simply not theirs).
    Raises BadRequestError if the primary practice is not in a cancellable
    state.
    """
    # READ, not lock: the right and the shape of the set are decided on an
    # unlocked copy, and every row is then taken in ONE statement by id
    # (PRACTICE ROW ORDER, practices/service.py). Taking the primary first
    # and its series after was a 40P01 against delete_curator_group and
    # block_student (BE-64 follow-up, O1/O2).
    read = (
        await session.execute(select(Practice).where(Practice.id == practice_id))
    ).scalar_one_or_none()
    if read is None:
        raise NotFoundError("Practice not found")

    # BE-63: "the master or the curator of the practice's school" is ONE
    # rule, _manager_of_practice_or_404 -- asked here exactly as by
    # update_practice and delete_practice. None: the actor is the master;
    # a school id: the actor curates the practice's school; anyone else:
    # the same 404 as "no such practice" (P-08). BE-64 removed the
    # audience restriction this function used to ask first. Asked on the
    # read: master_id and the school never change (BE-74), and the
    # curator's hold on the school is re-checked under the group lock
    # below.
    curated_group_id = await _manager_of_practice_or_404(
        read, user, session,
    )

    locked = await _lock_cancel_set(
        read, user, curated_group_id, scope, session,
    )
    primary, siblings = await _primary_and_later(practice_id, locked)

    # The school comes AFTER every practice row (practice -> group,
    # curator_groups/service.py header).
    # BE-74 (the BE-59 finding, carried here): OWNERSHIP RE-CHECKED UNDER
    # THE GROUP LOCK before anything is written. curated_group_id_for_
    # practice is a read, and the school can change hands between it and
    # this point -- a former curator mid-handover would then cancel a
    # practice of the new owner's school, refund its participants and write
    # into its journal. The group is taken once, at this strength, after
    # every practice row and before the journal rows _cancel_one inserts.
    # A refusal here has written nothing; the 404 is the stranger's, for
    # P-08's reason.
    if curated_group_id is not None:
        from app.modules.curator_groups.service import _lock_group_as_owner
        if not await _lock_group_as_owner(user.id, curated_group_id, session):
            raise NotFoundError("Practice not found")

    # W-3: one shared instant for every occurrence this action cancels, so the
    # diary cards line up rather than drifting by microseconds.
    cancel_ts = datetime.now(UTC)
    for occurrence in (primary, *siblings):
        await _cancel_one(
            occurrence,
            user,
            session,
            occurred_at=cancel_ts,
            curated_group_id=curated_group_id,
        )

    if curated_group_id is not None:
        await _tell_master_cancelled_by_curator(
            primary, curated_group_id, 1 + len(siblings), session,
        )

    return primary
