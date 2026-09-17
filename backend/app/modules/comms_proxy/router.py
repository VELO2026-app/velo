# =============================================================================
# VELO Backend -- Notifications proxy (Phase 6 / T1, items 3-4)
# =============================================================================
#
# The user-facing surface of the comms service (integration design
# ID-9): the frontend keeps ONE API and ONE initData authorization;
# velo authenticates the user, stamps recipient_id SERVER-SIDE, and
# forwards to the internal comms API via core/comms.py.
#
#   GET  /api/v1/notifications                  -> comms inbox (keyset;
#        ?limit=&cursor=)                          mirror of the frozen
#                                                  3b form: {items,
#                                                  next_cursor, unread})
#   GET  /api/v1/notifications/unread-count     -> {"unread": N}
#   POST /api/v1/notifications/read-all         -> {"unread": 0}
#   POST /api/v1/notifications/{delivery_id}/read -> {"unread": N}
#   GET  /api/v1/notifications/prefs            -> E8 facade, schedule
#                                                  converted (below)
#   PUT  /api/v1/notifications/prefs            -> partial write, same
#                                                  response as GET
#
# TRUST MODEL (frozen 3b contract, dispatch plan §6b "КРИТИЧНО"):
# comms does NOT check that recipient_id belongs to the end user --
# the shared token authenticates the PRODUCT. This router is the sole
# owner of that check: recipient_id is ALWAYS the authenticated velo
# session's user id. A recipient_id smuggled in the query string is
# rejected with 400 (never silently ignored -- silently answering for
# the RIGHT user would mask a broken client that believes it queried
# another one); the prefs body rejects unknown keys with 422 (pydantic
# extra="forbid").
#
# SCHEDULE CONVERSION (approved plan fork 4, Master-chat 2026-07-28):
# comms stores a QUIET window ("do not deliver from/to"); the velo UI
# speaks a DELIVERY window ("deliver from X to Y"). The
# proxy owns the inversion:
#     ui.from = quiet.to      ui.to = quiet.from      days pass through
# (quiet [22:00 -> 09:00] <=> deliver [09:00 -> 22:00]). Categories
# and timezone pass through untouched. KNOWN LIMIT (v1, accepted): a
# "no delivery at all on day D" cannot be expressed by one window --
# days keep the comms semantics of window-start days.
#
# FAILURE MODEL: comms down -> 502/504 from core/comms.py; velo keeps
# running (the bell degrades, domains do not).
# =============================================================================

from typing import Any
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from app.core.comms import comms_request
from app.core.exceptions import BadRequestError
from app.modules.auth.dependencies import get_current_user
from app.modules.users.models import User

logger = structlog.get_logger()

router = APIRouter(
    prefix="/api/v1/notifications", tags=["notifications"],
)


def _reject_recipient_override(request: Request) -> None:
    """400 on any attempt to name a recipient from the client side."""
    if "recipient_id" in request.query_params:
        raise BadRequestError(
            "recipient_id is derived from the session and cannot be "
            "supplied by the client"
        )


def _inbox_path(user: User, suffix: str = "") -> str:
    return f"/api/v1/recipients/{user.id}/inbox{suffix}"


def _prefs_path(user: User) -> str:
    return f"/api/v1/recipients/{user.id}/preferences"


# ---------------------------------------------------------------------------
# Inbox / badge (frozen 3b forms, forwarded verbatim)
# ---------------------------------------------------------------------------


@router.get("")
async def list_notifications(
    request: Request,
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None),
    user: User = Depends(get_current_user),
) -> Any:
    """The in-app bell: newest-first keyset page + badge, 3b form."""
    _reject_recipient_override(request)
    params: dict[str, Any] = {"limit": limit}
    if cursor is not None:
        params["cursor"] = cursor
    return await comms_request("GET", _inbox_path(user), params=params)


@router.get("/unread-count")
async def unread_count(
    request: Request,
    user: User = Depends(get_current_user),
) -> Any:
    _reject_recipient_override(request)
    return await comms_request(
        "GET", _inbox_path(user, "/unread-count"),
    )


@router.post("/read-all")
async def read_all(
    request: Request,
    user: User = Depends(get_current_user),
) -> Any:
    _reject_recipient_override(request)
    return await comms_request(
        "POST", _inbox_path(user, "/read-all"),
    )


@router.post("/{delivery_id}/read")
async def read_one(
    delivery_id: UUID,
    request: Request,
    user: User = Depends(get_current_user),
) -> Any:
    """Idempotent mark-read; 404 (forwarded) covers both "no such
    delivery" and "not this recipient's delivery" -- comms scopes the
    lookup to the recipient_id this proxy stamped."""
    _reject_recipient_override(request)
    return await comms_request(
        "POST", _inbox_path(user, f"/{delivery_id}/read"),
    )


# ---------------------------------------------------------------------------
# Preferences (E8 facade; schedule semantics converted here)
# ---------------------------------------------------------------------------


