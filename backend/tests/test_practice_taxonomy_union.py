# =============================================================================
# Test: Practice taxonomy -- config+catalog UNION validation (T2, 2026-07-15)
# =============================================================================
#
# T2 unifies the two direction/style SSOTs: POST/PATCH /api/v1/practices now
# accept a value that is in settings.practice_allowed_* (config) OR the active
# DB catalog (practice_directions / practice_styles) -- union, never replace.
# See practices/service.py: _validate_taxonomy() / _validate_style_choice().
#
# Covers:
#   - a catalog-only direction is accepted (create + update)
#   - a catalog-only style under its direction is accepted (create + update,
#     including the PATCH branch where direction changes in the same request)
#   - a value in neither source is still REJECTED -- the guard still guards
#   - the config-only path is unchanged (pure-config pair still 201/200)
#   - the fallback: a catalog read failure degrades to "not found" -- it can
#     NEVER reject an already-config-valid value (checked first, unconditio-
#     nally, with zero DB access), and it never lets an unrelated exception
#     escape past the union check
#   - GET /api/v1/practices feed filter (T2 follow-up, 2026-07-15): direction/
#     style are NOT membership-validated there at all (practices/router.py) --
#     a filter is a query, not a security boundary, so a catalog-only value
#     is accepted and MATCHES, and a value in neither source is accepted too
#     but correctly returns an EMPTY result (no 422) via the existing `.in_()`
#     filter in list_public_practices().
#
# telegram_id range (own cleanup band, no overlap with other suites): 99500-99599.
# Catalog rows created here are prefixed "zz_test_" and cleaned up before/after
# each test (mirrors test_admin_taxonomy.py's convention) -- seeded rows
# (source='seed') are never touched.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError
from app.modules.practices.service import (
    _catalog_styles_for_direction,
    _direction_in_catalog,
    _validate_style_choice,
    _validate_taxonomy,
)
from app.modules.practices.taxonomy_models import TaxonomyDirection, TaxonomyStyle
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user, switch_self_to_master

PRACTICES_URL = "/api/v1/practices"
APPLY_URL = "/api/v1/masters/apply"
VERIFY_URL = "/api/v1/admin/masters/{user_id}/verify"

