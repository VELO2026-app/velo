# =============================================================================
# VELO Backend -- Zoom Integration Client (E21 step C)
# =============================================================================
#
# Thin wrapper around Zoom's REST API for:
#   1. Server-to-Server OAuth token fetch (account-credentials grant)
#   2. Meeting CRUD: create / patch / delete
#   3. Registrant CRUD: create / list / status-update (Zoom has no DELETE)
#   4. Post-meeting participants report
#
# CREDENTIALS: ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET, env vars
#   only (core/config.py). Never logged, never persisted, never returned in
#   any response -- not even truncated.
#
# TOKEN CACHING: the access token lives in a module-level variable only,
#   refetched a little before it actually expires. No token table -- S2S
#   tokens are cheap to refetch, and persisting one is a secret-adjacent
#   surface for no benefit (E21 plan sec 7).
#
# WHY httpx.AsyncClient AND NOT asyncio.to_thread:
#   payments/stripe.py offloads the Stripe SDK (a SYNCHRONOUS client) onto a
#   thread pool because there's no way to call it without blocking the event
#   loop. There is no Zoom SDK dependency here -- this module talks to Zoom
#   directly over HTTP via httpx.AsyncClient, which is already
#   non-blocking/async-native. There is no blocking call to offload, so none
#   of the functions below need asyncio.to_thread; wrapping an already-async
#   call in one would just add a needless thread hop.
#
# STUB MODE: there is no Zoom sandbox for local dev. settings.is_zoom_stub
#   (true whenever credentials are blank, or ZOOM_CLIENT_SECRET="TEST",
#   mirroring the Stripe "TEST" sentinel) short-circuits every call below
#   with deterministic fake data, so callers can exercise their control flow
#   (success handling, failure handling, retry wiring) without real
#   credentials. UNLIKE the Stripe stub, there is no startup-blocking guard
#   here -- see the settings.is_zoom_stub docstring in core/config.py for
#   why, and do not add one without re-reading that reasoning first.
#
# FAILURE SHAPE: every call raises ZoomAPIError (status_code, body) on a
#   non-2xx response or a network failure. This module never swallows
#   errors or decides what "best-effort" means -- callers do that (E21
#   plan sec 2/3: publish/reschedule/cancel/registrant-create must never be
#   blocked by a Zoom failure, but that decision belongs to the caller, not
#   here).
# =============================================================================

import time
from typing import Any
from uuid import uuid4

import httpx
import structlog

from app.core.config import settings

logger = structlog.get_logger()

_ZOOM_OAUTH_URL = "https://zoom.us/oauth/token"
_ZOOM_API_BASE = "https://api.zoom.us/v2"

# In-memory only -- see module docstring. (access_token, expires_at_monotonic)
_token_cache: tuple[str, float] | None = None


class ZoomAPIError(Exception):
    """Raised on any non-2xx response or network failure from the Zoom API.

    Carries the raw status_code + body so callers can record
    ZoomMeeting.last_sync_error verbatim without re-deriving it. The
    exception's own message embeds both too (when there's a status_code to
    embed -- a network failure has neither, and its message already carries
    the underlying httpx error text from the raise site, so nothing is
    appended there rather than printing a hollow "status=None body=None").
    This makes str(exc)/logger.exception informative on their own, for any
    call site that doesn't explicitly re-read the attributes.
    """

    def __init__(
        self,
        message: str,
        status_code: int | None = None,
        body: Any = None,
    ) -> None:
        self.status_code = status_code
        self.body = body
        if status_code is not None:
            message = f"{message} (status={status_code}, body={body!r})"
        super().__init__(message)


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


