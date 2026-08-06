# =============================================================================
# VELO Backend — Alembic Environment Configuration
# =============================================================================
#
# This file tells Alembic HOW to run migrations.
#
# KEY POINTS:
#   1. We use ASYNC migrations (run_async_migrations) because our engine
#      is async. Standard Alembic expects sync — we bridge the gap here.
#   2. Database URL comes from app.core.config (reads .env), NOT from
#      alembic.ini — single source of truth for connection settings.
#   3. target_metadata = Base.metadata tells Alembic what the schema
#      SHOULD look like. It compares this against the actual DB to
#      generate --autogenerate migrations.
#
# IMPORTANT:
#   Every new models.py file must be imported here (or transitively
#   through app.core.database) so Alembic can see the tables.
# =============================================================================

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.config import settings
from app.core.database import Base

# Import all models so Alembic can detect them via Base.metadata.
# Add new model imports here as modules are created.
from app.modules.reports.models import Report  # noqa: F401
from app.modules.users.models import User  # noqa: F401
from app.modules.masters.models import MasterProfile  # noqa: F401
from app.modules.practices.models import Practice  # noqa: F401
from app.modules.bookings.models import Booking  # noqa: F401
from app.modules.waitlist.models import Waitlist  # noqa: F401  # Phase 5.3
from app.modules.payments.models import (  # noqa: F401  # Phase 6.1-6.4
    CompanyLedger,
    MasterLedger,
    Payment,
    Purchase,
    UserLedger,
)
from app.modules.withdrawals.models import Withdrawal  # noqa: F401  # Phase 6.6
from app.modules.promos.models import Promo  # noqa: F401  # Phase 6.7
from app.modules.practices.taxonomy_models import TaxonomyDirection, TaxonomyStyle  # noqa: F401  # R5
from app.core.events.models import OutboxEvent  # noqa: F401  # Phase 6 / T0
from app.modules.chats.models import ChatThread  # noqa: F401  # Phase 6 / T2

# ---------------------------------------------------------------------------
# Alembic Config object — provides access to alembic.ini values.
# ---------------------------------------------------------------------------
config = context.config

# Setup Python logging from alembic.ini [loggers] section.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# ---------------------------------------------------------------------------
# Target metadata — Alembic compares this against DB to find changes.
# ---------------------------------------------------------------------------
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    Generates SQL scripts without connecting to the database.
    Useful for: reviewing SQL before applying, CI/CD pipelines,
    environments where DB access isn't available.

    Usage: alembic upgrade head --sql
    """
    context.configure(
        url=settings.database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection) -> None:  # type: ignore[no-untyped-def]
    """Execute migrations using the provided connection."""
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """Run migrations in 'online' mode with async engine.

    Standard Alembic is synchronous. Since we use asyncpg (async driver),
    we create an async engine, get a sync connection from it via
    run_sync(), and pass that to Alembic's migration runner.

    TD-013: dispose() is called in finally to ensure the engine is always
    cleaned up, even if connect() raises (e.g. DB unreachable at startup).
    """
    connectable = create_async_engine(
        settings.database_url,
        pool_pre_ping=True,
    )

    try:
        async with connectable.connect() as connection:
            await connection.run_sync(do_run_migrations)
    finally:
        await connectable.dispose()


def run_migrations_online() -> None:
    """Entry point for online migrations — bridges async to sync."""
    asyncio.run(run_async_migrations())


# ---------------------------------------------------------------------------
# Decide which mode to run in.
# ---------------------------------------------------------------------------
if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
