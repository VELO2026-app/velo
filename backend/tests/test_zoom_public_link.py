# =============================================================================
# VELO -- Tests: the public Zoom link wrapper (T-35)
# =============================================================================
#
# telegram_id band: 89840-89859.
#
# ⚠ BAND PROVENANCE, read before reusing a number from it. The handoff issued
# 89800-89819, and that window is NOT free: test_chats_t3_students.py declares
# BAND_MIN, BAND_MAX = 89800, 89839 and its own cleanup deletes EVERY user in
# that range around every test, committing as it goes -- running alongside it
# would have destroyed that file's fixtures mid-run. 89840-89859 was picked
# after reading every band actually declared in this directory (89400-89499,
# 89520-89599, 89600-89619, 89620-89639, 89640-89659, 89660-89679,
# 89720-89759, 89800-89839, 96000-96999 and 99600-99699), which is the only
# registry visible from this repo. 89680-89699 is deliberately untouched
# (returned reserve, H-R3).
#
# WHAT IS UNDER TEST, AND WHY IT IS WORTH TESTING.
#
# The defect: a master pastes the shared guest Zoom link into a Telegram
# channel where his own booked students also sit. Their personal link is two
# screens away inside the app; the guest link is right there in the feed. They
# click it, join as a registrant the attendance matcher cannot attribute to
# anyone, and are recorded NO_SHOW for a practice they demonstrably attended.
#
# The wrapper kills that CONSTRUCTIVELY rather than by discipline: no raw Zoom
# URL leaves the API, so the only thing that can be pasted anywhere is
# {PUBLIC_LINK_BASE}/z/{code}, and what that resolves to is decided per-viewer
# at click time by resolve_zoom_entry.
#
# THE LADDER IS THE FEATURE, and its ORDER is load-bearing -- each step exists
# because the one below it would otherwise mask a state and lie to somebody.
# Every step AND every overlap between steps is covered below, including the
# three that were found by walking the order rather than by reading the code:
#   - a CONFIRMED booking with no join_url yet must be 'pending', never
#     'guest'. Handing that person the guest link recreates the exact NO_SHOW
#     this feature exists to kill.
#   - the owner must lose to 'failed' and to 'pending', because a 'host'
#     answer sends him to a "Начать" button that would then fail with
#     zoom_meeting_not_active.
#   - a guest with no minted link is 'guest' with url=None, NOT 'failed':
#     the meeting exists, only the guest seat in it does not.
#
# ⚠ BACKEND-ONLY, NOT RUN LOCALLY -- no docker/postgres in this environment
# (same standing caveat as test_zoom_start.py). Written to be read and
# exercised by the deploy battery; collection success is not passing.
# =============================================================================

import base64
import json
import uuid
from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking, BookingStatus
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.users.models import User, UserRole
from app.modules.zoom.models import (
    ZoomMeeting,
    ZoomMeetingStatus,
    ZoomRegistrant,
    ZoomRegistrantRole,
    ZoomRegistrantStatus,
)
from app.modules.zoom.service import (
    PUBLIC_CODE_LENGTH,
    decode_practice_code,
    encode_practice_code,
)
from tests.helpers import auth_headers, full_cleanup_range, login_user

PRACTICES_URL = "/api/v1/practices"

_TID_MIN = 89840
_TID_MAX = 89859


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """The shared FK-safe helper (TD-032), scoped strictly to this file's own
    band -- never a wider range, for the reason spelled out in the band note
    at the top of this file."""
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _make_verified_master(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int,
) -> dict:
    user_data = await login_user(
        client, telegram_id=telegram_id, first_name="LinkMaster",
    )
    user_id = user_data["user"]["id"]
    user = (
        await db_session.execute(select(User).where(User.id == user_id))
    ).scalar_one()
    user.role = UserRole.MASTER.value
    await db_session.flush()
    db_session.add(
        MasterProfile(
            user_id=UUID(user_id), data={"account": {"status": "verified"}},
        )
    )
    await db_session.commit()
    return user_data


async def _create_and_publish_practice(
    client: AsyncClient, master_data: dict,
) -> str:
    """Publish is what triggers create_meeting_for_practice, so the practice
    comes back with a real (stub) ACTIVE ZoomMeeting -- the same path a real
    master walks, not a hand-inserted row."""
    body = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Практика по ссылке",
        "scheduled_at": (
            datetime.now(timezone.utc) + timedelta(hours=48)
        ).isoformat(),
        "duration_minutes": 60,
        "timezone": "Europe/Moscow",
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }
    resp = await client.post(
        PRACTICES_URL, json=body, headers=auth_headers(master_data["session_token"]),
    )
    assert resp.status_code == 201
    practice_id = resp.json()["id"]
    publish = await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={"status": "scheduled"},
        headers=auth_headers(master_data["session_token"]),
    )
    assert publish.status_code == 200
    return practice_id


