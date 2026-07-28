# =============================================================================
# Test: Master invite -- generic one-time link (Batch-INVITE, Redis-backed)
# =============================================================================
#
# POST /admin/masters/invite  (admin-auth): NO target. Mints a random token,
#   stores sha256(token) in Redis with NO expiry, returns the full composed
#   deeplink. 503 if telegram_bot_url is unset.
# POST /masters/invite/claim  (any authenticated opener): hashes the supplied
#   token and burns it atomically (GETDEL). First claim wins (200); an unknown
#   or already-consumed token 404s (invite_invalid). Becoming a master still
#   goes through the regular apply + approval loop. Any auto-registered opener
#   may claim -- the link is not bound to an account.
#
# telegram_bot_url is monkeypatched so the composed link is deterministic
# regardless of the ambient .env.
# =============================================================================

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.users.models import User
from tests.helpers import auth_headers, full_cleanup_range, login_user

TID_MIN = 89503
TID_MAX = 89508

BOT_URL = "https://t.me/velo_testbot"
LINK_PREFIX = f"{BOT_URL}?startapp=master_onboarding__"


@pytest.fixture(autouse=True)
async def _cleanup(db_session: AsyncSession):
    """Wipe the invite telegram_id range before and after each test."""
    await full_cleanup_range(db_session, TID_MIN, TID_MAX)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, TID_MIN, TID_MAX)
    await db_session.commit()


@pytest.fixture(autouse=True)
def _bot_url(monkeypatch: pytest.MonkeyPatch):
    """Pin telegram_bot_url so the composed link is deterministic."""
    monkeypatch.setattr(settings, "telegram_bot_url", BOT_URL)


async def _get_user(db_session: AsyncSession, telegram_id: int) -> User:
    db_session.expire_all()
    return (
        await db_session.execute(
            select(User).where(User.telegram_id == telegram_id)
        )
    ).scalar_one()


async def _set_role(
    db_session: AsyncSession, telegram_id: int, role: str
) -> None:
    user = await _get_user(db_session, telegram_id)
    user.role = role
    await db_session.commit()


async def _login_admin(client: AsyncClient, db_session: AsyncSession) -> str:
    """Create + promote the acting admin, return their session token."""
    data = await login_user(client, telegram_id=89503, first_name="Inviter")
    await _set_role(db_session, 89503, "admin")
    return data["session_token"]


async def _issue(client: AsyncClient, token: str):
    """Generic issue -- no request body (no target)."""
    return await client.post(
        "/api/v1/admin/masters/invite",
        headers=auth_headers(token),
    )


async def _claim(client: AsyncClient, token: str, invite_token: str):
    return await client.post(
        "/api/v1/masters/invite/claim",
        headers=auth_headers(token),
        json={"token": invite_token},
    )


def _token_from_link(link: str) -> str:
    assert link.startswith(LINK_PREFIX), link
    return link[len(LINK_PREFIX):]


# ---------------------------------------------------------------------------
# Issue (admin side)
# ---------------------------------------------------------------------------


async def test_issue_non_admin_403(
    client: AsyncClient,
) -> None:
    """A plain user cannot issue invites."""
    data = await login_user(client, telegram_id=89504, first_name="Plain")
    response = await _issue(client, data["session_token"])
    assert response.status_code == 403


async def test_issue_success_returns_composed_link(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Success returns the full server-composed deeplink + issued_at.

    The link is generic (no target); there is deliberately NO expiry field.
    """
    admin_token = await _login_admin(client, db_session)

    response = await _issue(client, admin_token)
    assert response.status_code == 200
    body = response.json()
    assert body["invite_link"].startswith(LINK_PREFIX)
    assert body["issued_at"] is not None
    assert "expires_at" not in body
    # The plaintext token rides only in the link (never echoed elsewhere).
    assert _token_from_link(body["invite_link"])


async def test_issue_503_when_bot_url_unset(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No telegram_bot_url configured -> 503 with the machine code."""
    admin_token = await _login_admin(client, db_session)
    monkeypatch.setattr(settings, "telegram_bot_url", "")

    response = await _issue(client, admin_token)
    assert response.status_code == 503
    assert response.json()["error"] == "bot_url_not_configured"


# ---------------------------------------------------------------------------
# Claim (opener side)
# ---------------------------------------------------------------------------


async def test_claim_success_burns_single_use(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A valid claim returns claimed_at; the same token then 404s (burned)."""
    admin_token = await _login_admin(client, db_session)
    opener = await login_user(client, telegram_id=89505, first_name="Claimer")
    issued = await _issue(client, admin_token)
    token = _token_from_link(issued.json()["invite_link"])

    first = await _claim(client, opener["session_token"], token)
    assert first.status_code == 200
    assert first.json()["claimed_at"] is not None

    # Single use: the same (correct) token no longer claims.
    again = await _claim(client, opener["session_token"], token)
    assert again.status_code == 404
    assert again.json()["error"] == "invite_invalid"


async def test_claim_unknown_token_404(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A well-formed but never-issued token 404s (invite_invalid)."""
    admin_token = await _login_admin(client, db_session)
    opener = await login_user(client, telegram_id=89506, first_name="Garbled")
    # An admin exists but we never issue -> this token was never stored.
    assert admin_token

    response = await _claim(
        client, opener["session_token"], "x" * 43  # token_urlsafe(32) length
    )
    assert response.status_code == 404
    assert response.json()["error"] == "invite_invalid"


async def test_claim_auto_registered_opener_succeeds(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A generic link works for any authenticated opener (not a target).

    The opener is auto-registered by login (upsert_user_on_login); they were
    never named in the issue call, yet the generic token claims fine.
    """
    admin_token = await _login_admin(client, db_session)
    issued = await _issue(client, admin_token)
    token = _token_from_link(issued.json()["invite_link"])

    # A fresh opener who was never specifically invited.
    fresh = await login_user(client, telegram_id=89507, first_name="Fresh")
    response = await _claim(client, fresh["session_token"], token)
    assert response.status_code == 200
    assert response.json()["claimed_at"] is not None
