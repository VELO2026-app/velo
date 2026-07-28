"""add_description_to_master_group

Revision ID: 8b9c0d1e2f3a
Revises: 7a8b9c0d1e2f
Create Date: 2026-07-28

Owner Q4 (ПРОМТ №610): «Новая группа» gets a free-text description field.

master_group.description -- NEW column, nullable, NO server_default. Purely
additive: every existing group row gets NULL (= "no description"), which is
exactly how the frontend already renders "nothing shown, no dead space" for
a group with none. No backfill, no data rewrite, no constraint an existing
row could violate -- safe on the live prod table.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "8b9c0d1e2f3a"
down_revision: str | None = "7a8b9c0d1e2f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply this migration."""
    op.add_column(
        "master_group",
        sa.Column("description", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    """Revert this migration."""
    op.drop_column("master_group", "description")
