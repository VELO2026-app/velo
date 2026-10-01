# =============================================================================
# VELO Backend -- Zoom Meeting Creation Retry Poller (E21 step D)
# =============================================================================
#
# Background asyncio.Task, same shape as run_autofinalizer
# (bookings/autofinalize.py) and run_processor (notifications/processor.py):
# runs inside FastAPI lifespan, per-row isolated try/except so one meeting's
# failure never blocks another, exponential backoff on empty polls.
#
# WHY:
#   Publishing a practice must always succeed even if Zoom is unreachable
#   (E21 plan sec 2) -- so a failed meeting creation is recorded as
#   ZoomMeeting.status=create_failed rather than raised. This worker is what
#   actually retries those rows afterward, capped
#   (settings.zoom_meeting_create_max_retries) so a permanently-broken
#   config doesn't retry forever -- past the cap the row stays VISIBLY
#   create_failed (retry_count + last_sync_error both readable), the poller
#   just stops touching it.
#
#   PROMPT №559: this worker ALSO makes the FIRST (not just retry) attempt for
#   status=pending_creation rows -- a series child beyond the nearest
#   occurrence, whose Zoom meeting creation is deliberately deferred here
#   rather than made synchronously during publish (series_service.py).
#   attempt_zoom_meeting_create doesn't distinguish "first try" from "retry #N"; both
#   states are claimed by the same query and processed identically.
#
#   BE-96: this worker ALSO makes every Zoom-side registrant CANCEL. A
#   booking cancel (cancel_booking, block_student) only marks our row
#   cancelled and zoom_cancel_pending inside its own transaction; the call
#   to Zoom is made here, after that commit -- see the cancel phase at the
#   end of this module.
#
# SESSION / ISOLATION:
#   Each row is retried in its OWN session/transaction, claimed with
#   FOR UPDATE SKIP LOCKED so a row already being retried (or edited
#   concurrently) is skipped this tick, not double-processed.
# =============================================================================

import asyncio
from datetime import UTC, datetime

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_session_factory
from app.modules.practices.models import Practice
from app.modules.users.models import User
from app.modules.zoom.models import (
    ZoomMeeting,
    ZoomMeetingStatus,
    ZoomRegistrant,
    ZoomRegistrantStatus,
)
from app.modules.zoom.service import (
    ensure_host_registrant,
    ensure_shared_registrant,
    log_if_link_unavailable,
)
from app.modules.zoom.zoom_client import (
    ZoomAPIError,
    create_meeting,
    create_registrant,
    update_registrant_status,
)

logger = structlog.get_logger()


# ===================================================================
# Main loop
# ===================================================================


async def run_zoom_retry_poller() -> None:
    """Main retry-poller loop. Runs until cancelled.

    Called from FastAPI lifespan as a background task. Catches all
    exceptions to prevent the loop from dying.
    """
    base_interval = settings.zoom_retry_poll_interval_seconds
    max_backoff = settings.zoom_retry_max_backoff_seconds
    interval = base_interval

    logger.info(
        "zoom_retry_poller_started",
        poll_interval=base_interval,
        max_backoff=max_backoff,
        max_retries=settings.zoom_meeting_create_max_retries,
    )

    while True:
        try:
            work_done = await _poll_cycle()

            if work_done:
                interval = base_interval
            else:
                interval = min(interval * 2, max_backoff)

        except asyncio.CancelledError:
            logger.info("zoom_retry_poller_stopped")
            return
        except Exception:
            logger.exception("zoom_retry_poller_error")
            interval = max_backoff

        try:
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            logger.info("zoom_retry_poller_stopped")
            return


# ===================================================================
# Poll cycle
# ===================================================================


