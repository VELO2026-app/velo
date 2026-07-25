"""add_practice_audience

Revision ID: 7a8b9c0d1e2f
Revises: 6f7a8b9c0d1f
Create Date: 2026-07-24

Master GROUPS, P5 (ПРОМТ №594): per-practice audience.

practices.audience_kind ('public' | 'students' | 'groups', NEW column) --
added NOT NULL with server_default='public'. This single ALTER TABLE ADD
COLUMN ... DEFAULT ... IS the backfill: Postgres applies the default to
every EXISTING row as part of the same DDL statement (no separate UPDATE
needed) -- every practice created before this column existed had no
audience concept, so it stays visible to everyone, matching its behavior
today exactly.

practice_audience_group -- a practice's target CUSTOM groups (audience_
kind='groups' only). Brand-new table -- no pre-existing rows, so unlike the
practice dup-guard migration (MIG1) there is no dedup step needed before
the UNIQUE(practice_id, group_id) index; test fixtures inserting after
this migration must simply respect it.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "7a8b9c0d1e2f"
down_revision: str | None = "6f7a8b9c0d1f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply this migration."""
    op.add_column(
        "practices",
        sa.Column(
            "audience_kind",
            sa.String(length=20),
            server_default="public",
            nullable=False,
        ),
    )

    op.create_table(
        "practice_audience_group",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "practice_id",
            sa.UUID(),
            sa.ForeignKey("practices.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "group_id",
            sa.UUID(),
            sa.ForeignKey("master_group.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_practice_audience_group_practice_id",
        "practice_audience_group",
        ["practice_id"],
    )
    op.create_index(
        "uq_practice_audience_group_practice_group",
        "practice_audience_group",
        ["practice_id", "group_id"],
        unique=True,
    )


def downgrade() -> None:
    """Revert this migration."""
    op.drop_index(
        "uq_practice_audience_group_practice_group",
        table_name="practice_audience_group",
    )
    op.drop_index(
        "ix_practice_audience_group_practice_id",
        table_name="practice_audience_group",
    )
    op.drop_table("practice_audience_group")

    op.drop_column("practices", "audience_kind")
