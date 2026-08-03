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
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from redis import asyncio as aioredis
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError
from sqlalchemy import delete, or_, select, update

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
from app.core.events.outbox_admin import list_dead_events, requeue_events
from app.core.events.relay import (
    build_envelope,
    create_relay_redis,
    relay_pending_batch,
)
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

# Synthetic recipient_id prefix for rows emitted directly (not via a
# band user): lets the cleanup fixture target OUR rows and only ours.
SYNTH = "t89400-"


@pytest.fixture(autouse=True)
async def _clean_band(db_session):
    """Reset band users + drain OUR outbox rows around every test.

    TARGETED cleanup only (post-T0 finding #1): outbox rows are deleted
    iff their recipient_id belongs to a band user or carries the SYNTH
    prefix. The rest of the (live, shared) outbox -- other suites'
    events and the production audit trail -- is not ours to sweep.
    """
    async def _drain() -> None:
        # Band-user uuids BEFORE cleanup (cleanup does not delete the
        # users themselves, but collect first to be order-proof).
        result = await db_session.execute(
            select(User.id).where(
                User.telegram_id.between(BAND_MIN, BAND_MAX)
            )
        )
        band_ids = [str(uid) for uid in result.scalars().all()]
        await cleanup_range(db_session, BAND_MIN, BAND_MAX)
        recipient = OutboxEvent.payload["recipient_id"].astext
        conditions = [recipient.like(f"{SYNTH}%")]
        if band_ids:
            conditions.append(recipient.in_(band_ids))
        await db_session.execute(delete(OutboxEvent).where(or_(*conditions)))
        await db_session.commit()

    await _drain()
    yield
    await _drain()


async def _pending_events(session) -> list[OutboxEvent]:
    result = await session.execute(
        select(OutboxEvent).order_by(OutboxEvent.id)
    )
    return list(result.scalars().all())


async def _park_foreign_pending(session) -> None:
    """Mark every currently-pending row published INSIDE the test tx.

    Relay tests inject their session and must neither count nor
    consume foreign pending rows of the shared live outbox (other
    suites' committed events between live-relay ticks). Parking them
    in-transaction makes the pass see OUR rows only; the test's final
    rollback un-parks them untouched -- the live relay ships them
    later as if we were never here.
    """
    await session.execute(
        update(OutboxEvent)
        .where(OutboxEvent.published_at.is_(None))
        .values(published_at=datetime.now(UTC))
    )


