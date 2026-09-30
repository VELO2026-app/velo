# =============================================================================
# VELO Backend -- Comms HTTP client (Phase 6 / T1, item 3)
# =============================================================================
#
# The read path of integration design ID-9: velo's proxy routers call
# the INTERNAL comms HTTP API (arch decision 14: the frontend never
# talks to comms; DD-5: comms has no public port) over the
# aivis-shared docker network, authenticating as the PRODUCT with the
# shared service token ("Authorization: Bearer <token>", comms
# app/api/deps.py).
#
# TRUST MODEL (frozen with the 3b contract): comms trusts every
# recipient_id this client sends -- the caller (proxy router) is the
# sole owner of the "user X may only touch user X's data" check and
# MUST derive recipient_id from the authenticated velo session, never
# from client input.
#
# FAILURE MODEL (T1 handoff constraint "comms down must not take velo
# down"):
#   - COMMS_API_URL empty / connection refused / DNS -> 502 Bad
#     Gateway ("comms unavailable");
#   - request timeout (COMMS_HTTP_TIMEOUT_SECONDS)  -> 504 Gateway
#     Timeout;
#   - comms 4xx -> decided by the refusal's CLASS, not its text (comms
#     3.0.0 refuses with ONE body, {"error": {"class", "message",
#     "fields"?}}, app/api/errors.py): validation / not_found / conflict
#     are forwarded with their status and comms' message as `detail`;
#     every other class, a class that disagrees with the status, or a
#     body without `error` is a 502 (see _refusal);
#   - comms 5xx -> 502 (an upstream fault is a gateway fault here).
#
# IDEMPOTENCY (comms 3.0.0): the two calls that create --
# POST /api/v1/threads and POST /api/v1/threads/{id}/messages -- REQUIRE
# an `Idempotency-Key` header; without it comms refuses with 422. The
# caller passes `idempotency_key`; new_request_key and message_key below
# are the two ways a caller gets one.
# The token never appears in logs or error bodies.
#
# 403 is special-cased twice over (PROMPT №713, support write-authz):
# every OTHER call site's 403 means OUR service token broke, an infra
# fault -- mapped to 502 so a misconfigured COMMS_SERVICE_TOKEN cannot
# masquerade as "this user's session expired" and log people out
# (api/client.ts treats any 401 that way). But comms' write-authz on a
# SECTION thread (can_post_message, messaging/operators.py) returns a
# GENUINE, per-request, business-meaningful 403 -- "you have not
# claimed this thread" -- documented as such in comms'
# AuthorizationError (mapped to HTTP 403 by their API error handler,
# core/exceptions.py). Swallowing that into a generic 502 would hide
# exactly the state support/router.py needs to surface. `forward_403`
# opts a SPECIFIC call site into treating 403 as a real, forwardable
# refusal (class `forbidden`) instead of the infra-fault
# mapping -- default False, so every existing call site (chats,
# notifications, the rest of support) is byte-for-byte unchanged.
# =============================================================================

import hashlib
from typing import Any
from uuid import UUID, uuid4

import httpx
import structlog
from fastapi import HTTPException

from app.core.config import settings

logger = structlog.get_logger()

_UNAVAILABLE = HTTPException(
    status_code=502, detail="Notification service is unavailable",
)
_TIMEOUT = HTTPException(
    status_code=504, detail="Notification service timed out",
)

# comms 3.0.0's refusal classes and the status each one travels with
# (app/api/errors.py ErrorClass / _HTTP_CLASSES, conflict_class). The
# status is CHECKED against the class, never used instead of it.
_CLASS_STATUS: dict[str, int] = {
    "validation": 422,
    "unauthorized": 401,
    "forbidden": 403,
    "not_found": 404,
    "method_not_allowed": 405,
    "conflict": 409,
    "stale_snapshot": 409,
    "recipient_deleted": 409,
    "internal": 500,
}

# The classes that mean something to the end client on a resource call.
# `unauthorized` and (by default) `forbidden` are OUR service token --
# see the module header. `stale_snapshot` / `recipient_deleted` belong to
# the sync events, not to these calls, and `method_not_allowed` is our
# own wiring: all of them end as a logged 502 rather than a branch each.
_FORWARDABLE_CLASSES = frozenset({"validation", "not_found", "conflict"})

# comms bounds an Idempotency-Key to 1..200 characters.
IDEMPOTENCY_KEY_MAX = 200
IDEMPOTENCY_HEADER = "Idempotency-Key"


