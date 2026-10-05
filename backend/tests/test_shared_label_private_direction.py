# =============================================================================
# VELO Backend -- Test: one label, two masters, two private rows (BE-38)
# =============================================================================
#
# telegram_id band: 68600-68699 (master A 68601, master B 68602,
# admin 68690). Declared module-level below as _TID_MIN/_TID_MAX, ONCE --
# tests/telegram_id_bands.py parses that declaration out of the AST on every
# run, and a file using ids without declaring a band fails
# test_blind_zone_has_not_grown. Checked free before it was claimed:
# free_windows(space=(68000, 68999)) returned [(68600, 68999)].
#
# THE STATE THIS FILE EXISTS FOR IS REACHABLE, and that is the whole point.
# BE-12 called it theoretical -- "the values are synthetic, you cannot guess
# one" -- and that was wrong, because nobody has to guess.
# _scope_custom_methods_to_master deduplicates a new private row against
# global rows and this master's own, and DELIBERATELY not against other
# masters' private rows, "which are none of this master's business and must
# not block them from getting their own row with the same text". So two
# masters who both write "Сказкотерапия" end up owning two different rows
# carrying one label -- by design, not by accident.
#
# The confirmed-methods gate then matched BY LABEL. Master B, holding
# "Сказкотерапия" among his own methods, could name master A's VALUE and be
# confirmed against his own label. The practice that came out pointed at a
# row B cannot see in his own catalog and that dies when A's row is
# deactivated. The damage is integrity, not privacy: B already knew the
# word, he typed it himself.
#
# WHAT IS ASSERTED IS WHICH GATE REFUSED, not merely that something did.
# After BE-38 a refusal can arrive from two different places for two
# different reasons, and a test that only reads the status code stays green
# while the wrong one fires -- the trap named in the handoff, and the same
# shape that nearly produced a false red in BE-12.
#
# THE MESSAGE IS THE ONLY DISCRIMINATOR, on purpose. Both refusals carry
# code="direction_not_confirmed", because from the master's side the
# direction really is not one of their methods and a third error code would
# give the frontend a distinction no human can see. That makes the wording
# below load-bearing: rephrasing it is a deliberate act, not a cleanup, and
# whoever finds this assertion brittle should read this paragraph before
# weakening it to the code alone.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.practices.taxonomy_models import TaxonomyDirection
from app.modules.users.models import User, UserRole
from tests.helpers import (
    auth_headers,
    fresh_execute,
    full_cleanup_range,
    login_user,
    switch_self_to_master,
)

APPLY_URL = "/api/v1/masters/apply"
VERIFY_URL = "/api/v1/admin/masters/{user_id}/verify"
SUBMIT_URL = "/api/v1/masters/me/method-change-request"
APPROVE_URL = "/api/v1/admin/masters/{user_id}/method-change-request/approve"
TAXONOMY_URL = "/api/v1/taxonomy"
PRACTICES_URL = "/api/v1/practices"

_TID_MIN = 68600
_TID_MAX = 68699

_TID_A = 68601
_TID_B = 68602
_TID_ADMIN = 68690

# The SAME text for both masters -- that is the premise, not a coincidence.
_LABEL = "Сказкотерапия БЕ-38 (общее название, разные строки)"


# ===========================================================================
# Local helpers. Copied rather than imported, the convention here.
# ===========================================================================


def _valid_apply_body() -> dict:
    return {
        "profile": {
            "display_name": "Shared Label Master",
            "email": "shared@test.com",
            "phone": "+1234567890",
        },
        "experience": {
            "methods": ["Медитация", "Йога"],
            "experience_years": 5,
            "bio": "Practicing for years.",
            "certifications": [],
        },
        "documents": [],
    }


async def _make_admin_auth(
    client: AsyncClient, db_session: AsyncSession,
) -> dict:
    await login_user(client, telegram_id=_TID_ADMIN, first_name="Admin")
    await db_session.execute(
        update(User)
        .where(User.telegram_id == _TID_ADMIN)
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    return await login_user(
        client, telegram_id=_TID_ADMIN, first_name="Admin",
    )


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    admin_auth: dict,
) -> dict:
    """Apply, verify, re-login -- a master with CONFIRMED methods.

    The non-empty methods list matters here as it did in BE-12:
    _assert_master_confirmed_taxonomy fails open on an empty one, so a
    shortcut fixture would make every refusal below unreachable and the
    file would pass while testing nothing.
    """
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )
    applied = await client.post(
        APPLY_URL,
        json=_valid_apply_body(),
        headers=auth_headers(auth["session_token"]),
    )
    assert applied.status_code in (200, 201), applied.text
    verified = await client.post(
        VERIFY_URL.format(user_id=auth["user"]["id"]),
        json={},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert verified.status_code == 200, verified.text
    await switch_self_to_master(client, auth["session_token"])
    return await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )


