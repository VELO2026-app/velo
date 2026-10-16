# =============================================================================
# VELO -- Tests: Zoom inside the app, Meeting SDK join parameters (Standalone F4)
# =============================================================================
#
# telegram_id band: 60150-60199.
#
# BAND PROVENANCE. free_windows(space=(60000, 99999)) returned (60150, 64999)
# as its first window on 2026-10-15; 60200-64999 stays free.
#
# WHAT IS UNDER TEST
#
#   1. THE SIGNATURE (zoom/sdk.py). The HS256 layer against RFC 7515
#      Appendix A.1 byte for byte -- Zoom publishes no full vector with a
#      secret, so the primitive is checked against the RFC and the whole
#      token against an INDEPENDENT implementation (PyJWT): decoded with the
#      secret, its claims are Zoom's (appKey, sdkKey, mn, role, iat, exp,
#      tokenExp) and its life is the minimum Zoom accepts. Pair: the wrong
#      secret does not verify.
#   2. THE ENTRY TOKEN (zoom/service.py's entry_token_from_join_url): every
#      shape of a registrant join_url, including the repeated and the empty
#      `tk`.
#   3. THE ENDPOINT, POST /practices/{id}/zoom/sdk-join, over the gate's grid:
#      who (PERSONAL / HOST / everybody else) x keys (real / stub / absent) x
#      Zoom (answers / fails / answers without the field), plus 404, 401 and
#      the rate limit. Zoom is never called for real: the two Zoom functions
#      zoom/sdk.py imports are replaced in its namespace.
#   4. NOTHING SECRET LEAKS: the SDK secret is in no body and no log line;
#      the ZAK and the registrant token are in no log line; the response is
#      Cache-Control: no-store.
#   5. ONE PREDICATE, THREE READERS: a join_url WITHOUT a `tk` is no entry
#      for the booking list (zoom_registrant_ready, behind the M-3 gate with
#      a REAL token), for the resolver, and for the attendance verdict.
# =============================================================================

import base64
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import jwt
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from structlog.testing import capture_logs

from app.core.config import settings
from app.modules.bookings.models import Booking, BookingStatus
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.users.models import User, UserRole
from app.modules.zoom import attendance_service
from app.modules.zoom import sdk as zoom_sdk
from app.modules.zoom.attendance_service import ingest_report_for_meeting
from app.modules.zoom.models import (
    ZoomMeeting,
    ZoomMeetingStatus,
    ZoomRegistrant,
    ZoomRegistrantRole,
    ZoomRegistrantStatus,
)
from app.modules.zoom.service import (
    LINK_UNAVAILABLE_REGISTERED_WITHOUT_JOIN_URL,
    entry_token_from_join_url,
    link_unavailable_reason,
)
from app.modules.zoom.zoom_client import ZoomAPIError
from tests.helpers import auth_headers, full_cleanup_range, login_user

_TID_MIN = 60150
_TID_MAX = 60199

_SDK_ID = "sdk-client-id-test"
_SDK_SECRET = "sdk-client-secret-test-0123456789"
_LINK = "https://zoom.us/w/555000300?tk=tok-personal&pwd=encrypted"
_PASSWORD = "meeting-pass-42"
_ZAK = "zak-token-test-value"


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


