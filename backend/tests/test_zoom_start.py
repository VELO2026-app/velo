# =============================================================================
# Tests: Zoom "Начать" -- master starts their own meeting as host (ПРОМТ №556,
# OWNER-1 option В)
# =============================================================================
#
# telegram_id range: 99600-99699 (ПРОМТ №558 -- moved off 79200-79299 after
# that band turned out to be test_zoom_registrants.py's ALREADY-CLAIMED band,
# literal telegram_id for literal telegram_id (both files independently
# picked 79201-79206 for their masters). Verified 99600-99699 is free by
# grepping every "telegram_id range" comment AND every literal 996xx value
# across backend/tests/*.py -- zero hits either way (see ПРОМТ №558 report).
#
# ⚠ BACKEND-ONLY, UNPROVEN LOCALLY -- there is no docker/postgres available in
# this environment (per [[velo_testing]]). These tests were written to be
# read and were exercised via `pytest --collect-only` (import/collection
# succeeds) but never actually RUN against a live database -- collection
# success is NOT the same as passing. The deploy battery is the first real
# run. See the ГОТОВО report for exactly what was and wasn't observed.
#
# EXCEPTION -- test_zoom_start_route_is_reachable_not_a_uuid_parse_422 below
# WAS actually executed (ПРОМТ №557), not merely collected: run as a plain
# script against a live-imported `app.main.app` via httpx.ASGITransport (same
# mechanism as the `client` fixture below), with ONLY
# zoom.service.redeem_start_ticket mocked (it needs Redis, unreachable here;
# nothing else on this path touches Redis or Postgres before that call, since
# SQLAlchemy's async engine is lazy). Confirmed status=400 (the honest error
# page), not 422 -- proves the route is genuinely reachable end-to-end
# through the real router, not just that the handler function works in
# isolation. Written here as a normal pytest test using the SAME `client`
# fixture so it re-runs under the deploy battery too.
#
# STUB MODE: no real Zoom credentials exist in any test environment, so
# settings.is_zoom_stub is True by default and zoom_client._request() always
# returns deterministic fake data (see zoom_client.py's _stub_response),
# including a stub start_url for GET /meetings/{id}. The ZoomAPIError failure
# path is exercised by mocking zoom.service.get_meeting directly.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from app.modules.zoom.models import ZoomMeeting, ZoomMeetingStatus
from app.modules.zoom.zoom_client import ZoomAPIError
from tests.helpers import auth_headers, full_cleanup_range, login_user

PRACTICES_URL = "/api/v1/practices"

_TID_MIN = 99600
_TID_MAX = 99699


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """TD-032: the shared, FK-safe cleanup helper -- not a bespoke raw-SQL
    list. ПРОМТ №558: this file's own hand-rolled list (zoom_registrants,
    zoom_meetings, practices, master_profiles, users, in that order) omitted
    master_ledger entirely, which is exactly what broke the deploy gate --
    full_cleanup_range deletes master_ledger (RESTRICT FK) before users
    (step 7 of 19), so it can never repeat this specific failure, and it
    also means the NEXT table anyone adds to the schema doesn't need this
    file touched at all."""
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
) -> dict:
    user_data = await login_user(
        client, telegram_id=telegram_id, first_name="ZoomStartMaster",
    )
    user_id = user_data["user"]["id"]

    user = (
        await db_session.execute(select(User).where(User.id == user_id))
    ).scalar_one()
    user.role = UserRole.MASTER.value
    await db_session.flush()

    db_session.add(
        MasterProfile(
            user_id=UUID(user_id),
            data={"account": {"status": "verified"}},
        )
    )
    await db_session.commit()
    return user_data


async def _create_and_publish_practice(
    client: AsyncClient, master_data: dict,
) -> str:
    """Create a draft then publish it -- publish is what triggers
    create_meeting_for_practice, giving the practice a real (stub) ACTIVE
    ZoomMeeting row, exactly like a real master's flow."""
    body = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Zoom Start Test Practice",
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


