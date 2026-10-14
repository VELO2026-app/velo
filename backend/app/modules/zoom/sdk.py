# =============================================================================
# VELO Backend -- Zoom inside the app: Meeting SDK join parameters (Standalone F4)
# =============================================================================
#
# The practice screen mounts Zoom's Meeting SDK (client view) instead of
# sending anybody out to a Zoom link. Who may enter, and as what, is still
# decided by ONE ladder -- zoom/service.py's resolve_zoom_entry. This module
# only turns its two entering answers into what the SDK's join() needs:
#
#   PERSONAL -> role 0: meeting number, passcode, the registrant's token
#               (`tk`, so Zoom attributes the session to the registrant and
#               attendance keeps matching by registrant_id) with the email it
#               was registered under, display name.
#   HOST     -> role 1: meeting number, passcode, the host's ZAK.
#
# Every other kind is refused here (409 zoom_entry_not_joinable) -- GUEST
# included: inside the app "not booked" means "book first" (owner decision
# 12), never a guest entry.
#
# WHAT IS FETCHED, WHEN. Nothing Zoom-side is stored for this. The passcode
# and the host id come from GET /meetings/{id} at the moment of entering, the
# ZAK from GET /users/{host_id}/token. That is also why meetings created
# before this module existed need nothing done to them.
#
# THE SIGNATURE. Meeting SDK JWT, HS256 over the General App's Client Secret
# (settings.zoom_sdk_client_secret), built with the standard library: three
# short functions, and no dependency the project does not declare.
# Lifetime: Zoom requires exp at least 1800 s past iat and accepts up to 48 h;
# this uses the minimum, so a leaked signature is worth half an hour.
#
# WHAT NEVER LEAVES THE SERVER / NEVER REACHES A LOG: the Client Secret; the
# raw GET /meetings and token responses. The passcode, the token and the ZAK
# leave only in the response body of the one person they belong to, and no
# log line here carries any of them (failures log the practice and the status
# code only).
# =============================================================================

import base64
import enum
import hashlib
import hmac
import json
import time
from dataclasses import dataclass

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import ConflictError, TooManyRequestsError, VeloError
from app.core.ratelimit import count_in_window
from app.core.redis import get_redis
from app.modules.practices.models import Practice
from app.modules.users.models import User
from app.modules.zoom.models import (
    ZoomMeeting,
    ZoomMeetingStatus,
    ZoomRegistrantRole,
)
from app.modules.zoom.service import (
    ZoomEntryKind,
    meeting_display_name,
    resolve_zoom_entry,
)
from app.modules.zoom.zoom_client import ZoomAPIError, get_meeting, get_user_zak

logger = structlog.get_logger()

# Zoom: exp must be at least 1800 s after iat (and at most 48 h). iat is set
# a little in the past so a client clock running behind ours does not see a
# token issued "in the future"; exp counts from now, so exp - iat is
# SIGNATURE_LIFETIME_SECONDS + SIGNATURE_IAT_SKEW_SECONDS = 1830.
SIGNATURE_LIFETIME_SECONDS = 1800
SIGNATURE_IAT_SKEW_SECONDS = 30

# The ZAK is read by the SDK once, at join(), right after this endpoint
# answers; nothing needs it later. Zoom documents the ttl parameter (seconds,
# default 7200) but no minimum -- 300 covers a slow phone loading the SDK.
ZAK_TTL_SECONDS = 300

_JWT_HEADER = {"alg": "HS256", "typ": "JWT"}


class SdkRole(enum.IntEnum):
    """The Meeting SDK's `role` claim: 0 joins, 1 starts as host."""

    ATTENDEE = 0
    HOST = 1


def _b64url(raw: bytes) -> str:
    """base64url without padding -- the JWS encoding (RFC 7515 sec 2)."""
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def hs256_sign(signing_input: bytes, key: bytes) -> str:
    """The JWS HS256 signature of `signing_input`, base64url-encoded.

    Factored out so it can be checked against RFC 7515 Appendix A.1 byte for
    byte: that vector's header and payload are not JSON this module would
    produce (they carry CRLFs), so only this layer can meet it exactly.
    """
    return _b64url(hmac.new(key, signing_input, hashlib.sha256).digest())


