# =============================================================================
# VELO Backend -- Zoom Meeting + Registrant Lifecycle (E21 steps D + E)
# =============================================================================
#
# Best-effort glue between the practice/booking lifecycle
# (practices/service.py, practices/cancel_service.py, bookings/service.py)
# and the Zoom API (zoom_client.py). Every function here NEVER RAISES -- a
# Zoom failure is caught, logged, and recorded on the relevant row so it
# stays visible and retryable (create failures) or is simply logged
# (reschedule/delete/cancel failures, which don't block anything downstream
# in this step). This is the whole point: publish/reschedule/cancel/book
# must never be blocked by a third party (E21 plan sec 2/3, confirmed as
# the intended reading in PROMPT №519, restated explicitly for booking in
# PROMPT №520: "do not soften it into 'usually'").
#
# HOST EXCLUSION (step E): ensure_host_registrant registers the practice's
# master through the SAME Zoom flow as a student, role='host', no
# booking_id. This is the ENTIRE mechanism -- Zoom exposes no host flag on
# any surface (E21 research, round 2), so ours is the only fact that
# exists. Called after every successful meeting creation, idempotent (a
# no-op if a host row already exists), so it fires exactly once per meeting
# regardless of whether that meeting was created on the first attempt or a
# later retry.
#
# NO EMAIL ON VELO USERS (real gap, not hidden): User has no dedicated
# email column -- E11 added an OPTIONAL email in the credentials JSONB via
# a profile-edit form, so most users likely have none. Zoom's registrant
# API requires email. _registration_email_for falls back to a
# structurally-valid, deliberately-unusable placeholder
# (RFC 2606 .invalid TLD) when the user has no real one. KNOWN CONSEQUENCE:
# the future matching ladder's email-fallback step will not work for any
# VELO user who joins Zoom without going through our personal link (i.e.
# by authenticating with their own real Zoom account under their real
# email) -- that email will never match our placeholder. This narrows the
# ladder's real fallback value toward registrant_id only, which the owner
# should know before sizing the unmatched bucket, not discover after.
#
# SESSION RULES: no session.commit() here (P-01, same convention as every
# other service module) -- callers manage the transaction. Every function
# below add/mutates ORM objects on the session passed in; the caller's
# existing commit picks them up.
# =============================================================================

import base64
import binascii
import enum
import secrets
from dataclasses import dataclass
from datetime import UTC
from uuid import UUID

import structlog
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.redis import get_redis
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.users.models import User
from app.modules.zoom.models import (
    ZoomAttendanceSegment,
    ZoomMeeting,
    ZoomMeetingStatus,
    ZoomRegistrant,
    ZoomRegistrantRole,
    ZoomRegistrantStatus,
)
from app.modules.zoom.zoom_client import (
    ZoomAPIError,
    create_meeting,
    create_registrant,
    delete_meeting,
    get_meeting,
    get_meeting_recordings,
    list_registrants,
    patch_meeting,
    update_registrant_status,
)

logger = structlog.get_logger()


def _registration_email_for(user: User) -> str:
    """The exact email we will send Zoom for this user -- see module
    docstring for why a placeholder is sometimes unavoidable. Frozen into
    ZoomRegistrant.registration_email at the call site, not re-derived
    later."""
    real_email = (user.credentials or {}).get("email")
    if real_email:
        return real_email
    return f"user-{user.id}@users.velo.invalid"


async def create_meeting_for_practice(
    practice: Practice,
    session: AsyncSession,
) -> ZoomMeeting:
    """Create the Zoom meeting for a practice being published.

    Always returns a ZoomMeeting row (added to `session`, not committed) --
    status=active on success, status=create_failed + last_sync_error on any
    failure. Never raises: the caller (update_practice's publish branch)
    must succeed regardless of Zoom's outcome.

    PROMPT №530: row creation happens UNCONDITIONALLY, stub mode included --
    do not gate this on settings.is_zoom_stub. Stub mode's entire purpose
    (zoom_client.py module docstring) is to exercise this exact control flow
    (meeting/registrant creation, reschedule, retry, report ingestion) with
    deterministic fake data instead of a real Zoom sandbox; skipping row
    creation here would silently strip that coverage from the whole E21 test
    suite. The actual regression this prompt fixes -- a stub "meeting" being
    treated as trackable for the ATTENDANCE-DECISION deferral, which no
    stub report can ever resolve -- is fixed at that decision, in
    _finalize_practice_core (bookings/service.py), not here.
    """
    row = ZoomMeeting(practice_id=practice.id)
    session.add(row)

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
        logger.info(
            "zoom_meeting_created",
            practice_id=str(practice.id),
            zoom_meeting_id=row.zoom_meeting_id,
        )
        await ensure_host_registrant(row, practice, session)
        # T24-38 (PROMPT №642): best-effort, same call-site shape as the host
        # registrant above -- see ensure_shared_registrant's own docstring.
        await ensure_shared_registrant(row, session)
    except ZoomAPIError as exc:
        row.status = ZoomMeetingStatus.CREATE_FAILED.value
        row.last_sync_error = (
            f"create_meeting failed: status={exc.status_code} body={exc.body}"
        )
        logger.warning(
            "zoom_meeting_create_failed",
            practice_id=str(practice.id),
            status_code=exc.status_code,
        )
    except Exception:
        # PROMPT №525: ensure_host_registrant is now self-contained (its own
        # savepoint absorbs a database-level conflict, see that function),
        # but the module docstring's "NEVER RAISES" is a blanket contract --
        # anything else unforeseen here must not escape either, or publish
        # (or series generation, which calls this per child) can still be
        # aborted by our own code the same way the incident showed it could.
        row.status = ZoomMeetingStatus.CREATE_FAILED.value
        row.last_sync_error = "create_meeting_for_practice: unexpected error"
        logger.exception(
            "zoom_meeting_create_unexpected_error",
            practice_id=str(practice.id),
        )

    return row


