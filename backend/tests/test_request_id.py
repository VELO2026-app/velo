# =============================================================================
# BE-190 -- the request id of protocol 9.6 (app/core/middleware.py)
# =============================================================================
#
# Replaces test_trace_id.py: X-Trace-ID is gone, the one id is request_id.
#
# What is pinned here:
#   - an incoming X-Request-ID of the form [A-Za-z0-9._-]{1,128} is kept;
#     absent, empty, too long or malformed -> a fresh uuid4; of several the
#     LAST one is judged, alone;
#   - the response carries exactly one X-Request-ID, and no X-Trace-ID;
#   - the id lives for the request only;
#   - CORS lets the frontend send it and read it back;
#   - every comms call carries it -- the request's, or a fresh one bound
#     for the call outside a request;
#   - every event of the comms stream carries it as the envelope's field,
#     and never inside `data`.
# =============================================================================

import json
from uuid import UUID

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import comms
from app.core.config import settings
from app.core.events.models import OutboxEvent
from app.core.events.relay import build_envelope
from app.core.events.service import EVENT_REMINDER_CANCEL, REQUEST_ID_KEY, emit_event
from app.core.middleware import (
    REQUEST_ID,
    REQUEST_ID_FORM,
    current_request_id,
    request_id_scope,
)

_REAL_CLIENT = httpx.AsyncClient


def _is_minted(value: str) -> bool:
    return str(UUID(value)) == value and len(value) == 36


async def _id_of(client: AsyncClient, headers: list[tuple[str, str | bytes]]) -> str:
    resp = await client.get("/", headers=headers)
    assert resp.status_code == 200
    echoed = resp.headers.get_list("x-request-id")
    assert len(echoed) == 1
    assert "x-trace-id" not in resp.headers
    return echoed[0]


# -- the incoming header ----------------------------------------------------------


@pytest.mark.parametrize(
    "value",
    [
        pytest.param("a", id="one-char"),
        pytest.param("svc.req-42_x", id="every-allowed-kind"),
        pytest.param("a" * 128, id="the-longest"),
    ],
)
async def test_a_well_formed_id_is_kept(client: AsyncClient, value: str) -> None:
    assert await _id_of(client, [("X-Request-ID", value)]) == value


@pytest.mark.parametrize(
    "headers",
    [
        pytest.param([], id="absent"),
        pytest.param([("X-Request-ID", "")], id="empty"),
        pytest.param([("X-Request-ID", "a" * 129)], id="one-over"),
        pytest.param([("X-Request-ID", "a b")], id="space"),
        pytest.param([("X-Request-ID", "a/b")], id="slash"),
        # Bytes: httpx sends a str header only as ASCII.
        pytest.param([("X-Request-ID", "ид".encode())], id="not-ascii"),
    ],
)
async def test_anything_else_gets_a_fresh_id(
    client: AsyncClient, headers: list[tuple[str, str | bytes]]
) -> None:
    got = await _id_of(client, headers)
    assert _is_minted(got)
    for _, sent in headers:
        assert got != sent


async def test_of_several_the_last_is_kept(client: AsyncClient) -> None:
    got = await _id_of(
        client, [("X-Request-ID", "first-1"), ("X-Request-ID", "last-2")]
    )
    assert got == "last-2"


async def test_a_malformed_last_is_not_replaced_by_an_earlier_one(
    client: AsyncClient,
) -> None:
    got = await _id_of(client, [("X-Request-ID", "good-1"), ("X-Request-ID", "b d")])
    assert got != "good-1"
    assert _is_minted(got)


async def test_the_old_header_is_not_read(client: AsyncClient) -> None:
    got = await _id_of(client, [("X-Trace-ID", "old-trace-1")])
    assert got != "old-trace-1"
    assert _is_minted(got)


async def test_each_request_gets_its_own_and_none_outlives_it(
    client: AsyncClient,
) -> None:
    ids = {await _id_of(client, []) for _ in range(3)}
    assert len(ids) == 3
    assert current_request_id() is None


# -- CORS: the frontend sends and reads it ------------------------------------------


async def test_the_frontend_may_send_and_read_it(client: AsyncClient) -> None:
    origin = settings.frontend_origin
    preflight = await client.options(
        "/",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "x-request-id",
        },
    )
    assert preflight.status_code == 200
    assert "x-request-id" in preflight.headers["access-control-allow-headers"].lower()

    resp = await client.get("/", headers={"Origin": origin})
    exposed = resp.headers["access-control-expose-headers"].lower()
    assert "x-request-id" in exposed
    assert resp.headers["x-request-id"]


