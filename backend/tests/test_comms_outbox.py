# =============================================================================
# VELO Backend -- Comms outbox / relay / sync tests (Phase 6 / T0)
# =============================================================================
#
# Test band: telegram_ids 89400-89499 (assigned in the T0 review; velo
# band registry: 89000-89199, 89370, 89900-89999 taken by earlier
# suites, 83xxx by the legacy suites).
#
# Covers:
#   1. emit_event -- same-transaction semantics (rollback kills the
#      event), envelope discipline (v stamped, unknown types and
#      non-JSON values rejected), id ordering within a session.
#   2. relay_pending_batch -- publishes pending rows in id order to
#      the comms stream, marks published_at; PER-EVENT error handling
#      (mandatory review fix #1): a poison row gets attempts++ and a
#      WARN at the threshold while the REST of the batch publishes;
#      connection errors abort the pass without charging attempts.
#   3. Identity sync emits -- login upsert, PATCH /users/me on synced
#      fields (and silence on non-synced), snapshot null discipline.
#   4. Group sync emits -- capability deltas: admin verify (+masters),
#      revoke (-masters), self-switch silence, CLI set_role.
#   5. Backfill -- N users -> N snapshots + memberships; repeat run is
#      harmless by contract idempotency (fresh identical snapshots).
#
# Relay tests talk to the REAL test Redis (settings.redis_url) via a
# throwaway stream name -- the relay client is passed in explicitly,
# so no comms stack is needed.
# =============================================================================

import json
from unittest.mock import patch

import pytest
from redis import asyncio as aioredis
from redis.exceptions import ConnectionError as RedisConnectionError
from sqlalchemy import delete, select

from app.core.config import settings
from app.core.events import (
    EVENT_GROUP_CHANGED,
    EVENT_USER_UPSERTED,
    GROUP_ADMINS,
    GROUP_MASTERS,
    OutboxEvent,
    emit_event,
    user_snapshot,
)
from app.core.events.relay import build_envelope, relay_pending_batch
from app.modules.users.models import User
from tests.helpers import (
    auth_headers,
    cleanup_range,
    login_user,
)

pytestmark = pytest.mark.asyncio

# -- Band bookkeeping --------------------------------------------------------

TID_EMIT = 89400
TID_PATCH = 89401
TID_VERIFY = 89410
TID_ADMIN = 89411
TID_REVOKE = 89412
TID_ADMIN2 = 89413
TID_SWITCH = 89420
TID_SWITCH_ADMIN = 89421
TID_BACKFILL_A = 89430
TID_BACKFILL_B = 89431
TID_CLI = 89440

BAND_MIN, BAND_MAX = 89400, 89499


@pytest.fixture(autouse=True)
async def _clean_band(db_session):
    """Reset band users + drain their outbox rows around every test."""
    async def _drain() -> None:
        await cleanup_range(db_session, BAND_MIN, BAND_MAX)
        # Outbox rows have no FK to users; drain everything the band's
        # tests emitted (test DB, the table is ours to sweep).
        await db_session.execute(delete(OutboxEvent))
        await db_session.commit()

    await _drain()
    yield
    await _drain()


async def _pending_events(session) -> list[OutboxEvent]:
    result = await session.execute(
        select(OutboxEvent).order_by(OutboxEvent.id)
    )
    return list(result.scalars().all())


async def _events_for(session, recipient_id: str) -> list[OutboxEvent]:
    events = await _pending_events(session)
    return [
        e for e in events
        if e.payload.get("recipient_id") == recipient_id
    ]


# ===========================================================================
# 1. emit_event
# ===========================================================================


class TestEmitEvent:
    async def test_stamps_version_and_orders_ids(self, db_session):
        e1 = await emit_event(
            db_session, EVENT_GROUP_CHANGED,
            {"group_key": "masters", "recipient_id": "x" * 8, "member": True},
        )
        e2 = await emit_event(
            db_session, EVENT_GROUP_CHANGED,
            {"group_key": "masters", "recipient_id": "y" * 8, "member": False},
        )
        assert e1.payload["v"] == 1
        assert e2.id > e1.id  # publication order mirrors emission order
        await db_session.rollback()

    async def test_same_transaction_rollback_kills_event(self, db_session):
        await emit_event(
            db_session, EVENT_GROUP_CHANGED,
            {"group_key": "masters", "recipient_id": "z", "member": True},
        )
        await db_session.rollback()
        assert await _pending_events(db_session) == []

    async def test_rejects_unknown_type_and_non_json_values(self, db_session):
        with pytest.raises(ValueError, match="unknown outbox event type"):
            await emit_event(db_session, "booking_confirmed", {})
        with pytest.raises(ValueError, match="must not carry 'v'"):
            await emit_event(db_session, EVENT_USER_UPSERTED, {"v": 1})
        with pytest.raises(ValueError, match="stringify UUIDs"):
            from uuid import uuid4
            await emit_event(
                db_session, EVENT_USER_UPSERTED, {"recipient_id": uuid4()}
            )
        await db_session.rollback()


