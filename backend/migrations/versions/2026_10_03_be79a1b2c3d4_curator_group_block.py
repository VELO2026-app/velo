"""curator_group_block

Revision ID: be79a1b2c3d4
Revises: be48a1b2c3d4
Create Date: 2026-10-03

BE-79: a curator blocks a member of the school. Blocking deletes the
membership row and writes a row here in its place (kind and joined_at copied
from the deleted one); unblocking restores the membership from it and deletes
it. Why the swap and not a flag on the membership: CuratorGroupBlock's
docstring in app/modules/curator_groups/models.py.

NO DATA IS TOUCHED: nobody is blocked before this table exists.

Names are the ones Postgres gives an unnamed constraint, the same scheme
curator_group_member's own constraints carry (read from pg_constraint):
curator_group_block_pkey, curator_group_block_<col>_fkey. The unique index is
named, like the membership's: uq_curator_group_block_group_user.

kind has no CHECK, like curator_group_member.kind.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "be79a1b2c3d4"
down_revision: str | None = "be48a1b2c3d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "curator_group_block",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("group_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("kind", sa.String(length=10), nullable=False),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "blocked_by_user_id", postgresql.UUID(as_uuid=True), nullable=True,
        ),
        sa.Column(
            "blocked_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["group_id"], ["curator_group.id"],
            name="curator_group_block_group_id_fkey", ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"],
            name="curator_group_block_user_id_fkey", ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["blocked_by_user_id"], ["users.id"],
            name="curator_group_block_blocked_by_user_id_fkey",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name="curator_group_block_pkey"),
    )
    op.create_index(
        "uq_curator_group_block_group_user",
        "curator_group_block",
        ["group_id", "user_id"],
        unique=True,
    )
    op.create_index(
        "ix_curator_group_block_user_id", "curator_group_block", ["user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_curator_group_block_user_id", table_name="curator_group_block")
    op.drop_index(
        "uq_curator_group_block_group_user", table_name="curator_group_block",
    )
    op.drop_table("curator_group_block")
