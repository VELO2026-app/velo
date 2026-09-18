# =============================================================================
# VELO Backend -- Test: a master-scoped direction all the way to a practice
# (BE-12 part 1, GT-42)
# =============================================================================
#
# telegram_id band: 68500-68599 (master 68501, other master 68502,
# admin 68590). Declared module-level below as _TID_MIN/_TID_MAX, ONCE --
# tests/telegram_id_bands.py parses that declaration out of the AST on every
# run, and a file using ids without declaring a band fails
# test_blind_zone_has_not_grown. Checked free before it was claimed:
# free_windows(space=(68000, 68999)) returned [(68500, 68999)].
#
# WHY A WHOLE-PATH TEST EXISTS AT ALL. Every link of this feature is covered
# and the JOIN between links is not:
#
#   admin approves master_only   -- test_master_method_change.py
#   the scoped row is private    -- test_admin_masters.py
#   the catalog union            -- test_practice_taxonomy_union.py
#   the confirmed-taxonomy gate  -- test_master_confirmed_taxonomy.py
#
# Nobody walks "admin granted a private direction -> the master created a
# practice in it -> the practice exists". That is the class of defect this
# file is for: each link proven, the seam between them assumed.
#
# THE SEAM IS NARROWER THAN THE CARD SAYS, and it is worth knowing which
# part is new. test_admin_masters.py's
# test_master_only_direction_visible_to_owner_not_to_other_master ALREADY
# asserts step 3's pair -- visible to its owner, invisible to anyone else.
# What nothing covers is the last two links: the POST that uses the private
# direction, and the refusal of the same POST from another master.
#
# STEP 3 IS REPEATED HERE ANYWAY, AND THAT IS NOT A COPY. The existing test
# asserts visibility as a FACT ABOUT ONE LINK; this one asserts it as the
# INPUT STATE of the next step. The first fails when visibility breaks; this
# one fails when the seam breaks. A whole-path test that starts in the
# middle stops being one, and a month from now nobody would be able to say
# what it walks.
#
# A GREEN RUN IS A RESULT, NOT AN EMPTY DELIVERY. It means the code path is
# sound end to end, so the screenshot that started BE-12 is about the state
# of the data on the stand -- a specific request that was never approved, or
# approved into the catalog rather than to the master -- and part 2 should
# look there. A RED run means the opposite and stops the line: the fix is
# part 2, deliberately not in this delivery, because a repair and its test
# landing together make it impossible to say afterwards what was broken.
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
ME_URL = "/api/v1/masters/me"
TAXONOMY_URL = "/api/v1/taxonomy"
PRACTICES_URL = "/api/v1/practices"

_TID_MIN = 68500
_TID_MAX = 68599

_TID_MASTER = 68501
_TID_OTHER = 68502
_TID_ADMIN = 68590

# Synthetic on purpose: the test asserts it does not exist beforehand, so a
# word a real master might plausibly type would make that premise flaky.
_LABEL = "Сказкотерапия ГТ-42 (приватное направление)"


# ===========================================================================
# Local helpers. Copied rather than imported, the convention in every test
# file here -- and this file's fixtures differ from the originals in one
# load-bearing way, see _make_verified_master.
# ===========================================================================


