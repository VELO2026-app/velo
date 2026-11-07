# =============================================================================
# BE-182 -- the instance options (app/core/options.py, core/config.py)
# =============================================================================
#
# What is pinned here:
#   - a flag is the string true or false, nothing else; prod may not turn
#     payments on; the variables of an option are not checked while it is
#     off, the machine's literal included;
#   - the census: every endpoint an option closes carries require_option
#     for it, derived from the routers -- and nothing else carries it;
#   - off -> 404 for anybody, unauthenticated included; on -> the endpoint
#     answers as before;
#   - payments off: no practice BECOMES paid (created paid, edited from free
#     to paid); an already paid practice is left alone;
#   - zoom off: a published practice gets no meeting row, and the client
#     refuses as a backstop;
#   - llm off: nothing is queued for translation, the sweep does nothing;
#   - /health details names the options on.
#
# telegram_id band: 96000-96049.
# =============================================================================

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import pytest
from fastapi.routing import APIRoute
from httpx import AsyncClient
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import OPTIONS, settings
from app.core.options import require_option
from app.main import app
from app.modules.ai.transcription_router import router as transcription_router
from app.modules.masters.finance_router import router as finance_router
from app.modules.mcp.router import router as mcp_router
from app.modules.payments.purchase_router import purchases_user_router
from app.modules.payments.purchase_router import router as purchase_router
from app.modules.payments.router import router as payments_router
from app.modules.payments.webhook_router import webhook_router
from app.modules.practices.models import Practice
from app.modules.practices.service import PAYMENTS_UNAVAILABLE
from app.modules.promos.router import router as promos_router
from app.modules.schools.router import member_router as schools_member_router
from app.modules.schools.router import router as schools_router
from app.modules.support import translation
from app.modules.withdrawals.router import router as withdrawals_router
from app.modules.zoom import zoom_client
from app.modules.zoom.models import ZoomMeeting
from tests.helpers import auth_headers, full_cleanup_range, login_user
from tests.helpers import switch_self_to_master
from tests.settings_instance import build_settings

_TID_MIN = 96000
_TID_MAX = 96049
_TID_MASTER = 96001
_TID_ADMIN = 96040

PRACTICES_URL = "/api/v1/practices"


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession):
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX)
    await db_session.commit()


# -- the flags -------------------------------------------------------------------


