# =============================================================================
# Test: normalize_master_methods.py rollback safety (T21-6 chain, ПРОМТ №550)
# =============================================================================
#
# _run_rollback previously decided purely on `current == before`, which meant
# a row that had legitimately changed for a DIFFERENT reason since
# normalization (e.g. an admin approved a real method-change request) looked
# identical to "not yet rolled back" and would be silently OVERWRITTEN back to
# its pre-normalization value, discarding the real approval (ПРОМТ №549
# adversarial finding). Fixed to also check `current == after`: only a row
# that still holds EXACTLY what the normalizer wrote is safe to revert.
# Neither `before` nor `after` -> REFUSE loudly (printed, naming the master
# and all three values), never silently skip and never overwrite. This script
# runs against production, so the refusal must be observable, not a quiet
# no-op indistinguishable from "already rolled back".
#
# Exercises the script's own functions DIRECTLY against the real test DB (no
# HTTP layer -- this is a repair script, not an endpoint), same "unit-level
# against a real session" pattern test_practice_taxonomy_union.py already uses
# for _validate_taxonomy. `backend/scripts` has no __init__.py but is
# importable as a PEP 420 namespace package once `backend/` itself is on
# sys.path, which it already is for every `from app...` import in this suite.
#
# NOT EXECUTED (local pytest is blocked, same as every other file in this
# module's chain) -- traced by hand; see the ПРОМТ №550 report for the trace.
#
# telegram_id range: 99900-99909 (own tiny band).
# =============================================================================

import copy
from collections.abc import AsyncGenerator
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import AuditLog
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from scripts.normalize_master_methods import _AUDIT_EVENT, _run_rollback
from tests.helpers import auth_headers, full_cleanup_range, login_user, switch_self_to_master

APPLY_URL = "/api/v1/masters/apply"
VERIFY_URL = "/api/v1/admin/masters/{user_id}/verify"

_MASTER_TID = 99901
_ADMIN_TID = 99909


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, 99900, 99909, delete_users=False)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, 99900, 99909, delete_users=False)
    await db_session.commit()


async def _make_verified_master(
    client: AsyncClient,
    db_session: AsyncSession,
    methods: list[str],
    telegram_id: int = _MASTER_TID,
) -> dict:
    auth = await login_user(client, telegram_id=telegram_id, first_name="Master")
    await client.post(
        APPLY_URL,
        json={
            "profile": {"display_name": "Rollback Master", "email": "rollback@test.com"},
            "experience": {
                "methods": methods, "experience_years": 5, "bio": "Practitioner",
            },
            "documents": [],
        },
        headers=auth_headers(auth["session_token"]),
    )

    await login_user(client, telegram_id=_ADMIN_TID, first_name="Admin")
    await db_session.execute(
        update(User).where(User.telegram_id == _ADMIN_TID).values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    admin_auth = await login_user(client, telegram_id=_ADMIN_TID, first_name="Admin")

    user_id = auth["user"]["id"]
    verify_resp = await client.post(
        VERIFY_URL.format(user_id=user_id),
        json={},
        headers=auth_headers(admin_auth["session_token"]),
    )
    assert verify_resp.status_code == 200

    await switch_self_to_master(client, auth["session_token"])
    return await login_user(client, telegram_id=telegram_id, first_name="Master")


async def _seed_normalize_audit_entry(
    session: AsyncSession, user_id: UUID, before: list[str], after: list[str],
) -> None:
    """Insert the AuditLog row _run_normalize would have written, without
    actually running the normalizer -- isolates the rollback test from the
    normalize step (already covered separately by tracing _normalize_methods
    in the ПРОМТ №547/549 reports)."""
    session.add(
        AuditLog(
            event=_AUDIT_EVENT,
            actor_id=None,
            actor_type="system",
            target_type="master_profile",
            target_id=user_id,
            data={"before": before, "after": after},
        )
    )
    await session.commit()


@pytest.mark.asyncio
async def test_rollback_refuses_a_row_changed_for_another_reason(
    client: AsyncClient,
    db_session: AsyncSession,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The row was normalized (before=["yoga"], after=["Йога"]) and THEN a
    real admin approval changed it again to something else entirely --
    neither the recorded before nor after. Rollback must REFUSE, print the
    master's id and all three values, and leave the live data untouched
    (not reverted to `before`, not left silently as if nothing happened)."""
    auth = await _make_verified_master(client, db_session, methods=["yoga"])
    user_id_str = auth["user"]["id"]

    await _seed_normalize_audit_entry(
        db_session, UUID(user_id_str), before=["yoga"], after=["Йога"],
    )

    profile = await db_session.get(MasterProfile, user_id_str)
    new_data = copy.deepcopy(profile.data)
    new_data["profile"]["methods"] = ["Йога", "Медитация"]
    profile.set_jsonb("data", new_data)
    await db_session.commit()

    await _run_rollback(db_session, dry_run=False)
    await db_session.commit()

    captured = capsys.readouterr()
    assert "REFUSED" in captured.out
    assert user_id_str in captured.out
    assert "yoga" in captured.out  # recorded before
    assert "Медитация" in captured.out  # current (live) value

    await db_session.refresh(profile)
    assert profile.data["profile"]["methods"] == ["Йога", "Медитация"]


@pytest.mark.asyncio
async def test_rollback_reverts_a_row_that_still_matches_after(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Positive control: a row that still holds EXACTLY what the normalizer
    wrote (current == after, untouched since) is safe to revert -- guards
    against the REFUSE fix being too strict."""
    auth = await _make_verified_master(client, db_session, methods=["Йога"])
    user_id_str = auth["user"]["id"]

    await _seed_normalize_audit_entry(
        db_session, UUID(user_id_str), before=["yoga"], after=["Йога"],
    )

    await _run_rollback(db_session, dry_run=False)
    await db_session.commit()

    profile = await db_session.get(MasterProfile, user_id_str)
    await db_session.refresh(profile)
    assert profile.data["profile"]["methods"] == ["yoga"]


@pytest.mark.asyncio
async def test_rollback_skips_a_row_already_reverted(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Idempotency: a row already at its recorded `before` value (a prior
    rollback already ran) is skipped, not re-processed or double-reverted."""
    auth = await _make_verified_master(client, db_session, methods=["yoga"])
    user_id_str = auth["user"]["id"]

    await _seed_normalize_audit_entry(
        db_session, UUID(user_id_str), before=["yoga"], after=["Йога"],
    )

    await _run_rollback(db_session, dry_run=False)
    await db_session.commit()

    profile = await db_session.get(MasterProfile, user_id_str)
    await db_session.refresh(profile)
    assert profile.data["profile"]["methods"] == ["yoga"]