def build_sdk_signature(
    *,
    client_id: str,
    client_secret: str,
    meeting_number: str,
    role: SdkRole,
    now: int,
) -> str:
    """The Meeting SDK JWT for one entry into one meeting.

    Payload per Zoom's Meeting SDK auth docs: appKey (the General App's
    Client ID), mn, role, iat, exp, tokenExp (== exp). sdkKey carries the
    same Client ID -- the web SDK's older name for appKey, accepted next to
    it. Keys are arguments, not settings, so the signer is a pure function a
    test can drive with any key pair.
    """
    iat = now - SIGNATURE_IAT_SKEW_SECONDS
    exp = now + SIGNATURE_LIFETIME_SECONDS
    payload = {
        "appKey": client_id,
        "sdkKey": client_id,
        "mn": meeting_number,
        "role": int(role),
        "iat": iat,
        "exp": exp,
        "tokenExp": exp,
    }
    header_b64 = _b64url(json.dumps(_JWT_HEADER, separators=(",", ":")).encode())
    payload_b64 = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    signature = hs256_sign(signing_input, client_secret.encode("utf-8"))
    return f"{header_b64}.{payload_b64}.{signature}"


@dataclass(frozen=True)
class SdkJoin:
    """Everything ZoomMtg.join() needs for this person. tk and user_email
    are set for an attendee (role 0), zak for the host (role 1) -- never
    both kinds. user_email is the registrant's registration email: the
    SDK's join() asks for it on a meeting that requires registration (its
    own typings, 6.5.0), and it is the address Zoom already holds for him."""

    sdk_key: str
    signature: str
    meeting_number: str
    password: str
    user_name: str
    role: SdkRole
    tk: str | None
    user_email: str | None
    zak: str | None


async def check_sdk_join_rate_limit(user: User) -> None:
    """Per-user fixed window on sdk-join (core/ratelimit.count_in_window).

    Every call reaches Zoom, so a stuck button or a script costs a counter
    here before it costs Zoom API quota. Redis errors propagate: the limit
    fails CLOSED (500), the auth limiter's posture -- an entry that cannot be
    counted is not handed out uncounted.
    """
    count = await count_in_window(
        get_redis(),
        f"zoom_sdk_join_rate:{user.id}",
        settings.zoom_sdk_join_rate_limit_window_seconds,
    )
    if count > settings.zoom_sdk_join_rate_limit_max_requests:
        raise TooManyRequestsError(
            "Too many Zoom entry requests. Please try again later.",
        )


def _zoom_unavailable(
    practice: Practice, event: str, exc: ZoomAPIError,
) -> VeloError:
    """The 502 for "Zoom did not give us what entering needs". Logs the
    practice and Zoom's status code only -- never the response body, which
    can carry the very credentials this module hands out."""
    logger.warning(
        event,
        practice_id=str(practice.id),
        status_code=exc.status_code,
    )
    return VeloError(
        "Zoom did not answer the entry request",
        code="zoom_unavailable",
        status_code=502,
    )