# ---------------------------------------------------------------------------
# 0. Routing -- ПРОМТ №557: the route must be reached via the REAL router,
#    not a direct call to the handler function (that would prove nothing --
#    the defect class this guards against lives in route declaration order,
#    not in handler logic, and a handler-level test stays green through it).
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_zoom_start_route_is_reachable_not_a_uuid_parse_422(
    client: AsyncClient,
) -> None:
    """GET /api/v1/practices/zoom/start (the exact URL api/practices.ts
    builds) must reach zoom_start_redirect_endpoint, not get swallowed by
    GET /api/v1/practices/{practice_id} trying (and failing) to parse the
    literal string "zoom" as a UUID -- that would surface as 422, not the
    honest error page. Only redeem_start_ticket is mocked (it needs Redis,
    which this environment doesn't have); everything else -- URL parsing,
    router dispatch, dependency resolution, the handler itself -- is REAL.
    A 422 here means the routes collided again; a 400 (this test's actual,
    executed result -- see the module docstring) means the request reached
    the right handler and got the honest "ticket expired" page.
    """
    with patch(
        "app.modules.zoom.service.redeem_start_ticket", return_value=None,
    ):
        resp = await client.get(
            f"{PRACTICES_URL}/zoom/start",
            params={"ticket": "bogus"},
            follow_redirects=False,
        )
    assert resp.status_code == 400, (
        f"expected 400 (honest error page), got {resp.status_code} -- "
        "422 would mean /{practice_id} intercepted this request again"
    )
    assert "text/html" in resp.headers["content-type"]
    assert "Ссылка устарела" in resp.text


