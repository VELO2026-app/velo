# =============================================================================
# VELO Backend -- the suite's own Postgres database (BE-86, BE-191)
# =============================================================================
#
# No telegram_id band: nothing here creates users. The rule lives in
# tests/pg_isolation.py; these tests pin the name rule, the run's lock on
# its database, the reset, and that the running session really went
# through them -- on the live server (current_database(), pg_namespace,
# alembic_version), the layer the claims live on.
#
# The reset and the lock are tested on things the running session does not
# use -- a probe schema, a probe lock key, a database that does not exist --
# so that no test here can drop the session's schema or steal its lock.
# =============================================================================

from pathlib import Path

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import settings
from app.core.database import get_engine
from tests import pg_isolation
from tests.pg_isolation import (
    SESSION_LOCK_KEY,
    PgIsolationError,
    acquire_session_lock,
    reset_schema,
)

_PROBE_SCHEMA = "be191_probe"
_PROBE_LOCK_KEY = SESSION_LOCK_KEY + 1
_BACKEND = Path(__file__).resolve().parents[1]


def _on_database(name: str) -> str:
    """The session's URL moved to database `name` -- same server, same role."""
    return (
        make_url(settings.database_url)
        .set(database=name)
        .render_as_string(
            hide_password=False,
        )
    )


class TestTheRule:
    @pytest.mark.parametrize(
        "url",
        [
            "postgresql+asyncpg://velo:s3cret@postgres:5432/velo_test",
            "postgresql+asyncpg://u:p@db:6543/product_test",
        ],
    )
    def test_a_test_database_is_taken_as_it_is(self, url: str) -> None:
        assert pg_isolation.test_database_url(url) == url

    @pytest.mark.parametrize(
        "name",
        [
            "velo",  # the application's own
            "velo_test2",  # the neighbour of a test name
            "velo_test_old",
            "test_velo",  # the word, not the suffix
            "_test_velo",
            "VELO_TEST",  # Postgres keeps a quoted name's case
        ],
    )
    def test_a_name_without_the_suffix_is_refused(self, name: str) -> None:
        """NEHVATKA: any database the machine would not give the suite."""
        with pytest.raises(PgIsolationError) as refusal:
            pg_isolation.test_database_url(
                f"postgresql+asyncpg://velo:s3cret@postgres:5432/{name}"
            )
        message = str(refusal.value)
        assert "Refusing to run" in message
        assert f"'{name}'" in message
        assert "s3cret" not in message

    @pytest.mark.parametrize(
        "url",
        ["postgresql+asyncpg://velo:s3cret@postgres:5432", "postgresql+asyncpg://"],
    )
    def test_a_url_without_a_database_name_is_refused(self, url: str) -> None:
        """PUSTOTA."""
        with pytest.raises(PgIsolationError, match="names no database") as refusal:
            pg_isolation.test_database_url(url)
        assert "s3cret" not in str(refusal.value)

    def test_a_url_that_cannot_be_parsed_is_refused(self) -> None:
        with pytest.raises(PgIsolationError, match="cannot parse"):
            pg_isolation.test_database_url("not a url at all")