def new_request_key(kind: str) -> str:
    """A fresh key for ONE request -- the key of a call whose identity is
    the request itself (opening a thread: see chats/router.py
    _create_or_get_thread for why a thread must never get a stable key).
    """
    return f"{kind}:{uuid4().hex}"


def message_key(sender_id: UUID, client_key: str | None) -> str:
    """The Idempotency-Key of one message send.

    The intent to send lives in the CLIENT: only it knows that a second
    tap is the same message and not a second "ok". So a client key, when
    sent, is the message's identity -- the same key twice is one message
    and one ping. Without one (today's frontend sends none) each request
    gets its own key: the call is valid again, and a resend is a second
    message, as it was before comms 3.0.0.

    HASHED, NOT TRUNCATED OR APPENDED RAW. The key index in comms is
    global, so the sender goes in (one person's key must never meet
    another's). `msg:<uuid>:` alone takes 41 of comms' 200 characters,
    which would leave the client an unexplainable limit of 159 -- and
    truncating to fit instead would make two different long keys that
    share a prefix into ONE key, merging two messages silently. A digest
    keeps every property the key exists for -- equal in, equal out;
    different in, different out; different senders never equal -- at a
    fixed 105 characters for any client key.

    Raises:
        HTTPException: 422 for a client key comms would refuse (blank,
            or longer than 200) -- named here, before the call, so the
            culprit is the request and not an echo from another service.
    """
    if client_key is None:
        return new_request_key("msg")
    if not client_key.strip() or len(client_key) > IDEMPOTENCY_KEY_MAX:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{IDEMPOTENCY_HEADER} must be 1..{IDEMPOTENCY_KEY_MAX} "
                "non-blank characters"
            ),
        )
    digest = hashlib.sha256(client_key.encode("utf-8")).hexdigest()
    return f"msg:{sender_id}:{digest}"


def _refusal(
    response: httpx.Response, *, path: str, forward_403: bool,
) -> HTTPException:
    """A comms 4xx as velo's answer, decided by the refusal's CLASS.

    Text is never parsed: messages may change without notice, the class is
    the contract. A body without the envelope, an unknown class or a class
    that disagrees with the status is a 502 -- the refusal is not one we
    can read, and forwarding a guess is how a wrong status reaches a user.
    The log carries the status and the class, never the message.
    """
    error: Any = None
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        error = body.get("error")
    error_class = error.get("class") if isinstance(error, dict) else None
    message = error.get("message") if isinstance(error, dict) else None
    status = response.status_code

    if not isinstance(error_class, str) or _CLASS_STATUS.get(error_class) != status:
        logger.error(
            "comms_refusal_shape_unexpected",
            path=path,
            status=status,
            error_class=error_class if isinstance(error_class, str) else None,
            body_type=type(body).__name__,
        )
        return _UNAVAILABLE
    if error_class == "unauthorized" or (
        error_class == "forbidden" and not forward_403
    ):
        logger.error("comms_auth_error", path=path, status=status)
        return _UNAVAILABLE
    if error_class in _FORWARDABLE_CLASSES or error_class == "forbidden":
        return HTTPException(
            status_code=status,
            detail=(
                message
                if isinstance(message, str) and message
                else "Notification service rejected the request"
            ),
        )
    logger.warning(
        "comms_unexpected_refusal", path=path, status=status,
        error_class=error_class,
    )
    return _UNAVAILABLE