class ScheduleIn(BaseModel):
    """The UI's DELIVERY window ("deliver from X to Y", day picks)."""

    model_config = ConfigDict(extra="forbid")

    from_: str = Field(alias="from")
    to: str
    days: list[str]


class PrefsUpdate(BaseModel):
    """Partial update: only supplied parts change (mirrors comms
    PATCH). Unknown keys are rejected -- silently swallowing a field
    the client believed it set is how settings screens lie (frozen 3b
    wording)."""

    model_config = ConfigDict(extra="forbid")

    categories: dict[str, bool] | None = None
    # Tri-state: omitted = untouched, null = clear window, object =
    # full replace (all three fields required, as in comms); the
    # distinction is read via pydantic's model_fields_set.
    schedule: ScheduleIn | None = None


# ===========================================================================
# Screen <-> comms schedule translation (GT-37)
#
# THE INVERSION IS GONE, not rewritten. Until comms 2.0.0 they stored ONE
# QUIET window, our screen states DELIVERY hours, and the two are the same
# minutes read from opposite ends -- so the proxy swapped from and to. Their
# model now stores THE PERIODS WHEN DELIVERY IS ALLOWED, which is what the
# screen already says, and a swap left in place would send back exactly the
# inverse schedule WITHOUT ANY ERROR: an inverted period is still valid,
# 422 never comes, the build stays green, and the person is notified
# precisely when they asked for silence.
#
# THEIR SHAPE: a list of periods, each {day, from, to}, each owned by its
# weekday and never crossing midnight. Days absent from the list are silent
# for the whole day. null clears; an empty list is refused by them (422) --
# "never" is not a schedule.
#
# OUR SHAPE: one pair of hours plus a set of days, because that is what the
# screen has. Expanding is total; collapsing is not -- see
# _periods_to_delivery.
# ===========================================================================

_DAY_ORDER = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

# The screen's picker offers hours 00..23, so "until midnight" arrives as
# "00:00". Their only spelling for the end of a day is "24:00"; a start may
# not be 24:00, so the mapping is asymmetric ON PURPOSE -- only `to`.
_SCREEN_MIDNIGHT = "00:00"
_WIRE_MIDNIGHT = "24:00"


def _normalized_end(value: str) -> str:
    """The screen's end-of-day ("00:00") in the wire's spelling ("24:00").

    ORDER IS LOAD-BEARING: this runs BEFORE the from > to test below.
    "deliver 09:00 to 00:00" is numerically 09:00 > 00:00 and would fall
    into the overnight branch, which would split it into a zero-length
    period and a second one -- the first rejected, the second wrong, and
    the whole thing for the most ordinary choice on the screen. Normalise
    first and the same input is one period, 09:00..24:00.
    """
    return _WIRE_MIDNIGHT if value == _SCREEN_MIDNIGHT else value


def _delivery_to_periods(schedule: ScheduleIn) -> list[dict[str, str]]:
    """Screen window + days -> their list of allowed periods.

    from < to  -- one period per marked day.
    from > to  -- TWO periods in the MARKED day: [00:00, to) and
                  [from, 24:00). Not the marked day's evening plus the
                  NEXT day's morning: an unmarked day is silent for its
                  whole length (owner ruling, 16 September), so spilling
                  into it would deliver on a day nobody ticked. Read
                  forward, "deliver on Monday outside 09:00-21:00" is a
                  real setting -- do not disturb during working hours.
    from == to -- refused here, not forwarded: their message speaks of
                  minutes and an ISO day number, and this is the last place
                  that still knows the shape the screen sent.

    THE TWO PERIODS CANNOT OVERLAP OR TOUCH, so there is no branch for it
    and none is missing. They are [00:00, to) and [from, 24:00) with
    to < from; touching would need to == from, which the equality check
    above already refused, and overlapping would need to > from, which is
    the other branch. Documenting the impossible is how a reader learns to
    distrust the rest.

    Days are de-duplicated: the same day twice would produce two identical
    periods, and they refuse touching periods rather than merging them.
    """
    end = _normalized_end(schedule.to)
    if schedule.from_ == end or schedule.from_ == schedule.to:
        raise BadRequestError(
            "Время начала и окончания доставки не могут совпадать",
        )

    days = [day for day in _DAY_ORDER if day in set(schedule.days)]
    periods: list[dict[str, str]] = []
    for day in days:
        if schedule.from_ < end:
            periods.append(
                {"day": day, "from": schedule.from_, "to": end},
            )
        else:
            periods.append(
                {"day": day, "from": "00:00", "to": end},
            )
            periods.append(
                {"day": day, "from": schedule.from_, "to": _WIRE_MIDNIGHT},
            )
    return periods


def _hours_of_day(periods: list[dict[str, str]]) -> tuple[str, str] | None:
    """The screen's (from, to) for one day's periods, or None if it has no
    screen form.

    One period is the plain case. Two are the overnight case this proxy
    writes -- [00:00, to) and [from, 24:00) -- and only in that exact
    arrangement. Anything else was written by somebody other than us.
    """
    if len(periods) == 1:
        return periods[0]["from"], periods[0]["to"]
    if len(periods) == 2:
        first, second = periods
        if (
            first["from"] == "00:00"
            and second["to"] == _WIRE_MIDNIGHT
        ):
            return second["from"], first["to"]
    return None