async def _poll_cycle() -> bool:
    """Retry every create_failed ZoomMeeting row, and attempt every
    pending_creation one for the first time (PROMPT №559), both still under
    the cap, THEN every pending/create_failed ZoomRegistrant row whose
    meeting is now active (step E: a booking made while the meeting wasn't
    active yet, or whose registrant call failed, queues here).

    Returns True if at least one row (meeting OR registrant) was retried
    (regardless of outcome -- a retry that fails again still counts as work
    done, matching run_autofinalizer's "work found resets backoff"
    semantics).
    """
    meeting_ids = await _claim_retryable_ids()
    meetings_retried = 0
    for meeting_id in meeting_ids:
        if await _retry_one(meeting_id):
            meetings_retried += 1
    if meetings_retried > 0:
        logger.info("zoom_retry_batch", retried=meetings_retried)

    registrant_ids = await _claim_retryable_registrant_ids()
    registrants_retried = 0
    for registrant_id in registrant_ids:
        if await _retry_registrant_one(registrant_id):
            registrants_retried += 1
    if registrants_retried > 0:
        logger.info("zoom_registrant_retry_batch", retried=registrants_retried)

    # Zoom-side cancels AFTER creates: a create this cycle that raced a
    # booking cancel has committed its id by now, so the same cycle can
    # cancel it.
    cancel_ids = await _claim_cancel_pending_registrant_ids()
    cancels_done = 0
    for registrant_id in cancel_ids:
        if await _cancel_registrant_one(registrant_id):
            cancels_done += 1
    if cancels_done > 0:
        logger.info("zoom_registrant_cancel_batch", processed=cancels_done)

    return (meetings_retried + registrants_retried + cancels_done) > 0


async def _claim_retryable_ids() -> list:
    """Return ids of ZoomMeeting rows still eligible for a creation attempt
    -- either a genuine RETRY (create_failed) or a FIRST attempt that was
    deliberately deferred (pending_creation, PROMPT №559: series children
    beyond the nearest occurrence). attempt_zoom_meeting_create below treats both
    identically -- same Zoom call, same success/failure handling, same 429
    exemption -- a pending_creation row simply has retry_count=0 going in."""
    factory = get_session_factory()
    cap = settings.zoom_meeting_create_max_retries

    try:
        async with factory() as session:
            stmt = (
                select(ZoomMeeting.id)
                .where(
                    ZoomMeeting.status.in_(
                        [
                            ZoomMeetingStatus.CREATE_FAILED.value,
                            ZoomMeetingStatus.PENDING_CREATION.value,
                        ]
                    ),
                    ZoomMeeting.retry_count < cap,
                )
                .order_by(ZoomMeeting.created_at.asc())
                .with_for_update(skip_locked=True)
            )
            result = await session.execute(stmt)
            ids = list(result.scalars().all())
            # Read-only claim: release the SKIP LOCKED locks now rather than
            # holding them until session close.
            await session.rollback()
            return ids
    except Exception:
        logger.exception("zoom_retry_claim_error")
        return []


async def _retry_one(meeting_id) -> bool:
    """Retry meeting creation for one ZoomMeeting row, in its own transaction.

    Returns True whether the retry succeeded or failed (both are "work
    done" for backoff purposes) -- False only on an unexpected error that
    prevented even attempting the retry.
    """
    factory = get_session_factory()

    try:
        async with factory() as session:
            row = (
                await session.execute(
                    select(ZoomMeeting)
                    .where(ZoomMeeting.id == meeting_id)
                    .with_for_update()
                )
            ).scalar_one_or_none()
            if row is None or row.status not in (
                ZoomMeetingStatus.CREATE_FAILED.value,
                ZoomMeetingStatus.PENDING_CREATION.value,
            ):
                # Lost the race (already retried/resolved elsewhere).
                await session.rollback()
                return False

            practice = await session.get(Practice, row.practice_id)
            if practice is None:
                # Practice gone -- nothing left to create a meeting for.
                await session.rollback()
                return False

            await attempt_zoom_meeting_create(row, practice, session)
            await session.commit()
            return True
    except Exception:
        logger.exception("zoom_retry_failed", meeting_id=str(meeting_id))
        return False