# ---------------------------------------------------------------------------
# 1. Ownership -- P-08 pattern (404, not 403), same as update/delete/cancel
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_non_owner_refused_start_ticket(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A master who does not own the practice gets 404 (not 403, not the
    practice's existence confirmed) requesting a start ticket for it --
    mirrors update_practice/delete_practice/cancel_practice's own P-08
    check exactly (practices/service.py)."""
    owner = await _make_verified_master(client, db_session, telegram_id=99601)
    other = await _make_verified_master(client, db_session, telegram_id=99602)
    practice_id = await _create_and_publish_practice(client, owner)

    resp = await client.post(
        f"{PRACTICES_URL}/{practice_id}/zoom/start-ticket",
        headers=auth_headers(other["session_token"]),
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# 2. No active meeting -- honest, machine-readable refusal
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_no_active_meeting_returns_honest_error(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A draft (never published) practice has no ZoomMeeting row at all --
    the ticket endpoint must refuse with a specific machine-readable code,
    not a raw 500 or a generic message the frontend can't distinguish."""
    master = await _make_verified_master(client, db_session, telegram_id=99603)
    body = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Never Published",
        "scheduled_at": (
            datetime.now(timezone.utc) + timedelta(hours=48)
        ).isoformat(),
        "duration_minutes": 60,
        "timezone": "UTC",
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }
    create = await client.post(
        PRACTICES_URL, json=body, headers=auth_headers(master["session_token"]),
    )
    assert create.status_code == 201
    practice_id = create.json()["id"]

    resp = await client.post(
        f"{PRACTICES_URL}/{practice_id}/zoom/start-ticket",
        headers=auth_headers(master["session_token"]),
    )
    assert resp.status_code == 400
    assert resp.json()["error"] == "zoom_meeting_not_active"


# ---------------------------------------------------------------------------
# 3. Success path -- ticket, then redirect, start_url never in a JSON body
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ticket_then_redirect_success_never_exposes_start_url_in_json(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The owning master gets a ticket (JSON body containing ONLY `ticket`,
    never `start_url` in any form -- asserted by string search on the raw
    response body, not just schema shape), and redeeming that ticket 30s
    later is a redirect straight to Zoom -- the frontend never sees or
    holds the start_url at any point in this flow."""
    master = await _make_verified_master(client, db_session, telegram_id=99604)
    practice_id = await _create_and_publish_practice(client, master)

    ticket_resp = await client.post(
        f"{PRACTICES_URL}/{practice_id}/zoom/start-ticket",
        headers=auth_headers(master["session_token"]),
    )
    assert ticket_resp.status_code == 200
    assert set(ticket_resp.json().keys()) == {"ticket"}
    assert "zoom.us" not in ticket_resp.text
    assert "start_url" not in ticket_resp.text
    ticket = ticket_resp.json()["ticket"]

    redirect_resp = await client.get(
        f"{PRACTICES_URL}/zoom/start",
        params={"ticket": ticket},
        follow_redirects=False,
    )
    assert redirect_resp.status_code == 307
    assert redirect_resp.headers["location"].startswith("https://zoom.us/s/")


@pytest.mark.asyncio
async def test_start_redirect_sets_referrer_policy_no_referrer(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A4 V10: the 307 to Zoom must carry Referrer-Policy: no-referrer, so
    the browser never sends this endpoint's URL (including the -- by then
    already-consumed -- ticket query param) to zoom.us in a Referer header.
    Discriminates the real break: before the fix, RedirectResponse is
    constructed with no headers kwarg at all, so this header is simply
    absent from the response -- this assertion fails on that exact
    omission and nothing else (redirect status/location are already
    covered by test_ticket_then_redirect_success_never_exposes_start_url_in_json
    above, so this test checks only the one thing that changed)."""
    master = await _make_verified_master(client, db_session, telegram_id=99607)
    practice_id = await _create_and_publish_practice(client, master)

    ticket_resp = await client.post(
        f"{PRACTICES_URL}/{practice_id}/zoom/start-ticket",
        headers=auth_headers(master["session_token"]),
    )
    ticket = ticket_resp.json()["ticket"]

    redirect_resp = await client.get(
        f"{PRACTICES_URL}/zoom/start",
        params={"ticket": ticket},
        follow_redirects=False,
    )
    assert redirect_resp.status_code == 307
    assert redirect_resp.headers["referrer-policy"] == "no-referrer"


@pytest.mark.asyncio
async def test_ticket_is_single_use(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Redeeming the same ticket twice: the second attempt must get the
    honest "expired" page, not a second redirect -- GETDEL semantics."""
    master = await _make_verified_master(client, db_session, telegram_id=99605)
    practice_id = await _create_and_publish_practice(client, master)

    ticket_resp = await client.post(
        f"{PRACTICES_URL}/{practice_id}/zoom/start-ticket",
        headers=auth_headers(master["session_token"]),
    )
    ticket = ticket_resp.json()["ticket"]

    first = await client.get(
        f"{PRACTICES_URL}/zoom/start", params={"ticket": ticket}, follow_redirects=False,
    )
    assert first.status_code == 307

    second = await client.get(
        f"{PRACTICES_URL}/zoom/start", params={"ticket": ticket}, follow_redirects=False,
    )
    assert second.status_code == 400
    assert "text/html" in second.headers["content-type"]
    assert "Ссылка устарела" in second.text


# ---------------------------------------------------------------------------
# 4. Zoom failure -- honest Russian page, never the raw exception
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_zoom_unreachable_returns_honest_russian_page_not_raw_error(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Zoom's GET /meetings/{id} failing must surface as a short Russian
    HTML message, never the raw ZoomAPIError text (which embeds
    status_code/body since 6b69cfe and would otherwise leak an English,
    API-shaped string to a human -- exactly the OWNER-2 failure mode this
    track must not repeat)."""
    master = await _make_verified_master(client, db_session, telegram_id=99606)
    practice_id = await _create_and_publish_practice(client, master)

    ticket_resp = await client.post(
        f"{PRACTICES_URL}/{practice_id}/zoom/start-ticket",
        headers=auth_headers(master["session_token"]),
    )
    ticket = ticket_resp.json()["ticket"]

    with patch(
        "app.modules.zoom.service.get_meeting",
        side_effect=ZoomAPIError(
            "Zoom API GET /meetings/x failed", status_code=404, body={"code": 3001},
        ),
    ):
        resp = await client.get(
            f"{PRACTICES_URL}/zoom/start", params={"ticket": ticket}, follow_redirects=False,
        )

    assert resp.status_code == 400
    assert "text/html" in resp.headers["content-type"]
    assert "Не удалось связаться с Zoom" in resp.text
    assert "3001" not in resp.text
    assert "ZoomAPIError" not in resp.text


@pytest.mark.asyncio
async def test_invalid_ticket_returns_honest_error_not_500(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A garbage/never-issued ticket must be the same honest "expired" page
    as a real expiry, not a 500 or a raw exception."""
    resp = await client.get(
        f"{PRACTICES_URL}/zoom/start",
        params={"ticket": "not-a-real-ticket"},
        follow_redirects=False,
    )
    assert resp.status_code == 400
    assert "Ссылка устарела" in resp.text