@pytest.mark.parametrize("value", ["yes", "1", "True", "TRUE", "on", "", "0"])
def test_a_flag_is_true_or_false_and_nothing_else(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    with pytest.raises(ValidationError, match="`true` or `false`"):
        build_settings(monkeypatch, option_llm=value)


@pytest.mark.parametrize(("value", "on"), [("true", True), ("false", False)])
def test_the_two_words_are_read(
    monkeypatch: pytest.MonkeyPatch, value: str, on: bool
) -> None:
    assert build_settings(monkeypatch, option_llm=value).option_on("llm") is on


def test_prod_may_not_turn_payments_on(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ValidationError, match="no payments on prod"):
        build_settings(monkeypatch, option_payments="true")
    # the same flag on another role starts; off on prod starts
    assert build_settings(
        monkeypatch, option_payments="true", server_role="test"
    ).option_payments
    assert not build_settings(monkeypatch, option_payments="false").option_payments


@pytest.mark.parametrize("value", ["", "primer-switched-off"])
def test_the_variables_of_an_off_option_are_not_checked(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    """zoom off: its variables may be empty or the machine's literal --
    neither is checked. On, an empty one is refused (test_config.py)."""
    s = build_settings(
        monkeypatch,
        option_zoom="false",
        zoom_account_id=value,
        zoom_sdk_client_secret=value,
    )
    assert not s.option_on("zoom")


def test_an_unknown_option_is_a_programming_error() -> None:
    with pytest.raises(KeyError):
        settings.option_on("meet")
    with pytest.raises(KeyError):
        require_option("meet")


def test_the_options_on_are_listed_sorted(monkeypatch: pytest.MonkeyPatch) -> None:
    s = build_settings(monkeypatch, option_mcp="false", option_llm="false")
    assert s.enabled_options == ["schools", "telegram", "zoom"]


# -- the census -------------------------------------------------------------------


def _routes(*routers) -> set[tuple[str, str]]:
    return {
        (r.path, m)
        for router in routers
        for r in router.routes
        if isinstance(r, APIRoute)
        for m in r.methods
    }


# What each option closes, from the routers themselves; single endpoints by
# path. telegram closes nothing (options_required).
CLOSED: dict[str, set[tuple[str, str]]] = {
    "payments": _routes(
        payments_router,
        webhook_router,
        purchase_router,
        purchases_user_router,
        withdrawals_router,
        promos_router,
        finance_router,
    ),
    "schools": _routes(schools_router, schools_member_router),
    "mcp": _routes(mcp_router),
    "llm": _routes(transcription_router)
    | {
        (
            "/api/v1/support/threads/{thread_id}/messages/{message_id}"
            "/translation/retry",
            "POST",
        )
    },
    "zoom": {
        ("/api/v1/practices/{practice_id}/zoom/retry", "POST"),
        ("/api/v1/practices/{practice_id}/zoom/sdk-join", "POST"),
    },
}


def _gated_by(route: APIRoute) -> set[str]:
    return {
        getattr(d.call, "option", None)
        for d in route.dependant.dependencies
        if getattr(d.call, "option", None)
    }


def _served_routes() -> list[APIRoute]:
    """Every APIRoute the app serves. app.routes is the wrong source here:
    this FastAPI keeps an included router as one _IncludedRouter entry
    (measured -- see test_schools_killswitch.py), so the walk opens each one
    (original_router) instead; the routers carry their full paths."""
    found: list[APIRoute] = []
    stack = list(app.router.routes)
    while stack:
        route = stack.pop()
        if isinstance(route, APIRoute):
            found.append(route)
        elif hasattr(route, "original_router"):
            stack.extend(route.original_router.routes)
    return found


def test_every_endpoint_of_an_option_is_closed_by_it_and_nothing_else() -> None:
    served = _served_routes()
    assert len(served) > 200  # the walk opened the included routers
    seen: dict[str, set[tuple[str, str]]] = {o: set() for o in OPTIONS}
    for route in served:
        for option in _gated_by(route):
            seen[option] |= {(route.path, m) for m in route.methods}
    for option, closed in CLOSED.items():
        assert closed, option  # the routers were found
        assert seen[option] == closed, option
    assert seen["telegram"] == set()
    assert all(seen[o] == set() for o in OPTIONS if o not in CLOSED)


# -- 404 off, as before on ----------------------------------------------------------


def _path(template: str) -> str:
    out = template
    while "{" in out:
        i, j = out.index("{"), out.index("}")
        out = out[:i] + str(uuid4()) + out[j + 1 :]
    return out


@pytest.mark.parametrize("option", sorted(CLOSED))
async def test_off_is_404_for_anybody_and_on_is_not(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, option: str
) -> None:
    for template, method in sorted(CLOSED[option]):
        monkeypatch.setattr(settings, f"option_{option}", False)
        off = await client.request(method, _path(template))
        monkeypatch.setattr(settings, f"option_{option}", True)
        on = await client.request(method, _path(template))
        assert off.status_code == 404, (template, method)
        assert off.json().get("error") == "not_found", (template, method)
        assert on.status_code != 404 or on.json().get("error") != "not_found", (
            template,
            method,
        )


# -- payments off: no practice becomes paid -------------------------------------------


async def _verified_master(client: AsyncClient, db_session: AsyncSession) -> str:
    auth = await login_user(client, telegram_id=_TID_MASTER)
    token = auth["session_token"]
    await client.post(
        "/api/v1/masters/apply",
        json={
            "profile": {"display_name": "Options Master", "email": "o@test.com"},
            "experience": {"methods": ["meditation"], "experience_years": 3},
        },
        headers=auth_headers(token),
    )
    await login_user(client, telegram_id=_TID_ADMIN, first_name="Admin")
    await db_session.execute(
        text(f"UPDATE users SET role = 'admin' WHERE telegram_id = {_TID_ADMIN}")
    )
    await db_session.commit()
    admin = await login_user(client, telegram_id=_TID_ADMIN, first_name="Admin")
    verified = await client.post(
        f"/api/v1/admin/masters/{auth['user']['id']}/verify",
        json={},
        headers=auth_headers(admin["session_token"]),
    )
    assert verified.status_code == 200, verified.text
    await switch_self_to_master(client, token)
    return (await login_user(client, telegram_id=_TID_MASTER))["session_token"]


def _body(**overrides: object) -> dict:
    body: dict = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Options practice",
        "description": "Guided session",
        "scheduled_at": (datetime.now(UTC) + timedelta(days=8)).isoformat(),
        "duration_minutes": 60,
        "timezone": "UTC",
        "max_participants": 20,
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }
    body.update(overrides)
    return body


async def test_payments_off_refuses_a_practice_becoming_paid(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = await _verified_master(client, db_session)
    headers = auth_headers(token)

    # on: a paid practice is created -- the "already paid" one below
    monkeypatch.setattr(settings, "option_payments", True)
    paid = await client.post(
        PRACTICES_URL, json=_body(is_free=False, price_cents=1500), headers=headers
    )
    assert paid.status_code == 201, paid.text
    free = await client.post(PRACTICES_URL, json=_body(), headers=headers)
    assert free.status_code == 201, free.text

    monkeypatch.setattr(settings, "option_payments", False)
    # created paid -> refused
    refused = await client.post(
        PRACTICES_URL, json=_body(is_free=False, price_cents=1500), headers=headers
    )
    assert refused.status_code == 409
    assert refused.json()["error"] == PAYMENTS_UNAVAILABLE
    # edited free -> paid -> refused, the practice unchanged
    edit = await client.patch(
        f"{PRACTICES_URL}/{free.json()['id']}",
        json={"is_free": False, "price_cents": 900},
        headers=headers,
    )
    assert edit.status_code == 409
    assert edit.json()["error"] == PAYMENTS_UNAVAILABLE
    # an already paid practice: its price and other fields still edit
    repriced = await client.patch(
        f"{PRACTICES_URL}/{paid.json()['id']}",
        json={"price_cents": 2000, "title": "Still paid"},
        headers=headers,
    )
    assert repriced.status_code == 200, repriced.text
    assert repriced.json()["price_cents"] == 2000
    # a free practice is created as before
    assert (
        await client.post(PRACTICES_URL, json=_body(), headers=headers)
    ).status_code == 201


# -- zoom off: no meeting --------------------------------------------------------------


async def test_zoom_off_publishes_without_a_meeting(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = await _verified_master(client, db_session)
    headers = auth_headers(token)
    monkeypatch.setattr(settings, "option_zoom", False)

    created = await client.post(PRACTICES_URL, json=_body(), headers=headers)
    assert created.status_code == 201, created.text
    practice_id = created.json()["id"]
    published = await client.patch(
        f"{PRACTICES_URL}/{practice_id}", json={"status": "scheduled"}, headers=headers
    )
    assert published.status_code == 200, published.text
    assert published.json()["status"] == "scheduled"

    rows = (
        await db_session.execute(
            select(ZoomMeeting).where(ZoomMeeting.practice_id == practice_id)
        )
    ).all()
    assert rows == []


async def test_zoom_off_a_series_gets_children_without_meetings(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Series children are made apart from the publish branch
    (practices/series_service.py) -- they get no meeting row either, and
    are still made."""
    token = await _verified_master(client, db_session)
    headers = auth_headers(token)
    monkeypatch.setattr(settings, "option_zoom", False)

    created = await client.post(
        PRACTICES_URL,
        json=_body(
            practice_type="series",
            recurrence={"period": "daily", "end": "after_count", "count": 3},
        ),
        headers=headers,
    )
    assert created.status_code == 201, created.text
    root_id = created.json()["id"]
    published = await client.patch(
        f"{PRACTICES_URL}/{root_id}", json={"status": "scheduled"}, headers=headers
    )
    assert published.status_code == 200, published.text

    children = (
        (
            await db_session.execute(
                select(Practice.id).where(Practice.parent_practice_id == UUID(root_id))
            )
        )
        .scalars()
        .all()
    )
    assert children  # the series was materialized
    meetings = (
        await db_session.execute(
            select(ZoomMeeting).where(
                ZoomMeeting.practice_id.in_([*children, UUID(root_id)])
            )
        )
    ).all()
    assert meetings == []


async def test_zoom_off_the_client_refuses(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "option_zoom", False)
    token = AsyncMock(side_effect=AssertionError("keys must not be read"))
    monkeypatch.setattr(zoom_client, "_get_access_token", token)
    with pytest.raises(zoom_client.ZoomAPIError, match="option zoom"):
        await zoom_client._request("GET", "/users/me")
    assert token.await_count == 0


# -- llm off: nothing queued ------------------------------------------------------------


async def test_llm_off_queues_nothing_and_sweeps_nothing(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "option_llm", False)
    factory = AsyncMock(side_effect=AssertionError("no session for an off sweep"))
    monkeypatch.setattr(translation, "get_session_factory", factory)

    queued = await translation.enqueue(
        db_session,
        pointer=None,  # type: ignore[arg-type]  # never reached
        message_id=uuid4(),
        direction="to_admin",
        locale="en",
        text="hello",
    )
    await translation.sweep()

    assert queued is False
    assert factory.call_count == 0


# -- /health -----------------------------------------------------------------------------


async def test_health_names_the_options_on(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "option_schools", False)
    doc = (await client.get("/health")).json()
    assert "schools" not in doc["details"]["options"]
    assert doc["details"]["options"] == settings.enabled_options
    assert doc["modules"] == ["ai"]
