# =============================================================================
# VELO Backend -- Zoom Attendance Decision (E21 step F, ПРОМТ №521)
# =============================================================================
#
# THIS IS THE MODULE THAT CHANGES PRODUCTION BEHAVIOUR. Everything else in
# E21 so far was inert. This one writes the raw report into
# zoom_attendance_segments (the audit trail -- never filtered), runs the
# matching ladder, sums minutes, excludes the host, and writes the actual
# attended/no_show decision onto Booking rows that
# bookings/service.py:_finalize_practice_core deliberately left undecided
# for Zoom-tracked practices (see that function's docstring for the defer
# mechanism this module resolves).
#
# THE LADDER: registrant_id -> email -> unmatched. VELO users have NO email
# at all (not "no dedicated field" -- Telegram login, email is a documented
# future thing). registration_email is therefore usually a synthetic
# .invalid placeholder (zoom/service.py's _registration_email_for). The
# email rung is built and kept working end-to-end anyway, for two real
# reasons: the owner may add real email collection later and this rung
# must light up on its own without a code change; and a registrant Zoom
# happens to know by a genuine address (if the owner ever does add real
# emails) should not be thrown away just because MOST registrants still
# carry a placeholder. THE HARD RULE: a placeholder address is NEVER used
# as a match key, on either side -- checked BEFORE any comparison, not
# relied on to simply fail to coincide. Two placeholder addresses (e.g.
# two different users, both with no real email) must never match each
# other; PLACEHOLDER_EMAIL_SUFFIX detection guards this explicitly, tested
# explicitly (test_zoom_attendance.py).
#
# HOST EXCLUSION happens BEFORE the ladder, not as a ladder rung: a segment
# matching the meeting's role='host' registrant (by registrant_id OR a
# real, non-placeholder email) is tagged match_method='host' and pointed at
# the host registrant row -- present in the audit trail, excluded from
# every booking's total, and NOT counted as unmatched (matched_registrant_
# row_id is non-NULL, so it never satisfies the "unmatched" query).
# =============================================================================

from collections import defaultdict
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.practices.models import Practice
from app.modules.zoom.models import (
    ZoomAttendanceSegment,
    ZoomMeeting,
    ZoomRegistrant,
    ZoomRegistrantRole,
)
from app.modules.zoom.zoom_client import ZoomAPIError, get_participants_report

logger = structlog.get_logger()

# Must match the domain used in zoom/service.py's _registration_email_for.
# Duplicated as a literal (not imported) to keep this module import-light
# and because the two are tested against each other directly.
PLACEHOLDER_EMAIL_SUFFIX = "@users.velo.invalid"


def _is_placeholder_email(email: str | None) -> bool:
    """True for our own synthetic .invalid addresses -- never a valid match
    key, on either side of a comparison."""
    return bool(email) and email.strip().lower().endswith(PLACEHOLDER_EMAIL_SUFFIX)


def _normalized_matchable_email(email: str | None) -> str | None:
    """Lowercased/trimmed email, or None if blank OR a placeholder -- the
    single choke point every email comparison in this module goes through,
    so "never match on a placeholder" cannot be forgotten at a call site."""
    if not email:
        return None
    normalized = email.strip().lower()
    if not normalized or _is_placeholder_email(normalized):
        return None
    return normalized


