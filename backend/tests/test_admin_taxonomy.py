# =============================================================================
# Test: Admin -- Taxonomy catalog CRUD (R5, batch R stage 2)
# =============================================================================
#
# telegram_id range: 58950-58969 (admin/non-admin auth checks).
#
# Test-created directions/styles are prefixed "zz_test_" and cleaned up
# before/after each test (real DB, not transactional -- TD-032: ORM delete,
# no raw SQL). Seeded rows (source='seed', e.g. "meditation") are never
# touched by cleanup.
# =============================================================================

from collections.abc import AsyncGenerator
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.practices.taxonomy_models import TaxonomyDirection, TaxonomyStyle
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user

TAXONOMY_URL = "/api/v1/admin/taxonomy"
DIRECTIONS_URL = f"{TAXONOMY_URL}/directions"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Remove test-created taxonomy rows (value prefix zz_test_) before/after."""
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    # full_cleanup_range rolls back first (TD-032) -- it MUST run before our
    # own deletes below, else it would discard them along with anything
    # pending from a previous failed test.
    await full_cleanup_range(session, 58950, 58969, delete_users=False)

    # Styles first (also covers zz_test_ styles under a real seeded direction,
    # e.g. "meditation" -- deleting the direction itself would be wrong there).
    await session.execute(
        delete(TaxonomyStyle).where(TaxonomyStyle.value.like("zz_test_%"))
    )
    # Direction delete cascades any remaining zz_test_ styles under it.
    await session.execute(
        delete(TaxonomyDirection).where(TaxonomyDirection.value.like("zz_test_%"))
    )
    await session.commit()


async def _make_admin(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = 58950,
) -> str:
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="TaxonomyAdmin"
    )
    await db_session.execute(
        update(User)
        .where(User.id == auth["user"]["id"])
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    return auth["session_token"]


async def _get_seed_direction_id(session: AsyncSession, value: str = "meditation") -> str:
    """Fetch a real seeded direction's id (created by the R5 migration)."""
    stmt = select(TaxonomyDirection.id).where(TaxonomyDirection.value == value)
    result = (await session.execute(stmt)).scalar_one_or_none()
    assert result is not None, f"seed direction '{value}' missing -- migration not applied?"
    return str(result)


