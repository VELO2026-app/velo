# =============================================================================
# VELO Backend -- Tests: status notifications to the master APPLICANT (BE-104)
# =============================================================================
#
# telegram_id band: 70900-70999 (applicants 70901-70929, admin 70990).
# Declared module-level below as _TID_MIN/_TID_MAX, ONCE -- tests/
# telegram_id_bands.py parses that declaration out of the AST. Checked free
# before it was claimed: free_windows(space=(55000, 99999)) returned
# (70900, 79299) among others.
#
# WHAT IS PROVABLE HERE: the OutboxEvent rows the transitions queue -- type,
# addressee, idempotency key, action, the variables the telegram sheets
# read. Delivery itself (mute gate, rendering) lives in comms; the sheets'
# variables are checked against what is SENT, because comms renders a
# missing variable as the literal "{name}".
#
# EVERY "IS NOT THERE" IS PAIRED WITH AN "IS THERE": a count of zero passes
# just as happily when the emit path is broken for everyone.
# =============================================================================

import string
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

import pytest
import yaml
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session_factory
from app.core.events.models import OutboxEvent
from app.modules.admin.masters import service as admin_masters_service
from app.modules.admin.users import service as admin_users_service
from app.modules.masters.models import MasterProfile
from app.modules.users.models import User, UserRole
from tests.curator_race_harness import assert_no_deadlock, race
from tests.helpers import (
    auth_headers,
    fresh_execute,
    fresh_get,
    full_cleanup_range,
    login_user,
)

_TID_MIN = 70900
_TID_MAX = 70999

_TID_A = 70901
_TID_B = 70902
_TID_C = 70903
_TID_D = 70904
_TID_E = 70905
_TID_ADMIN = 70990
_TID_ADMIN_B = 70991

APPLY_URL = "/api/v1/masters/apply"
WITHDRAW_URL = "/api/v1/masters/me/application"
VERIFY_URL = "/api/v1/admin/masters/{user_id}/verify"
REJECT_URL = "/api/v1/admin/masters/{user_id}/reject"
REVOKE_URL = "/api/v1/admin/masters/{user_id}/revoke"
MAKE_MASTER_URL = "/api/v1/admin/users/{user_id}/make-master"

SUBMITTED = "master.application_submitted"
VERIFIED = "master.verified"
REJECTED = "master.rejected"
STATUS_TYPES = (SUBMITTED, VERIFIED, REJECTED)

_PROFILE_CANDIDATES = (
    Path(__file__).resolve().parents[2] / "comms-profile",
    Path("/comms-profile"),
)


def _profile_dir() -> Path:
    for candidate in _PROFILE_CANDIDATES:
        if (candidate / "types.yaml").is_file():
            return candidate
    raise AssertionError(
        "comms-profile/types.yaml found in none of: "
        + ", ".join(str(c) for c in _PROFILE_CANDIDATES)
    )


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX)
    await db_session.commit()
    yield
    await full_cleanup_range(db_session, _TID_MIN, _TID_MAX)
    await db_session.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _apply_body(*, full: bool = True) -> dict:
    if not full:
        # Only what MasterApplyRequest requires: no email, phone, bio,
        # certifications, languages or documents.
        return {
            "profile": {"display_name": "Bare"},
            "experience": {"methods": ["meditation"], "experience_years": 0},
        }
    return {
        "profile": {
            "display_name": "Status Test",
            "email": "status@test.com",
            "phone": "+1234567890",
        },
        "experience": {
            "methods": ["meditation"],
            "experience_years": 3,
            "bio": "bio",
            "certifications": ["Cert"],
        },
        "documents": [{"type": "certificate", "number": "C-1"}],
    }


async def _user(client: AsyncClient, tid: int, name: str = "Applicant") -> dict:
    return await login_user(client, telegram_id=tid, first_name=name)