async def _meeting(db_session: AsyncSession, practice_id: str) -> ZoomMeeting:
    return (
        await db_session.execute(
            select(ZoomMeeting).where(ZoomMeeting.practice_id == UUID(practice_id))
        )
    ).scalar_one()


async def _book(
    db_session: AsyncSession,
    practice_id: str,
    user_id: str,
    status: str,
    *,
    with_registrant_join_url: str | None = None,
) -> Booking:
    """A booking written directly, plus (optionally) the Zoom registrant row
    that would normally accompany it.

    Direct ORM writes on purpose: the resolver reads booking status and the
    registrant's join_url, and this file needs to exercise combinations the
    booking flow does not produce on demand -- notably a CONFIRMED booking
    whose registrant exists with join_url still NULL, which is a REAL state
    (Zoom does not always return a tokenized join_url on create; see
    ZoomRegistrant.join_url) and the single most dangerous rung of the ladder.
    """
    booking = Booking(
        practice_id=UUID(practice_id),
        user_id=UUID(user_id),
        status=status,
    )
    db_session.add(booking)
    await db_session.flush()
    meeting = await _meeting(db_session, practice_id)
    db_session.add(
        ZoomRegistrant(
            zoom_meeting_id=meeting.id,
            user_id=UUID(user_id),
            booking_id=booking.id,
            role=ZoomRegistrantRole.STUDENT.value,
            registration_email=f"u-{user_id}@users.velo.invalid",
            join_url=with_registrant_join_url,
            status=ZoomRegistrantStatus.REGISTERED.value,
        )
    )
    await db_session.commit()
    return booking


