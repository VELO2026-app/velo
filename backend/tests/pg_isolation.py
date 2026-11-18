# =============================================================================
# VELO Backend -- the suite's own Postgres database (BE-86, BE-191)
# =============================================================================
#
# The suite runs in a database of its own, never in the application's: on a
# shared server the application's database holds the live product, and a
# suite there leaves test rows the live relay ships to comms (BE-86).
#
# THE DATABASE IS GIVEN, NOT MADE (BE-191, PRIMER-PROTOCOL 7.1-7.2). The
# deploy machine creates `<name>_test` with the role of the application's
# DATABASE_URL, keeps it between runs, and hands the suite a ready
# DATABASE_URL on it. The suite takes that URL as it is and never creates,
# drops or leaves the database it was given: no DROP DATABASE, no CREATE
# DATABASE, no connection to the server's maintenance database, no CREATEDB.
# What the suite owns is the CONTENT, and it empties it at the start of every
# session (reset_schema): `public` is dropped and created again in one
# transaction, and alembic builds the schema from zero -- the property the
# old per-session DROP/CREATE DATABASE had, inside the given database.
#
# THREE REFUSALS, all before the first statement that changes anything, all
# stopping the run with exit code 3 (conftest.py setup_infrastructure):
#   1. the database name does not end in `_test` (or cannot be read) -- the
#      URL is then not the one the machine gives the suite, and it may be
#      the application's (test_database_url);
#   2. another run holds this database (acquire_session_lock) -- a second
#      session's reset would drop the schema under the first one and leave
#      it red or, worse, green on someone else's tables;
#   3. the database holds a schema other than `public` and the system ones
#      (reset_schema) -- the suite did not create it and does not drop it,
#      and with the default search_path `"$user", public` a schema named
#      after the role would take the tables alembic creates, out of reach
#      of the next reset.
#
# The rule lives HERE ONLY: the machine passes nothing but DATABASE_URL.
# =============================================================================

from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError, DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool

TEST_SUFFIX = "_test"

# The key of the session-level advisory lock one run holds on its database.
# Any constant does; advisory keys are per database, so runs on two
# different `*_test` databases of one server do not exclude each other.
SESSION_LOCK_KEY = 191_000_086

# Schemas the server itself keeps in every database. pg_toast_temp_N and
# pg_temp_N are per-backend and come and go with other sessions.
_SYSTEM_SCHEMAS = ("pg_catalog", "information_schema", "pg_toast")
_SYSTEM_SCHEMA_PREFIXES = ("pg_temp_", "pg_toast_temp_")

# The transaction id of this session's reset, set by conftest.py once
# reset_schema returns -- read by test_pg_isolation.py to prove the reset
# ran in THIS session, not in some earlier one.
session_reset_xact_id: int | None = None


class PgIsolationError(RuntimeError):
    """The database the suite was given cannot be used, or cannot be
    prepared."""


def _masked(url: str) -> str:
    try:
        return make_url(url).render_as_string(hide_password=True)
    except ArgumentError:
        return "<a URL that cannot be parsed>"


def test_database_url(url: str) -> str:
    """The URL the suite was given, if it names a `*_test` database.

    Returned unchanged: the suite works in exactly the database it was
    given. The suffix is matched as it is written -- Postgres keeps a quoted
    name's case, so `VELO_TEST` is another database, not a test one.

    Raises:
        PgIsolationError: the URL cannot be parsed, names no database, or
            names one that does not end in TEST_SUFFIX.
    """
    try:
        name = make_url(url).database
    except ArgumentError as exc:
        raise PgIsolationError(
            f"cannot parse DATABASE_URL ({_masked(url)}): the suite refuses "
            f"to guess which database it may empty"
        ) from exc
    if not name:
        raise PgIsolationError(
            f"DATABASE_URL ({_masked(url)}) names no database: the suite "
            f"refuses to guess which database it may empty"
        )
    if not name.endswith(TEST_SUFFIX):
        raise PgIsolationError(
            f"DATABASE_URL ({_masked(url)}) is on database '{name}', whose "
            f"name does not end in '{TEST_SUFFIX}'. Refusing to run: the "
            f"suite empties the database it is given, and this one may be "
            f"the application's. Give the suite its own '<name>{TEST_SUFFIX}' "
            f"database (the deploy machine does)."
        )
    return url


# Not a test, despite the name: pytest must not collect it where imported.
test_database_url.__test__ = False  # type: ignore[attr-defined]