async def ensure_host_registrant(
    zoom_meeting: ZoomMeeting,
    practice: Practice,
    session: AsyncSession,
) -> None:
    """Create the practice's master as a role='host' registrant, exactly
    once per meeting.

    Idempotent by design (checks for an existing, non-cancelled host row
    first) so it is safe to call from BOTH the initial successful creation
    (create_meeting_for_practice above) AND a later successful retry
    (retry_poller._attempt_create) without ever double-registering the
    master. See module docstring -- this is the entire host-exclusion
    mechanism.

    PROMPT №525: the existence check above is TOCTOU-safe only up to the
    point of the actual insert -- a concurrent caller (or, as the incident
    that prompted this, a caller that seeded a conflicting row directly)
    can still lose a genuine race to
    uq_zoom_registrant_meeting_user_active. The insert itself runs inside
    session.begin_nested() (a SAVEPOINT) specifically so that a
    unique-violation there can be rolled back to the savepoint and
    swallowed, instead of leaving the CALLER's own transaction unusable
    (PendingRollbackError) -- a plain try/except around the flush is not
    enough by itself: catching the Python exception does not undo the
    database-level abort without something to roll back TO. Best-effort:
    never raises, for exactly this reason ("Zoom never blocks" has to hold
    for our own database, not only Zoom's API).
    """
    existing = (
        await session.execute(
            select(ZoomRegistrant.id).where(
                ZoomRegistrant.zoom_meeting_id == zoom_meeting.id,
                ZoomRegistrant.role == ZoomRegistrantRole.HOST.value,
                ZoomRegistrant.status != ZoomRegistrantStatus.CANCELLED.value,
            ).limit(1)
        )
    ).first()
    if existing is not None:
        return

    master_user = await session.get(User, practice.master_id)
    if master_user is None:
        logger.warning(
            "zoom_host_registrant_skipped_no_master",
            practice_id=str(practice.id),
        )
        return

    email = _registration_email_for(master_user)

    try:
        async with session.begin_nested():
            row = ZoomRegistrant(
                zoom_meeting_id=zoom_meeting.id,
                user_id=master_user.id,
                booking_id=None,
                role=ZoomRegistrantRole.HOST.value,
                registration_email=email,
                status=ZoomRegistrantStatus.PENDING.value,
            )
            session.add(row)
            await session.flush()
    except IntegrityError:
        # Lost the race for this (meeting, user) slot -- someone else (a
        # concurrent call, or a pre-existing non-host row for the same
        # user) already holds it. Nothing left for THIS call to do; the
        # savepoint rollback is what keeps the caller's own transaction
        # alive past this point.
        logger.info(
            "zoom_host_registrant_race_lost", practice_id=str(practice.id),
        )
        return

    try:
        response = await create_registrant(
            zoom_meeting_id=zoom_meeting.zoom_meeting_id,
            email=email,
            first_name=master_user.first_name or "VELO",
            last_name=master_user.last_name or "Master",
        )
        row.zoom_registrant_id = response.get("registrant_id") or response.get("id")
        row.join_url = response.get("join_url")
        row.status = ZoomRegistrantStatus.REGISTERED.value
        logger.info(
            "zoom_host_registrant_created",
            practice_id=str(practice.id),
            zoom_registrant_id=row.zoom_registrant_id,
        )
    except ZoomAPIError as exc:
        row.status = ZoomRegistrantStatus.CREATE_FAILED.value
        row.last_sync_error = (
            f"host registrant create failed: "
            f"status={exc.status_code} body={exc.body}"
        )
        logger.warning(
            "zoom_host_registrant_create_failed",
            practice_id=str(practice.id),
            status_code=exc.status_code,
        )
    except Exception:
        row.status = ZoomRegistrantStatus.CREATE_FAILED.value
        row.last_sync_error = "host registrant create failed: unexpected error"
        logger.exception(
            "zoom_host_registrant_unexpected_error",
            practice_id=str(practice.id),
        )


def _shared_registration_email_for(zoom_meeting: ZoomMeeting) -> str:
    """The exact email sent to Zoom for the shared (no-human) registrant --
    deterministic per meeting, same shape as _registration_email_for's own
    .invalid placeholder but a DIFFERENT subdomain (@meetings., not
    @users.), on purpose: this address must never accidentally satisfy
    attendance_service.PLACEHOLDER_EMAIL_SUFFIX or any other check written
    against a per-USER placeholder, because this one represents no user at
    all. Deterministic (keyed on zoom_meeting.id, not a random token) so a
    retried mint sends Zoom the SAME email every time -- required for the
    idempotency this function leans on (see its own docstring)."""
    return f"shared-{zoom_meeting.id}@meetings.velo.invalid"


async def ensure_shared_registrant(
    zoom_meeting: ZoomMeeting,
    session: AsyncSession,
) -> None:
    """T24-38 (PROMPT №642): mint the ONE shared, registration-free
    registrant for this meeting, idempotently.

    Writes directly onto ZoomMeeting.shared_registrant_id / shared_join_url
    -- deliberately NOT a ZoomRegistrant row (see those two columns'
    docstring in models.py for the correctness reason: it keeps a guest
    joining through this link structurally unmatchable by the attendance
    ladder, which never queries ZoomMeeting for a "registrant").

    Idempotent by a plain column check (BOTH shared_registrant_id AND
    shared_join_url already set -> no-op) rather than the savepoint/
    IntegrityError dance ensure_host_registrant needs -- there is no unique
    index to race here (this is an UPDATE of one already-identified row,
    not an INSERT contending for a slot).

    PROMPT №645 (audit-found CRITICAL, fixed): the guard checks BOTH
    fields, not just shared_registrant_id, because Zoom's create-registrant
    response can carry a registrant_id with NO join_url --
    ZoomRegistrant.join_url's own docstring (models.py) already documents
    this as REAL, not hypothetical, for the twin per-user registrant path.
    A guard keyed on shared_registrant_id alone would set that field, see
    it truthy on every future call, and permanently skip ever filling in
    the still-missing join_url -- exactly the bug this replaced. A re-call
    that reaches this function again is safe to retry unconditionally: the
    email this function sends Zoom is DETERMINISTIC per meeting
    (_shared_registration_email_for), so even two concurrent callers, or a
    genuine retry after a partial success, land on the SAME Zoom registrant
    (recon, PROMPT №641: Zoom is idempotent on a duplicate registrant email
    -- same email returns the same registrant_id/join_url, no error, no
    duplicate) -- harmless by construction on BOTH sides, ours and Zoom's,
    not merely unlikely.

    Best-effort, same posture as ensure_host_registrant: never raises. No
    retry-poller coverage exists for a failure here (that poller only
    claims ZoomRegistrant rows, which this deliberately is not) -- see the
    PROMPT №642 DONE report for the known, accepted gap this leaves. NOTE
    left for a future reader, not new scope for this prompt: under today's
    call graph (create_meeting_for_practice + attempt_zoom_meeting_create,
    both fire at most once per ZoomMeeting -- neither is reachable once
    status is ACTIVE) this guard fix does not by itself add a NEW recovery
    trigger; it fixes the guard's own logic so that IF this function is
    ever called again for the same meeting (a future manual re-mint action,
    say), it behaves correctly instead of silently locking in a partial
    failure.
    """
    if zoom_meeting.shared_registrant_id and zoom_meeting.shared_join_url:
        return

    email = _shared_registration_email_for(zoom_meeting)

    try:
        response = await create_registrant(
            zoom_meeting_id=zoom_meeting.zoom_meeting_id,
            email=email,
            first_name="VELO",
            last_name="Guest Link",
        )
        zoom_meeting.shared_registrant_id = (
            response.get("registrant_id") or response.get("id")
        )
        zoom_meeting.shared_join_url = response.get("join_url")
        logger.info(
            "zoom_shared_registrant_created",
            zoom_meeting_id=str(zoom_meeting.id),
            shared_registrant_id=zoom_meeting.shared_registrant_id,
        )
    except ZoomAPIError as exc:
        logger.warning(
            "zoom_shared_registrant_create_failed",
            zoom_meeting_id=str(zoom_meeting.id),
            status_code=exc.status_code,
        )
    except Exception:
        logger.exception(
            "zoom_shared_registrant_unexpected_error",
            zoom_meeting_id=str(zoom_meeting.id),
        )


