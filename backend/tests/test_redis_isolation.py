# =============================================================================
# VELO Backend -- the suite's own Redis database (BE-82)
# =============================================================================
#
# No telegram_id band: nothing here touches users. The rule itself lives in
# tests/redis_isolation.py; these tests pin it, and pin that the running
# session really uses it (the layer the claim lives on: the live client's
# connection, not the URL string alone).
# =============================================================================

import pytest

from app.core.config import settings
from app.core.redis import get_redis
from tests.redis_isolation import (
    TEST_REDIS_DB,
    RedisIsolationError,
    isolated_redis_url,
)


class TestTheRule:
    @pytest.mark.parametrize(
        ("app_url", "expected"),
        [
            ("redis://localhost:6379/0", "redis://localhost:6379/15"),
            ("redis://:s3cret@redis:6379/0", "redis://:s3cret@redis:6379/15"),
            ("redis://user:pw@redis:6380/3", "redis://user:pw@redis:6380/15"),
            # No database in the URL is redis-py's database 0.
            ("redis://redis:6379", "redis://redis:6379/15"),
            ("redis://redis:6379/", "redis://redis:6379/15"),
            # The neighbour of the test database is still the application's.
            ("redis://redis:6379/14", "redis://redis:6379/15"),
        ],
    )
    def test_only_the_database_number_changes(
        self, app_url: str, expected: str,
    ) -> None:
        assert isolated_redis_url(app_url) == expected

    def test_an_application_on_the_test_database_is_refused(self) -> None:
        """NEHVATKA: the one configuration where the flush would hit the
        application -- refused, with the reason a person can act on."""
        with pytest.raises(RedisIsolationError) as refusal:
            isolated_redis_url(f"redis://:s3cret@redis:6379/{TEST_REDIS_DB}")
        message = str(refusal.value)
        assert f"database {TEST_REDIS_DB}" in message
        assert "Refusing to run" in message
        assert "redis://:***@redis:6379/15" in message
        assert "s3cret" not in message

    @pytest.mark.parametrize("path", ["/abc", "/1/2", "/-1"])
    def test_an_unreadable_database_number_is_refused(self, path: str) -> None:
        with pytest.raises(RedisIsolationError, match="refuses to guess"):
            isolated_redis_url(f"redis://redis:6379{path}")


class TestTheSession:
    def test_the_session_url_points_at_the_test_database(self) -> None:
        assert settings.redis_url.endswith(f"/{TEST_REDIS_DB}")

    async def test_the_live_client_is_connected_to_the_test_database(
        self,
    ) -> None:
        """The claim at its layer: the connection's own database number."""
        pool_kwargs = get_redis().connection_pool.connection_kwargs
        assert pool_kwargs["db"] == TEST_REDIS_DB
        await get_redis().set("be82:probe", "1", ex=60)
        assert await get_redis().get("be82:probe") is not None
