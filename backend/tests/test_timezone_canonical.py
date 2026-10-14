# =============================================================================
# Test: canonical IANA time zone names (BE-157)
# =============================================================================
#
# A phone reports its zone under the browser's spelling ("Asia/Katmandu");
# the images we run know only the canonical one ("Asia/Kathmandu"). The
# backend stores the canonical name (app/core/timezones.py) -- for users and
# for practices -- and every name it can store must be known to the Postgres
# this suite runs against: on the stand that is the stand's own Postgres
# image, so the pg_timezone_names checks below are checks of the image.
#
# telegram_id range: 71300-71349
#   71301 -- user (profile timezone)
#   71302 -- master (practices)
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from importlib.resources import files
from uuid import UUID
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session_factory
from app.core.timezones import (
    UnknownTimezoneError,
    canonical_timezone,
    canonical_timezone_names,
)
from app.modules.masters.models import MasterProfile
from app.modules.practices.models import AudienceKind, Practice, PracticeType
from app.modules.users.models import User, UserRole
from tests.helpers import (
    auth_headers,
    fresh_execute,
    full_cleanup_range,
    login_user,
)

_TID_MIN = 71300
_TID_MAX = 71349
_TID_USER = 71301
_TID_MASTER = 71302

ME_URL = "/api/v1/users/me"
PRACTICES_URL = "/api/v1/practices"
DETAIL_URL = "/api/v1/practices/{practice_id}"

# The five old spellings V8 reports, and what is stored for each.
LEGACY = {
    "Asia/Katmandu": "Asia/Kathmandu",
    "Asia/Calcutta": "Asia/Kolkata",
    "Asia/Saigon": "Asia/Ho_Chi_Minh",
    "Asia/Rangoon": "Asia/Yangon",
    "Europe/Kiev": "Europe/Kyiv",
}

# Links that must NOT be rewritten: living country zones of zone.tab that
# IANA merged into a neighbour's rules (the picker offers all of these), and
# the server default.
KEPT = (
    "Europe/Amsterdam",
    "Europe/Oslo",
    "Europe/Stockholm",
    "Atlantic/Reykjavik",
    "UTC",
)

UNKNOWN = (
    "Mars/Base",
    "Asia",  # a directory of the zoneinfo tree: ZoneInfo raised OSError -> 500
    "asia/kathmandu",
    " UTC",
    "UTC ",
    "posix/Europe/Berlin",
    "right/UTC",
    "../etc/passwd",
)


def _tzdata_zi() -> tuple[set[str], dict[str, str]]:
    """Zones and links of the pinned package, read here independently."""
    zones: set[str] = set()
    links: dict[str, str] = {}
    body = files("tzdata").joinpath("zoneinfo/tzdata.zi").read_text(encoding="utf-8")
    for line in body.splitlines():
        parts = line.split()
        if parts and parts[0] == "Z":
            zones.add(parts[1])
        elif parts and parts[0] == "L":
            links[parts[2]] = parts[1]
    return zones, links


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
    await db_session.commit()


async def _master(client: AsyncClient, db_session: AsyncSession) -> dict:
    """A verified master with no confirmed methods (the taxonomy check
    fails open for an empty list -- practices/service.py)."""
    auth = await login_user(client, telegram_id=_TID_MASTER, first_name="Master")
    user = await db_session.get(User, UUID(auth["user"]["id"]))
    user.role = UserRole.MASTER
    db_session.add(
        MasterProfile(
            user_id=user.id,
            data={"account": {"status": "verified"}, "profile": {"bio": "m"}},
        )
    )
    await db_session.commit()
    return await login_user(client, telegram_id=_TID_MASTER, first_name="Master")


def _practice_body(**overrides: object) -> dict:
    body: dict = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Tz",
        "description": "x",
        "scheduled_at": (datetime.now(UTC) + timedelta(days=7)).isoformat(),
        "duration_minutes": 60,
        "timezone": "Europe/Moscow",
        "max_participants": 20,
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }
    body.update(overrides)
    return body


async def _stored_user_tz(telegram_id: int) -> str:
    return (
        await fresh_execute(
            select(User.timezone).where(User.telegram_id == telegram_id)
        )
    ).scalar_one()


async def _stored_practice_tz(practice_id: str) -> str:
    return (
        await fresh_execute(
            select(Practice.timezone).where(Practice.id == UUID(practice_id))
        )
    ).scalar_one()


# ===========================================================================
# 1. The function
# ===========================================================================


@pytest.mark.parametrize(("legacy", "canonical"), sorted(LEGACY.items()))
def test_old_spelling_is_rewritten(legacy: str, canonical: str) -> None:
    assert canonical_timezone(legacy) == canonical