async def _resolve(client: AsyncClient, practice_id: str, token: str) -> dict:
    resp = await client.get(
        f"{PRACTICES_URL}/{practice_id}/zoom/resolve",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


# ===========================================================================
# 1. The codec. Three axes of garbage, matched by the client copy in
#    frontend/src/composables/useAuth.ts (its own doubles live there).
# ===========================================================================


def test_code_round_trips_and_is_exactly_22_chars() -> None:
    """Reversible and deterministic -- which is why no short-link table
    exists: a table would buy 15 characters at the price of a migration,
    collisions and expiry, and a dictionary code would be enumerable where a
    reversible one is exactly a UUIDv4."""
    for _ in range(50):
        practice_id = uuid.uuid4()
        code = encode_practice_code(practice_id)
        assert len(code) == PUBLIC_CODE_LENGTH == 22
        assert decode_practice_code(code) == practice_id


def test_code_charset_is_telegram_deep_link_safe() -> None:
    """The same code has to survive as startapp=zoom__<22> (28 chars against
    a 64 limit), so it may only use base64url's alphabet."""
    allowed = set(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    )
    for _ in range(50):
        assert set(encode_practice_code(uuid.uuid4())) <= allowed


def test_decode_rejects_wrong_length() -> None:
    """AXIS 1."""
    assert decode_practice_code("A" * 21) is None
    assert decode_practice_code("A" * 23) is None


def test_decode_rejects_wrong_charset() -> None:
    """AXIS 2 -- right length, impossible alphabet."""
    assert decode_practice_code("A" * 20 + "!!") is None
    assert decode_practice_code("A" * 20 + "==") is None
    assert decode_practice_code("тест" * 5 + "аб") is None


def test_decode_rejects_empty() -> None:
    """AXIS 3."""
    assert decode_practice_code("") is None


def test_decode_rejects_a_code_that_is_not_16_bytes() -> None:
    """Right length and right charset, wrong payload size. Guarded
    explicitly rather than trusted to base64: Python's decoder is lenient
    about stray characters, so the byte-count check is what actually
    holds."""
    fifteen = base64.urlsafe_b64encode(b"\x00" * 15).decode().rstrip("=")
    if len(fifteen) == PUBLIC_CODE_LENGTH:
        assert decode_practice_code(fifteen) is None


# ===========================================================================
# 1a. T-44: THE SHARED VECTOR.
#
# The block between the two sentinel comments below is duplicated VERBATIM in
# frontend/src/composables/useAuth.test.ts. Two copies, because no single
# build context can see both trees (the backend image copies app/ tests/
# scripts/ migrations/ + .env.example; the frontend image is built from
# frontend/ alone), so a shared file would be unreachable to one of them.
#
# TWO MECHANISMS, catching two different mistakes:
#   1. THIS FILE runs the real decode_practice_code against its own copy --
#      catches "I changed the codec and forgot the table".
#   2. `velo test` / `velo update` run a container that mounts the whole
#      checkout and diffs the two copies against each other -- catches "I
#      changed one side's codec AND its table", which neither side's own
#      suite can possibly see, because each is internally consistent.
#
# EDITING RULE: change the JSON here and the JSON there in the same commit.
# The comparison is on PARSED JSON, not bytes, so Python's triple quotes and
# TypeScript's backticks are free to differ -- the data must not.
#
# NOTE on the "not_16_bytes" axis, which carries no example. There is none to
# carry: 22 characters of base64url plus "==" always decode to exactly 16
# bytes. That is group arithmetic, not luck -- confirmed over 200000 random
# codes. Any input that would decode to a different length has to break the
# length or charset axis first, and is rejected there. Both sides keep their
# byte-count guard regardless, as the thing that would catch a future change
# to the code length; documenting why the axis is empty is honest, inventing
# a case that "covers" it would not be.
#
# NOTE on "+" and "/". Python's urlsafe_b64decode translates "-" into "+" and
# "_" into "/" and then calls the STANDARD decoder, which accepts either
# spelling -- so before T-44 the backend decoded "AAAAAAAAAAAAAAAAAAAA++" to a
# real practice id while the client's regex rejected it. Python accepted a
# strict superset of the client. That is the drift this vector exists to
# catch, and it is now closed by an explicit charset gate on the backend.
#
# --- T-44 CODEC VECTOR START (identical JSON on both sides) ---
_CODEC_VECTOR_JSON = """
{
  "axes": {
    "valid": "a real code decodes to its practice id",
    "length": "not 22 characters is not a code",
    "charset": "22 characters outside base64url is not a code",
    "empty": "the empty string is not a code",
    "repeat": "same input twice, same answer (asserted separately)",
    "not_16_bytes": "no example exists -- see the NOTE above, it is arithmetic"
  },
  "cases": [
    {
      "input": "ERERESIiMzNERFVVVVVVVQ",
      "expect": "11111111-2222-3333-4444-555555555555",
      "why": "canonical valid code"
    },
    {
      "input": "-__7__v_-__7__v_-__7_w",
      "expect": "fbfffbff-fbff-fbff-fbff-fbfffbfffbff",
      "why": "valid; exercises - and _, which ARE base64url"
    },
    {
      "input": "+//7//v/+//7//v/+//7/w",
      "expect": null,
      "why": "same bytes spelled with + and / -- the T-44 divergence"
    },
    {
      "input": "AAAAAAAAAAAAAAAAAAAA++",
      "expect": null,
      "why": "the divergence, minimal form"
    },
    {
      "input": "AAAAAAAAAAAAAAAAAAAA//",
      "expect": null,
      "why": "the divergence, other standard-alphabet character"
    },
    {
      "input": "AAAAAAAAAAAAAAAAAAAAA",
      "expect": null,
      "why": "21 characters -- too short"
    },
    {
      "input": "AAAAAAAAAAAAAAAAAAAAAAA",
      "expect": null,
      "why": "23 characters -- too long"
    },
    {
      "input": "",
      "expect": null,
      "why": "empty"
    },
    {
      "input": "AAAAAAAAAAAAAAAAAAAA!!",
      "expect": null,
      "why": "right length, impossible alphabet"
    },
    {
      "input": "AAAAAAAAAAAAAAAAAAAA==",
      "expect": null,
      "why": "padding is not part of a code -- it is stored stripped"
    },
    {
      "input": "AAAAAAAAAAAAAAAAAAAA  ",
      "expect": null,
      "why": "trailing whitespace -- caught by the charset gate"
    },
    {
      "input": "жжжжжжжжжжжжжжжжжжжжжж",
      "expect": null,
      "why": "22 non-ASCII characters -- length alone would pass"
    }
  ]
}
"""
# --- T-44 CODEC VECTOR END ---


def test_codec_matches_the_shared_vector() -> None:
    """MECHANISM 1 (see the block above): the real decoder, driven by this
    side's copy of the shared vector. A red here means the codec and the
    table disagree -- fix whichever is wrong, in BOTH files."""
    vector = json.loads(_CODEC_VECTOR_JSON)
    for case in vector["cases"]:
        actual = decode_practice_code(case["input"])
        expected = (
            None if case["expect"] is None else UUID(case["expect"])
        )
        assert actual == expected, (
            f"vector case {case['input']!r} ({case['why']}): "
            f"expected {expected}, got {actual}"
        )


def test_codec_vector_repeat_axis() -> None:
    """REPEAT axis, stated once here rather than as a duplicate row in the
    vector: the decoder is pure, so the same input twice gives the same
    answer. Worth pinning because a future memoisation or normalisation
    step is exactly the kind of change that would break it silently."""
    vector = json.loads(_CODEC_VECTOR_JSON)
    for case in vector["cases"]:
        first = decode_practice_code(case["input"])
        second = decode_practice_code(case["input"])
        assert first == second


# ===========================================================================
# 2. The anonymous page. 404 means "no such link"; 200 means "the link is
#    real, here is its state" -- Telegram only renders a preview card for
#    200, which is why an honest state page is still a 200.
# ===========================================================================


@pytest.mark.asyncio
async def test_malformed_code_is_404_and_never_touches_the_database(
    client: AsyncClient,
) -> None:
    """A code of the wrong shape is rejected by decode_practice_code BEFORE
    any query runs -- so a scan of malformed codes cannot cost a database
    round trip each. Proven by patching the loader's session use: if this
    request reached it, the patch would record a call."""
    for bad in ("short", "A" * 23, "A" * 20 + "!!"):
        resp = await client.get(f"/z/{bad}", follow_redirects=False)
        assert resp.status_code == 404, bad
        assert "text/html" in resp.headers["content-type"]
        assert "og:title" not in resp.text, "nothing real to describe"


@pytest.mark.asyncio
async def test_wellformed_code_for_a_missing_practice_is_404(
    client: AsyncClient,
) -> None:
    """Right shape, no such row. Indistinguishable from garbage on purpose:
    telling the two apart would make this route an existence oracle."""
    resp = await client.get(
        f"/z/{encode_practice_code(uuid.uuid4())}", follow_redirects=False,
    )
    assert resp.status_code == 404
    assert "og:title" not in resp.text


@pytest.mark.asyncio
async def test_draft_practice_is_404_and_does_not_leak_its_title(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A draft is an absence, not a state: publishing the title of an
    unpublished practice to whoever holds a URL would be a leak."""
    master = await _make_verified_master(client, db_session, telegram_id=89840)
    body = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "СЕКРЕТНЫЙ ЧЕРНОВИК",
        "scheduled_at": (
            datetime.now(timezone.utc) + timedelta(hours=48)
        ).isoformat(),
        "duration_minutes": 60,
        "timezone": "UTC",
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }
    resp = await client.post(
        PRACTICES_URL, json=body, headers=auth_headers(master["session_token"]),
    )
    practice_id = resp.json()["id"]

    page = await client.get(
        f"/z/{encode_practice_code(UUID(practice_id))}", follow_redirects=False,
    )
    assert page.status_code == 404
    assert "СЕКРЕТНЫЙ ЧЕРНОВИК" not in page.text


@pytest.mark.asyncio
async def test_landing_renders_og_tags_and_both_buttons(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The OpenGraph card is the reason this page is server-rendered instead
    of a redirect into the SPA -- an SPA returns an empty shell and Telegram
    draws no preview at all."""
    master = await _make_verified_master(client, db_session, telegram_id=89841)
    practice_id = await _create_and_publish_practice(client, master)
    code = encode_practice_code(UUID(practice_id))

    resp = await client.get(f"/z/{code}", follow_redirects=False)

    assert resp.status_code == 200
    assert 'property="og:title"' in resp.text
    assert 'property="og:description"' in resp.text
    assert "Практика по ссылке" in resp.text
    # Both ways in: the app (deep link carrying the SAME code) and guest.
    assert f"startapp=zoom__{code}" in resp.text
    assert f"/z/{code}/guest" in resp.text


@pytest.mark.asyncio
async def test_landing_never_contains_a_raw_zoom_url(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """THE POINT OF THE WHOLE FEATURE, asserted on the anonymous surface: no
    zoom.us anywhere in the page body. The guest button points at our own
    /guest route, which redirects -- the raw URL exists only as one
    Location header, never as something a person can copy out of the page
    and repost."""
    master = await _make_verified_master(client, db_session, telegram_id=89842)
    practice_id = await _create_and_publish_practice(client, master)

    resp = await client.get(
        f"/z/{encode_practice_code(UUID(practice_id))}", follow_redirects=False,
    )

    assert "zoom.us" not in resp.text


@pytest.mark.asyncio
async def test_cancelled_practice_page_is_200_and_its_og_says_cancelled(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A crawler arriving AFTER the cancellation must not paint a card for a
    live practice over an honest page. 200 (not 410): the link is real, and
    a non-200 would suppress the preview entirely."""
    master = await _make_verified_master(client, db_session, telegram_id=89843)
    practice_id = await _create_and_publish_practice(client, master)
    practice = (
        await db_session.execute(
            select(Practice).where(Practice.id == UUID(practice_id))
        )
    ).scalar_one()
    practice.status = PracticeStatus.CANCELLED.value
    await db_session.commit()

    resp = await client.get(
        f"/z/{encode_practice_code(UUID(practice_id))}", follow_redirects=False,
    )

    assert resp.status_code == 200
    assert 'property="og:description"' in resp.text
    assert "отменена" in resp.text


@pytest.mark.asyncio
async def test_landing_says_so_honestly_when_the_guest_seat_was_never_minted(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """ensure_shared_registrant is best-effort and the retry poller does not
    cover it (a known gap this feature deliberately does not fix). The
    wrapper turns what used to be an invisible nothing into an honest line:
    no guest button, but the app button still works."""
    master = await _make_verified_master(client, db_session, telegram_id=89844)
    practice_id = await _create_and_publish_practice(client, master)
    meeting = await _meeting(db_session, practice_id)
    meeting.shared_join_url = None
    meeting.shared_registrant_id = None
    await db_session.commit()
    code = encode_practice_code(UUID(practice_id))

    resp = await client.get(f"/z/{code}", follow_redirects=False)

    assert resp.status_code == 200
    assert f"/z/{code}/guest" not in resp.text
    assert "Гостевой вход сейчас недоступен" in resp.text
    assert f"startapp=zoom__{code}" in resp.text


@pytest.mark.asyncio
async def test_guest_route_redirects_307_with_no_referrer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The one place a raw Zoom URL is allowed to exist: a Location header.
    Referrer-Policy mirrors zoom_start_redirect_endpoint so zoom.us is not
    handed the shape of our route."""
    master = await _make_verified_master(client, db_session, telegram_id=89845)
    practice_id = await _create_and_publish_practice(client, master)
    meeting = await _meeting(db_session, practice_id)
    meeting.shared_join_url = "https://zoom.us/w/shared?tk=guest"
    await db_session.commit()

    resp = await client.get(
        f"/z/{encode_practice_code(UUID(practice_id))}/guest",
        follow_redirects=False,
    )

    assert resp.status_code == 307
    assert resp.headers["location"] == "https://zoom.us/w/shared?tk=guest"
    assert resp.headers["Referrer-Policy"] == "no-referrer"


@pytest.mark.asyncio
async def test_guest_route_on_a_cancelled_practice_does_not_redirect(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A stale or hand-typed /guest URL must not walk into a dead meeting --
    the landing would not have offered the button in this state."""
    master = await _make_verified_master(client, db_session, telegram_id=89846)
    practice_id = await _create_and_publish_practice(client, master)
    practice = (
        await db_session.execute(
            select(Practice).where(Practice.id == UUID(practice_id))
        )
    ).scalar_one()
    practice.status = PracticeStatus.CANCELLED.value
    await db_session.commit()

    resp = await client.get(
        f"/z/{encode_practice_code(UUID(practice_id))}/guest",
        follow_redirects=False,
    )

    assert resp.status_code == 200
    assert "location" not in {k.lower() for k in resp.headers}


@pytest.mark.asyncio
async def test_repeat_clicks_on_the_same_link_behave_identically(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """THE REPEAT AXIS. Nothing about this link is one-shot -- unlike the
    start ticket, which is GETDEL'd on redemption. A link sits in a channel
    for weeks and is clicked by many people many times."""
    master = await _make_verified_master(client, db_session, telegram_id=89847)
    practice_id = await _create_and_publish_practice(client, master)
    code = encode_practice_code(UUID(practice_id))

    first = await client.get(f"/z/{code}", follow_redirects=False)
    second = await client.get(f"/z/{code}", follow_redirects=False)

    assert first.status_code == second.status_code == 200
    assert first.text == second.text


# ===========================================================================
# 3. THE ANONYMOUS BRANCH NEVER RETURNS A PERSONAL LINK.
#    This is the one security property of the wrapper, and it rests on the
#    request being anonymous, NOT on the code being unguessable (the code is
#    a deterministic function of a practice id any authenticated user
#    already sees in the feed).
# ===========================================================================


@pytest.mark.asyncio
async def test_anonymous_page_never_leaks_a_booked_students_personal_link(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A URL forwarded out of a channel must not become a skeleton key to
    somebody else's attendance. The student's personal link exists and is
    valid; the anonymous page still must not contain it, on either route."""
    master = await _make_verified_master(client, db_session, telegram_id=89848)
    student = await login_user(client, telegram_id=89849, first_name="Ученик")
    practice_id = await _create_and_publish_practice(client, master)
    personal = "https://zoom.us/w/personal?tk=SECRET"
    await _book(
        db_session,
        practice_id,
        student["user"]["id"],
        BookingStatus.CONFIRMED.value,
        with_registrant_join_url=personal,
    )
    meeting = await _meeting(db_session, practice_id)
    meeting.shared_join_url = "https://zoom.us/w/shared?tk=guest"
    await db_session.commit()
    code = encode_practice_code(UUID(practice_id))

    page = await client.get(f"/z/{code}", follow_redirects=False)
    guest = await client.get(f"/z/{code}/guest", follow_redirects=False)

    assert "SECRET" not in page.text
    assert personal not in page.text
    assert guest.headers["location"] != personal


# ===========================================================================
# 4. THE LADDER. Every step, and every overlap between steps.
# ===========================================================================


@pytest.mark.asyncio
async def test_booked_student_gets_their_own_personal_link(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """THE OUTCOME THE FEATURE EXISTS FOR: the person whose attendance can be
    recorded is handed the only link that records it."""
    master = await _make_verified_master(client, db_session, telegram_id=89850)
    student = await login_user(client, telegram_id=89851, first_name="Ученик")
    practice_id = await _create_and_publish_practice(client, master)
    personal = "https://zoom.us/w/personal?tk=abc"
    await _book(
        db_session,
        practice_id,
        student["user"]["id"],
        BookingStatus.CONFIRMED.value,
        with_registrant_join_url=personal,
    )

    body = await _resolve(client, practice_id, student["session_token"])

    assert body["kind"] == "personal"
    assert body["url"] == personal


@pytest.mark.asyncio
async def test_confirmed_booking_without_a_join_url_is_pending_not_guest(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """⭐ THE DEFECT THIS FEATURE WOULD OTHERWISE RECREATE INSIDE ITSELF.

    Zoom does not always return a tokenized join_url when the registrant is
    created (documented on ZoomRegistrant.join_url; the retry poller fills it
    in later). A naive "no personal link -> hand out the guest link" would
    send this CONFIRMED student in as an unmatchable guest -- and
    attendance_service writes NO_SHOW for exactly this shape: a CONFIRMED
    booking whose registrant collected zero seconds.

    Honest waiting is the only correct answer here.
    """
    master = await _make_verified_master(client, db_session, telegram_id=89852)
    student = await login_user(client, telegram_id=89853, first_name="Ученик")
    practice_id = await _create_and_publish_practice(client, master)
    await _book(
        db_session,
        practice_id,
        student["user"]["id"],
        BookingStatus.CONFIRMED.value,
        with_registrant_join_url=None,
    )
    meeting = await _meeting(db_session, practice_id)
    meeting.shared_join_url = "https://zoom.us/w/shared?tk=guest"
    await db_session.commit()

    body = await _resolve(client, practice_id, student["session_token"])

    assert body["kind"] == "pending"
    assert body["url"] is None


@pytest.mark.asyncio
async def test_pending_booking_is_pending_not_guest(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A PENDING booking can become CONFIRMED before the practice starts.
    Hand its owner a guest link now and the NO_SHOW arrives later, after the
    status flips -- which is why "no booking" in this resolver means "no
    booking attendance will ever judge", not "no right to a personal link
    right now"."""
    master = await _make_verified_master(client, db_session, telegram_id=89854)
    student = await login_user(client, telegram_id=89855, first_name="Ученик")
    practice_id = await _create_and_publish_practice(client, master)
    await _book(
        db_session, practice_id, student["user"]["id"], BookingStatus.PENDING.value,
    )
    meeting = await _meeting(db_session, practice_id)
    meeting.shared_join_url = "https://zoom.us/w/shared?tk=guest"
    await db_session.commit()

    body = await _resolve(client, practice_id, student["session_token"])

    assert body["kind"] == "pending"


@pytest.mark.asyncio
async def test_cancelled_booking_gets_the_guest_link(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The other side of the same rule: attendance will never write anything
    for a cancelled booking, so there is nothing to lose by letting this
    person in as a guest."""
    master = await _make_verified_master(client, db_session, telegram_id=89856)
    student = await login_user(client, telegram_id=89857, first_name="Ученик")
    practice_id = await _create_and_publish_practice(client, master)
    await _book(
        db_session, practice_id, student["user"]["id"], BookingStatus.CANCELLED.value,
    )
    meeting = await _meeting(db_session, practice_id)
    meeting.shared_join_url = "https://zoom.us/w/shared?tk=guest"
    await db_session.commit()

    body = await _resolve(client, practice_id, student["session_token"])

    assert body["kind"] == "guest"
    assert body["url"] == "https://zoom.us/w/shared?tk=guest"


@pytest.mark.asyncio
async def test_user_with_no_booking_at_all_gets_the_guest_link(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The twin of the personal case in task 3's own wording."""
    master = await _make_verified_master(client, db_session, telegram_id=89858)
    stranger = await login_user(client, telegram_id=89859, first_name="Гость")
    practice_id = await _create_and_publish_practice(client, master)
    meeting = await _meeting(db_session, practice_id)
    meeting.shared_join_url = "https://zoom.us/w/shared?tk=guest"
    await db_session.commit()

    body = await _resolve(client, practice_id, stranger["session_token"])

    assert body["kind"] == "guest"
    assert body["url"] == "https://zoom.us/w/shared?tk=guest"


@pytest.mark.asyncio
async def test_guest_without_a_minted_link_is_guest_with_null_url_not_failed(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Two different facts, never collapsed: 'failed' means there is no
    meeting, while this means the meeting exists and only the guest seat in
    it does not."""
    master = await _make_verified_master(client, db_session, telegram_id=89840)
    stranger = await login_user(client, telegram_id=89841, first_name="Гость")
    practice_id = await _create_and_publish_practice(client, master)
    meeting = await _meeting(db_session, practice_id)
    meeting.shared_join_url = None
    await db_session.commit()

    body = await _resolve(client, practice_id, stranger["session_token"])

    assert body["kind"] == "guest"
    assert body["url"] is None


@pytest.mark.asyncio
async def test_owner_gets_host_when_the_meeting_is_active(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A master clicking his own published link must not be seated in his own
    meeting as a guest -- the meeting would wait for a host who is standing
    inside it. url is None by design: he starts through the ticket flow."""
    master = await _make_verified_master(client, db_session, telegram_id=89842)
    practice_id = await _create_and_publish_practice(client, master)
    meeting = await _meeting(db_session, practice_id)
    meeting.shared_join_url = "https://zoom.us/w/shared?tk=guest"
    await db_session.commit()

    body = await _resolve(client, practice_id, master["session_token"])

    assert body["kind"] == "host"
    assert body["url"] is None


@pytest.mark.asyncio
async def test_owner_on_a_create_failed_meeting_is_failed_not_host(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """OVERLAP: 'failed' sits ABOVE 'host' in the ladder. Answering 'host'
    here would put the master in front of a "Начать" button whose ticket
    endpoint then refuses with zoom_meeting_not_active -- and he is the one
    person who can actually fix this, via the owner-only retry."""
    master = await _make_verified_master(client, db_session, telegram_id=89843)
    practice_id = await _create_and_publish_practice(client, master)
    meeting = await _meeting(db_session, practice_id)
    meeting.status = ZoomMeetingStatus.CREATE_FAILED.value
    await db_session.commit()

    body = await _resolve(client, practice_id, master["session_token"])

    assert body["kind"] == "failed"


@pytest.mark.asyncio
async def test_owner_on_a_pending_creation_meeting_is_pending_not_host(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """OVERLAP, and the case a narrower step-3 would have missed. Step 3 is a
    branch on "no ACTIVE meeting", not a check for create_failed --
    pending_creation is the normal birth state of every series child beyond
    the nearest occurrence (series_service.py), so this is routine, not
    exotic. Answering 'host' would send the master to the same dead
    "Начать" button."""
    master = await _make_verified_master(client, db_session, telegram_id=89844)
    practice_id = await _create_and_publish_practice(client, master)
    meeting = await _meeting(db_session, practice_id)
    meeting.status = ZoomMeetingStatus.PENDING_CREATION.value
    await db_session.commit()

    body = await _resolve(client, practice_id, master["session_token"])

    assert body["kind"] == "pending"


@pytest.mark.asyncio
async def test_owner_with_no_meeting_row_at_all_is_pending_not_host(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """OVERLAP: the fifth state of step 3 -- no row at all (publish never
    ran, or pre-E21 data). Same reasoning as pending_creation."""
    master = await _make_verified_master(client, db_session, telegram_id=89845)
    practice_id = await _create_and_publish_practice(client, master)
    meeting = await _meeting(db_session, practice_id)
    await db_session.delete(meeting)
    await db_session.commit()

    body = await _resolve(client, practice_id, master["session_token"])

    assert body["kind"] == "pending"


@pytest.mark.asyncio
async def test_owner_on_a_cancelled_practice_is_cancelled_not_host(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """OVERLAP: 'cancelled' is older than everything, INCLUDING the owner. A
    cancelled practice is not started -- offering him "Начать" would be
    offering to do the thing that was cancelled."""
    master = await _make_verified_master(client, db_session, telegram_id=89846)
    practice_id = await _create_and_publish_practice(client, master)
    practice = (
        await db_session.execute(
            select(Practice).where(Practice.id == UUID(practice_id))
        )
    ).scalar_one()
    practice.status = PracticeStatus.CANCELLED.value
    await db_session.commit()

    body = await _resolve(client, practice_id, master["session_token"])

    assert body["kind"] == "cancelled"
    assert body["url"] is None


@pytest.mark.asyncio
async def test_booked_student_on_a_create_failed_meeting_is_failed_not_pending(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """OVERLAP: step 3 sits above the booking steps, and the distinction it
    preserves is exactly the one A4 V2 introduced -- 'still preparing' vs
    'will never appear unless somebody acts'. Collapsing this into 'pending'
    would re-stitch the seam that made a student wait forever."""
    master = await _make_verified_master(client, db_session, telegram_id=89847)
    student = await login_user(client, telegram_id=89848, first_name="Ученик")
    practice_id = await _create_and_publish_practice(client, master)
    await _book(
        db_session, practice_id, student["user"]["id"], BookingStatus.CONFIRMED.value,
    )
    meeting = await _meeting(db_session, practice_id)
    meeting.status = ZoomMeetingStatus.CREATE_FAILED.value
    await db_session.commit()

    body = await _resolve(client, practice_id, student["session_token"])

    assert body["kind"] == "failed"
    assert body["url"] is None


@pytest.mark.asyncio
async def test_resolve_404s_for_a_missing_practice_rather_than_returning_a_kind(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """P-08, the same shape every other endpoint in this router uses. A
    well-formed deep link naming a deleted practice lands here, and the
    client (which has no database and cannot know) renders an honest error
    from this 404."""
    student = await login_user(client, telegram_id=89849, first_name="Ученик")

    resp = await client.get(
        f"{PRACTICES_URL}/{uuid.uuid4()}/zoom/resolve",
        headers=auth_headers(student["session_token"]),
    )

    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_resolve_requires_authentication(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The authenticated half is authenticated. Without this, the anonymous
    branch's whole guarantee would be reachable around."""
    master = await _make_verified_master(client, db_session, telegram_id=89850)
    practice_id = await _create_and_publish_practice(client, master)

    resp = await client.get(f"{PRACTICES_URL}/{practice_id}/zoom/resolve")

    assert resp.status_code in (401, 403)


# ===========================================================================
# 5. No raw Zoom URL leaves the API any more -- the wrapper REPLACED the
#    shared link rather than adding a second path to it.
# ===========================================================================


@pytest.mark.asyncio
async def test_practice_response_carries_our_link_and_not_the_shared_zoom_url(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The master's "Копировать" button reads this field. If the raw shared
    URL were still here, we would have ADDED a path instead of replacing one
    -- and the shorter, more convenient link is the one that gets pasted."""
    master = await _make_verified_master(client, db_session, telegram_id=89851)
    practice_id = await _create_and_publish_practice(client, master)
    meeting = await _meeting(db_session, practice_id)
    meeting.shared_join_url = "https://zoom.us/w/shared?tk=guest"
    await db_session.commit()

    resp = await client.get(
        f"{PRACTICES_URL}/{practice_id}",
        headers=auth_headers(master["session_token"]),
    )

    body = resp.json()
    assert "zoom_shared_join_url" not in body
    assert "zoom_link" not in body
    assert body["zoom_public_link"].endswith(
        f"/z/{encode_practice_code(UUID(practice_id))}"
    )


@pytest.mark.asyncio
async def test_public_link_is_owner_only(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Not a security boundary -- the code is derivable from a practice id
    any authenticated user already sees -- but replacing a field must not
    silently WIDEN its audience, which is what this pins."""
    master = await _make_verified_master(client, db_session, telegram_id=89852)
    stranger = await login_user(client, telegram_id=89853, first_name="Гость")
    practice_id = await _create_and_publish_practice(client, master)

    resp = await client.get(
        f"{PRACTICES_URL}/{practice_id}",
        headers=auth_headers(stranger["session_token"]),
    )

    assert resp.json()["zoom_public_link"] is None


@pytest.mark.asyncio
async def test_the_link_survives_a_reschedule_and_follows_the_new_meeting(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """WHY THE CODE NAMES THE PRACTICE AND NOT THE MEETING. A link posted two
    weeks ago must lead wherever the practice actually is now -- meetings are
    deleted and recreated, practices are stable. Same code before and after,
    resolving to whatever the CURRENT meeting is."""
    master = await _make_verified_master(client, db_session, telegram_id=89854)
    stranger = await login_user(client, telegram_id=89855, first_name="Гость")
    practice_id = await _create_and_publish_practice(client, master)
    code = encode_practice_code(UUID(practice_id))

    meeting = await _meeting(db_session, practice_id)
    meeting.shared_join_url = "https://zoom.us/w/OLD"
    await db_session.commit()
    before = await _resolve(client, practice_id, stranger["session_token"])

    await client.patch(
        f"{PRACTICES_URL}/{practice_id}",
        json={
            "scheduled_at": (
                datetime.now(timezone.utc) + timedelta(hours=96)
            ).isoformat(),
        },
        headers=auth_headers(master["session_token"]),
    )
    meeting = await _meeting(db_session, practice_id)
    meeting.shared_join_url = "https://zoom.us/w/NEW"
    await db_session.commit()
    after = await _resolve(client, practice_id, stranger["session_token"])

    assert code == encode_practice_code(UUID(practice_id))
    assert before["url"] == "https://zoom.us/w/OLD"
    assert after["url"] == "https://zoom.us/w/NEW"


@pytest.mark.asyncio
async def test_no_zoom_link_field_survives_anywhere_on_the_practice_api(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The column is gone; this pins that the SCHEMA went with it, on the
    owner's own response, where the field used to be shown unconditionally."""
    master = await _make_verified_master(client, db_session, telegram_id=89856)
    practice_id = await _create_and_publish_practice(client, master)

    detail = await client.get(
        f"{PRACTICES_URL}/{practice_id}",
        headers=auth_headers(master["session_token"]),
    )
    listing = await client.get(
        "/api/v1/masters/me/practices",
        headers=auth_headers(master["session_token"]),
    )

    assert "zoom_link" not in detail.json()
    for item in listing.json()["items"]:
        assert "zoom_link" not in item


@pytest.mark.asyncio
async def test_creating_a_practice_with_a_zoom_link_field_ignores_it(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """An old client (or a curl from muscle memory) still sending zoom_link
    must not resurrect it. Pydantic's extra='ignore' drops it -- asserted,
    not assumed, because "ignored" and "stored somewhere" look identical
    from the outside until someone checks."""
    master = await _make_verified_master(client, db_session, telegram_id=89857)
    body = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Со старым полем",
        "scheduled_at": (
            datetime.now(timezone.utc) + timedelta(hours=48)
        ).isoformat(),
        "duration_minutes": 60,
        "timezone": "UTC",
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
        "zoom_link": "https://zoom.us/j/legacy",
    }

    resp = await client.post(
        PRACTICES_URL, json=body, headers=auth_headers(master["session_token"]),
    )

    assert resp.status_code == 201
    assert "zoom_link" not in resp.json()
    practice = (
        await db_session.execute(
            select(Practice).where(Practice.id == UUID(resp.json()["id"]))
        )
    ).scalar_one()
    assert not hasattr(practice, "zoom_link")