def _periods_to_delivery(payload: Any) -> Any:
    """comms GET/PATCH response -> the screen's form.

    KNOWN CEILING -- a schedule this screen cannot show comes back as null.

      MECHANICS: their contract is strictly more expressive than our
        screen. They allow different hours on different days; the screen
        has one pair of hours for every ticked day. Collapsing a list into
        that pair is only defined while every day carries the same hours.
        It holds today because THE ONLY WRITER IS THIS PROXY -- an
        invariant of our code, not a promise of their contract.
      STATUS: acknowledged by design.
      TASK: none. The shape that would need it does not exist yet; building
        for it now would be a branch nobody can reach.
      DEFUSING TRIGGER (observable): the first "comms_schedule_not_representable"
        line in the log. It carries the recipient and the list, so the day
        it appears we will know who wrote it and what it said.
      AGREED FIX WHEN IT FIRES: return the hours of the first period and
        ONLY the days that match them, dropping the rest. That is truer
        than null -- the days returned really are those hours -- and the
        person repairs the remainder by saving, since a save replaces the
        whole list.
      REJECTED, AND WHY: (a) an error response, which locks the screen --
        the only way to rewrite a schedule is to save from this screen, and
        it would not open; (b) silently taking the first period's hours
        without checking the others, which is the "the person's choice
        changes quietly" defect this line spent GT-36 refusing.

    NULL HERE IS NOT A FACT ABOUT THE STORE. It says "not representable by
    this screen", not "not configured". The two look identical to the
    screen and are told apart only in the log -- which is the price of the
    ceiling above, named rather than hidden.
    """
    if not isinstance(payload, dict):
        return payload
    periods = payload.get("schedule")
    if not isinstance(periods, list):
        return payload

    by_day: dict[str, list[dict[str, str]]] = {}
    for period in periods:
        if not isinstance(period, dict) or "day" not in period:
            by_day = {}
            break
        by_day.setdefault(period["day"], []).append(period)

    hours: tuple[str, str] | None = None
    days: list[str] = []
    representable = bool(by_day)
    for day in _DAY_ORDER:
        if day not in by_day:
            continue
        day_hours = _hours_of_day(by_day[day])
        if day_hours is None or (hours is not None and day_hours != hours):
            representable = False
            break
        hours = day_hours
        days.append(day)

    screen_end = (
        _SCREEN_MIDNIGHT
        if hours is not None and hours[1] == _WIRE_MIDNIGHT
        else (hours[1] if hours is not None else None)
    )
    if hours is not None and hours[0] == screen_end:
        # A whole day, [00:00, 24:00), collapses to from == to on the
        # screen -- and the write path refuses that pair. Showing it would
        # put the screen in a state it cannot save back, which fails
        # reversibility just as loudly as showing the wrong hours. This
        # proxy never writes a whole-day period (from == to is refused on
        # the way in), so the shape can only have come from another writer,
        # and that is the ceiling below.
        representable = False

    if not representable or hours is None:
        logger.warning(
            "comms_schedule_not_representable",
            schedule=periods,
        )
        return {**payload, "schedule": None}

    start, end = hours
    return {
        **payload,
        "schedule": {
            "from": start,
            # Back into the picker's vocabulary: it offers 00..23 and has
            # no "24:00" to select.
            "to": _SCREEN_MIDNIGHT if end == _WIRE_MIDNIGHT else end,
            "days": days,
        },
    }


@router.get("/prefs")
async def get_prefs(
    request: Request,
    user: User = Depends(get_current_user),
) -> Any:
    """E8 facade: category toggles + delivery schedule + read-only
    timezone. 404 (forwarded) = recipient not yet synced into comms."""
    _reject_recipient_override(request)
    payload = await comms_request("GET", _prefs_path(user))
    return _periods_to_delivery(payload)


@router.put("/prefs")
async def put_prefs(
    body: PrefsUpdate,
    request: Request,
    user: User = Depends(get_current_user),
) -> Any:
    _reject_recipient_override(request)
    patch: dict[str, Any] = {}
    if body.categories is not None:
        patch["categories"] = body.categories
    if "schedule" in body.model_fields_set:
        periods = (
            None
            if body.schedule is None
            else _delivery_to_periods(body.schedule)
        )
        # NO DAY TICKED IS null, NOT AN EMPTY LIST. They refuse [] with a
        # 422 -- "never" is not a schedule, it is a black hole where
        # deliveries defer until they expire -- and null is their spelling
        # for "no restriction". Without this line the screen's own empty
        # state answers with their validation error.
        patch["schedule"] = periods or None
    payload = await comms_request(
        "PATCH", _prefs_path(user), json=patch,
    )
    return _periods_to_delivery(payload)