@pytest.mark.parametrize("name", KEPT)
def test_country_links_and_utc_are_kept(name: str) -> None:
    assert canonical_timezone(name) == name


@pytest.mark.parametrize("name", UNKNOWN)
def test_unknown_forms_are_refused(name: str) -> None:
    with pytest.raises(UnknownTimezoneError):
        canonical_timezone(name)


def test_old_spellings_never_come_out_and_the_new_ones_do() -> None:
    """The pair: no old spelling among the outputs, every new one there,
    and the output set is not empty."""
    names = canonical_timezone_names()
    assert len(names) > 300
    assert not set(LEGACY) & names
    assert set(LEGACY.values()) <= names


def test_every_name_of_the_package_lands_on_an_output_in_one_step() -> None:
    """Every zone stays itself; every link resolves to an output, and the
    output resolves to itself (no chains, idempotent) -- across the WHOLE
    pinned tzdata, not five samples. A future tzdata with link chains or
    with a link pointing at a rewritten name fails here, by name."""
    zones, links = _tzdata_zi()
    assert zones and links
    names = canonical_timezone_names()
    for zone in zones:
        assert canonical_timezone(zone) == zone
    for alias in links:
        out = canonical_timezone(alias)
        assert out in names, alias
        assert canonical_timezone(out) == out, alias


def test_every_storable_name_loads_in_this_image() -> None:
    """Item 1 of BE-157: ZoneInfo finds the five old and the five new names
    in the image the suite runs in -- and every name we may store, since
    reminders, periods, series and MCP all call ZoneInfo(<stored name>)."""
    for legacy, canonical in LEGACY.items():
        assert ZoneInfo(legacy).utcoffset(datetime(2026, 1, 1)) is not None
        assert ZoneInfo(canonical).utcoffset(datetime(2026, 1, 1)) is not None
    for name in canonical_timezone_names():
        ZoneInfo(name)


# ===========================================================================
# 2. Users: PATCH /users/me
# ===========================================================================