async def comms_request(
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    json: dict[str, Any] | None = None,
    forward_403: bool = False,
    idempotency_key: str | None = None,
) -> Any:
    """One request to the internal comms API; returns the parsed JSON body.

    Args:
        method: HTTP method ("GET", "POST", "PATCH").
        path: API path starting with "/" (e.g.
            "/api/v1/recipients/{id}/inbox").
        params: Optional query parameters.
        json: Optional JSON body.
        forward_403: When True, a comms 403 is treated as a genuine,
            forwardable business response (comms' AuthorizationError,
            e.g. "actor is not the serving operator of this thread")
            instead of the default infra-fault mapping to 502. See the
            module header. False everywhere except the one call site
            that needs it.
        idempotency_key: Sent as the Idempotency-Key header; required
            by comms on the two calls that create (module header).

    Returns:
        The response body parsed as JSON.

    Raises:
        HTTPException: 502 (comms unreachable / upstream 5xx / a refusal
            we cannot read), 504 (timeout), or 422 / 404 / 409 (and 403
            only when forward_403=True) with comms' message as detail.
    """
    base_url = settings.comms_api_url.rstrip("/")
    if not base_url:
        # Local dev has no comms stack; the proxy degrades loudly
        # instead of crashing at import time.
        logger.warning("comms_api_url_not_configured", path=path)
        raise _UNAVAILABLE

    url = f"{base_url}{path}"
    headers = {"Authorization": f"Bearer {settings.comms_service_token}"}
    if idempotency_key is not None:
        headers[IDEMPOTENCY_HEADER] = idempotency_key
    timeout = httpx.Timeout(settings.comms_http_timeout_seconds)

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.request(
                method, url, params=params, json=json, headers=headers,
            )
    except httpx.TimeoutException as exc:
        logger.warning("comms_request_timeout", path=path, error=str(exc))
        raise _TIMEOUT from exc
    except httpx.HTTPError as exc:
        # ConnectError, network errors, protocol errors -- the pipe is
        # down, not the request.
        logger.warning("comms_request_failed", path=path, error=str(exc))
        raise _UNAVAILABLE from exc

    if response.status_code >= 500:
        logger.warning(
            "comms_upstream_error",
            path=path,
            status=response.status_code,
        )
        raise _UNAVAILABLE

    # 4xx: read by class (_refusal). 401 there is always OUR service
    # token -- an infra fault, never the end user's: the frontend treats
    # ANY 401 as "this user's session expired" (api/client.ts) and logs
    # them out, so it must never be forwarded. 403 is the same story
    # unless the caller opted in (forward_403, module header).
    if response.status_code >= 400:
        raise _refusal(response, path=path, forward_403=forward_403)

    try:
        return response.json()
    except ValueError as exc:
        logger.warning("comms_response_not_json", path=path)
        raise _UNAVAILABLE from exc


def read_comms_page(payload: Any, *, path: str) -> tuple[list[Any], str | None]:
    """The rows and the cursor of a comms list response -- or a refusal.

    comms 3.0.0 has ONE listing shape (its app/api/paging.py):
    `{"items": [...], "next_cursor": "<opaque>" | null}`. A caller that
    filters a list for privacy reads it through here and nowhere else.

    AN UNKNOWN SHAPE CLOSES THE DOOR. Both privacy filters over comms lists
    used to look for a key, find nothing and `return` -- and the whole
    unfiltered page went out: the unclaimed support queue to every master,
    every thread on the installation to the admin support list. The shape
    had changed twice by then (`threads` -> `items`). So anything but the
    exact shape -- not a mapping, `items` absent or not a list,
    `next_cursor` absent or neither a string nor null -- is treated as the
    list being unavailable: 502, the same answer as comms being down. No
    fallback list: an empty list would hide the next change of shape.

    THE LOG CARRIES THE SHAPE, NEVER THE CONTENT: the payload type and its
    sorted top-level keys. The rows hold client uuids and the text of
    support requests; logging them would move the leak from the response
    into the logs.

    Args:
        payload: The parsed body comms_request returned.
        path: The comms path it came from, for the log.

    Returns:
        (items, next_cursor) exactly as comms sent them. The rows are NOT
        inspected here -- deciding which rows a caller may return is the
        caller's filter.

    Raises:
        HTTPException: 502 on any other shape.
    """
    if isinstance(payload, dict) and "next_cursor" in payload:
        items = payload.get("items")
        cursor = payload["next_cursor"]
        if isinstance(items, list) and (cursor is None or isinstance(cursor, str)):
            return items, cursor
    logger.error(
        "comms_list_shape_unexpected",
        path=path,
        payload_type=type(payload).__name__,
        keys=(
            sorted(str(key) for key in payload)
            if isinstance(payload, dict)
            else None
        ),
    )
    raise _UNAVAILABLE


def read_comms_counter(payload: Any, key: str, *, path: str) -> int:
    """A non-negative integer count riding next to a comms page -- or a
    refusal, by the same rule as read_comms_page: an unknown shape is the
    answer being unavailable (502), logged as its shape, never its content.

    `bool` is refused although it is an `int` in Python: `true` is not a
    count, and forwarding it would put `1` on a badge that means nothing.
    """
    if isinstance(payload, dict):
        value = payload.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
    logger.error(
        "comms_list_shape_unexpected",
        path=path,
        payload_type=type(payload).__name__,
        keys=(
            sorted(str(k) for k in payload)
            if isinstance(payload, dict)
            else None
        ),
    )
    raise _UNAVAILABLE