# ===========================================================================
# 2. Relay
# ===========================================================================


@pytest.fixture
async def relay_redis():
    """A client to the TEST redis + a throwaway stream, cleaned after."""
    redis = aioredis.from_url(settings.redis_url, decode_responses=False)
    stream = "test:comms:events:89400"
    try:
        with patch.object(settings, "comms_events_stream", stream):
            yield redis, stream
    finally:
        await redis.delete(stream)
        await redis.aclose()


class TestRelay:
    async def test_publishes_in_order_and_marks_published(
        self, db_session, relay_redis
    ):
        redis, stream = relay_redis
        for n in range(3):
            await emit_event(
                db_session, EVENT_GROUP_CHANGED,
                {"group_key": "masters", "recipient_id": f"r{n}", "member": True},
            )
        await db_session.commit()

        published, failed = await relay_pending_batch(redis)
        assert (published, failed) == (3, 0)

        entries = await redis.xrange(stream)
        assert len(entries) == 3
        recipients = [
            json.loads(fields[b"data"])["recipient_id"]
            for _, fields in entries
        ]
        assert recipients == ["r0", "r1", "r2"]  # id order on the wire
        assert entries[0][1][b"event"] == EVENT_GROUP_CHANGED.encode()

        events = await _pending_events(db_session)
        assert all(e.published_at is not None for e in events)

        # Second pass: nothing pending.
        assert await relay_pending_batch(redis) == (0, 0)

    async def test_poison_event_does_not_block_batch(
        self, db_session, relay_redis
    ):
        """Mandatory review fix #1: per-event errors, not per-batch."""
        redis, stream = relay_redis
        ids = []
        for n in range(3):
            e = await emit_event(
                db_session, EVENT_GROUP_CHANGED,
                {"group_key": "masters", "recipient_id": f"p{n}", "member": True},
            )
            ids.append(e.id)
        await db_session.commit()
        poison_id = ids[0]

        real_xadd = redis.xadd

        async def xadd_poisoned(stream_name, fields, *a, **kw):
            if json.loads(fields["data"])["recipient_id"] == "p0":
                raise RuntimeError("malformed for the wire")
            return await real_xadd(stream_name, fields, *a, **kw)

        with (
            patch.object(redis, "xadd", side_effect=xadd_poisoned),
            patch.object(settings, "comms_relay_warn_every_attempts", 2),
        ):
            # Pass 1: poison fails (attempts=1), the other two publish.
            assert await relay_pending_batch(redis) == (2, 1)
            # Pass 2: only the poison row is pending; attempts hits the
            # threshold (2) -> the WARN branch fires.
            assert await relay_pending_batch(redis) == (0, 1)

        entries = await redis.xrange(stream)
        recipients = [
            json.loads(fields[b"data"])["recipient_id"]
            for _, fields in entries
        ]
        assert recipients == ["p1", "p2"]  # the pipe kept moving

        events = await _pending_events(db_session)
        poison = next(e for e in events if e.id == poison_id)
        assert poison.published_at is None  # never dropped, still pending
        assert poison.attempts == 2
        others = [e for e in events if e.id != poison_id]
        assert all(e.published_at is not None for e in others)
        assert all(e.attempts == 0 for e in others)

    async def test_connection_error_aborts_without_charging_attempts(
        self, db_session, relay_redis
    ):
        redis, _stream = relay_redis
        await emit_event(
            db_session, EVENT_GROUP_CHANGED,
            {"group_key": "masters", "recipient_id": "c0", "member": True},
        )
        await db_session.commit()

        with patch.object(
            redis, "xadd", side_effect=RedisConnectionError("down")
        ):
            assert await relay_pending_batch(redis) == (0, 0)

        events = await _pending_events(db_session)
        assert events[0].attempts == 0  # infra, not poison
        assert events[0].published_at is None

        # Redis back up -> next tick ships it.
        assert await relay_pending_batch(redis) == (1, 0)

    async def test_envelope_shape_matches_contract(self, db_session):
        e = await emit_event(
            db_session, EVENT_USER_UPSERTED,
            {
                "recipient_id": "00000000-0000-0000-0000-000000000000",
                "telegram_id": None,
                "email": None,
                "locale": "en",
                "timezone": None,
                "active": True,
            },
        )
        envelope = build_envelope(e)
        assert set(envelope) == {"event", "data"}
        data = json.loads(envelope["data"])
        assert data["v"] == 1
        # Snapshot discipline: every contract key present, explicit nulls.
        assert set(data) == {
            "v", "recipient_id", "telegram_id", "email", "locale",
            "timezone", "active",
        }
        await db_session.rollback()