def _valid_apply_body() -> dict:
    """A master application. `methods` is NOT decoration -- see below."""
    return {
        "profile": {
            "display_name": "Path Master",
            "email": "path@test.com",
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
    """Promote the band's admin id and return a fresh admin session."""
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

    THE NON-EMPTY METHODS LIST IS THE POINT, not scenery.
    _assert_master_confirmed_taxonomy FAILS OPEN when a master's
    profile.methods is empty -- a written decision, not an oversight, on
    the grounds that a really verified master always has at least one.
    A fixture that skipped the application would therefore let the OTHER
    master's POST through, and step 5 would report a defect that does not
    exist: a red run on a fixture's property rather than on the code's.

    The admin session is passed in rather than created here: each
    _make_admin_auth costs two of the five logins per sixty seconds that
    the auth rate limit allows one telegram_id, and this file builds two
    masters plus an approval.
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


async def _taxonomy_labels(client: AsyncClient, who: dict) -> set[str]:
    resp = await client.get(
        TAXONOMY_URL, headers=auth_headers(who["session_token"]),
    )
    assert resp.status_code == 200, resp.text
    return {d["label"] for d in resp.json()["directions"]}


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
# The path
# ===========================================================================


@pytest.mark.asyncio
async def test_a_privately_granted_direction_reaches_a_created_practice(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """All five links, on live data, in one test.

    1. a master asks for a method nobody has;
    2. the admin approves it as master_only -- through
       approve_method_change and NOT through verify_master, because that
       is the only door of the two that also writes profile.methods, and
       the confirmed-taxonomy gate in step 4 reads exactly that field.
       Through the other door steps 4 and 5 would meet the empty-methods
       fail-open and prove nothing;
    3. GET /taxonomy shows it to its owner AND NOT to the other master;
    4. POST /practices with it succeeds for the owner;
    5. the SAME POST from the other master is refused.

    STEPS 3 AND 5 ARE PAIRS AND BOTH HALVES LIVE HERE. "Mine is visible"
    without "theirs is not" passes in a world with no privacy at all;
    "my POST worked" without "theirs was refused" passes in a world with
    no gate. Split across two neighbouring tests they would both keep
    passing while the seam between them rotted.

    WHAT REFUSES THE OTHER MASTER, measured rather than assumed: the
    catalog lookups in practices/service.py do NOT filter by master, so
    _label_for_direction_value resolves the private row for anybody, the
    confirmed-methods comparison runs, and the other master's own methods
    do not contain this label. If those lookups ever gain a master filter,
    dir_label becomes None for the other master and the gate takes its
    fail-open branch instead -- which is why that "theoretical hole" must
    not be closed on its own. See the delivery report's observations.
    """
    admin_auth = await _make_admin_auth(client, db_session)

    premise = (
        await db_session.execute(
            select(TaxonomyDirection.id).where(
                TaxonomyDirection.label == _LABEL,
            )
        )
    ).scalars().all()
    assert premise == [], f"premise violated: {_LABEL!r} already exists"

    master = await _make_verified_master(
        client, db_session, _TID_MASTER, admin_auth,
    )
    other = await _make_verified_master(
        client, db_session, _TID_OTHER, admin_auth,
    )
    master_headers = auth_headers(master["session_token"])
    other_headers = auth_headers(other["session_token"])

    # The fixture's own premise, asserted rather than trusted: the other
    # master has confirmed methods, so the gate in step 5 will actually
    # run instead of failing open.
    other_me = await client.get(ME_URL, headers=other_headers)
    assert other_me.status_code == 200, other_me.text
    assert other_me.json()["methods"], "fail-open would make step 5 vacuous"

    # --- 1. the request -------------------------------------------------
    submitted = await client.post(
        SUBMIT_URL,
        json={"proposed_methods": [_LABEL]},
        headers=master_headers,
    )
    assert submitted.status_code in (200, 201), submitted.text

    # Before approval the direction exists for nobody -- the deliberate
    # part of the design the card's screenshot cannot distinguish from a
    # bug: the profile shows what the master TYPED, the selector shows
    # what is CONFIRMED.
    assert _LABEL not in await _taxonomy_labels(client, master)

    # --- 2. the approval, master_only ------------------------------------
    approved = await client.post(
        APPROVE_URL.format(user_id=master["user"]["id"]),
        json={"master_only": [_LABEL]},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "approved"

    row = (
        await fresh_execute(
            select(TaxonomyDirection).where(
                TaxonomyDirection.label == _LABEL,
            )
        )
    ).scalar_one()
    assert str(row.master_id) == master["user"]["id"]
    assert row.source == "custom"

    # --- 3. visible to its owner, invisible to the other -----------------
    assert _LABEL in await _taxonomy_labels(client, master)
    assert _LABEL not in await _taxonomy_labels(client, other)

    # --- 4. the owner creates a practice in it ---------------------------
    created = await client.post(
        PRACTICES_URL,
        json=_practice_body(row.value),
        headers=master_headers,
    )
    assert created.status_code == 201, created.text
    assert created.json()["direction"] == row.value

    # --- 5. the other master is refused the same direction ---------------
    refused = await client.post(
        PRACTICES_URL,
        json=_practice_body(row.value),
        headers=other_headers,
    )
    assert refused.status_code == 400, refused.text
    assert refused.json()["error"] == "direction_not_confirmed", refused.text