_MASTER_TID = 99501
_ADMIN_TID = 99590


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    await full_cleanup_range(session, 99500, 99599, delete_users=False)
    await session.execute(
        delete(TaxonomyStyle).where(TaxonomyStyle.value.like("zz_test_%"))
    )
    await session.execute(
        delete(TaxonomyDirection).where(TaxonomyDirection.value.like("zz_test_%"))
    )
    await session.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _valid_apply_body() -> dict:
    return {
        "profile": {"display_name": "Taxonomy Union Master", "email": "tunion@test.com"},
        "experience": {
            # T21-6/T21-7 (ПРОМТ №547/548): _assert_master_confirmed_taxonomy
            # requires the calling master to hold the exact direction/style
            # being created/updated. Widened to exactly what THIS file's own
            # tests exercise (yoga+kundalini/hatha/the catalog-only style,
            # the catalog-only direction bare and with its own catalog-only
            # style) -- raw VALUES, matching this fixture's own pre-existing
            # style and the value-canonical comparison chosen in ПРОМТ №547.
            # No bare "yoga" entry -- this file never creates a bare-style
            # yoga practice, unlike test_practices.py.
            "methods": [
                "meditation",
                "yoga — kundalini",
                "yoga — hatha",
                "yoga — zz_test_powerflow",
                "zz_test_therapy",
                "zz_test_therapy — zz_test_grounding",
            ],
            "experience_years": 5, "bio": "Practitioner",
        },
        "documents": [],
    }


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = _MASTER_TID,
) -> dict:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Master")
    await client.post(
        APPLY_URL, json=_valid_apply_body(), headers=auth_headers(auth["session_token"]),
    )

    await login_user(client, telegram_id=_ADMIN_TID, first_name="Admin")
    await db_session.execute(
        update(User).where(User.telegram_id == _ADMIN_TID).values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    admin_auth = await login_user(client, telegram_id=_ADMIN_TID, first_name="Admin")

    user_id = auth["user"]["id"]
    verify_resp = await client.post(
        VERIFY_URL.format(user_id=user_id), json={},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert verify_resp.status_code == 200

    await switch_self_to_master(client, auth["session_token"])
    return await login_user(client, telegram_id=telegram_id, first_name="Master")


def _valid_practice_body(**overrides: object) -> dict:
    base: dict = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Taxonomy Union Practice",
        "description": "Session",
        "scheduled_at": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
        "duration_minutes": 60,
        "timezone": "Europe/Moscow",
        "max_participants": 20,
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }
    base.update(overrides)
    return base


async def _add_catalog_direction(
    session: AsyncSession,
    value: str = "zz_test_therapy",
    label: str = "Test Therapy",
) -> UUID:
    """Insert an active, catalog-only direction (not in config). Returns its id."""
    direction = TaxonomyDirection(value=value, label=label, source="custom")
    session.add(direction)
    await session.flush()
    await session.commit()
    return direction.id


async def _get_seed_direction_id(session: AsyncSession, value: str = "yoga") -> UUID:
    stmt = select(TaxonomyDirection.id).where(TaxonomyDirection.value == value)
    result = (await session.execute(stmt)).scalar_one_or_none()
    assert result is not None, f"seed direction '{value}' missing -- migration not applied?"
    return result


async def _add_catalog_style(
    session: AsyncSession,
    direction_id: UUID,
    value: str = "zz_test_powerflow",
    label: str = "Test Powerflow",
) -> None:
    """Insert an active, catalog-only style (not in config) under a direction."""
    style = TaxonomyStyle(direction_id=direction_id, value=value, label=label, source="custom")
    session.add(style)
    await session.commit()


async def _create_and_publish(
    client: AsyncClient, auth: dict, **overrides: object,
) -> str:
    """Create a practice and transition it to scheduled (visible in the
    default feed, which only shows scheduled/live practices in the future)."""
    create = await client.post(
        PRACTICES_URL, json=_valid_practice_body(**overrides),
        headers=auth_headers(auth["session_token"]),
    )
    assert create.status_code == 201
    pid = create.json()["id"]
    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"status": "scheduled"},
        headers=auth_headers(auth["session_token"]),
    )
    assert patch.status_code == 200
    return pid


# ---------------------------------------------------------------------------
# Config-only path unchanged (sanity baseline)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_config_only_pair_unchanged(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A pure-config direction+style pair still creates fine post-refactor."""
    auth = await _make_verified_master(client, db_session)
    resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(direction="yoga", difficulty="high", style="kundalini"),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["direction"] == "yoga"
    assert data["style"] == "kundalini"


# ---------------------------------------------------------------------------
# Catalog-only DIRECTION accepted
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_catalog_only_direction_accepted(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A direction that exists ONLY in the DB catalog (not config) is accepted."""
    await _add_catalog_direction(db_session)
    auth = await _make_verified_master(client, db_session)

    resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(direction="zz_test_therapy", difficulty="beginner"),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 201
    assert resp.json()["direction"] == "zz_test_therapy"


@pytest.mark.asyncio
async def test_update_direction_to_catalog_only_accepted(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """PATCH direction to a catalog-only value is accepted."""
    await _add_catalog_direction(db_session)
    auth = await _make_verified_master(client, db_session)

    create = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(direction="meditation", difficulty="beginner"),
        headers=auth_headers(auth["session_token"]),
    )
    pid = create.json()["id"]

    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"direction": "zz_test_therapy"},
        headers=auth_headers(auth["session_token"]),
    )
    assert patch.status_code == 200
    assert patch.json()["direction"] == "zz_test_therapy"


# ---------------------------------------------------------------------------
# Catalog-only STYLE (under its direction) accepted
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_catalog_only_style_accepted(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A style that exists ONLY in the DB catalog, under a real direction, is
    accepted -- alongside that direction's existing config styles (union, not
    replace)."""
    yoga_id = await _get_seed_direction_id(db_session, "yoga")
    await _add_catalog_style(db_session, yoga_id)
    auth = await _make_verified_master(client, db_session)

    resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(
            direction="yoga", difficulty="beginner", style="zz_test_powerflow",
        ),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 201
    assert resp.json()["style"] == "zz_test_powerflow"


@pytest.mark.asyncio
async def test_update_style_catalog_only_without_direction_accepted(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """PATCH style only (no direction resent) to a catalog-only value valid
    for the STORED direction is accepted (W-1 stored-direction fallback,
    now checked via the union)."""
    yoga_id = await _get_seed_direction_id(db_session, "yoga")
    await _add_catalog_style(db_session, yoga_id)
    auth = await _make_verified_master(client, db_session)

    create = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(direction="yoga", difficulty="beginner", style="hatha"),
        headers=auth_headers(auth["session_token"]),
    )
    pid = create.json()["id"]

    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"style": "zz_test_powerflow"},
        headers=auth_headers(auth["session_token"]),
    )
    assert patch.status_code == 200
    assert patch.json()["style"] == "zz_test_powerflow"