def _unusable(url: str, exc: BaseException) -> PgIsolationError:
    """A connection or statement failure, said once, without the password."""
    detail = str(getattr(exc, "orig", None) or exc).strip().splitlines()
    first = detail[0] if detail else type(exc).__name__
    lowered = str(exc).lower()
    if "does not exist" in lowered and "database" in lowered:
        hint = (
            " The suite does not create its database: the deploy machine "
            "does, and CI's Postgres service does through POSTGRES_DB."
        )
    elif "permission denied" in lowered or "must be owner" in lowered:
        hint = (
            " The role of DATABASE_URL must own the database (the deploy "
            "machine creates it with that role)."
        )
    else:
        hint = ""
    return PgIsolationError(
        f"cannot prepare the test database ({_masked(url)}): {first}.{hint}"
    )


class SessionLock:
    """One run's hold on its database: a session-level advisory lock on a
    connection of its own, outside any transaction, kept until release().

    The lock goes with the connection -- on release(), and on the death of
    the process, when the server closes the connection.
    """

    def __init__(self, engine: AsyncEngine, conn: AsyncConnection) -> None:
        self._engine = engine
        self._conn = conn

    async def release(self) -> None:
        try:
            await self._conn.close()
        finally:
            await self._engine.dispose()


async def acquire_session_lock(
    url: str,
    key: int = SESSION_LOCK_KEY,
) -> SessionLock:
    """Take this run's lock on its database, or refuse.

    `key` is a parameter only so the refusal can be tested on a key the
    running session does not hold; the session passes nothing.

    Raises:
        PgIsolationError: another connection holds the key -- another run
            is in this database -- or the database cannot be reached.
    """
    engine = create_async_engine(
        url,
        poolclass=NullPool,
        isolation_level="AUTOCOMMIT",
    )
    try:
        conn = await engine.connect()
    except (DBAPIError, OSError) as exc:
        await engine.dispose()
        raise _unusable(url, exc) from exc
    try:
        taken = (
            await conn.execute(
                text("SELECT pg_try_advisory_lock(:key)"),
                {"key": key},
            )
        ).scalar_one()
    except (DBAPIError, OSError) as exc:
        await conn.close()
        await engine.dispose()
        raise _unusable(url, exc) from exc
    if not taken:
        await conn.close()
        await engine.dispose()
        raise PgIsolationError(
            f"another run is in the test database ({_masked(url)}): it holds "
            f"the suite's advisory lock {key}. Refusing to run: this run's "
            f"reset would drop the schema under it. Wait for it to end."
        )
    return SessionLock(engine, conn)


def _is_system(schema: str) -> bool:
    return schema in _SYSTEM_SCHEMAS or schema.startswith(
        _SYSTEM_SCHEMA_PREFIXES,
    )


async def reset_schema(url: str, schema: str = "public") -> int:
    """Empty the test database: DROP SCHEMA `schema` CASCADE and CREATE it
    again, in ONE transaction, as the role of `url`.

    One transaction: a run killed between the two statements leaves the
    database as it was, never without its schema. CASCADE takes every
    object in the schema, whoever owns it -- the schema's owner may drop
    them all (Postgres DROP SCHEMA). The new schema belongs to the role;
    the USAGE grant to PUBLIC of a fresh database's `public` is not
    reproduced -- the suite has one role.

    `schema` is a parameter only so the reset can be tested on a probe
    schema without destroying the running session's; the session passes
    nothing.

    Returns:
        The id of the reset's transaction (pg_current_xact_id): the xmin of
        the new schema's pg_namespace row is its low 32 bits.

    Raises:
        PgIsolationError: the database holds a non-system schema other than
            `public` and `schema` (refusal 3 of the module header), or it
            cannot be reached or emptied -- with the masked URL.
    """
    engine = create_async_engine(url, poolclass=NullPool)
    try:
        async with engine.begin() as conn:
            names = (
                (await conn.execute(text("SELECT nspname FROM pg_namespace")))
                .scalars()
                .all()
            )
            foreign = sorted(
                name
                for name in names
                if not _is_system(name) and name not in ("public", schema)
            )
            if foreign:
                raise PgIsolationError(
                    f"the test database ({_masked(url)}) holds schemas the "
                    f"suite did not create: {', '.join(foreign)}. Refusing "
                    f"to run: the suite does not drop what it did not "
                    f"create, and a schema named after the role takes the "
                    f"tables alembic creates. Remove them, or give the suite "
                    f"a fresh database."
                )
            xact_id = int(
                (
                    await conn.execute(text("SELECT pg_current_xact_id()::text"))
                ).scalar_one()
            )
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
            await conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    except (DBAPIError, OSError) as exc:
        raise _unusable(url, exc) from exc
    finally:
        await engine.dispose()
    return xact_id