def attendance_threshold_seconds(duration_minutes: int) -> int:
    """The attendance bar for a practice: 50% of ITS OWN duration, not a
    fixed global minute count (owner decision, ПРОМТ №585 -- replaces the
    old settings.zoom_attendance_threshold_minutes=10 constant, which is
    now vestigial, see config.py). Integer floor division on minutes, THEN
    converted to seconds -- matches the owner's mapping exactly: 30->15,
    45->22, 60->30, 75->37, 90->45, 120->60 (test_zoom_attendance_ladder.py
    asserts all six literally). Total over the whole validated
    practice_min/max_duration_minutes range (5..480, config.py) -- no floor,
    no cap, deliberately (that was explicitly deferred by the owner)."""
    return (duration_minutes // 2) * 60


def _parse_report_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def match_report_rows(
    rows: list[dict],
    registrants: list[ZoomRegistrant],
) -> list[dict]:
    """Run the matching ladder over raw report rows. Pure function (no DB,
    no session) -- returns a list of dicts describing each row's match, for
    the caller to turn into ZoomAttendanceSegment rows and a per-registrant
    minutes total. Kept separate from ingest_report_for_meeting() so the
    ladder itself is directly unit-testable without a database.

    Each result dict: {row, matched_registrant, match_method}. match_method
    is one of 'host' | 'registrant_id' | 'email' | 'unmatched'.
    """
    by_zoom_registrant_id = {
        r.zoom_registrant_id: r for r in registrants if r.zoom_registrant_id
    }
    by_email: dict[str, ZoomRegistrant] = {}
    for r in registrants:
        key = _normalized_matchable_email(r.registration_email)
        if key is not None and key not in by_email:
            by_email[key] = r
    host = next(
        (r for r in registrants if r.role == ZoomRegistrantRole.HOST.value), None,
    )
    host_email_key = (
        _normalized_matchable_email(host.registration_email) if host else None
    )

    results = []
    for row in rows:
        raw_registrant_id = row.get("registrant_id") or None
        raw_email_key = _normalized_matchable_email(row.get("user_email"))

        matched: ZoomRegistrant | None = None
        method = "unmatched"

        # Host check FIRST -- excluded entirely, not just another rung.
        if host is not None and (
            (raw_registrant_id and raw_registrant_id == host.zoom_registrant_id)
            or (raw_email_key is not None and raw_email_key == host_email_key)
        ):
            matched, method = host, "host"
        elif raw_registrant_id and raw_registrant_id in by_zoom_registrant_id:
            matched = by_zoom_registrant_id[raw_registrant_id]
            method = "registrant_id"
        elif raw_email_key is not None and raw_email_key in by_email:
            matched = by_email[raw_email_key]
            method = "email"

        results.append(
            {"row": row, "matched_registrant": matched, "match_method": method},
        )
    return results


def sum_seconds_by_registrant(
    matches: list[dict],
) -> dict[UUID, int]:
    """Sum duration_seconds per matched STUDENT registrant across ALL their
    segments -- Zoom returns multiple rows on rejoin and does not sum them,
    so this does. Host-matched and unmatched rows contribute nothing to
    anyone's total (by construction: only 'registrant_id'/'email' matches,
    which are never host, reach here as a real ZoomRegistrant to key on)."""
    totals: dict[UUID, int] = defaultdict(int)
    for m in matches:
        matched = m["matched_registrant"]
        if matched is None or matched.role != ZoomRegistrantRole.STUDENT.value:
            continue
        seconds = int(m["row"].get("duration") or 0)
        totals[matched.id] += seconds
    return dict(totals)


async def ingest_report_for_meeting(
    zoom_meeting: ZoomMeeting,
    practice: Practice,
    session: AsyncSession,
) -> bool:
    """Pull both report variants, prefer the richer one, write every row to
    zoom_attendance_segments verbatim (the audit trail -- never filtered),
    run the ladder, sum minutes, and decide every still-CONFIRMED STUDENT
    booking on this meeting (including bookings with zero matched
    segments -- a genuine no-show, decided via Zoom just as authoritatively
    as an attended one).

    Returns True if the Zoom calls themselves succeeded (report_ingested_at
    is set), regardless of whether any/all bookings ended up attended or
    no_show -- a real, possibly-empty answer is success. Returns False only
    on a Zoom API failure, leaving report_ingested_at NULL for the next
    poll cycle (or, eventually, the deadline fallback) to handle. Never
    raises.
    """
    try:
        with_registrant_id = await get_participants_report(
            zoom_meeting_id=zoom_meeting.zoom_meeting_id, include_registrant_id=True,
        )
        without_registrant_id = await get_participants_report(
            zoom_meeting_id=zoom_meeting.zoom_meeting_id, include_registrant_id=False,
        )
    except ZoomAPIError as exc:
        logger.warning(
            "zoom_report_fetch_failed",
            practice_id=str(practice.id),
            status_code=exc.status_code,
            error=str(exc),
        )
        return False

    def _populated(rows: list[dict]) -> int:
        return sum(1 for r in rows if r.get("registrant_id"))

    # Prefer whichever variant has more populated registrant_id values --
    # the parameter's real effect is unconfirmed (E21 research); use ONE
    # dataset, never both (using both would double-write every segment).
    rows = (
        with_registrant_id
        if _populated(with_registrant_id) >= _populated(without_registrant_id)
        else without_registrant_id
    )

    registrants = (
        await session.execute(
            select(ZoomRegistrant).where(
                ZoomRegistrant.zoom_meeting_id == zoom_meeting.id,
            )
        )
    ).scalars().all()

    matches = match_report_rows(rows, list(registrants))

    for m in matches:
        row = m["row"]
        matched = m["matched_registrant"]
        session.add(
            ZoomAttendanceSegment(
                zoom_meeting_id=zoom_meeting.id,
                matched_registrant_row_id=matched.id if matched else None,
                match_method=m["match_method"],
                zoom_registrant_id_raw=row.get("registrant_id") or None,
                join_time=_parse_report_datetime(row.get("join_time")),
                leave_time=_parse_report_datetime(row.get("leave_time")),
                duration_seconds=(
                    int(row["duration"]) if row.get("duration") is not None else None
                ),
                raw_row=row,
                source="report",
            )
        )

    seconds_by_registrant = sum_seconds_by_registrant(matches)
    threshold_seconds = attendance_threshold_seconds(practice.duration_minutes)

    outcomes: list[tuple[UUID, UUID, str]] = []
    for r in registrants:
        if r.role != ZoomRegistrantRole.STUDENT.value or r.booking_id is None:
            continue
        booking = (
            await session.execute(
                select(Booking).where(Booking.id == r.booking_id).with_for_update()
            )
        ).scalar_one_or_none()
        if booking is None or booking.status != BookingStatus.CONFIRMED.value:
            # Already decided (or cancelled) by something else -- never
            # overwritten here. FOR UPDATE (same discipline as
            # cancel_booking, bookings/service.py:372) closes the race: a
            # cancel committing between this read and our flush would
            # otherwise be silently reverted by the unconditional status
            # write below.
            continue

        # Raw-seconds comparison, no rounding of our own on top of Zoom's
        # own undocumented one (E21 research). zoom_minutes_present is a
        # DISPLAY value (floor division) -- the decision itself compares
        # total_seconds, not the rounded minutes.
        total_seconds = seconds_by_registrant.get(r.id, 0)
        attended = total_seconds >= threshold_seconds

        booking.zoom_minutes_present = total_seconds // 60
        booking.attendance_decided_via = "zoom_report"
        booking.status = (
            BookingStatus.ATTENDED.value if attended else BookingStatus.NO_SHOW.value
        )
        outcomes.append((booking.user_id, booking.id, booking.status))

    if outcomes:
        from app.modules.diary.projections import project_practice_outcome
        from app.modules.masters.service import get_master_display_name

        master_name = await get_master_display_name(practice.master_id, session)
        await project_practice_outcome(
            session,
            practice=practice,
            master_name=master_name,
            outcomes=outcomes,
            occurred_at=datetime.now(UTC),
        )

    zoom_meeting.report_ingested_at = datetime.now(UTC)
    logger.info(
        "zoom_report_ingested",
        practice_id=str(practice.id),
        segments=len(matches),
        bookings_decided=len(outcomes),
    )
    return True


async def apply_legacy_proxy_fallback(
    practice: Practice,
    session: AsyncSession,
) -> int:
    """THE BOUND: decide every remaining CONFIRMED booking on this practice
    via the legacy join_at/checkin proxy, tagged legacy_proxy -- for a
    Zoom-tracked practice whose report never successfully ingested within
    settings.zoom_attendance_decision_deadline_minutes. Closes the trap
    named in the E21 plan: an empty/failed report is indistinguishable at a
    glance from "not ready yet", so without this bound a booking could sit
    undecided indefinitely, silently blocking feedback eligibility and
    hours.

    Reuses bookings/service.py's resolve_bookings_via_legacy_proxy (the
    SAME logic _finalize_practice_core uses for non-Zoom-tracked practices)
    so there is exactly one place that knows how the proxy decides.
    Projects the diary outcome for these bookings, since they were deferred
    at practice-finalize time and never got one. Returns the number of
    bookings decided.
    """
    from app.modules.bookings.service import resolve_bookings_via_legacy_proxy

    bookings = (
        await session.execute(
            select(Booking)
            .where(
                Booking.practice_id == practice.id,
                Booking.status == BookingStatus.CONFIRMED.value,
            )
            .with_for_update()
        )
    ).scalars().all()
    if not bookings:
        return 0

    outcomes = await resolve_bookings_via_legacy_proxy(
        list(bookings), practice.id, session,
    )

    if outcomes:
        from app.modules.diary.projections import project_practice_outcome
        from app.modules.masters.service import get_master_display_name

        master_name = await get_master_display_name(practice.master_id, session)
        await project_practice_outcome(
            session,
            practice=practice,
            master_name=master_name,
            outcomes=outcomes,
            occurred_at=datetime.now(UTC),
        )

    logger.info(
        "zoom_attendance_deadline_fallback_applied",
        practice_id=str(practice.id),
        bookings_decided=len(outcomes),
    )
    return len(outcomes)
