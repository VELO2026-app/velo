# =============================================================================
# VELO Backend -- comms 3.0.0 snapshot version (users.snapshot_version)
# =============================================================================
#
# telegram_id band: 88100-88199. Declared module-level below as
# _TID_MIN/_TID_MAX, once. Checked free before it was claimed: no literal
# 881xx occurs in tests/, and 88000-88099 (test_comms_protocol_3.py) ends
# below it.
#
# What is pinned:
#   1. The TRIGGER (migration cm21a1b2c3d4): +1 on a change of any snapshot
#      field, through the ORM and through ON CONFLICT DO UPDATE; nothing on
#      a write that leaves those fields alone; a value written by code is
#      overridden.
#   2. The SNAPSHOT (core/events/sync.py): version on the wire, read from
#      the row in the emitting session even when the caller's object is
#      stale or from another session; blank strings become null.
#   3. The paths through the endpoints: login, repeat login, PATCH.
# =============================================================================

from collections.abc import AsyncGenerator
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session_factory
from app.core.events.models import OutboxEvent
from app.core.events.service import EVENT_USER_UPSERTED
from app.core.events.sync import emit_user_upserted
from app.modules.users.models import User
from tests.helpers import auth_headers, full_cleanup_range, login_user

_TID_MIN = 88100
_TID_MAX = 88199

_TID_A = 88101
_TID_B = 88102
_TID_C = 88103

ME_URL = "/api/v1/users/me"


@pytest.fixture(autouse=True)
async def cleanup(db_session: AsyncSession) -> AsyncGenerator[None, None]:
    async def _wipe() -> None:
        ids = [
            str(uid) for uid in (
                await db_session.execute(
                    select(User.id).where(
                        User.telegram_id.between(_TID_MIN, _TID_MAX),
                    )
                )
            ).scalars().all()
        ]
        if ids:
            await db_session.execute(
                delete(OutboxEvent).where(
                    OutboxEvent.payload["recipient_id"].astext.in_(ids),
                )
            )
        # Committed HERE: full_cleanup_range opens with a rollback.
        await db_session.commit()
        await full_cleanup_range(
            db_session, _TID_MIN, _TID_MAX, delete_users=True,
        )
        await db_session.commit()

    await _wipe()
    yield
    await _wipe()


async def _version(session: AsyncSession, user_id: str) -> int:
    return (
        await session.execute(
            text("SELECT snapshot_version FROM users WHERE id = :id"),
            {"id": user_id},
        )
    ).scalar_one()


async def _snapshots(session: AsyncSession, user_id: str) -> list[dict]:
    result = await session.execute(
        select(OutboxEvent)
        .where(
            OutboxEvent.event_type == EVENT_USER_UPSERTED,
            OutboxEvent.payload["recipient_id"].astext == user_id,
        )
        .order_by(OutboxEvent.id)
    )
    return [row.payload for row in result.scalars().all()]


async def _sql(session: AsyncSession, statement: str, **params) -> None:
    await session.execute(text(statement), params)
    await session.commit()


# ===========================================================================
# 1. The trigger
# ===========================================================================


