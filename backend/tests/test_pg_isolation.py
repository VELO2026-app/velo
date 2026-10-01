# =============================================================================
# VELO Backend -- the suite's own Postgres database (BE-86)
# =============================================================================
#
# No telegram_id band: nothing here creates users. The rule lives in
# tests/pg_isolation.py; these tests pin it, the last check before DROP,
# and that the running session really uses it -- on the live engine
# (current_database()), the layer the claim lives on.
# =============================================================================

import pytest
from sqlalchemy import text

from app.core.config import settings
from app.core.database import get_engine
from tests.pg_isolation import (
    TEST_DATABASE,
    PgIsolationError,
    assert_droppable,
    isolated_database_url,
    recreate_database,
)

_APP = "postgresql+asyncpg://velo:s3cret@postgres:5432/velo"


class TestTheRule:
    @pytest.mark.parametrize(
        ("app_url", "expected"),
        [
            (_APP, "postgresql+asyncpg://velo:s3cret@postgres:5432/velo_test"),
            (
                "postgresql+asyncpg://u:p@db:6543/product",
                "postgresql+asyncpg://u:p@db:6543/velo_test",
            ),
            # The neighbour of the test name is still the application's.
            (
                "postgresql+asyncpg://u:p@db/velo_test2",
                "postgresql+asyncpg://u:p@db/velo_test",
            ),
        ],
    )
    def test_only_the_database_name_changes(
        self, app_url: str, expected: str,
    ) -> None:
        assert isolated_database_url(app_url) == expected

    def test_an_application_on_the_test_database_is_refused(self) -> None:
        """NEHVATKA: the configuration where the DROP would hit the app."""
        with pytest.raises(PgIsolationError) as refusal:
            isolated_database_url(
                "postgresql+asyncpg://velo:s3cret@postgres:5432/velo_test"
            )
        message = str(refusal.value)
        assert "Refusing to run" in message
        assert f"'{TEST_DATABASE}'" in message
        assert "s3cret" not in message

    def test_a_url_without_a_database_name_is_refused(self) -> None:
        with pytest.raises(PgIsolationError, match="refuses to guess"):
            isolated_database_url("postgresql+asyncpg://velo:p@postgres:5432")


class TestTheLastCheckBeforeDrop:
    def test_only_the_literal_test_name_may_be_dropped(self) -> None:
        assert_droppable(TEST_DATABASE, "velo")
        for target in ("velo", "velo_test_other", "postgres", ""):
            with pytest.raises(PgIsolationError, match="refusing to DROP"):
                assert_droppable(target, "velo")

    def test_the_test_name_is_refused_when_it_is_the_applications(self) -> None:
        with pytest.raises(PgIsolationError, match="refusing to DROP"):
            assert_droppable(TEST_DATABASE, TEST_DATABASE)

    async def test_another_name_at_the_moment_of_drop_is_refused(self) -> None:
        """The check sits inside recreate_database, right before DROP: a
        target that is not TEST_DATABASE never reaches the statement.

        The target is a name that does not exist, on purpose -- were the
        check gone, DROP IF EXISTS would succeed silently and this test
        would go red, without destroying anything real.
        """
        app_url = settings.database_url.rsplit("/", 1)[0] + "/velo"
        with pytest.raises(PgIsolationError, match="refusing to DROP"):
            await recreate_database(app_url, target="velo_test_other")


class TestTheSession:
    def test_the_session_url_names_the_test_database(self) -> None:
        assert settings.database_url.endswith(f"/{TEST_DATABASE}")

    async def test_the_live_engine_is_connected_to_the_test_database(
        self,
    ) -> None:
        """The claim at its layer -- and it closes the question of a
        module-level engine created at import: that engine would have been
        built from the application's URL and answer 'velo' here."""
        async with get_engine().connect() as conn:
            name = (await conn.execute(text("SELECT current_database()"))).scalar()
        assert name == TEST_DATABASE