async def attempt_zoom_meeting_create(
    row: ZoomMeeting,
    practice: Practice,
    session: AsyncSession,
) -> None:
    """One creation attempt against the Zoom API, updating `row` in place.

    Never raises -- ZoomAPIError (and anything else) is caught and recorded
    as last_sync_error, same posture as the initial attempt in
    practices/service.py. Caller commits.

    SW13 (Батч B, PROMPT №579): "anything else" above used to be aspirational
    only -- a non-ZoomAPIError exception (e.g. a malformed response.get()
    call, an unwrapped network error) propagated straight past this
    function's own except clause to _retry_one's outer `except Exception`,
    which never touches retry_count or row.status. The row would then be
    reclaimed and reattempted every cycle forever, uncapped, without ever
    surfacing create_failed -- the exact silent-failure mode the cap exists
    to prevent, just via a different door. The broad `except Exception`
    below closes it: any non-ZoomAPIError failure now counts against the
    cap exactly like a generic (non-429) ZoomAPIError does.

    A4 V2 (PROMPT №572): public (no leading underscore) -- besides
    _retry_one's own automatic-poller call below, practices/router.py's
    retry_zoom_meeting_endpoint calls this directly for a master-triggered
    "Повторить" on a create_failed meeting, so the master does not have to
    wait for the poller's next cycle (which can be minutes away if it has
    backed off from idling). Caller owns the row's FOR UPDATE lock either
    way -- this function itself takes no lock and commits nothing.

    RATE LIMIT (429) IS EXEMPT FROM THE RETRY CAP (PROMPT №520, series-hole
    volume answer). A generic failure (bad config, network down, Zoom
    outage) counts against retry_count and eventually gives up visibly --
    that's the cap's whole purpose. A 429 is categorically different: Zoom
    is explicitly saying "you will succeed later, just not today" (its
    documented 100 meeting-creations/day/host limit). Counting that against
    the same 5-attempt cap would exhaust it within minutes at this poller's
    base interval, permanently abandoning a child practice that would have
    succeeded the moment the daily quota reset -- turning "the poller
    retries tomorrow" from a chosen answer into an accident. So: on 429,
    retry_count is NOT incremented, the row stays create_failed, and the
    NEXT poll cycle claims it again -- retried every cycle, uncapped, until
    either it succeeds or a genuine (non-429) failure occurs, at which
    point normal cap counting resumes.
    """
    try:
        response = await create_meeting(
            topic=practice.title,
            start_time_iso=practice.scheduled_at.astimezone(UTC).isoformat(),
            duration_minutes=practice.duration_minutes,
            timezone=practice.timezone,
        )
        row.zoom_meeting_id = str(response.get("id"))
        row.zoom_meeting_uuid = response.get("uuid")
        row.host_zoom_user_id = response.get("host_id")
        row.status = ZoomMeetingStatus.ACTIVE.value
        row.last_sync_error = None
        row.retry_count += 1
        logger.info(
            "zoom_meeting_retry_succeeded",
            practice_id=str(practice.id),
            zoom_meeting_id=row.zoom_meeting_id,
            attempt=row.retry_count,
        )
        await ensure_host_registrant(row, practice, session)
        # T24-38 (PROMPT №642): same reasoning as the initial-creation call
        # site (service.py's create_meeting_for_practice) -- a meeting that
        # only succeeded on a RETRY still needs its shared registrant minted
        # here, since this is the only other place the meeting flips ACTIVE.
        await ensure_shared_registrant(row, session)
    except ZoomAPIError as exc:
        if exc.status_code == 429:
            row.last_sync_error = (
                f"create_meeting rate-limited (429): {exc.body} -- "
                f"not counted against the retry cap, retried next cycle"
            )
            logger.warning(
                "zoom_meeting_retry_rate_limited",
                practice_id=str(practice.id),
                retry_count=row.retry_count,
            )
            return

        row.status = ZoomMeetingStatus.CREATE_FAILED.value
        row.retry_count += 1
        at_cap = row.retry_count >= settings.zoom_meeting_create_max_retries
        suffix = " (retry cap reached, no further attempts)" if at_cap else ""
        row.last_sync_error = (
            f"create_meeting retry #{row.retry_count} failed: "
            f"status={exc.status_code} body={exc.body}{suffix}"
        )
        logger.warning(
            "zoom_meeting_retry_failed",
            practice_id=str(practice.id),
            attempt=row.retry_count,
            at_cap=at_cap,
            status_code=exc.status_code,
        )
    except Exception as exc:
        row.status = ZoomMeetingStatus.CREATE_FAILED.value
        row.retry_count += 1
        at_cap = row.retry_count >= settings.zoom_meeting_create_max_retries
        suffix = " (retry cap reached, no further attempts)" if at_cap else ""
        row.last_sync_error = (
            f"create_meeting retry #{row.retry_count} failed with an "
            f"unexpected (non-Zoom-API) error: {exc!r}{suffix}"
        )
        logger.exception(
            "zoom_meeting_retry_unexpected_error",
            practice_id=str(practice.id),
            attempt=row.retry_count,
            at_cap=at_cap,
        )


