# =============================================================================
# VELO Backend -- ASGI Middleware
# =============================================================================
#
# Pure ASGI middleware -- no BaseHTTPMiddleware wrapper. This guarantees
# that structlog contextvars work reliably without TaskGroup isolation
# issues that BaseHTTPMiddleware can introduce.
#
# TRACE ID (Pre-6.1):
#   Every HTTP request gets a trace_id:
#     - From X-Trace-ID header (if provided by client/load balancer)
#     - Or auto-generated uuid4
#   The trace_id is:
#     1. Bound to structlog contextvars -> appears in every log line
#     2. Returned in X-Trace-ID response header -> client can correlate
#   In Phase 6 (Payments), trace_id will link AuditLog entries to
#   application logs for financial operation tracing.
#
# SECURITY (SEC-01):
#   Client-provided trace_id is validated against a safe character set
#   (alphanumeric + dots, hyphens, underscores). This prevents log
#   injection, header injection, and JSONB pollution via crafted
#   X-Trace-ID values that end up in AuditLog.trace_id (String(36)).
# =============================================================================

import ipaddress
import re
from uuid import uuid4

import structlog
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Receive, Scope, Send

# SEC-01: Safe character set for client-provided trace IDs.
# Allows UUIDs (hex + hyphens), custom IDs like "my-custom-trace-42",
# and dotted formats like "svc.req.123". Rejects spaces, newlines,
# unicode, quotes, slashes, and other injection vectors.
_TRACE_ID_RE = re.compile(r"^[a-zA-Z0-9._-]+$")

# T-47: hard cap applied to X-Forwarded-For BEFORE it is parsed or split.
# Roomy enough for a real proxy chain, small enough that nothing large ever
# reaches the parsing below. The value that survives all the checks lands in
# AuditLog.ip_address, which is String(45) -- an IPv6 address with a scope
# suffix is the widest thing that legitimately fits. See _extract_client_ip
# for why the cap comes first and what it protects.
_MAX_FORWARDED_LEN = 256


class TraceIdMiddleware:
    """Attach a trace_id to every HTTP request.

    Pure ASGI implementation -- operates directly on scope/receive/send
    without intermediate abstractions.

    Non-HTTP scopes (lifespan, websocket) are passed through unchanged.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Extract request context from ASGI scope headers.
        # Guard: AuditLog.trace_id is String(36). If client sends
        # a longer value, discard it and generate a fresh uuid4
        # to prevent DataError in financial transactions (Phase 6+).
        #
        # SEC-01: additionally validate character set to prevent
        # log injection and JSONB pollution via crafted trace IDs.
        raw_trace = _extract_header(scope, b"x-trace-id") or ""
        if (
            0 < len(raw_trace) <= 36
            and _TRACE_ID_RE.match(raw_trace)
        ):
            trace_id = raw_trace
        else:
            trace_id = str(uuid4())

        ip_address = _extract_client_ip(scope)
        user_agent = _extract_header(scope, b"user-agent")

        # Bind to structlog contextvars -- every log call in this
        # request will include trace_id automatically via
        # merge_contextvars processor. ip_address and user_agent
        # are consumed by record_audit() (Pre-6.2).
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(
            trace_id=trace_id,
            ip_address=ip_address,
            user_agent=user_agent,
        )

        async def send_with_trace_id(message: dict) -> None:
            """Inject X-Trace-ID into response headers."""
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers.append("X-Trace-ID", trace_id)
            await send(message)

        await self.app(scope, receive, send_with_trace_id)


def _extract_header(scope: Scope, name: bytes) -> str | None:
    """Read a single header value from ASGI scope.

    ASGI headers are list of (name, value) byte-tuples.
    Returns None if header is missing or empty.
    """
    for header_name, header_value in scope.get("headers", []):
        if header_name == name:
            decoded = header_value.decode("latin-1")
            return decoded if decoded else None
    return None


def _extract_client_ip(scope: Scope) -> str | None:
    """Extract the client IP address for the audit trail.

    X-Forwarded-For is accepted ONLY when this request physically arrived
    from our own reverse proxy, and only when the value is a real address.
    Otherwise the ASGI peer address is used.

    T-47, three separate problems this closes:

    1. AVAILABILITY, and this is the sharp one. AuditLog.ip_address is
       String(45) (core/audit.py) and record_audit() writes into the
       CALLER's session with the commit deferred (P-01), so an over-long
       value did not merely spoil one audit row -- it raised on flush and
       rolled back the whole operation, financial ones included. A client
       header could abort somebody else's transaction. The length cap below
       therefore runs FIRST, before parsing, before any other check, and is
       the reason a bad header now costs a clean rejection instead of a 500.
       (The neighbours already did this: user_agent is truncated in
       record_audit, trace_id is validated above. ip_address was the one
       that was not.)

    2. INTEGRITY. Nginx sets this header, but the application could not tell
       its own proxy's header from one a client typed. The audit log is kept
       for five years and produced as evidence; rows with an attacker-chosen
       IP devalue all of it, including the honest rows, because nothing
       distinguishes them afterwards.

    3. FORM. A value that is not an address at all (log-injection payloads,
       JSONB-poisoning attempts) has no business in this column.

    WHAT "TRUSTED" MEANS HERE, and why it needs no new setting. The app
    always sits behind nginx on the same host (docker network), so the TCP
    peer of a proxied request is a private/loopback address. If the peer is
    public, the request did not come through our proxy -- and in that case
    scope["client"] IS the real client address, so no header is needed. The
    test is therefore exact in both directions, and it reads the deployment
    rather than a config key that could drift from it.
    """
    client = scope.get("client")
    peer = client[0] if client else None

    forwarded = _extract_header(scope, b"x-forwarded-for")
    if forwarded and _peer_is_trusted(peer):
        # Cap BEFORE anything else -- see (1) above. The cap is generous
        # enough for a full XFF chain; the candidate taken out of it is
        # validated on its own terms right after.
        candidate = forwarded[:_MAX_FORWARDED_LEN].split(",")[0].strip()
        if _is_ip_address(candidate):
            return candidate
        # Malformed or over-long -> fall through to the peer rather than
        # store something that is not an address.

    return peer


def _peer_is_trusted(peer: str | None) -> bool:
    """True when the request reached us from our own reverse proxy.

    Loopback and private ranges only -- see the note in _extract_client_ip
    for why this is the right test for this deployment and why it is not a
    configuration value.
    """
    if not peer:
        return False
    try:
        addr = ipaddress.ip_address(peer)
    except ValueError:
        # Unix socket peers and anything unparseable: not a proxy we know.
        return False
    # NOTE on what is_private actually covers, checked rather than assumed
    # (CPython 3.12): it is WIDER than RFC1918 -- link-local and the
    # documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24)
    # report True as well. That is harmless here, because a real TCP peer is
    # either our proxy on the docker network or a genuinely routable client,
    # and neither is a documentation address. It is written down because the
    # name suggests a narrower set than it has, and a future reader comparing
    # this to an RFC1918 list would otherwise think it a bug.
    return addr.is_loopback or addr.is_private


def _is_ip_address(value: str) -> bool:
    """True when the value parses as an IPv4 or IPv6 address.

    ipaddress, not a regex, deliberately: a hand-written IPv6 pattern is a
    reliable source of its own defects, and this is a security fix -- it may
    not introduce one. This also bounds the length implicitly (no valid
    address approaches String(45)), but the explicit cap above stays: it is
    what protects the transaction, and it must not depend on this function
    being reached at all.
    """
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return True