async def _admin(
    client: AsyncClient,
    db_session: AsyncSession,
    tid: int = _TID_ADMIN,
) -> tuple[str, UUID]:
    auth = await login_user(client, telegram_id=tid, first_name="Admin")
    await db_session.execute(
        update(User)
        .where(User.id == auth["user"]["id"])
        .values(role=UserRole.ADMIN.value)
    )
    await db_session.commit()
    return auth["session_token"], UUID(auth["user"]["id"])


async def _apply(client: AsyncClient, auth: dict, *, full: bool = True):
    return await client.post(
        APPLY_URL,
        json=_apply_body(full=full),
        headers=auth_headers(auth["session_token"]),
    )


async def _verify(client: AsyncClient, admin_token: str, user_id: str):
    return await client.post(
        VERIFY_URL.format(user_id=user_id),
        json={"notes": "ok"},
        headers=auth_headers(admin_token),
    )


async def _reject(
    client: AsyncClient,
    admin_token: str,
    user_id: str,
    reason: str,
):
    return await client.post(
        REJECT_URL.format(user_id=user_id),
        json={"reason": reason},
        headers=auth_headers(admin_token),
    )


async def _make_master(client: AsyncClient, admin_token: str, user_id: str):
    return await client.post(
        MAKE_MASTER_URL.format(user_id=user_id),
        headers=auth_headers(admin_token),
    )


async def _status_rows(user_id: str, type_: str | None = None) -> list[dict]:
    """Status notifications queued FOR ONE PERSON, oldest first.

    Scoped by target_value (the access path full_cleanup_range uses): an
    unscoped select reads the whole suite's outbox.
    """
    rows = (
        (
            await fresh_execute(
                select(OutboxEvent)
                .where(OutboxEvent.payload["target_value"].astext == str(user_id))
                .order_by(OutboxEvent.id)
            )
        )
        .scalars()
        .all()
    )
    payloads = [r.payload or {} for r in rows]
    wanted = (type_,) if type_ else STATUS_TYPES
    return [p for p in payloads if p.get("type") in wanted]


async def _account(user_id: str) -> dict:
    profile = await fresh_get(MasterProfile, UUID(user_id))
    assert profile is not None
    return profile.data["account"]


async def _admins_received(user_id: str) -> int:
    """master.application_received rows naming this applicant (group:admins)."""
    rows = (
        (
            await fresh_execute(
                select(OutboxEvent).where(
                    OutboxEvent.payload["type"].astext == "master.application_received",
                    OutboxEvent.payload["action_data"]["params"]["user_id"].astext
                    == str(user_id),
                )
            )
        )
        .scalars()
        .all()
    )
    return len(rows)