@pytest.fixture
def real_zoom(monkeypatch: pytest.MonkeyPatch) -> dict:
    """Zoom as a configured server sees it -- S2S not the stub, SDK keys set
    -- with the two Zoom calls zoom/sdk.py makes replaced in ITS namespace.
    Returns the knobs a test turns: what GET /meetings answers, what the
    token call answers, and the calls made."""
    monkeypatch.setattr(settings, "zoom_account_id", "acct")
    monkeypatch.setattr(settings, "zoom_client_id", "s2s-id")
    monkeypatch.setattr(settings, "zoom_client_secret", "s2s-secret-not-test")
    monkeypatch.setattr(settings, "zoom_sdk_client_id", _SDK_ID)
    monkeypatch.setattr(settings, "zoom_sdk_client_secret", _SDK_SECRET)
    state: dict = {
        "details": {"host_id": "zoom-host-1", "password": _PASSWORD},
        "details_error": None,
        "zak": {"token": _ZAK},
        "zak_error": None,
        "meeting_calls": [],
        "zak_calls": [],
    }

    async def fake_get_meeting(*, zoom_meeting_id: str) -> dict:
        state["meeting_calls"].append(zoom_meeting_id)
        if state["details_error"] is not None:
            raise state["details_error"]
        return state["details"]

    async def fake_get_user_zak(*, zoom_user_id: str, ttl_seconds: int) -> dict:
        state["zak_calls"].append((zoom_user_id, ttl_seconds))
        if state["zak_error"] is not None:
            raise state["zak_error"]
        return state["zak"]

    monkeypatch.setattr(zoom_sdk, "get_meeting", fake_get_meeting)
    monkeypatch.setattr(zoom_sdk, "get_user_zak", fake_get_user_zak)
    return state


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _user(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int, *,
    master: bool = False,
) -> tuple[User, str]:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name=f"U{telegram_id}",
    )
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    if master:
        user.role = UserRole.MASTER.value
        db_session.add(
            MasterProfile(
                user_id=user.id,
                data={
                    "account": {"status": "verified"},
                    "profile": {"display_name": "Master"},
                },
            )
        )
    await db_session.flush()
    return user, auth["session_token"]


async def _practice_with_meeting(
    db_session: AsyncSession, master: User, zoom_id: str, *,
    host_zoom_user_id: str | None = "stored-host",
) -> tuple[Practice, ZoomMeeting]:
    practice = Practice(
        master_id=master.id,
        title="SDK join",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=PracticeStatus.SCHEDULED.value,
        scheduled_at=datetime.now(UTC) + timedelta(hours=3),
        duration_minutes=60,
        timezone="UTC",
        max_participants=10,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        data={},
    )
    db_session.add(practice)
    await db_session.flush()
    meeting = ZoomMeeting(
        practice_id=practice.id,
        zoom_meeting_id=zoom_id,
        zoom_meeting_uuid=f"uuid-{zoom_id}",
        host_zoom_user_id=host_zoom_user_id,
        status=ZoomMeetingStatus.ACTIVE.value,
    )
    db_session.add(meeting)
    await db_session.flush()
    return practice, meeting


async def _booking_with_registrant(
    db_session: AsyncSession,
    practice: Practice,
    meeting: ZoomMeeting,
    user: User,
    *,
    join_url: str | None,
    booking_status: str = BookingStatus.CONFIRMED.value,
    zoom_registrant_id: str | None = "reg-1",
) -> tuple[Booking, ZoomRegistrant]:
    booking = Booking(
        practice_id=practice.id, user_id=user.id, status=booking_status,
    )
    db_session.add(booking)
    await db_session.flush()
    registrant = ZoomRegistrant(
        zoom_meeting_id=meeting.id,
        user_id=user.id,
        booking_id=booking.id,
        role=ZoomRegistrantRole.STUDENT.value,
        registration_email=f"user-{user.id}@users.velo.invalid",
        status=ZoomRegistrantStatus.REGISTERED.value,
        join_url=join_url,
        zoom_registrant_id=zoom_registrant_id,
    )
    db_session.add(registrant)
    await db_session.flush()
    return booking, registrant


async def _join(client: AsyncClient, practice_id: UUID, token: str | None):
    headers = auth_headers(token) if token else {}
    return await client.post(
        f"/api/v1/practices/{practice_id}/zoom/sdk-join", headers=headers,
    )


def _decode(signature: str, secret: str = _SDK_SECRET) -> dict:
    return jwt.decode(
        signature, secret, algorithms=["HS256"], options={"verify_exp": False},
    )


# ===========================================================================
# 1. The signature.
# ===========================================================================


