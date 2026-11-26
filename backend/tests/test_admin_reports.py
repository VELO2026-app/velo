# =============================================================================
# Test: Admin Reports -- resolve, dismiss, listing (Phase 3.3)
# =============================================================================
#
# telegram_id ranges:
#   59200-59299 -- reporters
#   59300-59399 -- targets
#   59900-59999 -- admin users
# =============================================================================

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.masters.models import MasterProfile
from app.modules.practices.models import Practice, PracticeStatus, PracticeType
from app.modules.reports.models import Report
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, login_user, full_cleanup_range

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
REPORTS_URL = "/api/v1/reports"
ADMIN_REPORTS_URL = "/api/v1/admin/reports"
RESOLVE_URL = "/api/v1/admin/reports/{report_id}/resolve"
DISMISS_URL = "/api/v1/admin/reports/{report_id}/dismiss"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    """Clean all test data before/after each test (TD-032: ORM, no raw SQL)."""
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    """Full ORM cleanup for telegram_id 59200-59999."""
    await full_cleanup_range(session, 59200, 59999, delete_users=False)
    await session.commit()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
async def _make_admin(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int = 59900,
) -> str:
    """Create admin user, return token."""
    auth = await login_user(
        client, telegram_id=telegram_id, first_name="ReportAdmin"
    )
    await db_session.execute(
        update(User)
        .where(User.id == auth["user"]["id"])
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    return auth["session_token"]


async def _create_report(
    client: AsyncClient,
    reporter_tg_id: int,
    target_tg_id: int,
    reason: str = "Test reason",
) -> tuple[str, str, str]:
    """Create reporter + target + report.

    Returns (reporter_token, target_id, report_id).
    """
    reporter = await login_user(
        client, telegram_id=reporter_tg_id, first_name=f"Reporter{reporter_tg_id}"
    )
    target = await login_user(
        client, telegram_id=target_tg_id, first_name=f"Target{target_tg_id}"
    )

    resp = await client.post(
        REPORTS_URL,
        json={
            "target_type": "user",
            "target_id": target["user"]["id"],
            "reason": reason,
        },
        headers=auth_headers(reporter["session_token"]),
    )
    assert resp.status_code == 201

    return (
        reporter["session_token"],
        target["user"]["id"],
        resp.json()["id"],
    )


# ---------------------------------------------------------------------------
# GET /admin/reports -- auth checks
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_list_reports_no_auth(client: AsyncClient) -> None:
    """No token: 401."""
    resp = await client.get(ADMIN_REPORTS_URL)
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_list_reports_non_admin(client: AsyncClient) -> None:
    """Regular user: 403."""
    auth = await login_user(client, telegram_id=59200, first_name="NotAdmin")
    resp = await client.get(
        ADMIN_REPORTS_URL, headers=auth_headers(auth["session_token"])
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# GET /admin/reports -- listing
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_list_reports_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Admin can list reports with pagination."""
    token = await _make_admin(client, db_session)

    # Create a report.
    await _create_report(client, reporter_tg_id=59201, target_tg_id=59301)

    resp = await client.get(ADMIN_REPORTS_URL, headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()
    assert "items" in data
    assert "total" in data
    assert "limit" in data
    assert "offset" in data
    assert data["total"] >= 1


@pytest.mark.asyncio
async def test_list_reports_filter_status(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Filter by status returns only matching reports."""
    token = await _make_admin(client, db_session)

    # Create and resolve a report.
    _, _, report_id = await _create_report(
        client, reporter_tg_id=59202, target_tg_id=59302
    )
    resolve_url = RESOLVE_URL.format(report_id=report_id)
    await client.post(
        resolve_url,
        json={"resolution_note": "Resolved"},
        headers=auth_headers(token),
    )

    # Filter by pending -- resolved report should not appear.
    resp = await client.get(
        f"{ADMIN_REPORTS_URL}?status=pending",
        headers=auth_headers(token),
    )
    data = resp.json()
    for item in data["items"]:
        assert item["status"] == "pending"


@pytest.mark.asyncio
async def test_list_reports_filter_target_type(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Filter by target_type works."""
    token = await _make_admin(client, db_session)

    await _create_report(client, reporter_tg_id=59203, target_tg_id=59303)

    resp = await client.get(
        f"{ADMIN_REPORTS_URL}?target_type=user",
        headers=auth_headers(token),
    )
    data = resp.json()
    for item in data["items"]:
        assert item["target_type"] == "user"


# ---------------------------------------------------------------------------
# POST /admin/reports/{id}/resolve -- success
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_resolve_report_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Admin can resolve a pending report."""
    token = await _make_admin(client, db_session, telegram_id=59901)
    _, _, report_id = await _create_report(
        client, reporter_tg_id=59204, target_tg_id=59304
    )

    url = RESOLVE_URL.format(report_id=report_id)
    resp = await client.post(
        url,
        json={"resolution_note": "User warned"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "resolved"
    assert data["resolution_note"] == "User warned"
    assert data["resolved_by"] is not None
    assert data["resolved_at"] is not None


# ---------------------------------------------------------------------------
# POST /admin/reports/{id}/resolve -- no auth
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_resolve_report_no_auth(client: AsyncClient) -> None:
    """No token: 401."""
    url = RESOLVE_URL.format(report_id=uuid4())
    resp = await client.post(url, json={"resolution_note": "Test"})
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# POST /admin/reports/{id}/resolve -- not found
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_resolve_report_not_found(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Non-existent report: 404."""
    token = await _make_admin(client, db_session, telegram_id=59902)

    url = RESOLVE_URL.format(report_id=uuid4())
    resp = await client.post(
        url,
        json={"resolution_note": "Test"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# POST /admin/reports/{id}/resolve -- already resolved
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_resolve_already_resolved(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Resolving an already-resolved report: 409."""
    token = await _make_admin(client, db_session, telegram_id=59903)
    _, _, report_id = await _create_report(
        client, reporter_tg_id=59205, target_tg_id=59305
    )

    url = RESOLVE_URL.format(report_id=report_id)

    # First resolve -- success.
    resp1 = await client.post(
        url,
        json={"resolution_note": "Done"},
        headers=auth_headers(token),
    )
    assert resp1.status_code == 200

    # Second resolve -- conflict.
    resp2 = await client.post(
        url,
        json={"resolution_note": "Again"},
        headers=auth_headers(token),
    )
    assert resp2.status_code == 409


# ---------------------------------------------------------------------------
# POST /admin/reports/{id}/resolve -- empty note
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_resolve_empty_note(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Resolve without note: 422."""
    token = await _make_admin(client, db_session, telegram_id=59904)

    url = RESOLVE_URL.format(report_id=uuid4())
    resp = await client.post(
        url,
        json={"resolution_note": ""},
        headers=auth_headers(token),
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# POST /admin/reports/{id}/dismiss -- success
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_dismiss_report_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Admin can dismiss a pending report."""
    token = await _make_admin(client, db_session, telegram_id=59905)
    _, _, report_id = await _create_report(
        client, reporter_tg_id=59206, target_tg_id=59306
    )

    url = DISMISS_URL.format(report_id=report_id)
    resp = await client.post(
        url,
        json={"resolution_note": "Not a real issue"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "dismissed"


# ---------------------------------------------------------------------------
# POST /admin/reports/{id}/dismiss -- without note (optional)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_dismiss_without_note(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Dismiss without resolution_note (optional): 200."""
    token = await _make_admin(client, db_session, telegram_id=59906)
    _, _, report_id = await _create_report(
        client, reporter_tg_id=59207, target_tg_id=59307
    )

    url = DISMISS_URL.format(report_id=report_id)
    resp = await client.post(
        url,
        json={},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "dismissed"


# ---------------------------------------------------------------------------
# POST /admin/reports/{id}/dismiss -- already dismissed
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_dismiss_already_dismissed(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Dismissing an already-dismissed report: 409."""
    token = await _make_admin(client, db_session, telegram_id=59907)
    _, _, report_id = await _create_report(
        client, reporter_tg_id=59208, target_tg_id=59308
    )

    url = DISMISS_URL.format(report_id=report_id)

    # First dismiss -- success.
    resp1 = await client.post(url, json={}, headers=auth_headers(token))
    assert resp1.status_code == 200

    # Second dismiss -- conflict.
    resp2 = await client.post(url, json={}, headers=auth_headers(token))
    assert resp2.status_code == 409


# ---------------------------------------------------------------------------
# Lifecycle: resolve dismissed report (cross-state)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_resolve_dismissed_report(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Cannot resolve a dismissed report: 409."""
    token = await _make_admin(client, db_session, telegram_id=59908)
    _, _, report_id = await _create_report(
        client, reporter_tg_id=59209, target_tg_id=59309
    )

    # Dismiss first.
    dismiss_url = DISMISS_URL.format(report_id=report_id)
    resp1 = await client.post(dismiss_url, json={}, headers=auth_headers(token))
    assert resp1.status_code == 200

    # Try to resolve.
    resolve_url = RESOLVE_URL.format(report_id=report_id)
    resp2 = await client.post(
        resolve_url,
        json={"resolution_note": "Oops"},
        headers=auth_headers(token),
    )
    assert resp2.status_code == 409


# ---------------------------------------------------------------------------
# Names in a report (BE-258)
# ---------------------------------------------------------------------------
async def _login_named(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    first_name: str | None,
    last_name: str | None = None,
) -> str:
    """Create a user and give it exactly this account name; return its id."""
    auth = await login_user(client, telegram_id=telegram_id)
    await db_session.execute(
        update(User)
        .where(User.id == auth["user"]["id"])
        .values(first_name=first_name, last_name=last_name)
    )
    await db_session.commit()
    return auth["user"]["id"]


async def _report_row(
    db_session: AsyncSession,
    reporter_id: str,
    target_type: str,
    target_id: str,
) -> str:
    """Insert a report directly (the polymorphic target needs no row)."""
    report = Report(
        reporter_id=reporter_id,
        target_type=target_type,
        target_id=target_id,
        reason="Because",
    )
    db_session.add(report)
    await db_session.commit()
    return str(report.id)


async def _master_with_practice(
    client: AsyncClient,
    db_session: AsyncSession,
    telegram_id: int,
    profile_name: str | None,
    first_name: str | None = "Acct",
    last_name: str | None = "Master",
) -> tuple[str, str]:
    """A master (account name "Acct Master" unless given) with a practice
    titled "Evening Breathwork"; returns (master user id, practice id)."""
    master_id = await _login_named(
        client, db_session, telegram_id, first_name, last_name,
    )
    db_session.add(
        MasterProfile(
            user_id=master_id,
            data={"profile": {"display_name": profile_name}} if profile_name else {},
        )
    )
    practice = Practice(
        master_id=master_id,
        title="Evening Breathwork",
        description="x",
        practice_type=PracticeType.LIVE.value,
        status=PracticeStatus.SCHEDULED.value,
        scheduled_at=datetime.now(UTC) + timedelta(days=2),
        duration_minutes=60,
        timezone="UTC",
        max_participants=10,
        current_participants=0,
        is_free=True,
        price_cents=0,
        currency="eur",
        data={},
    )
    db_session.add(practice)
    await db_session.commit()
    return master_id, str(practice.id)


@pytest.mark.asyncio
async def test_list_reports_names_the_reporter_and_every_kind_of_target(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """BE-258: a row names its reporter and its target -- a person, a master
    (one rule with the rest of the admin: the account's first and last name,
    never the profile's display name), a practice by its title -- and a
    target that is gone, or a nameless person, reads as the fallback or null
    instead of failing the list."""
    token = await _make_admin(client, db_session)
    reporter = await _login_named(client, db_session, 59210, "Vera", "Reporter")
    nameless_reporter = await _login_named(client, db_session, 59211, None, None)
    person = await _login_named(client, db_session, 59310, "Pavel", "Target")
    carded_master, practice_id = await _master_with_practice(
        client, db_session, 59311, "Lotus Master",
    )
    nameless_master, _ = await _master_with_practice(
        client, db_session, 59312, None, first_name=None, last_name=None,
    )
    gone = str(uuid4())

    by_target = {
        person: await _report_row(db_session, reporter, "user", person),
        carded_master: await _report_row(db_session, reporter, "master", carded_master),
        nameless_master: await _report_row(
            db_session, reporter, "master", nameless_master,
        ),
        practice_id: await _report_row(db_session, reporter, "practice", practice_id),
        gone: await _report_row(db_session, nameless_reporter, "practice", gone),
    }

    resp = await client.get(
        ADMIN_REPORTS_URL, params={"limit": 100}, headers=auth_headers(token),
    )

    assert resp.status_code == 200
    rows = {item["id"]: item for item in resp.json()["items"]}
    named = {
        target: (rows[report_id]["reporter_name"], rows[report_id]["target_name"])
        for target, report_id in by_target.items()
    }
    assert named == {
        person: ("Vera Reporter", "Pavel Target"),
        carded_master: ("Vera Reporter", "Acct Master"),
        nameless_master: ("Vera Reporter", "Мастер"),
        practice_id: ("Vera Reporter", "Evening Breathwork"),
        gone: ("Участник", None),
    }
    assert rows[by_target[practice_id]]["target_type"] == "practice"


@pytest.mark.asyncio
@pytest.mark.parametrize("read", ["get", "resolve", "dismiss"])
async def test_report_card_and_decisions_carry_the_names(
    client: AsyncClient,
    db_session: AsyncSession,
    read: str,
) -> None:
    """BE-258: the card (GET /{id}) and the answers of resolve and dismiss
    name the reporter and the target as the list does, so a screen that
    swaps the row for the answer keeps the names."""
    token = await _make_admin(client, db_session)
    reporter = await _login_named(client, db_session, 59220, "Vera", "Reporter")
    target = await _login_named(client, db_session, 59320, "Pavel", "Target")
    report_id = await _report_row(db_session, reporter, "user", target)
    url = f"{ADMIN_REPORTS_URL}/{report_id}"

    if read == "get":
        resp = await client.get(url, headers=auth_headers(token))
    else:
        resp = await client.post(
            f"{url}/{read}",
            json={"resolution_note": "Handled"},
            headers=auth_headers(token),
        )

    assert resp.status_code == 200
    data = resp.json()
    assert (data["reporter_name"], data["target_name"]) == (
        "Vera Reporter", "Pavel Target",
    )
