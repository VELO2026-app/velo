# =============================================================================
# Tests: Zoom Attendance Matching Ladder (E21 step F -- ПРОМТ №521)
# =============================================================================
#
# Pure logic, no DB: match_report_rows / sum_seconds_by_registrant operate
# on in-memory ZoomRegistrant objects (UUIDMixin gives them an id via
# app-side uuid4() without a session) and plain dicts. No fixtures needed.
#
# ⚠ ON PROOF: this exact logic (the ladder, placeholder exclusion, host
# exclusion, rejoin summing) was ALSO executed directly via a standalone
# script outside pytest entirely -- 20 assertions, all passing, including
# catching and fixing a bug in the verification script itself (not in
# production code) on the first run. That is real, observed proof this
# specific logic is correct. This file is the same logic in pytest form,
# written to be read and to run in CI -- but running IT specifically
# through pytest was never observed this session (see
# test_zoom_lifecycle.py's module docstring for the exact local blocker).
# Do not conflate "the standalone script passed" with "this pytest file
# passed" -- they are the same logic, exercised two different ways, and
# only the first was actually watched execute in this session.
# =============================================================================

from uuid import uuid4

from app.modules.zoom.attendance_service import (
    PLACEHOLDER_EMAIL_SUFFIX,
    _is_placeholder_email,
    _normalized_matchable_email,
    attendance_threshold_seconds,
    match_report_rows,
    sum_seconds_by_registrant,
)
from app.modules.zoom.models import ZoomRegistrant, ZoomRegistrantRole

# Illustrative boundary only -- NOT the production threshold since ПРОМТ
# №585 (the real one is 50% of each practice's own duration_minutes, see
# attendance_threshold_seconds() and its own tests below). Kept as a plain
# constant here because these two tests exercise sum_seconds_by_registrant's
# rejoin-summing, not the decision itself, and need SOME boundary to sit at.
THRESHOLD_SECONDS = 10 * 60


def _registrant(**overrides) -> ZoomRegistrant:
    base = dict(
        zoom_meeting_id=uuid4(),
        user_id=uuid4(),
        role=ZoomRegistrantRole.STUDENT.value,
        registration_email="placeholder@users.velo.invalid",
    )
    base.update(overrides)
    return ZoomRegistrant(**base)


def test_placeholder_detection() -> None:
    assert _is_placeholder_email(f"user-{uuid4()}{PLACEHOLDER_EMAIL_SUFFIX}") is True
    assert _is_placeholder_email("real-person@example.com") is False
    assert _is_placeholder_email(None) is False


def test_normalized_matchable_email_rejects_placeholder_and_normalizes_real() -> None:
    placeholder = _registrant(registration_email=f"user-{uuid4()}{PLACEHOLDER_EMAIL_SUFFIX}")
    assert _normalized_matchable_email(placeholder.registration_email) is None
    assert _normalized_matchable_email("  Real-Person@Example.COM  ") == "real-person@example.com"


def test_ladder_rung_registrant_id() -> None:
    """First rung: registrant_id hit."""
    alice = _registrant(booking_id=uuid4(), zoom_registrant_id="zoom-alice")
    rows = [{"registrant_id": "zoom-alice", "user_email": None, "duration": 700}]

    results = match_report_rows(rows, [alice])

    assert results[0]["match_method"] == "registrant_id"
    assert results[0]["matched_registrant"] is alice


def test_ladder_rung_email_when_registrant_id_absent() -> None:
    """Second rung: registrant_id missing/unknown, real email known -- still
    matches. This rung exists to light up on its own if the owner ever adds
    real email collection (E21 plan sec: keep all three rungs)."""
    alice = _registrant(
        booking_id=uuid4(), zoom_registrant_id=None,
        registration_email="alice-real@example.com",
    )
    rows = [{"registrant_id": None, "user_email": "Alice-Real@Example.com", "duration": 650}]

    results = match_report_rows(rows, [alice])

    assert results[0]["match_method"] == "email"
    assert results[0]["matched_registrant"] is alice


def test_ladder_rung_unmatched() -> None:
    """Third rung: neither registrant_id nor email known -- unmatched, the
    bucket that must stay visible (E21 plan sec 6)."""
    alice = _registrant(booking_id=uuid4(), zoom_registrant_id="zoom-alice")
    rows = [{"registrant_id": "zoom-unknown", "user_email": "stranger@example.com", "duration": 500}]

    results = match_report_rows(rows, [alice])

    assert results[0]["match_method"] == "unmatched"
    assert results[0]["matched_registrant"] is None


