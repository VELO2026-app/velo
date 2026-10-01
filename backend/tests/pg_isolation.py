# =============================================================================
# VELO Backend -- the suite's own Postgres database (BE-86)
# =============================================================================
#
# The suite used to run in the APPLICATION's database. On the stand that is
# the live product's: test users created and deleted by telegram_id band,
# test rows in outbox_events (57 249 on 2026-10-01) that the live app's
# relay publishes to comms -- the "phantom rows" of every deploy -- and
# whole-table reads of outbox_events that cost every update ~90 s. The
# suite now runs in a database of its own, DROPPED and CREATED at the start
# of each session and migrated from zero (conftest.py setup_infrastructure).
#
# TEST_DATABASE IS FIXED, NOT "<application>_test", for the reason of
# redis_isolation.py: a derived name could never coincide with the
# application's, and the guard would guard nothing. With a fixed name the
# collision is a real configuration -- an application on `velo_test` -- and
# it is refused before anything is touched.
#
# TWO CHECKS, ON PURPOSE. isolated_database_url refuses the configuration
# when the URL is read; assert_droppable refuses the DROP itself,
# immediately before it, on the literal name it is about to drop. The
# second one does not trust the first: it is the last line before a
# statement that destroys a database.
#
# The rule lives HERE ONLY -- velo-manage.sh passes nothing (`velo update`
# runs from a snapshot of the previous script; this module ships in the
# image the tests run in).
# =============================================================================

from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine

TEST_DATABASE = "velo_test"
_MAINTENANCE_DATABASE = "postgres"


class PgIsolationError(RuntimeError):
    """The suite's database cannot be told apart from the application's,
    or cannot be prepared."""


def _masked(url: str) -> str:
    return make_url(url).render_as_string(hide_password=True)


def _database_of(url: str) -> str:
    name = make_url(url).database
    if not name:
        raise PgIsolationError(
            f"cannot read the database name of the application's "
            f"DATABASE_URL ({_masked(url)}): the suite refuses to guess "
            f"which database it may drop"
        )
    return name


def isolated_database_url(app_url: str) -> str:
    """The application's database URL moved to the suite's own database.

    Same driver, host, port and credentials; only the name changes, to
    TEST_DATABASE.

    Raises:
        PgIsolationError: the application itself is on TEST_DATABASE, or
            its database name cannot be read.
    """
    app_db = _database_of(app_url)
    if app_db == TEST_DATABASE:
        raise PgIsolationError(
            f"the application's DATABASE_URL ({_masked(app_url)}) is on "
            f"database '{app_db}', the database the test suite DROPS at "
            f"start. Refusing to run: the drop would destroy the "
            f"application's data. Move the application off '{TEST_DATABASE}', "
            f"or change TEST_DATABASE in backend/tests/pg_isolation.py."
        )
    return make_url(app_url).set(database=TEST_DATABASE).render_as_string(
        hide_password=False,
    )


def assert_droppable(target: str, app_database: str) -> None:
    """The last check before DROP DATABASE: only the literal TEST_DATABASE,
    and never the application's database, whatever led here."""
    if target != TEST_DATABASE or target == app_database:
        raise PgIsolationError(
            f"refusing to DROP DATABASE '{target}': the suite drops only "
            f"'{TEST_DATABASE}', and never the application's "
            f"('{app_database}')"
        )


async def recreate_database(app_url: str, target: str = TEST_DATABASE) -> None:
    """DROP and CREATE `target` on the application's server.

    Connects to the server's maintenance database with the application's
    credentials (a database cannot be dropped from inside itself).
    `target` is a parameter only so the refusal can be tested; the session
    passes nothing.

    Raises:
        PgIsolationError: the drop is refused (assert_droppable), or the
            role may not create databases -- with the one action that fixes
            it.
    """
    app_database = _database_of(app_url)
    maintenance = make_url(app_url).set(database=_MAINTENANCE_DATABASE)
    engine = create_async_engine(maintenance, isolation_level="AUTOCOMMIT")
    try:
        async with engine.connect() as conn:
            assert_droppable(target, app_database)
            try:
                await conn.execute(
                    text(f'DROP DATABASE IF EXISTS "{target}" WITH (FORCE)')
                )
                await conn.execute(text(f'CREATE DATABASE "{target}"'))
            except DBAPIError as exc:
                if "permission denied" in str(exc).lower():
                    role = make_url(app_url).username
                    raise PgIsolationError(
                        f"the database role '{role}' may not create the test "
                        f"database '{target}'. One action fixes it, on the "
                        f"server: ALTER ROLE {role} CREATEDB;"
                    ) from exc
                raise
    finally:
        await engine.dispose()