@pytest.mark.asyncio
class TestTrigger:
    @pytest.mark.parametrize(
        ("assignment", "params"),
        [
            ("language = :v", {"v": "de"}),
            ("timezone = :v", {"v": "Europe/Berlin"}),
            ("is_active = :v", {"v": False}),
            ("telegram_id = :v", {"v": _TID_C}),
            (
                "credentials = credentials"
                " || jsonb_build_object('email', CAST(:v AS text))",
                {"v": "a@example.com"},
            ),
        ],
    )
    async def test_every_snapshot_field_raises_it_once(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        assignment: str,
        params: dict,
    ) -> None:
        """One field per case -- a field missing from the trigger fails here."""
        user_id = (await login_user(client, telegram_id=_TID_A))["user"]["id"]
        assert await _version(db_session, user_id) == 1

        await _sql(
            db_session,
            f"UPDATE users SET {assignment} WHERE id = :id",
            id=user_id,
            **params,
        )
        assert await _version(db_session, user_id) == 2

    async def test_a_write_that_leaves_the_fields_alone_keeps_it(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """NEHVATKA, with its pair: the row really was rewritten."""
        user_id = (await login_user(client, telegram_id=_TID_A))["user"]["id"]
        await _sql(
            db_session,
            "UPDATE users SET first_name = 'Renamed', "
            "credentials = credentials || '{\"onboarding_completed\": true}' "
            "WHERE id = :id",
            id=user_id,
        )
        row = (
            await db_session.execute(
                text(
                    "SELECT first_name, credentials, snapshot_version "
                    "FROM users WHERE id = :id"
                ),
                {"id": user_id},
            )
        ).one()
        assert row.first_name == "Renamed"
        assert row.credentials["onboarding_completed"] is True
        assert row.snapshot_version == 1

    async def test_the_same_value_again_is_not_a_change(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        user_id = (await login_user(client, telegram_id=_TID_A))["user"]["id"]
        await _sql(
            db_session,
            "UPDATE users SET language = 'de' WHERE id = :id", id=user_id,
        )
        await _sql(
            db_session,
            "UPDATE users SET language = 'de' WHERE id = :id", id=user_id,
        )
        assert await _version(db_session, user_id) == 2

    async def test_code_cannot_write_it(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """The database owns the column: an assigned value is overridden."""
        user_id = (await login_user(client, telegram_id=_TID_A))["user"]["id"]
        await _sql(
            db_session,
            "UPDATE users SET snapshot_version = 50 WHERE id = :id",
            id=user_id,
        )
        assert await _version(db_session, user_id) == 1
        await _sql(
            db_session,
            "UPDATE users SET snapshot_version = 50, language = 'de' "
            "WHERE id = :id",
            id=user_id,
        )
        assert await _version(db_session, user_id) == 2

    async def test_on_conflict_do_update_raises_it_too(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """The login path's statement form, past the ORM."""
        user_id = (await login_user(client, telegram_id=_TID_A))["user"]["id"]
        for language in ("ru", "ru"):
            await db_session.execute(
                pg_insert(User)
                .values(telegram_id=_TID_A, language=language)
                .on_conflict_do_update(
                    index_elements=["telegram_id"],
                    set_={"language": language},
                )
            )
            await db_session.commit()
        assert await _version(db_session, user_id) == 2

    async def test_a_new_row_starts_at_one(
        self, db_session: AsyncSession,
    ) -> None:
        """A row inserted without the column -- what every existing row got."""
        await _sql(
            db_session,
            "INSERT INTO users (id, telegram_id) "
            "VALUES (gen_random_uuid(), :tid)",
            tid=_TID_B,
        )
        version = (
            await db_session.execute(
                text("SELECT snapshot_version FROM users WHERE telegram_id = :t"),
                {"t": _TID_B},
            )
        ).scalar_one()
        assert version == 1


# ===========================================================================
# 2. The snapshot
# ===========================================================================


@pytest.mark.asyncio
class TestSnapshot:
    async def test_a_stale_object_from_another_session_sends_the_row(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """The /masters/apply shape: the object is not this session's.

        The row moves on after the object was loaded; the snapshot must
        carry the row's content AND the row's version, one state of it.
        """
        user_id = (await login_user(client, telegram_id=_TID_A))["user"]["id"]
        factory = get_session_factory()
        async with factory() as reader:
            stale = await reader.get(User, UUID(user_id))
            assert stale.language == "en"

        await _sql(
            db_session,
            "UPDATE users SET language = 'de' WHERE id = :id", id=user_id,
        )
        async with factory() as writer:
            await emit_user_upserted(writer, stale)
            await writer.commit()

        last = (await _snapshots(db_session, user_id))[-1]
        assert last["locale"] == "de"
        assert last["version"] == 2

    async def test_two_changes_with_a_flush_between_raise_it_twice(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """POVTOR: each change reaches the row, each snapshot its own version."""
        user_id = (await login_user(client, telegram_id=_TID_A))["user"]["id"]
        user = await db_session.get(User, UUID(user_id))
        user.language = "de"
        await emit_user_upserted(db_session, user)
        user.timezone = "Europe/Berlin"
        await emit_user_upserted(db_session, user)
        await db_session.commit()

        *_, first, second = await _snapshots(db_session, user_id)
        assert (first["version"], first["locale"]) == (2, "de")
        assert (second["version"], second["timezone"]) == (3, "Europe/Berlin")

    async def test_no_credentials_at_all_is_a_null_email(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """NEHVATKA: `{}` -- email null, every other key present."""
        user_id = (await login_user(client, telegram_id=_TID_A))["user"]["id"]
        await _sql(
            db_session,
            "UPDATE users SET credentials = '{}' WHERE id = :id", id=user_id,
        )
        user = await db_session.get(User, UUID(user_id))
        await emit_user_upserted(db_session, user)
        await db_session.commit()

        last = (await _snapshots(db_session, user_id))[-1]
        assert last["email"] is None
        assert last["version"] == 1
        assert last["locale"] == "en"
        assert last["timezone"] == "UTC"
        assert last["telegram_id"] == _TID_A


# ===========================================================================
# 3. Through the endpoints
# ===========================================================================


@pytest.mark.asyncio
class TestPaths:
    async def test_a_repeat_login_is_a_replay(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """POVTOR: the snapshot goes out again, at the same version.

        A returning login changes no snapshot field, so for comms it is an
        equal version with equal content -- a replay, applied nowhere.
        """
        user_id = (await login_user(client, telegram_id=_TID_A))["user"]["id"]
        await login_user(client, telegram_id=_TID_A)

        first, second = await _snapshots(db_session, user_id)
        assert first == second
        assert first["version"] == 1

    async def test_a_patch_raises_it_and_a_repeat_patch_does_not(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        auth = await login_user(client, telegram_id=_TID_A)
        user_id = auth["user"]["id"]
        headers = auth_headers(auth["session_token"])
        for _ in range(2):
            resp = await client.patch(
                ME_URL, json={"language": "ru"}, headers=headers,
            )
            assert resp.status_code == 200, resp.text

        _login, changed, repeated = await _snapshots(db_session, user_id)
        assert (changed["version"], changed["locale"]) == (2, "ru")
        assert repeated == changed

    async def test_a_cleared_email_is_null_and_a_new_version(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """PUSTOTA: "" is the velo "cleared", null on the wire."""
        auth = await login_user(client, telegram_id=_TID_A)
        user_id = auth["user"]["id"]
        headers = auth_headers(auth["session_token"])
        for email in ("sync@example.com", ""):
            resp = await client.patch(
                ME_URL, json={"email": email}, headers=headers,
            )
            assert resp.status_code == 200, resp.text

        *_, set_, cleared = await _snapshots(db_session, user_id)
        assert (set_["version"], set_["email"]) == (2, "sync@example.com")
        assert (cleared["version"], cleared["email"]) == (3, None)
        assert cleared["locale"] == "en"

    async def test_a_blank_language_is_stored_but_sent_as_null(
        self, client: AsyncClient, db_session: AsyncSession,
    ) -> None:
        """PUSTOTA, and the product defect it hides.

        PATCH accepts language=" " (min_length=1, no strip) and stores it;
        comms refuses a blank locale. The snapshot sends null -- the pair
        pins that the blank really is in the row, so this test goes red the
        day the validator is fixed and the case becomes unreachable.
        """
        auth = await login_user(client, telegram_id=_TID_A)
        user_id = auth["user"]["id"]
        resp = await client.patch(
            ME_URL,
            json={"language": " "},
            headers=auth_headers(auth["session_token"]),
        )
        assert resp.status_code == 200, resp.text

        stored = (
            await db_session.execute(
                text("SELECT language FROM users WHERE id = :id"),
                {"id": user_id},
            )
        ).scalar_one()
        assert stored == " "
        last = (await _snapshots(db_session, user_id))[-1]
        assert last["locale"] is None
        assert last["version"] == 2
        assert last["timezone"] == "UTC"
        assert last["telegram_id"] == _TID_A