@pytest.mark.parametrize(("legacy", "canonical"), sorted(LEGACY.items()))
async def test_profile_stores_and_returns_the_canonical_name(
    client: AsyncClient, legacy: str, canonical: str,
) -> None:
    auth = await login_user(client, telegram_id=_TID_USER)
    resp = await client.patch(
        ME_URL, headers=auth_headers(auth["session_token"]),
        json={"timezone": legacy},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["timezone"] == canonical
    assert await _stored_user_tz(_TID_USER) == canonical


async def test_onboarding_finish_with_an_old_spelling_completes(
    client: AsyncClient,
) -> None:
    """The stuck user's request: «Пропустить» / «Готово» send the device
    zone together with the onboarding flag."""
    auth = await login_user(client, telegram_id=_TID_USER)
    resp = await client.patch(
        ME_URL, headers=auth_headers(auth["session_token"]),
        json={"timezone": "Asia/Katmandu", "onboarding_completed": True},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["onboarding_completed"] is True
    assert resp.json()["timezone"] == "Asia/Kathmandu"


async def test_the_same_old_spelling_twice_stores_one_value(
    client: AsyncClient,
) -> None:
    auth = await login_user(client, telegram_id=_TID_USER)
    for _ in range(2):
        resp = await client.patch(
            ME_URL, headers=auth_headers(auth["session_token"]),
            json={"timezone": "Europe/Kiev"},
        )
        assert resp.status_code == 200, resp.text
    assert await _stored_user_tz(_TID_USER) == "Europe/Kyiv"


@pytest.mark.parametrize("name", UNKNOWN)
async def test_profile_refuses_an_unknown_name_and_keeps_the_old_one(
    client: AsyncClient, name: str,
) -> None:
    auth = await login_user(client, telegram_id=_TID_USER)
    token = auth["session_token"]
    ok = await client.patch(
        ME_URL, headers=auth_headers(token), json={"timezone": "Europe/Oslo"},
    )
    assert ok.status_code == 200, ok.text
    resp = await client.patch(
        ME_URL, headers=auth_headers(token), json={"timezone": name},
    )
    assert resp.status_code == 422, resp.text
    assert await _stored_user_tz(_TID_USER) == "Europe/Oslo"


# ===========================================================================
# 3. Practices: create and update
# ===========================================================================


async def test_practice_create_and_update_store_the_canonical_name(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _master(client, db_session)
    headers = auth_headers(master["session_token"])
    created = await client.post(
        PRACTICES_URL, headers=headers,
        json=_practice_body(timezone="Asia/Calcutta"),
    )
    assert created.status_code == 201, created.text
    practice_id = created.json()["id"]
    assert created.json()["timezone"] == "Asia/Kolkata"
    assert await _stored_practice_tz(practice_id) == "Asia/Kolkata"

    updated = await client.patch(
        DETAIL_URL.format(practice_id=practice_id), headers=headers,
        json={"timezone": "Asia/Saigon"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["timezone"] == "Asia/Ho_Chi_Minh"
    assert await _stored_practice_tz(practice_id) == "Asia/Ho_Chi_Minh"


async def test_practice_refuses_an_unknown_name_on_create_and_update(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    master = await _master(client, db_session)
    headers = auth_headers(master["session_token"])
    refused = await client.post(
        PRACTICES_URL, headers=headers, json=_practice_body(timezone="Asia"),
    )
    assert refused.status_code == 422, refused.text

    created = await client.post(
        PRACTICES_URL, headers=headers,
        json=_practice_body(timezone="Europe/Amsterdam"),
    )
    assert created.status_code == 201, created.text
    practice_id = created.json()["id"]
    resp = await client.patch(
        DETAIL_URL.format(practice_id=practice_id), headers=headers,
        json={"timezone": "Mars/Base"},
    )
    assert resp.status_code == 422, resp.text
    assert await _stored_practice_tz(practice_id) == "Europe/Amsterdam"


# ===========================================================================
# 4. Postgres of the stand
# ===========================================================================


async def test_postgres_knows_every_name_we_can_store() -> None:
    """BE-157 item 3, over the WHOLE output set: the backend reads its
    names from the PyPI tzdata, Postgres from the image's system tzdata
    (--with-system-tzdata). A name one has and the other lacks would be
    accepted by the validator and turn into a 500 in SQL."""
    pg_names = set(
        (await fresh_execute(text("SELECT name FROM pg_timezone_names"))).scalars()
    )
    assert "Asia/Kathmandu" in pg_names
    assert sorted(canonical_timezone_names() - pg_names) == []


@pytest.mark.parametrize("canonical", sorted(LEGACY.values()))
async def test_postgres_converts_in_each_canonical_zone(canonical: str) -> None:
    local = (
        await fresh_execute(
            text("SELECT timezone(:tz, now())"), {"tz": canonical},
        )
    ).scalar_one()
    assert local is not None


async def test_timezone_columns_hold_the_longest_name() -> None:
    """Measured on the schema, not on the models."""
    rows = (
        await fresh_execute(
            text(
                "SELECT table_name, character_maximum_length "
                "FROM information_schema.columns "
                "WHERE column_name = 'timezone' "
                "AND table_name IN ('users', 'practices')"
            )
        )
    ).all()
    assert {r[0] for r in rows} == {"users", "practices"}
    longest = max(len(n) for n in canonical_timezone_names())
    for table, limit in rows:
        assert limit is not None and limit >= longest, table


async def test_time_of_day_filter_for_a_viewer_who_came_with_an_old_name(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """The listing buckets by the VIEWER's zone in SQL. 03:00 UTC is 08:45 in
    Kathmandu: morning for this viewer, night in UTC."""
    master = await _master(client, db_session)
    async with get_session_factory()() as session:
        practice = Practice(
            master_id=UUID(master["user"]["id"]),
            title="Tz bucket",
            description="x",
            practice_type=PracticeType.LIVE.value,
            status="scheduled",
            scheduled_at=datetime(2031, 5, 6, 3, 0, tzinfo=UTC),
            duration_minutes=60,
            timezone="UTC",
            max_participants=20,
            current_participants=0,
            is_free=True,
            price_cents=0,
            currency="eur",
            audience_kind=AudienceKind.PUBLIC.value,
        )
        practice.set_jsonb(
            "data", {"taxonomy": {"direction": "yoga", "difficulty": "beginner"}},
        )
        session.add(practice)
        await session.commit()
        practice_id = str(practice.id)

    viewer = await login_user(client, telegram_id=_TID_USER)
    headers = auth_headers(viewer["session_token"])
    patched = await client.patch(
        ME_URL, headers=headers, json={"timezone": "Asia/Katmandu"},
    )
    assert patched.status_code == 200, patched.text

    async def ids(bucket: str) -> set[str]:
        resp = await client.get(
            PRACTICES_URL, headers=headers,
            params={"time_of_day": bucket, "master_id": master["user"]["id"]},
        )
        assert resp.status_code == 200, resp.text
        return {item["id"] for item in resp.json()["items"]}

    assert practice_id in await ids("morning")
    assert practice_id not in await ids("night")