# ===================================================================
# Registrant retry phase (E21 step E)
# ===================================================================


async def _claim_retryable_registrant_ids() -> list:
    """Return ids of ZoomRegistrant rows eligible for a retry: pending (the
    meeting wasn't active at booking time) or create_failed (the Zoom call
    itself failed), under the cap, AND whose meeting is now active -- a
    registrant for a still-create_failed meeting has nothing to register
    against yet and is left alone (the meeting phase above owns getting the
    meeting itself active first)."""
    factory = get_session_factory()
    cap = settings.zoom_registrant_create_max_retries

    try:
        async with factory() as session:
            stmt = (
                select(ZoomRegistrant.id)
                .join(ZoomMeeting, ZoomRegistrant.zoom_meeting_id == ZoomMeeting.id)
                .where(
                    ZoomRegistrant.status.in_(
                        [
                            ZoomRegistrantStatus.PENDING.value,
                            ZoomRegistrantStatus.CREATE_FAILED.value,
                        ]
                    ),
                    ZoomRegistrant.retry_count < cap,
                    ZoomMeeting.status == ZoomMeetingStatus.ACTIVE.value,
                )
                .order_by(ZoomRegistrant.created_at.asc())
                .with_for_update(of=ZoomRegistrant, skip_locked=True)
            )
            result = await session.execute(stmt)
            ids = list(result.scalars().all())
            await session.rollback()
            return ids
    except Exception:
        logger.exception("zoom_registrant_retry_claim_error")
        return []


async def _retry_registrant_one(registrant_id) -> bool:
    """Retry Zoom registrant creation for one row, in its own transaction.

    Same posture as _retry_one for meetings: True whether the attempt
    succeeded or failed (both count as work done), False only if an
    unexpected error prevented even attempting it.
    """
    factory = get_session_factory()

    try:
        async with factory() as session:
            row = (
                await session.execute(
                    select(ZoomRegistrant)
                    .where(ZoomRegistrant.id == registrant_id)
                    .with_for_update()
                )
            ).scalar_one_or_none()
            if row is None or row.status not in (
                ZoomRegistrantStatus.PENDING.value,
                ZoomRegistrantStatus.CREATE_FAILED.value,
            ):
                await session.rollback()
                return False

            zoom_meeting = await session.get(ZoomMeeting, row.zoom_meeting_id)
            if zoom_meeting is None or zoom_meeting.status != ZoomMeetingStatus.ACTIVE.value:
                await session.rollback()
                return False

            await _attempt_registrant_create(row, zoom_meeting, session)
            await session.commit()
            # BE-72: this attempt may be the one that left the row without a
            # link for good -- the cap reached, or a success Zoom answered
            # without a join_url. After the commit (expire_on_commit=False,
            # core/database.py), so a commit that fails logs nothing and the
            # retried attempt is the one counted; and after the attempt, so
            # the 429 branch, which returns early, passes the same line.
            log_if_link_unavailable(row)
            return True
    except Exception:
        logger.exception(
            "zoom_registrant_retry_failed", registrant_id=str(registrant_id),
        )
        return False


