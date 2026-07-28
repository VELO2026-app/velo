# =============================================================================
# Test: Role Switch — capability-derived policy (POST /api/v1/users/me/role)
# =============================================================================
#
# A1=Б: the endpoint is ALWAYS ON (the ROLE_SWITCH_ENABLED flag is gone);
# authorization is derived, not seeded:
#
#   allowed(user) = {USER}
#                 ∪ {MASTER}              iff a VERIFIED MasterProfile exists
#                 ∪ {USER, MASTER, ADMIN} iff the user is an admin (current
#                                              role, or a switched-away admin
#                                              via credentials.role_switch.
#                                              home_role -- the round-trip
#                                              marker)
#
# Hard rule ADMIN-NEVER-TARGET: a non-admin can never switch to ADMIN. An
# admin may switch to MASTER even without a master profile (№254 Q4=А).
# Legacy seeded credentials.role_switch.allowed_roles lists grant NOTHING.
#
# Covers the derivation matrix on the write path, the round-trip marker
# bookkeeping, and the role_switch block surfaced in GET /users/me (read
# path -- same derivation, single source of truth). Cleanup of the
# telegram_id range removes the MasterProfiles created here so they never
# leak into other suites.
# =============================================================================

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.masters.models import MasterProfile
from app.modules.users.models import User
from app.modules.users.schemas import credentials_without_admin_home
from tests.helpers import auth_headers, full_cleanup_range, login_user

TID_MIN = 89485
TID_MAX = 89502


@pytest.fixture(autouse=True)
async def _cleanup(db_session: AsyncSession):
    """Wipe the role-switch telegram_id range before and after each test."""
    await full_cleanup_range(db_session, TID_MIN, TID_MAX)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, TID_MIN, TID_MAX)
    await db_session.commit()


async def _get_user(db_session: AsyncSession, telegram_id: int) -> User:
    db_session.expire_all()  # drop stale identity-map state after API writes
    return (
        await db_session.execute(
            select(User).where(User.telegram_id == telegram_id)
        )
    ).scalar_one()


async def _set_role(
    db_session: AsyncSession, telegram_id: int, role: str
) -> None:
    """Directly assign a role (simulates the CLI/DB grant, e.g. admin)."""
    user = await _get_user(db_session, telegram_id)
    user.role = role
    await db_session.commit()


async def _cli_demote_to_user(
    db_session: AsyncSession, telegram_id: int
) -> None:
    """Simulate `velo setrole <id> U`: set role=user AND clear the marker.

    Mirrors scripts.set_role._set_role. That module cannot be imported here
    (scripts/ is not a package), so this calls the SAME real helper it uses
    (credentials_without_admin_home) -- the regression exercises the actual
    clearing logic, not a copy.
    """
    user = await _get_user(db_session, telegram_id)
    user.role = "user"
    user.set_jsonb(
        "credentials", credentials_without_admin_home(user.credentials)
    )
    await db_session.commit()


async def _add_master_profile(
    db_session: AsyncSession, telegram_id: int, status: str = "verified"
) -> None:
    """Attach a MasterProfile with the given account.status."""
    user = await _get_user(db_session, telegram_id)
    profile = MasterProfile(user_id=user.id)
    profile.set_jsonb("data", {"account": {"status": status}})
    db_session.add(profile)
    await db_session.commit()


async def _seed_legacy_allowlist(
    db_session: AsyncSession, telegram_id: int, allowed_roles: list[str]
) -> None:
    """Seed the LEGACY credentials.role_switch.allowed_roles list.

    Mirrors what old seed scenarios wrote. The derived policy must ignore it
    entirely -- kept only for the regression test below.
    """
    user = await _get_user(db_session, telegram_id)
    creds = dict(user.credentials or {})
    creds["role_switch"] = {"allowed_roles": allowed_roles}
    user.set_jsonb("credentials", creds)
    await db_session.commit()


async def _switch(client: AsyncClient, token: str, role: str):
    return await client.post(
        "/api/v1/users/me/role",
        headers=auth_headers(token),
        json={"role": role},
    )


# ---------------------------------------------------------------------------
# Plumbing: auth & validation
# ---------------------------------------------------------------------------


async def test_switch_role_no_auth_401(client: AsyncClient) -> None:
    """No token → 401 (auth dependency runs before the handler)."""
    response = await client.post(
        "/api/v1/users/me/role",
        json={"role": "admin"},
    )
    assert response.status_code == 401


async def test_switch_invalid_role_422(client: AsyncClient) -> None:
    """An unknown role value is rejected by Pydantic → 422."""
    data = await login_user(client, telegram_id=89492, first_name="Bogus")
    response = await _switch(client, data["session_token"], "superuser")
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Derivation matrix: write path (POST /me/role)
# ---------------------------------------------------------------------------