def test_hs256_layer_meets_rfc_7515_appendix_a1() -> None:
    """RFC 7515 A.1: the exact signing input, key and signature of the RFC's
    own HS256 example. This is the only layer such a vector can reach -- the
    RFC's header and payload carry CRLFs no JSON encoder of ours emits."""
    header = "eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9"
    payload = (
        "eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFt"
        "cGxlLmNvbS9pc19yb290Ijp0cnVlfQ"
    )
    k = (
        "AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4h"
        "cgUuTwjAzZr1Z9CAow"
    )
    key = base64.urlsafe_b64decode(k + "=" * (-len(k) % 4))

    got = zoom_sdk.hs256_sign(f"{header}.{payload}".encode("ascii"), key)

    assert got == "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"


@pytest.mark.parametrize("role", [zoom_sdk.SdkRole.ATTENDEE, zoom_sdk.SdkRole.HOST])
def test_signature_is_zooms_jwt_verified_by_an_independent_implementation(
    role: zoom_sdk.SdkRole,
) -> None:
    now = 1_760_000_000
    token = zoom_sdk.build_sdk_signature(
        client_id=_SDK_ID, client_secret=_SDK_SECRET,
        meeting_number="555000300", role=role, now=now,
    )

    assert jwt.get_unverified_header(token) == {"alg": "HS256", "typ": "JWT"}
    claims = _decode(token)
    assert claims == {
        "appKey": _SDK_ID,
        "sdkKey": _SDK_ID,
        "mn": "555000300",
        "role": int(role),
        "iat": now - 30,
        "exp": now + 1800,
        "tokenExp": now + 1800,
    }
    # Zoom: exp at least 1800 s past iat; the owner's bound: minutes, not
    # days -- at most an hour.
    assert 1800 <= claims["exp"] - claims["iat"] <= 3600
    # No base64 padding anywhere in a JWS.
    assert "=" not in token


def test_signature_does_not_verify_with_another_secret() -> None:
    token = zoom_sdk.build_sdk_signature(
        client_id=_SDK_ID, client_secret=_SDK_SECRET,
        meeting_number="1", role=zoom_sdk.SdkRole.ATTENDEE, now=1_760_000_000,
    )
    with pytest.raises(jwt.InvalidSignatureError):
        _decode(token, "a-different-secret-0123456789abcdef")


# ===========================================================================
# 2. The entry token.
# ===========================================================================


@pytest.mark.parametrize(
    ("join_url", "expected"),
    [
        ("https://zoom.us/w/1?tk=abc", "abc"),
        # Other parameters around it, either order.
        ("https://zoom.us/w/1?pwd=x&tk=abc", "abc"),
        (_LINK, "tok-personal"),
        # Percent-encoding is decoded -- the SDK wants the token itself.
        ("https://zoom.us/w/1?tk=a%2Bb.c", "a+b.c"),
        # EMPTINESS: no URL, an empty one, no tk, an empty or blank tk.
        (None, None),
        ("", None),
        ("https://zoom.us/w/1", None),
        ("https://zoom.us/w/1?pwd=x", None),
        ("https://zoom.us/w/1?tk=", None),
        ("https://zoom.us/w/1?tk=%20%20", None),
        # REPEAT: two tokens is not a documented shape; no guessing which.
        ("https://zoom.us/w/1?tk=a&tk=b", None),
    ],
)
def test_entry_token_from_join_url(join_url: str | None, expected: str | None) -> None:
    assert entry_token_from_join_url(join_url) == expected


def test_a_registered_link_without_tk_is_no_link_for_the_predicate() -> None:
    """NEW CELL of link_unavailable_reason (F4): a join_url that carries no
    `tk` opens nothing in the SDK, so a registered row holding one is
    registered_without_join_url. Pair: the same row WITH a tk is fine."""
    def row(join_url: str) -> ZoomRegistrant:
        return ZoomRegistrant(
            status=ZoomRegistrantStatus.REGISTERED.value, join_url=join_url,
            retry_count=0, role=ZoomRegistrantRole.STUDENT.value,
        )

    assert link_unavailable_reason(row("https://zoom.us/w/1?pwd=x")) == (
        LINK_UNAVAILABLE_REGISTERED_WITHOUT_JOIN_URL
    )
    assert link_unavailable_reason(row("https://zoom.us/w/1?tk=abc")) is None