# ---------------------------------------------------------------------------
# GET /admin/taxonomy -- auth + seed content
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_taxonomy_list_no_auth(client: AsyncClient) -> None:
    resp = await client.get(TAXONOMY_URL)
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_taxonomy_list_non_admin(client: AsyncClient) -> None:
    auth = await login_user(client, telegram_id=58951, first_name="NotAdmin")
    resp = await client.get(
        TAXONOMY_URL, headers=auth_headers(auth["session_token"])
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_taxonomy_list_returns_seed(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Seeded directions/styles are present, byte-identical values, source=seed."""
    token = await _make_admin(client, db_session)

    resp = await client.get(TAXONOMY_URL, headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()

    directions = {d["value"]: d for d in data["directions"]}
    # All 10 seeded directions present (core/config.py practice_allowed_directions).
    assert len(directions) >= 10
    for value in (
        "meditation", "yoga", "breathwork", "somatic", "tantra",
        "circles", "sound_healing", "art", "narrative", "movement",
    ):
        assert value in directions, f"seed direction '{value}' missing"
        assert directions[value]["source"] == "seed"
        assert directions[value]["is_active"] is True

    # Directions with styles carry the right style values (label spot-check).
    # Subset, not exact equality (PROMPT №411/№412): an admin can add a new
    # style under meditation via this very CRUD endpoint (that is R5's whole
    # point), so asserting the seed set is the WHOLE set fails the moment the
    # feature it's meant to guard actually gets used -- the identical bug
    # that took test_taxonomy.py's sibling test red.
    med_styles = {s["value"]: s["label"] for s in directions["meditation"]["styles"]}
    assert med_styles.items() >= {
        "silence": "Медитация молчания",
        "presence": "Медитация присутствия",
        "sound": "Звуковая медитация",
        "taoist": "Даосская медитация",
    }.items()
    # styles is always a list (never null/missing) -- a shape guarantee, not a
    # claim that breathwork (or any other named direction) can never gain one.
    for d in directions.values():
        assert isinstance(d["styles"], list)


# ---------------------------------------------------------------------------
# POST /admin/taxonomy/directions
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_direction_non_admin(client: AsyncClient) -> None:
    auth = await login_user(client, telegram_id=58952, first_name="NotAdmin")
    resp = await client.post(
        DIRECTIONS_URL,
        json={"value": "zz_test_dir1", "label": "Test Direction"},
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_create_direction_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    token = await _make_admin(client, db_session, telegram_id=58953)

    resp = await client.post(
        DIRECTIONS_URL,
        json={"value": "zz_test_dir2", "label": "Test Direction 2", "display_order": 99},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["value"] == "zz_test_dir2"
    assert data["label"] == "Test Direction 2"
    assert data["display_order"] == 99
    assert data["is_active"] is True
    assert data["source"] == "custom"
    assert data["styles"] == []


@pytest.mark.asyncio
async def test_create_direction_duplicate_value_400(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    token = await _make_admin(client, db_session, telegram_id=58954)

    body = {"value": "zz_test_dupdir", "label": "Dup Direction"}
    first = await client.post(
        DIRECTIONS_URL, json=body, headers=auth_headers(token),
    )
    assert first.status_code == 201

    second = await client.post(
        DIRECTIONS_URL, json=body, headers=auth_headers(token),
    )
    assert second.status_code == 400


@pytest.mark.asyncio
async def test_create_direction_invalid_value_422(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Value must match the slug pattern (lowercase, starts with a letter)."""
    token = await _make_admin(client, db_session, telegram_id=58955)

    resp = await client.post(
        DIRECTIONS_URL,
        json={"value": "Not A Slug!", "label": "Bad"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# PATCH /admin/taxonomy/directions/{id}
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_update_direction_partial(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    token = await _make_admin(client, db_session, telegram_id=58956)

    create_resp = await client.post(
        DIRECTIONS_URL,
        json={"value": "zz_test_upd1", "label": "Original Label", "display_order": 1},
        headers=auth_headers(token),
    )
    direction_id = create_resp.json()["id"]

    # Only send label -- display_order must be untouched (partial PATCH).
    patch_resp = await client.patch(
        f"{DIRECTIONS_URL}/{direction_id}",
        json={"label": "Updated Label"},
        headers=auth_headers(token),
    )
    assert patch_resp.status_code == 200
    data = patch_resp.json()
    assert data["label"] == "Updated Label"
    assert data["display_order"] == 1
    assert data["is_active"] is True


@pytest.mark.asyncio
async def test_deactivate_direction(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """is_active=false is the deactivate path -- row stays, still listed."""
    token = await _make_admin(client, db_session, telegram_id=58957)

    create_resp = await client.post(
        DIRECTIONS_URL,
        json={"value": "zz_test_deact", "label": "To Deactivate"},
        headers=auth_headers(token),
    )
    direction_id = create_resp.json()["id"]

    patch_resp = await client.patch(
        f"{DIRECTIONS_URL}/{direction_id}",
        json={"is_active": False},
        headers=auth_headers(token),
    )
    assert patch_resp.status_code == 200
    assert patch_resp.json()["is_active"] is False

    list_resp = await client.get(TAXONOMY_URL, headers=auth_headers(token))
    directions = {d["value"]: d for d in list_resp.json()["directions"]}
    assert "zz_test_deact" in directions
    assert directions["zz_test_deact"]["is_active"] is False


@pytest.mark.asyncio
async def test_update_direction_not_found_404(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    token = await _make_admin(client, db_session, telegram_id=58958)
    resp = await client.patch(
        f"{DIRECTIONS_URL}/{uuid4()}",
        json={"label": "Nope"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# POST /admin/taxonomy/directions/{id}/styles
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_style_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    token = await _make_admin(client, db_session, telegram_id=58959)
    direction_id = await _get_seed_direction_id(db_session, "meditation")

    resp = await client.post(
        f"{DIRECTIONS_URL}/{direction_id}/styles",
        json={"value": "zz_test_style1", "label": "Test Style"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["value"] == "zz_test_style1"
    assert data["direction_id"] == direction_id
    assert data["source"] == "custom"
    assert data["is_active"] is True


@pytest.mark.asyncio
async def test_create_style_direction_not_found_404(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    token = await _make_admin(client, db_session, telegram_id=58960)
    resp = await client.post(
        f"{DIRECTIONS_URL}/{uuid4()}/styles",
        json={"value": "zz_test_orphan", "label": "Orphan Style"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_create_style_duplicate_under_direction_400(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    token = await _make_admin(client, db_session, telegram_id=58961)
    direction_id = await _get_seed_direction_id(db_session, "yoga")

    body = {"value": "zz_test_dupstyle", "label": "Dup Style"}
    first = await client.post(
        f"{DIRECTIONS_URL}/{direction_id}/styles",
        json=body,
        headers=auth_headers(token),
    )
    assert first.status_code == 201

    second = await client.post(
        f"{DIRECTIONS_URL}/{direction_id}/styles",
        json=body,
        headers=auth_headers(token),
    )
    assert second.status_code == 400


# ---------------------------------------------------------------------------
# PATCH /admin/taxonomy/styles/{id}
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_update_style_partial_and_deactivate(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    token = await _make_admin(client, db_session, telegram_id=58962)
    direction_id = await _get_seed_direction_id(db_session, "circles")

    create_resp = await client.post(
        f"{DIRECTIONS_URL}/{direction_id}/styles",
        json={"value": "zz_test_style2", "label": "Original Style Label"},
        headers=auth_headers(token),
    )
    style_id = create_resp.json()["id"]

    patch_resp = await client.patch(
        f"{TAXONOMY_URL}/styles/{style_id}",
        json={"is_active": False},
        headers=auth_headers(token),
    )
    assert patch_resp.status_code == 200
    data = patch_resp.json()
    assert data["is_active"] is False
    assert data["label"] == "Original Style Label"  # untouched by partial PATCH


@pytest.mark.asyncio
async def test_update_style_not_found_404(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    token = await _make_admin(client, db_session, telegram_id=58963)
    resp = await client.patch(
        f"{TAXONOMY_URL}/styles/{uuid4()}",
        json={"label": "Nope"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 404