async def _grant_private_label(
    client: AsyncClient,
    master: dict,
    admin_auth: dict,
) -> None:
    """Request the shared label and have the admin grant it master_only."""
    submitted = await client.post(
        SUBMIT_URL,
        json={"proposed_methods": [_LABEL]},
        headers=auth_headers(master["session_token"]),
    )
    assert submitted.status_code in (200, 201), submitted.text
    approved = await client.post(
        APPROVE_URL.format(user_id=master["user"]["id"]),
        json={"master_only": [_LABEL]},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert approved.status_code == 200, approved.text


async def _own_row_value(master: dict) -> str:
    row = (
        await fresh_execute(
            select(TaxonomyDirection).where(
                TaxonomyDirection.label == _LABEL,
                TaxonomyDirection.master_id == master["user"]["id"],
            )
        )
    ).scalar_one()
    return row.value


def _practice_body(direction: str) -> dict:
    return {
        "practice_type": "live",
        "direction": direction,
        "difficulty": "beginner",
        "title": "Занятие по собственному методу",
        "description": "x",
        "scheduled_at": (
            datetime.now(UTC) + timedelta(days=8)
        ).isoformat(),
        "duration_minutes": 60,
        "timezone": "UTC",
        "max_participants": 20,
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }


# ===========================================================================
# Cleanup
# ===========================================================================


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    async def _wipe() -> None:
        await full_cleanup_range(
            db_session, _TID_MIN, _TID_MAX, delete_users=True,
        )
        await db_session.commit()

    await _wipe()
    yield
    await _wipe()


# ===========================================================================
# The case
# ===========================================================================


@pytest.mark.asyncio
async def test_a_shared_label_does_not_open_another_masters_direction(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """B holds the same word as A and still cannot use A's row.

    THE PREMISE IS ASSERTED BEFORE THE BEHAVIOUR: two rows, one label, two
    different values, one per master. If the dedup ever became global this
    assertion fails first and says so, instead of the refusal below quietly
    becoming untestable because there is only one row left to name.

    THE PAIR: B is refused A's value AND creates a practice in HIS OWN.
    Refusal alone would pass in a world where B cannot create anything --
    which is exactly what a too-eager scoping of the label lookup would
    produce.

    THE REFUSAL IS CHECKED BY GATE, not by status. Before BE-38 this same
    POST returned 201; after it, a 400 could still come from the wrong
    place -- from _validate_taxonomy, say, if somebody ever filtered the
    existence check too, which T21-6 forbids. The message names the branch
    that fired.
    """
    admin_auth = await _make_admin_auth(client, db_session)
    master_a = await _make_verified_master(
        client, db_session, _TID_A, admin_auth,
    )
    master_b = await _make_verified_master(
        client, db_session, _TID_B, admin_auth,
    )

    await _grant_private_label(client, master_a, admin_auth)
    await _grant_private_label(client, master_b, admin_auth)

    value_a = await _own_row_value(master_a)
    value_b = await _own_row_value(master_b)
    assert value_a != value_b, (
        "premise: the dedup must NOT collapse two masters onto one row"
    )

    # Neither sees the other's row -- the boundary at the catalog read.
    b_taxonomy = await client.get(
        TAXONOMY_URL, headers=auth_headers(master_b["session_token"]),
    )
    assert b_taxonomy.status_code == 200, b_taxonomy.text
    b_values = {d["value"] for d in b_taxonomy.json()["directions"]}
    assert value_b in b_values
    assert value_a not in b_values

    # B in his own direction: allowed.
    own = await client.post(
        PRACTICES_URL,
        json=_practice_body(value_b),
        headers=auth_headers(master_b["session_token"]),
    )
    assert own.status_code == 201, own.text

    # B in A's direction: refused, and by the gate that should refuse it.
    borrowed = await client.post(
        PRACTICES_URL,
        json=_practice_body(value_a),
        headers=auth_headers(master_b["session_token"]),
    )
    assert borrowed.status_code == 400, borrowed.text
    body = borrowed.json()
    assert body["error"] == "direction_not_confirmed", body
    assert "not in your catalog" in body["message"], body


@pytest.mark.asyncio
async def test_a_master_still_reaches_a_global_direction(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Scoping the label lookup must not cost anyone the shared catalog.

    A global row (master_id IS NULL) has to stay visible to the lookup for
    every master, or the new filter would quietly refuse every seed
    direction -- the failure mode with the widest blast radius in this
    delivery, and the cheapest to miss because the end-to-end test only
    walks private rows.

    "Медитация" is in the fixture's application, so it is among this
    master's confirmed methods and the gate has something to match.
    """
    admin_auth = await _make_admin_auth(client, db_session)
    master = await _make_verified_master(
        client, db_session, _TID_A, admin_auth,
    )

    created = await client.post(
        PRACTICES_URL,
        json=_practice_body("meditation"),
        headers=auth_headers(master["session_token"]),
    )
    assert created.status_code == 201, created.text
