# =============================================================================
# VELO -- Tests: limits on the anonymous guest path (BE-66)
# =============================================================================
#
# telegram_id band: 60050-60099.
#
# BAND PROVENANCE. free_windows(space=(60050, 64999)) returned
# [(60050, 64999)] on 2026-09-24; 60100-64999 stays free.
#
# WHAT IS UNDER TEST
#
#   1. core/ratelimit.py: the TTL is set on the FIRST increment only, and a
#      source that is not a routable public address is passed, never keyed.
#   2. The two guest endpoints DEGRADE over the limit instead of refusing:
#      GET shows the page without a proposed name and writes nothing, POST
#      sends the guest to the shared registrant without calling Zoom.
#      Redis unreachable -> served unlimited (fail-open, guest path only).
#   3. The names ceiling per practice.
#   4. No pooled connection is held while Zoom is called, nor while the page
#      is drawn -- measured with pool.checkedout(), not assumed.
#   5. One rule for "is there a guest entry": a non-https shared URL no
#      longer shows a button that leads to "unavailable".
#
# ADDRESSES. The test client's peer is 127.0.0.1, which the middleware trusts
# as our proxy, so X-Forwarded-For carries the address. It must be GLOBAL:
# the documentation ranges (203.0.113.0/24, 198.51.100.0/24) are not
# is_global and would be passed through, not limited.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from redis.exceptions import ConnectionError as RedisConnectionError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from structlog.testing import capture_logs

from app.core import ratelimit
from app.core.config import settings
from app.core.database import get_engine
from app.core.ratelimit import count_in_window, limitable_source, over_source_limit
from app.core.redis import get_redis
from app.modules.masters.models import MasterProfile
from app.modules.practices import router as practices_router
from app.modules.practices.models import Practice, PracticeStatus
from app.modules.users.models import User, UserRole
from app.modules.zoom import service as zoom_service
from app.modules.zoom.models import ZoomGuestName, ZoomMeeting
from app.modules.zoom.service import (
    GuestEntryKind,
    ZoomEntryKind,
    ZoomEntryResolution,
    encode_practice_code,
    guest_entry,
)
from tests.helpers import auth_headers, full_cleanup_range, login_user

PRACTICES_URL = "/api/v1/practices"
_TID_MIN = 60050
_TID_MAX = 60099
_SHARED = "https://zoom.us/w/shared?tk=guest"


# Every address and probe key this file can make the limiter write. Cleanup
# DELETEs exactly these -- it used to SCAN the whole keyspace, three
# patterns, before and after every test: 1.3 s a call at 70 000 keys
# locally, linear in the key count, and the most likely cause of the stand's
# suite going from ~8 to ~24 minutes after BE-66.
_ADDRESSES = ("93.184.216.34", "1.1.1.1")
_RATE_KEYS = (
    *(f"{bucket}:{address}"
      for bucket in ("guest_view_src", "guest_enter_src")
      for address in _ADDRESSES),
    "be66_probe:ttl",
    "be66_probe:93.184.216.34",
)


@pytest.fixture
async def rate_keys() -> AsyncGenerator[None, None]:
    """This file's limiter keys, removed by name before and after."""
    await get_redis().delete(*_RATE_KEYS)
    yield
    await get_redis().delete(*_RATE_KEYS)


@pytest.fixture
async def cleanup(
    db_session: AsyncSession, rate_keys: None,
) -> AsyncGenerator[None, None]:
    """The band's rows plus the limiter keys. NOT autouse: the pure tests
    below (address classification, the guest_entry grid) touch neither the
    database nor Redis and should not pay for either. Every test that
    publishes a practice gets it through the `zoom` fixture."""
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


async def _keys_under(prefix: str) -> list[str]:
    """Every key under `prefix` -- a SCAN, kept for the two assertions that
    must see keys of ANY name (a limiter keying on the wrong thing would not
    use one of _RATE_KEYS). A large COUNT keeps it to a few round trips."""
    return [k async for k in get_redis().scan_iter(match=f"{prefix}*", count=10000)]


class _Zoom:
    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.checkedout_during: list[int] = []

    async def __call__(self, **kwargs: str) -> dict:
        self.calls.append(kwargs)
        self.checkedout_during.append(get_engine().pool.checkedout())
        n = len(self.calls)
        return {
            "registrant_id": f"reg-{n}",
            "join_url": f"https://us06web.zoom.us/w/g{n}?tk=x",
        }


@pytest.fixture
def zoom(monkeypatch: pytest.MonkeyPatch, cleanup: None) -> _Zoom:
    recorder = _Zoom()
    monkeypatch.setattr(zoom_service, "create_registrant", recorder)
    return recorder