def test_sdk_configured_needs_real_zoom_and_both_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "zoom_account_id", "acct")
    monkeypatch.setattr(settings, "zoom_client_id", "s2s-id")
    monkeypatch.setattr(settings, "zoom_client_secret", "s2s-secret-not-test")
    monkeypatch.setattr(settings, "zoom_sdk_client_id", _SDK_ID)
    monkeypatch.setattr(settings, "zoom_sdk_client_secret", _SDK_SECRET)
    assert settings.is_zoom_sdk_configured is True

    monkeypatch.setattr(settings, "zoom_sdk_client_secret", "")
    assert settings.is_zoom_sdk_configured is False

    monkeypatch.setattr(settings, "zoom_sdk_client_secret", _SDK_SECRET)
    monkeypatch.setattr(settings, "zoom_sdk_client_id", "")
    assert settings.is_zoom_sdk_configured is False

    # Keys present, but Zoom itself is the stub: fabricated meeting numbers.
    monkeypatch.setattr(settings, "zoom_sdk_client_id", _SDK_ID)
    monkeypatch.setattr(settings, "zoom_client_secret", "TEST")
    assert settings.is_zoom_sdk_configured is False


# ===========================================================================
# 3. The endpoint.
# ===========================================================================


@pytest.mark.asyncio
async def test_student_gets_attendee_parameters_and_nothing_leaks(
    client: AsyncClient, db_session: AsyncSession, real_zoom: dict,
) -> None:
    master, _ = await _user(client, db_session, 60150, master=True)
    student, token = await _user(client, db_session, 60151)
    practice, meeting = await _practice_with_meeting(db_session, master, "555000300")
    _, registrant = await _booking_with_registrant(
        db_session, practice, meeting, student, join_url=_LINK,
    )
    await db_session.commit()

    with capture_logs() as logs:
        resp = await _join(client, practice.id, token)

    assert resp.status_code == 200, resp.text
    assert resp.headers["cache-control"] == "no-store"
    body = resp.json()
    assert body["role"] == 0
    assert body["tk"] == "tok-personal"
    assert body["user_email"] == registrant.registration_email
    assert body["zak"] is None
    assert body["sdk_key"] == _SDK_ID
    assert body["meeting_number"] == "555000300"
    assert body["password"] == _PASSWORD
    assert body["user_name"] == f"U60151 {student.last_name or 'User'}"
    claims = _decode(body["signature"])
    assert claims["mn"] == "555000300"
    assert claims["role"] == 0
    # Asked Zoom for the meeting once, never for a ZAK.
    assert real_zoom["meeting_calls"] == ["555000300"]
    assert real_zoom["zak_calls"] == []
    # The secret is nowhere in the body; nothing credential-shaped is logged.
    assert _SDK_SECRET not in resp.text
    logged = repr(logs)
    for secret in (_SDK_SECRET, _PASSWORD, "tok-personal", body["signature"]):
        assert secret not in logged
    # Pair: the issue IS logged -- the check above is not vacuous.
    assert any(e["event"] == "zoom_sdk_join_issued" for e in logs)


@pytest.mark.asyncio
async def test_owner_gets_host_parameters_with_a_short_lived_zak(
    client: AsyncClient, db_session: AsyncSession, real_zoom: dict,
) -> None:
    master, token = await _user(client, db_session, 60152, master=True)
    practice, _ = await _practice_with_meeting(db_session, master, "555000301")
    await db_session.commit()

    with capture_logs() as logs:
        resp = await _join(client, practice.id, token)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["role"] == 1
    assert body["zak"] == _ZAK
    assert body["tk"] is None
    assert body["user_email"] is None
    assert _decode(body["signature"])["role"] == 1
    # The host is whoever Zoom says hosts it now; the ZAK lives 300 s.
    assert real_zoom["zak_calls"] == [("zoom-host-1", zoom_sdk.ZAK_TTL_SECONDS)]
    assert zoom_sdk.ZAK_TTL_SECONDS == 300
    assert _ZAK not in repr(logs)