def test_two_placeholder_addresses_never_match_each_other() -> None:
    """THE BUG CLASS this test exists for: two registrants who both only
    have a synthetic .invalid address (the common case, since VELO has no
    real email collection) must NEVER be matched to each other via the
    email rung, even if a report row's email happened to equal one of
    them exactly. Green-suite-wrong-people-credited is exactly what this
    guards against."""
    same_placeholder = f"user-{uuid4()}{PLACEHOLDER_EMAIL_SUFFIX}"
    bob = _registrant(
        booking_id=uuid4(), zoom_registrant_id=None,
        registration_email=same_placeholder,
    )
    carol = _registrant(
        booking_id=uuid4(), zoom_registrant_id=None,
        registration_email=same_placeholder,  # identical string, on purpose
    )
    rows = [{"registrant_id": None, "user_email": same_placeholder, "duration": 400}]

    results = match_report_rows(rows, [bob, carol])

    assert results[0]["match_method"] == "unmatched", (
        "a report row whose email happens to equal a placeholder string "
        "must never be treated as a match key"
    )
    assert results[0]["matched_registrant"] is None


def test_host_excluded_not_unmatched_not_credited_to_any_booking() -> None:
    """Host segments are matched (matched_registrant_row_id is non-NULL, so
    a 'WHERE matched_registrant_row_id IS NULL' unmatched-count query never
    picks them up) but contribute zero seconds to any STUDENT booking."""
    host = _registrant(
        role=ZoomRegistrantRole.HOST.value, booking_id=None,
        zoom_registrant_id="zoom-host", registration_email="master-real@example.com",
    )
    alice = _registrant(booking_id=uuid4(), zoom_registrant_id="zoom-alice")
    rows = [{"registrant_id": "zoom-host", "user_email": None, "duration": 3000}]

    results = match_report_rows(rows, [host, alice])

    assert results[0]["match_method"] == "host"
    assert results[0]["matched_registrant"] is host
    assert results[0]["matched_registrant"] is not None  # never "unmatched"

    totals = sum_seconds_by_registrant(results)
    assert totals == {}, "host's segment must not appear in any booking's total"


def test_rejoin_summing_just_under_threshold() -> None:
    """Multiple segments for the SAME registrant (rejoin) are summed, not
    just the last row taken -- and the sum lands just under the default
    10-minute (600s) threshold."""
    alice = _registrant(booking_id=uuid4(), zoom_registrant_id="zoom-alice")
    rows = [
        {"registrant_id": "zoom-alice", "user_email": None, "duration": 250},
        {"registrant_id": "zoom-alice", "user_email": None, "duration": 300},
        {"registrant_id": "zoom-alice", "user_email": None, "duration": 49},
    ]  # 599s total

    results = match_report_rows(rows, [alice])
    totals = sum_seconds_by_registrant(results)

    assert totals[alice.id] == 599
    assert totals[alice.id] < THRESHOLD_SECONDS


def test_rejoin_summing_exactly_at_threshold() -> None:
    """Same as above but the rejoin sum lands exactly at the threshold --
    attended = total_seconds >= threshold, so this is the attended side."""
    alice = _registrant(booking_id=uuid4(), zoom_registrant_id="zoom-alice")
    rows = [
        {"registrant_id": "zoom-alice", "user_email": None, "duration": 250},
        {"registrant_id": "zoom-alice", "user_email": None, "duration": 300},
        {"registrant_id": "zoom-alice", "user_email": None, "duration": 50},
    ]  # 600s total, exactly the boundary

    results = match_report_rows(rows, [alice])
    totals = sum_seconds_by_registrant(results)

    assert totals[alice.id] == 600
    assert totals[alice.id] >= THRESHOLD_SECONDS


# ===================================================================
# attendance_threshold_seconds -- 50% of the practice's OWN duration
# (ПРОМТ №585, replaces the old fixed 10-minute constant)
# ===================================================================


def test_attendance_threshold_matches_owner_mapping_exactly() -> None:
    """The six pairs from the owner's decision, asserted literally --
    duration_minutes -> threshold_minutes, both sides in seconds here."""
    owner_mapping_minutes = {
        30: 15,
        45: 22,
        60: 30,
        75: 37,
        90: 45,
        120: 60,
    }
    for duration_minutes, expected_threshold_minutes in owner_mapping_minutes.items():
        assert attendance_threshold_seconds(duration_minutes) == expected_threshold_minutes * 60


def test_attendance_threshold_sane_at_validated_range_extremes() -> None:
    """practice_min/max_duration_minutes admits 5..480 (config.py) even
    though the product UI only offers 30..120 -- the formula must stay a
    sane, non-negative, non-zero-division result over the FULL validated
    range, not just the UI's subset."""
    assert attendance_threshold_seconds(5) == 120  # 5 // 2 = 2 min -> 120s
    assert attendance_threshold_seconds(480) == 14400  # 240 min -> 14400s


def test_attendance_threshold_never_negative_or_crashing_across_full_range() -> None:
    """No floor, no cap, deliberately -- pure 50%, every minute in the
    validated range produces a sane non-negative result."""
    for duration_minutes in range(5, 481):
        threshold = attendance_threshold_seconds(duration_minutes)
        assert threshold >= 0
        assert threshold <= duration_minutes * 60