class TestTheReset:
    async def test_the_reset_empties_the_schema_and_keeps_it(self) -> None:
        """The reset on a probe schema: a table with a row before, the schema
        present and empty after. "Nothing left" goes with "the schema is
        there" -- a reset that dropped and never created would pass the
        first half alone."""
        engine = create_async_engine(settings.database_url, poolclass=NullPool)
        try:
            async with engine.begin() as conn:
                await conn.execute(
                    text(f'DROP SCHEMA IF EXISTS "{_PROBE_SCHEMA}" CASCADE')
                )
                await conn.execute(text(f'CREATE SCHEMA "{_PROBE_SCHEMA}"'))
                await conn.execute(
                    text(f'CREATE TABLE "{_PROBE_SCHEMA}".leftover (n int)')
                )
                await conn.execute(
                    text(f'INSERT INTO "{_PROBE_SCHEMA}".leftover VALUES (1)')
                )
            try:
                xact_id = await reset_schema(
                    settings.database_url,
                    schema=_PROBE_SCHEMA,
                )
                async with engine.connect() as conn:
                    left = (
                        await conn.execute(
                            text(
                                "SELECT count(*) FROM pg_class c JOIN"
                                " pg_namespace n ON n.oid = c.relnamespace"
                                " WHERE n.nspname = :s"
                            ),
                            {"s": _PROBE_SCHEMA},
                        )
                    ).scalar_one()
                    xmin = (
                        await conn.execute(
                            text(
                                "SELECT xmin::text FROM pg_namespace WHERE nspname = :s"
                            ),
                            {"s": _PROBE_SCHEMA},
                        )
                    ).scalar_one_or_none()
            finally:
                async with engine.begin() as conn:
                    await conn.execute(
                        text(f'DROP SCHEMA IF EXISTS "{_PROBE_SCHEMA}" CASCADE')
                    )
        finally:
            await engine.dispose()
        assert left == 0
        assert xmin is not None, "the reset dropped the schema and never made it"
        # The id it returns is the transaction that made the new schema.
        assert int(xmin) == xact_id % 2**32

    async def test_a_foreign_schema_is_refused_and_left_alone(self) -> None:
        """NEHVATKA: a schema the suite did not create stops the reset --
        before the reset's own schema is touched."""
        foreign = "be191_foreign"
        engine = create_async_engine(settings.database_url, poolclass=NullPool)
        try:
            async with engine.begin() as conn:
                for name in (foreign, _PROBE_SCHEMA):
                    await conn.execute(text(f'DROP SCHEMA IF EXISTS "{name}" CASCADE'))
                    await conn.execute(text(f'CREATE SCHEMA "{name}"'))
                await conn.execute(text(f'CREATE TABLE "{_PROBE_SCHEMA}".kept (n int)'))
            try:
                with pytest.raises(PgIsolationError) as refusal:
                    await reset_schema(settings.database_url, schema=_PROBE_SCHEMA)
                async with engine.connect() as conn:
                    kept = (
                        await conn.execute(
                            text("SELECT to_regclass(:t) IS NOT NULL"),
                            {"t": f"{_PROBE_SCHEMA}.kept"},
                        )
                    ).scalar_one()
            finally:
                async with engine.begin() as conn:
                    for name in (foreign, _PROBE_SCHEMA):
                        await conn.execute(
                            text(f'DROP SCHEMA IF EXISTS "{name}" CASCADE')
                        )
        finally:
            await engine.dispose()
        message = str(refusal.value)
        assert "did not create" in message
        assert foreign in message
        assert kept, "the refused reset dropped its schema all the same"

    async def test_a_database_that_does_not_exist_is_refused(self) -> None:
        """NEHVATKA: the suite does not create its database, and says so --
        without the password."""
        url = _on_database("be191_absent_test")
        with pytest.raises(
            PgIsolationError, match="does not create its database"
        ) as refusal:
            await reset_schema(url)
        password = make_url(settings.database_url).password
        if password:
            assert password not in str(refusal.value)


class TestTheLock:
    async def test_a_key_held_by_another_connection_is_refused(self) -> None:
        """Another run is in the database: refused. And the pair -- the same
        key, once free, is taken: the refusal is about the holder, not
        about the key."""
        holder_engine = create_async_engine(
            settings.database_url,
            poolclass=NullPool,
            isolation_level="AUTOCOMMIT",
        )
        try:
            async with holder_engine.connect() as holder:
                assert (
                    await holder.execute(
                        text("SELECT pg_try_advisory_lock(:k)"),
                        {"k": _PROBE_LOCK_KEY},
                    )
                ).scalar_one()
                with pytest.raises(PgIsolationError, match="another run"):
                    await acquire_session_lock(
                        settings.database_url,
                        key=_PROBE_LOCK_KEY,
                    )
            # The holder's connection is closed: its lock went with it.
            lock = await acquire_session_lock(
                settings.database_url,
                key=_PROBE_LOCK_KEY,
            )
            await lock.release()
        finally:
            await holder_engine.dispose()

    async def test_this_session_holds_its_lock(self) -> None:
        """The running session holds the lock on its database: a second run
        started now is refused."""
        with pytest.raises(PgIsolationError, match="another run"):
            await acquire_session_lock(settings.database_url)


class TestTheSession:
    def test_the_session_url_names_a_test_database(self) -> None:
        assert make_url(settings.database_url).database.endswith("_test")

    async def test_the_live_engine_is_connected_to_the_given_database(
        self,
    ) -> None:
        """The claim at its layer -- and it closes the question of a
        module-level engine created at import from some other URL."""
        async with get_engine().connect() as conn:
            name = (await conn.execute(text("SELECT current_database()"))).scalar()
        assert name == make_url(settings.database_url).database

    async def test_public_was_made_by_this_sessions_reset(self) -> None:
        """No data of an earlier run: `public` itself is the one this
        session's reset created -- its pg_namespace row was written by the
        reset's transaction. Compared by equality, not by "newer than":
        transaction ids wrap around."""
        assert pg_isolation.session_reset_xact_id is not None
        async with get_engine().connect() as conn:
            xmin = (
                await conn.execute(
                    text("SELECT xmin::text FROM pg_namespace WHERE nspname = 'public'")
                )
            ).scalar_one()
        assert int(xmin) == pg_isolation.session_reset_xact_id % 2**32

    async def test_the_schema_is_the_alembic_head(self) -> None:
        """After the reset, alembic built the schema to its one head."""
        config = Config(str(_BACKEND / "alembic.ini"))
        config.set_main_option("script_location", str(_BACKEND / "migrations"))
        heads = ScriptDirectory.from_config(config).get_heads()
        assert len(heads) == 1
        async with get_engine().connect() as conn:
            versions = (
                (await conn.execute(text("SELECT version_num FROM alembic_version")))
                .scalars()
                .all()
            )
        assert versions == heads
