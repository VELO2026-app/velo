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
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import record_audit
from app.core.exceptions import BadRequestError, NotFoundError
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.payments.refund import refund_all_bookings_for_practice
from app.modules.practices.models import (
    AudienceKind,
    Practice,
    PracticeStatus,
)
from app.modules.practices.service import master_full_name
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
    curated_group_ids: list[UUID] | None = None,
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

    curated_group_ids (BE-21) is what tells this function WHO is cancelling:
    non-empty means the actor is a curator and lists the practice's schools
    they curate; empty or None means the actor is the practice's master. It
    is not a bool because the school journal needs the ids, and it is not
    derived here because the caller already had to compute it to decide
    whether the actor was allowed in at all -- asking twice would let the
    two answers drift.
    """
    acting_as_curator = bool(curated_group_ids)
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
    # migration. group_ids carries WHICH schools the right came from.
    audit_data: dict[str, object] = {"refunded_bookings": refunded_count}
    if acting_as_curator:
        audit_data["group_ids"] = [str(gid) for gid in curated_group_ids or []]
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
    # velo into per-user emits (C-boundary ID-4). The practice's whole
    # pending reminder series is expired by practice_id correlation.
    # All in the cancellation's transaction (ID-2).
    from app.core.events.notify import emit_notification
    from app.core.events.reminders import (
        cancel_practice_reminders,
        format_event_time,
    )
    when_text = format_event_time(practice.scheduled_at)
    for uid in affected_user_ids:
        await emit_notification(
            session,
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
        await emit_notification(
            session,
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
        session, practice_id=str(practice.id),
    )

    # BE-21: two things only a CURATOR cancellation produces.
    #
    # 1. The practice's own master is told. He was the actor until today,
    #    so nothing was ever sent to him -- notifying yourself is noise.
    #    Now he can lose a session to someone else's decision and the money
    #    can go back without him touching anything, so he is the one person
    #    who must not find out by opening the app. A master who is ALSO the
    #    curator never reaches this branch: he cancels as the owner, and
    #    acting_as_curator is false for him by construction.
    #
    # 2. Each school the ACTOR curates records it. Only theirs: a second
    #    school this practice was also addressed to did not cancel
    #    anything, and writing "the curator cancelled" into its journal
    #    would put someone else's action in its history. The consequence
    #    is real and is recorded as a known gap, not a fix: that school
    #    loses the practice with nothing in its journal to say so.
    if acting_as_curator:
        from app.modules.curator_groups.models import (
            CuratorGroup,
            CuratorGroupEventKind,
        )
        from app.modules.curator_groups.service import _record_group_event

        groups = list(
            (
                await session.execute(
                    select(CuratorGroup)
                    .where(CuratorGroup.id.in_(curated_group_ids or []))
                    .order_by(CuratorGroup.id)
                )
            ).scalars().all()
        )
        # Every school the actor curates, joined -- not just the first.
        # One person can curate two of a practice's target schools, and
        # picking one would hide from the master half of the reason his
        # practice is gone. The template's {group_name} is a scalar, so
        # the join happens here rather than as branching in two files.
        group_names = ", ".join(g.name for g in groups)
        await emit_notification(
            session,
            type="practice.cancelled_by_curator",
            target_type="user",
            target_value=str(practice.master_id),
            title="Вашу практику отменили",
            body=(
                f"Практику «{practice.title}» ({when_text}) отменил "
                f"куратор школы «{group_names}». "
                f"Участникам возвращена оплата."
            ),
            action_data={
                "action": "open_practice",
                "params": {"practice_id": str(practice.id)},
                "practice_title": practice.title,
                "scheduled_at": when_text,
                "group_name": group_names,
            },
        )
        for group in groups:
            _record_group_event(
                group.id,
                user,
                CuratorGroupEventKind.PRACTICE_CANCELLED,
                session,
                data={
                    "practice_id": str(practice.id),
                    "practice_title": practice.title,
                },
            )

    # E21: best-effort delete the practice's Zoom meeting so a cancelled
    # session can't still be joined via a still-live personal link. Skips
    # meetings that already have attendance segments, and never raises --
    # refunds/cancellation must proceed regardless of Zoom's outcome.
    from app.modules.zoom.service import delete_meeting_for_practice
    await delete_meeting_for_practice(practice, session)

    return refunded_count


async def cancel_practice(
    practice_id: UUID,
    user: User,
    session: AsyncSession,
    *,
    scope: str = "this",
) -> Practice:
    """Cancel a scheduled/live practice with full refund to all participants.

    The actor is either the practice's MASTER or, since BE-21, the CURATOR
    of a school this practice is addressed to. This is the ONLY path to
    Practice.status=cancelled (PATCH status=cancelled is intentionally
    blocked in _VALID_TRANSITIONS).

    scope:
      "this"            -- cancel only this occurrence (the historical default).
      "this_and_future" -- for a SERIES, also cancel every LATER occurrence of
                           the same series (scheduled_at >= this one's) that is
                           still cancellable. A non-series practice has no
                           siblings, so it behaves like "this". Past, completed,
                           or already-cancelled occurrences are never touched.
                           MASTER ONLY -- see the refusal below.

    Each affected occurrence is locked FOR UPDATE (P-12), refunded via the same
    double-entry flow, audited, and projected to the diary. Returns the primary
    practice (the one addressed by practice_id).

    Raises NotFoundError if not found, or if the actor is neither the owner
    nor an entitled curator (P-08: 404 not 403, and the SAME message and code
    in every one of those cases -- a distinct code would tell a stranger that
    the practice exists and that the school is simply not theirs).
    Raises BadRequestError if the primary practice is not in a cancellable
    state, or if a curator asks for the series cascade.
    """
    # Lock + validate the primary occurrence.
    primary = (
        await session.execute(
            select(Practice)
            .where(Practice.id == practice_id)
            .with_for_update()
        )
    ).scalar_one_or_none()

    if not primary:
        raise NotFoundError("Practice not found")

    # BE-21: two ways in. The master of the practice, as always; or the
    # curator of a school this practice is addressed to. Lazy import
    # because curator_groups/service.py imports practices/models.py, so a
    # module-level import here closes a cycle -- the same reason the five
    # imports inside _cancel_one are lazy.
    curated_group_ids: list[UUID] = []
    is_owner = primary.master_id == user.id
    if not is_owner:
        if primary.audience_kind == AudienceKind.CURATOR_GROUPS.value:
            from app.modules.curator_groups.service import (
                curated_group_ids_for_practice,
            )
            curated_group_ids = await curated_group_ids_for_practice(
                primary.id, user.id, session,
            )
        # P-08: 404, and deliberately the identical message and code the
        # "no such practice" branch above raises. "Not your school",
        # "not a school practice" and "no such practice" must be one
        # answer, or the difference between them is the leak.
        if not curated_group_ids:
            raise NotFoundError("Practice not found")

    if primary.status not in _CANCELLABLE_PRACTICE_STATUSES:
        raise BadRequestError(
            f"Cannot cancel practice in status "
            f"{primary.status}"
        )

    # BE-21: the series cascade stays MASTER-ONLY, and this is a decision,
    # not an oversight. The cascade's safety rests on the C2 filter below
    # -- Practice.master_id == user.id -- which scopes it to practices the
    # actor owns. A curator owns none of them, so the filter has no curator
    # equivalent that is not itself a new right over other people's
    # practices: the honest one ("every sibling must ALSO be addressed to
    # my school") means re-validating each sibling against the school, and
    # the value did not justify inventing a second cascade rule in this
    # delivery. Cost, named out loud rather than discovered: the curator of
    # an abandoned weekly series cancels it one occurrence at a time.
    if scope == "this_and_future" and not is_owner:
        raise BadRequestError(
            "Series cancellation is available to the practice's master only",
            code="curator_cannot_cancel_series",
        )

    # W-3: one shared instant for every occurrence this action cancels, so the
    # diary cards line up rather than drifting by microseconds.
    cancel_ts = datetime.now(UTC)
    await _cancel_one(
        primary,
        user,
        session,
        occurred_at=cancel_ts,
        curated_group_ids=curated_group_ids,
    )

    if scope == "this_and_future":
        # Series identity = the root id (parent if this is a child, else its own
        # id). Cancel later siblings of the SAME series that are still
        # cancellable; non-series practices have no siblings, so this is empty
        # and the call reduces to "this".
        root_id = primary.parent_practice_id or primary.id
        root_expr = func.coalesce(Practice.parent_practice_id, Practice.id)
        siblings = (
            (
                await session.execute(
                    select(Practice)
                    .where(
                        root_expr == root_id,
                        # SECURITY (C2): scope the cascade to the actor's
                        # OWN practices. root_id derives from
                        # parent_practice_id, which is client-writable
                        # via UpdatePracticeRequest -- without this
                        # filter a master could set their practice's
                        # parent to another master's series root and
                        # cancel+refund that whole series (cross-tenant
                        # mass refund, ledger debit, audit under the
                        # attacker's actor_id). The owner check on
                        # `primary` above does not cover the siblings.
                        # Defense-in-depth: holds even once
                        # parent_practice_id is removed from the update
                        # schema (the other half of the fix).
                        Practice.master_id == user.id,
                        Practice.id != primary.id,
                        Practice.scheduled_at >= primary.scheduled_at,
                        Practice.status.in_(_CANCELLABLE_PRACTICE_STATUSES),
                    )
                    .order_by(Practice.scheduled_at)
                    .with_for_update()
                )
            ).scalars().all()
        )
        for sibling in siblings:
            # No curated_group_ids: this loop is unreachable for a curator
            # (the cascade is refused above), so every sibling here is
            # cancelled by its own master.
            await _cancel_one(sibling, user, session, occurred_at=cancel_ts)

    return primary
