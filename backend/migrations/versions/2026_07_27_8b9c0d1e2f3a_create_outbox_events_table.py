# =============================================================================
# Create outbox_events -- the transactional outbox to comms (Phase 6 / T0)
# =============================================================================
#
# One table: pending domain events awaiting publication to the comms
# Redis Stream by the background relay (app/core/events/relay.py).
# BIGSERIAL pk (publication order), JSONB payload (the event `data`
# document of the frozen comms wire contract, incl. "v"), lifecycle
# columns published_at / attempts, and a partial index over the
# pending tail (the relay's steady-state scan predicate).
# =============================================================================

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "8b9c0d1e2f3a"
down_revision: str | None = "7a8b9c0d1e2f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "outbox_events",
        sa.Column(
            "id",
            sa.BigInteger(),
            sa.Identity(always=False),
            primary_key=True,
        ),
        sa.Column("event_type", sa.String(length=50), nullable=False),
        sa.Column("payload", JSONB(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "attempts",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
    )
    op.create_index(
        "ix_outbox_events_unpublished",
        "outbox_events",
        ["id"],
        postgresql_where=sa.text("published_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_outbox_events_unpublished", table_name="outbox_events")
    op.drop_table("outbox_events")
