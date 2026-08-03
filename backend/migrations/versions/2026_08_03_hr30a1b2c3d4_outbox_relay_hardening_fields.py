"""outbox relay hardening: next_attempt_at + dead_lettered_at

H-R3 (relay hardening, §8a-3): two nullable timestamptz carriers on
outbox_events -- exponential backoff (next_attempt_at) and dead-letter
marker (dead_lettered_at). Purely additive; NULL is the semantic
default for every existing row ("may be picked up immediately" /
"alive"), so no backfill.

Revision ID: hr30a1b2c3d4
Revises: 9c0d1e2f3a4b
Create Date: 2026-08-03
"""

import sqlalchemy as sa
from alembic import op

revision: str = "hr30a1b2c3d4"
down_revision: str | None = "9c0d1e2f3a4b"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "outbox_events",
        sa.Column(
            "next_attempt_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "outbox_events",
        sa.Column(
            "dead_lettered_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("outbox_events", "dead_lettered_at")
    op.drop_column("outbox_events", "next_attempt_at")