async def test_plain_user_cannot_switch_to_master_403(
    client: AsyncClient,
) -> None:
    """No master profile → MASTER is not in the derived set → 403."""
    data = await login_user(client, telegram_id=89486, first_name="Plain")
    response = await _switch(client, data["session_token"], "master")
    assert response.status_code == 403
    assert response.json()["error"] == "role_not_allowed"


async def test_plain_user_cannot_switch_to_admin_403(
    client: AsyncClient,
) -> None:
    """ADMIN-NEVER-TARGET: a non-admin can never switch to admin."""
    data = await login_user(client, telegram_id=89487, first_name="Wannabe")
    response = await _switch(client, data["session_token"], "admin")
    assert response.status_code == 403
    assert response.json()["error"] == "role_not_allowed"


async def test_unverified_profile_cannot_switch_to_master_403(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A pending (unverified) profile grants no master capability → 403."""
    data = await login_user(client, telegram_id=89488, first_name="Pending")
    await _add_master_profile(db_session, 89488, status="pending")
    response = await _switch(client, data["session_token"], "master")
    assert response.status_code == 403
    assert response.json()["error"] == "role_not_allowed"


async def test_suspended_profile_cannot_switch_to_master_403(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A suspended profile (CLI soft-freeze) grants no capability → 403."""
    data = await login_user(client, telegram_id=89489, first_name="Frozen")
    await _add_master_profile(db_session, 89489, status="suspended")
    response = await _switch(client, data["session_token"], "master")
    assert response.status_code == 403
    assert response.json()["error"] == "role_not_allowed"


async def test_verified_capability_roundtrip_user_master(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A verified MasterProfile unlocks MASTER; USER is always available."""
    data = await login_user(client, telegram_id=89490, first_name="Capable")
    token = data["session_token"]
    await _add_master_profile(db_session, 89490, status="verified")

    response = await _switch(client, token, "master")
    assert response.status_code == 200
    assert response.json()["role"] == "master"

    response = await _switch(client, token, "user")
    assert response.status_code == 200
    assert response.json()["role"] == "user"


async def test_verified_master_cannot_switch_to_admin_403(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Master capability does NOT unlock admin (ADMIN-NEVER-TARGET)."""
    data = await login_user(client, telegram_id=89491, first_name="MasterOnly")
    token = data["session_token"]
    await _add_master_profile(db_session, 89491, status="verified")
    await _switch(client, token, "master")

    response = await _switch(client, token, "admin")
    assert response.status_code == 403
    assert response.json()["error"] == "role_not_allowed"


async def test_switch_to_current_role_is_noop_200(
    client: AsyncClient,
) -> None:
    """USER is always in the derived set: user → user is a harmless no-op."""
    data = await login_user(client, telegram_id=89493, first_name="Same")
    response = await _switch(client, data["session_token"], "user")
    assert response.status_code == 200
    assert response.json()["role"] == "user"


# ---------------------------------------------------------------------------
# Admin round-trip (home_role marker)
# ---------------------------------------------------------------------------


async def test_admin_roundtrip_via_user(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Admin → user → back to admin; the home marker is set, then cleared."""
    data = await login_user(client, telegram_id=89494, first_name="Boss")
    token = data["session_token"]
    await _set_role(db_session, 89494, "admin")

    response = await _switch(client, token, "user")
    assert response.status_code == 200
    assert response.json()["role"] == "user"
    # While away, the derived set still offers admin (round-trip marker).
    assert response.json()["role_switch"] == {
        "allowed_roles": ["user", "master", "admin"]
    }
    user = await _get_user(db_session, 89494)
    assert (user.credentials or {}).get("role_switch", {}).get(
        "home_role"
    ) == "admin"

    response = await _switch(client, token, "admin")
    assert response.status_code == 200
    assert response.json()["role"] == "admin"
    # Marker is cleared on return: no stale self-serve admin grant remains.
    user = await _get_user(db_session, 89494)
    assert "home_role" not in (user.credentials or {}).get("role_switch", {})


async def test_admin_without_profile_can_switch_to_master_and_back(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """№254 Q4=А: admin → master works WITHOUT a master profile, and back."""
    data = await login_user(client, telegram_id=89495, first_name="AdminNoP")
    token = data["session_token"]
    await _set_role(db_session, 89495, "admin")

    response = await _switch(client, token, "master")
    assert response.status_code == 200
    assert response.json()["role"] == "master"

    response = await _switch(client, token, "admin")
    assert response.status_code == 200
    assert response.json()["role"] == "admin"


# ---------------------------------------------------------------------------
# Legacy allow-lists are dead
# ---------------------------------------------------------------------------


async def test_stale_seeded_allowlist_grants_nothing(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Old seeded allowed_roles lists are ignored by the derived policy."""
    data = await login_user(client, telegram_id=89496, first_name="Legacy")
    token = data["session_token"]
    await _seed_legacy_allowlist(
        db_session, 89496, ["user", "master", "admin"]
    )

    response = await _switch(client, token, "admin")
    assert response.status_code == 403
    response = await _switch(client, token, "master")
    assert response.status_code == 403


# ---------------------------------------------------------------------------
# GET /users/me — role_switch block exposure (read path, same derivation)
# ---------------------------------------------------------------------------


async def test_me_role_switch_null_for_plain_user(
    client: AsyncClient,
) -> None:
    """A plain user derives {USER} only → nothing to switch to → null."""
    data = await login_user(client, telegram_id=89498, first_name="Nobody")
    me = await client.get(
        "/api/v1/users/me", headers=auth_headers(data["session_token"])
    )
    assert me.status_code == 200
    assert me.json()["role_switch"] is None


async def test_me_role_switch_for_verified_capability(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A verified MasterProfile surfaces [user, master] regardless of role."""
    data = await login_user(client, telegram_id=89499, first_name="Exposed")
    await _add_master_profile(db_session, 89499, status="verified")
    me = await client.get(
        "/api/v1/users/me", headers=auth_headers(data["session_token"])
    )
    assert me.status_code == 200
    assert me.json()["role_switch"] == {"allowed_roles": ["user", "master"]}


async def test_me_role_switch_for_admin(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An admin surfaces all three roles (profile not required)."""
    data = await login_user(client, telegram_id=89500, first_name="AdminMe")
    await _set_role(db_session, 89500, "admin")
    me = await client.get(
        "/api/v1/users/me", headers=auth_headers(data["session_token"])
    )
    assert me.status_code == 200
    assert me.json()["role_switch"] == {
        "allowed_roles": ["user", "master", "admin"]
    }


async def test_me_role_switch_for_switched_away_admin(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A switched-away admin (home marker) still sees all three in /me."""
    data = await login_user(client, telegram_id=89501, first_name="Away")
    token = data["session_token"]
    await _set_role(db_session, 89501, "admin")
    await _switch(client, token, "user")

    me = await client.get("/api/v1/users/me", headers=auth_headers(token))
    assert me.status_code == 200
    assert me.json()["role"] == "user"
    assert me.json()["role_switch"] == {
        "allowed_roles": ["user", "master", "admin"]
    }


# ---------------------------------------------------------------------------
# R-1: CLI demotion clears the home marker (no self-serve admin restore)
# ---------------------------------------------------------------------------


async def test_credentials_without_admin_home_strips_marker() -> None:
    """R-1 helper: drops role_switch.home_role (and empties role_switch)."""
    # Marker-only role_switch -> the whole block is removed.
    assert credentials_without_admin_home(
        {"role_switch": {"home_role": "admin"}}
    ) == {}
    # Only home_role is dropped; other keys (legacy allowed_roles, phone) stay.
    assert credentials_without_admin_home(
        {
            "role_switch": {"home_role": "admin", "allowed_roles": ["user"]},
            "phone": "1",
        }
    ) == {"role_switch": {"allowed_roles": ["user"]}, "phone": "1"}
    # No marker -> unchanged; None -> {}.
    assert credentials_without_admin_home({"phone": "1"}) == {"phone": "1"}
    assert credentials_without_admin_home(None) == {}
    # Input is not mutated.
    original = {"role_switch": {"home_role": "admin"}}
    credentials_without_admin_home(original)
    assert original == {"role_switch": {"home_role": "admin"}}


async def test_demoted_ex_admin_cannot_self_restore_admin(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """R-1: once the CLI demotes a switched-away admin, the home marker is
    gone, so POST /me/role {admin} no longer self-restores admin."""
    data = await login_user(client, telegram_id=89497, first_name="ExBoss")
    token = data["session_token"]
    await _set_role(db_session, 89497, "admin")

    # Admin switches away -> round-trip marker recorded.
    response = await _switch(client, token, "user")
    assert response.status_code == 200
    user = await _get_user(db_session, 89497)
    assert (user.credentials or {}).get("role_switch", {}).get(
        "home_role"
    ) == "admin"

    # CLI demotion (velo setrole U) clears the marker.
    await _cli_demote_to_user(db_session, 89497)
    user = await _get_user(db_session, 89497)
    assert "home_role" not in (user.credentials or {}).get("role_switch", {})

    # The ex-admin is now a plain user -> cannot switch back to admin.
    response = await _switch(client, token, "admin")
    assert response.status_code == 403
    assert response.json()["error"] == "role_not_allowed"
