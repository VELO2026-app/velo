# =============================================================================
# VELO Backend -- the suite's own Redis database (BE-82)
# =============================================================================
#
# The suite used to run against the APPLICATION's Redis database. On the
# stand that is the live product's keyspace (341 348 keys on 2026-10-01),
# and the autouse flush_auth_redis_keys fixture walks the whole keyspace
# with KEYS twice per test -- about 4 000 full walks per run, the bulk of
# the deploy's test time. The suite now runs in a database of its own,
# emptied once per session (conftest.py setup_infrastructure).
#
# TEST_REDIS_DB IS FIXED, NOT "the application's number + 1". With "+1" the
# two could never coincide, the guard below would guard nothing, and its
# branch would document an impossible state. With a fixed 15 the collision
# is a real configuration -- an application set to /15 -- and it is refused
# before anything is flushed. Redis serves 16 databases (0..15) by default;
# docker-compose.yml starts redis-server without --databases.
#
# The rule lives HERE ONLY. velo-manage.sh passes nothing: `velo update`
# runs from a snapshot of the PREVIOUS script, so a rule in the deploy
# script would act one deploy late, while this module ships in the image
# the tests run in.
# =============================================================================

from urllib.parse import urlsplit, urlunsplit

TEST_REDIS_DB = 15


class RedisIsolationError(RuntimeError):
    """The suite's database cannot be told apart from the application's."""


def _masked(url: str) -> str:
    """The URL without its password -- for messages people will read."""
    parts = urlsplit(url)
    if parts.password is None:
        return url
    netloc = parts.netloc.replace(f":{parts.password}@", ":***@", 1)
    return urlunsplit(parts._replace(netloc=netloc))


def _db_of(parts) -> int:
    path = parts.path.strip("/")
    if path == "":
        return 0  # redis-py's default when the URL names no database
    if not path.isdigit():
        raise RedisIsolationError(
            f"cannot read the database number of the application's "
            f"REDIS_URL ({_masked(urlunsplit(parts))}): the suite refuses "
            f"to guess which database it may empty"
        )
    return int(path)


def isolated_redis_url(app_url: str) -> str:
    """The application's Redis URL moved to the suite's own database.

    Same scheme, host, port and credentials; only the database number
    changes, to TEST_REDIS_DB.

    Raises:
        RedisIsolationError: the application itself is on TEST_REDIS_DB, or
            its database number cannot be read -- in both cases emptying the
            suite's database could empty the application's, so nothing is
            emptied and the suite must stop.
    """
    parts = urlsplit(app_url)
    app_db = _db_of(parts)
    if app_db == TEST_REDIS_DB:
        raise RedisIsolationError(
            f"the application's REDIS_URL ({_masked(app_url)}) is on "
            f"database {app_db}, the database the test suite empties at "
            f"start. Refusing to run: the flush would wipe the application's "
            f"keys. Move the application off /{TEST_REDIS_DB}, or change "
            f"TEST_REDIS_DB in backend/tests/redis_isolation.py."
        )
    return urlunsplit(parts._replace(path=f"/{TEST_REDIS_DB}"))