@pytest.mark.asyncio
async def test_host_id_falls_back_to_the_stored_one_and_neither_is_a_502(
    client: AsyncClient, db_session: AsyncSession, real_zoom: dict,
) -> None:
    master, token = await _user(client, db_session, 60153, master=True)
    with_stored, _ = await _practice_with_meeting(
        db_session, master, "555000302", host_zoom_user_id="stored-host",
    )
    without, _ = await _practice_with_meeting(
        db_session, master, "555000303", host_zoom_user_id=None,
    )
    await db_session.commit()
    real_zoom["details"] = {"password": _PASSWORD}  # NO host_id from Zoom

    first = await _join(client, with_stored.id, token)
    second = await _join(client, without.id, token)

    assert first.status_code == 200, first.text
    assert real_zoom["zak_calls"] == [("stored-host", zoom_sdk.ZAK_TTL_SECONDS)]
    assert second.status_code == 502
    assert second.json()["error"] == "zoom_host_token_unavailable"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("zak_error", "zak_answer"),
    [
        # The S2S app lacks user:read:token:admin, typically.
        (ZoomAPIError("scope", status_code=400, body={"code": 4711}), None),
        # Answered, but without a token.
        (None, {}),
        (None, {"token": ""}),
    ],
)
async def test_no_zak_from_zoom_is_an_honest_502_for_the_master(
    client: AsyncClient, db_session: AsyncSession, real_zoom: dict,
    zak_error: ZoomAPIError | None, zak_answer: dict | None,
) -> None:
    master, token = await _user(client, db_session, 60154, master=True)
    practice, _ = await _practice_with_meeting(db_session, master, "555000304")
    await db_session.commit()
    real_zoom["zak_error"] = zak_error
    if zak_answer is not None:
        real_zoom["zak"] = zak_answer

    resp = await _join(client, practice.id, token)

    assert resp.status_code == 502
    assert resp.json()["error"] == "zoom_host_token_unavailable"


@pytest.mark.asyncio
async def test_zoom_not_answering_the_meeting_is_a_502(
    client: AsyncClient, db_session: AsyncSession, real_zoom: dict,
) -> None:
    master, _ = await _user(client, db_session, 60155, master=True)
    student, token = await _user(client, db_session, 60156)
    practice, meeting = await _practice_with_meeting(db_session, master, "555000305")
    await _booking_with_registrant(
        db_session, practice, meeting, student, join_url=_LINK,
    )
    await db_session.commit()
    real_zoom["details_error"] = ZoomAPIError("down", status_code=503, body="x")

    with capture_logs() as logs:
        resp = await _join(client, practice.id, token)

    assert resp.status_code == 502
    assert resp.json()["error"] == "zoom_unavailable"
    failed = [e for e in logs if e["event"] == "zoom_sdk_meeting_fetch_failed"]
    assert failed and failed[0]["status_code"] == 503


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "details", [{"host_id": "h"}, {"host_id": "h", "password": None}],
)
async def test_a_meeting_without_a_passcode_joins_with_an_empty_one(
    client: AsyncClient, db_session: AsyncSession, real_zoom: dict, details: dict,
) -> None:
    master, _ = await _user(client, db_session, 60157, master=True)
    student, token = await _user(client, db_session, 60158)
    practice, meeting = await _practice_with_meeting(db_session, master, "555000306")
    await _booking_with_registrant(
        db_session, practice, meeting, student, join_url=_LINK,
    )
    await db_session.commit()
    real_zoom["details"] = details

    resp = await _join(client, practice.id, token)

    assert resp.status_code == 200, resp.text
    assert resp.json()["password"] == ""