async def _attempt_registrant_create(
    row: ZoomRegistrant,
    zoom_meeting: ZoomMeeting,
    session: AsyncSession,
) -> None:
    """One registrant-creation attempt, updating `row` in place. Same 429
    exemption as attempt_zoom_meeting_create above, same reasoning -- a rate-limited
    registrant call is retried indefinitely without burning the cap.

    Names are re-fetched from User via row.user_id (ZoomRegistrant doesn't
    store them -- only the frozen registration_email) rather than sent
    blank/placeholder, so a retried registrant shows the real person's name
    on Zoom's side, not a generic stand-in.

    SW13 (Батч B, PROMPT №579): same broad `except Exception` fallback as
    attempt_zoom_meeting_create above, same reasoning -- a non-ZoomAPIError
    exception must still count against the cap, or it retries forever
    without ever surfacing create_failed.
    """
    user = await session.get(User, row.user_id)
    first_name = (user.first_name if user else None) or "VELO"
    last_name = (user.last_name if user else None) or "User"
    try:
        response = await create_registrant(
            zoom_meeting_id=zoom_meeting.zoom_meeting_id,
            email=row.registration_email,
            first_name=first_name,
            last_name=last_name,
        )
        row.zoom_registrant_id = response.get("registrant_id") or response.get("id")
        row.join_url = response.get("join_url")
        row.status = ZoomRegistrantStatus.REGISTERED.value
        row.last_sync_error = None
        row.retry_count += 1
        logger.info(
            "zoom_registrant_retry_succeeded",
            registrant_id=str(row.id),
            attempt=row.retry_count,
        )
    except ZoomAPIError as exc:
        if exc.status_code == 429:
            # Status left UNTOUCHED -- same as attempt_zoom_meeting_create's
            # 429 branch above. Setting CREATE_FAILED here contradicted
            # last_sync_error's own "retried next cycle" claim: a row still
            # PENDING on its first attempt would be forced into
            # CREATE_FAILED for no reason (cosmetic here, since both
            # statuses are equally claimable by
            # _claim_retryable_registrant_ids -- but the row's actual state
            # should say what happened, not something else).
            row.last_sync_error = (
                f"create_registrant rate-limited (429): {exc.body} -- "
                f"not counted against the retry cap, retried next cycle"
            )
            logger.warning(
                "zoom_registrant_retry_rate_limited", registrant_id=str(row.id),
            )
            return

        row.status = ZoomRegistrantStatus.CREATE_FAILED.value
        row.retry_count += 1
        at_cap = row.retry_count >= settings.zoom_registrant_create_max_retries
        suffix = " (retry cap reached, no further attempts)" if at_cap else ""
        row.last_sync_error = (
            f"create_registrant retry #{row.retry_count} failed: "
            f"status={exc.status_code} body={exc.body}{suffix}"
        )
        logger.warning(
            "zoom_registrant_retry_failed",
            registrant_id=str(row.id),
            attempt=row.retry_count,
            at_cap=at_cap,
            status_code=exc.status_code,
        )
    except Exception as exc:
        row.status = ZoomRegistrantStatus.CREATE_FAILED.value
        row.retry_count += 1
        at_cap = row.retry_count >= settings.zoom_registrant_create_max_retries
        suffix = " (retry cap reached, no further attempts)" if at_cap else ""
        row.last_sync_error = (
            f"create_registrant retry #{row.retry_count} failed with an "
            f"unexpected (non-Zoom-API) error: {exc!r}{suffix}"
        )
        logger.exception(
            "zoom_registrant_retry_unexpected_error",
            registrant_id=str(row.id),
            attempt=row.retry_count,
            at_cap=at_cap,
        )


# ===================================================================
# Registrant cancel phase (BE-96)
# ===================================================================
#
# cancel_registrant_for_booking (zoom/service.py) no longer calls Zoom: it
# sets our row cancelled and zoom_cancel_pending=True inside the caller's
# transaction, and this phase makes the Zoom-side cancel after commit, one
# row per transaction. The queue lives in the row, so a process dying after
# the booking cancel committed loses nothing -- the flag is still there on
# the next cycle, after a restart included.
#
# THE WINDOW IS AN OWNER DECISION, not a pending gap. Between the booking
# cancel and this phase the registrant is still live on Zoom's side: up to
# zoom_retry_poll_interval_seconds while the poller is busy, up to
# zoom_retry_max_backoff_seconds (600 s by default) after an idle stretch.
# The owner accepted a window of up to 10 minutes (BE-96). What bounds it:
# our own pages stop handing the link out at once (resolve_zoom_entry and
# the booking lists read only non-cancelled rows), and attendance ingest
# never credits a cancelled booking -- only someone holding the raw Zoom
# URL can still enter in that window.
#
# Repeats: a process dying after Zoom answered but before this phase's
# commit repeats the call next cycle. How Zoom answers a cancel of an
# already-cancelled registrant is not established (E21); whatever it is,
# the repeat is bounded by settings.zoom_registrant_cancel_max_retries.


