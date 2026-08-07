# =============================================================================
# Test: Masters Module — application flow
# =============================================================================
# Post-HTTP DB reads go through tests.helpers.fresh_get / fresh_execute
# (T-19 convention -- see the docstring there for the flake AND the lie it kills).

import copy
from collections.abc import AsyncGenerator

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from tests.helpers import auth_headers, fresh_execute, fresh_get, full_cleanup_range, login_user


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

APPLY_URL = "/api/v1/masters/apply"


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
    """Full ORM cleanup for telegram_id 55000-55999."""
    await full_cleanup_range(session, 55000, 55999, delete_users=False)
    await session.commit()

def _valid_apply_body() -> dict:
    """Minimal valid application payload."""
    return {
        "profile": {
            "display_name": "Test Master",
            "email": "master@test.com",
            "phone": "+1234567890",
        },
        "experience": {
            "methods": ["meditation"],
            "experience_years": 3,
            "bio": "Experienced meditation teacher",
            "certifications": ["Cert A"],
        },
        "documents": [
            {"type": "certificate", "number": "ABC-123"},
        ],
    }


# ---------------------------------------------------------------------------
# POST /masters/apply — success
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_apply_master_success(client: AsyncClient) -> None:
    """User can submit a master application."""
    auth = await login_user(client, telegram_id=55001, first_name="Applicant")
    token = auth["session_token"]

    response = await client.post(
        APPLY_URL,
        json=_valid_apply_body(),
        headers=auth_headers(token),
    )

    assert response.status_code == 201
    data = response.json()
    assert data["status"] == "pending"
    assert data["user_id"] == auth["user"]["id"]


# ---------------------------------------------------------------------------
# POST /masters/apply — duplicate (already pending)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_apply_master_already_pending(client: AsyncClient) -> None:
    """Second application while pending → 409 Conflict."""
    auth = await login_user(client, telegram_id=55002, first_name="Duplicate")
    token = auth["session_token"]

    # First application.
    resp1 = await client.post(
        APPLY_URL,
        json=_valid_apply_body(),
        headers=auth_headers(token),
    )
    assert resp1.status_code == 201

    # Second application — should fail.
    resp2 = await client.post(
        APPLY_URL,
        json=_valid_apply_body(),
        headers=auth_headers(token),
    )
    assert resp2.status_code == 409


