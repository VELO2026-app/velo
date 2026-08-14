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
#   - comms 4xx (422 bad cursor, 404 unsynced recipient, ...) ->
#     forwarded as-is: the status is part of the frozen 3b contract
#     and the frontend is entitled to see it;
#   - comms 5xx -> 502 (an upstream fault is a gateway fault here).
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
# 4xx (same shape as _FORWARDABLE_4XX) instead of the infra-fault
# mapping -- default False, so every existing call site (chats,
# notifications, the rest of support) is byte-for-byte unchanged.
# =============================================================================

from typing import Any

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

# The only comms 4xx statuses meaningful to the end client and modeled
# by the frozen 3b contract; everything else (auth, teapots, ...) is an
# upstream fault mapped to 502.
_FORWARDABLE_4XX = frozenset({400, 404, 409, 422})


async def comms_request(
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    json: dict[str, Any] | None = None,
    forward_403: bool = False,
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

    Returns:
        The response body parsed as JSON.

    Raises:
        HTTPException: 502 (comms unreachable / upstream 5xx), 504
            (timeout), or the comms 4xx status forwarded verbatim
            (403 included only when forward_403=True).
    """
    base_url = settings.comms_api_url.rstrip("/")
    if not base_url:
        # Local dev has no comms stack; the proxy degrades loudly
        # instead of crashing at import time.
        logger.warning("comms_api_url_not_configured", path=path)
        raise _UNAVAILABLE

    url = f"{base_url}{path}"
    headers = {"Authorization": f"Bearer {settings.comms_service_token}"}
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

    # 401 from comms always means OUR service token is wrong/expired --
    # an infra fault, never the end user's. Forwarding it verbatim is a
    # foot-gun: the product frontend treats ANY 401 as "this user's
    # session expired" (api/client.ts) and logs them out, so one
    # misconfigured COMMS_SERVICE_TOKEN would log out every user who
    # opens the bell. Map to 502 (upstream unavailable) and never leak
    # the internal service's auth detail.
    if response.status_code == 401:
        logger.error("comms_auth_error", path=path, status=401)
        raise _UNAVAILABLE

    # 403 is the SAME infra-fault story UNLESS the caller opted in
    # (forward_403) -- see the module header for why comms' write-authz
    # 403 is a genuine business response on the one call site that
    # needs it.
    if response.status_code == 403 and not forward_403:
        logger.error("comms_auth_error", path=path, status=403)
        raise _UNAVAILABLE

    if response.status_code >= 400:
        # Only the client-meaningful statuses of the frozen 3b contract
        # are forwarded verbatim: 400 (bad request), 404 (unsynced
        # recipient / missing delivery), 409, 422 (malformed cursor,
        # unknown category) -- plus 403 on the one call site that opted
        # in above. Anything else the boundary does not model is an
        # upstream fault -> 502, not a leaked passthrough.
        forwardable = _FORWARDABLE_4XX | ({403} if forward_403 else set())
        if response.status_code not in forwardable:
            logger.warning(
                "comms_unexpected_4xx",
                path=path,
                status=response.status_code,
            )
            raise _UNAVAILABLE
        detail: Any = "Notification service rejected the request"
        try:
            body = response.json()
            if isinstance(body, dict) and "detail" in body:
                detail = body["detail"]
        except ValueError:
            pass
        raise HTTPException(
            status_code=response.status_code, detail=detail,
        )

    try:
        return response.json()
    except ValueError as exc:
        logger.warning("comms_response_not_json", path=path)
        raise _UNAVAILABLE from exc