@pytest.mark.asyncio
async def test_update_direction_and_catalog_style_together_accepted(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """PATCH direction+style together validates style against the NEW
    direction (not the stale stored one) -- a catalog-only direction paired
    with a catalog-only style under it, both introduced in the same request."""
    therapy_id = await _add_catalog_direction(db_session)
    await _add_catalog_style(db_session, therapy_id, value="zz_test_grounding")
    auth = await _make_verified_master(client, db_session)

    create = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(direction="meditation", difficulty="beginner"),
        headers=auth_headers(auth["session_token"]),
    )
    pid = create.json()["id"]

    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"direction": "zz_test_therapy", "style": "zz_test_grounding"},
        headers=auth_headers(auth["session_token"]),
    )
    assert patch.status_code == 200
    data = patch.json()
    assert data["direction"] == "zz_test_therapy"
    assert data["style"] == "zz_test_grounding"


# ---------------------------------------------------------------------------
# A value in NEITHER source is still rejected -- the guard still guards
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_direction_in_neither_rejected(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    auth = await _make_verified_master(client, db_session)
    resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(direction="zz_test_nonexistent", difficulty="beginner"),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_create_style_in_neither_rejected(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    auth = await _make_verified_master(client, db_session)
    resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(
            direction="yoga", difficulty="beginner", style="zz_test_nonexistent",
        ),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_update_direction_in_neither_rejected(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    auth = await _make_verified_master(client, db_session)
    create = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(direction="meditation", difficulty="beginner"),
        headers=auth_headers(auth["session_token"]),
    )
    pid = create.json()["id"]

    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"direction": "zz_test_nonexistent"},
        headers=auth_headers(auth["session_token"]),
    )
    assert patch.status_code == 400


# ---------------------------------------------------------------------------
# Fallback: a catalog read failure degrades to "not found", never propagates,
# and NEVER reaches the DB (let alone rejects) for an already-config-valid
# value (unit-level -- exercises _validate_taxonomy directly with a session
# whose .execute() raises, standing in for an unreadable/broken catalog).
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_config_valid_pair_survives_broken_catalog_session() -> None:
    """A config-valid direction+style never touches the DB at all, so a
    broken catalog session can't affect it -- config is checked first,
    unconditionally, for direction AND (independently) for style."""
    broken_session = AsyncMock()
    broken_session.execute.side_effect = RuntimeError("catalog unreachable")

    # Must not raise -- and broken_session.execute must never be called.
    await _validate_taxonomy("meditation", "silence", broken_session)
    broken_session.execute.assert_not_called()


