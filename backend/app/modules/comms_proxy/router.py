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
# rejected with 422 (never silently ignored -- silently answering for
# the RIGHT user would mask a broken client that believes it queried
# another one); the prefs body rejects unknown keys the same way.
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

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from app.core.comms import comms_request
from app.core.exceptions import BadRequestError
from app.modules.auth.dependencies import get_current_user
from app.modules.users.models import User

router = APIRouter(
    prefix="/api/v1/notifications", tags=["notifications"],
)


def _reject_recipient_override(request: Request) -> None:
    """422 on any attempt to name a recipient from the client side."""
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


def _delivery_to_quiet(schedule: ScheduleIn) -> dict[str, Any]:
    """UI delivery window -> comms quiet window (times swapped)."""
    return {
        "from": schedule.to,
        "to": schedule.from_,
        "days": schedule.days,
    }


def _quiet_to_delivery(payload: Any) -> Any:
    """comms GET/PATCH response -> UI form (quiet times swapped back).

    The rest of the facade (categories, timezone) passes through
    untouched -- re-assembling it would be the "half a facade" the
    arch doc warns about; only the schedule semantics differ.
    """
    if not isinstance(payload, dict):
        return payload
    quiet = payload.get("schedule")
    if isinstance(quiet, dict):
        payload = {
            **payload,
            "schedule": {
                "from": quiet.get("to"),
                "to": quiet.get("from"),
                "days": quiet.get("days"),
            },
        }
    return payload


@router.get("/prefs")
async def get_prefs(
    request: Request,
    user: User = Depends(get_current_user),
) -> Any:
    """E8 facade: category toggles + delivery schedule + read-only
    timezone. 404 (forwarded) = recipient not yet synced into comms."""
    _reject_recipient_override(request)
    payload = await comms_request("GET", _prefs_path(user))
    return _quiet_to_delivery(payload)


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
        patch["schedule"] = (
            None
            if body.schedule is None
            else _delivery_to_quiet(body.schedule)
        )
    payload = await comms_request(
        "PATCH", _prefs_path(user), json=patch,
    )
    return _quiet_to_delivery(payload)