async def create_registrant_for_booking(
    booking: Booking,
    user: User,
    session: AsyncSession,
) -> ZoomRegistrant | None:
    """Create the Zoom registrant for a student's booking.

    Idempotent by (zoom_meeting_id, user_id) -- looks up an existing,
    non-cancelled registrant for this pair FIRST and reuses it instead of
    inserting a second row (PROMPT №525: this check was missing entirely
    before, the same non-idempotent shape that broke ensure_host_registrant,
    just never triggered here yet -- the bookings table's own
    uq_booking_practice_user_active makes two ACTIVE bookings for the same
    (practice, user) impossible today, so the realistic trigger is a
    retried call for the SAME booking, not a second booking). Insert only
    when none exists (added to `session`, not committed) -- status=registered
    on success, status=pending if the meeting isn't ACTIVE yet (queued for
    the retry poller's registrant phase), status=create_failed if Zoom's
    call itself failed (also retried by the poller). Returns None when
    there is no ZoomMeeting row at all for this practice (pre-E21 data, or
    a series-child edge case), or when the insert lost a race for the slot.

    NEVER RAISES and never blocks booking creation, regardless of Zoom's
    or the meeting's state (PROMPT №519 amendment 2 / PROMPT №520: not
    softened into "usually"). The insert itself runs inside
    session.begin_nested() (a SAVEPOINT) for the same reason as
    ensure_host_registrant: catching the exception alone would not be
    enough to keep the CALLER's transaction (the booking that already
    succeeded) alive past a unique-violation here.
    """
    zoom_meeting = (
        await session.execute(
            select(ZoomMeeting).where(ZoomMeeting.practice_id == booking.practice_id)
        )
    ).scalar_one_or_none()
    if zoom_meeting is None:
        logger.info(
            "zoom_registrant_skipped_no_meeting", booking_id=str(booking.id),
        )
        return None

    existing = (
        await session.execute(
            select(ZoomRegistrant).where(
                ZoomRegistrant.zoom_meeting_id == zoom_meeting.id,
                ZoomRegistrant.user_id == user.id,
                ZoomRegistrant.status != ZoomRegistrantStatus.CANCELLED.value,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        logger.info(
            "zoom_registrant_reused_existing", booking_id=str(booking.id),
        )
        return existing

    email = _registration_email_for(user)

    try:
        async with session.begin_nested():
            row = ZoomRegistrant(
                zoom_meeting_id=zoom_meeting.id,
                user_id=user.id,
                booking_id=booking.id,
                role=ZoomRegistrantRole.STUDENT.value,
                registration_email=email,
                status=ZoomRegistrantStatus.PENDING.value,
            )
            session.add(row)
            await session.flush()
    except IntegrityError:
        logger.info("zoom_registrant_race_lost", booking_id=str(booking.id))
        return None

    if zoom_meeting.status != ZoomMeetingStatus.ACTIVE.value:
        # Meeting not ready yet -- leave queued (status stays PENDING) for
        # the retry poller. Booking already succeeded; this is a queue
        # entry, not a failure.
        logger.info(
            "zoom_registrant_queued_meeting_not_active",
            booking_id=str(booking.id),
        )
        return row

    try:
        response = await create_registrant(
            zoom_meeting_id=zoom_meeting.zoom_meeting_id,
            email=email,
            first_name=user.first_name or "VELO",
            last_name=user.last_name or "User",
        )
        row.zoom_registrant_id = response.get("registrant_id") or response.get("id")
        row.join_url = response.get("join_url")
        row.status = ZoomRegistrantStatus.REGISTERED.value
        logger.info(
            "zoom_registrant_created",
            booking_id=str(booking.id),
            zoom_registrant_id=row.zoom_registrant_id,
        )
    except ZoomAPIError as exc:
        row.status = ZoomRegistrantStatus.CREATE_FAILED.value
        row.last_sync_error = (
            f"create_registrant failed: status={exc.status_code} body={exc.body}"
        )
        logger.warning(
            "zoom_registrant_create_failed",
            booking_id=str(booking.id),
            status_code=exc.status_code,
        )
    except Exception:
        row.status = ZoomRegistrantStatus.CREATE_FAILED.value
        row.last_sync_error = "create_registrant failed: unexpected error"
        logger.exception(
            "zoom_registrant_unexpected_error", booking_id=str(booking.id),
        )

    return row


async def cancel_registrant_for_booking(
    booking: Booking,
    session: AsyncSession,
) -> None:
    """Best-effort Zoom-side registrant cancel; mark our own row cancelled
    REGARDLESS of whether the Zoom call succeeds.

    Our row's status is the sole authority downstream (E21 research: it was
    never confirmed whether Zoom actually invalidates a cancelled
    registrant's join link -- nothing here may depend on Zoom cooperating).
    No-op if there's no registrant row for this booking. Never raises --
    booking cancellation must proceed regardless.
    """
    row = (
        await session.execute(
            select(ZoomRegistrant).where(ZoomRegistrant.booking_id == booking.id)
        )
    ).scalar_one_or_none()
    if row is None:
        return

    if row.zoom_registrant_id:
        zoom_meeting = await session.get(ZoomMeeting, row.zoom_meeting_id)
        if zoom_meeting is not None and zoom_meeting.zoom_meeting_id:
            try:
                await update_registrant_status(
                    zoom_meeting_id=zoom_meeting.zoom_meeting_id,
                    zoom_registrant_id=row.zoom_registrant_id,
                    email=row.registration_email,
                    action="cancel",
                )
            except ZoomAPIError as exc:
                logger.warning(
                    "zoom_registrant_cancel_call_failed",
                    booking_id=str(booking.id),
                    status_code=exc.status_code,
                    error=str(exc),
                )

    row.status = ZoomRegistrantStatus.CANCELLED.value
    logger.info("zoom_registrant_cancelled", booking_id=str(booking.id))


async def sync_meeting_reschedule(
    practice: Practice,
    session: AsyncSession,
) -> None:
    """PATCH the Zoom meeting's start time, then re-fetch registrants and
    overwrite our stored join_url with whatever Zoom currently returns.

    This is the self-healing answer to the unresolved question of whether
    registrant links survive a reschedule (E21 research could not confirm
    either way): if links survived, re-fetching is a no-op; if they didn't,
    we pick up the fresh ones without needing to have known which world we
    were in. No-op (logged, not raised) if there's no active ZoomMeeting for
    this practice yet, or if either Zoom call fails.

    PROMPT №645: the shared registrant (ZoomMeeting.shared_registrant_id/
    shared_join_url, T24-38) rides the SAME `list_registrants` call below --
    Zoom returns it in that list like any other registrant on the meeting,
    we simply never stored it as a ZoomRegistrant row (see that pair of
    columns' own docstring for why). Only REFRESHES an already-minted
    shared registrant's join_url; it does not attempt a fresh mint if one
    never succeeded -- that is the separate, already-accepted no-retry-
    coverage gap (PROMPT №642 item A), not this function's job.
    """
    zoom_meeting = (
        await session.execute(
            select(ZoomMeeting).where(ZoomMeeting.practice_id == practice.id)
        )
    ).scalar_one_or_none()

    if zoom_meeting is None or zoom_meeting.status != ZoomMeetingStatus.ACTIVE.value:
        # No active meeting to reschedule -- either creation never
        # succeeded (retry poller owns that) or this practice predates E21.
        return

    try:
        await patch_meeting(
            zoom_meeting_id=zoom_meeting.zoom_meeting_id,
            start_time_iso=practice.scheduled_at.astimezone(UTC).isoformat(),
        )
    except ZoomAPIError as exc:
        zoom_meeting.last_sync_error = (
            f"patch_meeting (reschedule) failed: "
            f"status={exc.status_code} body={exc.body}"
        )
        logger.warning(
            "zoom_meeting_reschedule_failed",
            practice_id=str(practice.id),
            status_code=exc.status_code,
        )
        return

    try:
        registrants = await list_registrants(zoom_meeting_id=zoom_meeting.zoom_meeting_id)
    except ZoomAPIError as exc:
        logger.warning(
            "zoom_registrant_refetch_failed",
            practice_id=str(practice.id),
            status_code=exc.status_code,
            error=str(exc),
        )
        return

    if not registrants:
        return

    stored = (
        await session.execute(
            select(ZoomRegistrant).where(
                ZoomRegistrant.zoom_meeting_id == zoom_meeting.id,
            )
        )
    ).scalars().all()
    by_zoom_id = {r.zoom_registrant_id: r for r in stored if r.zoom_registrant_id}

    for remote in registrants:
        remote_id = remote.get("registrant_id") or remote.get("id")
        fresh_join_url = remote.get("join_url")
        local = by_zoom_id.get(remote_id)
        if local is not None:
            if fresh_join_url and fresh_join_url != local.join_url:
                local.join_url = fresh_join_url
            continue
        # PROMPT №645: same refresh, for the shared registrant living on
        # ZoomMeeting instead of a ZoomRegistrant row (see docstring above).
        if (
            remote_id
            and remote_id == zoom_meeting.shared_registrant_id
            and fresh_join_url
            and fresh_join_url != zoom_meeting.shared_join_url
        ):
            zoom_meeting.shared_join_url = fresh_join_url

    logger.info(
        "zoom_registrants_refetched",
        practice_id=str(practice.id),
        remote_count=len(registrants),
    )


async def delete_meeting_for_practice(
    practice: Practice,
    session: AsyncSession,
) -> None:
    """Best-effort deletion of a practice's Zoom meeting on cancel.

    Skips meetings that already have attendance segments (nothing left to
    protect a cancelled-after-the-fact meeting from -- the report already
    happened). No-op if there's no active meeting, or if the Zoom call
    fails (logged, never raised -- refunds/cancellation must proceed
    regardless, E21 plan sec 2).
    """
    zoom_meeting = (
        await session.execute(
            select(ZoomMeeting).where(ZoomMeeting.practice_id == practice.id)
        )
    ).scalar_one_or_none()

    if zoom_meeting is None or zoom_meeting.status != ZoomMeetingStatus.ACTIVE.value:
        return

    has_segments = (
        await session.execute(
            select(ZoomAttendanceSegment.id)
            .where(ZoomAttendanceSegment.zoom_meeting_id == zoom_meeting.id)
            .limit(1)
        )
    ).first() is not None
    if has_segments:
        logger.info(
            "zoom_meeting_delete_skipped_has_segments",
            practice_id=str(practice.id),
        )
        return

    try:
        await delete_meeting(zoom_meeting_id=zoom_meeting.zoom_meeting_id)
        zoom_meeting.status = ZoomMeetingStatus.DELETED.value
        logger.info("zoom_meeting_deleted", practice_id=str(practice.id))
    except ZoomAPIError as exc:
        zoom_meeting.last_sync_error = (
            f"delete_meeting failed: status={exc.status_code} body={exc.body}"
        )
        logger.warning(
            "zoom_meeting_delete_failed",
            practice_id=str(practice.id),
            status_code=exc.status_code,
        )


# ---------------------------------------------------------------------------
# T21-1: read-only host-link lookups for owner-facing PracticeResponse.zoom_
# host_join_url. Never used for a student's own link (that's the booking's
# own registrant, looked up by booking_id in bookings/service.py) -- these
# two only ever resolve the role='host' row, the master's own personal link.
# ---------------------------------------------------------------------------


async def get_host_join_url(
    practice_id: UUID,
    session: AsyncSession,
) -> str | None:
    """This practice's host registrant join_url, or None if there is no
    USABLE one -- meeting not created yet, Zoom hasn't returned a link yet
    (see ZoomRegistrant.join_url docstring), or the meeting was since
    deleted (ZoomMeetingStatus.DELETED -- the registrant row itself is not
    touched on delete, only the meeting, so status must be checked here
    rather than trusting the registrant row alone)."""
    zoom_meeting_id = (
        await session.execute(
            select(ZoomMeeting.id).where(
                ZoomMeeting.practice_id == practice_id,
                ZoomMeeting.status == ZoomMeetingStatus.ACTIVE.value,
            )
        )
    ).scalar_one_or_none()
    if zoom_meeting_id is None:
        return None
    return (
        await session.execute(
            select(ZoomRegistrant.join_url).where(
                ZoomRegistrant.zoom_meeting_id == zoom_meeting_id,
                ZoomRegistrant.role == ZoomRegistrantRole.HOST.value,
                ZoomRegistrant.status != ZoomRegistrantStatus.CANCELLED.value,
            )
        )
    ).scalar_one_or_none()


async def get_host_join_urls(
    practice_ids: list[UUID],
    session: AsyncSession,
) -> dict[UUID, str]:
    """Batched form of get_host_join_url for a list endpoint (master's own
    practice list) -- one query, no N+1, same pattern as
    bookings/service.py's feedback/checkin set-membership lookups."""
    if not practice_ids:
        return {}
    rows = (
        await session.execute(
            select(ZoomMeeting.practice_id, ZoomRegistrant.join_url)
            .join(
                ZoomRegistrant,
                ZoomRegistrant.zoom_meeting_id == ZoomMeeting.id,
            )
            .where(
                ZoomMeeting.practice_id.in_(practice_ids),
                ZoomMeeting.status == ZoomMeetingStatus.ACTIVE.value,
                ZoomRegistrant.role == ZoomRegistrantRole.HOST.value,
                ZoomRegistrant.status != ZoomRegistrantStatus.CANCELLED.value,
                ZoomRegistrant.join_url.is_not(None),
            )
        )
    ).all()
    return {row[0]: row[1] for row in rows}


# ---------------------------------------------------------------------------
# A4 V2 (PROMPT №572): read-only ZoomMeetingStatus lookups for
# PracticeResponse.zoom_meeting_status / PracticeSummary.zoom_meeting_status.
# Unlike get_host_join_url[s] above, this is NOT owner-gated -- the status
# value itself carries no secret material (same zero-masking posture as the
# admin zoom-attendance endpoint's own zoom_meeting_status field,
# admin/practices/schemas.py), and BOTH the master and a booked participant
# need it to tell "still preparing" (pending_creation) apart from
# "permanently failed" (create_failed) -- utils/zoomLink.ts previously had no
# way to distinguish the two, so both rendered the identical "готовится"
# spinner forever on a permanently-failed meeting.
# ---------------------------------------------------------------------------


async def get_zoom_meeting_status(
    practice_id: UUID,
    session: AsyncSession,
) -> str | None:
    """This practice's ZoomMeeting.status, or None if no ZoomMeeting row was
    ever created (creation never attempted -- pre-E21 data, or a draft never
    published)."""
    return (
        await session.execute(
            select(ZoomMeeting.status).where(ZoomMeeting.practice_id == practice_id)
        )
    ).scalar_one_or_none()


async def get_zoom_meeting_statuses(
    practice_ids: list[UUID],
    session: AsyncSession,
) -> dict[UUID, str]:
    """Batched form of get_zoom_meeting_status for a list endpoint -- one
    query, no N+1, same pattern as get_host_join_urls above."""
    if not practice_ids:
        return {}
    rows = (
        await session.execute(
            select(ZoomMeeting.practice_id, ZoomMeeting.status).where(
                ZoomMeeting.practice_id.in_(practice_ids),
            )
        )
    ).all()
    return {row[0]: row[1] for row in rows}


# ---------------------------------------------------------------------------
# PROMPT №556 (OWNER-1, option В): "Начать" -- the master starts their own
# meeting as host. start_url is a bearer credential (its holder needs no
# further Zoom-side identity check to become host) that also expires, so the
# owner decided against ever storing or returning it: it is fetched fresh
# from Zoom at the moment the master clicks, and handed to the browser only
# via an HTTP redirect (a Location header), never through a JSON body a
# frontend variable could hold onto.
#
# A plain browser navigation (window.location / Telegram WebApp.openLink)
# never carries our Authorization header -- there is no cookie session
# either (client.ts is bearer-only) -- so the redirect endpoint cannot reuse
# get_current_master. The ticket below stands in for that header for exactly
# one redirect: minted only after the ownership check already ran
# (practices/router.py, same P-08 pattern as update/delete/cancel_practice),
# single-use (deleted the instant it's read), and short-lived enough that a
# leaked ticket (server access logs, browser history) is worthless within
# seconds -- a much smaller exposure than the general session token would be
# if that were reused here instead.
# ---------------------------------------------------------------------------

_START_TICKET_PREFIX = "zoom_start_ticket:"
_START_TICKET_TTL_SECONDS = 30


async def get_active_meeting_for_practice(
    practice_id: UUID,
    session: AsyncSession,
) -> ZoomMeeting | None:
    """This practice's ZoomMeeting row if one exists and is currently
    active, else None. Used to give an honest "no meeting" refusal before
    ever minting a start ticket for a practice that has nothing to start."""
    return (
        await session.execute(
            select(ZoomMeeting).where(
                ZoomMeeting.practice_id == practice_id,
                ZoomMeeting.status == ZoomMeetingStatus.ACTIVE.value,
            )
        )
    ).scalar_one_or_none()


async def create_start_ticket(zoom_meeting_id: UUID) -> str:
    """Mint a single-use, short-lived ticket authorizing ONE start_url fetch
    for this meeting. Caller must already have verified the requester owns
    the practice this meeting belongs to -- this function trusts its input."""
    ticket = secrets.token_urlsafe(32)
    redis = get_redis()
    await redis.set(
        f"{_START_TICKET_PREFIX}{ticket}",
        str(zoom_meeting_id),
        ex=_START_TICKET_TTL_SECONDS,
    )
    return ticket


async def redeem_start_ticket(ticket: str) -> UUID | None:
    """Atomically read-and-delete a start ticket. Returns the ZoomMeeting id
    it authorized, or None if the ticket is missing, expired, or already
    used (GETDEL is one round trip -- no separate GET+DEL race window)."""
    redis = get_redis()
    value = await redis.getdel(f"{_START_TICKET_PREFIX}{ticket}")
    if value is None:
        return None
    return UUID(value)


async def get_meeting_start_url(zoom_meeting_id: str) -> str | None:
    """Fetch the meeting's CURRENT start_url from Zoom, at request time --
    never read from a stored column (none exists; see create_meeting's
    docstring for why one was never added). Returns None if Zoom's response
    has no usable start_url; raises ZoomAPIError on any Zoom-side failure
    (network, non-2xx) for the caller to translate into an honest message.

    Does not log `response` or any field of it -- do not add a logging call
    here that would put start_url in a log line."""
    response = await get_meeting(zoom_meeting_id=zoom_meeting_id)
    start_url = response.get("start_url")
    if not isinstance(start_url, str) or not start_url.startswith("https://"):
        return None
    return start_url


# ---------------------------------------------------------------------------
# REC-1 (PROMPT №618): watch-recording link for a past practice. Owner
# decisions this reflects: sharing is on and "must authenticate" is off (so
# a VELO user with no Zoom account can open the link), passcode is required
# and NOT embedded by Zoom (that account setting stays off), so WE embed it
# -- the user never sees a raw URL or a passcode, only one ready link.
# Retention is Zoom's own 7-day auto-delete; our side never expires
# anything, it only reacts to the file being gone (a 404 from Zoom).
# ---------------------------------------------------------------------------


async def get_meeting_recording_link(zoom_meeting_id: str) -> str | None:
    """This meeting's current recording link, passcode embedded, fetched
    fresh from Zoom every call -- never stored, same "ask Zoom at request
    time" posture as get_meeting_start_url above, and for the same reason:
    a stored link would go stale the moment Zoom's own 7-day retention
    deletes the file, and re-deriving staleness ourselves would duplicate a
    job Zoom already does.

    Returns None when Zoom has no recording for this meeting right now
    (404 -- never created, still processing, or already deleted). Raises
    ZoomAPIError for any other failure (network/auth/5xx) so the caller can
    tell "confirmed absent" apart from "couldn't check" -- do not catch
    that here and collapse the two.

    Does not log `response` or the constructed link -- the link carries the
    passcode inline once built, same "never log the credential" rule
    get_meeting_start_url's docstring states for start_url above.
    """
    try:
        response = await get_meeting_recordings(zoom_meeting_id=zoom_meeting_id)
    except ZoomAPIError as exc:
        if exc.status_code == 404:
            return None
        raise

    share_url = response.get("share_url")
    if not isinstance(share_url, str) or not share_url.startswith("https://"):
        return None

    passcode = response.get("recording_play_passcode") or response.get("password")
    if not passcode:
        # Share URL exists but Zoom didn't return a passcode -- still
        # usable (Zoom will prompt), better than showing nothing. Logged
        # without the URL itself, which carries no secret in this branch.
        logger.warning(
            "zoom_recording_no_passcode", zoom_meeting_id=zoom_meeting_id,
        )
        return share_url

    return f"{share_url}?pwd={passcode}"


# ---------------------------------------------------------------------------
# T-35: the public link wrapper.
#
# WHY THIS EXISTS. Until now three different Zoom URLs left this system: the
# personal registrant link (the only one attendance can be written from), the
# shared guest link on ZoomMeeting, and a hand-typed Practice.zoom_link (now
# gone). A master pasted the SHARED one into a Telegram channel -- where his
# own booked students also sit. Their personal link is two screens away inside
# the app, the shared one is right there in the feed, so they clicked it,
# joined as an unmatchable guest, and the attendance matcher recorded
# NO_SHOW for a person who was demonstrably present.
#
# The wrapper kills that CONSTRUCTIVELY rather than by discipline: if no raw
# Zoom URL exists outside this backend, a student physically cannot enter past
# his own personal link -- the resolver hands him that one, because it knows
# who he is. Nothing here waits on a fix to the matcher (T24's territory).
#
# THE CODE IS NOT A SECRET. It is base64url(practice.id.bytes) -- reversible,
# deterministic, 22 characters, no padding. Any authenticated user already
# sees practice ids in the feed, so the wrapper adds exactly zero entropy and
# NOTHING in this feature may be built on the code being unguessable. The one
# security property is that the ANONYMOUS branch never returns a personal
# link, and it rests on the request being anonymous, not on the code.
#
# Practice.id, not ZoomMeeting.id, is what gets encoded: meetings are deleted
# and recreated (reschedule, cancel, retry), practices are stable. That is
# what lets a link posted two weeks ago resolve to the CURRENT meeting at
# click time instead of a stale one baked into the URL.
# ---------------------------------------------------------------------------

# base64url of 16 raw bytes is 24 chars with two "=" of padding; we strip it,
# so every code is exactly this long. The charset is also exactly what
# Telegram permits in a startapp parameter, which is why the same code works
# as the deep link "zoom__<22>" (28 chars against a limit of 64).
PUBLIC_CODE_LENGTH = 22

# base64url's alphabet, character for character what the client copy's
# /^[A-Za-z0-9_-]{22}$/ allows. Used by decode_practice_code to reject a
# wrong charset BEFORE decoding -- see the T-44 note in that function for
# why the decoder alone does not do it.
_PUBLIC_CODE_ALPHABET = (
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
)

# SECOND COPY WARNING: frontend/src/composables/useAuth.ts carries a decoder
# for this same code. Two copies exist because the deep-link route takes a
# UUID path parameter, so the client must decode BEFORE it can build the
# route -- the split is a language boundary, not forgetfulness. Routing the
# decode through yet another endpoint would not remove the copy, it would add
# a network round trip to a pure function. Both sides must agree on GARBAGE,
# not just on valid input: wrong length, wrong charset and empty all mean
# "not a route" on both sides.
#
# T-44: that agreement is no longer held by discipline alone. A shared vector
# -- the same JSON table of inputs and expected outcomes -- is duplicated
# VERBATIM in both test files:
#   backend/tests/test_zoom_public_link.py
#   frontend/src/composables/useAuth.test.ts
# Each side runs its own decoder against its own copy (catching "I changed
# the codec and not the table"), and `velo test` / `velo update` additionally
# diff the two copies against each other in a container that can see both
# trees (catching "I changed one side's codec AND its table, leaving the
# other side behind" -- which no single-sided test can see).
# CHANGE THIS DECODER ONLY IN PAIRS: this function, useAuth.ts's
# decodePracticeCode, and BOTH copies of the vector. T-44 was opened because
# this comment used to be the only thing holding them together, and the two
# had already drifted: Python accepted "+" and "/" where the client did not.


def encode_practice_code(practice_id: UUID) -> str:
    """practice.id -> the 22-character code used in /z/{code} and in the
    Telegram deep link. Deterministic: the same practice always yields the
    same code, so no table, no TTL and no collision handling exist (a short
    -link table was considered and rejected -- a migration plus collisions
    plus expiry to save 15 characters, and a dictionary code would be
    enumerable where a reversible one is exactly a UUIDv4)."""
    return base64.urlsafe_b64encode(practice_id.bytes).decode("ascii").rstrip("=")


def decode_practice_code(code: str) -> UUID | None:
    """The code back into a practice id, or None if this is not a code at
    all -- wrong length, wrong charset, empty. Returns None instead of
    raising because every caller's honest answer to garbage is the same
    "no such link" page, and because this must never reach the database on
    input that cannot possibly name a row.

    A code of the RIGHT shape naming a practice that does not exist is NOT
    detectable here and must not be: that is a database question, answered
    by the caller (404).

    KNOWN, HARMLESS: 22 base64url characters carry 132 bits while a UUID is
    128, so the final character has 4 bits nobody reads -- a handful of
    non-canonical codes decode to the same practice as the canonical one and
    resolve normally. Not worth rejecting: the code is not a secret and not a
    capability (see the section header), so "more than one spelling reaches
    the same public page" costs nothing, while a canonicality check would be
    one more rule for the client copy of this function to match exactly.
    """
    if len(code) != PUBLIC_CODE_LENGTH:
        return None
    # T-44: the charset gate this docstring has always promised ("wrong
    # charset" -> None) but did not have. It is NOT redundant with the
    # decoder below: urlsafe_b64decode translates - -> + and _ -> / and then
    # calls the STANDARD decoder, which happily accepts a literal "+" or "/"
    # that was already in the input. So "AAAAAAAAAAAAAAAAAAAA++" decoded to a
    # perfectly good UUID here while the client copy (useAuth.ts, which tests
    # the alphabet with a regex BEFORE atob) rejected it -- Python accepted a
    # strict superset of what the client accepted, which is exactly the
    # silent divergence T-44's shared vector exists to catch. Checked with
    # str.strip(), not a regex, to keep this cheap and dependency-free; the
    # alphabet is base64url's, character for character what the client's
    # /^[A-Za-z0-9_-]{22}$/ allows.
    if code.strip(_PUBLIC_CODE_ALPHABET) != "":
        return None
    try:
        raw = base64.urlsafe_b64decode(code + "==")
    except (binascii.Error, ValueError):
        # binascii.Error for bad padding/charset; ValueError on some inputs.
        # Deliberately NOT a bare `except Exception`: a future bug inside
        # this function, or a MemoryError, must surface rather than be
        # silently answered with "not a link".
        return None
    if len(raw) != 16:
        # UNREACHABLE for input that passed both gates above, and kept
        # deliberately: 22 characters of the alphabet plus "==" always
        # decode to exactly 16 bytes (verified over 200k random codes --
        # it is arithmetic, not luck). This survives as the guard that
        # would catch a future change to PUBLIC_CODE_LENGTH, which is why
        # the shared vector documents the axis instead of carrying a
        # fabricated example for it.
        return None
    return UUID(bytes=raw)


def build_public_practice_link(practice_id: UUID) -> str:
    """The full, shareable link for a practice. Assembled at the edge from
    settings.public_link_base (arch decision 13, late binding: the intent
    lives in the data, the domain in env, the URL is built at send time) --
    no domain is ever stored on a row."""
    base = settings.public_link_base.rstrip("/")
    return f"{base}/z/{encode_practice_code(practice_id)}"


class ZoomEntryKind(enum.StrEnum):
    """What the resolver decided about ONE person's entry into ONE practice.

    PERSONAL -- their own registrant link; the only outcome attendance can
                be written from, and the whole point of the feature.
    HOST     -- the practice's own master; url is None on purpose, the
                client uses the existing start-ticket flow instead.
    GUEST    -- nobody attendance will judge; the shared guest link. url is
                None when the shared registrant was never minted.
    PENDING  -- honest "being prepared".
    FAILED   -- meeting creation is permanently failed; waiting is pointless
                until someone acts.
    CANCELLED -- the practice itself is cancelled.
    """

    PERSONAL = "personal"
    HOST = "host"
    GUEST = "guest"
    PENDING = "pending"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class ZoomEntryResolution:
    """kind + the URL to send the browser to, if any.

    url is None for HOST (by construction -- the start-ticket flow owns
    that path) and for GUEST when ensure_shared_registrant never succeeded.
    Callers must branch on kind and handle a null url on BOTH, never
    collapse either into FAILED: FAILED means there is no meeting, while
    a guest with no link means the meeting exists and only the guest seat
    in it does not. Two different facts.
    """

    kind: ZoomEntryKind
    url: str | None


def is_publicly_resolvable(practice: Practice) -> bool:
    """Step 1 of the ladder below, factored out because BOTH entry points
    (the anonymous /z/{code} page and the authenticated resolve endpoint)
    must apply it and must apply the SAME one. A draft or soft-deleted
    practice is answered with 404 -- not a state, an absence: publishing
    the title of an unpublished practice to anyone holding a guessed URL
    would be a leak, and the authenticated side already answers 404 for
    exactly this case (P-08)."""
    return practice.status not in (
        PracticeStatus.DRAFT.value,
        PracticeStatus.DELETED.value,
    )


# Statuses that make a booking LIVE for the purposes of this resolver.
#
# Deliberately WIDER than ZOOM_VISIBLE_BOOKING_STATUSES (practices/service.py),
# and the difference is the whole correctness argument of step 5 below:
# "no booking" here means "no booking attendance will ever judge", NOT "no
# right to a personal link right now". A PENDING booking can become CONFIRMED
# before the practice starts; hand its owner a guest link now and the matcher
# will find zero seconds against his registrant later and write NO_SHOW --
# the exact defect this whole feature exists to kill, recreated by our own
# resolver.
_LIVE_BOOKING_STATUSES = (
    BookingStatus.PENDING.value,
    BookingStatus.CONFIRMED.value,
    BookingStatus.ATTENDED.value,
)


async def resolve_zoom_entry(
    practice: Practice,
    user: User | None,
    session: AsyncSession,
) -> ZoomEntryResolution:
    """Decide how THIS person enters THIS practice, right now.

    A LADDER, evaluated top to bottom, first match wins. The order is
    load-bearing -- each step exists because the one below it would
    otherwise mask a state and lie to somebody:

      1. draft/deleted -> not resolvable at all. Enforced by callers via
         is_publicly_resolvable above, before this function is reached.
      2. practice cancelled -> CANCELLED. Older than everything, INCLUDING
         the owner: a cancelled practice is not started.
      3. NO ACTIVE MEETING -- and note this is a branch on "not active",
         NOT a check for create_failed. THIS IS THE STEP A FUTURE
         REFACTOR WILL WANT TO "SIMPLIFY" BACK INTO ONE STATUS: don't.
         ZoomMeetingStatus has four values plus "no row at all", and three
         of those five would then fall through to HOST, whose button leads
         to create_zoom_start_ticket_endpoint, which answers 400
         zoom_meeting_not_active. pending_creation is not exotic either --
         series children are born in it (series_service.py).
           create_failed                      -> FAILED (the owner gets an
             action: the retry endpoint is owner-only, so he is the only
             person who CAN act; a student gets "waiting is pointless").
           pending_creation / deleted / none  -> PENDING (honest "being
             prepared" -- for pending_creation it is literally true, the
             retry poller claims those alongside create_failed).
      4. the owner -> HOST. Reached only with an ACTIVE meeting, so the
         "Начать" button cannot land on nothing BY CONSTRUCTION.
      5. a live booking -> PERSONAL when the registrant link exists,
         PENDING when it does not (Zoom does not always return a tokenized
         join_url on create -- see ZoomRegistrant.join_url; the retry
         poller fills it in later). PENDING bookings resolve to PENDING
         too, see _LIVE_BOOKING_STATUSES.
      6. no live booking -> GUEST.

    AUDIENCE IS DELIBERATELY NOT CHECKED HERE, and two code reviews have
    now raised it independently -- so it is written down rather than left
    to be "fixed" by the next reader.

    A practice with audience_kind students/groups is hidden from a
    non-member by get_practice_detail (404). This resolver does not apply
    that gate, so an authenticated non-member holding the practice id gets
    kind=GUEST and the shared link. That asymmetry is intentional and it
    costs nothing that is not already spent: the ANONYMOUS /z/{code} page
    hands the same guest link to anybody at all, by design -- the master
    publishes that link into a Telegram channel himself. Gating the
    authenticated half while the anonymous half stays open would protect
    nothing and would break the one thing this feature exists to do.

    An audience gate for Zoom entry is a separate, deliberate non-goal
    (owner ruling: practices are free today, the mechanism comes later and
    not from here). If it ever arrives, it belongs on BOTH halves at once,
    and the landing page's guest button has to go with it.

    ANONYMITY IS STRUCTURAL, NOT A RULE: user is None for the public page,
    and steps 4 and 5 cannot fire without a user. A link forwarded out of a
    channel therefore CANNOT produce somebody else's personal link, no
    matter what the caller does.
    """
    # -- 2. cancelled --
    if practice.status == PracticeStatus.CANCELLED.value:
        return ZoomEntryResolution(kind=ZoomEntryKind.CANCELLED, url=None)

    # -- 3. no active meeting --
    meeting = (
        await session.execute(
            select(ZoomMeeting).where(ZoomMeeting.practice_id == practice.id)
        )
    ).scalar_one_or_none()
    if meeting is None or meeting.status != ZoomMeetingStatus.ACTIVE.value:
        failed = (
            meeting is not None
            and meeting.status == ZoomMeetingStatus.CREATE_FAILED.value
        )
        if failed:
            return ZoomEntryResolution(kind=ZoomEntryKind.FAILED, url=None)
        return ZoomEntryResolution(kind=ZoomEntryKind.PENDING, url=None)

    # -- 4. the owner --
    if user is not None and practice.master_id == user.id:
        return ZoomEntryResolution(kind=ZoomEntryKind.HOST, url=None)

    # -- 5. a live booking --
    if user is not None:
        booking = (
            await session.execute(
                select(Booking).where(
                    Booking.practice_id == practice.id,
                    Booking.user_id == user.id,
                    Booking.status.in_(_LIVE_BOOKING_STATUSES),
                )
            )
        ).scalars().first()
        if booking is not None:
            # Imported here rather than at module load: practices/service.py
            # reaches back into this module, and every cross-service call in
            # that pair is deliberately lazy.
            from app.modules.practices.service import (
                ZOOM_VISIBLE_BOOKING_STATUSES,
            )
            join_url = None
            if booking.status in ZOOM_VISIBLE_BOOKING_STATUSES:
                join_url = (
                    await session.execute(
                        select(ZoomRegistrant.join_url).where(
                            ZoomRegistrant.zoom_meeting_id == meeting.id,
                            ZoomRegistrant.booking_id == booking.id,
                            ZoomRegistrant.status
                            != ZoomRegistrantStatus.CANCELLED.value,
                            ZoomRegistrant.join_url.is_not(None),
                        )
                    )
                ).scalars().first()
            if join_url:
                return ZoomEntryResolution(
                    kind=ZoomEntryKind.PERSONAL, url=join_url,
                )
            return ZoomEntryResolution(kind=ZoomEntryKind.PENDING, url=None)

    # -- 6. nobody attendance will judge --
    return ZoomEntryResolution(
        kind=ZoomEntryKind.GUEST, url=meeting.shared_join_url,
    )
