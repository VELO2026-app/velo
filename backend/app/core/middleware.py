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

# T-47 / BE-40: hard cap applied to X-Real-IP BEFORE it is parsed. Equal to
# the width of AuditLog.ip_address (String(45)) on purpose, and tied to it by
# a test: a longer value is REJECTED, never truncated (truncating a valid
# address can yield a different valid address). The cap is not redundant
# with the address check -- ipaddress accepts an IPv6 scope id of any length
# ("fe80::1%" + 100 characters parses), so validity alone does not bound the
# width. See _extract_client_ip for what this protects.
_MAX_CLIENT_IP_LEN = 45


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
    """Extract the client IP address for the audit trail and the limiters.

    The address is X-Real-IP, accepted ONLY when this request physically
    arrived from our own reverse proxy, and only when the value is a real
    address that fits the audit column. Otherwise the ASGI peer address is
    used. X-Forwarded-For is not read at all.

    WHY X-REAL-IP AND NOT X-FORWARDED-FOR (BE-40). Nginx sets both
    (scripts/nginx-render.sh), but not in the same way. X-Forwarded-For is
    $proxy_add_x_forwarded_for: nginx APPENDS the real address to whatever
    the client sent, so the first hop is written by the sender and the
    header as a whole is client-controlled. X-Real-IP is $remote_addr:
    nginx REPLACES any client-sent X-Real-IP with the address of the TCP
    connection it accepted (checked live on nginx 1.24: a single, a
    duplicated and a lower-case client header all arrive as one header
    carrying the connection address). Before BE-40 the first XFF hop was
    taken, so any sender chose the address in the five-year audit trail
    and the key of every per-source limit -- a private address in the
    header switched the pre-HMAC login limit off, random public ones gave
    an unbounded number of fresh buckets.

    T-47, three separate problems the checks below close:

    1. AVAILABILITY, and this is the sharp one. AuditLog.ip_address is
       String(45) (core/audit.py) and record_audit() writes into the
       CALLER's session with the commit deferred (P-01), so an over-long
       value did not merely spoil one audit row -- it raised on flush and
       rolled back the whole operation, financial ones included. The length
       cap therefore runs FIRST, before parsing, and rejects rather than
       truncates. It is the column width, not a looser bound: a valid IPv6
       address with a long scope id is still an address (see
       _MAX_CLIENT_IP_LEN).

    2. INTEGRITY. The audit log is kept for five years and produced as
       evidence; rows with a sender-chosen IP devalue all of it, including
       the honest rows, because nothing distinguishes them afterwards. Only
       a header our own proxy overwrites can carry the address, and only
       from our own proxy.

    3. FORM. A value that is not an address at all (log-injection payloads,
       JSONB-poisoning attempts) has no business in this column.

    WHEN X-REAL-IP IS MISSING OR UNUSABLE from a trusted peer, the peer
    address is used. It is our own infrastructure (private/loopback), so
    every per-source limit passes it unlimited -- the degradation to OFF
    that core/ratelimit.py names and chooses over a shared bucket.

    WHAT "TRUSTED" MEANS HERE, and why it needs no new setting. The app
    always sits behind nginx on the same host (docker network), so the TCP
    peer of a proxied request is a private/loopback address. If the peer is
    public, the request did not come through our proxy -- and in that case
    scope["client"] IS the real client address, so no header is needed. The
    test is therefore exact in both directions, and it reads the deployment
    rather than a config key that could drift from it. scope["client"] is
    the TCP peer as the OS reported it because uvicorn runs with
    --no-proxy-headers (backend/Dockerfile): its own X-Forwarded-For
    handling would otherwise rewrite the peer from the header, unvalidated,
    whenever FORWARDED_ALLOW_IPS trusted the connecting address.

    A PROXY IN FRONT OF NGINX (Cloudflare, a CDN, a load balancer) is
    configured in NGINX, not here, and this function does not change. Today
    there is none. When one appears, nginx's real_ip module puts the true
    client address into $remote_addr, and therefore into X-Real-IP:

        set_real_ip_from <the proxy's published ranges>;   # one per range
        real_ip_header   <the header that proxy sets>;     # e.g. CF-Connecting-IP
        real_ip_recursive on;                              # if it chains

    set_real_ip_from must list ONLY that proxy's ranges: a range that also
    covers ordinary clients lets them write their own address again. The
    line `proxy_set_header X-Real-IP $remote_addr;` stays exactly as it is.
    This is the owner's decision (BE-40, 2026-10-01), not a deferred gap:
    the application trusts exactly one hop, its own nginx, and nginx is
    the one place that knows what stands in front of it. Reading
    X-Forwarded-For here -- first hop, last hop or N-th from the right --
    is the rejected alternative: it would make the application a second
    place that has to know the proxy chain. scripts/nginx-render.sh points
    back here.
    """
    client = scope.get("client")
    peer = client[0] if client else None

    if _peer_is_trusted(peer):
        real_ip = _extract_header(scope, b"x-real-ip")
        # Cap BEFORE anything else -- see (1) above. Over the cap is
        # rejected, not shortened; under it the value must still be an
        # address. Missing, empty, over-long or malformed -> the peer.
        if (
            real_ip
            and len(real_ip) <= _MAX_CLIENT_IP_LEN
            and _is_ip_address(real_ip)
        ):
            return real_ip

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
    not introduce one. It does NOT bound the length: an IPv6 scope id may be
    arbitrarily long and still parse ("fe80::1%" + 100 characters does).
    The cap in _extract_client_ip is what protects the transaction, and it
    runs before this function is reached.
    """
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return True