async def build_sdk_join(
    practice: Practice,
    user: User,
    session: AsyncSession,
    *,
    now: int | None = None,
) -> SdkJoin:
    """SDK join parameters for THIS user entering THIS practice, right now.

    Order, each step a refusal of its own:
      1. the ladder (resolve_zoom_entry) -- anything but PERSONAL / HOST is
         409 zoom_entry_not_joinable, before any configuration question: a
         guest is "not joinable" whether or not this server has SDK keys.
      2. settings.is_zoom_sdk_configured -- else 409 zoom_sdk_not_configured.
      3. GET /meetings/{id} -- failure is 502 zoom_unavailable.
      4. HOST only: the host's ZAK -- failure, or no host id anywhere, is 502
         zoom_host_token_unavailable (typically the S2S app lacks the scope
         user:read:token:admin; the master's screen says he cannot start).

    The caller (the endpoint) has already passed the rate limit and checked
    the practice is publicly resolvable (404 otherwise).
    """
    resolution = await resolve_zoom_entry(practice, user, session)
    if resolution.kind not in (ZoomEntryKind.PERSONAL, ZoomEntryKind.HOST):
        raise ConflictError(
            f"No Zoom entry for this user right now ({resolution.kind.value})",
            code="zoom_entry_not_joinable",
        )
    if not settings.is_zoom_sdk_configured:
        raise ConflictError(
            "Zoom inside the app is not configured on this server",
            code="zoom_sdk_not_configured",
        )

    # The ladder answered PERSONAL/HOST, so an ACTIVE meeting exists (step 3
    # of the ladder runs before both) -- read it by the same condition.
    meeting = (
        await session.execute(
            select(ZoomMeeting).where(
                ZoomMeeting.practice_id == practice.id,
                ZoomMeeting.status == ZoomMeetingStatus.ACTIVE.value,
            )
        )
    ).scalar_one()

    try:
        details = await get_meeting(zoom_meeting_id=meeting.zoom_meeting_id)
    except ZoomAPIError as exc:
        raise _zoom_unavailable(
            practice, "zoom_sdk_meeting_fetch_failed", exc,
        ) from None

    # Zoom omits or empties the passcode of a meeting that has none; the SDK
    # takes "" for that.
    raw_password = details.get("password")
    password = raw_password if isinstance(raw_password, str) else ""

    tk: str | None = None
    user_email: str | None = None
    zak: str | None = None
    if resolution.kind == ZoomEntryKind.HOST:
        role = SdkRole.HOST
        zak = await _fetch_host_zak(practice, meeting, details)
        user_name = meeting_display_name(user, ZoomRegistrantRole.HOST.value)
    else:
        role = SdkRole.ATTENDEE
        tk = resolution.entry_token
        user_email = resolution.registration_email
        user_name = meeting_display_name(user, ZoomRegistrantRole.STUDENT.value)

    signature = build_sdk_signature(
        client_id=settings.zoom_sdk_client_id,
        client_secret=settings.zoom_sdk_client_secret,
        meeting_number=meeting.zoom_meeting_id,
        role=role,
        now=int(time.time()) if now is None else now,
    )
    logger.info(
        "zoom_sdk_join_issued",
        practice_id=str(practice.id),
        user_id=str(user.id),
        role=int(role),
    )
    return SdkJoin(
        sdk_key=settings.zoom_sdk_client_id,
        signature=signature,
        meeting_number=meeting.zoom_meeting_id,
        password=password,
        user_name=user_name,
        role=role,
        tk=tk,
        user_email=user_email,
        zak=zak,
    )


async def _fetch_host_zak(
    practice: Practice, meeting: ZoomMeeting, details: dict,
) -> str:
    """The meeting host's ZAK, fresh from Zoom.

    The host is whoever Zoom says hosts the meeting right now (`host_id` of
    the details just fetched); the id stored at creation is the fallback for
    a response without one. Neither -> 502, as is a token call that fails or
    answers without a token.
    """
    raw_host = details.get("host_id")
    host_id = (
        raw_host
        if isinstance(raw_host, str) and raw_host
        else meeting.host_zoom_user_id
    )
    if not host_id:
        logger.warning("zoom_sdk_host_id_missing", practice_id=str(practice.id))
        raise _host_token_unavailable()
    try:
        response = await get_user_zak(
            zoom_user_id=host_id, ttl_seconds=ZAK_TTL_SECONDS,
        )
    except ZoomAPIError as exc:
        logger.warning(
            "zoom_sdk_host_zak_failed",
            practice_id=str(practice.id),
            status_code=exc.status_code,
        )
        raise _host_token_unavailable() from None
    token = response.get("token")
    if not isinstance(token, str) or not token:
        logger.warning("zoom_sdk_host_zak_missing", practice_id=str(practice.id))
        raise _host_token_unavailable()
    return token


def _host_token_unavailable() -> VeloError:
    return VeloError(
        "Zoom did not give the host's start key",
        code="zoom_host_token_unavailable",
        status_code=502,
    )