# ===========================================================================
# 3. Identity sync emits
# ===========================================================================


class TestIdentitySync:
    async def test_login_upsert_emits_snapshot(self, client, db_session):
        login = await login_user(client, telegram_id=TID_EMIT)
        user_id = login["user"]["id"]

        events = await _events_for(db_session, user_id)
        assert len(events) == 1
        e = events[0]
        assert e.event_type == EVENT_USER_UPSERTED
        assert e.payload["telegram_id"] == TID_EMIT
        assert e.payload["active"] is True
        assert e.payload["email"] is None  # explicit null, key present
        assert "role" not in e.payload  # role is NOT in the contract

        # Returning login re-emits the (idempotent) snapshot.
        await login_user(client, telegram_id=TID_EMIT)
        assert len(await _events_for(db_session, user_id)) == 2

    async def test_profile_patch_emits_only_for_synced_fields(
        self, client, db_session
    ):
        login = await login_user(client, telegram_id=TID_PATCH)
        user_id = login["user"]["id"]
        token = login["session_token"]
        baseline = len(await _events_for(db_session, user_id))

        # Non-synced field -> silence.
        resp = await client.patch(
            "/api/v1/users/me",
            headers=auth_headers(token),
            json={"first_name": "Renamed"},
        )
        assert resp.status_code == 200
        assert len(await _events_for(db_session, user_id)) == baseline

        # Synced fields -> one snapshot with the new values.
        resp = await client.patch(
            "/api/v1/users/me",
            headers=auth_headers(token),
            json={"language": "ru", "email": "sync@example.com"},
        )
        assert resp.status_code == 200
        events = await _events_for(db_session, user_id)
        assert len(events) == baseline + 1
        assert events[-1].payload["locale"] == "ru"
        assert events[-1].payload["email"] == "sync@example.com"

    async def test_snapshot_maps_empty_email_to_null(self, db_session):
        class Duck:
            from uuid import uuid4
            id = uuid4()
            telegram_id = 89499
            credentials = {"email": ""}
            language = "en"
            timezone = "UTC"
            is_active = True

        snap = user_snapshot(Duck())
        assert snap["email"] is None


# ===========================================================================
# 4. Group sync emits (capability deltas)
# ===========================================================================



def _apply_body(name: str) -> dict:
    """Minimal valid master application payload (mirrors test_admin_masters)."""
    return {
        "profile": {
            "display_name": name,
            "email": "sync@test.com",
            "phone": "+1234567890",
        },
        "experience": {
            "methods": ["meditation"],
            "experience_years": 5,
            "bio": "comms sync test master",
            "certifications": [],
        },
        "documents": [],
    }

async def _make_admin(db_session, telegram_id: int) -> User:
    result = await db_session.execute(
        select(User).where(User.telegram_id == telegram_id)
    )
    user = result.scalar_one()
    user.role = "admin"
    await db_session.commit()
    await db_session.refresh(user)
    return user


