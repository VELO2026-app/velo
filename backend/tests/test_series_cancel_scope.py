# =============================================================================
# Test: Practice Series -- cancel scope (E3, Batch 3)
# =============================================================================
#
# POST /practices/{id}/cancel gains an optional body {scope}:
#   - "this" (default, or no body) cancels only the addressed occurrence;
#   - "this_and_future" also cancels every LATER occurrence of the same series
#     that is still cancellable; a non-series practice behaves like "this";
#   - past / completed / already-cancelled occurrences are never touched.
#
# These tests assert WHICH occurrences flip to cancelled (the new scope logic).
# The refund / audit / diary mechanics of a single cancel are unchanged and stay
# covered by test_cancellation.py, which exercises cancel_practice with the
# default scope through the refactored _cancel_one core.
#
# telegram_id range (own cleanup band):
#   64001 -- master, 64900 -- admin
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.practices.models import Practice, PracticeStatus
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, login_user, full_cleanup_range, switch_self_to_master

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
PRACTICES_URL = "/api/v1/practices"
MY_PRACTICES_URL = "/api/v1/masters/me/practices"
APPLY_URL = "/api/v1/masters/apply"
VERIFY_URL = "/api/v1/admin/masters/{user_id}/verify"

_MASTER_TID = 64001
_ADMIN_TID = 64900
_UNSET = object()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean all test data before/after each test (ORM, no raw SQL)."""
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    """Full ORM cleanup for telegram_id 64000-64999."""
    await full_cleanup_range(session, 64000, 64999, delete_users=False)
    await session.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _valid_apply_body() -> dict:
    return {
        "profile": {"display_name": "Scope Master", "email": "scope@test.com"},
        "experience": {
            "methods": ["meditation"],
            "experience_years": 5,
            "bio": "Experienced practitioner",
        },
        "documents": [],
    }


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = _MASTER_TID,
) -> dict:
    """Create user, apply as master, verify via admin. Returns master auth."""
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )
    await client.post(
        APPLY_URL,
        json=_valid_apply_body(),
        headers=auth_headers(auth["session_token"]),
    )

    await login_user(client, telegram_id=_ADMIN_TID, first_name="Admin")
    await db_session.execute(
        update(User)
        .where(User.telegram_id == _ADMIN_TID)
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    admin_auth = await login_user(
        client, telegram_id=_ADMIN_TID, first_name="Admin",
    )

    user_id = auth["user"]["id"]
    verify_resp = await client.post(
        VERIFY_URL.format(user_id=user_id),
        json={},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert verify_resp.status_code == 200

    await switch_self_to_master(client, auth["session_token"])
    return await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )


def _valid_practice_body(**overrides: object) -> dict:
    """A valid CreatePracticeRequest body (UTC tz by default)."""
    base: dict = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Scope Practice",
        "description": "Guided session",
        "scheduled_at": (
            datetime.now(timezone.utc) + timedelta(days=8)
        ).isoformat(),
        "duration_minutes": 60,
        "timezone": "UTC",
        "max_participants": 20,
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }
    base.update(overrides)
    return base


async def _create_and_publish(
    client: AsyncClient,
    auth: dict,
    *,
    recurrence: dict | None = None,
    **overrides: object,
) -> str:
    """Create a practice (optionally a series) and publish it. Returns its id."""
    body = _valid_practice_body(**overrides)
    if recurrence is not None:
        body["recurrence"] = recurrence
        if "practice_type" not in overrides:
            body["practice_type"] = "series"
    create = await client.post(
        PRACTICES_URL,
        json=body,
        headers=auth_headers(auth["session_token"]),
    )
    assert create.status_code == 201, create.text
    pid = create.json()["id"]

    patch = await client.patch(
        f"{PRACTICES_URL}/{pid}",
        json={"status": "scheduled"},
        headers=auth_headers(auth["session_token"]),
    )
    assert patch.status_code == 200, patch.text
    return pid


async def _cancel(
    client: AsyncClient,
    auth: dict,
    practice_id: str,
    *,
    scope: object = _UNSET,
) -> object:
    """POST the cancel endpoint. scope omitted -> no body (default path)."""
    url = f"{PRACTICES_URL}/{practice_id}/cancel"
    headers = auth_headers(auth["session_token"])
    if scope is _UNSET:
        return await client.post(url, headers=headers)
    return await client.post(url, json={"scope": scope}, headers=headers)


async def _status_map(client: AsyncClient, auth: dict) -> dict[str, str]:
    """id -> status for all of the master's practices (root + children)."""
    resp = await client.get(
        f"{MY_PRACTICES_URL}?limit=100",
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    return {i["id"]: i["status"] for i in resp.json()["items"]}


async def _children_ids(
    client: AsyncClient, auth: dict, root_id: str,
) -> list[str]:
    """Child ids of a root, ordered by scheduled_at ascending."""
    resp = await client.get(
        f"{MY_PRACTICES_URL}?limit=100",
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 200
    kids = [
        i for i in resp.json()["items"]
        if i.get("parent_practice_id") == root_id
    ]
    kids.sort(key=lambda i: i["scheduled_at"])
    return [i["id"] for i in kids]


# ---------------------------------------------------------------------------
# scope = "this" (default / explicit)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_cancel_this_only_default_no_body(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """No body -> cancel only the addressed occurrence; siblings untouched."""
    auth = await _make_verified_master(client, db_session)
    root_id = await _create_and_publish(
        client, auth,
        recurrence={"period": "daily", "end": "after_count", "count": 4},
    )
    kids = await _children_ids(client, auth, root_id)
    assert len(kids) == 3

    resp = await _cancel(client, auth, root_id)
    assert resp.status_code == 200
    assert resp.json()["status"] == "cancelled"

    statuses = await _status_map(client, auth)
    assert statuses[root_id] == "cancelled"
    for kid in kids:
        assert statuses[kid] == "scheduled"


@pytest.mark.asyncio
async def test_cancel_explicit_this_scope(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An explicit scope='this' matches the default (only this occurrence)."""
    auth = await _make_verified_master(client, db_session)
    root_id = await _create_and_publish(
        client, auth,
        recurrence={"period": "daily", "end": "after_count", "count": 4},
    )
    kids = await _children_ids(client, auth, root_id)

    resp = await _cancel(client, auth, root_id, scope="this")
    assert resp.status_code == 200

    statuses = await _status_map(client, auth)
    assert statuses[root_id] == "cancelled"
    assert all(statuses[kid] == "scheduled" for kid in kids)


# ---------------------------------------------------------------------------
# scope = "this_and_future"
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_cancel_this_and_future_from_root(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """From the root, this_and_future cancels the entire series."""
    auth = await _make_verified_master(client, db_session)
    root_id = await _create_and_publish(
        client, auth,
        recurrence={"period": "daily", "end": "after_count", "count": 4},
    )
    kids = await _children_ids(client, auth, root_id)

    resp = await _cancel(client, auth, root_id, scope="this_and_future")
    assert resp.status_code == 200

    statuses = await _status_map(client, auth)
    assert statuses[root_id] == "cancelled"
    for kid in kids:
        assert statuses[kid] == "cancelled"


@pytest.mark.asyncio
async def test_cancel_this_and_future_from_middle_child(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """From a middle child, only that child + later occurrences are cancelled.

    Earlier occurrences (the root and prior children) stay scheduled.
    """
    auth = await _make_verified_master(client, db_session)
    root_id = await _create_and_publish(
        client, auth,
        recurrence={"period": "daily", "end": "after_count", "count": 4},
    )
    kids = await _children_ids(client, auth, root_id)  # [day1, day2, day3]
    assert len(kids) == 3

    # Cancel the 2nd child (day2) and everything after it.
    resp = await _cancel(client, auth, kids[1], scope="this_and_future")
    assert resp.status_code == 200

    statuses = await _status_map(client, auth)
    assert statuses[root_id] == "scheduled"   # earlier than the cut
    assert statuses[kids[0]] == "scheduled"   # earlier than the cut
    assert statuses[kids[1]] == "cancelled"   # the cut itself
    assert statuses[kids[2]] == "cancelled"   # later than the cut


@pytest.mark.asyncio
async def test_cancel_this_and_future_non_series_like_this(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A non-series practice with this_and_future cancels only itself."""
    auth = await _make_verified_master(client, db_session)
    pid = await _create_and_publish(client, auth)  # plain live practice

    resp = await _cancel(client, auth, pid, scope="this_and_future")
    assert resp.status_code == 200
    assert resp.json()["status"] == "cancelled"

    statuses = await _status_map(client, auth)
    assert statuses[pid] == "cancelled"


@pytest.mark.asyncio
async def test_cancel_this_and_future_skips_completed_and_cancelled(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Only cancellable later occurrences flip; completed/cancelled are left.

    Pre-set one child completed and another cancelled, then cancel the whole
    series from the root: those two keep their status, the remaining scheduled
    occurrence and the root are cancelled.
    """
    auth = await _make_verified_master(client, db_session)
    root_id = await _create_and_publish(
        client, auth,
        recurrence={"period": "daily", "end": "after_count", "count": 4},
    )
    kids = await _children_ids(client, auth, root_id)  # [day1, day2, day3]

    await db_session.execute(
        update(Practice)
        .where(Practice.id == UUID(kids[0]))
        .values(status=PracticeStatus.COMPLETED.value)
    )
    await db_session.execute(
        update(Practice)
        .where(Practice.id == UUID(kids[1]))
        .values(status=PracticeStatus.CANCELLED.value)
    )
    await db_session.commit()

    resp = await _cancel(client, auth, root_id, scope="this_and_future")
    assert resp.status_code == 200

    statuses = await _status_map(client, auth)
    assert statuses[root_id] == "cancelled"          # cancellable -> cancelled
    assert statuses[kids[0]] == "completed"          # left untouched
    assert statuses[kids[1]] == "cancelled"          # already cancelled
    assert statuses[kids[2]] == "cancelled"          # cancellable -> cancelled


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_cancel_invalid_scope_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An unknown scope value is a 422 (closed Literal vocabulary)."""
    auth = await _make_verified_master(client, db_session)
    pid = await _create_and_publish(client, auth)

    resp = await _cancel(client, auth, pid, scope="everything")
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_cancel_this_and_future_on_completed_root_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """this_and_future on an already-completed root is a 400 (not cancellable).

    The primary-occurrence status check runs before any scope fan-out, so a
    terminal root is rejected regardless of scope (W-2).
    """
    auth = await _make_verified_master(client, db_session)
    root_id = await _create_and_publish(
        client, auth,
        recurrence={"period": "daily", "end": "after_count", "count": 4},
    )
    # Drive the root to a terminal status directly (no finalize flow needed).
    await db_session.execute(
        update(Practice)
        .where(Practice.id == UUID(root_id))
        .values(status=PracticeStatus.COMPLETED.value)
    )
    await db_session.commit()

    resp = await _cancel(client, auth, root_id, scope="this_and_future")
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# SECURITY (C2): cross-tenant series cancel via forged parent_practice_id
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_this_and_future_cannot_cross_tenant_via_forged_parent(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A master must not cancel another master's series by pointing their
    own practice's parent_practice_id at the victim's series root.

    root_id in cancel_practice derives from parent_practice_id, which is
    client-influenceable. The sibling fan-out is scoped to the actor's OWN
    practices (Practice.master_id == user.id), so even a forged parent
    cancels nothing that is not the attacker's. We forge the parent at the
    DB level -- that is the strongest form of the attack (it models the
    schema hole AND any other route to a bad parent), and the fix must
    hold against it, not merely against the API.
    """
    attacker = await _make_verified_master(
        client, db_session, telegram_id=64001,
    )
    victim = await _make_verified_master(
        client, db_session, telegram_id=64002,
    )

    # Victim publishes a real 4-occurrence series.
    victim_root = await _create_and_publish(
        client, victim,
        recurrence={"period": "daily", "end": "after_count", "count": 4},
    )

    # Attacker publishes a lone practice, then forges its parent to point
    # at the victim's series root.
    attacker_practice = await _create_and_publish(client, attacker)
    await db_session.execute(
        update(Practice)
        .where(Practice.id == UUID(attacker_practice))
        .values(parent_practice_id=UUID(victim_root))
    )
    await db_session.commit()

    resp = await _cancel(
        client, attacker, attacker_practice, scope="this_and_future",
    )
    assert resp.status_code == 200

    # The victim's ENTIRE series is untouched: root + every child stays
    # in a live (non-cancelled) status.
    victim_map = await _status_map(client, victim)
    victim_ids = [victim_root, *await _children_ids(client, victim, victim_root)]
    assert len(victim_ids) == 4
    for pid in victim_ids:
        assert victim_map[pid] != PracticeStatus.CANCELLED.value

    # The attacker's own practice IS cancelled (their legitimate action).
    attacker_map = await _status_map(client, attacker)
    assert attacker_map[attacker_practice] == PracticeStatus.CANCELLED.value
