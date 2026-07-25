# =============================================================================
# Test: Master-confirmed taxonomy check (T21-6 / T21-7 / T21-8)
# =============================================================================
#
# _assert_master_confirmed_taxonomy (practices/service.py) shipped in c2ef48c
# (T21-6) with ZERO test coverage of its own -- nothing asserted it ACCEPTS a
# direction/style a master genuinely holds, or REJECTS one they don't. ПРОМТ
# №547 traced its behavior by hand (fixing the mixed value/label storage
# format, T21-7) and ПРОМТ №548 (owner mandate) requires that trace to become
# a test that would FAIL if the rule were removed or either fix reverted.
#
# Each test goes through the real HTTP create/update endpoints (not a direct
# call to the underscore-prefixed function) -- proves the feature end to end,
# the same way a real master would hit it, not just that one internal helper
# returns the right boolean.
#
# NONE of these tests have been executed (local pytest is blocked). Each is
# traced by hand against the current code in this PR -- see the ПРОМТ №548
# report for the full trace of every test below. The deploy gate is their
# first real run.
#
# telegram_id range (own band, no overlap with any other suite): 99800-99899.
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, full_cleanup_range, login_user, switch_self_to_master

PRACTICES_URL = "/api/v1/practices"
APPLY_URL = "/api/v1/masters/apply"
VERIFY_URL = "/api/v1/admin/masters/{user_id}/verify"
SUBMIT_URL = "/api/v1/masters/me/method-change-request"
APPROVE_URL = "/api/v1/admin/masters/{user_id}/method-change-request/approve"

_MASTER_TID = 99801
_ADMIN_TID = 99890


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, 99800, 99899, delete_users=False)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, 99800, 99899, delete_users=False)
    await db_session.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _apply_body(methods: list[str]) -> dict:
    return {
        "profile": {"display_name": "Confirm Master", "email": "confirm@test.com"},
        "experience": {
            "methods": methods, "experience_years": 5, "bio": "Practitioner",
        },
        "documents": [],
    }