# -- every comms call carries it ----------------------------------------------------


@pytest.fixture
def comms_calls(monkeypatch: pytest.MonkeyPatch) -> list[httpx.Request]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        # The id velo is serving at the moment comms answers.
        return httpx.Response(200, json={"seen_by_velo": current_request_id()})

    monkeypatch.setattr(settings, "comms_api_url", "http://comms.test")
    monkeypatch.setattr(settings, "comms_service_token", "token")
    monkeypatch.setattr(
        comms.httpx,
        "AsyncClient",
        lambda **kw: _REAL_CLIENT(transport=httpx.MockTransport(handler), **kw),
    )
    return seen


async def test_a_call_in_a_request_carries_the_requests_id(
    comms_calls: list[httpx.Request],
) -> None:
    token = REQUEST_ID.set("req-in-flight-7")
    try:
        await comms.comms_request("GET", "/api/v1/ping")
    finally:
        REQUEST_ID.reset(token)

    [call] = comms_calls
    assert call.headers.get_list("x-request-id") == ["req-in-flight-7"]


async def test_a_call_outside_a_request_gets_an_id_for_the_call(
    comms_calls: list[httpx.Request],
) -> None:
    assert current_request_id() is None

    answer = await comms.comms_request("GET", "/api/v1/ping")

    [call] = comms_calls
    sent = call.headers["x-request-id"]
    assert _is_minted(sent)
    # velo's own lines during the call carry the same id ...
    assert answer["seen_by_velo"] == sent
    # ... and it does not outlive the call.
    assert current_request_id() is None


def test_the_scope_keeps_a_requests_id() -> None:
    token = REQUEST_ID.set("outer-1")
    try:
        with request_id_scope() as inner:
            assert inner == "outer-1"
        assert current_request_id() == "outer-1"
    finally:
        REQUEST_ID.reset(token)


# -- every event of the stream carries it ---------------------------------------------


async def test_an_event_made_in_a_request_carries_its_id(
    db_session: AsyncSession,
) -> None:
    token = REQUEST_ID.set("req-event-3")
    try:
        row = await emit_event(
            db_session, EVENT_REMINDER_CANCEL, {"types": ["x"], "correlation": "c"}
        )
    finally:
        REQUEST_ID.reset(token)
    await db_session.rollback()

    envelope = build_envelope(row)
    assert envelope["request_id"] == "req-event-3"
    assert json.loads(envelope["data"]) == {
        "v": 1,
        "types": ["x"],
        "correlation": "c",
    }


async def test_an_event_made_outside_a_request_gets_its_own(
    db_session: AsyncSession,
) -> None:
    a = await emit_event(
        db_session, EVENT_REMINDER_CANCEL, {"types": ["x"], "correlation": "a"}
    )
    b = await emit_event(
        db_session, EVENT_REMINDER_CANCEL, {"types": ["x"], "correlation": "b"}
    )
    await db_session.rollback()

    ids = [build_envelope(row)["request_id"] for row in (a, b)]
    assert all(_is_minted(i) for i in ids)
    assert ids[0] != ids[1]
    # Minted when the event is made and kept with the row: every send of
    # it -- a retry, a requeue of a dead letter -- names the same id.
    assert build_envelope(a)["request_id"] == ids[0]
    assert a.payload[REQUEST_ID_KEY] == ids[0]


def test_a_row_without_one_gets_one_at_sending() -> None:
    """A row the key never existed for -- the production outbox moved to the
    machine -- still sends a well-formed id, and its data unchanged."""
    row = OutboxEvent(
        event_type=EVENT_REMINDER_CANCEL,
        payload={"v": 1, "types": ["x"], "correlation": "c"},
    )

    envelope = build_envelope(row)

    assert REQUEST_ID_FORM.fullmatch(envelope["request_id"])
    assert json.loads(envelope["data"]) == row.payload


async def test_the_data_may_not_carry_the_key(db_session: AsyncSession) -> None:
    with pytest.raises(ValueError, match=REQUEST_ID_KEY):
        await emit_event(
            db_session,
            EVENT_REMINDER_CANCEL,
            {"types": ["x"], "correlation": "c", REQUEST_ID_KEY: "forged"},
        )