class TestGroupSync:
    async def test_admin_verify_emits_masters_join(self, client, db_session):
        # Applicant applies (pending -- no capability, no event).
        applicant = await login_user(client, telegram_id=TID_VERIFY)
        resp = await client.post(
            "/api/v1/masters/apply",
            headers=auth_headers(applicant["session_token"]),
            json=_apply_body("Sync Master"),
        )
        assert resp.status_code in (200, 201), resp.text
        group_events = [
            e for e in await _events_for(db_session, applicant["user"]["id"])
            if e.event_type == EVENT_GROUP_CHANGED
        ]
        assert group_events == []  # pending != capability

        # Admin verifies -> +masters (snapshot belt precedes membership).
        admin = await login_user(client, telegram_id=TID_ADMIN)
        await _make_admin(db_session, TID_ADMIN)
        resp = await client.post(
            f"/api/v1/admin/masters/{applicant['user']['id']}/verify",
            headers=auth_headers(admin["session_token"]),
            json={"notes": "ok"},
        )
        assert resp.status_code == 200, resp.text

        events = await _events_for(db_session, applicant["user"]["id"])
        group_events = [
            e for e in events if e.event_type == EVENT_GROUP_CHANGED
        ]
        assert len(group_events) == 1
        assert group_events[0].payload["group_key"] == GROUP_MASTERS
        assert group_events[0].payload["member"] is True
        # Ordering belt: the snapshot emitted in the same transaction
        # has a SMALLER id than the membership event.
        belt_snapshots = [
            e for e in events
            if e.event_type == EVENT_USER_UPSERTED
            and e.id < group_events[0].id
        ]
        assert belt_snapshots  # at least the belt (login also emitted one)

    async def test_admin_revoke_emits_masters_leave(self, client, db_session):
        # Mint a verified master via apply + verify.
        applicant = await login_user(client, telegram_id=TID_REVOKE)
        resp = await client.post(
            "/api/v1/masters/apply",
            headers=auth_headers(applicant["session_token"]),
            json=_apply_body("Revoke Master"),
        )
        assert resp.status_code in (200, 201), resp.text
        admin = await login_user(client, telegram_id=TID_ADMIN2)
        await _make_admin(db_session, TID_ADMIN2)
        resp = await client.post(
            f"/api/v1/admin/masters/{applicant['user']['id']}/verify",
            headers=auth_headers(admin["session_token"]),
            json={"notes": "ok"},
        )
        assert resp.status_code == 200, resp.text

        resp = await client.post(
            f"/api/v1/admin/masters/{applicant['user']['id']}/revoke",
            headers=auth_headers(admin["session_token"]),
        )
        assert resp.status_code == 200, resp.text

        group_events = [
            e for e in await _events_for(db_session, applicant["user"]["id"])
            if e.event_type == EVENT_GROUP_CHANGED
            and e.payload["group_key"] == GROUP_MASTERS
        ]
        assert [e.payload["member"] for e in group_events] == [True, False]

    async def test_self_role_switch_is_silent(self, client, db_session):
        """A verified master flipping modes must NOT flap membership."""
        applicant = await login_user(client, telegram_id=TID_SWITCH)
        resp = await client.post(
            "/api/v1/masters/apply",
            headers=auth_headers(applicant["session_token"]),
            json=_apply_body("Switch Master"),
        )
        assert resp.status_code in (200, 201), resp.text
        admin = await login_user(client, telegram_id=TID_SWITCH_ADMIN)
        await _make_admin(db_session, TID_SWITCH_ADMIN)
        resp = await client.post(
            f"/api/v1/admin/masters/{applicant['user']['id']}/verify",
            headers=auth_headers(admin["session_token"]),
            json={"notes": "ok"},
        )
        assert resp.status_code == 200, resp.text
        before = len(await _events_for(db_session, applicant["user"]["id"]))

        # master mode -> back to user mode: capability held, silence.
        resp = await client.post(
            "/api/v1/users/me/role",
            headers=auth_headers(applicant["session_token"]),
            json={"role": "master"},
        )
        assert resp.status_code == 200, resp.text
        resp = await client.post(
            "/api/v1/users/me/role",
            headers=auth_headers(applicant["session_token"]),
            json={"role": "user"},
        )
        assert resp.status_code == 200, resp.text

        assert (
            len(await _events_for(db_session, applicant["user"]["id"]))
            == before
        )

    async def test_cli_set_role_round_trip(self, client, db_session):
        """scripts/set_role.py: to_admin emits +admins, to_user drops all."""
        from scripts.set_role import to_admin, to_master, to_user

        login = await login_user(client, telegram_id=TID_CLI)
        result = await db_session.execute(
            select(User).where(User.telegram_id == TID_CLI)
        )
        user = result.scalar_one()

        assert await to_admin(db_session, user, assume_yes=True)
        assert await to_master(db_session, user, assume_yes=True)
        assert await to_user(db_session, user, assume_yes=True)
        await db_session.commit()

        group_events = [
            (e.payload["group_key"], e.payload["member"])
            for e in await _events_for(db_session, login["user"]["id"])
            if e.event_type == EVENT_GROUP_CHANGED
        ]
        assert group_events == [
            (GROUP_ADMINS, True),     # to_admin
            (GROUP_MASTERS, True),    # to_master (+ admins drop below)
            (GROUP_ADMINS, False),    # to_master cleared role/marker
            (GROUP_MASTERS, False),   # to_user suspended the profile
        ]


# ===========================================================================
# 5. Backfill
# ===========================================================================


class TestBackfill:
    async def test_backfill_projects_users_and_is_harmless_on_repeat(
        self, client, db_session
    ):
        from scripts.backfill_comms_sync import backfill

        a = await login_user(client, telegram_id=TID_BACKFILL_A)
        await login_user(client, telegram_id=TID_BACKFILL_B)
        await _make_admin(db_session, TID_BACKFILL_B)

        # Drain the login-time events: the backfill run is measured alone.
        await db_session.execute(delete(OutboxEvent))
        await db_session.commit()

        users, masters, admins = await backfill()
        assert users >= 2  # the whole test DB; ours are among them
        assert admins >= 1

        events_a = await _events_for(db_session, a["user"]["id"])
        assert [e.event_type for e in events_a] == [EVENT_USER_UPSERTED]

        # Repeat run: fresh identical snapshots, nothing corrupted --
        # harmless by the contract's natural idempotency (comms upserts).
        users2, masters2, admins2 = await backfill()
        assert (users2, masters2, admins2) == (users, masters, admins)
        events_a2 = await _events_for(db_session, a["user"]["id"])
        assert len(events_a2) == 2
        assert events_a2[0].payload == events_a2[1].payload