async def _make_admin_auth(client: AsyncClient, db_session: AsyncSession) -> dict:
    await login_user(client, telegram_id=_ADMIN_TID, first_name="Admin")
    await db_session.execute(
        update(User).where(User.telegram_id == _ADMIN_TID).values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    return await login_user(client, telegram_id=_ADMIN_TID, first_name="Admin")


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    methods: list[str],
    telegram_id: int = _MASTER_TID,
) -> dict:
    """Create a verified master confirmed for exactly `methods` (whatever
    format the caller passes -- raw value or composite label, per test)."""
    auth = await login_user(client, telegram_id=telegram_id, first_name="Master")
    await client.post(
        APPLY_URL,
        json=_apply_body(methods),
        headers=auth_headers(auth["session_token"]),
    )

    admin_auth = await _make_admin_auth(client, db_session)
    user_id = auth["user"]["id"]
    verify_resp = await client.post(
        VERIFY_URL.format(user_id=user_id),
        json={},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert verify_resp.status_code == 200

    await switch_self_to_master(client, auth["session_token"])
    return await login_user(client, telegram_id=telegram_id, first_name="Master")


async def _narrow_confirmed_methods(
    client: AsyncClient,
    db_session: AsyncSession,
    master: dict,
    new_methods: list[str],
) -> None:
    """Replace a verified master's confirmed methods via the REAL production
    write path (submit a method-change-request, admin approves it) -- not a
    hand-rolled JSONB edit. This is exactly how "a master's confirmed methods
    no longer cover an existing practice's direction" happens for real (the
    owner's own framing in ПРОМТ №547 Task 2): approve_method_change
    overwrites data.profile.methods verbatim (admin/masters/service.py:517),
    same mechanism test_master_method_change.py already exercises."""
    submit = await client.post(
        SUBMIT_URL,
        json={"proposed_methods": new_methods},
        headers=auth_headers(master["session_token"]),
    )
    assert submit.status_code == 201

    admin_auth = await _make_admin_auth(client, db_session)
    approve = await client.post(
        APPROVE_URL.format(user_id=master["user"]["id"]),
        json={},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert approve.status_code == 200


def _valid_practice_body(**overrides: object) -> dict:
    base: dict = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Confirm Practice",
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


# ---------------------------------------------------------------------------
# ACCEPTS -- both stored formats (T21-7, ПРОМТ №547)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_accepts_direction_confirmed_as_raw_catalog_value(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Tony's real production shape: methods=["yoga"], a raw catalog VALUE,
    no style. Creating a bare-yoga practice must succeed. Before T21-7 this
    was rejected unconditionally -- the label-only check compared the
    catalog label "Йога" against a list holding the raw value "yoga" and
    never matched, for ANY value-stored master."""
    auth = await _make_verified_master(client, db_session, methods=["yoga"])
    resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(direction="yoga"),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 201
    assert resp.json()["direction"] == "yoga"


@pytest.mark.asyncio
async def test_accepts_direction_and_style_confirmed_as_composite_label(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """JJ's real production shape: methods=["Йога — Кундалини-йога"], a
    frozen composite LABEL written by the wizard. Creating a yoga practice
    with style=kundalini must succeed -- the format this check was ORIGINALLY
    written for, and must keep accepting after the T21-7 fix."""
    auth = await _make_verified_master(
        client, db_session, methods=["Йога — Кундалини-йога"],
    )
    resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(direction="yoga", style="kundalini"),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 201
    assert resp.json()["style"] == "kundalini"


# ---------------------------------------------------------------------------
# REJECTS -- direction not held at all (T21-6, the whole point of the check)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_rejects_direction_master_does_not_hold_at_all(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A master confirmed ONLY for meditation cannot create a yoga practice.
    If _assert_master_confirmed_taxonomy were removed entirely (or its call
    site deleted from create_practice), this would 201 instead of 400."""
    auth = await _make_verified_master(client, db_session, methods=["meditation"])
    resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(direction="yoga"),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# The bare-direction / specific-style hierarchy is strict in BOTH directions
# -- deliberate design decision from ПРОМТ №547, not an accident of string
# matching. Each half gets its own test so a change to either direction of
# the rule fails exactly one of them, not both.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_bare_direction_confirmation_does_not_grant_any_specific_style(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Confirmed for bare "yoga" (no style at all) -- creating WITH a
    specific style (kundalini) must still be REJECTED. Holding a direction
    in general does not imply holding any particular style under it."""
    auth = await _make_verified_master(client, db_session, methods=["yoga"])
    resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(direction="yoga", style="kundalini"),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_style_specific_confirmation_does_not_grant_bare_parent_direction(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Confirmed ONLY for the composite "yoga — kundalini" (raw-value form)
    -- creating the SAME direction with NO style must still be REJECTED.
    The mirror image of the test above: a specific style confirmation does
    not widen back out to the bare parent direction."""
    auth = await _make_verified_master(
        client, db_session, methods=["yoga — kundalini"],
    )
    resp = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(direction="yoga"),
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# T21-8 (ПРОМТ №547 Task 2): validate on CHANGE, not on presence. This is the
# owner's exact scenario and the whole point of the distinction -- currently
# asserted nowhere else.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_update_resending_unchanged_now_unconfirmed_direction_succeeds(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """A practice is created while the master holds "yoga". Their confirmed
    methods are then narrowed to ["meditation"] only (a real approved
    method-change request -- yoga is no longer held). EditPracticeView-style
    resend of the practice's OWN unchanged direction/style (a title-only
    edit that still carries both fields in the PATCH body, exactly like
    EditPracticeView.vue:541-545) must SUCCEED -- T21-8 exists precisely so
    an unrelated field edit doesn't 400 just because direction/style were
    present in the request."""
    auth = await _make_verified_master(client, db_session, methods=["yoga"])
    create = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(direction="yoga", title="Original"),
        headers=auth_headers(auth["session_token"]),
    )
    assert create.status_code == 201
    pid = create.json()["id"]

    await _narrow_confirmed_methods(client, db_session, auth, ["meditation"])

    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"title": "Renamed", "direction": "yoga", "style": None},
        headers=auth_headers(auth["session_token"]),
    )
    assert patch.status_code == 200
    assert patch.json()["title"] == "Renamed"


@pytest.mark.asyncio
async def test_update_changing_to_unconfirmed_direction_fails(
    client: AsyncClient, db_session: AsyncSession,
) -> None:
    """Same narrowed-master setup as the test above, but this time the
    update actually CHANGES direction to something still unconfirmed -- must
    FAIL. The difference between this test and the one above IS the entire
    T21-8 owner decision: object on CHANGE, not on presence."""
    auth = await _make_verified_master(client, db_session, methods=["yoga"])
    create = await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(direction="yoga", title="Original"),
        headers=auth_headers(auth["session_token"]),
    )
    assert create.status_code == 201
    pid = create.json()["id"]

    await _narrow_confirmed_methods(client, db_session, auth, ["meditation"])

    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"direction": "breathwork"},
        headers=auth_headers(auth["session_token"]),
    )
    assert patch.status_code == 400