@pytest.mark.asyncio
async def test_catalog_only_direction_degrades_to_rejected_on_read_failure() -> None:
    """A config-miss direction that would need the catalog degrades to
    BadRequestError (not the underlying exception) when the catalog is
    unreadable -- the same outcome as an empty/missing catalog row."""
    broken_session = AsyncMock()
    broken_session.execute.side_effect = RuntimeError("catalog unreachable")

    assert await _direction_in_catalog("zz_test_whatever", broken_session) is False
    with pytest.raises(BadRequestError):
        await _validate_taxonomy("zz_test_whatever", None, broken_session)


@pytest.mark.asyncio
async def test_catalog_only_style_degrades_to_rejected_on_read_failure() -> None:
    """Same degrade-safety for the style axis: a config-miss style whose
    catalog lookup errors is rejected, not propagated."""
    broken_session = AsyncMock()
    broken_session.execute.side_effect = RuntimeError("catalog unreachable")

    styles = await _catalog_styles_for_direction("yoga", broken_session)
    assert styles == set()
    with pytest.raises(BadRequestError):
        await _validate_style_choice("yoga", "zz_test_whatever", broken_session)


# ===========================================================================
# GET /api/v1/practices feed filter (T2 follow-up, 2026-07-15)
# ===========================================================================
#
# direction/style are NOT membership-validated on the feed filter at all
# (practices/router.py) -- neither against config nor the catalog. A filter
# is a query, not a security boundary: a catalog-only value is accepted and
# MATCHES; a value in NEITHER source is also accepted (no 422) and correctly
# returns an empty result, because list_public_practices() filters with a
# plain `.in_()` against the JSONB taxonomy that naturally matches nothing.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_feed_filter_catalog_only_direction_accepted_and_matches(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    await _add_catalog_direction(db_session)
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]

    await _create_and_publish(
        client, auth, direction="zz_test_therapy", difficulty="beginner", title="T",
    )
    await _create_and_publish(
        client, auth, direction="meditation", difficulty="beginner", title="M",
    )

    resp = await client.get(
        f"{PRACTICES_URL}?direction=zz_test_therapy&master_id={master_id}",
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["title"] == "T"


@pytest.mark.asyncio
async def test_feed_filter_catalog_only_style_accepted_and_matches(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    yoga_id = await _get_seed_direction_id(db_session, "yoga")
    await _add_catalog_style(db_session, yoga_id)
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]

    await _create_and_publish(
        client, auth, direction="yoga", style="zz_test_powerflow", title="P",
    )
    await _create_and_publish(
        client, auth, direction="yoga", style="hatha", title="H",
    )

    resp = await client.get(
        f"{PRACTICES_URL}?style=zz_test_powerflow&master_id={master_id}",
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["title"] == "P"


@pytest.mark.asyncio
async def test_feed_filter_direction_in_neither_source_is_empty_not_422(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A direction in neither config nor catalog is accepted (no 422) and
    correctly returns an empty result -- a filter is a query, not a guard."""
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    await _create_and_publish(client, auth, direction="meditation", title="M")

    resp = await client.get(
        f"{PRACTICES_URL}?direction=zz_test_nonexistent&master_id={master_id}",
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["total"] == 0


@pytest.mark.asyncio
async def test_feed_filter_style_in_neither_source_is_empty_not_422(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    await _create_and_publish(
        client, auth, direction="yoga", style="hatha", title="H",
    )

    resp = await client.get(
        f"{PRACTICES_URL}?style=zz_test_nonexistent&master_id={master_id}",
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["total"] == 0


@pytest.mark.asyncio
async def test_feed_filter_config_only_path_unchanged(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Sanity: a pure-config direction+style filter still works exactly as
    before -- dropping the membership check doesn't touch the happy path
    (already broadly covered by test_practices.py's filter suite, unmodified;
    this is the T2-scoped confirmation)."""
    auth = await _make_verified_master(client, db_session)
    master_id = auth["user"]["id"]
    await _create_and_publish(
        client, auth, direction="yoga", style="kundalini", title="K",
    )
    await _create_and_publish(
        client, auth, direction="meditation", title="M",
    )

    resp = await client.get(
        f"{PRACTICES_URL}?direction=yoga&style=kundalini&master_id={master_id}",
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["title"] == "K"