def _from(address: str) -> dict[str, str]:
    return {"X-Forwarded-For": address}


async def _practice(
    client: AsyncClient, db_session: AsyncSession, telegram_id: int, zoom: _Zoom,
) -> tuple[str, str]:
    """Published through the API (real ACTIVE meeting from the stub path);
    publishing's own mints are cleared from the recorder."""
    auth = await login_user(client, telegram_id=telegram_id, first_name="Host")
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    user.role = UserRole.MASTER.value
    db_session.add(
        MasterProfile(user_id=user.id, data={"account": {"status": "verified"}})
    )
    await db_session.commit()
    headers = auth_headers(auth["session_token"])
    resp = await client.post(PRACTICES_URL, headers=headers, json={
        "practice_type": "live", "direction": "meditation",
        "difficulty": "beginner", "title": "Лимиты",
        "scheduled_at": (datetime.now(UTC) + timedelta(hours=48)).isoformat(),
        "duration_minutes": 60, "timezone": "Europe/Moscow",
        "is_free": True, "price_cents": 0, "currency": "eur",
    })
    assert resp.status_code == 201, resp.text
    practice_id = resp.json()["id"]
    publish = await client.patch(
        f"{PRACTICES_URL}/{practice_id}", json={"status": "scheduled"},
        headers=headers,
    )
    assert publish.status_code == 200, publish.text
    meeting = await _meeting(db_session, practice_id)
    meeting.shared_join_url = _SHARED
    await db_session.commit()
    zoom.calls.clear()
    zoom.checkedout_during.clear()
    return practice_id, encode_practice_code(UUID(practice_id))


async def _meeting(db_session: AsyncSession, practice_id: str) -> ZoomMeeting:
    return (
        await db_session.execute(
            select(ZoomMeeting).where(ZoomMeeting.practice_id == UUID(practice_id))
        )
    ).scalar_one()


async def _row_count(db_session: AsyncSession, practice_id: str) -> int:
    db_session.expire_all()
    return (
        await db_session.execute(
            select(func.count()).select_from(ZoomGuestName).where(
                ZoomGuestName.practice_id == UUID(practice_id),
            )
        )
    ).scalar_one()


# ===========================================================================
# 1. core/ratelimit.py
# ===========================================================================


@pytest.mark.parametrize(
    "source",
    [None, "", "127.0.0.1", "::1", "10.0.0.5", "192.168.1.1", "172.16.0.9",
     "203.0.113.7", "198.51.100.4", "not-an-ip"],
)
def test_non_public_sources_are_not_limitable(source: str | None) -> None:
    """THE EMPTINESS AXIS: our own infrastructure, documentation ranges and
    non-addresses are passed, never keyed (the 644-logins lesson)."""
    assert limitable_source(source) is False


@pytest.mark.parametrize("source", ["93.184.216.34", "2606:4700:4700::1111"])
def test_public_sources_are_limitable(source: str) -> None:
    """Pair to the test above: the check is not vacuously False."""
    assert limitable_source(source) is True


@pytest.mark.usefixtures("rate_keys")
@pytest.mark.asyncio
async def test_ttl_is_set_on_the_first_increment_only() -> None:
    """Lesson 1: a later hit must not slide the window forward. The TTL is
    shortened by hand after the first hit; a second hit leaves it short."""
    redis = get_redis()
    key = "be66_probe:ttl"
    assert await count_in_window(redis, key, 600) == 1
    assert 590 <= await redis.ttl(key) <= 600
    await redis.expire(key, 50)

    assert await count_in_window(redis, key, 600) == 2
    assert await redis.ttl(key) <= 50


@pytest.mark.usefixtures("rate_keys")
@pytest.mark.asyncio
async def test_unlimitable_source_writes_no_key_and_a_public_one_does() -> None:
    redis = get_redis()

    assert await over_source_limit(
        "be66_probe", "127.0.0.1", limit=0, window_seconds=60,
    ) == (False, 0)
    assert await _keys_under("be66_probe:") == []

    assert await over_source_limit(
        "be66_probe", "93.184.216.34", limit=0, window_seconds=60,
    ) == (True, 1)
    assert await redis.get("be66_probe:93.184.216.34") == "1"


# ===========================================================================
# 2. The guest endpoints degrade over the limit.
# ===========================================================================