# ---------------------------------------------------------------------------
# POST /masters/apply — reapply after rejection
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_apply_master_reapply_after_rejection(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Rejected user can reapply — profile is updated, not duplicated."""
    auth = await login_user(client, telegram_id=55003, first_name="Rejected")
    token = auth["session_token"]

    # First application.
    resp1 = await client.post(
        APPLY_URL,
        json=_valid_apply_body(),
        headers=auth_headers(token),
    )
    assert resp1.status_code == 201

    # Simulate admin rejection using set_jsonb (deep copy to avoid
    # SQLAlchemy shallow-reference tracking issues).
    user_id = auth["user"]["id"]
    stmt = select(MasterProfile).where(
        MasterProfile.user_id == user_id
    )
    result = await db_session.execute(stmt)
    profile = result.scalar_one()

    rejected_data = copy.deepcopy(profile.data)
    rejected_data["account"]["status"] = "rejected"
    rejected_data["account"]["rejected_at"] = "2026-02-09T00:00:00Z"
    rejected_data["account"]["rejection_reason"] = "Not enough experience"
    profile.set_jsonb("data", rejected_data)
    await db_session.commit()

    # Reapply with updated info.
    new_body = _valid_apply_body()
    new_body["experience"]["experience_years"] = 10
    new_body["experience"]["bio"] = "Now with more experience"

    resp2 = await client.post(
        APPLY_URL,
        json=new_body,
        headers=auth_headers(token),
    )
    assert resp2.status_code == 201
    assert resp2.json()["status"] == "pending"

    # Verify rejection history is preserved.
    profile = await fresh_get(MasterProfile, profile.user_id)
    rejections = profile.data["account"]["rejections"]
    assert len(rejections) == 1
    assert rejections[0]["reason"] == "Not enough experience"


# ---------------------------------------------------------------------------
# POST /masters/apply — no auth
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_apply_master_no_auth(client: AsyncClient) -> None:
    """Unauthenticated request → 401."""
    response = await client.post(APPLY_URL, json=_valid_apply_body())
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# DELETE /masters/me/application — F4 withdraw
# ---------------------------------------------------------------------------

WITHDRAW_URL = "/api/v1/masters/me/application"


@pytest.mark.asyncio
async def test_withdraw_application_success(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A pending applicant can withdraw: status flips, User row is untouched.

    Operator decision (F4): status flip ONLY -- role, is_active, and every
    other User column stay exactly as they were.
    """
    auth = await login_user(client, telegram_id=55004, first_name="Withdrawer")
    token = auth["session_token"]

    apply_resp = await client.post(
        APPLY_URL, json=_valid_apply_body(), headers=auth_headers(token),
    )
    assert apply_resp.status_code == 201

    withdraw_resp = await client.delete(WITHDRAW_URL, headers=auth_headers(token))
    assert withdraw_resp.status_code == 204

    user_id = auth["user"]["id"]
    profile = (
        await db_session.execute(
            select(MasterProfile).where(MasterProfile.user_id == user_id)
        )
    ).scalar_one()
    assert profile.data["account"]["status"] == "cancelled_by_user"

    user = (
        await db_session.execute(select(User).where(User.id == user_id))
    ).scalar_one()
    assert user.role == UserRole.USER
    assert user.is_active is True


@pytest.mark.asyncio
async def test_withdraw_application_no_application_404(client: AsyncClient) -> None:
    """Withdrawing with no application on file → 404."""
    auth = await login_user(client, telegram_id=55005, first_name="NoApp")
    response = await client.delete(WITHDRAW_URL, headers=auth_headers(auth["session_token"]))
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_withdraw_application_not_pending_conflict(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A verified (or otherwise non-pending) application can't be withdrawn → 409."""
    auth = await login_user(client, telegram_id=55006, first_name="Verified")
    token = auth["session_token"]

    apply_resp = await client.post(
        APPLY_URL, json=_valid_apply_body(), headers=auth_headers(token),
    )
    assert apply_resp.status_code == 201

    user_id = auth["user"]["id"]
    profile = (
        await db_session.execute(
            select(MasterProfile).where(MasterProfile.user_id == user_id)
        )
    ).scalar_one()
    verified_data = copy.deepcopy(profile.data)
    verified_data["account"]["status"] = "verified"
    profile.set_jsonb("data", verified_data)
    await db_session.commit()

    response = await client.delete(WITHDRAW_URL, headers=auth_headers(token))
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_withdraw_application_no_auth(client: AsyncClient) -> None:
    """Unauthenticated withdraw → 401."""
    response = await client.delete(WITHDRAW_URL)
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_reapply_after_withdrawal_succeeds(client: AsyncClient) -> None:
    """PIN: a withdrawn applicant can re-apply with zero special-casing.

    apply_for_master's reapply branch only special-cases "pending"/"verified"
    -- anything else (including "cancelled_by_user") falls through to the
    generic reapply path. This test pins that behavior so a future change to
    that branch can't silently reintroduce a block on re-applying after
    withdrawal.
    """
    auth = await login_user(client, telegram_id=55007, first_name="Reapplier")
    token = auth["session_token"]

    assert (
        await client.post(APPLY_URL, json=_valid_apply_body(), headers=auth_headers(token))
    ).status_code == 201
    assert (
        await client.delete(WITHDRAW_URL, headers=auth_headers(token))
    ).status_code == 204

    reapply_resp = await client.post(
        APPLY_URL, json=_valid_apply_body(), headers=auth_headers(token),
    )
    assert reapply_resp.status_code == 201
    assert reapply_resp.json()["status"] == "pending"


# ---------------------------------------------------------------------------
# POST /masters/apply — master role forbidden
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_apply_master_self_provision_no_profile_creates_verified(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """role=master with NO profile self-provisions a VERIFIED profile (№307).

    An admin who switched into master mode (role=master, no MasterProfile) fills
    the apply form -> the profile is created status=verified immediately (no
    approval loop), with the submitted methods/experience/bio and open
    availability so the master zone works at once.
    """
    auth = await login_user(client, telegram_id=55004, first_name="SelfProvision")
    token = auth["session_token"]

    # Switch into master mode: role=master, but no MasterProfile yet.
    user_id = auth["user"]["id"]
    await db_session.execute(
        update(User).where(User.id == user_id).values(role=UserRole.MASTER.value)
    )
    await db_session.commit()

    response = await client.post(
        APPLY_URL,
        json=_valid_apply_body(),
        headers=auth_headers(token),
    )
    assert response.status_code == 201
    assert response.json()["status"] == "verified"

    # The persisted profile is verified, self-provision-stamped, open, and
    # carries the fields the form collected.
    profile = (
        await fresh_execute(
            select(MasterProfile).where(MasterProfile.user_id == user_id)
        )
    ).scalar_one()
    assert profile.data["account"]["status"] == "verified"
    assert profile.data["account"]["verification"]["verified_by"] == "self_provision"
    assert profile.data["availability"]["is_accepting"] is True
    assert profile.data["profile"]["methods"] == ["meditation"]
    assert profile.data["profile"]["bio"] == "Experienced meditation teacher"


@pytest.mark.asyncio
async def test_apply_master_self_provision_existing_profile_conflict(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """role=master WITH an existing profile is already a master -> 409 (№307)."""
    auth = await login_user(client, telegram_id=55014, first_name="AlreadyMaster")
    token = auth["session_token"]

    # Switch into master mode and self-provision once (creates the profile).
    user_id = auth["user"]["id"]
    await db_session.execute(
        update(User).where(User.id == user_id).values(role=UserRole.MASTER.value)
    )
    await db_session.commit()
    first = await client.post(
        APPLY_URL, json=_valid_apply_body(), headers=auth_headers(token)
    )
    assert first.status_code == 201

    # A second apply now finds an existing profile -> 409 already_master.
    second = await client.post(
        APPLY_URL, json=_valid_apply_body(), headers=auth_headers(token)
    )
    assert second.status_code == 409
    assert second.json()["error"] == "already_master"


# ---------------------------------------------------------------------------
# POST /masters/apply — validation errors
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_apply_master_missing_methods(client: AsyncClient) -> None:
    """Empty methods list → 422."""
    auth = await login_user(client, telegram_id=55005, first_name="NoMethods")
    token = auth["session_token"]

    body = _valid_apply_body()
    body["experience"]["methods"] = []

    response = await client.post(
        APPLY_URL,
        json=body,
        headers=auth_headers(token),
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_apply_master_missing_display_name(client: AsyncClient) -> None:
    """Empty display_name → 422."""
    auth = await login_user(client, telegram_id=55006, first_name="NoName")
    token = auth["session_token"]

    body = _valid_apply_body()
    body["profile"]["display_name"] = ""

    response = await client.post(
        APPLY_URL,
        json=body,
        headers=auth_headers(token),
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_apply_master_negative_experience(client: AsyncClient) -> None:
    """Negative experience_years → 422."""
    auth = await login_user(client, telegram_id=55007, first_name="NegExp")
    token = auth["session_token"]

    body = _valid_apply_body()
    body["experience"]["experience_years"] = -1

    response = await client.post(
        APPLY_URL,
        json=body,
        headers=auth_headers(token),
    )
    assert response.status_code == 422