async def _get_access_token() -> str:
    """Return a cached or freshly-fetched S2S OAuth access token."""
    global _token_cache
    if _token_cache is not None:
        token, expires_at = _token_cache
        if time.monotonic() < expires_at:
            return token

    auth = httpx.BasicAuth(settings.zoom_client_id, settings.zoom_client_secret)
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.post(
                _ZOOM_OAUTH_URL,
                params={
                    "grant_type": "account_credentials",
                    "account_id": settings.zoom_account_id,
                },
                auth=auth,
            )
        except httpx.HTTPError as exc:
            raise ZoomAPIError(f"Zoom OAuth request failed: {exc}") from None

    if resp.status_code != 200:
        raise ZoomAPIError(
            "Zoom OAuth token request failed",
            status_code=resp.status_code,
            body=_safe_body(resp),
        )

    data = resp.json()
    token = data.get("access_token")
    expires_in = data.get("expires_in", 3600)
    if not token:
        raise ZoomAPIError("Zoom OAuth response missing access_token")

    # Refresh 60s early so an in-flight request never uses a token that
    # expires mid-call.
    _token_cache = (token, time.monotonic() + max(expires_in - 60, 0))
    return token


def _safe_body(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return resp.text


# ---------------------------------------------------------------------------
# Request core
# ---------------------------------------------------------------------------


async def _request(
    method: str,
    path: str,
    *,
    json_body: dict | None = None,
    params: dict | None = None,
) -> Any:
    """Make one authenticated Zoom API call. Raises ZoomAPIError on failure."""
    if settings.is_zoom_stub:
        return _stub_response(method, path, json_body)

    token = await _get_access_token()
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.request(
                method,
                f"{_ZOOM_API_BASE}{path}",
                json=json_body,
                params=params,
                headers={"Authorization": f"Bearer {token}"},
            )
        except httpx.HTTPError as exc:
            raise ZoomAPIError(
                f"Zoom API request failed: {method} {path}: {exc}"
            ) from None

    if resp.status_code >= 300:
        raise ZoomAPIError(
            f"Zoom API {method} {path} failed",
            status_code=resp.status_code,
            body=_safe_body(resp),
        )

    if resp.status_code == 204 or not resp.content:
        return {}
    return resp.json()


def _stub_response(method: str, path: str, json_body: dict | None) -> Any:
    """Deterministic fake responses for stub mode. No network call.

    Shapes mirror the real Zoom response schemas closely enough to exercise
    caller control flow (E21 plan sec 7 / this module's docstring) -- these
    are NOT a substitute for testing against real Zoom once credentials
    exist.
    """
    logger.info("zoom_stub_call", method=method, path=path)

    if method == "POST" and path.endswith("/meetings"):
        stub_id = str(uuid4().int)[:10]
        return {
            "id": int(stub_id),
            "uuid": str(uuid4()),
            "host_id": "stub-host-id",
            "join_url": f"https://zoom.us/j/{stub_id}?pwd=stub",
            "start_url": f"https://zoom.us/s/{stub_id}?pwd=stub",
        }
    if method == "PATCH" and "/meetings/" in path:
        return {}
    if method == "DELETE" and "/meetings/" in path:
        return {}
    if method == "POST" and path.endswith("/registrants"):
        stub_id = str(uuid4())
        return {
            "registrant_id": stub_id,
            "id": stub_id,
            "topic": "stub",
            "join_url": f"https://zoom.us/w/stub?tk={stub_id}",
        }
    if method == "GET" and path.endswith("/registrants"):
        return {"registrants": []}
    if method == "PUT" and path.endswith("/registrants/status"):
        return {}
    if method == "GET" and "/report/meetings/" in path:
        return {"participants": []}
    # Must come AFTER both /registrants and /report/meetings/ GET checks
    # above -- both of those paths also contain "/meetings/" as a substring.
    if method == "GET" and "/meetings/" in path:
        stub_id = path.rsplit("/", 1)[-1]
        return {
            "id": int(stub_id) if stub_id.isdigit() else 0,
            "start_url": f"https://zoom.us/s/{stub_id}?pwd=stub&zak=stubzak",
        }

    raise ZoomAPIError(f"No stub response defined for {method} {path}")


# ---------------------------------------------------------------------------
# Meetings
# ---------------------------------------------------------------------------


async def create_meeting(
    *,
    topic: str,
    start_time_iso: str,
    duration_minutes: int,
    timezone: str,
) -> dict:
    """Create a scheduled Zoom meeting under the S2S-app's own user.

    Registration-specific settings (approval_type etc.) are configured
    here so the meeting is ready for registrants once that wiring lands in
    a later step -- no registrant is created by this call.
    """
    return await _request(
        "POST",
        "/users/me/meetings",
        json_body={
            "topic": topic,
            "type": 2,  # scheduled meeting
            "start_time": start_time_iso,
            "duration": duration_minutes,
            "timezone": timezone,
            "settings": {
                "approval_type": 0,  # automatic approval
                "registrants_email_notification": True,
                "join_before_host": False,
            },
        },
    )


async def patch_meeting(*, zoom_meeting_id: str, start_time_iso: str) -> None:
    """Update a meeting's start time (reschedule)."""
    await _request(
        "PATCH",
        f"/meetings/{zoom_meeting_id}",
        json_body={"start_time": start_time_iso},
    )


async def get_meeting(*, zoom_meeting_id: str) -> dict:
    """Fetch a meeting's current details from Zoom, including start_url.

    ПРОМТ №556 (OWNER-1, option В): this is the ONLY place start_url is ever
    read. create_meeting's response has one too, but that one is deliberately
    discarded (see this module's FAILURE SHAPE note + zoom/service.py) so the
    credential is fetched fresh, on demand, and never stored -- callers must
    not persist or log the field this returns.
    """
    return await _request("GET", f"/meetings/{zoom_meeting_id}")


async def delete_meeting(*, zoom_meeting_id: str) -> None:
    """Delete a meeting."""
    await _request("DELETE", f"/meetings/{zoom_meeting_id}")


# ---------------------------------------------------------------------------
# Registrants
# ---------------------------------------------------------------------------


async def create_registrant(
    *,
    zoom_meeting_id: str,
    email: str,
    first_name: str,
    last_name: str,
) -> dict:
    """Register one person on a meeting. Returns Zoom's response, which
    should contain registrant_id and join_url (join_url is sometimes
    omitted -- see ZoomRegistrant.join_url docstring)."""
    return await _request(
        "POST",
        f"/meetings/{zoom_meeting_id}/registrants",
        json_body={"email": email, "first_name": first_name, "last_name": last_name},
    )


async def list_registrants(*, zoom_meeting_id: str) -> list[dict]:
    """List all registrants on a meeting (any status Zoom returns)."""
    data = await _request("GET", f"/meetings/{zoom_meeting_id}/registrants")
    return data.get("registrants", [])


async def update_registrant_status(
    *,
    zoom_meeting_id: str,
    zoom_registrant_id: str,
    email: str,
    action: str,
) -> None:
    """Approve / cancel / deny a registrant. action must be one of Zoom's
    enum values: 'approve' | 'cancel' | 'deny'."""
    await _request(
        "PUT",
        f"/meetings/{zoom_meeting_id}/registrants/status",
        json_body={
            "action": action,
            "registrants": [{"id": zoom_registrant_id, "email": email}],
        },
    )


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------


async def get_participants_report(
    *,
    zoom_meeting_id: str,
    include_registrant_id: bool,
) -> list[dict]:
    """Fetch the post-meeting participants report.

    include_registrant_id toggles include_fields=registrant_id -- E21
    research could not confirm whether that parameter changes anything;
    the caller (attendance-decision step, not this one) calls both ways
    and reconciles.
    """
    params: dict = {"page_size": 300}
    if include_registrant_id:
        params["include_fields"] = "registrant_id"
    data = await _request(
        "GET",
        f"/report/meetings/{zoom_meeting_id}/participants",
        params=params,
    )
    return data.get("participants", [])