async def _synth_events(session) -> list[OutboxEvent]:
    """This suite's directly-emitted rows (SYNTH-prefixed), id order."""
    return [
        e
        for e in await _pending_events(session)
        if str(e.payload.get("recipient_id", "")).startswith(SYNTH)
    ]


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
            {"group_key": "masters", "recipient_id": f"{SYNTH}x", "member": True},
        )
        e2 = await emit_event(
            db_session, EVENT_GROUP_CHANGED,
            {"group_key": "masters", "recipient_id": f"{SYNTH}y", "member": False},
        )
        assert e1.payload["v"] == 1
        assert e2.id > e1.id  # publication order mirrors emission order
        await db_session.rollback()

    async def test_same_transaction_rollback_kills_event(self, db_session):
        await emit_event(
            db_session, EVENT_GROUP_CHANGED,
            {"group_key": "masters", "recipient_id": f"{SYNTH}z", "member": True},
        )
        await db_session.rollback()
        # Scoped to OUR rows: the shared live outbox may hold foreign
        # events -- they are not this assertion's business.
        assert await _synth_events(db_session) == []

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
        await _park_foreign_pending(db_session)
        for n in range(3):
            await emit_event(
                db_session, EVENT_GROUP_CHANGED,
                {"group_key": "masters",
                 "recipient_id": f"{SYNTH}r{n}", "member": True},
            )
        # NO commit: the rows stay invisible to the live server relay
        # (post-T0 finding #1); the pass runs in OUR transaction.
        published, failed = await relay_pending_batch(
            redis, session=db_session
        )
        assert (published, failed) == (3, 0)

        entries = await redis.xrange(stream)
        assert len(entries) == 3
        recipients = [
            json.loads(fields[b"data"])["recipient_id"]
            for _, fields in entries
        ]
        assert recipients == [f"{SYNTH}r{n}" for n in range(3)]  # id order on the wire
        assert entries[0][1][b"event"] == EVENT_GROUP_CHANGED.encode()

        events = await _synth_events(db_session)
        assert len(events) == 3
        assert all(e.published_at is not None for e in events)

        # Second pass: nothing pending (same transaction).
        assert await relay_pending_batch(redis, session=db_session) == (0, 0)
        await db_session.rollback()  # nothing persists past the test

    async def test_poison_event_does_not_block_batch(
        self, db_session, relay_redis
    ):
        """Mandatory review fix #1: per-event errors, not per-batch."""
        redis, stream = relay_redis
        await _park_foreign_pending(db_session)
        ids = []
        for n in range(3):
            e = await emit_event(
                db_session, EVENT_GROUP_CHANGED,
                {"group_key": "masters",
                 "recipient_id": f"{SYNTH}p{n}", "member": True},
            )
            ids.append(e.id)
        poison_id = ids[0]  # uncommitted -- invisible to the live relay

        real_xadd = redis.xadd

        async def xadd_poisoned(stream_name, fields, *a, **kw):
            if json.loads(fields["data"])["recipient_id"] == f"{SYNTH}p0":
                raise RuntimeError("malformed for the wire")
            return await real_xadd(stream_name, fields, *a, **kw)

        with (
            patch.object(redis, "xadd", side_effect=xadd_poisoned),
            patch.object(settings, "comms_relay_warn_every_attempts", 2),
        ):
            # Pass 1: poison fails (attempts=1), the other two publish.
            assert await relay_pending_batch(redis, session=db_session) == (2, 1)
            # H-R3: the failure assigned a backoff -- pass 2 would now
            # skip the row (see TestRelayHardening). Lapse it directly:
            # this test's subject is the WARN threshold and the moving
            # pipe, not the backoff itself.
            events = await _synth_events(db_session)
            next(e for e in events if e.id == poison_id).next_attempt_at = None
            await db_session.flush()
            # Pass 2: only the poison row is pending; attempts hits the
            # threshold (2) -> the WARN branch fires.
            assert await relay_pending_batch(redis, session=db_session) == (0, 1)

        entries = await redis.xrange(stream)
        recipients = [
            json.loads(fields[b"data"])["recipient_id"]
            for _, fields in entries
        ]
        assert recipients == [f"{SYNTH}p1", f"{SYNTH}p2"]  # the pipe kept moving

        events = await _synth_events(db_session)
        poison = next(e for e in events if e.id == poison_id)
        assert poison.published_at is None  # never dropped, still pending
        assert poison.attempts == 2
        others = [e for e in events if e.id != poison_id]
        assert all(e.published_at is not None for e in others)
        assert all(e.attempts == 0 for e in others)
        await db_session.rollback()

    async def test_connection_error_aborts_without_charging_attempts(
        self, db_session, relay_redis
    ):
        redis, _stream = relay_redis
        await _park_foreign_pending(db_session)
        await emit_event(
            db_session, EVENT_GROUP_CHANGED,
            {"group_key": "masters", "recipient_id": f"{SYNTH}c0", "member": True},
        )
        # NO commit (see the ordering test).
        with patch.object(
            redis, "xadd", side_effect=RedisConnectionError("down")
        ):
            assert await relay_pending_batch(redis, session=db_session) == (0, 0)

        events = await _synth_events(db_session)
        assert events[0].attempts == 0  # infra, not poison
        assert events[0].published_at is None

        # Redis back up -> next tick ships it.
        assert await relay_pending_batch(redis, session=db_session) == (1, 0)
        await db_session.rollback()

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


