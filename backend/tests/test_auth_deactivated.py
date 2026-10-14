# =============================================================================
# A deactivated account gets no session from POST /api/v1/auth/telegram
# (Standalone F3 tails, observation 1)
# =============================================================================
#
# Before: the initData door created a session for a deactivated account and
# every later request answered 403 from get_current_user. Now the door itself
# refuses -- 403 account_deactivated after the upsert and before
# create_session -- the same refusal as the browser sign-in
# (test_auth_browser_login.py). The upsert is undone by get_db_session.
#
# The state is reachable (the column, the global guard in dependencies.py,
# the admin filter, backend/scripts/dev_admin_simulator.py --block), so the
# test builds it the way an operator would: is_active=False on the row.
#
# telegram_id band: 74150-74169.
# =============================================================================

from collections.abc import AsyncGenerator
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.redis import get_redis
from app.modules.users.models import User
from tests.helpers import BOT_TOKEN, build_init_data, full_cleanup_range, login_user

_TID_MIN = 74150
_TID_MAX = 74169


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    async def clean() -> None:
        await full_cleanup_range(db_session, _TID_MIN, _TID_MAX, delete_users=True)
        await db_session.commit()
        for tid in range(_TID_MIN, _TID_MAX + 1):
            await get_redis().delete(f"auth_rate:{tid}")

    await clean()
    yield
    await clean()


async def _deactivate(db_session: AsyncSession, tid: int) -> User:
    await db_session.execute(
        update(User).where(User.telegram_id == tid).values(is_active=False)
    )
    await db_session.commit()
    db_session.expire_all()
    user = (
        await db_session.execute(select(User).where(User.telegram_id == tid))
    ).scalar_one()
    return user


async def _sign_in(client: AsyncClient, tid: int, first_name: str):
    init_data = build_init_data({"id": tid, "first_name": first_name})
    with patch.object(settings, "telegram_bot_token", BOT_TOKEN):
        return await client.post("/api/v1/auth/telegram", json={"init_data": init_data})


async def test_a_deactivated_account_gets_no_session_and_no_profile_write(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    await login_user(client, 74150, first_name="Before")
    user = await _deactivate(db_session, 74150)
    sessions_before = await get_redis().zcard(f"user_sessions:{user.id}")

    resp = await _sign_in(client, 74150, first_name="After")

    assert resp.status_code == 403
    assert resp.json()["error"] == "account_deactivated"
    assert "session_token" not in resp.json()
    assert await get_redis().zcard(f"user_sessions:{user.id}") == sessions_before
    # The upsert ("After") was rolled back with the request.
    db_session.expire_all()
    stored = (
        await db_session.execute(select(User).where(User.telegram_id == 74150))
    ).scalar_one()
    assert stored.first_name == "Before"


async def test_repeated_attempts_of_a_deactivated_account_all_refused(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    await login_user(client, 74151)
    user = await _deactivate(db_session, 74151)
    sessions_before = await get_redis().zcard(f"user_sessions:{user.id}")

    for _ in range(2):
        resp = await _sign_in(client, 74151, first_name="Again")
        assert resp.status_code == 403
    assert await get_redis().zcard(f"user_sessions:{user.id}") == sessions_before


async def test_an_active_account_still_signs_in(client: AsyncClient) -> None:
    await login_user(client, 74152)
    resp = await _sign_in(client, 74152, first_name="Active")
    assert resp.status_code == 200
    assert resp.json()["session_token"]


async def test_a_new_account_is_created_active(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    resp = await _sign_in(client, 74153, first_name="New")
    assert resp.status_code == 200
    db_session.expire_all()
    user = (
        await db_session.execute(select(User).where(User.telegram_id == 74153))
    ).scalar_one()
    assert user.is_active is True