@pytest.mark.asyncio
async def test_views_over_the_limit_show_no_name_and_write_nothing(
    client: AsyncClient, db_session: AsyncSession, zoom: _Zoom,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """REPEAT: N views claim N names, the (N+1)th writes nothing, still 200,
    and says so in the log with the address and which limit."""
    monkeypatch.setattr(settings, "guest_view_rate_limit", 2)
    practice_id, code = await _practice(client, db_session, 60050, zoom)

    for _ in range(2):
        resp = await client.get(f"/z/{code}/guest", headers=_from("93.184.216.34"))
        assert "guest_name_id" in resp.text
    with capture_logs() as logs:
        past = await client.get(f"/z/{code}/guest", headers=_from("93.184.216.34"))

    assert past.status_code == 200
    assert "guest_name_id" not in past.text
    assert "name='name'" in past.text
    assert await _row_count(db_session, practice_id) == 2
    hit = [e for e in logs if e["event"] == "guest_rate_limited"]
    assert hit and hit[0]["limit"] == "view"
    assert hit[0]["source"] == "93.184.216.34"
    assert hit[0]["log_level"] == "warning"


@pytest.mark.asyncio
async def test_another_address_has_its_own_bucket(
    client: AsyncClient, db_session: AsyncSession, zoom: _Zoom,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The limit names one source, not the practice."""
    monkeypatch.setattr(settings, "guest_view_rate_limit", 1)
    practice_id, code = await _practice(client, db_session, 60051, zoom)

    await client.get(f"/z/{code}/guest", headers=_from("93.184.216.34"))
    await client.get(f"/z/{code}/guest", headers=_from("93.184.216.34"))
    await client.get(f"/z/{code}/guest", headers=_from("1.1.1.1"))

    assert await _row_count(db_session, practice_id) == 2


@pytest.mark.asyncio
async def test_loopback_source_is_never_limited_and_never_keyed(
    client: AsyncClient, db_session: AsyncSession, zoom: _Zoom,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """THE EMPTINESS AXIS end to end. Pair: every view did its normal work."""
    monkeypatch.setattr(settings, "guest_view_rate_limit", 1)
    practice_id, code = await _practice(client, db_session, 60052, zoom)

    for _ in range(3):
        assert "guest_name_id" in (await client.get(f"/z/{code}/guest")).text

    assert await _row_count(db_session, practice_id) == 3
    assert await _keys_under("guest_view_src:") == []


@pytest.mark.asyncio
async def test_entries_over_the_limit_go_to_the_shared_registrant_without_zoom(
    client: AsyncClient, db_session: AsyncSession, zoom: _Zoom,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The typed name is lost on this path; the entry is not."""
    monkeypatch.setattr(settings, "guest_enter_rate_limit", 1)
    _, code = await _practice(client, db_session, 60053, zoom)

    first = await client.post(
        f"/z/{code}/guest", data={"name": "Марина"},
        headers=_from("93.184.216.34"), follow_redirects=False,
    )
    with capture_logs() as logs:
        second = await client.post(
            f"/z/{code}/guest", data={"name": "Марина"},
            headers=_from("93.184.216.34"), follow_redirects=False,
        )

    assert first.status_code == 303
    assert first.headers["location"] == "https://us06web.zoom.us/w/g1?tk=x"
    assert second.status_code == 303
    assert second.headers["location"] == _SHARED
    assert len(zoom.calls) == 1
    hit = [e for e in logs if e["event"] == "guest_rate_limited"]
    assert hit and hit[0]["limit"] == "enter"


@pytest.mark.asyncio
async def test_entry_over_the_limit_with_no_shared_link_is_an_honest_page(
    client: AsyncClient, db_session: AsyncSession, zoom: _Zoom,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "guest_enter_rate_limit", 0)
    practice_id, code = await _practice(client, db_session, 60054, zoom)
    meeting = await _meeting(db_session, practice_id)
    meeting.shared_join_url = None
    await db_session.commit()

    resp = await client.post(
        f"/z/{code}/guest", headers=_from("93.184.216.34"), follow_redirects=False,
    )

    assert resp.status_code == 200
    assert "Гостевой вход сейчас недоступен" in resp.text
    assert zoom.calls == []


class _DeadRedis:
    async def incr(self, key: str) -> int:
        raise RedisConnectionError("connection refused")


@pytest.mark.asyncio
async def test_unreachable_redis_serves_the_guest_unlimited(
    client: AsyncClient, db_session: AsyncSession, zoom: _Zoom,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """THE SHORTAGE AXIS: fail-open on the guest path. Pair: the view did
    claim, the entry did mint -- and the outage is in the log."""
    monkeypatch.setattr(ratelimit, "get_redis", lambda: _DeadRedis())
    practice_id, code = await _practice(client, db_session, 60055, zoom)

    with capture_logs() as logs:
        page = await client.get(f"/z/{code}/guest", headers=_from("93.184.216.34"))
        (shown,) = (
            await db_session.execute(
                select(ZoomGuestName).where(
                    ZoomGuestName.practice_id == UUID(practice_id),
                )
            )
        ).scalars().all()
        await db_session.commit()
        enter = await client.post(
            f"/z/{code}/guest", data={"guest_name_id": str(shown.id)},
            headers=_from("93.184.216.34"), follow_redirects=False,
        )

    assert "guest_name_id" in page.text
    assert await _row_count(db_session, practice_id) == 1
    assert enter.status_code == 303
    assert len(zoom.calls) == 1
    outages = [e for e in logs if e["event"] == "guest_rate_limit_unavailable"]
    assert {e["limit"] for e in outages} == {"view", "enter"}


@pytest.mark.asyncio
async def test_uninitialized_redis_is_a_programming_error_not_swallowed(
    client: AsyncClient, db_session: AsyncSession, zoom: _Zoom,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Only network failures fail open. get_redis() raising RuntimeError
    means the app never initialized its client -- that must surface."""
    _, code = await _practice(client, db_session, 60056, zoom)

    def not_initialized() -> None:
        raise RuntimeError("Redis client not initialized.")

    monkeypatch.setattr(ratelimit, "get_redis", not_initialized)

    with pytest.raises(RuntimeError, match="not initialized"):
        await client.get(f"/z/{code}/guest", headers=_from("93.184.216.34"))


# ===========================================================================
# 3. The names ceiling.
# ===========================================================================


@pytest.mark.asyncio
async def test_at_the_ceiling_an_empty_entry_takes_the_shared_registrant(
    client: AsyncClient, db_session: AsyncSession, zoom: _Zoom,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The page past the ceiling has no hidden id; an empty "Войти" from it
    cannot claim either, so it goes to the shared registrant without Zoom.
    Pair: a typed name from the same page still mints."""
    monkeypatch.setattr(settings, "zoom_guest_names_max_per_practice", 1)
    practice_id, code = await _practice(client, db_session, 60057, zoom)
    await client.get(f"/z/{code}/guest")

    with capture_logs() as logs:
        page = await client.get(f"/z/{code}/guest")
        empty = await client.post(f"/z/{code}/guest", follow_redirects=False)
    typed = await client.post(
        f"/z/{code}/guest", data={"name": "Марина"}, follow_redirects=False,
    )

    assert "guest_name_id" not in page.text
    assert empty.headers["location"] == _SHARED
    assert typed.headers["location"] == "https://us06web.zoom.us/w/g1?tk=x"
    assert len(zoom.calls) == 1
    assert await _row_count(db_session, practice_id) == 1
    capped = [e for e in logs if e["event"] == "guest_name_cap_reached"]
    assert capped and capped[0]["cap"] == 1


# ===========================================================================
# 4. No pooled connection across the Zoom call, nor across drawing the page.
# ===========================================================================


@pytest.mark.asyncio
async def test_no_connection_is_held_while_zoom_is_called(
    client: AsyncClient, db_session: AsyncSession, zoom: _Zoom,
) -> None:
    """Measured, not assumed: pool.checkedout() inside create_registrant
    equals the count before the request. Pair: the entry did mint, and the
    row did get the registrant through the separate short session."""
    practice_id, code = await _practice(client, db_session, 60058, zoom)
    await client.get(f"/z/{code}/guest")
    (row,) = (
        await db_session.execute(
            select(ZoomGuestName).where(
                ZoomGuestName.practice_id == UUID(practice_id),
            )
        )
    ).scalars().all()
    await db_session.commit()
    baseline = get_engine().pool.checkedout()

    resp = await client.post(
        f"/z/{code}/guest", data={"guest_name_id": str(row.id)},
        follow_redirects=False,
    )

    assert resp.status_code == 303
    assert zoom.checkedout_during == [baseline]
    db_session.expire_all()
    await db_session.refresh(row)
    assert row.zoom_registrant_id == "reg-1"


@pytest.mark.asyncio
async def test_the_name_is_committed_before_the_page_is_drawn(
    client: AsyncClient, db_session: AsyncSession, zoom: _Zoom,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """get_db_session commits AFTER the response is sent; the page must not
    show a name a failed commit never reserved. While the form is drawn the
    request's connection is already back in the pool -- i.e. the claim was
    committed. Pair: the drawn form does carry a claimed name."""
    _, code = await _practice(client, db_session, 60059, zoom)
    await db_session.commit()
    baseline = get_engine().pool.checkedout()
    seen: list[int] = []
    original = practices_router._guest_name_form

    def spying(code_: str, guest_name: ZoomGuestName | None) -> str:
        seen.append(get_engine().pool.checkedout())
        assert guest_name is not None
        return original(code_, guest_name)

    monkeypatch.setattr(practices_router, "_guest_name_form", spying)

    resp = await client.get(f"/z/{code}/guest")

    assert resp.status_code == 200
    assert seen == [baseline]


@pytest.mark.asyncio
async def test_failed_record_after_a_successful_mint_still_enters(
    client: AsyncClient, db_session: AsyncSession, zoom: _Zoom,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """THE SHORTAGE AXIS after the commit: the guest gets his personal link
    even if writing it down fails; the row stays "issued, not entered"."""
    practice_id, code = await _practice(client, db_session, 60060, zoom)
    await client.get(f"/z/{code}/guest")
    (row,) = (
        await db_session.execute(
            select(ZoomGuestName).where(
                ZoomGuestName.practice_id == UUID(practice_id),
            )
        )
    ).scalars().all()
    await db_session.commit()

    def broken_factory():
        raise OSError("database went away")

    monkeypatch.setattr(zoom_service, "get_session_factory", broken_factory)
    with capture_logs() as logs:
        resp = await client.post(
            f"/z/{code}/guest", data={"guest_name_id": str(row.id)},
            follow_redirects=False,
        )

    assert resp.status_code == 303
    assert resp.headers["location"] == "https://us06web.zoom.us/w/g1?tk=x"
    db_session.expire_all()
    await db_session.refresh(row)
    assert row.zoom_registrant_id is None
    assert any(e["event"] == "zoom_guest_registrant_record_failed" for e in logs)


# ===========================================================================
# 5. One rule for "is there a guest entry".
# ===========================================================================


_PLAIN = "http://zoom.us/w/x"


class _P:
    def __init__(self, status: str) -> None:
        self.status = status


@pytest.mark.parametrize(
    ("status", "url", "kind", "shared"),
    [
        (PracticeStatus.SCHEDULED.value, _SHARED, GuestEntryKind.NAMED, _SHARED),
        (PracticeStatus.SCHEDULED.value, None, GuestEntryKind.NAMED, None),
        (PracticeStatus.SCHEDULED.value, _PLAIN, GuestEntryKind.NAMED, None),
        (PracticeStatus.COMPLETED.value, _SHARED, GuestEntryKind.SHARED, _SHARED),
        (PracticeStatus.COMPLETED.value, None, GuestEntryKind.NONE, None),
        (PracticeStatus.COMPLETED.value, _PLAIN, GuestEntryKind.NONE, None),
    ],
    ids=["open+https", "open+none", "open+http", "closed+https", "closed+none",
         "closed+http"],
)
def test_guest_entry_grid(
    status: str, url: str | None, kind: GuestEntryKind, shared: str | None,
) -> None:
    entry = guest_entry(
        _P(status), ZoomEntryResolution(kind=ZoomEntryKind.GUEST, url=url),
    )
    assert entry.kind == kind
    assert entry.shared_url == shared


@pytest.mark.parametrize(
    "kind", [k for k in ZoomEntryKind if k != ZoomEntryKind.GUEST],
)
def test_no_guest_entry_unless_the_resolver_says_guest(kind: ZoomEntryKind) -> None:
    entry = guest_entry(
        _P(PracticeStatus.SCHEDULED.value),
        ZoomEntryResolution(kind=kind, url=_SHARED),
    )
    assert entry.kind == GuestEntryKind.NONE


@pytest.mark.asyncio
async def test_non_https_shared_link_shows_no_button_and_no_dead_end(
    client: AsyncClient, db_session: AsyncSession, zoom: _Zoom,
) -> None:
    """The fifth cell, gone by construction: past the naming window with a
    non-https shared URL, the landing and the guest page agree -- no button,
    and the guest page is the honest sentence, not a redirect."""
    practice_id, code = await _practice(client, db_session, 60061, zoom)
    meeting = await _meeting(db_session, practice_id)
    meeting.shared_join_url = "http://zoom.us/w/plain"
    practice = await db_session.get(Practice, UUID(practice_id))
    practice.status = PracticeStatus.COMPLETED.value
    await db_session.commit()

    landing = await client.get(f"/z/{code}")
    guest = await client.get(f"/z/{code}/guest", follow_redirects=False)

    assert f"/z/{code}/guest" not in landing.text
    assert "Гостевой вход сейчас недоступен" in landing.text
    assert guest.status_code == 200
    assert "Гостевой вход сейчас недоступен" in guest.text