class TestRelayHardening:
    """H-R3 (§8a-3): backoff + ceiling/DLQ + timeouts + requeue.

    Same conventions as TestRelay: SYNTH-marked rows, no commit, the
    autouse _clean_band drains our rows. NOTE for the band registry:
    the issued band 89680-89699 is NOT consumed -- this suite creates
    no users (synthetic recipient_ids only), recorded in the H-R3
    report.
    """

    async def _emit_synth(self, session, tag: str):
        return await emit_event(
            session, EVENT_GROUP_CHANGED,
            {"group_key": "masters",
             "recipient_id": f"{SYNTH}{tag}", "member": True},
        )

    @staticmethod
    def _always_poison(redis):
        return patch.object(
            redis, "xadd", side_effect=RuntimeError("malformed"),
        )

    async def test_poison_gets_backoff_alive_row_ships_immediately(
        self, db_session, relay_redis
    ):
        """Twin pair: the poison row leaves the pass with a FUTURE
        next_attempt_at and is NOT selectable next pass; a fresh alive
        row (next_attempt_at NULL) ships without any delay."""
        redis, _stream = relay_redis
        await _park_foreign_pending(db_session)
        poison = await self._emit_synth(db_session, "bo-p")

        real_xadd = redis.xadd

        async def xadd_poisoned(stream_name, fields, *a, **kw):
            if json.loads(fields["data"])["recipient_id"] == f"{SYNTH}bo-p":
                raise RuntimeError("malformed for the wire")
            return await real_xadd(stream_name, fields, *a, **kw)

        with patch.object(redis, "xadd", side_effect=xadd_poisoned):
            assert await relay_pending_batch(redis, session=db_session) == (0, 1)

            now = datetime.now(UTC)
            events = await _synth_events(db_session)
            row = next(e for e in events if e.id == poison.id)
            # Backoff from POST-increment attempts: base(2.0) * 2**1.
            assert row.attempts == 1
            assert row.dead_lettered_at is None
            assert row.next_attempt_at is not None
            assert row.next_attempt_at > now
            assert row.next_attempt_at <= now + timedelta(seconds=10)

            # Alive row emitted AFTER: ships in the very next pass while
            # the backed-off poison is not even selected (0 failed).
            await self._emit_synth(db_session, "bo-a")
            assert await relay_pending_batch(redis, session=db_session) == (1, 0)
            events = await _synth_events(db_session)
            row = next(e for e in events if e.id == poison.id)
            assert row.attempts == 1  # untouched: filtered out, not retried
        await db_session.rollback()

    async def test_backoff_lapse_makes_row_selectable_again(
        self, db_session, relay_redis
    ):
        """Direct-state twin: next_attempt_at in the past -> picked up;
        in the future -> skipped. No sleeping, state built directly."""
        redis, _stream = relay_redis
        await _park_foreign_pending(db_session)
        e = await self._emit_synth(db_session, "lapse")

        e.next_attempt_at = datetime.now(UTC) + timedelta(minutes=5)
        await db_session.flush()
        assert await relay_pending_batch(redis, session=db_session) == (0, 0)

        e.next_attempt_at = datetime.now(UTC) - timedelta(seconds=1)
        await db_session.flush()
        assert await relay_pending_batch(redis, session=db_session) == (1, 0)
        await db_session.rollback()

    async def test_ceiling_dead_letters_once_and_leaves_the_select(
        self, db_session, relay_redis
    ):
        """attempts hits the ceiling -> dead_lettered_at set, published_at
        stays NULL, next_attempt_at NOT assigned on death, and the row is
        excluded from the next pass -- so a second ERROR is impossible by
        construction."""
        redis, _stream = relay_redis
        await _park_foreign_pending(db_session)
        e = await self._emit_synth(db_session, "dl")
        # One failure away from the ceiling; clear any pending delay so
        # the pass picks it up.
        e.attempts = settings.comms_relay_max_attempts - 1
        e.next_attempt_at = None
        await db_session.flush()

        with self._always_poison(redis):
            assert await relay_pending_batch(redis, session=db_session) == (0, 1)
            events = await _synth_events(db_session)
            row = next(x for x in events if x.id == e.id)
            assert row.attempts == settings.comms_relay_max_attempts
            assert row.dead_lettered_at is not None
            assert row.published_at is None  # the truth: never shipped
            assert row.next_attempt_at is None  # no backoff for the dead

            # Second pass: the dead row is not selected -- (0, 0), so it
            # cannot fail (or ERROR) again.
            assert await relay_pending_batch(redis, session=db_session) == (0, 0)
            events = await _synth_events(db_session)
            row = next(x for x in events if x.id == e.id)
            assert row.attempts == settings.comms_relay_max_attempts
        await db_session.rollback()

    async def test_head_of_line_survives_the_ceiling(
        self, db_session, relay_redis
    ):
        """T0 invariant alive at the ceiling: the row DYING in this pass
        does not stop the rest of the batch from publishing."""
        redis, _stream = relay_redis
        await _park_foreign_pending(db_session)
        dying = await self._emit_synth(db_session, "hd-p")
        alive = await self._emit_synth(db_session, "hd-a")
        dying.attempts = settings.comms_relay_max_attempts - 1
        await db_session.flush()

        real_xadd = redis.xadd

        async def xadd_poisoned(stream_name, fields, *a, **kw):
            if json.loads(fields["data"])["recipient_id"] == f"{SYNTH}hd-p":
                raise RuntimeError("malformed for the wire")
            return await real_xadd(stream_name, fields, *a, **kw)

        with patch.object(redis, "xadd", side_effect=xadd_poisoned):
            assert await relay_pending_batch(redis, session=db_session) == (1, 1)

        events = await _synth_events(db_session)
        dead = next(x for x in events if x.id == dying.id)
        ok = next(x for x in events if x.id == alive.id)
        assert dead.dead_lettered_at is not None
        assert ok.published_at is not None
        await db_session.rollback()

    async def test_infra_error_assigns_no_backoff_and_never_kills(
        self, db_session, relay_redis
    ):
        """Extended infra twin (item 4): a redis TimeoutError aborts the
        pass; attempts, next_attempt_at AND dead_lettered_at are all
        untouched -- even at attempts == max - 1."""
        redis, _stream = relay_redis
        await _park_foreign_pending(db_session)
        e = await self._emit_synth(db_session, "inf")
        e.attempts = settings.comms_relay_max_attempts - 1
        await db_session.flush()

        with patch.object(
            redis, "xadd", side_effect=RedisTimeoutError("hung socket")
        ):
            assert await relay_pending_batch(redis, session=db_session) == (0, 0)

        events = await _synth_events(db_session)
        row = next(x for x in events if x.id == e.id)
        assert row.attempts == settings.comms_relay_max_attempts - 1
        assert row.next_attempt_at is None
        assert row.dead_lettered_at is None

        # Pipe back up -> ships normally.
        assert await relay_pending_batch(redis, session=db_session) == (1, 0)
        await db_session.rollback()

    async def test_relay_redis_factory_carries_socket_timeouts(self):
        """done-when item 4: the timeouts are visible in from_url."""
        captured: dict = {}

        def fake_from_url(url, **kwargs):
            captured.update(kwargs, url=url)
            return object()

        with patch.object(aioredis, "from_url", side_effect=fake_from_url):
            create_relay_redis()

        assert captured["socket_connect_timeout"] == (
            settings.comms_relay_socket_connect_timeout_seconds
        )
        assert captured["socket_timeout"] == (
            settings.comms_relay_socket_timeout_seconds
        )

    async def test_requeue_revives_and_relay_ships_it(
        self, db_session, relay_redis
    ):
        """Item 5 service-level integration: list-dead sees the corpse,
        requeue clears BOTH markers and KEEPS attempts, the next pass
        publishes the row for real."""
        redis, stream = relay_redis
        await _park_foreign_pending(db_session)
        e = await self._emit_synth(db_session, "rq")
        e.attempts = settings.comms_relay_max_attempts - 1
        await db_session.flush()

        with self._always_poison(redis):
            assert await relay_pending_batch(redis, session=db_session) == (0, 1)

        dead = [
            x for x in await list_dead_events(db_session)
            if str(x.payload.get("recipient_id", "")).startswith(SYNTH)
        ]
        assert [x.id for x in dead] == [e.id]

        revived = await requeue_events(db_session, event_ids=[e.id])
        assert revived == 1

        events = await _synth_events(db_session)
        row = next(x for x in events if x.id == e.id)
        assert row.dead_lettered_at is None
        assert row.next_attempt_at is None
        assert row.attempts == settings.comms_relay_max_attempts  # history

        # Poison fixed (real xadd) -> ships on the next pass.
        assert await relay_pending_batch(redis, session=db_session) == (1, 0)
        entries = await redis.xrange(stream)
        assert any(
            json.loads(f[b"data"])["recipient_id"] == f"{SYNTH}rq"
            for _, f in entries
        )
        await db_session.rollback()

    async def test_requeue_all_and_argument_validation(self, db_session):
        """--all revives every dead row; exactly-one-scope is enforced."""
        await _park_foreign_pending(db_session)
        e1 = await self._emit_synth(db_session, "ra1")
        e2 = await self._emit_synth(db_session, "ra2")
        now = datetime.now(UTC)
        e1.dead_lettered_at = now
        e2.dead_lettered_at = now
        e2.next_attempt_at = now
        await db_session.flush()

        with pytest.raises(ValueError):
            await requeue_events(db_session)
        with pytest.raises(ValueError):
            await requeue_events(
                db_session, event_ids=[e1.id], requeue_all=True,
            )

        revived = await requeue_events(db_session, requeue_all=True)
        assert revived >= 2  # ours for sure; foreign dead rows (if any) too
        events = await _synth_events(db_session)
        for x in events:
            assert x.dead_lettered_at is None
            assert x.next_attempt_at is None
        await db_session.rollback()


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

        # No global drain (post-T0 finding #1): measure per-user DELTAS
        # against whatever the shared outbox already holds.
        base_a = len(await _events_for(db_session, a["user"]["id"]))

        users, masters, admins = await backfill()
        assert users >= 2  # the whole test DB; ours are among them
        assert admins >= 1

        events_a = await _events_for(db_session, a["user"]["id"])
        assert len(events_a) == base_a + 1  # exactly one snapshot per run
        assert events_a[-1].event_type == EVENT_USER_UPSERTED

        # Repeat run: fresh identical snapshots, nothing corrupted --
        # harmless by the contract's natural idempotency (comms upserts).
        users2, masters2, admins2 = await backfill()
        assert (users2, masters2, admins2) == (users, masters, admins)
        events_a2 = await _events_for(db_session, a["user"]["id"])
        assert len(events_a2) == base_a + 2
        assert events_a2[-1].payload == events_a2[-2].payload