async def _claim_cancel_pending_registrant_ids() -> list:
    """Ids of cancelled rows still waiting for their Zoom-side cancel,
    under the cap. FOR UPDATE SKIP LOCKED, same as the other claims."""
    factory = get_session_factory()
    cap = settings.zoom_registrant_cancel_max_retries

    try:
        async with factory() as session:
            stmt = (
                select(ZoomRegistrant.id)
                .where(
                    ZoomRegistrant.status == ZoomRegistrantStatus.CANCELLED.value,
                    ZoomRegistrant.zoom_cancel_pending.is_(True),
                    ZoomRegistrant.zoom_cancel_attempts < cap,
                )
                .order_by(ZoomRegistrant.updated_at.asc())
                .with_for_update(of=ZoomRegistrant, skip_locked=True)
            )
            ids = list((await session.execute(stmt)).scalars().all())
            await session.rollback()
            return ids
    except Exception:
        logger.exception("zoom_registrant_cancel_claim_error")
        return []


async def _cancel_registrant_one(registrant_id) -> bool:
    """One Zoom-side cancel, in its own transaction. Locks only the
    registrant row -- never a Practice or a Booking.

    True when the row was processed (cleared, retried later, or counted as
    a failure), False when it was no longer eligible or an unexpected error
    prevented even attempting it.
    """
    factory = get_session_factory()

    try:
        async with factory() as session:
            row = (
                await session.execute(
                    select(ZoomRegistrant)
                    .where(ZoomRegistrant.id == registrant_id)
                    .with_for_update()
                )
            ).scalar_one_or_none()
            if row is None or not row.zoom_cancel_pending:
                await session.rollback()
                return False

            await _attempt_registrant_cancel(row, session)
            await session.commit()
            return True
    except Exception:
        logger.exception(
            "zoom_registrant_cancel_one_failed", registrant_id=str(registrant_id),
        )
        return False


async def _attempt_registrant_cancel(
    row: ZoomRegistrant,
    session: AsyncSession,
) -> None:
    """One Zoom cancel attempt, updating `row` in place.

    Nothing to tell Zoom -- no zoom_registrant_id (the create never
    succeeded), or no Zoom meeting -- clears the flag without a call.
    Success clears it. 404 means Zoom has no such registrant or meeting:
    there is nothing left to cancel, the flag is cleared. 429 leaves the
    row untouched and uncounted, same exemption as the create phase. Any
    other failure counts against the cap; at the cap the row stays visibly
    pending with last_sync_error saying so.
    """
    zoom_meeting = await session.get(ZoomMeeting, row.zoom_meeting_id)
    if (
        not row.zoom_registrant_id
        or zoom_meeting is None
        or not zoom_meeting.zoom_meeting_id
    ):
        row.zoom_cancel_pending = False
        logger.info(
            "zoom_registrant_cancel_nothing_to_send", registrant_id=str(row.id),
        )
        return

    cap = settings.zoom_registrant_cancel_max_retries
    try:
        await update_registrant_status(
            zoom_meeting_id=zoom_meeting.zoom_meeting_id,
            zoom_registrant_id=row.zoom_registrant_id,
            email=row.registration_email,
            action="cancel",
        )
        row.zoom_cancel_pending = False
        logger.info("zoom_registrant_cancel_sent", registrant_id=str(row.id))
        return
    except ZoomAPIError as exc:
        if exc.status_code == 404:
            row.zoom_cancel_pending = False
            logger.info(
                "zoom_registrant_cancel_gone_on_zoom", registrant_id=str(row.id),
            )
            return
        if exc.status_code == 429:
            row.last_sync_error = (
                f"cancel rate-limited (429): {exc.body} -- not counted "
                f"against the cancel cap, retried next cycle"
            )
            logger.warning(
                "zoom_registrant_cancel_rate_limited", registrant_id=str(row.id),
            )
            return
        error = f"status={exc.status_code} body={exc.body}"
    except Exception as exc:
        error = f"unexpected (non-Zoom-API) error: {exc!r}"

    row.zoom_cancel_attempts += 1
    at_cap = row.zoom_cancel_attempts >= cap
    suffix = " (cancel cap reached, no further attempts)" if at_cap else ""
    row.last_sync_error = (
        f"cancel attempt #{row.zoom_cancel_attempts} failed: {error}{suffix}"
    )
    logger.warning(
        "zoom_registrant_cancel_failed",
        registrant_id=str(row.id),
        attempt=row.zoom_cancel_attempts,
        at_cap=at_cap,
    )
