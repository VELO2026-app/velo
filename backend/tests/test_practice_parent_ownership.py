"""H-R2 (3.4): parent_practice_id ownership validation on create.

An occurrence may only attach to an EXISTING practice OWNED by the
calling master that is itself a ROOT. All three refusals share one 400
(anti-enumeration, mirror of the P5 group check); a nonexistent id must
be a clean 400, not a 500 from the FK.

Update path: parent_practice_id is DELIBERATELY absent from the update
schema (C2, practices/schemas.py) -- there is nothing to validate there;
the fact is recorded in the H-R2 report.

telegram_id band: 89640-89659 (issued for H-R2; admin pinned at 89659).
"""

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User, UserRole
from tests.helpers import (
    auth_headers,
    full_cleanup_range,
    login_user,
    switch_self_to_master,
)

PRACTICES_URL = "/api/v1/practices"
APPLY_URL = "/api/v1/masters/apply"
VERIFY_URL = "/api/v1/admin/masters/{user_id}/verify"

_ADMIN_TID = 89659


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await _do_cleanup(db_session)
    yield
    await _do_cleanup(db_session)


async def _do_cleanup(session: AsyncSession) -> None:
    """Full ORM cleanup for the file's band 89640-89659."""
    await full_cleanup_range(session, 89640, 89659, delete_users=False)
    await session.commit()


def _valid_practice_body(**overrides: object) -> dict:
    base: dict = {
        "practice_type": "live",
        "direction": "meditation",
        "difficulty": "beginner",
        "title": "Parent Ownership Session",
        "description": "Guided breathwork session",
        "scheduled_at": (
            datetime.now(UTC) + timedelta(days=7)
        ).isoformat(),
        "duration_minutes": 60,
        "timezone": "Europe/Moscow",
        "max_participants": 10,
        "is_free": True,
        "price_cents": 0,
        "currency": "eur",
    }
    base.update(overrides)
    return base


def _valid_apply_body() -> dict:
    return {
        "profile": {
            "display_name": "Parent Master",
            "email": "parentmaster@test.com",
        },
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
    telegram_id: int,
) -> dict:
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

    verify_resp = await client.post(
        VERIFY_URL.format(user_id=auth["user"]["id"]),
        json={},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert verify_resp.status_code == 200

    await switch_self_to_master(client, auth["session_token"])
    return await login_user(
        client, telegram_id=telegram_id, first_name="Master",
    )


async def _create(
    client: AsyncClient, master_auth: dict, **overrides: object,
):
    return await client.post(
        PRACTICES_URL,
        json=_valid_practice_body(**overrides),
        headers=auth_headers(master_auth["session_token"]),
    )


@pytest.mark.asyncio
async def test_parent_own_root_accepted(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Positive twin: attaching to your OWN ROOT practice works."""
    master = await _make_verified_master(client, db_session, 89640)
    root = await _create(client, master, title="Root A")
    assert root.status_code == 201
    child = await _create(
        client, master,
        title="Occurrence of A",
        parent_practice_id=root.json()["id"],
    )
    assert child.status_code == 201
    assert child.json()["parent_practice_id"] == root.json()["id"]


@pytest.mark.asyncio
async def test_parent_foreign_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Someone else's practice as parent -> 400."""
    owner = await _make_verified_master(client, db_session, 89640)
    foreign_root = await _create(client, owner, title="Foreign Root")
    assert foreign_root.status_code == 201

    intruder = await _make_verified_master(client, db_session, 89641)
    resp = await _create(
        client, intruder,
        title="Hijack attempt",
        parent_practice_id=foreign_root.json()["id"],
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_parent_nonexistent_rejected_with_400_not_500(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Unknown id -> clean 400 (previously a raw FK error -> 500)."""
    master = await _make_verified_master(client, db_session, 89640)
    resp = await _create(
        client, master,
        title="Orphan attempt",
        parent_practice_id=str(uuid4()),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_parent_that_is_a_child_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A non-root parent (grandchild attempt) -> 400."""
    master = await _make_verified_master(client, db_session, 89640)
    root = await _create(client, master, title="Root B")
    assert root.status_code == 201
    child = await _create(
        client, master,
        title="Occurrence of B",
        parent_practice_id=root.json()["id"],
    )
    assert child.status_code == 201

    grandchild = await _create(
        client, master,
        title="Grandchild attempt",
        parent_practice_id=child.json()["id"],
    )
    assert grandchild.status_code == 400