@pytest.mark.asyncio
async def test_not_configured_is_said_out_loud(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The suite runs on the Zoom stub (conftest). A person who MAY enter is
    told the server is not configured -- and Zoom is not asked anything."""
    master, _ = await _user(client, db_session, 60159, master=True)
    student, token = await _user(client, db_session, 60160)
    practice, meeting = await _practice_with_meeting(db_session, master, "555000307")
    await _booking_with_registrant(
        db_session, practice, meeting, student, join_url=_LINK,
    )
    await db_session.commit()
    called: list[str] = []

    async def must_not_be_called(**kwargs: object) -> dict:
        called.append("zoom")
        return {}

    monkeypatch.setattr(zoom_sdk, "get_meeting", must_not_be_called)
    assert settings.is_zoom_sdk_configured is False

    resp = await _join(client, practice.id, token)

    assert resp.status_code == 409
    assert resp.json()["error"] == "zoom_sdk_not_configured"
    assert called == []


@pytest.mark.asyncio
async def test_everybody_the_ladder_does_not_let_in_is_refused_before_config(
    client: AsyncClient, db_session: AsyncSession, real_zoom: dict,
) -> None:
    """GUEST (not booked -- owner decision 12), a booking whose registrant
    has a link WITHOUT tk (unavailable), a PENDING booking, a cancelled
    practice: all 409 zoom_entry_not_joinable, and Zoom is never asked."""
    master, _ = await _user(client, db_session, 60161, master=True)
    _guest, guest_token = await _user(client, db_session, 60162)
    no_tk_user, no_tk_token = await _user(client, db_session, 60163)
    pending_user, pending_token = await _user(client, db_session, 60164)
    practice, meeting = await _practice_with_meeting(db_session, master, "555000308")
    await _booking_with_registrant(
        db_session, practice, meeting, no_tk_user,
        join_url="https://zoom.us/w/555000308?pwd=only",
    )
    await _booking_with_registrant(
        db_session, practice, meeting, pending_user, join_url=_LINK,
        booking_status=BookingStatus.PENDING.value,
    )
    cancelled, _ = await _practice_with_meeting(db_session, master, "555000309")
    cancelled.status = PracticeStatus.CANCELLED.value
    await db_session.commit()

    for practice_id, token in (
        (practice.id, guest_token),
        (practice.id, no_tk_token),
        (practice.id, pending_token),
        (cancelled.id, guest_token),
    ):
        resp = await _join(client, practice_id, token)
        assert resp.status_code == 409, resp.text
        assert resp.json()["error"] == "zoom_entry_not_joinable"
    assert real_zoom["meeting_calls"] == []


@pytest.mark.asyncio
async def test_missing_practice_is_404_and_anonymous_is_401(
    client: AsyncClient, db_session: AsyncSession, real_zoom: dict,
) -> None:
    _, token = await _user(client, db_session, 60165)
    await db_session.commit()

    missing = await _join(client, UUID("00000000-0000-4000-8000-000000000000"), token)
    anonymous = await _join(client, UUID("00000000-0000-4000-8000-000000000000"), None)

    assert missing.status_code == 404
    assert anonymous.status_code == 401
    assert real_zoom["meeting_calls"] == []


@pytest.mark.asyncio
async def test_the_rate_limit_stops_the_calls_before_zoom(
    client: AsyncClient, db_session: AsyncSession, real_zoom: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """REPEAT: a stuck button. Over the per-user limit the answer is 429 and
    Zoom is not asked; under it, every call is a fresh, independent entry."""
    monkeypatch.setattr(settings, "zoom_sdk_join_rate_limit_max_requests", 2)
    master, _ = await _user(client, db_session, 60166, master=True)
    student, token = await _user(client, db_session, 60167)
    practice, meeting = await _practice_with_meeting(db_session, master, "555000310")
    await _booking_with_registrant(
        db_session, practice, meeting, student, join_url=_LINK,
    )
    await db_session.commit()

    first = await _join(client, practice.id, token)
    second = await _join(client, practice.id, token)
    third = await _join(client, practice.id, token)

    assert (first.status_code, second.status_code, third.status_code) == (200, 200, 429)
    assert len(real_zoom["meeting_calls"]) == 2


# ===========================================================================
# 5. One predicate, three readers.
# ===========================================================================


@pytest.mark.asyncio
async def test_ready_flag_follows_the_token_and_stays_behind_the_m3_gate(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Three practices of one student: a CONFIRMED booking with a real tk
    (ready), a CONFIRMED booking whose link has no tk (not ready, and
    unavailable -- nothing will fix it), and a PENDING booking with a real
    tk (not ready: the M-3 gate holds even when there IS an entry)."""
    master, _ = await _user(client, db_session, 60168, master=True)
    student, token = await _user(client, db_session, 60169)
    want: dict[str, tuple[bool, bool]] = {}
    for zoom_id, join_url, status, expected in (
        ("555000311", _LINK, BookingStatus.CONFIRMED.value, (True, False)),
        ("555000312", "https://zoom.us/w/1?pwd=x", BookingStatus.CONFIRMED.value,
         (False, True)),
        ("555000313", _LINK, BookingStatus.PENDING.value, (False, False)),
    ):
        practice, meeting = await _practice_with_meeting(db_session, master, zoom_id)
        booking, _ = await _booking_with_registrant(
            db_session, practice, meeting, student,
            join_url=join_url, booking_status=status,
        )
        want[str(booking.id)] = expected
    await db_session.commit()

    listed = await client.get("/api/v1/bookings/me", headers=auth_headers(token))

    assert listed.status_code == 200, listed.text
    got = {
        r["id"]: (r["zoom_registrant_ready"], r["zoom_registrant_link_unavailable"])
        for r in listed.json()["items"]
        if r["id"] in want
    }
    assert got == want
    assert "zoom.us" not in listed.text


@pytest.mark.asyncio
async def test_ingest_gives_no_zoom_verdict_to_a_link_without_tk(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The BE-72 branch reads the same predicate: a registrant whose link
    carries no tk had nothing to enter with, so his zero seconds back no
    zoom_report verdict -- the proxy decides. Pair: the neighbour WITH a tk
    and report time is judged by Zoom in the same run."""
    master, _ = await _user(client, db_session, 60170, master=True)
    with_tk_user, _ = await _user(client, db_session, 60171)
    no_tk_user, _ = await _user(client, db_session, 60172)
    practice, meeting = await _practice_with_meeting(db_session, master, "555000314")
    with_tk, _ = await _booking_with_registrant(
        db_session, practice, meeting, with_tk_user,
        join_url=_LINK, zoom_registrant_id="reg-with-tk",
    )
    no_tk, _ = await _booking_with_registrant(
        db_session, practice, meeting, no_tk_user,
        join_url="https://zoom.us/w/555000314?pwd=only",
        zoom_registrant_id="reg-no-tk",
    )
    practice.scheduled_at = datetime.now(UTC) - timedelta(hours=2)
    practice.status = PracticeStatus.COMPLETED.value
    await db_session.flush()

    async def report(*, zoom_meeting_id: str, include_registrant_id: bool) -> list:
        return [{
            "registrant_id": "reg-with-tk",
            "user_email": "",
            "duration": practice.duration_minutes * 60,
            "join_time": "2026-10-01T10:00:00Z",
            "leave_time": "2026-10-01T11:00:00Z",
        }]

    monkeypatch.setattr(attendance_service, "get_participants_report", report)

    ingested = await ingest_report_for_meeting(meeting, practice, db_session)
    await db_session.flush()
    await db_session.refresh(with_tk)
    await db_session.refresh(no_tk)

    assert ingested is True
    assert (with_tk.status, with_tk.attendance_decided_via) == (
        BookingStatus.ATTENDED.value, "zoom_report",
    )
    assert no_tk.attendance_decided_via == "legacy_proxy"