# ---------------------------------------------------------------------------
# apply_for_master -> master.application_submitted
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_application_tells_the_applicant_once(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """One submitted to the applicant, keyed on applied_at; a repeat is 409."""
    auth = await _user(client, _TID_A)
    uid = auth["user"]["id"]

    resp = await _apply(client, auth)
    assert resp.status_code == 201, resp.text

    rows = await _status_rows(uid)
    assert [r["type"] for r in rows] == [SUBMITTED]
    (row,) = rows
    applied_at = (await _account(uid))["applied_at"]
    assert row["idempotency_key"] == f"master-status-submitted:{uid}:{applied_at}"
    assert row["target_type"] == "user"
    assert row["target_value"] == uid
    assert row["title"] and row["body"]
    assert row["action_data"] == {
        "action": "open_master_application",
        "params": {},
    }
    # The admins' notification is still there -- the new one is beside it.
    assert await _admins_received(uid) == 1

    # REPEAT axis: same call again -> 409 pending, nothing new queued.
    again = await _apply(client, auth)
    assert again.status_code == 409, again.text
    assert len(await _status_rows(uid, SUBMITTED)) == 1


@pytest.mark.asyncio
async def test_a_reapplication_after_a_rejection_is_a_new_notification(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Reapply -> a new submitted (own key); reject again -> a new rejected."""
    admin_token, _ = await _admin(client, db_session)
    auth = await _user(client, _TID_A)
    uid = auth["user"]["id"]

    assert (await _apply(client, auth)).status_code == 201
    assert (await _reject(client, admin_token, uid, "first")).status_code == 200
    assert (await _apply(client, auth)).status_code == 201
    assert (await _reject(client, admin_token, uid, "second")).status_code == 200

    rows = await _status_rows(uid)
    assert [r["type"] for r in rows] == [SUBMITTED, REJECTED, SUBMITTED, REJECTED]
    keys = [r["idempotency_key"] for r in rows]
    assert len(set(keys)) == 4
    assert [r["action_data"]["reason"] for r in rows if r["type"] == REJECTED] == [
        "first",
        "second",
    ]


@pytest.mark.asyncio
async def test_reapplying_after_a_withdrawal_notifies_and_the_withdrawal_does_not(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """cancelled_by_user is a reapplication too (any non-pending status is)."""
    auth = await _user(client, _TID_A)
    uid = auth["user"]["id"]

    assert (await _apply(client, auth)).status_code == 201
    withdrawn = await client.delete(
        WITHDRAW_URL,
        headers=auth_headers(auth["session_token"]),
    )
    assert withdrawn.status_code == 204, withdrawn.text
    # The withdrawal itself is silent (owner ruling) ...
    assert len(await _status_rows(uid)) == 1
    assert (await _account(uid))["status"] == "cancelled_by_user"

    assert (await _apply(client, auth)).status_code == 201
    rows = await _status_rows(uid, SUBMITTED)
    assert len(rows) == 2
    assert rows[0]["idempotency_key"] != rows[1]["idempotency_key"]


@pytest.mark.asyncio
async def test_a_nameless_applicant_with_a_bare_form_gets_the_same_letter(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """EMPTINESS axis: no name, only required fields -> the same text, no 'None'."""
    named = await _user(client, _TID_A, name="Named")
    bare = await _user(client, _TID_B, name="Bare")
    await db_session.execute(
        update(User)
        .where(User.id == bare["user"]["id"])
        .values(first_name="", last_name=None)
    )
    await db_session.commit()

    assert (await _apply(client, named)).status_code == 201
    assert (await _apply(client, bare, full=False)).status_code == 201

    (n,) = await _status_rows(named["user"]["id"], SUBMITTED)
    (b,) = await _status_rows(bare["user"]["id"], SUBMITTED)
    assert b["title"] == n["title"] and b["body"] == n["body"]
    assert b["body"] and "None" not in b["body"]


@pytest.mark.asyncio
async def test_self_provision_sends_no_status_notification(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """role=master without a profile -> verified at once, and nobody is told (owner)."""
    auth = await _user(client, _TID_A)
    uid = auth["user"]["id"]
    await db_session.execute(
        update(User).where(User.id == uid).values(role=UserRole.MASTER.value)
    )
    await db_session.commit()

    resp = await _apply(client, auth)
    assert resp.status_code == 201, resp.text
    assert (await _account(uid))["status"] == "verified"
    assert await _status_rows(uid) == []


# ---------------------------------------------------------------------------
# verify_master / reject_master
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_verification_tells_the_applicant_once(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    admin_token, _ = await _admin(client, db_session)
    auth = await _user(client, _TID_A)
    uid = auth["user"]["id"]
    assert (await _apply(client, auth)).status_code == 201

    assert (await _verify(client, admin_token, uid)).status_code == 200
    rows = await _status_rows(uid, VERIFIED)
    assert len(rows) == 1
    (row,) = rows
    assert row["idempotency_key"].startswith(f"master-status-verified:{uid}:")
    assert row["action_data"] == {"action": "open_master_zone", "params": {}}
    # One text for every path: it must not speak of an application.
    assert "заявк" not in (row["title"] + row["body"]).lower()

    # SHORTAGE / REPEAT axes: verify a verified profile -> 409, nothing queued.
    again = await _verify(client, admin_token, uid)
    assert again.status_code == 409, again.text
    assert len(await _status_rows(uid, VERIFIED)) == 1


@pytest.mark.asyncio
async def test_a_rejection_carries_its_reason_and_is_sent_once(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    admin_token, _ = await _admin(client, db_session)
    auth = await _user(client, _TID_A)
    uid = auth["user"]["id"]
    assert (await _apply(client, auth)).status_code == 201

    reason = "Нужен сертификат <b>RYT</b>"
    assert (await _reject(client, admin_token, uid, reason)).status_code == 200
    (row,) = await _status_rows(uid, REJECTED)
    rejected_at = (await _account(uid))["rejected_at"]
    assert row["idempotency_key"] == f"master-status-rejected:{uid}:{rejected_at}"
    assert row["action_data"] == {
        "action": "open_master_application",
        "params": {},
        "reason": reason,
    }
    assert reason in row["body"]

    again = await _reject(client, admin_token, uid, reason)
    assert again.status_code == 409, again.text
    assert len(await _status_rows(uid, REJECTED)) == 1
    # And a 409 on verify of the rejected profile queues nothing either.
    assert (await _verify(client, admin_token, uid)).status_code == 409
    assert await _status_rows(uid, VERIFIED) == []


@pytest.mark.asyncio
async def test_a_rolled_back_rejection_leaves_no_notification(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The row lives and dies with the transition (outbox, P-01)."""
    _, admin_id = await _admin(client, db_session)
    auth = await _user(client, _TID_A)
    uid = auth["user"]["id"]
    assert (await _apply(client, auth)).status_code == 201

    async def _boom(*_a, **_kw):
        raise RuntimeError("after the emit")

    monkeypatch.setattr(admin_masters_service, "close_pending_master_offers", _boom)
    async with get_session_factory()() as session:
        admin = await session.get(User, admin_id)
        with pytest.raises(RuntimeError):
            await admin_masters_service.reject_master(
                UUID(uid),
                admin,
                "why",
                session,
            )
        await session.rollback()

    assert await _status_rows(uid, REJECTED) == []
    # Pair: the profile is still pending and the submission is still there.
    assert (await _account(uid))["status"] == "pending"
    assert len(await _status_rows(uid, SUBMITTED)) == 1


# ---------------------------------------------------------------------------
# make_master
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_make_master_on_a_plain_user_tells_them_once(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    admin_token, _ = await _admin(client, db_session)
    auth = await _user(client, _TID_A)
    uid = auth["user"]["id"]

    assert (await _make_master(client, admin_token, uid)).status_code == 200
    assert len(await _status_rows(uid, VERIFIED)) == 1

    again = await _make_master(client, admin_token, uid)
    assert again.status_code == 409, again.text
    assert "already_master" in again.text
    assert len(await _status_rows(uid, VERIFIED)) == 1


@pytest.mark.asyncio
async def test_make_master_on_an_approved_applicant_sends_nothing_new(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Verified, never switched: the transition, and its notification, were verify's."""
    admin_token, _ = await _admin(client, db_session)
    auth = await _user(client, _TID_A)
    uid = auth["user"]["id"]
    assert (await _apply(client, auth)).status_code == 201
    assert (await _verify(client, admin_token, uid)).status_code == 200
    assert len(await _status_rows(uid, VERIFIED)) == 1

    assert (await _make_master(client, admin_token, uid)).status_code == 200
    user = await fresh_get(User, UUID(uid))
    assert user is not None and user.role == UserRole.MASTER.value
    assert len(await _status_rows(uid, VERIFIED)) == 1


@pytest.mark.asyncio
async def test_make_master_on_a_rejected_applicant_is_a_verification(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    admin_token, _ = await _admin(client, db_session)
    auth = await _user(client, _TID_A)
    uid = auth["user"]["id"]
    assert (await _apply(client, auth)).status_code == 201
    assert (await _reject(client, admin_token, uid, "no")).status_code == 200

    assert (await _make_master(client, admin_token, uid)).status_code == 200
    assert [r["type"] for r in await _status_rows(uid)] == [
        SUBMITTED,
        REJECTED,
        VERIFIED,
    ]


@pytest.mark.asyncio
async def test_verify_revoke_make_master_are_two_transitions_two_keys(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The key names the transition, not the person.

    The key is a uuid4 per transition by construction; since BE-104
    delivery 2 the verification stamp would differ here too, but the key
    does not rest on what a writer remembers to stamp.
    """
    admin_token, _ = await _admin(client, db_session)
    auth = await _user(client, _TID_A)
    uid = auth["user"]["id"]
    assert (await _apply(client, auth)).status_code == 201
    assert (await _verify(client, admin_token, uid)).status_code == 200
    revoked = await client.post(
        REVOKE_URL.format(user_id=uid),
        headers=auth_headers(admin_token),
    )
    assert revoked.status_code == 200, revoked.text
    # The revoke itself is silent (owner ruling).
    assert len(await _status_rows(uid, VERIFIED)) == 1

    assert (await _make_master(client, admin_token, uid)).status_code == 200
    rows = await _status_rows(uid, VERIFIED)
    assert len(rows) == 2
    assert rows[0]["idempotency_key"] != rows[1]["idempotency_key"]


@pytest.mark.asyncio
async def test_make_master_on_a_missing_user_queues_nothing(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    admin_token, _ = await _admin(client, db_session)
    ghost = "00000000-0000-4000-8000-000000070999"
    resp = await _make_master(client, admin_token, ghost)
    assert resp.status_code == 404, resp.text
    assert await _status_rows(ghost) == []
    # Pair: the same admin's make_master on a real user does queue one.
    real = await _user(client, _TID_B)
    assert (
        await _make_master(client, admin_token, real["user"]["id"])
    ).status_code == 200
    assert len(await _status_rows(real["user"]["id"], VERIFIED)) == 1


# ---------------------------------------------------------------------------
# make_master writes a FRESH verification block (BE-104, delivery 2)
# ---------------------------------------------------------------------------

_GRANTED = "master granted via admin make-master"
_REVERIFIED = "re-verified via admin make-master"


async def _to_pending(client, admin_token, auth) -> None:
    assert (await _apply(client, auth)).status_code == 201


async def _to_rejected(client, admin_token, auth) -> None:
    await _to_pending(client, admin_token, auth)
    resp = await _reject(client, admin_token, auth["user"]["id"], "no")
    assert resp.status_code == 200


async def _to_cancelled(client, admin_token, auth) -> None:
    await _to_pending(client, admin_token, auth)
    resp = await client.delete(
        WITHDRAW_URL,
        headers=auth_headers(auth["session_token"]),
    )
    assert resp.status_code == 204


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("setup", "status_before"),
    [
        (_to_pending, "pending"),
        (_to_rejected, "rejected"),
        (_to_cancelled, "cancelled_by_user"),
    ],
)
async def test_make_master_replaces_the_explicit_none_block(
    client: AsyncClient,
    db_session: AsyncSession,
    setup,
    status_before,
) -> None:
    """EMPTINESS: _build_data stores "verification": None; it is replaced.

    setdefault kept the None, leaving a verified profile that recorded no
    verification at all.
    """
    admin_token, admin_id = await _admin(client, db_session)
    auth = await _user(client, _TID_A)
    uid = auth["user"]["id"]
    await setup(client, admin_token, auth)
    before = await _account(uid)
    assert before["status"] == status_before
    assert before["verification"] is None

    started = datetime.now(UTC)
    assert (await _make_master(client, admin_token, uid)).status_code == 200
    block = (await _account(uid))["verification"]
    assert block["verified_by"] == str(admin_id)
    assert block["notes"] == _REVERIFIED
    assert datetime.fromisoformat(block["verified_at"]) >= started


@pytest.mark.asyncio
async def test_make_master_overwrites_the_block_of_an_earlier_verification(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """suspended -> verified: another admin's old block goes, no history kept."""
    token_b, admin_b = await _admin(client, db_session, _TID_ADMIN_B)
    token_a, admin_a = await _admin(client, db_session)
    auth = await _user(client, _TID_A)
    uid = auth["user"]["id"]
    assert (await _apply(client, auth)).status_code == 201
    assert (await _verify(client, token_b, uid)).status_code == 200
    revoked = await client.post(
        REVOKE_URL.format(user_id=uid),
        headers=auth_headers(token_b),
    )
    assert revoked.status_code == 200, revoked.text
    old = (await _account(uid))["verification"]
    assert old["verified_by"] == str(admin_b)

    assert (await _make_master(client, token_a, uid)).status_code == 200
    new = (await _account(uid))["verification"]
    assert new["verified_by"] == str(admin_a)
    assert new["notes"] == _REVERIFIED
    assert datetime.fromisoformat(new["verified_at"]) > datetime.fromisoformat(
        old["verified_at"]
    )


@pytest.mark.asyncio
async def test_make_master_on_no_profile_names_the_admin(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    admin_token, admin_id = await _admin(client, db_session)
    auth = await _user(client, _TID_A)
    uid = auth["user"]["id"]
    started = datetime.now(UTC)
    assert (await _make_master(client, admin_token, uid)).status_code == 200
    block = (await _account(uid))["verification"]
    assert block["verified_by"] == str(admin_id)
    assert block["notes"] == _GRANTED
    assert datetime.fromisoformat(block["verified_at"]) >= started


@pytest.mark.asyncio
async def test_a_repeated_make_master_leaves_the_block_byte_for_byte(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """REPEAT: the second call is 409 already_master and writes nothing."""
    admin_token, _ = await _admin(client, db_session)
    auth = await _user(client, _TID_A)
    uid = auth["user"]["id"]
    await _to_rejected(client, admin_token, auth)
    assert (await _make_master(client, admin_token, uid)).status_code == 200
    first = await _account(uid)
    assert first["verification"]["notes"] == _REVERIFIED

    again = await _make_master(client, admin_token, uid)
    assert again.status_code == 409, again.text
    assert await _account(uid) == first


@pytest.mark.asyncio
async def test_make_master_on_an_approved_applicant_keeps_verifys_block(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """SHORTAGE: had_master -- verify_master wrote the block, and it stays."""
    token_b, admin_b = await _admin(client, db_session, _TID_ADMIN_B)
    token_a, _ = await _admin(client, db_session)
    auth = await _user(client, _TID_E)
    uid = auth["user"]["id"]
    assert (await _apply(client, auth)).status_code == 201
    assert (await _verify(client, token_b, uid)).status_code == 200
    verified = (await _account(uid))["verification"]
    assert verified["verified_by"] == str(admin_b) and verified["notes"] == "ok"

    assert (await _make_master(client, token_a, uid)).status_code == 200
    assert (await _account(uid))["verification"] == verified
    # Pair: the call did something -- the role moved.
    user = await fresh_get(User, UUID(uid))
    assert user is not None and user.role == UserRole.MASTER.value


# ---------------------------------------------------------------------------
# The race: make_master vs verify_master on one pending profile (BE-104, fork D1)
# ---------------------------------------------------------------------------


async def _pending_applicant(client: AsyncClient, tid: int) -> str:
    auth = await _user(client, tid)
    assert (await _apply(client, auth)).status_code == 201
    return auth["user"]["id"]


def _verify_call(uid: str, admin_id: UUID):
    async def _call(session: AsyncSession) -> object:
        admin = await session.get(User, admin_id)
        return await admin_masters_service.verify_master(
            UUID(uid),
            admin,
            "raced",
            session,
            can_create_groups=True,
        )

    return _call


def _make_master_call(uid: str, admin_id: UUID):
    async def _call(session: AsyncSession) -> object:
        admin = await session.get(User, admin_id)
        return await admin_users_service.make_master(UUID(uid), admin, session)

    return _call


@pytest.mark.asyncio
async def test_make_master_waits_for_a_verification_in_flight(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """verify holds the profile; make_master must wait, then see it verified.

    Before BE-104 make_master read the profile unlocked: both passed their
    guards, the person got master.verified twice, and make_master's stale
    copy overwrote verify's verification block and can_create_groups.
    """
    _, admin_id = await _admin(client, db_session)
    uid = await _pending_applicant(client, _TID_C)

    result = await race(
        monkeypatch,
        holder=_verify_call(uid, admin_id),
        pause_in=(admin_masters_service, "announce_pending_master_offers"),
        rival=_make_master_call(uid, admin_id),
    )
    assert_no_deadlock(result)
    assert result.rival_waited
    assert result.holder.committed, result.holder.error
    assert result.rival.committed, result.rival.error

    assert len(await _status_rows(uid, VERIFIED)) == 1
    account = await _account(uid)
    assert account["status"] == "verified"
    assert account["verification"]["verified_by"] == str(admin_id)
    assert account["verification"]["notes"] == "raced"
    assert account.get("can_create_groups") is True
    user = await fresh_get(User, UUID(uid))
    assert user is not None and user.role == UserRole.MASTER.value


@pytest.mark.asyncio
async def test_a_verification_waits_for_make_master_in_flight(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The other order: make_master holds users -> profile; verify waits, then 409s."""
    _, admin_id = await _admin(client, db_session)
    uid = await _pending_applicant(client, _TID_D)

    result = await race(
        monkeypatch,
        holder=_make_master_call(uid, admin_id),
        pause_in=(admin_users_service, "announce_pending_master_offers"),
        rival=_verify_call(uid, admin_id),
    )
    assert_no_deadlock(result)
    assert result.rival_waited
    assert result.holder.committed, result.holder.error
    assert not result.rival.committed
    assert "not pending" in str(result.rival.error)

    assert len(await _status_rows(uid, VERIFIED)) == 1
    account = await _account(uid)
    # make_master's grant, not the rival's verification, is what stands.
    assert account["verification"]["notes"] == "re-verified via admin make-master"
    assert account["verification"]["verified_by"] == str(admin_id)
    assert account.get("can_create_groups") is not True


# ---------------------------------------------------------------------------
# The profile: types and the variables the sheets read
# ---------------------------------------------------------------------------


def test_the_status_types_are_routed_and_carry_no_category() -> None:
    types = yaml.safe_load((_profile_dir() / "types.yaml").read_text())["types"]
    for key in (*STATUS_TYPES, "master.application_received"):
        assert key in types, key
        assert types[key] == {"channels": ["in_app", "telegram"]}, key


def _sheet_fields(type_: str) -> set[str]:
    fields: set[str] = set()
    for locale in ("ru", "en"):
        sheets = yaml.safe_load(
            (_profile_dir() / "templates" / f"{locale}.yaml").read_text()
        )
        sheet = sheets[type_]["telegram"]
        assert sheet["title"] and sheet["body"], (locale, type_)
        for text in (sheet["title"], sheet["body"]):
            fields |= {name for _, name, _, _ in string.Formatter().parse(text) if name}
    return fields


@pytest.mark.asyncio
async def test_every_variable_a_sheet_reads_is_sent(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """comms renders a missing variable as the literal '{name}' -- send them all."""
    admin_token, _ = await _admin(client, db_session)
    a = await _user(client, _TID_A)
    b = await _user(client, _TID_B)
    assert (await _apply(client, a)).status_code == 201
    assert (await _apply(client, b)).status_code == 201
    assert (await _verify(client, admin_token, a["user"]["id"])).status_code == 200
    assert (await _reject(client, admin_token, b["user"]["id"], "r")).status_code == 200

    sent = {
        r["type"]: r
        for r in [
            *await _status_rows(a["user"]["id"]),
            *await _status_rows(b["user"]["id"]),
        ]
    }
    assert set(sent) == set(STATUS_TYPES)
    for type_, row in sent.items():
        available = set(row.get("action_data") or {}) | {"title", "body"}
        assert _sheet_fields(type_) <= available, type_
    # Pair: the rejected sheet really does read one -- the check is not vacuous.
    assert _sheet_fields(REJECTED) == {"reason"}
